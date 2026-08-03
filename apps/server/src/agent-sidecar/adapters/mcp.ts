/**
 * McpSidecarAdapter - MCP-over-stdio 协议 adapter
 *
 * 适用于把 CLI agent 当 MCP server (stdio transport) 启动的场景。
 * 协议参考：https://modelcontextprotocol.io/specification
 *
 * 与 AcpSidecarAdapter 的差异：
 * - ACP: JSON-RPC over stdio，agent 是会话主体（agent ↔ client）
 * - MCP: JSON-RPC over stdio，agent 暴露工具/资源给 client 调用（agent 是工具）
 *
 * 复用现有 mcp.ts 的脱敏与配置逻辑：
 * - McpItem 结构与 OpenWork 现有 mcp config 兼容
 * - 启动方式与 opencode mcp config 中的 stdio server 一致
 *
 * 一个 adapter 覆盖 MCP 集群 agent（未来扩展）：
 * - continue-mcp, kilocode-mcp, continue --mcp, ...
 *
 * 注意：MCP client 协议处理（initialize, tools/list, tools/call）
 * 当前不在 adapter 职责内，由 OpenWork 上层（mcp.ts）负责。
 * 本 adapter 只负责 spawn + 健康检查 + transportInfo 暴露。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolveCleanPath } from "../detect.js";
import { buildTransportEnv } from "../transport.js";
import { BaseSidecarAdapter } from "./base.js";
import type { SidecarHandle, SidecarStartOptions, TransportInfo } from "../types.js";

export class McpSidecarAdapter extends BaseSidecarAdapter {
  readonly protocol = "mcp" as const;

  private child: ChildProcess | null = null;

  override async start(options: SidecarStartOptions): Promise<SidecarHandle> {
    const binary = this.config.binaryPath ?? this.config.binary;
    if (!binary) {
      throw new Error(`MCP adapter requires 'binary' or 'binaryPath' for agent '${this.config.agentId}'`);
    }
    const args = this.config.args ?? [];
    const cleanPath = resolveCleanPath(options.path);

    const env: Record<string, string | undefined> = {
      PATH: cleanPath,
      ...options.env,
      ...this.config.env,
      // MCP stdio server 期望通过 stdin/stdout 通信
      MCP_TRANSPORT: "stdio",
    };

    this.child = spawn(binary, args, {
      cwd: options.cwd,
      env: { ...process.env, ...env } as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const transportInfo: TransportInfo = {
      command: binary,
      args,
      cwd: options.cwd,
      env: buildTransportEnv(env),
    };

    let closePromise: Promise<void> | null = null;
    const exited = new Promise<void>((resolve) => {
      this.child!.once("exit", () => resolve());
    });

    const handle: SidecarHandle = {
      protocol: "mcp",
      agentId: this.config.agentId,
      processId: this.child.pid ?? undefined,
      transportInfo,
      isAlive: () => {
        if (!this.child) return false;
        return this.child.exitCode === null && this.child.signalCode === null && !this.child.killed;
      },
      stop: async () => {
        closePromise ??= (async () => {
          if (this.child && !this.child.killed) {
            this.child.kill("SIGTERM");
            await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 1000))]);
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

    // 监听 stderr 用于诊断
    this.child.stderr?.on("data", (chunk) => {
      // TODO: 转发到 OpenWork logger
      void chunk;
    });

    // 短的 startup 缓冲，捕获立即崩溃
    const earlyExit = new Promise<never>((_, reject) => {
      this.child!.once("exit", (code, signal) => {
        if (code !== null && code !== 0) {
          reject(new Error(`MCP agent '${this.config.agentId}' exited immediately (code=${code} signal=${signal})`));
        }
      });
      this.child!.once("error", (err) => reject(err));
    });

    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
      earlyExit,
    ]).catch((err) => {
      void handle.stop();
      throw err;
    });

    return handle;
  }

  /** 获取子进程 stdin（用于 MCP client → server 通信） */
  get stdin() {
    return this.child?.stdin ?? null;
  }

  /** 获取子进程 stdout（用于 server → client 通信） */
  get stdout() {
    return this.child?.stdout ?? null;
  }

  /** 获取子进程 stderr（用于诊断） */
  get stderr() {
    return this.child?.stderr ?? null;
  }
}
