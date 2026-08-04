import { relations, sql } from "drizzle-orm"
import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import { compatJsonColumn, denTypeIdColumn, timestamps } from "../columns"
import { MemberTable, OrganizationTable } from "./org"
import { TeamTable } from "./teams"

// ============================================================
// 团队自治 Schema — 基于 WorkBuddy Bluebook 调研修正
// 团队为第一等公民，兼容个人管理（Personal Team 自动创建）
// ============================================================
//
// 设计依据：
// - WorkBuddy Bluebook Ch3 三模式（Ask/Craft/Plan）
// - WorkBuddy Bluebook Ch6 专家团（角色 + 协作流程）
// - WorkBuddy Bluebook Ch10/25 自动化状态机 + 降级交付 + 可行动告警
// - WorkBuddy Bluebook Ch22 Skill 三重验证 + 诱饵测试
// - WorkBuddy Bluebook Ch24 多 Agent 系统设计（角色契约 + 共享产物层）
// - 借鉴 LangGraph Checkpoint 持久化、Temporal 4 超时 + RetryOptions
// - 借鉴 CrewAI expected_output（升级为 forbidden_actions 契约）
// - 复用 openwork 现有 ConfigObjectTable（Skill/Agent/MCP 统一抽象）
//   + PluginAccessGrantTable（viewer/editor/manager 三级 RBAC）
// ============================================================

// ---------- Team 表升级（团队第一等公民） ----------
// TeamTable 在 ./teams.ts 中已新增 slug / kind / settings / ownerUserId 字段
// 通过 0050_team_autonomy.sql 的 ALTER TABLE 落库
// TeamKind 类型也从 ./teams.ts 导出

export const PermissionMode = ["ask", "craft", "plan", "interactive", "auto", "custom"] as const
export type PermissionMode = (typeof PermissionMode)[number]

// ---------- 角色 ----------
// WorkBuddy Bluebook Ch24 角色契约：输入 / 输出 / 禁止动作
// CrewAI 的 expected_output 是其简化版
export const TeamRoleName = ["owner", "admin", "editor", "viewer"] as const

// 双轨权限模式：
// - 个人 / 简单用户：3 模式（Ask / Craft / Plan）—— WorkBuddy 风格
// - 团队 / 自治场景：5 模式（Discuss / Plan / Interactive / Auto / Custom）—— OpenWorker 风格
// 团队 admin 在 team_permission_profile 中决定团队用哪套
export const PermissionProfile = ["simple", "advanced"] as const

export const TeamRoleTable = mysqlTable(
  "team_role",
  {
    id: denTypeIdColumn("teamRole", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    name: mysqlEnum("name", TeamRoleName).notNull(),
    // 权限位集合：{ can_create_task, can_approve_plan, can_manage_agents, can_manage_budget, ... }
    permissions: compatJsonColumn<Record<string, boolean>>("permissions").notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamps.updated_at,
  },
  (table) => [
    index("team_role_team_id").on(table.team_id),
    uniqueIndex("team_role_team_name").on(table.team_id, table.name),
  ],
)

// ---------- 团队 Agent 池 ----------
// 一个 Team 可挂多个 Agent（OpenWorker sidecar 实例）
// WorkBuddy Bluebook Ch24：角色契约（输入 / 输出 / 禁止动作）
export const TeamAgentStatus = ["idle", "busy", "paused", "offline", "error"] as const
// engine='cli' 表示通用 CLI agent 引擎（Kimi AtomCode / Freebuff / Claude Code 等），
// 启动/协议信息存 engine_config（见 EngineConfigProtocol / TeamAgentEngineConfig）
export const TeamAgentEngine = ["openworker", "opencode", "mcp", "generic", "cli"] as const

// engine_config 协议类型：pty（伪终端）/ headless（无头）/ jsonrpc（JSON-RPC 通道）
export const EngineConfigProtocol = ["pty", "headless", "jsonrpc"] as const
export type EngineConfigProtocol = (typeof EngineConfigProtocol)[number]

// engine='cli' 时 binary 必填、protocol 必填（见 openspec-team-agent-engine-cli.md I1/I2）
export type TeamAgentEngineConfig = {
  binary: string
  args?: string[]
  protocol?: EngineConfigProtocol
  cwd?: string
  env?: Record<string, string>
  supported?: string[]
}

export const TeamAgentTable = mysqlTable(
  "team_agent",
  {
    id: denTypeIdColumn("teamAgent", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    engine: mysqlEnum("engine", TeamAgentEngine).notNull().default("openworker"),
    // 通用 CLI agent 引擎配置（engine='cli' 时必填 binary + protocol；可空）
    engine_config: compatJsonColumn<TeamAgentEngineConfig | null>("engine_config"),
    role_id: denTypeIdColumn("teamRole", "role_id"),
    // persona 指令（人设 + 方法论）
    persona: text("persona"),
    // 关联的 ConfigObject（Skill / Agent 模板）
    skills: compatJsonColumn<string[]>("skills"),
    connectors: compatJsonColumn<string[]>("connectors"),
    model_default: varchar("model_default", { length: 64 }),
    status: mysqlEnum("status", TeamAgentStatus).notNull().default("idle"),
    // 当前关联的 sidecar session
    sidecar_session_id: varchar("sidecar_session_id", { length: 128 }),
    // 角色契约：禁止动作（WorkBuddy Ch24 关键设计）
    // 例：["不跳过子任务验收直接交付","不引入 Brief 未确认的信息"]
    forbidden_actions: compatJsonColumn<string[]>("forbidden_actions"),
    // 当前正在执行的任务
    current_task_id: denTypeIdColumn("teamTask", "current_task_id"),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamps.updated_at,
  },
  (table) => [
    index("team_agent_team_id").on(table.team_id),
    index("team_agent_status").on(table.team_id, table.status),
    index("team_agent_role_id").on(table.role_id),
  ],
)

// ---------- 项目看板 + 任务依赖图 ----------
// WorkBuddy Bluebook Ch24：主理人职责（拆解 / 分发 / 等待 / 重试 / 拍板 / 合成）
export const TeamBoardTable = mysqlTable(
  "team_board",
  {
    id: denTypeIdColumn("teamBoard", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    // ["todo","in_progress","review","done"]
    columns: compatJsonColumn<string[]>("columns").notNull(),
    created_by: denTypeIdColumn("member", "created_by").notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamps.updated_at,
  },
  (table) => [index("team_board_team_id").on(table.team_id)],
)

export const TaskPriority = ["low", "medium", "high", "urgent"] as const
export const TaskAssigneeType = ["member", "agent"] as const
export const PlanStatus = ["none", "pending", "approved", "rejected", "revision_requested"] as const

export const TeamTaskTable = mysqlTable(
  "team_task",
  {
    id: denTypeIdColumn("teamTask", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    board_id: denTypeIdColumn("teamBoard", "board_id"),
    title: varchar("title", { length: 256 }).notNull(),
    description: text("description"),
    // 当前所在列
    status: varchar("status", { length: 32 }).notNull().default("todo"),
    column_id: varchar("column_id", { length: 32 }).notNull(),
    // 分配给谁（member 或 agent）
    assignee_type: mysqlEnum("assignee_type", TaskAssigneeType).notNull(),
    assignee_id: varchar("assignee_id", { length: 64 }).notNull(),
    created_by: denTypeIdColumn("member", "created_by").notNull(),
    priority: mysqlEnum("priority", TaskPriority).notNull().default("medium"),
    // 任务依赖图：depends_on + blocks（反向自动维护）
    depends_on: compatJsonColumn<string[]>("depends_on"),
    blocks: compatJsonColumn<string[]>("blocks"),
    // 计划审批（WorkBuddy Ch3 Plan 模式 + Ch24 三个必须由人确认的点）
    plan: text("plan"),
    plan_status: mysqlEnum("plan_status", PlanStatus).notNull().default("none"),
    plan_approved_by: denTypeIdColumn("member", "plan_approved_by"),
    plan_approved_at: timestamp("plan_approved_at", { fsp: 3 }),
    // 任务产出物引用（artifact_id 列表）
    artifacts: compatJsonColumn<string[]>("artifacts"),
    started_at: timestamp("started_at", { fsp: 3 }),
    completed_at: timestamp("completed_at", { fsp: 3 }),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamps.updated_at,
  },
  (table) => [
    index("team_task_team_status").on(table.team_id, table.status),
    index("team_task_assignee").on(table.assignee_type, table.assignee_id),
    index("team_task_board").on(table.board_id, table.column_id),
    index("team_task_plan_status").on(table.team_id, table.plan_status),
  ],
)

// 任务移交记录（保留上下文快照）
export const TeamTaskHandoffTable = mysqlTable(
  "team_task_handoff",
  {
    id: denTypeIdColumn("teamTaskHandoff", "id").notNull().primaryKey(),
    task_id: denTypeIdColumn("teamTask", "task_id").notNull(),
    from_assignee_type: mysqlEnum("from_assignee_type", TaskAssigneeType).notNull(),
    from_assignee_id: varchar("from_assignee_id", { length: 64 }).notNull(),
    to_assignee_type: mysqlEnum("to_assignee_type", TaskAssigneeType).notNull(),
    to_assignee_id: varchar("to_assignee_id", { length: 64 }).notNull(),
    reason: text("reason"),
    // 移交时的会话/上下文快照（agent 状态、已读消息、已生成产物引用）
    context_snapshot: compatJsonColumn<Record<string, unknown>>("context_snapshot"),
    handed_at: timestamp("handed_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index("team_task_handoff_task_id").on(table.task_id)],
)

// ---------- 共享产物层（修正 1：artifact 状态机） ----------
// WorkBuddy Bluebook Ch24 关键设计：
//   "角色之间不通过对话传递关键内容细节，下游只读取上游已确认的产物"
// 单一事实源，状态机控制可读性
export const ArtifactKind = [
  "document",
  "spreadsheet",
  "presentation",
  "image",
  "data",
  "config",
  "code",
  "video",
  "audio",
  "other",
] as const

export const ArtifactStatus = ["draft", "in_review", "confirmed", "superseded", "archived"] as const

export const TeamArtifactTable = mysqlTable(
  "team_artifact",
  {
    id: denTypeIdColumn("teamArtifact", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    // 产出该 artifact 的任务（可空，如手动上传）
    task_id: denTypeIdColumn("teamTask", "task_id"),
    name: varchar("name", { length: 256 }).notNull(),
    kind: mysqlEnum("kind", ArtifactKind).notNull(),
    mime_type: varchar("mime_type", { length: 128 }),
    storage_uri: varchar("storage_uri", { length: 1024 }).notNull(),
    size_bytes: int("size_bytes").notNull(),
    // 状态机：draft → in_review → confirmed → superseded → archived
    // 下游角色只能读取 confirmed 状态的 artifact
    status: mysqlEnum("status", ArtifactStatus).notNull().default("draft"),
    // 当前版本号（指向 team_artifact_version.version_number）
    current_version: int("current_version").notNull().default(1),
    // 产出者（agent 或 member）
    produced_by_type: mysqlEnum("produced_by_type", TaskAssigneeType).notNull(),
    produced_by_id: varchar("produced_by_id", { length: 64 }).notNull(),
    // 确认者（必须是主理人 / team owner / admin）
    confirmed_by: denTypeIdColumn("member", "confirmed_by"),
    confirmed_at: timestamp("confirmed_at", { fsp: 3 }),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamps.updated_at,
  },
  (table) => [
    index("team_artifact_team_kind").on(table.team_id, table.kind),
    index("team_artifact_team_status").on(table.team_id, table.status),
    index("team_artifact_task_id").on(table.task_id),
    index("team_artifact_produced_by").on(table.produced_by_type, table.produced_by_id),
  ],
)

export const TeamArtifactVersionTable = mysqlTable(
  "team_artifact_version",
  {
    id: denTypeIdColumn("teamArtifactVersion", "id").notNull().primaryKey(),
    artifact_id: denTypeIdColumn("teamArtifact", "artifact_id").notNull(),
    version_number: int("version_number").notNull(),
    storage_uri: varchar("storage_uri", { length: 1024 }).notNull(),
    size_bytes: int("size_bytes").notNull(),
    change_summary: text("change_summary"),
    produced_by_type: mysqlEnum("produced_by_type", TaskAssigneeType).notNull(),
    produced_by_id: varchar("produced_by_id", { length: 64 }).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("team_artifact_version_artifact_version").on(table.artifact_id, table.version_number),
    index("team_artifact_version_artifact").on(table.artifact_id, table.version_number),
  ],
)

// ---------- 团队信箱（成员 + agent 间异步通信） ----------
export const MailboxRecipientType = ["member", "agent", "channel"] as const
export const MailboxSenderType = ["member", "agent", "system"] as const
export const MailboxKind = ["message", "task_update", "approval_request", "notification"] as const

export const TeamMailboxTable = mysqlTable(
  "team_mailbox",
  {
    id: denTypeIdColumn("teamMailbox", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    recipient_type: mysqlEnum("recipient_type", MailboxRecipientType).notNull(),
    recipient_id: varchar("recipient_id", { length: 64 }).notNull(),
    sender_type: mysqlEnum("sender_type", MailboxSenderType).notNull(),
    sender_id: varchar("sender_id", { length: 64 }).notNull(),
    kind: mysqlEnum("kind", MailboxKind).notNull(),
    subject: varchar("subject", { length: 256 }),
    body: text("body"),
    // 关联的 artifact_id 列表（替代"通过对话传递关键内容"）
    attachment_refs: compatJsonColumn<string[]>("attachment_refs"),
    related_task_id: denTypeIdColumn("teamTask", "related_task_id"),
    read_at: timestamp("read_at", { fsp: 3 }),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("team_mailbox_recipient").on(table.recipient_type, table.recipient_id, table.read_at),
    index("team_mailbox_team_time").on(table.team_id, table.created_at),
    index("team_mailbox_related_task").on(table.related_task_id),
  ],
)

// ---------- 团队预算（角色级配额） ----------
// WorkBuddy Bluebook 5.0：管理员/编辑者/查看者三级 + Token 预算
export const BudgetPeriod = ["daily", "weekly", "monthly"] as const
export const BudgetEntityType = ["member", "agent", "role"] as const

export const TeamBudgetTable = mysqlTable(
  "team_budget",
  {
    id: denTypeIdColumn("teamBudget", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    period: mysqlEnum("period", BudgetPeriod).notNull().default("monthly"),
    total_tokens: int("total_tokens").notNull(),
    used_tokens: int("used_tokens").notNull().default(0),
    total_cost_cents: int("total_cost_cents").notNull(),
    used_cost_cents: int("used_cost_cents").notNull().default(0),
    reset_at: timestamp("reset_at", { fsp: 3 }).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamps.updated_at,
  },
  (table) => [uniqueIndex("team_budget_team_period").on(table.team_id, table.period)],
)

export const TeamBudgetAllocationTable = mysqlTable(
  "team_budget_allocation",
  {
    id: denTypeIdColumn("teamBudgetAllocation", "id").notNull().primaryKey(),
    budget_id: denTypeIdColumn("teamBudget", "budget_id").notNull(),
    entity_type: mysqlEnum("entity_type", BudgetEntityType).notNull(),
    entity_id: varchar("entity_id", { length: 64 }).notNull(),
    allocated_tokens: int("allocated_tokens").notNull(),
    used_tokens: int("used_tokens").notNull().default(0),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamps.updated_at,
  },
  (table) => [
    uniqueIndex("team_budget_allocation_budget_entity").on(table.budget_id, table.entity_type, table.entity_id),
  ],
)

// ---------- 团队自动化（修正 2：状态机 + 降级交付 + 可行动告警） ----------
// WorkBuddy Bluebook Ch25：从"能用"到"可靠"的工程级方法论
// 借鉴 LangGraph Checkpoint（断点续跑 state JSON）
// 借鉴 Temporal 4 超时 + RetryOptions（retry_policy JSON）
export const AutomationState = [
  "waiting_trigger",
  "fetching",
  "partial_aggregating",
  "aggregating",
  "filtering",
  "delivering",
  "completed",
  "blocked",
  "failed",
] as const

export const DegradationLevel = ["full", "partial", "minimal", "blocked"] as const

export const TeamAutomationTable = mysqlTable(
  "team_automation",
  {
    id: denTypeIdColumn("teamAutomation", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    cron_expr: varchar("cron_expr", { length: 64 }).notNull(),
    message: text("message").notNull(),
    agent_id: denTypeIdColumn("teamAgent", "agent_id"),
    // 自动化免审批范围（standing rule scoped to this automation）
    scoped_approvals: compatJsonColumn<Record<string, unknown>>("scoped_approvals"),
    timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Shanghai"),
    enabled: boolean("enabled").notNull().default(true),
    last_run_at: timestamp("last_run_at", { fsp: 3 }),
    next_run_at: timestamp("next_run_at", { fsp: 3 }),
    skip_on_overlap: boolean("skip_on_overlap").notNull().default(true),
    run_once_catch_up: boolean("run_once_catch_up").notNull().default(true),
    // WorkBuddy Ch25 上线前必须跑过 3 次手动
    manual_run_count: int("manual_run_count").notNull().default(0),
    ready_for_schedule: boolean("ready_for_schedule").notNull().default(false),
    // 质量门禁（WorkBuddy Ch25：相关性/时效性/重复性/最低数量）
    quality_gate: compatJsonColumn<Record<string, unknown>>("quality_gate"),
    // 重试策略（借鉴 Temporal RetryOptions）
    // { schedule_to_close_seconds, start_to_close_seconds, heartbeat_seconds,
    //   max_attempts, backoff_coefficient, retry_on: [...], no_retry_on: [401,403] }
    retry_policy: compatJsonColumn<Record<string, unknown>>("retry_policy"),
    // 推送目标（多目标，幂等控制用 batch_id）
    // [{ kind: "feishu_group", target: "...", idempotency_key: "ai-hotspot-{date}" }]
    delivery_targets: compatJsonColumn<Array<Record<string, unknown>>>("delivery_targets"),
    // 单次运行成本上限（分）
    max_cost_cents_per_run: int("max_cost_cents_per_run"),
    owner_member_id: denTypeIdColumn("member", "owner_member_id").notNull(),
    created_by: denTypeIdColumn("member", "created_by").notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamps.updated_at,
  },
  (table) => [
    index("team_automation_team_enabled").on(table.team_id, table.enabled, table.next_run_at),
    index("team_automation_agent_id").on(table.agent_id),
  ],
)

export const TeamAutomationRunTable = mysqlTable(
  "team_automation_run",
  {
    id: denTypeIdColumn("teamAutomationRun", "id").notNull().primaryKey(),
    automation_id: denTypeIdColumn("teamAutomation", "automation_id").notNull(),
    task_id: denTypeIdColumn("teamTask", "task_id"),
    // 幂等批次 ID（WorkBuddy Ch25：ai-hotspot-2026-07-10）
    batch_id: varchar("batch_id", { length: 128 }).notNull(),
    status: mysqlEnum("status", AutomationState).notNull().default("waiting_trigger"),
    // 当前所在步骤（断点续跑用，WorkBuddy Ch25 state JSON）
    // { completed: ["fetching","aggregating"], current: "delivering",
    //   source_status: { wechat: "ok", github: "ok", ... },
    //   item_count: 18, last_error: null }
    state: compatJsonColumn<Record<string, unknown>>("state"),
    // 降级交付级别（WorkBuddy Ch25：full / partial / minimal / blocked）
    degradation_level: mysqlEnum("degradation_level", DegradationLevel),
    started_at: timestamp("started_at", { fsp: 3 }).notNull(),
    finished_at: timestamp("finished_at", { fsp: 3 }),
    error: text("error"),
    artifacts: compatJsonColumn<string[]>("artifacts"),
    tokens_used: int("tokens_used"),
    cost_cents: int("cost_cents"),
    // 上线前演练标记（WorkBuddy Ch25：5 场景演练）
    dry_run: boolean("dry_run").notNull().default(false),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("team_automation_run_batch").on(table.automation_id, table.batch_id),
    index("team_automation_run_automation_started").on(table.automation_id, table.started_at),
    index("team_automation_run_status").on(table.status),
  ],
)

// 可行动告警（WorkBuddy Ch25：必须含 7 字段）
// 批次 ID / 状态 / 触发时间 / 失败原因 / 已完成步骤 / 影响 / 建议处理 / 恢复入口
export const TeamAutomationAlertTable = mysqlTable(
  "team_automation_alert",
  {
    id: denTypeIdColumn("teamAutomationAlert", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    automation_id: denTypeIdColumn("teamAutomation", "automation_id").notNull(),
    run_id: denTypeIdColumn("teamAutomationRun", "run_id"),
    // 触发时间字符串（如 "09:00"）
    trigger_time: varchar("trigger_time", { length: 16 }),
    severity: varchar("severity", { length: 16 }).notNull().default("warning"),
    // 失败原因（必须可行动，不能只说"任务失败"）
    failure_reason: text("failure_reason").notNull(),
    // 已完成步骤（["fetching","aggregating"]）
    completed_steps: compatJsonColumn<string[]>("completed_steps"),
    // 影响描述
    impact: text("impact").notNull(),
    // 建议处理步骤（数组，每条都是可执行动作）
    suggested_actions: compatJsonColumn<string[]>("suggested_actions").notNull(),
    // 恢复入口（如 "WorkBuddy → 自动化任务 → 手动运行"）
    recovery_entry: varchar("recovery_entry", { length: 256 }).notNull(),
    // 推送状态
    delivered: boolean("delivered").notNull().default(false),
    delivered_at: timestamp("delivered_at", { fsp: 3 }),
    acknowledged_by: denTypeIdColumn("member", "acknowledged_by"),
    acknowledged_at: timestamp("acknowledged_at", { fsp: 3 }),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("team_automation_alert_team").on(table.team_id, table.delivered, table.created_at),
    index("team_automation_alert_automation").on(table.automation_id),
    index("team_automation_alert_run").on(table.run_id),
  ],
)

// ---------- Skill 三重验证 + 诱饵测试（修正 3） ----------
// WorkBuddy Bluebook Ch22：知识精馏六阶段
// 阶段 1.5 三重验证：跨域验证 / 预测力测试 / 独特性检验
// 阶段 5 压力测试：诱饵测试（不该触发的场景）+ 执行验证（真实问题）
//
// 复用 openwork 现有 ConfigObjectTable（objectType='skill'）
// 此处只新增验证元数据 + 测试用例 + 关系网
export const SkillValidationStatus = ["pending", "in_progress", "passed", "failed", "skipped"] as const
export const SkillValidationType = ["cross_domain", "predictive_power", "uniqueness"] as const

export const SkillValidationTable = mysqlTable(
  "skill_validation",
  {
    id: denTypeIdColumn("skillValidation", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    // 关联 ConfigObject（objectType='skill'）
    config_object_id: denTypeIdColumn("configObject", "config_object_id").notNull(),
    // 验证类型
    validation_type: mysqlEnum("validation_type", SkillValidationType).notNull(),
    status: mysqlEnum("status", SkillValidationStatus).notNull().default("pending"),
    // 验证证据（候选 Skill 在哪些场景出现 / 推导出哪些未讨论问题 / 独特性对比）
    evidence: compatJsonColumn<Record<string, unknown>>("evidence"),
    // 通过/未通过原因
    reason: text("reason"),
    // 验证人（人工复核，WorkBuddy Ch22 强调"读过后再蒸馏"）
    reviewed_by: denTypeIdColumn("member", "reviewed_by"),
    reviewed_at: timestamp("reviewed_at", { fsp: 3 }),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamps.updated_at,
  },
  (table) => [
    index("skill_validation_team").on(table.team_id),
    index("skill_validation_config_object").on(table.config_object_id, table.validation_type),
    index("skill_validation_status").on(table.status),
  ],
)

// 诱饵测试用例（WorkBuddy Ch22 阶段 5：故意给不该触发的场景，检验能否忍住不激活）
export const SkillTestKind = ["bait", "execution"] as const
export const SkillTestStatus = ["pending", "passed", "failed"] as const

export const SkillTestCaseTable = mysqlTable(
  "skill_test_case",
  {
    id: denTypeIdColumn("skillTestCase", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    config_object_id: denTypeIdColumn("configObject", "config_object_id").notNull(),
    kind: mysqlEnum("kind", SkillTestKind).notNull(),
    // 输入场景描述
    input: text("input").notNull(),
    // 期望行为（bait: 不应激活；execution: 应输出可落地步骤）
    expected_behavior: text("expected_behavior").notNull(),
    // 实际行为（agent 运行后填入）
    actual_behavior: text("actual_behavior"),
    status: mysqlEnum("status", SkillTestStatus).notNull().default("pending"),
    last_run_at: timestamp("last_run_at", { fsp: 3 }),
    // 兼容 darwin-skill 自动进化（WorkBuddy Ch22）
    darwin_score: int("darwin_score"),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamps.updated_at,
  },
  (table) => [
    index("skill_test_case_team").on(table.team_id),
    index("skill_test_case_config_object").on(table.config_object_id, table.kind),
    index("skill_test_case_status").on(table.status),
  ],
)

// Skill 关系网（WorkBuddy Ch22 阶段 4：依赖 / 对比 / 组合）
export const SkillLinkKind = ["dependency", "contrast", "composition"] as const

export const SkillLinkTable = mysqlTable(
  "skill_link",
  {
    id: denTypeIdColumn("skillLink", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    source_config_object_id: denTypeIdColumn("configObject", "source_config_object_id").notNull(),
    target_config_object_id: denTypeIdColumn("configObject", "target_config_object_id").notNull(),
    kind: mysqlEnum("kind", SkillLinkKind).notNull(),
    note: text("note"),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_link_team").on(table.team_id),
    index("skill_link_source").on(table.source_config_object_id),
    index("skill_link_target").on(table.target_config_object_id),
    uniqueIndex("skill_link_unique").on(table.source_config_object_id, table.target_config_object_id, table.kind),
  ],
)

// ---------- 双轨权限模式 + Standing Rule（修正 4） ----------
// 个人层 3 模式（Ask / Craft / Plan）—— WorkBuddy 风格
// 团队层 5 模式（Discuss / Plan / Interactive / Auto / Custom）—— OpenWorker 风格
// 团队 admin 在 team_permission_profile 中决定团队用哪套
export const TeamPermissionProfileTable = mysqlTable(
  "team_permission_profile",
  {
    id: denTypeIdColumn("teamPermissionProfile", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    // simple = 3 模式（Ask/Craft/Plan），advanced = 5 模式（Discuss/Plan/Interactive/Auto/Custom）
    profile: mysqlEnum("profile", PermissionProfile).notNull().default("simple"),
    // 团队默认权限模式
    default_mode: mysqlEnum("default_mode", PermissionMode).notNull().default("craft"),
    // 自定义模式规则（profile=custom 时生效）
    custom_rules: compatJsonColumn<Record<string, unknown>>("custom_rules"),
    updated_by: denTypeIdColumn("member", "updated_by").notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamps.updated_at,
  },
  (table) => [uniqueIndex("team_permission_profile_team").on(table.team_id)],
)

// Standing Rule（任务级"工具+目标"永久授权，OpenWorker 移植）
export const StandingRuleScope = ["team", "agent", "task"] as const

export const TeamStandingRuleTable = mysqlTable(
  "team_standing_rule",
  {
    id: denTypeIdColumn("teamStandingRule", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    scope: mysqlEnum("scope", StandingRuleScope).notNull(),
    // agent_id / task_id，team 级为 NULL
    scope_id: varchar("scope_id", { length: 64 }),
    tool_name: varchar("tool_name", { length: 64 }).notNull(),
    // glob 路径模式
    target_pattern: varchar("target_pattern", { length: 512 }).notNull(),
    granted_by: denTypeIdColumn("member", "granted_by").notNull(),
    granted_at: timestamp("granted_at", { fsp: 3 }).notNull().defaultNow(),
    expires_at: timestamp("expires_at", { fsp: 3 }),
    revoked_at: timestamp("revoked_at", { fsp: 3 }),
    revoked_by: denTypeIdColumn("member", "revoked_by"),
  },
  (table) => [
    index("team_standing_rule_team_scope").on(table.team_id, table.scope, table.scope_id),
    index("team_standing_rule_tool").on(table.tool_name),
  ],
)

// 团队 Inbox（融合 OpenWorker Inbox，扩展到团队级）
// 5 类消息：approval / question / notification / directory / plan
// first-responder-wins 幂等
export const TeamInboxKind = ["approval", "question", "notification", "directory", "plan"] as const
export const TeamInboxStatus = ["pending", "resolved", "denied", "superseded"] as const
export const TeamInboxAssigneeType = ["member", "agent"] as const

export const TeamInboxTable = mysqlTable(
  "team_inbox",
  {
    id: denTypeIdColumn("teamInbox", "id").notNull().primaryKey(),
    team_id: denTypeIdColumn("team", "team_id").notNull(),
    session_id: varchar("session_id", { length: 128 }),
    task_id: denTypeIdColumn("teamTask", "task_id"),
    assignee_type: mysqlEnum("assignee_type", TeamInboxAssigneeType).notNull(),
    assignee_id: varchar("assignee_id", { length: 64 }).notNull(),
    kind: mysqlEnum("kind", TeamInboxKind).notNull(),
    tool_name: varchar("tool_name", { length: 64 }),
    arguments: compatJsonColumn<Record<string, unknown>>("arguments"),
    reason: text("reason"),
    status: mysqlEnum("status", TeamInboxStatus).notNull().default("pending"),
    // first-responder-wins：先到先得，幂等
    resolved_by: denTypeIdColumn("member", "resolved_by"),
    resolved_at: timestamp("resolved_at", { fsp: 3 }),
    resolution: compatJsonColumn<Record<string, unknown>>("resolution"),
    // OpenWorker tool_call_id 对应（durable resume）
    external_tool_call_id: varchar("external_tool_call_id", { length: 128 }),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamps.updated_at,
  },
  (table) => [
    index("team_inbox_team_pending").on(table.team_id, table.assignee_type, table.assignee_id, table.status, table.created_at),
    uniqueIndex("team_inbox_external_tool_call").on(table.external_tool_call_id),
    index("team_inbox_session").on(table.session_id),
    index("team_inbox_task").on(table.task_id),
  ],
)

// ============================================================
// 关系定义
// ============================================================
export const teamRoleRelations = relations(TeamRoleTable, ({ one, many }) => ({
  team: one(TeamTable, { fields: [TeamRoleTable.team_id], references: [TeamTable.id] }),
  agents: many(TeamAgentTable),
}))

export const teamAgentRelations = relations(TeamAgentTable, ({ one }) => ({
  team: one(TeamTable, { fields: [TeamAgentTable.team_id], references: [TeamTable.id] }),
  role: one(TeamRoleTable, { fields: [TeamAgentTable.role_id], references: [TeamRoleTable.id] }),
}))

export const teamTaskRelations = relations(TeamTaskTable, ({ one, many }) => ({
  team: one(TeamTable, { fields: [TeamTaskTable.team_id], references: [TeamTable.id] }),
  board: one(TeamBoardTable, { fields: [TeamTaskTable.board_id], references: [TeamBoardTable.id] }),
  artifacts: many(TeamArtifactTable),
  handoffs: many(TeamTaskHandoffTable),
}))

export const teamArtifactRelations = relations(TeamArtifactTable, ({ one, many }) => ({
  team: one(TeamTable, { fields: [TeamArtifactTable.team_id], references: [TeamTable.id] }),
  task: one(TeamTaskTable, { fields: [TeamArtifactTable.task_id], references: [TeamTaskTable.id] }),
  versions: many(TeamArtifactVersionTable),
}))

export const teamAutomationRunRelations = relations(TeamAutomationRunTable, ({ one, many }) => ({
  automation: one(TeamAutomationTable, { fields: [TeamAutomationRunTable.automation_id], references: [TeamAutomationTable.id] }),
  alerts: many(TeamAutomationAlertTable),
}))

// ============================================================
// 导出（保持 openwork 命名风格：lowercase 表名导出）
// ============================================================
export const teamRole = TeamRoleTable
export const teamAgent = TeamAgentTable
export const teamBoard = TeamBoardTable
export const teamTask = TeamTaskTable
export const teamTaskHandoff = TeamTaskHandoffTable
export const teamArtifact = TeamArtifactTable
export const teamArtifactVersion = TeamArtifactVersionTable
export const teamMailbox = TeamMailboxTable
export const teamBudget = TeamBudgetTable
export const teamBudgetAllocation = TeamBudgetAllocationTable
export const teamAutomation = TeamAutomationTable
export const teamAutomationRun = TeamAutomationRunTable
export const teamAutomationAlert = TeamAutomationAlertTable
export const skillValidation = SkillValidationTable
export const skillTestCase = SkillTestCaseTable
export const skillLink = SkillLinkTable
export const teamPermissionProfile = TeamPermissionProfileTable
export const teamStandingRule = TeamStandingRuleTable
export const teamInbox = TeamInboxTable
