/**
 * ChatRelayService — 群聊 → agent 路由 + 多 agent 接力（openspec-chat-bridge.md）
 *
 * 借鉴 cc-connect 的 multi-bot relay：
 * - 群里 @agentId 消息 → 找到对应 adapter（RuntimeRegistry / preset）→ runAgentPrompt
 * - agent 的回复若包含 @otherAgent，自动接力交给 otherAgent（A 写完 @B 审查）
 *
 * 不变量：
 * I1: 只有被 @ 的 agent 才会被驱动（未提及的 agent 不响应）
 * I2: 未知 agentId → 返回错误消息（fail-fast，绝不静默）
 * I3: 接力深度受限（maxHandoffs，默认 3），防死循环
 * I4: 每个被驱动 agent 独立 spawn（adapter 按需创建，不用共享会话）
 */

import { runAgentPrompt } from "../agent-team/agent-runner.js";
import { createAdapterForAgent } from "../agent-sidecar/registry.js";
import type { AgentEvent, AgentSidecarAdapter } from "../agent-sidecar/types.js";
import type { ChatChannelAdapter, ChatMessage, ChatRouteResult } from "./types.js";

/** 默认接力深度 */
export const DEFAULT_MAX_HANDOFFS = 3;

export interface ChatRelayOptions {
  /** 可用 agentId 集合（限制可被 @ 的 agent） */
  allowedAgents?: Set<string>;
  /** 最大接力深度 */
  maxHandoffs?: number;
  /** 默认工作目录 */
  cwd?: string;
  /** 默认超时 */
  timeoutMs?: number;
}

/** 从文本解析 @mention（支持 @agentId 和 @agent-label） */
export function parseMentions(text: string): string[] {
  const mentions = new Set<string>();
  const regex = /@([A-Za-z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    mentions.add(match[1]!);
  }
  return [...mentions];
}

/** 从回复文本中提取接力目标（首个 @ 提及的 agentId） */
export function extractHandoffTarget(reply: string, allowed: Set<string>): string | undefined {
  for (const mention of parseMentions(reply)) {
    if (allowed.has(mention)) return mention;
  }
  return undefined;
}

function extractFinalText(events: AgentEvent[]): string {
  return events
    .filter((e): e is Extract<AgentEvent, { kind: "agent-message-chunk" }> => e.kind === "agent-message-chunk")
    .map((e) => e.text)
    .join("");
}

export class ChatRelayService {
  private readonly allowedAgents: Set<string>;
  private readonly maxHandoffs: number;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  /** 手动注入的 adapter 工厂（测试用；默认走 preset registry） */
  private readonly adapterFactory?: (agentId: string) => AgentSidecarAdapter | null;

  constructor(options: ChatRelayOptions & { adapterFactory?: (agentId: string) => AgentSidecarAdapter | null } = {}) {
    this.allowedAgents = options.allowedAgents ?? new Set<string>();
    this.maxHandoffs = options.maxHandoffs ?? DEFAULT_MAX_HANDOFFS;
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.adapterFactory = options.adapterFactory;
  }

  /** 路由一条入站消息：@ 的第一个 agent 执行，回复可接力 */
  async route(channel: ChatChannelAdapter, message: ChatMessage): Promise<ChatRouteResult | null> {
    const target = this.resolveTarget(message);
    if (!target) {
      // I1: 未提及任何可用 agent → 不响应
      return null;
    }

    let currentPrompt = message.text;
    let currentAgent = target;
    let eventCount = 0;
    let handedOff = false;
    let handoffTarget: string | undefined;
    let hopCount = 0;

    // I3: 接力深度受限（hopCount >= maxHandoffs 时停止接力）
    while (true) {
      const adapter = this.createAdapter(currentAgent);
      if (!adapter) {
        // I2: 未知/不可创建 agent → fail-fast
        const errorText = `@${currentAgent} is not available on this runtime.`;
        await channel.send(
          {
            id: `reply-${Date.now()}`,
            conversationId: message.conversationId,
            sender: "system",
            role: "system",
            text: errorText,
            mentions: [],
            timestamp: Date.now(),
          },
          { replyTo: message.id },
        );
        return {
          agentId: currentAgent,
          reply: errorText,
          handedOff,
          handoffTarget,
          eventCount,
        };
      }

      const events: AgentEvent[] = [];
      try {
        for await (const event of runAgentPrompt({
          adapter,
          cwd: this.cwd,
          prompt: currentPrompt,
          timeoutMs: this.timeoutMs,
        })) {
          events.push(event);
          if (event.kind === "stop" || event.kind === "error") break;
        }
      } catch (error) {
        const errorText = `@${currentAgent} failed: ${error instanceof Error ? error.message : String(error)}`;
        await channel.send(
          {
            id: `reply-${Date.now()}`,
            conversationId: message.conversationId,
            sender: "system",
            role: "system",
            text: errorText,
            mentions: [],
            timestamp: Date.now(),
          },
          { replyTo: message.id },
        );
        return { agentId: currentAgent, reply: errorText, handedOff, handoffTarget, eventCount };
      }

      eventCount += events.length;
      const finalText = extractFinalText(events);

      // 提取接力目标：回复里 @ 其他可用 agent
      const nextTarget = extractHandoffTarget(finalText, this.allowedAgents);
      const hasError = events.some((e) => e.kind === "error");

      await channel.send(
        {
          id: `reply-${Date.now()}`,
          conversationId: message.conversationId,
          sender: currentAgent,
          role: "agent",
          text: finalText || "(no output)",
          mentions: [],
          timestamp: Date.now(),
        },
        { replyTo: message.id },
      );

      if (hasError || !nextTarget || nextTarget === currentAgent || hopCount >= this.maxHandoffs) {
        // 出错 / 无接力 / 接力给自己 / 深度耗尽 → 结束
        return {
          agentId: currentAgent,
          reply: finalText,
          handedOff,
          handoffTarget,
          eventCount,
        };
      }

      // 接力：把当前回复作为下一个 agent 的输入（A 写完 → @B 审查）
      handedOff = true;
      handoffTarget = nextTarget;
      hopCount++;
      currentAgent = nextTarget;
      currentPrompt = `Handoff from @${message.sender === currentAgent ? "previous" : currentAgent}:\n\n${finalText}`;
    }
  }

  /** I1: 解析被 @ 的目标 agent（首个 @ 即目标；可用性由 createAdapter 判定，未知 agent 走 fail-fast） */
  private resolveTarget(message: ChatMessage): string | undefined {
    return message.mentions[0];
  }

  /** I4: 按需创建 adapter */
  private createAdapter(agentId: string): AgentSidecarAdapter | null {
    if (this.adapterFactory) return this.adapterFactory(agentId);
    if (this.allowedAgents.size > 0 && !this.allowedAgents.has(agentId)) return null;
    try {
      return createAdapterForAgent(agentId);
    } catch {
      return null;
    }
  }
}
