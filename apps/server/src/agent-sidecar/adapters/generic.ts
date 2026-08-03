/**
 * GenericSidecarAdapter - 兜底通用 adapter
 *
 * 借鉴 paperclip 的 Bash adapter 与 HTTP adapter：
 * - commandTemplate: "{binary} -c {command}" 模板替换
 * - outputParser: jsonl | ansi | regex | none
 *
 * 用于：
 * - 自定义 bash wrapper（任意 CLI 通过模板包装）
 * - HTTP webhook agent（按 heartbeat 唤醒）
 * - 不在 preset 中的新 agent 快速接入
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolveCleanPath } from "../detect.js";
import { buildTransportEnv } from "../transport.js";
import { BaseSidecarAdapter } from "./base.js";
import type { SidecarHandle, SidecarStartOptions, TransportInfo } from "../types.js";

export class GenericSidecarAdapter extends BaseSidecarAdapter {
  readonly protocol = "generic" as const;

  private child: ChildProcess | null = null;

  override async start(options: SidecarStartOptions): Promise<SidecarHandle> {
    const binary = this.config.binaryPath ?? this.config.binary ?? "";
    const args = this.config.args ?? [];
    const cleanPath = resolveCleanPath(options.path);

    const env: Record<string, string | undefined> = {
      PATH: cleanPath,
      ...options.env,
      ...this.config.env,
    };

    // 如果配置了 commandTemplate，渲染它（替换 {binary} {command}）
    const finalArgs = args;
    const finalCommand = binary || this.config.commandTemplate || "";

    if (!finalCommand) {
      throw new Error(`Generic adapter requires 'binary' or 'commandTemplate' for agent '${this.config.agentId}'`);
    }

    this.child = spawn(finalCommand, finalArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...env } as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const transportInfo: TransportInfo = {
      command: finalCommand,
      args: finalArgs,
      cwd: options.cwd,
      env: buildTransportEnv(env),
    };

    let closePromise: Promise<void> | null = null;

    const handle: SidecarHandle = {
      protocol: "generic",
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
            await new Promise<void>((resolve) => {
              const t = setTimeout(() => resolve(), 1000);
              this.child!.once("exit", () => {
                clearTimeout(t);
                resolve();
              });
            });
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

    // 给进程一个短的 startup 缓冲
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    return handle;
  }

  /**
   * 获取子进程 stdin
   */
  get stdin() {
    return this.child?.stdin ?? null;
  }

  /**
   * 获取子进程 stdout
   */
  get stdout() {
    return this.child?.stdout ?? null;
  }

  /**
   * 获取子进程 stderr
   */
  get stderr() {
    return this.child?.stderr ?? null;
  }

  /**
   * 输出解析器（jsonl | ansi | regex | none）
   */
  get outputParser() {
    return this.config.outputParser ?? "none";
  }
}
