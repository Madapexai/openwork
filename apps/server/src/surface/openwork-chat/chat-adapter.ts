/**
 * ChatChannelAdapter -> Surface 适配层（openspec-surface-abstraction.md）
 *
 * 把 OpenWork 现有的 ChatChannelAdapter（send/receive ChatMessage）
 * 翻译成 Surface 侧的 SurfaceMessage / SurfaceInbound 收发原语。
 *
 * 这一层只负责"消息格式翻译 + 目标映射 + 历史缓存"，
 * 不涉及 capabilities / approval / handoff（那些由 OpenWorkChatSurface 在上层决定）。
 *
 * 不变量：
 * I1: inbound() 每条消息只产出一次 SurfaceInbound（底层 receive 游标去重）
 * I2: history() 返回的缓存按 receivedAt 升序
 * I3: send() 同时把出站消息写入缓存（pullContext 能看到完整对话）
 */

import type { ChatChannelAdapter, ChatMessage, ChatMessageRole } from "../../chat/types.js";
import type { ScopeId } from "../../governance/memory/types.js";
import type {
  SurfaceDestination,
  SurfaceInbound,
  SurfaceMessage,
  SurfaceSendResult,
} from "../types.js";

/** 适配器依赖 */
export interface ChatSurfaceAdapterDeps {
  /** 被包装的 ChatChannelAdapter（InMemoryChatChannel 或后续 HttpChatChannel） */
  channel: ChatChannelAdapter;
  /** 默认 audienceScopeId（入站消息构造 destination 时用） */
  defaultScopeId: ScopeId;
  /** 默认发送者（出站消息的 sender；被 destination.onBehalfOf 覆盖） */
  defaultSender?: string;
  /** 默认角色（出站消息的 role） */
  defaultRole?: ChatMessageRole;
}

/** ChatChannelAdapter 适配出的 Surface 原语 */
export interface ChatSurfaceAdapter {
  /** 启动后台消费者，开始缓存消息历史 */
  start(): Promise<void>;
  /** 停止后台消费者 */
  stop(): Promise<void>;
  /** 发送消息（转换 + channel.send + 缓存） */
  send(message: SurfaceMessage, destination: SurfaceDestination): Promise<SurfaceSendResult>;
  /** 入站消息流（包装 channel.receive，做格式转换） */
  inbound(): AsyncIterable<SurfaceInbound>;
  /** 从缓存拉取历史（pullContext 用） */
  history(query: {
    destination?: SurfaceDestination;
    lookbackMs?: number;
    limit?: number;
    containsText?: string;
  }): SurfaceInbound[];
}

/**
 * 把 ChatMessage 转换成 SurfaceInbound
 */
export function chatMessageToInbound(msg: ChatMessage, scopeId: ScopeId): SurfaceInbound {
  return {
    inboundId: `inbound-${msg.id}`,
    message: {
      text: msg.text,
      mentions: msg.mentions.map((id) => ({ id })),
    },
    fromId: msg.sender,
    fromLabel: msg.sender,
    receivedAt: msg.timestamp,
    destination: {
      type: "channel",
      target: msg.conversationId,
      audienceScopeId: scopeId,
    },
    extension: { role: msg.role },
  };
}

/**
 * 把 SurfaceMessage + SurfaceDestination 转换成 ChatMessage（用于 send）
 */
export function surfaceMessageToChatMessage(
  message: SurfaceMessage,
  destination: SurfaceDestination,
  deps: { defaultSender: string; defaultRole: ChatMessageRole },
): ChatMessage {
  const sender = destination.onBehalfOf ?? deps.defaultSender;
  return {
    id: `surf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: destination.target,
    sender,
    role: (message.extension?.role as ChatMessageRole | undefined) ?? deps.defaultRole,
    text: message.text,
    mentions: (message.mentions ?? []).map((m) => m.id),
    timestamp: Date.now(),
  };
}

/** 创建 ChatSurfaceAdapter */
export function createChatSurfaceAdapter(deps: ChatSurfaceAdapterDeps): ChatSurfaceAdapter {
  const defaultSender = deps.defaultSender ?? "surface";
  const defaultRole: ChatMessageRole = deps.defaultRole ?? "agent";
  const cache: SurfaceInbound[] = [];
  let running = false;
  let consumer: Promise<void> | null = null;

  async function consume(): Promise<void> {
    try {
      for await (const msg of deps.channel.receive()) {
        if (!running) break;
        const inbound = chatMessageToInbound(msg, deps.defaultScopeId);
        cache.push(inbound);
      }
    } catch {
      // channel closed or errored — stop quietly
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;
      consumer = consume();
    },

    async stop() {
      running = false;
      if (consumer) {
        await consumer.catch(() => {});
        consumer = null;
      }
    },

    async send(message, destination) {
      const chatMessage = surfaceMessageToChatMessage(message, destination, {
        defaultSender,
        defaultRole,
      });
      await deps.channel.send(chatMessage);
      // I3: 把出站消息也写入缓存（以 SurfaceInbound 形式，便于 pullContext 看到完整对话）
      const outboundInbound: SurfaceInbound = {
        inboundId: `outbound-${chatMessage.id}`,
        message,
        fromId: chatMessage.sender,
        fromLabel: chatMessage.sender,
        receivedAt: chatMessage.timestamp,
        destination,
        extension: { role: chatMessage.role, direction: "outbound" },
      };
      cache.push(outboundInbound);
      return {
        messageId: chatMessage.id,
        timestamp: chatMessage.timestamp,
      };
    },

    async *inbound() {
      // 包装 channel.receive，做格式转换
      // 注意：InMemoryChatChannel 的 receive() 每次调用都从 cursor=0 开始，
      // 所以 inbound() 也会回放历史。这符合 openwork-chat 的 demo 语义。
      for await (const msg of deps.channel.receive()) {
        yield chatMessageToInbound(msg, deps.defaultScopeId);
      }
    },

    history(query) {
      let results = [...cache];
      if (query.destination) {
        results = results.filter(
          (m) =>
            m.destination.target === query.destination!.target &&
            m.destination.type === query.destination!.type,
        );
      }
      if (query.lookbackMs) {
        const cutoff = Date.now() - query.lookbackMs;
        results = results.filter((m) => m.receivedAt >= cutoff);
      }
      if (query.containsText) {
        results = results.filter((m) => m.message.text.includes(query.containsText!));
      }
      if (query.limit && results.length > query.limit) {
        results = results.slice(-query.limit);
      }
      return results;
    },
  };
}