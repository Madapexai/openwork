/**
 * chat-relay.test.ts — 群聊 → agent 路由 + 多 agent 接力测试（openspec-chat-bridge.md §7）
 *
 * FakeAdapter 实现 AgentSidecarAdapter 接口 + stream()（走 agent-runner 的 duck-typing 路径），
 * 验证：@mention 路由 / fail-fast / 接力 / 深度限制 / 未提及不响应。
 *
 * 运行: bun test src/chat/chat-relay.test.ts
 */

import { describe, expect, test } from "bun:test";
import { ChatRelayService, parseMentions, extractHandoffTarget, DEFAULT_MAX_HANDOFFS } from "./chat-relay.js";
import { InMemoryChatChannel } from "./channels/in-memory.js";
import type { AgentSidecarAdapter, AgentEvent, AgentDetectResult, AgentDoctorInfo, SidecarHandle } from "../agent-sidecar/types.js";

/** 可控回复的 FakeAdapter：stream() 输出 replyText，支持 @mention 接力 */
class FakeAdapter implements AgentSidecarAdapter {
  readonly protocol = "pty" as const;
  readonly agentId: string;
  readonly displayName: string;
  replyText: string;

  constructor(agentId: string, replyText: string) {
    this.agentId = agentId;
    this.displayName = agentId;
    this.replyText = replyText;
  }

  async *stream(): AsyncIterable<AgentEvent> {
    yield { kind: "agent-message-chunk", text: this.replyText };
    yield { kind: "stop", stopReason: "end_turn" };
  }

  async start(): Promise<SidecarHandle> {
    throw new Error("not used in chat-relay test");
  }
  async detect(): Promise<AgentDetectResult> {
    return { agentId: this.agentId, available: true, binaryPath: "/fake/" + this.agentId } as AgentDetectResult;
  }
  async doctor(): Promise<AgentDoctorInfo> {
    return {
      agentId: this.agentId,
      healthy: true,
      binaryName: this.agentId,
      binaryPath: "/fake/" + this.agentId,
      checks: [],
    } as AgentDoctorInfo;
  }
}

function makeRelay(fakes: Map<string, FakeAdapter>, allowed: Set<string>) {
  const relay = new ChatRelayService({
    allowedAgents: allowed,
    cwd: "/tmp",
    timeoutMs: 5_000,
    adapterFactory: (agentId) => fakes.get(agentId) ?? null,
  });
  return relay;
}

describe("parseMentions / extractHandoffTarget（§7.1 解析）", () => {
  test("解析多个 @mention", () => {
    expect(parseMentions("@claude @codex 帮我看看")).toEqual(["claude", "codex"]);
  });

  test("无 @ 返回空数组", () => {
    expect(parseMentions("普通消息")).toEqual([]);
  });

  test("从回复中提取接力目标（只认 allowed 集合内 agent）", () => {
    const allowed = new Set(["codex", "gemini"]);
    expect(extractHandoffTarget("@claude 写完 @codex 审查", allowed)).toBe("codex");
    expect(extractHandoffTarget("@claude 写完 @wind-surf 审查", allowed)).toBeUndefined();
  });
});

describe("ChatRelayService（§7.2 路由）", () => {
  test("I1: 未 @ 任何 agent → 不响应（返回 null）", async () => {
    const channel = new InMemoryChatChannel();
    const relay = makeRelay(new Map(), new Set(["claude"]));
    const result = await relay.route(channel, {
      id: "m1",
      conversationId: "conv-1",
      sender: "user",
      role: "user",
      text: "大家好",
      mentions: [],
      timestamp: Date.now(),
    });
    expect(result).toBeNull();
  });

  test("@agent 消息 → agent 执行 → 回复发送到通道", async () => {
    const channel = new InMemoryChatChannel();
    const fake = new FakeAdapter("claude", "已完成，改动在 src/main.ts");
    const relay = makeRelay(new Map([["claude", fake]]), new Set(["claude"]));

    const result = await relay.route(channel, {
      id: "m2",
      conversationId: "conv-1",
      sender: "user",
      role: "user",
      text: "@claude 实现登录页",
      mentions: ["claude"],
      timestamp: Date.now(),
    });

    expect(result?.agentId).toBe("claude");
    expect(result?.reply).toContain("已完成");
    expect(result?.handedOff).toBe(false);
  });

  test("I2: 未知 agent → fail-fast 错误消息（不静默）", async () => {
    const channel = new InMemoryChatChannel();
    const relay = makeRelay(new Map(), new Set(["claude"]));

    const result = await relay.route(channel, {
      id: "m3",
      conversationId: "conv-1",
      sender: "user",
      role: "user",
      text: "@nope 干活",
      mentions: ["nope"],
      timestamp: Date.now(),
    });

    expect(result?.agentId).toBe("nope");
    expect(result?.reply).toContain("not available");
  });
});

describe("ChatRelayService（§7.3 多 agent 接力）", () => {
  test("回复 @ 其他 agent → 自动接力（A 实现 → B 审查）", async () => {
    const channel = new InMemoryChatChannel();
    const a = new FakeAdapter("claude", "实现完成 @codex 请审查");
    const b = new FakeAdapter("codex", "审查通过，无问题");
    const relay = makeRelay(
      new Map([
        ["claude", a],
        ["codex", b],
      ]),
      new Set(["claude", "codex"]),
    );

    const result = await relay.route(channel, {
      id: "m4",
      conversationId: "conv-1",
      sender: "user",
      role: "user",
      text: "@claude 实现登录页",
      mentions: ["claude"],
      timestamp: Date.now(),
    });

    expect(result?.handedOff).toBe(true);
    expect(result?.handoffTarget).toBe("codex");
    expect(result?.reply).toContain("审查通过");
  });

  test("I3: 接力深度受限（maxHandoffs=1 时最多两跳）", async () => {
    const channel = new InMemoryChatChannel();
    // A → B → C → D 无限接力，但 maxHandoffs=1 只允许 1 次接力
    const a = new FakeAdapter("a", "@b 继续");
    const b = new FakeAdapter("b", "@c 继续");
    const c = new FakeAdapter("c", "@d 继续");
    const d = new FakeAdapter("d", "完成");
    const fakes = new Map([
      ["a", a],
      ["b", b],
      ["c", c],
      ["d", d],
    ]);
    const relay = new ChatRelayService({
      allowedAgents: new Set(["a", "b", "c", "d"]),
      cwd: "/tmp",
      maxHandoffs: 1,
      adapterFactory: (id) => fakes.get(id) ?? null,
    });

    const result = await relay.route(channel, {
      id: "m5",
      conversationId: "conv-1",
      sender: "user",
      role: "user",
      text: "@a 开始",
      mentions: ["a"],
      timestamp: Date.now(),
    });

    // 只接力一次（到 b），不再继续
    expect(result?.agentId).toBe("b");
    expect(result?.handedOff).toBe(true);
  });

  test("DEFAULT_MAX_HANDOFFS = 3", () => {
    expect(DEFAULT_MAX_HANDOFFS).toBe(3);
  });
});

describe("ChatRelayService（§7.4 通道集成）", () => {
  test("InMemoryChatChannel send 后可通过 receive 消费", async () => {
    const channel = new InMemoryChatChannel();
    const fake = new FakeAdapter("claude", "回复内容");
    const relay = makeRelay(new Map([["claude", fake]]), new Set(["claude"]));

    await relay.route(channel, {
      id: "m6",
      conversationId: "conv-1",
      sender: "user",
      role: "user",
      text: "@claude 你好",
      mentions: ["claude"],
      timestamp: Date.now(),
    });

    // receive 回放队列，第一条就是 agent 回复
    const iterator = channel.receive("conv-1")[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.role).toBe("agent");
    expect(first.value?.text).toContain("回复内容");
  });
});
