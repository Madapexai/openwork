/**
 * PtySidecarAdapter - PTY 协议 adapter
 *
 * 借鉴 orca 的设计："Works with any CLI agent — if it runs in a terminal, it runs in Orca"
 * 不抽象 agent，直接 spawn 进程 + 解析输出。
 *
 * 一个 adapter 覆盖 21+ PTY agent：
 * - claude-code (-p)
 * - codex
 * - cursor-agent
 * - gemini
 * - copilot
 * - amp, cline, codebuff, continue, droid, kilocode, mistral-vibe
 * - qwen-code, rovo-dev, auggie, command-code, autohand, crush, mimo, devin
 *
 * PoC 已验证：spawn + stdout/stderr 捕获正常工作。
 *
 * 输出解析（参考 paperclip Generic adapter 的 output_handler）：
 * - 通过 config.outputParser 选择 jsonl | ansi | regex | none
 * - 通过 createOutputEvents() 获取 AsyncIterable<AgentEvent>
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolveCleanPath } from "../detect.js";
import { buildTransportEnv } from "../transport.js";
import { bindStreamToParser, createOutputParser, type OutputParser } from "../output-parser.js";
import { BaseSidecarAdapter } from "./base.js";
import type { AgentEvent, SidecarHandle, SidecarStartOptions, TransportInfo } from "../types.js";

export class PtySidecarAdapter extends BaseSidecarAdapter {
  readonly protocol = "pty" as const;

  private child: ChildProcess | null = null;
  private stdoutParser: OutputParser | null = null;
  private stderrParser: OutputParser | null = null;

  override async start(options: SidecarStartOptions): Promise<SidecarHandle> {
    const binary = this.config.binaryPath ?? this.config.binary;
    if (!binary) {
      throw new Error(`PTY adapter requires 'binary' or 'binaryPath' for agent '${this.config.agentId}'`);
    }
    const args = this.config.args ?? [];
    const cleanPath = resolveCleanPath(options.path);

    const env: Record<string, string | undefined> = {
      PATH: cleanPath,
      ...options.env,
      ...this.config.env,
    };

    this.child = spawn(binary, args, {
      cwd: options.cwd,
      env: { ...process.env, ...env } as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // 初始化输出解析器
    const parserMode = this.config.outputParser ?? "ansi";
    const regex = this.config.outputPattern ? new RegExp(this.config.outputPattern, "g") : undefined;
    this.stdoutParser = createOutputParser(parserMode, { regex, agentId: this.config.agentId });
    this.stderrParser = createOutputParser("ansi"); // stderr 一律按 ansi 处理

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
      protocol: "pty",
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
          // 结束 parsers
          this.stdoutParser?.end();
          this.stderrParser?.end();
        })();
        await closePromise;
      },
    };

    // 等待进程就绪（PTY 协议没有握手，直接返回）
    const startupTimeoutMs = options.timeoutMs ?? 15000;
    const earlyExit = new Promise<never>((_, reject) => {
      this.child!.once("exit", (code, signal) => {
        if (code !== null && code !== 0) {
          reject(new Error(`PTY agent '${this.config.agentId}' exited immediately (code=${code} signal=${signal})`));
        }
      });
      this.child!.once("error", (err) => reject(err));
      setTimeout(() => {
        // 启动窗口通过
      }, Math.min(startupTimeoutMs, 2000));
    });

    // 绑定 stdout/stderr 到 parser
    bindStreamToParser(this.child.stdout, this.stdoutParser);
    bindStreamToParser(this.child.stderr, this.stderrParser);

    // 等待一小段时间，让进程稳定
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
      earlyExit,
    ]).catch((err) => {
      void handle.stop();
      throw err;
    });

    return handle;
  }

  /**
   * 获取子进程 stdin（用于向 agent 发送输入）
   */
  get stdin() {
    return this.child?.stdin ?? null;
  }

  /**
   * 获取子进程 stdout（用于读取 agent 输出，原始）
   */
  get stdout() {
    return this.child?.stdout ?? null;
  }

  /**
   * 获取子进程 stderr（用于诊断，原始）
   */
  get stderr() {
    return this.child?.stderr ?? null;
  }

  /**
   * 获取 stdout 的解析后事件流（AsyncIterable<AgentEvent>）
   *
   * 用于上层 for-await-of 消费：
   * ```ts
   * for await (const event of adapter.events()) {
   *   if (event.kind === "agent-message-chunk") console.log(event.text);
   * }
   * ```
   */
  events(): AsyncIterable<AgentEvent> {
    if (!this.stdoutParser) {
      return {
        async *[Symbol.asyncIterator]() {
          // 还没启动
        },
      };
    }
    return this.stdoutParser;
  }

  /**
   * 获取 stderr 的解析后事件流（诊断用）
   */
  diagnosticEvents(): AsyncIterable<AgentEvent> {
    if (!this.stderrParser) {
      return {
        async *[Symbol.asyncIterator]() {
          // 还没启动
        },
      };
    }
    return this.stderrParser;
  }
}
