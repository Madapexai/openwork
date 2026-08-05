/**
 * GenericCliSidecarAdapter - 通用 CLI agent 适配器（openspec-cli-agent-adapter）
 *
 * 统一驱动市面上主流 CLI agent（Claude Code / Codex / Gemini CLI / Qwen Code /
 * Kimi / Freebuff / Cursor CLI 等），按「能力金字塔」分层执行：
 *
 * - L3 结构化协议（ACP/HTTP+SSE）→ 已有 AcpSidecarAdapter / OpenCodeSidecarAdapter
 * - L2 headless 输出解析 → 本文件 exec()/stream()（claude -p、codex exec、gemini -p）
 * - L1 交互式终端（PTY）→ 本文件 pty 路径（写 stdin + 解析 stdout），复用 PtySidecarAdapter
 *
 * 核心原则（规范 I3）：不支持的 agent 显式 fail-fast（CliAgentUnsupportedError），
 * 不允许「进程起来了但永远收不到 stop」的假成功。
 *
 * 协议对外统一暴露 "pty" | "generic"，上层 agent-team 的 runAgentPrompt() 零感知。
 */

import { spawn } from "node:child_process";
import { BaseSidecarAdapter } from "../adapters/base.js";
import { PtySidecarAdapter } from "../adapters/pty.js";
import { resolveCleanPath, findBinaryInPath, getAgentVersion } from "../detect.js";
import { bindStreamToParser, createOutputParser, mapJsonlToEvent } from "../output-parser.js";
import type {
  AgentEvent,
  SidecarHandle,
  SidecarStartOptions,
} from "../types.js";

// ============================================================
// 能力探测（§6.1）
// ============================================================

export type CliAutomationMode = "headless" | "pty" | "structured" | "unsupported";

export interface CliCapabilities {
  mode: CliAutomationMode;
  /** 探测到的二进制绝对路径 */
  binaryPath?: string;
  /** 版本 */
  version?: string;
  /** headless 参数模板，如 ["-p"] / ["exec"] / ["-p", "--output-format", "stream-json"] */
  headlessArgs?: string[];
  /** 支持的结构化输出格式：json | stream-json | ansi */
  outputFormats?: Array<"json" | "stream-json" | "ansi">;
  /** 是否支持权限请求上报（仅 structured 层） */
  permissions?: boolean;
  /** 不支持原因（mode === "unsupported" 时必有） */
  unsupportedReason?: string;
}

export interface DetectCliCapabilitiesOptions {
  versionFlag?: string;
  helpFlag?: string;
  headlessArgs?: string[];
  env?: Record<string, string>;
}

/** 跑一次冒烟命令，判断是否成功（退出码 0） */
function smokeTest(binaryPath: string, args: string[], env?: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      timeout: 8000,
    });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

/** 从 headless 参数模板推断输出格式 */
function inferOutputFormats(args: string[]): CliCapabilities["outputFormats"] {
  const idx = args.indexOf("--output-format");
  if (idx >= 0 && args[idx + 1] === "stream-json") return ["stream-json"];
  if (idx >= 0 && args[idx + 1] === "json") return ["json"];
  return ["ansi"];
}

/**
 * 能力探测（规范 §7.2）
 *
 * 1. 二进制不存在 → { mode: "unsupported", unsupportedReason: "binary-not-found" }
 * 2. 跑 --version 获取版本
 * 3. headless 冒烟（headlessArgs + "hi" 优先，其次 helpFlag）→ 成功则 mode="headless"
 * 4. 否则回退 pty（交互式兜底，仅声明了 pty 或未声明 headless 时）
 */
export async function detectCliCapabilities(
  binary: string,
  options: DetectCliCapabilitiesOptions = {},
): Promise<CliCapabilities> {
  const cleanPath = resolveCleanPath();
  const binaryPath = await findBinaryInPath(binary, cleanPath);
  if (!binaryPath) {
    return { mode: "unsupported", unsupportedReason: "binary-not-found" };
  }

  const version = await getAgentVersion(binaryPath, [options.versionFlag ?? "--version"], options.env).catch(
    () => undefined,
  );

  // headless 冒烟：优先完整 headlessArgs 模板，其次 helpFlag
  const smokeCandidates: string[][] = [];
  if (options.headlessArgs?.length) smokeCandidates.push([...options.headlessArgs, "hi"]);
  if (options.helpFlag) smokeCandidates.push([options.helpFlag]);

  for (const candidate of smokeCandidates) {
    if (await smokeTest(binaryPath, candidate, options.env)) {
      const headlessArgs = options.headlessArgs?.length ? options.headlessArgs : [options.helpFlag!];
      return {
        mode: "headless",
        binaryPath,
        version,
        headlessArgs,
        outputFormats: inferOutputFormats(headlessArgs),
        permissions: false,
      };
    }
  }

  // 未探测到 headless：至少 pty 可用（交互式终端兜底）
  return { mode: "pty", binaryPath, version };
}

// ============================================================
// fail-fast 错误（I3）
// ============================================================

export class CliAgentUnsupportedError extends Error {
  readonly agentId: string;
  /** 缺失能力列表 */
  readonly missing: string[];

  constructor(agentId: string, missing: string[], reason?: string) {
    super(
      `CLI agent '${agentId}' does not support required capabilities: ${missing.join(", ")}` +
        (reason ? ` (${reason})` : ""),
    );
    this.name = "CliAgentUnsupportedError";
    this.agentId = agentId;
    this.missing = missing;
  }
}

// ============================================================
// 输出行 → AgentEvent 映射（支持 stream-json / json 最终结果）
// ============================================================

function mapCliOutputLine(obj: unknown): AgentEvent | null {
  if (typeof obj !== "object" || obj === null) return null;
  const record = obj as Record<string, unknown>;

  // stream-json（Claude Code / Gemini CLI）: {"type":"stream_event","event":{...}}
  if (record.type === "stream_event" && record.event && typeof record.event === "object") {
    const inner = record.event as Record<string, unknown>;
    if (inner.type === "content_block_delta" && inner.delta && typeof inner.delta === "object") {
      const delta = inner.delta as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        return { kind: "agent-message-chunk", text: delta.text };
      }
    }
    if (inner.type === "message_stop") {
      return { kind: "stop", stopReason: "end_turn" };
    }
    return null;
  }

  // json 最终结果（codex exec --json）: {"result":"done","is_error":false}
  if (typeof record.result === "string" || typeof record.output === "string") {
    const text = String(record.result ?? record.output ?? "");
    const events: AgentEvent[] = [];
    if (text) events.push({ kind: "agent-message-chunk", text });
    events.push({ kind: "stop", stopReason: record.is_error === true ? "error" : "end_turn" });
    return events[0];
  }

  // 其余复用通用 jsonl 映射
  return mapJsonlToEvent(obj);
}

/** 执行参数 */
export interface CliExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  path?: string;
}

// ============================================================
// 适配器（§6.2）
// ============================================================

export class GenericCliSidecarAdapter extends BaseSidecarAdapter {
  private capsCache: CliCapabilities | null = null;

  get protocol(): "pty" | "generic" {
    return this.config.protocol === "generic" ? "generic" : "pty";
  }

  /** headless 模式：prompt 追加为参数，一次性执行（claude -p / codex exec / gemini -p） */
  private get isHeadless(): boolean {
    return this.config.cliProfile?.headless === true;
  }

  /** 能力探测（带缓存；I1 声明与实测交叉验证） */
  async detectCapabilities(): Promise<CliCapabilities> {
    if (this.capsCache) return this.capsCache;
    const binary = this.config.binaryPath ?? this.config.binary;
    if (!binary) {
      this.capsCache = { mode: "unsupported", unsupportedReason: "no-binary-configured" };
      return this.capsCache;
    }
    const profile = this.config.cliProfile;
    this.capsCache = await detectCliCapabilities(binary, {
      headlessArgs: profile?.headless ? profile.headlessArgs : undefined,
      env: this.config.env,
    });
    return this.capsCache;
  }

  /** I3: 能力检查，unsupported 时抛 CliAgentUnsupportedError */
  private async assertSupported(required: string[]): Promise<CliCapabilities> {
    const caps = await this.detectCapabilities();
    if (caps.mode === "unsupported") {
      throw new CliAgentUnsupportedError(this.config.agentId, required, caps.unsupportedReason);
    }
    if (this.isHeadless && caps.mode !== "headless" && caps.mode !== "structured") {
      // 声明 headless 但实测不支持 → fail-fast（I3）
      throw new CliAgentUnsupportedError(
        this.config.agentId,
        ["headless"],
        `declared headless but detected mode='${caps.mode}'`,
      );
    }
    return caps;
  }

  /** 构建执行参数：headless 用 cliProfile.headlessArgs + prompt；pty 用 config.args */
  private buildExecArgs(prompt: string, caps: CliCapabilities): string[] {
    if (this.isHeadless) {
      const headlessArgs = this.config.cliProfile?.headlessArgs ?? caps.headlessArgs ?? [];
      return [...headlessArgs, prompt];
    }
    return [...(this.config.args ?? [])];
  }

  /** 构建 env：PATH 清洗 + config.env 覆盖（I5） */
  private buildEnv(optsEnv?: Record<string, string | undefined>): Record<string, string> {
    const cleanPath = resolveCleanPath(optsEnv?.PATH);
    const env: Record<string, string | undefined> = {
      PATH: cleanPath,
      ...optsEnv,
      ...this.config.env,
    };
    return { ...process.env, ...env } as Record<string, string>;
  }

  private resolveBinary(): string {
    const binary = this.config.binaryPath ?? this.config.binary;
    if (!binary) {
      throw new Error(`CLI adapter requires 'binary' or 'binaryPath' for agent '${this.config.agentId}'`);
    }
    return binary;
  }

  // ============================================================
  // AgentSidecarAdapter 接口（I2）
  // ============================================================

  /** I4: spawn 进程。pty 模式委托 PtySidecarAdapter（stop 幂等 + transportInfo 脱敏） */
  override async start(options: SidecarStartOptions): Promise<SidecarHandle> {
    await this.assertSupported(["start"]);
    // 委托 PtySidecarAdapter：spawn/kill 超时/transportInfo 语义完全一致
    const pty = new PtySidecarAdapter(this.config);
    return pty.start(options);
  }

  /**
   * L2: 一次性 headless/pty 执行，返回最终文本 + 事件流
   * I4: 超时（默认 60s）后 kill；I3: unsupported 抛 CliAgentUnsupportedError
   */
  async exec(prompt: string, opts: CliExecOptions = {}): Promise<{ stdout: string; events: AgentEvent[] }> {
    const caps = await this.assertSupported(["headless", "pty"]);
    const binary = this.resolveBinary();
    const timeoutMs = opts.timeoutMs ?? 60_000;

    return new Promise((resolve, reject) => {
      const parser = createOutputParser(this.config.outputParser ?? "jsonl", { agentId: this.config.agentId });
      const events: AgentEvent[] = [];
      let stdout = "";
      let settled = false;

      const collect = (async () => {
        for await (const event of parser) events.push(event);
      })();

      const child = spawn(binary, this.buildExecArgs(prompt, caps), {
        cwd: opts.cwd ?? this.config.cwd,
        env: this.buildEnv(opts.env),
        stdio: ["pipe", "pipe", "pipe"],
      });

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        parser.end();
        void collect.then(() => (err ? reject(err) : resolve({ stdout, events })));
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        parser.push(chunk);
      });
      child.stderr?.on("data", () => {
        // stderr 诊断流独立于 stdout 事件流（§7.1）
      });
      child.on("error", (err) => finish(err));
      child.on("close", () => finish());

      const timer = setTimeout(() => {
        parser.push(JSON.stringify({ type: "error", error: "prompt timeout" }));
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
        finish();
      }, timeoutMs);

      // pty 模式：prompt 走 stdin
      if (!this.isHeadless) {
        child.stdin?.write(prompt + "\n");
      }
    });
  }

  /**
   * L2/L1: 流式执行（stream-json / jsonl → AgentEvent 流）
   * I4: 超时产出 error 事件并 kill；以 stop/error 收尾
   */
  async *stream(prompt: string, opts: CliExecOptions = {}): AsyncIterable<AgentEvent> {
    const caps = await this.assertSupported(["headless", "pty"]);
    const binary = this.resolveBinary();
    const timeoutMs = opts.timeoutMs ?? 60_000;

    const child = spawn(binary, this.buildExecArgs(prompt, caps), {
      cwd: opts.cwd ?? this.config.cwd,
      env: this.buildEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parser = createOutputParser(this.config.outputParser ?? "jsonl", { agentId: this.config.agentId });
    const stdoutIter = bindStreamToParser(child.stdout, parser);

    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        // 1s 宽限后 SIGKILL（沿用 pty.ts stop 语义）
        setTimeout(() => {
          if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
        }, 1000).unref();
      }
      parser.end();
    };

    const timer = setTimeout(() => {
      parser.push(JSON.stringify({ type: "error", error: "prompt timeout" }));
      kill();
    }, timeoutMs);

    // pty 模式：prompt 走 stdin
    if (!this.isHeadless) {
      try {
        child.stdin?.write(prompt + "\n");
      } catch (err) {
        yield {
          kind: "error",
          error: `Failed to write to stdin: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    try {
      for await (const event of stdoutIter) {
        yield event;
        if (event.kind === "stop" || event.kind === "error") break;
      }
    } finally {
      clearTimeout(timer);
      kill();
    }
  }

  /** 输出解析（单块 → 事件），支持 stream-json / json / jsonl */
  parseOutput(chunk: Buffer | string): AgentEvent[] {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const events: AgentEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = mapCliOutputLine(JSON.parse(trimmed));
        if (event) events.push(event);
      } catch {
        events.push({ kind: "agent-message-chunk", text: line });
      }
    }
    return events;
  }
}
