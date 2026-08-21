/**
 * Agent Team / Relay 类型定义
 *
 * 设计参考：
 * - multica: 多 agent 任务分配（dispatch policy + capability matching）
 * - paperclip: 零人工公司（orchestrator 路由任务到不同 agent）
 * - orca: 并行 worktree 隔离（fan-out 到多 agent 同时执行）
 * - cc-connect: capability-based agent selection
 *
 * 三种编排模式：
 * - dispatch: 把一个任务交给一个 agent（按 policy 选）
 * - relay: 多 agent 串行链式接力（A 的输出 → B 的输入 → C 的输入）
 * - broadcast: 多 agent 并行执行同一任务，收集所有输出
 *
 * 不直接调 LLM，只通过 AgentSidecarAdapter 接入 CLI agent。
 */

import type {
  AgentEvent,
  AgentSidecarAdapter,
  SidecarCapabilities,
  SidecarHandle,
} from "../agent-sidecar/types.js";
import type { MergeOptions, MergeResult, WorktreeDiff } from "./worktree-manager.js";

// Re-export for downstream consumers
export type { AgentEvent, AgentSidecarAdapter };

// Re-export new modules
export type { WorktreeInfo, WorktreeConfig, MergeStrategy, MergeOptions, MergeResult, WorktreeDiff } from "./worktree-manager.js";
export type { AgentMessage, AgentMessageType } from "./message-bus.js";
export type { SupervisorConfig, SupervisorDecision, SubTaskAssignment } from "./supervisor.js";
export type { ModelCostConfig, RoleModelRecommendation } from "./cost-efficiency-router.js";
export type { PlanActConfig, PlanPhaseResult, ActPhaseResult, PlanActRunOptions } from "./plan-act.js";
export type { SshTunnelConfig, SshTunnelHandle } from "./ssh-relay.js";
export type { CloudContextEntry, CloudSessionState, CloudContextHandle, CloudContextStoreOptions } from "./cloud-context.js";
export type { TeamStrategyId, TeamStrategyMeta, TeamStrategyConfig } from "./team-strategies.js";
export type { HarnessKind, HarnessCapabilities, HarnessHealth, HarnessDefinition } from "./harness-environment.js";

// ============================================================
// Team 成员与配置
// ============================================================

/** 团队成员角色 */
export type MemberRole =
  | "primary"      // 主力 agent，默认承担任务
  | "reviewer"     // 审查/校对
  | "fallback"     // 主力失败时启用
  | "specialist"   // 特定领域专家（capability-match 时启用）
  | "observer";    // 只读，仅广播模式下参与

/** 团队成员 */
export interface AgentTeamMember {
  /** Agent ID（对应 presets.ts 的 key） */
  agentId: string;
  /** Adapter 实例（已绑定 preset 配置） */
  adapter: AgentSidecarAdapter;
  /** 角色 */
  role?: MemberRole;
  /** 能力覆盖（覆盖 adapter.capabilities） */
  capabilities?: SidecarCapabilities;
  /** 启动后产生的 handle（运行时填充） */
  handle?: SidecarHandle;
}

/** 分派策略 */
export type DispatchPolicy =
  | { kind: "round-robin" }
  | { kind: "first-available" }
  | { kind: "capability-match"; required: Partial<SidecarCapabilities> }
  | { kind: "primary-with-fallback"; primary: string; fallbacks: string[] }
  | { kind: "role-based"; role: MemberRole }
  | { kind: "llm-supervisor"; model: string; providerID: string; prompt?: string };

/** 接力策略 */
export type RelayStrategy =
  | { kind: "chain" }              // 串行：A → B → C，前一个的输出作为后一个的输入
  | { kind: "broadcast" }          // 并行：所有 agent 同时执行同一输入，收集所有事件
  | { kind: "fan-out" };           // 分发：每个 agent 处理不同的子任务（assignment）

/** Team 配置 */
export interface AgentTeamConfig {
  /** 团队 ID */
  teamId: string;
  /** 显示名 */
  displayName?: string;
  /** 成员列表 */
  members: AgentTeamMember[];
  /** 默认分派策略 */
  dispatchPolicy: DispatchPolicy;
  /** 默认接力策略（可选，未指定则不支持 relay） */
  relayStrategy?: RelayStrategy;
  /** 是否在 team.start() 时立即启动所有成员 */
  eagerStart?: boolean;
  /** 启动超时（毫秒），默认 30000 */
  startupTimeoutMs?: number;

  // ===== Worktree 隔离配置 =====
  /** 是否启用 worktree 隔离（默认 true） */
  worktreeIsolation?: boolean;
  /** worktree 基准分支（默认 "main"） */
  worktreeBaseBranch?: string;
  /** worktree 目录前缀 */
  worktreePrefix?: string;

  // ===== 模型分配配置 =====
  /** 按角色分配模型（覆盖默认 CostEfficiencyRouter 推荐） */
  roleModels?: Partial<Record<MemberRole, { providerID: string; modelID: string }>>;
  /** 预算上限（美元/1M tokens） */
  maxCostPerMillion?: number;

  // ===== 共享上下文 =====
  /** 所有 agent 共享的系统提示 */
  sharedSystemPrompt?: string;
  /** 共享的上下文文件路径（注入到每个 agent 的 prompt） */
  sharedContextFiles?: string[];
  /** 共享变量（注入到每个 agent 的环境） */
  sharedVariables?: Record<string, string>;

  // ===== 进程池配置 =====
  /** 是否使用全局 SidecarProcessPool（默认 true） */
  useProcessPool?: boolean;
}

// ============================================================
// 任务与事件
// ============================================================

/** 输入任务 */
export interface TeamTask {
  /** 任务 ID（用于追踪） */
  taskId: string;
  /** Prompt 文本 */
  prompt: string;
  /** 图片（base64 或 URL） */
  images?: string[];
  /** 工作目录 */
  cwd: string;
  /** 显式指定的 agentId（覆盖 dispatch policy） */
  explicitAgentId?: string;
  /** 任务超时（毫秒），0 表示不超时 */
  timeoutMs?: number;
}

/** Relay 输入（用于 relay pipeline） */
export interface RelayInput {
  /** Pipeline ID（用于追踪） */
  pipelineId: string;
  /** 初始 prompt */
  prompt: string;
  /** 工作目录 */
  cwd: string;
  /** 接力阶段（agentId 顺序列表） */
  stages: string[];
  /** 每阶段超时（毫秒），0 表示不超时 */
  stageTimeoutMs?: number;
}

/**
 * Fan-out 子任务（一个 agent 处理一个子任务）
 *
 * 借鉴 multica 的 task assignment：每个成员拿到不同的 prompt，
 * 用于并行执行异构子任务（如：A 写代码、B 写测试、C 写文档）。
 */
export interface FanOutAssignment {
  /** 子任务 ID（用于追踪） */
  subtaskId: string;
  /** 目标 agentId（必须为 team 成员） */
  agentId: string;
  /** 该 agent 收到的 prompt */
  prompt: string;
  /** 该子任务超时（毫秒），0 表示用默认 */
  timeoutMs?: number;
}

/** Fan-out 输入 */
export interface FanOutInput {
  /** Fan-out ID（用于追踪） */
  fanOutId: string;
  /** 工作目录 */
  cwd: string;
  /** 子任务分配列表（每个 agent 一个 prompt） */
  assignments: FanOutAssignment[];
  /** 默认每子任务超时（毫秒） */
  defaultTimeoutMs?: number;
}

/** Team 事件流 */
export type TeamEvent =
  | { kind: "task-assigned"; taskId: string; agentId: string; role?: MemberRole }
  | { kind: "task-event"; taskId: string; agentId: string; event: AgentEvent }
  | { kind: "task-completed"; taskId: string; agentId: string; finalText: string }
  | { kind: "task-failed"; taskId: string; agentId: string; error: string }
  | { kind: "task-timeout"; taskId: string; agentId: string };

/**
 * Fan-out 事件流（每个子任务独立追踪）
 *
 * 借鉴 paperclip 的 sub-task 跟踪机制：
 * - 每个 assignment 一个 subtaskId
 * - 事件流仍复用 TeamEvent 形态，但携带 subtaskId
 */
export type FanOutEvent =
  | { kind: "subtask-assigned"; fanOutId: string; subtaskId: string; agentId: string }
  | { kind: "subtask-event"; fanOutId: string; subtaskId: string; agentId: string; event: AgentEvent }
  | { kind: "subtask-completed"; fanOutId: string; subtaskId: string; agentId: string; finalText: string }
  | { kind: "subtask-failed"; fanOutId: string; subtaskId: string; agentId: string; error: string }
  | { kind: "subtask-timeout"; fanOutId: string; subtaskId: string; agentId: string }
  | { kind: "fanout-completed"; fanOutId: string; results: Array<{ subtaskId: string; agentId: string; finalText: string | null; error?: string }> };

/** Relay 阶段事件 */
export type RelayStageEvent =
  | { kind: "stage-started"; pipelineId: string; stageIndex: number; agentId: string; input: string }
  | { kind: "stage-event"; pipelineId: string; stageIndex: number; agentId: string; event: AgentEvent }
  | { kind: "stage-completed"; pipelineId: string; stageIndex: number; agentId: string; output: string }
  | { kind: "stage-failed"; pipelineId: string; stageIndex: number; agentId: string; error: string }
  | { kind: "pipeline-completed"; pipelineId: string; finalOutput: string };

// ============================================================
// Team 运行时句柄
// ============================================================

/** Team 运行时句柄 */
export interface AgentTeamHandle {
  /** 团队 ID */
  readonly teamId: string;
  /** 成员快照（已启动的） */
  readonly members: ReadonlyArray<AgentTeamMember>;
  /** 是否所有成员都存活 */
  allAlive(): boolean;
  /** 获取指定 agentId 的成员 */
  getMember(agentId: string): AgentTeamMember | undefined;
  /** 启动尚未启动的成员 */
  ensureMemberStarted(agentId: string): Promise<SidecarHandle>;
  /** 停止所有成员 */
  stop(): Promise<void>;

  // ===== 新增：Worktree 隔离 =====
  /** 获取指定 agent 的 worktree 路径（cwd） */
  getAgentCwd(agentId: string, baseCwd: string): string;
  /** 获取所有 worktree 信息 */
  listWorktrees(): Array<{ path: string; agentId: string; isGitWorktree: boolean }>;
  /** 获取指定 worktree 的变更差异 */
  getWorktreeDiff?(worktreePath: string): WorktreeDiff;
  /** 合并所有 worktree 变更回目标分支 */
  mergeWorktrees?(options?: MergeOptions): MergeResult;

  // ===== 新增：消息总线 =====
  /** 发送 agent 间消息 */
  sendMessage(msg: { fromAgentId: string; toAgentId: string; content: string; type?: "direct" | "broadcast" | "system" }): Promise<{ id: string }>;
  /** 订阅发往指定 agent 的消息 */
  subscribeMessages(agentId: string, handler: (msg: { id: string; fromAgentId: string; content: string; type: string }) => void): () => void;

  // ===== 新增：Supervisor =====
  /** 使用 LLM Supervisor 分解任务为子任务 */
  decomposeTask(taskPrompt: string): Promise<Array<{ subtaskId: string; agentId: string; prompt: string; dependencies: string[] }>>;
  /** 使用 LLM Supervisor 选择最优 agent */
  coordinateTask(taskPrompt: string): Promise<string>;

  // ===== 新增：Kill-switch =====
  /** 强制停止指定 agent（kill-switch） */
  killAgent(agentId: string): Promise<void>;
  /** 获取 team 运行状态 */
  getStatus(): { teamId: string; alive: boolean; memberCount: number; activeTasks: number };
}
