/**
 * ACP Session Helper 测试
 *
 * 通过 mock ClientConnection 验证 runAcpPrompt 与 mapSessionUpdateToUpdate 的行为：
 * - 验证 agent_message_chunk (text) → agent-message-chunk
 * - 验证 tool_call → tool-call
 * - 验证 plan → plan
 * - 验证 stop 转换
 * - 验证 timeout 路径
 * - 验证 session/new 失败路径
 * - 验证 prompt 异常路径
 */

import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import {
  mapSessionUpdateToUpdate,
  mapStopReason,
  runAcpPrompt,
} from "./sessions.js";
import type { AgentEvent } from "./types.js";

// ============================================================
// Helpers：构造 mock ClientConnection / ActiveSession
// ============================================================

type Update = acp.SessionUpdate;
type ActiveSessionMessage = acp.ActiveSessionMessage;

interface MockSessionScript {
  /** session/new 失败（抛出此 Error） */
  startError?: Error;
  /** prompt() 抛出此 Error（若提供） */
  promptError?: Error;
  /** prompt() resolve 时返回的 PromptResponse.stopReason */
  stopReason?: acp.StopReason;
  /** 在 prompt resolve 之前先发的 update 序列 */
  updates?: Update[];
  /** 在 prompt resolve 之后是否还有更新（一般 false） */
  postUpdates?: Update[];
  /** prompt() 是否永不 resolve（用于超时测试） */
  neverResolve?: boolean;
  /** prompt resolve 延迟（毫秒） */
  promptDelayMs?: number;
}

function makeTextUpdate(text: string): Update {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  } as unknown as Update;
}

function makeToolCallUpdate(toolCallId: string, title: string, status: string): Update {
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title,
    status,
  } as unknown as Update;
}

function makeMockSession(script: MockSessionScript): acp.ActiveSession {
  const updates = [...(script.updates ?? [])];
  const postUpdates = [...(script.postUpdates ?? [])];
  let stopQueued = false;
  let promptSettled = false;

  const promptPromise = new Promise<acp.PromptResponse>((resolve, reject) => {
    const delay = script.promptDelayMs ?? 0;
    setTimeout(() => {
      if (script.neverResolve) return; // 永不 resolve
      if (script.promptError) {
        promptSettled = true;
        reject(script.promptError);
        return;
      }
      promptSettled = true;
      stopQueued = true;
      resolve({
        stopReason: script.stopReason ?? "end_turn",
        sessionId: "mock-session",
      } as acp.PromptResponse);
    }, delay);
  });

  const session = {
    get sessionId() {
      return "mock-session";
    },
    prompt: () => promptPromise,
    nextUpdate: async (): Promise<ActiveSessionMessage> => {
      // 先发 updates
      if (updates.length > 0) {
        const update = updates.shift()!;
        return { kind: "session_update", notification: {} as acp.SessionNotification, update };
      }
      // 如果有 postUpdates，发完
      if (postUpdates.length > 0) {
        const update = postUpdates.shift()!;
        return { kind: "session_update", notification: {} as acp.SessionNotification, update };
      }
      // 等 prompt 完成
      if (!promptSettled) {
        await promptPromise.catch(() => {});
      }
      // 返回 stop
      return {
        kind: "stop",
        response: { stopReason: script.stopReason ?? "end_turn" } as acp.PromptResponse,
        stopReason: (script.stopReason ?? "end_turn") as acp.StopReason,
      };
    },
    dispose: () => {
      // no-op
    },
    [Symbol.dispose]: () => {
      // no-op
    },
  };
  return session as unknown as acp.ActiveSession;
}

function makeMockConn(script: MockSessionScript): acp.ClientConnection {
  const session = makeMockSession(script);
  const closed = new Promise<void>(() => {}); // 永不 close
  const signal = new AbortController().signal;

  const conn = {
    agent: {
      buildSession: (_cwd: string) => ({
        start: async () => {
          if (script.startError) throw script.startError;
          return session;
        },
      }),
      notify: async (_method: string, _params: unknown) => {
        // no-op
      },
    },
    closed,
    signal,
    close: () => {},
  };
  return conn as unknown as acp.ClientConnection;
}

async function collect<T>(iter: AsyncIterable<T>, timeoutMs = 1500): Promise<T[]> {
  const events: T[] = [];
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([
    (async () => {
      for await (const ev of iter) {
        events.push(ev);
      }
    })(),
    timeout,
  ]);
  return events;
}

// ============================================================
// Tests
// ============================================================

describe("mapSessionUpdateToUpdate", () => {
  test("agent_message_chunk (text) → agent-message-chunk", () => {
    const event = mapSessionUpdateToUpdate(makeTextUpdate("hello") as acp.SessionUpdate);
    expect(event).toEqual({ kind: "agent-message-chunk", text: "hello" });
  });

  test("agent_message_chunk (image) → agent-message-chunk-image", () => {
    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", mimeType: "image/png", data: "base64data" },
    } as unknown as acp.SessionUpdate;
    const event = mapSessionUpdateToUpdate(update);
    expect(event).toEqual({
      kind: "agent-message-chunk-image",
      mediaType: "image/png",
      data: "base64data",
    });
  });

  test("agent_thought_chunk (text) → agent-thought-chunk", () => {
    const update = {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking..." },
    } as unknown as acp.SessionUpdate;
    const event = mapSessionUpdateToUpdate(update);
    expect(event).toEqual({ kind: "agent-thought-chunk", text: "thinking..." });
  });

  test("user_message_chunk (text) → user-message-chunk", () => {
    const update = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "user input" },
    } as unknown as acp.SessionUpdate;
    const event = mapSessionUpdateToUpdate(update);
    expect(event).toEqual({ kind: "user-message-chunk", text: "user input" });
  });

  test("tool_call → tool-call", () => {
    const update = makeToolCallUpdate("tc-1", "Read file", "running") as acp.SessionUpdate;
    const event = mapSessionUpdateToUpdate(update);
    expect(event?.kind).toBe("tool-call");
    if (event && event.kind === "tool-call") {
      expect(event.toolCallId).toBe("tc-1");
      expect(event.title).toBe("Read file");
      expect(event.status).toBe("running");
    }
  });

  test("tool_call_update → tool-call-update", () => {
    const update = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
    } as unknown as acp.SessionUpdate;
    const event = mapSessionUpdateToUpdate(update);
    expect(event).toEqual({ kind: "tool-call-update", toolCallId: "tc-1", status: "completed" });
  });

  test("plan → plan", () => {
    const planData = { sessionUpdate: "plan", plan: { steps: [] } } as unknown as acp.SessionUpdate;
    const event = mapSessionUpdateToUpdate(planData);
    expect(event?.kind).toBe("plan");
  });

  test("unknown update type → null", () => {
    const update = { sessionUpdate: "plan_update" } as unknown as acp.SessionUpdate;
    const event = mapSessionUpdateToUpdate(update);
    expect(event).toBeNull();
  });
});

describe("mapStopReason", () => {
  test("undefined → end", () => {
    expect(mapStopReason(undefined)).toBe("end");
  });

  test("end_turn → end_turn", () => {
    expect(mapStopReason("end_turn")).toBe("end_turn");
  });

  test("max_tokens → max_tokens", () => {
    expect(mapStopReason("max_tokens")).toBe("max_tokens");
  });

  test("cancelled → cancelled", () => {
    expect(mapStopReason("cancelled")).toBe("cancelled");
  });

  test("max_turn_requests → max_turn_requests", () => {
    expect(mapStopReason("max_turn_requests")).toBe("max_turn_requests");
  });

  test("refusal → refusal", () => {
    expect(mapStopReason("refusal")).toBe("refusal");
  });

  test("unknown enum → stringified", () => {
    expect(mapStopReason("custom_reason" as acp.StopReason)).toBe("custom_reason");
  });
});

describe("runAcpPrompt", () => {
  test("正常路径：update 流 + stop", async () => {
    const conn = makeMockConn({
      updates: [makeTextUpdate("Hello "), makeTextUpdate("world!")],
      stopReason: "end_turn",
    });

    const events = await collect(runAcpPrompt(conn, "/tmp", "test prompt", 1000));

    const textEvents = events.filter(
      (e): e is Extract<AgentEvent, { kind: "agent-message-chunk" }> => e.kind === "agent-message-chunk",
    );
    expect(textEvents.length).toBe(2);
    expect(textEvents[0]!.text).toBe("Hello ");
    expect(textEvents[1]!.text).toBe("world!");

    const stopEvent = events.find((e) => e.kind === "stop") as Extract<AgentEvent, { kind: "stop" }> | undefined;
    expect(stopEvent).toBeDefined();
    expect(stopEvent?.stopReason).toBe("end_turn");
  });

  test("混合事件：tool_call + agent_message_chunk + stop", async () => {
    const conn = makeMockConn({
      updates: [
        makeToolCallUpdate("tc-1", "Read package.json", "running"),
        makeTextUpdate("Found deps:"),
        makeToolCallUpdate("tc-1", "Read package.json", "completed"),
      ],
      stopReason: "end_turn",
    });

    const events = await collect(runAcpPrompt(conn, "/tmp", "explore", 1000));

    const toolCalls = events.filter((e) => e.kind === "tool-call");
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);

    const stop = events.find((e) => e.kind === "stop");
    expect(stop).toBeDefined();
  });

  test("session/new 失败 → error 事件", async () => {
    const conn = makeMockConn({
      startError: new Error("spawn failed"),
    });

    const events = await collect(runAcpPrompt(conn, "/tmp", "test", 500));

    const errEvent = events.find((e) => e.kind === "error") as Extract<AgentEvent, { kind: "error" }> | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent?.error).toContain("session/new failed");
    expect(errEvent?.error).toContain("spawn failed");
  });

  test("prompt 异常 → error 事件", async () => {
    const conn = makeMockConn({
      promptError: new Error("model unavailable"),
      updates: [],
    });

    const events = await collect(runAcpPrompt(conn, "/tmp", "test", 1000));

    const errEvent = events.find((e) => e.kind === "error") as Extract<AgentEvent, { kind: "error" }> | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent?.error).toContain("model unavailable");
  });

  test("timeout：超时发 error 并尝试 cancel", async () => {
    const conn = makeMockConn({
      updates: [],
      neverResolve: true,
    });

    const events = await collect(runAcpPrompt(conn, "/tmp", "test", 200), 1000);

    const errEvent = events.find((e) => e.kind === "error") as Extract<AgentEvent, { kind: "error" }> | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent?.error).toContain("timeout");
  });

  test("timeoutMs=0：永不超时，等待 prompt 完成", async () => {
    const conn = makeMockConn({
      updates: [makeTextUpdate("delayed")],
      stopReason: "end_turn",
      promptDelayMs: 100,
    });

    const events = await collect(runAcpPrompt(conn, "/tmp", "test", 0), 2000);

    const stop = events.find((e) => e.kind === "stop");
    expect(stop).toBeDefined();
  });

  test("空 update 列表 + 立即 stop", async () => {
    const conn = makeMockConn({
      updates: [],
      stopReason: "end_turn",
    });

    const events = await collect(runAcpPrompt(conn, "/tmp", "test", 1000));

    const stop = events.find((e) => e.kind === "stop") as Extract<AgentEvent, { kind: "stop" }> | undefined;
    expect(stop).toBeDefined();
    expect(stop?.stopReason).toBe("end_turn");
  });

  test("多个 stop_reason 类型映射正确", async () => {
    const reasons: acp.StopReason[] = ["end_turn", "max_tokens", "cancelled", "refusal"];
    for (const reason of reasons) {
      const conn = makeMockConn({
        updates: [],
        stopReason: reason,
      });
      const events = await collect(runAcpPrompt(conn, "/tmp", "test", 1000));
      const stop = events.find((e) => e.kind === "stop") as Extract<AgentEvent, { kind: "stop" }> | undefined;
      expect(stop).toBeDefined();
      expect(stop?.stopReason).toBe(reason);
    }
  });
});
