/**
 * Surface 抽象层类型定义（openspec-surface-abstraction.md）
 *
 * 把"任意 IM / 聊天通道"抽象成统一的 Surface 接口：
 * - inbound/send 是消息收发原语
 * - update/delete/react 是消息级操作（按 capability 开关）
 * - presentApproval / requestAgentHandoff 是高阶交互（按 capability 开关）
 * - pullContext 让 agent 拉取对话上下文
 * - resolveDestination / openGroup 是路由与群组管理
 *
 * 设计原则：
 * P1: Surface 是能力声明驱动（capabilities）的；不支持的能力调用 -> SurfaceCapabilityError
 * P2: SurfaceMessage 是归一化的；平台特化字段收进 extension
 * P3: SurfaceDestination 携带 audienceScopeId，把"发到哪"和"以谁的身份"绑定到治理层
 * P4: 入站 / 出站消息都走同一套 SurfaceMessage 结构，便于 agent 侧无差别处理
 */

import type { ScopeId } from "../governance/memory/types.js";

/** Surface 类型标识 */
export type SurfaceKind = "openwork-chat" | "slack" | "feishu" | "dingtalk" | "webhook";

/** 富文本能力档位 */
export type RichTextCapability = "none" | "markdown" | "rich";

/**
 * Surface 能力声明
 * 调用方在调用对应方法前必须先检查 capability，否则可能抛 SurfaceCapabilityError
 */
export interface SurfaceCapabilities {
  /** 支持审批卡片呈现 */
  approvalCard: boolean;
  /** 支持转接人工 / 其他 agent */
  handoff: boolean;
  /** 支持线程（话题） */
  thread: boolean;
  /** 支持表情回应 */
  reaction: boolean;
  /** 支持消息更新（编辑） */
  messageUpdate: boolean;
  /** 支持文件上传 */
  fileUpload: boolean;
  /** 支持群 DM（多人会话） */
  groupDm: boolean;
  /** 富文本能力档位 */
  richText: RichTextCapability;
}

/** @ 提及 */
export interface SurfaceMention {
  /** 被提及的实体 ID（agentId / userId / 角色名） */
  id: string;
  /** 显示名称 */
  label?: string;
  /** 提及类型 */
  type?: "agent" | "user" | "channel" | "role";
}

/** 附件（文件 / 图片 / 卡片） */
export interface SurfaceAttachment {
  id: string;
  filename: string;
  mimeType?: string;
  /** 附件内容来源：URL 或内联 base64；二者互斥 */
  url?: string;
  data?: string;
  size?: number;
}

/** 归一化的 Surface 消息 */
export interface SurfaceMessage {
  text: string;
  mentions?: SurfaceMention[];
  attachments?: SurfaceAttachment[];
  /** 回复引用的消息 ID */
  replyTo?: SurfaceMessageRef;
  /** 平台特化字段（rich text blocks / 自定义 payload 等） */
  extension?: Record<string, unknown>;
}

/** 目标定位：消息发到哪、以谁的身份 */
export interface SurfaceDestination {
  type: "principal" | "channel" | "group" | "thread";
  /** 目标标识（principalId / channelId / groupId / threadRef） */
  target: string;
  /** 受众范围 ID，绑定到治理层（权限 / 可见性） */
  audienceScopeId: ScopeId;
  /** 代理发送者（on-behalf-of；agent 代某个 principal 发消息时填） */
  onBehalfOf?: string;
  /** 线程引用（type=thread 时填，或作为 thread continuation） */
  threadRef?: string;
  /** 平台特化字段 */
  extension?: Record<string, unknown>;
}

/** 消息引用（用于 update / delete / react） */
export type SurfaceMessageRef = string;

/** 目标查询：把模糊目标解析成具体 SurfaceDestination */
export type DestinationQuery =
  | { kind: "principal"; principalId: string }
  | { kind: "channel"; channelName: string }
  | { kind: "group"; groupId: string }
  | { kind: "thread"; threadRef: string }
  | { kind: "raw"; target: string };

/** 目标解析结果 */
export interface DestinationResolution {
  destination: SurfaceDestination;
  /** 是否需要二次确认（敏感目标） */
  requiresConfirmation?: boolean;
  /** 人类可读的目标描述 */
  description?: string;
}

/** 审批决策 */
export type ApprovalDecision = "approve" | "deny" | "defer";

/** 审批范围 */
export interface ApprovalScope {
  kind: "action" | "resource" | "destination";
  target: string;
}

/** 审批请求 */
export interface ApprovalRequest {
  /** 业务侧 ID（agent 侧生成，用于幂等关联） */
  businessId: string;
  title: string;
  summary: string;
  /** 候选动作（按钮） */
  actions: string[];
  scope?: ApprovalScope[];
  /** 审批有效期（ms） */
  ttlMs?: number;
}

/** 审批呈现选项 */
export interface ApprovalPresentOpts {
  /** 呈现目标（默认走当前会话） */
  destination?: SurfaceDestination;
  /** 呈现样式 */
  style?: "card" | "inline" | "modal";
}

/** 审批句柄（异步等待决策） */
export interface ApprovalHandle {
  approvalId: string;
  /** 当前决策（未决时 undefined） */
  decision?: ApprovalDecision;
  /** 等待决策完成（resolves on approve / deny / defer / expire） */
  awaitDecision(): Promise<{ decision: ApprovalDecision; reason?: string }>;
  /** 外部反馈决策（由人 / 监督 agent 调用） */
  respond(decision: ApprovalDecision, reason?: string): Promise<void>;
}

/** Handoff 状态 */
export type HandoffStatus = "pending" | "accepted" | "rejected" | "completed" | "failed";

/** Handoff 结果 */
export interface HandoffResult {
  status: HandoffStatus;
  /** 接手方的回复 */
  reply?: string;
  /** 失败 / 拒绝原因 */
  reason?: string;
}

/** Handoff 请求 */
export interface HandoffRequest {
  /** 发起 handoff 的 agentId */
  fromAgentId: string;
  /** 目标 agentId（省略时由 surface 路由） */
  toAgentId?: string;
  /** 目标角色 */
  toRole?: "human" | "agent";
  reason: string;
  /** 携带给接手方的上下文摘要 */
  contextSummary?: string;
}

/** Handoff 句柄（异步等待接手方结果） */
export interface HandoffHandle {
  handoffId: string;
  status: HandoffStatus;
  awaitResult(): Promise<HandoffResult>;
  cancel(reason?: string): Promise<void>;
}

/** Surface 上下文查询 */
export interface SurfaceContextQuery {
  /** 限定目标 */
  destination?: SurfaceDestination;
  /** 时间窗口（ms，从现在起向前回溯） */
  lookbackMs?: number;
  /** 拉取条数上限 */
  limit?: number;
  /** 关键字过滤 */
  containsText?: string;
}

/** 入站消息（含来源元信息） */
export interface SurfaceInbound {
  /** 入站消息 ID（surface 侧生成） */
  inboundId: string;
  /** 收到的消息内容 */
  message: SurfaceMessage;
  /** 发送方 ID */
  fromId: string;
  /** 发送方显示名 */
  fromLabel?: string;
  /** 接收时间戳 */
  receivedAt: number;
  /** 这条消息投向何处（用于路由回执） */
  destination: SurfaceDestination;
  /** 平台特化字段 */
  extension?: Record<string, unknown>;
}

/** Surface 上下文结果 */
export interface SurfaceContextResult {
  messages: SurfaceInbound[];
  /** 是否因 limit 截断 */
  truncated: boolean;
}

/** 入站选项 */
export interface InboundOpts {
  /** 限定目标 */
  destination?: SurfaceDestination;
  /** 时间窗口（ms，从现在起向前回溯） */
  lookbackMs?: number;
}

/** 发送结果 */
export interface SurfaceSendResult {
  /** 平台侧消息 ID */
  messageId: string;
  /** 发送时间戳 */
  timestamp: number;
  /** 是否异步（消息已排队但未最终送达） */
  pending?: boolean;
}

/**
 * Surface 接口
 *
 * 实现方必须声明 capabilities，并在不支持的方法上抛 SurfaceCapabilityError。
 * inbound 是 AsyncIterable（拉模式）；start / stop 控制底层消费者生命周期。
 */
export interface Surface {
  readonly surfaceId: string;
  readonly kind: SurfaceKind;
  readonly capabilities: SurfaceCapabilities;

  /** 入站消息流（拉模式） */
  inbound(opts?: InboundOpts): AsyncIterable<SurfaceInbound>;
  /** 发送消息到指定目标 */
  send(message: SurfaceMessage, destination: SurfaceDestination): Promise<SurfaceSendResult>;
  /** 更新已发送的消息 */
  update(ref: SurfaceMessageRef, message: SurfaceMessage): Promise<void>;
  /** 删除已发送的消息 */
  delete(ref: SurfaceMessageRef): Promise<void>;
  /** 对消息打表情回应 */
  react(ref: SurfaceMessageRef, emoji: string): Promise<void>;

  /** 呈现审批卡片（不支持时抛 SurfaceCapabilityError） */
  presentApproval(request: ApprovalRequest, opts?: ApprovalPresentOpts): Promise<ApprovalHandle>;
  /** 请求转接人工 / 其他 agent（不支持时抛 SurfaceCapabilityError） */
  requestAgentHandoff(request: HandoffRequest): Promise<HandoffHandle>;
  /** 拉取对话上下文 */
  pullContext(query: SurfaceContextQuery): Promise<SurfaceContextResult>;
  /** 解析目标查询为具体 SurfaceDestination */
  resolveDestination(query: DestinationQuery, authorityId: string): Promise<DestinationResolution>;
  /** 打开多人会话 */
  openGroup(participants: readonly string[]): Promise<{ groupId: string } | { error: string }>;

  /** 启动 surface（建立连接 / 启动消费者） */
  start(): Promise<void>;
  /** 停止 surface（释放资源） */
  stop(): Promise<void>;
}