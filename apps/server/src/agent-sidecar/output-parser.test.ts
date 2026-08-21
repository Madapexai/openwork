import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import {
  bindStreamToParser,
  createOutputParser,
  type OutputParser,
} from "./output-parser.js";
import type { AgentEvent } from "./types.js";

async function collect<T>(iter: AsyncIterable<T>, max = 50, timeoutMs = 500): Promise<T[]> {
  const events: T[] = [];
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  const race = Promise.race([
    (async () => {
      for await (const ev of iter) {
        events.push(ev);
        if (events.length >= max) break;
      }
    })(),
    timeout,
  ]);
  await race;
  return events;
}

// ============================================================
// JsonlParser
// ============================================================

describe("JsonlParser", () => {
  test("parses one JSON object per line into AgentEvent", async () => {
    const parser = createOutputParser("jsonl");
    parser.push('{"type":"agent-message-chunk","text":"hello"}\n');
    parser.push('{"type":"agent-message-chunk","text":" world"}\n');
    parser.end();
    const events = await collect(parser);
    expect(events.length).toBe(2);
    expect(events[0]).toEqual({ kind: "agent-message-chunk", text: "hello" });
    expect(events[1]).toEqual({ kind: "agent-message-chunk", text: " world" });
  });

  test("supports 'kind' field as alternative to 'type'", async () => {
    const parser = createOutputParser("jsonl");
    parser.push('{"kind":"agent-message-chunk","text":"hi"}\n');
    parser.end();
    const events = await collect(parser);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ kind: "agent-message-chunk", text: "hi" });
  });

  test("supports 'content' field as alternative to 'text'", async () => {
    const parser = createOutputParser("jsonl");
    parser.push('{"type":"agent-message-chunk","content":"alt text"}\n');
    parser.end();
    const events = await collect(parser);
    expect(events[0]).toEqual({ kind: "agent-message-chunk", text: "alt text" });
  });

  test("parses tool-call events", async () => {
    const parser = createOutputParser("jsonl");
    parser.push('{"type":"tool-call","toolCallId":"tc1","title":"Run shell","status":"running"}\n');
    parser.end();
    const events = await collect(parser);
    expect(events[0]).toEqual({
      kind: "tool-call",
      toolCallId: "tc1",
      title: "Run shell",
      status: "running",
    });
  });

  test("parses stop event", async () => {
    const parser = createOutputParser("jsonl");
    parser.push('{"type":"stop","stopReason":"end"}\n');
    parser.end();
    const events = await collect(parser);
    expect(events[0]).toEqual({ kind: "stop", stopReason: "end" });
  });

  test("parses error event", async () => {
    const parser = createOutputParser("jsonl");
    parser.push('{"type":"error","error":"boom"}\n');
    parser.end();
    const events = await collect(parser);
    expect(events[0]).toEqual({ kind: "error", error: "boom" });
  });

  test("falls back to agent-message-chunk for invalid JSON line", async () => {
    const parser = createOutputParser("jsonl");
    parser.push("not json\n");
    parser.end();
    const events = await collect(parser);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ kind: "agent-message-chunk", text: "not json" });
  });

  test("handles buffer split across multiple chunks (no premature parse)", async () => {
    const parser = createOutputParser("jsonl");
    parser.push('{"type":"agent-message-chu');
    parser.push('nk","text":"split"}\n');
    parser.end();
    const events = await collect(parser);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ kind: "agent-message-chunk", text: "split" });
  });

  test("flushes trailing buffer without newline on end()", async () => {
    const parser = createOutputParser("jsonl");
    parser.push('{"type":"agent-message-chunk","text":"tail"}');
    parser.end();
    const events = await collect(parser);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ kind: "agent-message-chunk", text: "tail" });
  });

  test("accepts Buffer chunks", async () => {
    const parser = createOutputParser("jsonl");
    parser.push(Buffer.from('{"type":"agent-message-chunk","text":"buf"}\n', "utf8"));
    parser.end();
    const events = await collect(parser);
    expect(events[0]).toEqual({ kind: "agent-message-chunk", text: "buf" });
  });
});

// ============================================================
// AnsiParser
// ============================================================

describe("AnsiParser", () => {
  test("emits agent-message-chunk for each push", async () => {
    const parser = createOutputParser("ansi");
    parser.push("hello ");
    parser.push("world");
    parser.end();
    const events = await collect(parser);
    expect(events.length).toBe(2);
    expect(events[0]).toEqual({ kind: "agent-message-chunk", text: "hello " });
    expect(events[1]).toEqual({ kind: "agent-message-chunk", text: "world" });
  });

  test("ignores empty chunks", async () => {
    const parser = createOutputParser("ansi");
    parser.push("");
    parser.push("data");
    parser.end();
    const events = await collect(parser);
    expect(events.length).toBe(1);
  });
});

// ============================================================
// RegexParser
// ============================================================

describe("RegexParser", () => {
  test("extracts matches via global regex", async () => {
    // Match content inside <msg>...</msg>
    const parser = createOutputParser("regex", {
      regex: /<msg>([^<]+)<\/msg>/g,
    });
    parser.push("<msg>hello</msg> noise <msg>world</msg>");
    parser.end();
    const events = await collect(parser);
    expect(events.length).toBe(2);
    expect(events[0]).toEqual({ kind: "agent-message-chunk", text: "hello" });
    expect(events[1]).toEqual({ kind: "agent-message-chunk", text: "world" });
  });

  test("uses group 0 (full match) when no group 1", async () => {
    const parser = createOutputParser("regex", {
      regex: /\bERR\b/g,
    });
    parser.push("line1 ERR line2 ERR end");
    parser.end();
    const events = await collect(parser);
    expect(events.length).toBe(2);
    expect(events[0]).toEqual({ kind: "agent-message-chunk", text: "ERR" });
  });

  test("throws when regex option missing", () => {
    expect(() => createOutputParser("regex")).toThrow(/requires 'regex' option/);
  });

  test("handles pattern spanning multiple chunks", async () => {
    const parser = createOutputParser("regex", {
      regex: /<msg>([^<]+)<\/msg>/g,
    });
    parser.push("<msg>hel");
    parser.push("lo</msg>");
    parser.end();
    const events = await collect(parser);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ kind: "agent-message-chunk", text: "hello" });
  });
});

// ============================================================
// NoneParser
// ============================================================

describe("NoneParser", () => {
  test("produces no events", async () => {
    const parser = createOutputParser("none");
    parser.push("ignored");
    parser.end();
    const events = await collect(parser);
    expect(events.length).toBe(0);
  });
});

// ============================================================
// createOutputParser dispatch
// ============================================================

describe("createOutputParser", () => {
  test("returns parser with matching mode", () => {
    expect(createOutputParser("jsonl").mode).toBe("jsonl");
    expect(createOutputParser("ansi").mode).toBe("ansi");
    expect(createOutputParser("regex", { regex: /x/g }).mode).toBe("regex");
    expect(createOutputParser("none").mode).toBe("none");
  });
});

// ============================================================
// bindStreamToParser
// ============================================================

describe("bindStreamToParser", () => {
  test("binds a Readable stream to the parser and yields events", async () => {
    const parser = createOutputParser("jsonl");
    const stream = Readable.from([
      '{"type":"agent-message-chunk","text":"a"}\n',
      '{"type":"agent-message-chunk","text":"b"}\n',
    ]);
    const iter = bindStreamToParser(stream, parser);
    const events = await collect(iter);
    expect(events.length).toBe(2);
    expect(events[0]).toEqual({ kind: "agent-message-chunk", text: "a" });
    expect(events[1]).toEqual({ kind: "agent-message-chunk", text: "b" });
  });

  test("returns empty async iterable for null stream", async () => {
    const parser = createOutputParser("ansi");
    const iter = bindStreamToParser(null, parser);
    const events = await collect(iter);
    expect(events.length).toBe(0);
  });

  test("emits error event on stream error", async () => {
    const parser = createOutputParser("jsonl");
    const stream = new Readable({
      read() {
        this.destroy(new Error("stream boom"));
      },
    });
    const iter = bindStreamToParser(stream, parser);
    const events = await collect(iter, 50, 300);
    const errorEvent = events.find((e) => e.kind === "error") as Extract<AgentEvent, { kind: "error" }> | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error).toContain("stream boom");
  });
});
