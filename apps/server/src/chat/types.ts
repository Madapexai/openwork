/**
 * Chat 桥接层类型（openspec-chat-bridge.md）
 *
 * 借鉴 cc-connect：把 AI agent 桥接到任意聊天通道（IM/群聊/Webhook），
 * 群里 @agentId 即可驱动 agent 干活，agent 的回复也能再 @ 其他 agent 接力
 * （multi-bot relay，同 cc-connect 的群聊多 bot 互转）。
 *
 * 通道抽象：ChatChannelAdapter 定义 send/receive，具体实现：
 * - InMemoryChatChannel：进程内队列（测试/本地 demo）
 * - HttpChatChannel：webhook 双向（后续可接飞书/微信/钉钉/Telegram）
 */

/** 消息角色 */
export type ChatMessageRole = "user" | "agent" | "system";

/** 归一化的聊天消息 */
export interface ChatMessage {
  /** 通道内消息 ID */
  id: string;
  /** 会话/群聊 ID */
  conversationId: string;
  /** 发送者（用户 ID 或 agentId） */
  sender: string;
  /** 角色 */
  role: ChatMessageRole;
  /** 文本内容 */
  text: string;
  /** 被 @ 的 agentId 列表（由解析层填充） */
  mentions: string[];
  /** 时间戳 */
  timestamp: number;
}

/** 通道发送选项 */
export interface ChatSendOptions {
  /** 回复关联的消息 ID（引用） */
  replyTo?: string;
}

/** 聊天通道适配器：屏蔽具体 IM 平台差异 */
export interface ChatChannelAdapter {
  readonly channelId: string;
  /** 发送消息到会话 */
  send(message: ChatMessage, options?: ChatSendOptions): Promise<void>;
  /** 接收新消息（拉取模式；实现方负责去重） */
  receive(conversationId?: string): AsyncIterable<ChatMessage>;
}

/** 群聊路由结果 */
export interface ChatRouteResult {
  /** 被驱动的 agentId */
  agentId: string;
  /** agent 最终回复文本 */
  reply: string;
  /** 是否发生接力（回复中包含 @ 其他 agent） */
  handedOff: boolean;
  /** 接力目标（若有） */
  handoffTarget?: string;
  /** 事件数（诊断） */
  eventCount: number;
}
