/**
 * SSH Tunnel — cross-machine relay bridge.
 *
 * Allows a team member to run on a remote machine while participating in
 * the local relay pipeline. The local side spawns an SSH process that
 * port-forwards a remote ACP/HTTP endpoint back to the local sidecar pool.
 *
 * Design principles (from industry research):
 *   - ForwardAgent no  — default; ProxyJump for multi-hop.
 *   - authorized_keys with `command="...",restrict,no-pty` for scoped keys.
 *   - Remote runtime must expose an ACP/HTTP endpoint the local side can
 *     talk to; we never exec arbitrary commands on the remote.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface SshTunnelConfig {
  /** Remote host (hostname or IP). */
  host: string;
  /** Remote SSH port (default 22). */
  port?: number;
  /** Remote user. */
  user: string;
  /** Path to SSH private key (optional; defaults to system ssh-agent). */
  identityFile?: string;
  /** Remote ACP/HTTP endpoint port (what the remote runtime listens on). */
  remotePort: number;
  /** Local forwarded port (default 0 → OS picks). */
  localPort?: number;
  /** Optional ProxyJump host for multi-hop. */
  proxyJump?: string;
  /** Connect timeout (ms, default 15s). */
  connectTimeoutMs?: number;
}

export interface SshTunnelHandle {
  id: string;
  config: SshTunnelConfig;
  /** Local HTTP endpoint the relay pipeline can connect to. */
  localEndpoint: string;
  /** Stop the tunnel. */
  stop(): Promise<void>;
  /** Whether the underlying SSH process is still alive. */
  isAlive(): boolean;
}

/**
 * Start an SSH tunnel that forwards a local port to the remote ACP/HTTP
 * endpoint. Returns a handle with a localEndpoint the relay pipeline can
 * use as if it were a local runtime.
 */
export function startSshTunnel(config: SshTunnelConfig): Promise<SshTunnelHandle> {
  return new Promise<SshTunnelHandle>((resolve, reject) => {
    const id = `ssh_${randomUUID().slice(0, 8)}`;
    const localListen = createServer((req, res) => {
      // The local side is just a TCP forwarder — the actual HTTP request
      // is proxied by ssh -L. If we land here it means ssh isn't
      // forwarding yet (race). Respond 502 so callers retry cleanly.
      writeProxyError(res, 502, "SSH tunnel not ready");
      void req;
    });

    localListen.once("error", reject);
    localListen.listen(config.localPort ?? 0, "127.0.0.1", () => {
      const addr = localListen.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind local port"));
        return;
      }
      const boundPort = (addr as { port: number }).port;

      const sshArgs = buildSshArgs(config, boundPort);
      const child = spawn("ssh", sshArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      let resolved = false;
      const finishResolve = () => {
        if (resolved) return;
        resolved = true;
        resolve({
          id,
          config,
          localEndpoint: `http://127.0.0.1:${boundPort}`,
          async stop() {
            try {
              child.kill("SIGTERM");
              await new Promise<void>((r) => setTimeout(r, 500));
              if (!child.killed) child.kill("SIGKILL");
            } catch {
              // ignore
            }
            localListen.close();
          },
          isAlive() {
            return !child.killed && child.exitCode === null;
          },
        });
      };

      child.once("error", (err) => {
        if (resolved) return;
        resolved = true;
        localListen.close();
        reject(err);
      });

      // Give ssh a brief moment to establish the tunnel.
      const timeoutMs = config.connectTimeoutMs ?? 15_000;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        child.kill("SIGTERM");
        localListen.close();
        reject(new Error(`SSH tunnel to ${config.host}:${config.remotePort} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Wait for the first successful response from the remote.
      probeOnce(`http://127.0.0.1:${boundPort}`, 5)
        .then(() => {
          clearTimeout(timer);
          finishResolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          if (resolved) return;
          resolved = true;
          child.kill("SIGTERM");
          localListen.close();
          reject(err);
        });
    });
  });
}

function buildSshArgs(config: SshTunnelConfig, localPort: number): string[] {
  const args = [
    "-N",
    "-o", "ForwardAgent=no",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "ExitOnForwardFailure=yes",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${config.remotePort}`,
  ];
  if (config.proxyJump) args.push("-J", config.proxyJump);
  if (config.identityFile) args.push("-i", config.identityFile);
  if (config.port) args.push("-p", String(config.port));
  args.push(`${config.user}@${config.host}`);
  return args;
}

/** Best-effort probe: returns when the local forwarded port responds. */
async function probeOnce(endpoint: string, attempts: number): Promise<void> {
  let lastErr: unknown = null;
  const http = await import("node:http");
  for (let i = 0; i < attempts; i++) {
    try {
      await new Promise<void>((resolveInner, rejectInner) => {
        const req = http.get(endpoint, { timeout: 1500 }, () => resolveInner());
        req.on("error", rejectInner);
        req.on("timeout", () => { req.destroy(new Error("timeout")); rejectInner(new Error("timeout")); });
      });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr ?? new Error("SSH tunnel probe failed");
}

function writeProxyError(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { "Content-Type": "text/plain" });
  res.end(message);
}

/** Minimal in-memory registry of active tunnels — keyed by agentId. */
const activeTunnels = new Map<string, SshTunnelHandle>();

export const SshTunnelRegistry = {
  async start(agentId: string, config: SshTunnelConfig): Promise<SshTunnelHandle> {
    const existing = activeTunnels.get(agentId);
    if (existing && existing.isAlive()) return existing;
    if (existing) {
      await existing.stop().catch(() => {});
    }
    const handle = await startSshTunnel(config);
    activeTunnels.set(agentId, handle);
    return handle;
  },
  async stop(agentId: string): Promise<void> {
    const handle = activeTunnels.get(agentId);
    if (!handle) return;
    activeTunnels.delete(agentId);
    await handle.stop().catch(() => {});
  },
  get(agentId: string): SshTunnelHandle | undefined {
    return activeTunnels.get(agentId);
  },
  async stopAll(): Promise<void> {
    const handles = [...activeTunnels.values()];
    activeTunnels.clear();
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
  },
};

export type { ChildProcess, IncomingMessage, Server };
