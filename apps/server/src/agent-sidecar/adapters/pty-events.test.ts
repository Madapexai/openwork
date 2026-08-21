import { describe, expect, test } from "bun:test";
import { PtySidecarAdapter } from "./pty.js";
import type { AgentEvent, AgentSidecarConfig } from "../types.js";

async function collect<T>(iter: AsyncIterable<T>, max: number, timeoutMs = 800): Promise<T[]> {
  const events: T[] = [];
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([
    (async () => {
      for await (const ev of iter) {
        events.push(ev);
        if (events.length >= max) break;
      }
    })(),
    timeout,
  ]);
  return events;
}

describe("PtySidecarAdapter events() stream", () => {
  test("ansi mode: emits agent-message-chunk for each stdout line", async () => {
    // Use printf to write deterministic output, then sleep so the process stays alive.
    // The shell script writes 2 lines, then waits so the process doesn't exit.
    const script = 'printf "hello\\nworld\\n"; sleep 0.5';
    const config: AgentSidecarConfig = {
      agentId: "test-pty-ansi",
      protocol: "pty",
      binary: "bash",
      args: ["-c", script],
      outputParser: "ansi",
    };
    const adapter = new PtySidecarAdapter(config);
    const handle = await adapter.start({ cwd: "/tmp" });

    try {
      const events = await collect(adapter.events(), 10, 400);
      const chunks = events
        .filter((e): e is Extract<AgentEvent, { kind: "agent-message-chunk" }> => e.kind === "agent-message-chunk")
        .map((e) => e.text)
        .join("");
      expect(chunks).toContain("hello");
      expect(chunks).toContain("world");
    } finally {
      await handle.stop();
    }
  });

  test("jsonl mode: parses JSONL lines into structured AgentEvents", async () => {
    const script = 'printf \'{"type":"agent-message-chunk","text":"hi"}\\n{"type":"stop","stopReason":"end"}\\n\'; sleep 0.5';
    const config: AgentSidecarConfig = {
      agentId: "test-pty-jsonl",
      protocol: "pty",
      binary: "bash",
      args: ["-c", script],
      outputParser: "jsonl",
    };
    const adapter = new PtySidecarAdapter(config);
    const handle = await adapter.start({ cwd: "/tmp" });

    try {
      const events = await collect(adapter.events(), 10, 400);
      const messageEvent = events.find((e) => e.kind === "agent-message-chunk") as Extract<AgentEvent, { kind: "agent-message-chunk" }> | undefined;
      const stopEvent = events.find((e) => e.kind === "stop") as Extract<AgentEvent, { kind: "stop" }> | undefined;
      expect(messageEvent).toBeDefined();
      expect(messageEvent?.text).toBe("hi");
      expect(stopEvent).toBeDefined();
      expect(stopEvent?.stopReason).toBe("end");
    } finally {
      await handle.stop();
    }
  });

  test("regex mode: extracts matches via global regex", async () => {
    // Output: <msg>A</msg> noise <msg>B</msg>
    const script = "printf '<msg>A</msg> noise <msg>B</msg>\\n'; sleep 0.5";
    const config: AgentSidecarConfig = {
      agentId: "test-pty-regex",
      protocol: "pty",
      binary: "bash",
      args: ["-c", script],
      outputParser: "regex",
      outputPattern: "<msg>([^<]+)</msg>",
    };
    const adapter = new PtySidecarAdapter(config);
    const handle = await adapter.start({ cwd: "/tmp" });

    try {
      const events = await collect(adapter.events(), 10, 400);
      const chunks = events
        .filter((e): e is Extract<AgentEvent, { kind: "agent-message-chunk" }> => e.kind === "agent-message-chunk")
        .map((e) => e.text);
      expect(chunks).toContain("A");
      expect(chunks).toContain("B");
    } finally {
      await handle.stop();
    }
  });

  test("diagnosticEvents(): stderr is captured as agent-message-chunk", async () => {
    // Write to stderr only
    const script = 'printf "warn-line\\n" >&2; sleep 0.5';
    const config: AgentSidecarConfig = {
      agentId: "test-pty-stderr",
      protocol: "pty",
      binary: "bash",
      args: ["-c", script],
      outputParser: "ansi", // stdout parser mode (unused for stderr)
    };
    const adapter = new PtySidecarAdapter(config);
    const handle = await adapter.start({ cwd: "/tmp" });

    try {
      const events = await collect(adapter.diagnosticEvents(), 10, 400);
      const text = events
        .filter((e): e is Extract<AgentEvent, { kind: "agent-message-chunk" }> => e.kind === "agent-message-chunk")
        .map((e) => e.text)
        .join("");
      expect(text).toContain("warn-line");
    } finally {
      await handle.stop();
    }
  });

  test("events() before start returns empty async iterable", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-pty-not-started",
      protocol: "pty",
      binary: "cat",
      args: [],
    };
    const adapter = new PtySidecarAdapter(config);
    const events = await collect(adapter.events(), 10, 100);
    expect(events.length).toBe(0);
  });
});
