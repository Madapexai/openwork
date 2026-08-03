/**
 * AcpSidecarAdapter - ACP 协议 adapter
 *
 * 基于 @agentclientprotocol/sdk 实现，PoC 已验证（kimi / opencode / traecli 全部握手成功）。
 *
 * 一个 adapter 覆盖 13+ ACP agent：
 * - opencode acp
 * - kimi acp
 * - traecli acp serve
 * - goose acp
 * - openclaw acp
 * - hermes acp
 * - pi acp
 * - qodercli acp
 * - kiro-cli acp
 * - antigravity acp
 * - openclaude acp
 * - codex acp
 * - continue acp
 *
 * 设计参考：
 * - SDK 1.3+：client({name}).connect(stream) → ClientConnection，使用 ctx.agent.request(...) 调用
 * - 握手成功后保留 ClientConnection，直到 stop() 触发 close()
 * - permission 处理：默认 allow_once，避免阻塞；上层可覆盖
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
// type alias for web streams (avoids generic-on-Writable type error)
type WebWritable = WritableStream<Uint8Array>;
type WebReadable = ReadableStream<Uint8Array>;
import { resolveCleanPath } from "../detect.js";
import { buildTransportEnv } from "../transport.js";
import { BaseSidecarAdapter } from "./base.js";
import type {
  AgentDetectResult,
  AgentDoctorInfo,
  SidecarCapabilities,
  SidecarHandle,
  SidecarStartOptions,
  TransportInfo,
} from "../types.js";

interface AcpConnection {
  agentInfo: { name: string; version: string } | null;
  protocolVersion: number;
  agentCapabilities: acp.AgentCapabilities | null;
  authMethods: acp.AuthMethod[] | null;
}

export class AcpSidecarAdapter extends BaseSidecarAdapter {
  readonly protocol = "acp" as const;

  private connection: AcpConnection | null = null;
  private child: ChildProcess | null = null;
  private clientConn: acp.ClientConnection | null = null;
  private stream: acp.Stream | null = null;

  override async start(options: SidecarStartOptions): Promise<SidecarHandle> {
    const binary = this.config.binaryPath ?? this.config.binary;
    if (!binary) {
      throw new Error(`ACP adapter requires 'binary' or 'binaryPath' for agent '${this.config.agentId}'`);
    }
    const args = this.config.args ?? ["acp"];
    const cleanPath = resolveCleanPath(options.path);

    const env: Record<string, string | undefined> = {
      PATH: cleanPath,
      ...options.env,
      ...this.config.env,
    };

    // spawn child process with stdio pipes
    this.child = spawn(binary, args, {
      cwd: options.cwd,
      env: { ...process.env, ...env } as Record<string, string>,
      stdio: ["pipe", "pipe", "inherit"],
    });

    const transportInfo: TransportInfo = {
      command: binary,
      args,
      cwd: options.cwd,
      env: buildTransportEnv(env),
    };

    let closePromise: Promise<void> | null = null;

    const handle: SidecarHandle = {
      protocol: "acp",
      agentId: this.config.agentId,
      processId: this.child.pid ?? undefined,
      transportInfo,
      isAlive: () => {
        if (!this.child) return false;
        return this.child.exitCode === null && this.child.signalCode === null && !this.child.killed;
      },
      stop: async () => {
        closePromise ??= (async () => {
          try {
            this.clientConn?.close();
          } catch {}
          if (this.child && !this.child.killed) {
            this.child.kill("SIGTERM");
            await Promise.race([
              new Promise<void>((resolve) => {
                this.child!.once("exit", () => resolve());
                setTimeout(() => resolve(), 1000);
              }),
            ]);
            if (this.child.exitCode === null) {
              try {
                this.child.kill("SIGKILL");
              } catch {}
            }
          }
        })();
        await closePromise;
      },
    };

    // 建立 ACP 连接（initialize 握手）
    try {
      const input = Writable.toWeb(this.child.stdin!) as unknown as WebWritable;
      const output = Readable.toWeb(this.child.stdout!) as unknown as WebReadable;

      this.stream = acp.ndJsonStream(input, output);
      this.clientConn = acp.client({ name: `openwork-sidecar-${this.config.agentId}` })
        .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
          // 默认选 allow_once（生产环境应该回写到 OpenWork 审批层）
          const opts = ctx.params.options ?? [];
          const allowOnce = opts.find((o) => o.kind === "allow_once");
          const allowAlways = opts.find((o) => o.kind === "allow_always");
          const selected = allowOnce ?? allowAlways ?? opts[0];
          return selected
            ? { outcome: { outcome: "selected", optionId: selected.optionId } }
            : { outcome: { outcome: "cancelled" } };
        })
        .connect(this.stream);

      // 监听连接关闭
      this.clientConn.closed.catch(() => {
        // connection 异常关闭，由 isAlive 反映
      });

      // initialize 握手（agent ↔ client 协商）
      const initResult = await this.clientConn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      });
      this.connection = {
        agentInfo: initResult.agentInfo ?? null,
        protocolVersion: initResult.protocolVersion,
        agentCapabilities: initResult.agentCapabilities ?? null,
        authMethods: initResult.authMethods ?? null,
      };
    } catch (err) {
      await handle.stop();
      throw err;
    }

    return handle;
  }

  /**
   * 获取已建立的 ACP 连接信息（用于 diagnostics）
   */
  getConnection(): AcpConnection | null {
    return this.connection;
  }

  /**
   * 获取 ACP ClientConnection（用于 session-based API）
   */
  getClientConnection(): acp.ClientConnection | null {
    return this.clientConn;
  }

  override get capabilities(): SidecarCapabilities | undefined {
    // 从 ACP agentCapabilities 动态推导
    const caps = this.connection?.agentCapabilities;
    if (!caps) return this.config.capabilities;
    return {
      ...this.config.capabilities,
      streaming: true,
      multiSession: !!caps.sessionCapabilities?.list,
      modelSwitch: !!(caps as { providers?: unknown }).providers,
      imageInput: !!caps.promptCapabilities?.image,
      audioInput: !!caps.promptCapabilities?.audio,
      embeddedContext: !!caps.promptCapabilities?.embeddedContext,
      mcpClient: !!caps.mcpCapabilities,
      permissions: true, // ACP 默认支持 requestPermission
    };
  }

  override async detect(): Promise<AgentDetectResult> {
    return super.detect();
  }

  override async doctor(): Promise<AgentDoctorInfo> {
    const detection = await this.detect();
    const checks: AgentDoctorInfo["checks"] = [
      {
        name: "binary-exists",
        ok: detection.available,
        detail: detection.binaryPath ?? detection.error,
      },
    ];
    if (detection.version) {
      checks.push({ name: "version-probe", ok: true, detail: `v${detection.version}` });
    }
    if (this.connection) {
      checks.push({
        name: "acp-handshake",
        ok: true,
        detail: `protocol=v${this.connection.protocolVersion}, agent=${this.connection.agentInfo?.name ?? "unknown"}`,
      });
    }
    if (this.connection?.authMethods && this.connection.authMethods.length > 0) {
      checks.push({
        name: "acp-auth",
        ok: true,
        detail: `${this.connection.authMethods.length} auth method(s) available`,
      });
    }
    return {
      agentId: this.config.agentId,
      healthy: detection.available && !!this.connection,
      binaryName: this.config.binary ?? "",
      binaryPath: detection.binaryPath,
      checks,
    };
  }
}
