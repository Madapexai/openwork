/**
 * Output Parser - PTY/Generic 输出解析器
 *
 * 支持四种解析模式（参考 paperclip Generic adapter 的 output_handler 设计）：
 * - jsonl:  每行一个 JSON 对象，按 agent 事件 schema 解析
 * - ansi:   原始 ANSI 文本，按行 chunk
 * - regex:  按正则提取（用于 Claude Code/Codex 的标记化输出）
 * - none:   不解析，原样转发
 *
 * AsyncIterable 设计：parser 实现 AsyncIterable<AgentEvent>，
 * 上层可用 for-await-of 消费事件流。
 */

import type { Readable } from "node:stream";
import type { AgentEvent } from "./types.js";

export interface OutputParser extends AsyncIterable<AgentEvent> {
  /** 喂入数据块 */
  push(chunk: Buffer | string): void;
  /** 标记流结束 */
  end(): void;
  /** 解析模式 */
  readonly mode: OutputParserMode;
}

export type OutputParserMode = "jsonl" | "ansi" | "regex" | "none";

/** 流式 ANSI 文本 chunk（无 JSON 解析） */
export interface AnsiChunkEvent {
  text: string;
}

/**
 * 创建一个 OutputParser
 */
export function createOutputParser(
  mode: OutputParserMode,
  options: { regex?: RegExp; agentId?: string } = {},
): OutputParser {
  switch (mode) {
    case "jsonl":
      return new JsonlParser(options.agentId);
    case "ansi":
      return new AnsiParser();
    case "regex":
      if (!options.regex) throw new Error("regex mode requires 'regex' option");
      return new RegexParser(options.regex, options.agentId);
    case "none":
      return new NoneParser();
  }
}

// ============================================================
// JSONL Parser
// ============================================================

class JsonlParser implements OutputParser {
  readonly mode = "jsonl" as const;
  private buffer = "";
  private queue: AgentEvent[] = [];
  private resolvers: Array<(event: IteratorResult<AgentEvent>) => void> = [];
  private done = false;

  constructor(private readonly agentId?: string) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const event = mapJsonlToEvent(obj, this.agentId);
        if (event) this.emit(event);
      } catch {
        // 非法 JSON：作为 agent-message-chunk 转发
        this.emit({ kind: "agent-message-chunk", text: line });
      }
    }
  }

  end(): void {
    this.done = true;
    // flush 残余
    if (this.buffer.trim()) {
      try {
        const obj = JSON.parse(this.buffer.trim());
        const event = mapJsonlToEvent(obj, this.agentId);
        if (event) this.emit(event);
      } catch {
        this.emit({ kind: "agent-message-chunk", text: this.buffer });
      }
      this.buffer = "";
    }
    // 通知所有 pending iterator 结束
    for (const resolve of this.resolvers) {
      resolve({ value: undefined, done: true });
    }
    this.resolvers = [];
  }

  private emit(event: AgentEvent): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    while (true) {
      const event = this.queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.done) return;
      const result = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (result.done) return;
      yield result.value as AgentEvent;
    }
  }
}

// ============================================================
// ANSI Parser
// ============================================================

class AnsiParser implements OutputParser {
  readonly mode = "ansi" as const;
  private queue: AgentEvent[] = [];
  private resolvers: Array<(event: IteratorResult<AgentEvent>) => void> = [];
  private done = false;

  push(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length === 0) return;
    this.emit({ kind: "agent-message-chunk", text });
  }

  end(): void {
    this.done = true;
    for (const resolve of this.resolvers) {
      resolve({ value: undefined, done: true });
    }
    this.resolvers = [];
  }

  private emit(event: AgentEvent): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    while (true) {
      const event = this.queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.done) return;
      const result = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (result.done) return;
      yield result.value as AgentEvent;
    }
  }
}

// ============================================================
// Regex Parser
// ============================================================

class RegexParser implements OutputParser {
  readonly mode = "regex" as const;
  private buffer = "";
  private queue: AgentEvent[] = [];
  private resolvers: Array<(event: IteratorResult<AgentEvent>) => void> = [];
  private done = false;

  constructor(
    private readonly regex: RegExp,
    private readonly agentId?: string,
  ) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let match: RegExpExecArray | null;
    while ((match = this.regex.exec(this.buffer)) !== null) {
      const text = match[0];
      // 提取 group 1 作为消息文本（如果有）
      const message = match[1] ?? match[0];
      this.emit({ kind: "agent-message-chunk", text: message });
      this.buffer = this.buffer.slice(match.index + text.length);
      // 截断 buffer 后必须重置 lastIndex，否则会跳过新缓冲区中的匹配
      // （全局 regex 的 lastIndex 指向旧缓冲区的位置，已失效）
      this.regex.lastIndex = 0;
      if (!this.regex.global) break;
    }
  }

  end(): void {
    this.done = true;
    for (const resolve of this.resolvers) {
      resolve({ value: undefined, done: true });
    }
    this.resolvers = [];
  }

  private emit(event: AgentEvent): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    while (true) {
      const event = this.queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.done) return;
      const result = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (result.done) return;
      yield result.value as AgentEvent;
    }
  }
}

// ============================================================
// None Parser
// ============================================================

class NoneParser implements OutputParser {
  readonly mode = "none" as const;
  private done = false;

  push(_chunk: Buffer | string): void {
    // 丢弃
  }

  end(): void {
    this.done = true;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    // 不产生任何事件
  }
}

// ============================================================
// JSONL → AgentEvent 映射
// ============================================================

export function mapJsonlToEvent(obj: unknown, _agentId?: string): AgentEvent | null {
  if (typeof obj !== "object" || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : typeof record.kind === "string" ? record.kind : "";
  const text = typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : "";

  switch (type) {
    case "message":
    case "agent-message":
    case "agent-message-chunk":
      return text ? { kind: "agent-message-chunk", text } : null;
    case "tool-call":
    case "tool_call":
      return {
        kind: "tool-call",
        toolCallId: String(record.toolCallId ?? record.id ?? ""),
        title: String(record.title ?? record.name ?? ""),
        status: String(record.status ?? "running"),
      };
    case "tool-call-update":
    case "tool_call_update":
      return {
        kind: "tool-call-update",
        toolCallId: String(record.toolCallId ?? record.id ?? ""),
        status: String(record.status ?? "running"),
      };
    case "plan":
      return { kind: "plan", plan: record.plan ?? record.content ?? record };
    case "thought":
    case "agent-thought-chunk":
      return { kind: "agent-thought-chunk", text: text || String(record.thought ?? "") };
    case "user-message":
    case "user-message-chunk":
      return { kind: "user-message-chunk", text };
    case "permission-request":
    case "permission_request":
      return {
        kind: "permission-request",
        requestId: String(record.requestId ?? record.id ?? ""),
        toolCall: {
          title: String(record.title ?? ""),
          options: Array.isArray(record.options) ? (record.options as Array<{ optionId: string; name: string; kind: string }>) : [],
        },
      };
    case "stop":
    case "end":
      return { kind: "stop", stopReason: String(record.stopReason ?? record.reason ?? "end") };
    case "error":
      return { kind: "error", error: String(record.error ?? record.message ?? "unknown error") };
    default:
      // 未识别的 type，作为 message chunk 转发
      return text ? { kind: "agent-message-chunk", text } : null;
  }
}

// ============================================================
// 流绑定工具
// ============================================================

/**
 * 把一个 Readable 流绑定到 OutputParser
 *
 * 返回 AsyncIterable<AgentEvent>，可直接 for-await-of
 */
export function bindStreamToParser(
  stream: Readable | NodeJS.ReadableStream | null,
  parser: OutputParser,
): AsyncIterable<AgentEvent> {
  if (!stream) {
    return {
      async *[Symbol.asyncIterator]() {
        // 空流，不产生事件
      },
    };
  }
  // 监听 data 事件
  stream.on("data", (chunk: Buffer | string) => {
    parser.push(chunk);
  });
  stream.on("end", () => {
    parser.end();
  });
  stream.on("error", (err: Error) => {
    // 把错误作为事件发出去
    parser.push(JSON.stringify({ type: "error", error: err.message }));
    parser.end();
  });
  return parser;
}
