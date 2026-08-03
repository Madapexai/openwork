/**
 * AgentSidecar 类型定义
 *
 * 设计参考：
 * - cc-connect: 能力可选接口（capability-based），避免 type-switch
 * - paperclip: Mutable Adapter Registry，运行时可扩展
 * - multica: Runtime auto-detect PATH，启动时扫描可用 agent
 * - orca: "Works with any CLI agent"，不抽象 agent，靠隔离层提供差异
 *
 * 5 个 SidecarProtocol 覆盖所有 CLI agent：
 * - acp:      Agent Client Protocol (Zed 主导，JSON-RPC over stdio)
 * - http:     HTTP REST + SSE (如 opencode serve)
 * - pty:      直接 spawn 进程，解析 ANSI 输出
 * - mcp:      Model Context Protocol (agent 作为 MCP server)
 * - generic:  Bash/HTTP wrapper (paperclip 风格的兜底适配)
 */

/** Sidecar 通信协议分类 */
export type SidecarProtocol = "acp" | "http" | "pty" | "mcp" | "generic";

/** Agent 启动选项 */
export interface SidecarStartOptions {
  /** 工作目录 */
  cwd: string;
  /** 主机名（仅 http/acp-over-tcp 生效） */
  hostname?: string;
  /** 端口（仅 http 生效，留空则自动分配） */
  port?: number;
  /** 排除的端口列表 */
  excludedPorts?: number[];
  /** 启动超时（毫秒），默认 15000 */
  timeoutMs?: number;
  /** 空闲超时（毫秒），借鉴 cc-connect，0 表示不回收 */
  idleTimeoutMs?: number;
  /** 环境变量 */
  env?: Record<string, string | undefined>;
  /** 额外参数 */
  args?: string[];
  /** 显式 PATH（避免父进程 PATH 污染） */
  path?: string;
}

/** Agent 检测结果 */
export interface AgentDetectResult {
  /** Agent ID（如 "kimi"、"claude-code"） */
  agentId: string;
  /** 是否在 PATH 上找到 */
  available: boolean;
  /** 二进制绝对路径 */
  binaryPath?: string;
  /** 版本号（如能获取） */
  version?: string;
  /** 检测时的错误信息 */
  error?: string;
}

/** Doctor 健康检查信息 */
export interface AgentDoctorInfo {
  agentId: string;
  healthy: boolean;
  binaryName: string;
  binaryPath?: string;
  /** 是否已认证 */
  authenticated?: boolean;
  /** 检查详情 */
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

/** Agent sidecar 运行句柄 */
export interface SidecarHandle {
  /** 协议类型 */
  readonly protocol: SidecarProtocol;
  /** Agent ID */
  readonly agentId: string;
  /** HTTP base URL（http 协议） */
  readonly baseUrl?: string;
  /** 进程 ID（local spawn 场景） */
  readonly processId?: number;
  /** 传输层信息（用于日志与诊断） */
  readonly transportInfo: TransportInfo;
  /** 是否存活 */
  isAlive(): boolean;
  /** 停止 sidecar */
  stop(): Promise<void>;
}

/** 传输层元信息 */
export interface TransportInfo {
  /** 启动命令 */
  command: string;
  /** 启动参数 */
  args: string[];
  /** 工作目录 */
  cwd: string;
  /** 关键环境变量（已脱敏） */
  env: Array<{ name: string; value: string; redacted: boolean }>;
}

/** Agent sidecar adapter 抽象接口 */
export interface AgentSidecarAdapter {
  /** 协议类型 */
  readonly protocol: SidecarProtocol;
  /** Agent ID（如 "kimi"、"claude-code"） */
  readonly agentId: string;
  /** 显示名 */
  readonly displayName: string;
  /** 能力声明（可选，capability-based） */
  readonly capabilities?: SidecarCapabilities;

  /** 启动 sidecar */
  start(options: SidecarStartOptions): Promise<SidecarHandle>;
  /** 检测 agent 是否可用（PATH 扫描） */
  detect(): Promise<AgentDetectResult>;
  /** 健康检查 */
  doctor(): Promise<AgentDoctorInfo>;
}

/** 能力声明（参考 cc-connect capability interface） */
export interface SidecarCapabilities {
  /** 流式响应 */
  streaming?: boolean;
  /** 支持权限请求（ACP requestPermission） */
  permissions?: boolean;
  /** 多 session 并发 */
  multiSession?: boolean;
  /** 模型切换 */
  modelSwitch?: boolean;
  /** 工作区隔离（orca worktree 风格） */
  worktree?: boolean;
  /** 心跳保活（paperclip 风格） */
  heartbeat?: boolean;
  /** 成本追踪 */
  costTracking?: boolean;
  /** 卡片消息（IM 风格） */
  cardMessages?: boolean;
  /** 文件拖入 prompt */
  filePicker?: boolean;
  /** 图片输入 */
  imageInput?: boolean;
  /** 音频输入 */
  audioInput?: boolean;
  /** 嵌入式上下文 */
  embeddedContext?: boolean;
  /** MCP 客户端能力（agent 主动连接外部 MCP） */
  mcpClient?: boolean;
  /** 文档同步（编辑器 ↔ agent） */
  documentSync?: boolean;
}

/** Agent 配置（持久化用，借鉴 cc-connect [[projects]] + multica presets） */
export interface AgentSidecarConfig {
  /** Agent ID（如 "kimi"、"claude-code"） */
  agentId: string;
  /** 协议 */
  protocol: SidecarProtocol;
  /** 二进制名（PATH 上的可执行名） */
  binary?: string;
  /** 二进制绝对路径（覆盖 PATH 查找） */
  binaryPath?: string;
  /** 默认工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 启动参数 */
  args?: string[];
  /** 启动超时 */
  startupTimeoutMs?: number;
  /** 空闲超时 */
  idleTimeoutMs?: number;
  /** 能力覆盖（覆盖 preset 默认值） */
  capabilities?: Partial<SidecarCapabilities>;
  /** 集群 generic 专用：命令模板 */
  commandTemplate?: string;
  /** 集群 generic 专用：输出解析器 */
  outputParser?: "jsonl" | "ansi" | "regex" | "none";
  /** 集群 generic 专用：正则模式 */
  outputPattern?: string;
  /** 显示名覆盖 */
  displayName?: string;
  /** 是否禁用 */
  disabled?: boolean;
}

/** Adapter 工厂函数 */
export type AdapterFactory = (config: AgentSidecarConfig) => AgentSidecarAdapter;

/** Agent 消息（统一事件流） */
export type AgentMessage =
  | { kind: "prompt"; text: string; images?: string[] }
  | { kind: "cancel" }
  | { kind: "permission-response"; requestId: string; optionId: string }
  | { kind: "set-mode"; mode: string };

/** Agent 事件（统一事件流，源自 ACP session/update） */
export type AgentEvent =
  | { kind: "agent-message-chunk"; text: string }
  | { kind: "agent-message-chunk-image"; mediaType: string; data: string }
  | { kind: "tool-call"; toolCallId: string; title: string; status: string }
  | { kind: "tool-call-update"; toolCallId: string; status: string }
  | { kind: "plan"; plan: unknown }
  | { kind: "agent-thought-chunk"; text: string }
  | { kind: "user-message-chunk"; text: string }
  | { kind: "permission-request"; requestId: string; toolCall: { title: string; options: Array<{ optionId: string; name: string; kind: string }> } }
  | { kind: "stop"; stopReason: string }
  | { kind: "error"; error: string };

/** 会话句柄 */
export interface SessionHandle {
  /** 会话 ID */
  readonly sessionId: string;
  /** 发送消息 */
  send(message: AgentMessage): Promise<void>;
  /** 订阅事件流 */
  events(): AsyncIterable<AgentEvent>;
  /** 停止会话 */
  stop(): Promise<void>;
}
