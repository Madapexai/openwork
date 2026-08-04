// TeamAgentService — 团队 Agent 池 + 角色契约 + forbidden_actions 守门
// OpenSpecs: prds/team-autonomy/openspecs/openspec-team-agent-service.md
//
// 不变量：
// I1: forbidden_actions 不可被 agent 自身修改；只能由 member (owner/admin) 通过 updateAgent 设置
//     → agent-as-actor 调用 updateAgent 改 forbiddenActions 返回 403 FORBIDDEN_ACTION_SELF_MODIFY
// I2: status=busy 时 current_task_id 必须非空；assignTask/unassignTask 原子更新两者
// I3: role_id 必须属于同 team_id（防跨团队污染）→ createAgent/updateAgent 校验
// I4: 删除 agent 前 current_task_id 必须为空 → deleteAgent 检查
// I5: skills/connectors 必须是有效 ConfigObject id 列表（字符串数组、可空）
//
// 注：team-autonomy 表的 JS 属性名为 snake_case（与 org.ts 不同），
// 所有 DB 列引用使用 snake_case，对外 API 使用 camelCase（通过 rowToAgent 映射）。
//
// 错误风格：operational-errors.ts 风格的 discriminated union（{ ok: false, status, response: { code, message } }），
// 与 asset-service.ts / permission-service.ts 保持一致。

import { db } from "../db.js"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  EngineConfigProtocol,
  TeamAgentEngine,
  TeamAgentStatus,
  TeamAgentTable,
  TeamRoleTable,
  TeamTaskTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"

// 内部：非法 typeid 返回 null（保持"查不到 → 404/空结果"语义，避免 normalizeDenTypeId 抛异常）
function parseDenTypeId<TName extends DenTypeIdName>(name: TName, value: string): DenTypeId<TName> | null {
  try {
    return normalizeDenTypeId(name, value)
  } catch {
    return null
  }
}

// ============================================================
// 类型导出
// ============================================================

export { TeamAgentEngine, TeamAgentStatus }

export type AgentEngine = typeof TeamAgentEngine[number]
export type AgentStatus = typeof TeamAgentStatus[number]
export type TeamRole = "owner" | "admin" | "editor" | "viewer"

// engine='cli' 的启动/协议配置（openspec-team-agent-engine-cli.md 1.3）
export type AgentEngineConfig = {
  binary: string
  args?: string[]
  protocol?: EngineConfigProtocol
  cwd?: string
  env?: Record<string, string>
  supported?: string[]
}

export type Actor = { memberId: string; role: TeamRole }

export type AgentRow = {
  id: string
  teamId: string
  name: string
  engine: AgentEngine
  engineConfig: AgentEngineConfig | null
  roleId: string | null
  persona: string | null
  skills: string[] | null
  connectors: string[] | null
  modelDefault: string | null
  status: AgentStatus
  sidecarSessionId: string | null
  forbiddenActions: string[] | null
  currentTaskId: string | null
  createdAt: Date
  updatedAt: Date
}

export type CreateAgentInput = {
  teamId: string
  name: string
  engine: AgentEngine
  engineConfig?: AgentEngineConfig
  roleId?: string
  persona?: string
  skills?: string[]
  connectors?: string[]
  modelDefault?: string
  forbiddenActions?: string[]
}

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, "teamId">>

export type CreateAgentResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; status: 400 | 403; response: { code: string; message: string } }

export type UpdateAgentResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; status: 400 | 403 | 404; response: { code: string; message: string } }

export type DeleteAgentResult =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 409; response: { code: string; message: string } }

export type PauseResumeResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; status: 403 | 404 | 409; response: { code: string; message: string } }

export type AssignTaskResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; status: 400 | 403 | 404 | 409; response: { code: string; message: string } }

export type UnassignTaskResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; status: 403 | 404 | 409; response: { code: string; message: string } }

export type ForbiddenCheck = {
  forbidden: boolean
  action?: string
  exists: boolean
}

// ============================================================
// 纯函数：状态机校验（I2 + 1.3 状态图）— 无需 DB，可单测
// ============================================================

const ALLOWED_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  idle: ["busy", "paused", "offline", "error"],
  busy: ["idle", "paused", "offline", "error"],
  paused: ["idle", "offline", "error"], // paused 不能直接 → busy（必须先 resume 回 idle）
  offline: ["idle"], // 外部恢复入口
  error: ["idle"], // 恢复入口
}

export function isValidStatusTransition(from: AgentStatus, to: AgentStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

// ============================================================
// 纯函数：forbidden_actions 匹配（I1 + 1.4 角色契约执行点）
// ============================================================

// 将 glob 模式转换为正则；与 permission-service.ts::matchGlob 一致：* → .*（跨 /），? → .
function globToRegex(pattern: string): RegExp {
  let regex = "^"
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") regex += ".*"
    else if (c === "?") regex += "."
    else regex += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  regex += "$"
  return new RegExp(regex)
}

export function matchForbiddenAction(
  forbidden: string[] | null | undefined,
  action: string,
  opts?: { glob?: boolean },
): boolean {
  if (!forbidden || forbidden.length === 0) return false
  if (opts?.glob) {
    for (const pattern of forbidden) {
      if (globToRegex(pattern).test(action)) return true
    }
    return false
  }
  return forbidden.includes(action)
}

// ============================================================
// 纯函数：ConfigObject id 列表校验（I5）
// ============================================================

// ConfigObject id 前缀为 cob_（见 typeid.ts::idTypesMapNameToPrefix.configObject）
// 这里只做结构校验：必须是 string[]，每个元素是非空字符串。
// 严格 typeid 校验交给 DB 外键 + controller 层 zod；service 层只防明显错误。
export function validateConfigObjectRefs(refs: unknown): boolean {
  if (refs === null || refs === undefined) return true
  if (!Array.isArray(refs)) return false
  for (const r of refs) {
    if (typeof r !== "string") return false
    if (r.length === 0) return false
  }
  return true
}

// ============================================================
// 纯函数：engine_config 校验（openspec-team-agent-engine-cli.md I1/I2）
// ============================================================

// I1: engine='cli' 时 binary 必填（非空字符串）；非 cli engine 允许 engine_config 为空
// I2: protocol 有值时必须 ∈ {pty, headless, jsonrpc}；engine='cli' 时 protocol 必填
// 可选字段类型约束（宽松防御）：args/supported 数组、cwd 字符串、env 对象
export function validateEngineConfig(engine: AgentEngine, config: unknown): boolean {
  if (config === null || config === undefined) {
    return engine !== "cli"
  }
  if (typeof config !== "object" || Array.isArray(config)) return false
  const cfg = config as Record<string, unknown>

  if (engine === "cli") {
    if (typeof cfg.binary !== "string" || cfg.binary.trim().length === 0) return false
    if (cfg.protocol === undefined || cfg.protocol === null) return false
  }
  if (cfg.protocol !== undefined && cfg.protocol !== null) {
    if (!EngineConfigProtocol.includes(cfg.protocol as EngineConfigProtocol)) return false
  }
  if (cfg.args !== undefined && cfg.args !== null && !Array.isArray(cfg.args)) return false
  if (cfg.supported !== undefined && cfg.supported !== null && !Array.isArray(cfg.supported)) return false
  if (cfg.cwd !== undefined && cfg.cwd !== null && typeof cfg.cwd !== "string") return false
  if (
    cfg.env !== undefined &&
    cfg.env !== null &&
    (typeof cfg.env !== "object" || Array.isArray(cfg.env))
  ) {
    return false
  }
  return true
}

// 内部：engine_config 校验错误响应（I1/I2 执行点）
function engineConfigError(): { ok: false; status: 400; response: { code: string; message: string } } {
  return {
    ok: false,
    status: 400,
    response: {
      code: "INVALID_ENGINE_CONFIG",
      message: "engine='cli' requires engine_config with non-empty binary and protocol (pty|headless|jsonrpc)",
    },
  }
}

// ============================================================
// 内部：actor 权限校验
// ============================================================

function canManageAgents(role: TeamRole): boolean {
  return role === "owner" || role === "admin"
}

// I1: agent 自身不能改 forbidden_actions
// actor.memberId === agent.id 时视为 agent 自身调用（memberId 字段填 agentId 是约定）
function isSelfModify(actor: Actor, agentId: string, patch: UpdateAgentInput): boolean {
  return (
    actor.memberId === agentId &&
    Object.prototype.hasOwnProperty.call(patch, "forbiddenActions")
  )
}

// ============================================================
// 行映射：snake_case schema → camelCase API
// ============================================================

function rowToAgent(row: typeof TeamAgentTable.$inferSelect): AgentRow {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    engine: row.engine,
    engineConfig: row.engine_config ?? null,
    roleId: row.role_id,
    persona: row.persona,
    skills: row.skills,
    connectors: row.connectors,
    modelDefault: row.model_default,
    status: row.status,
    sidecarSessionId: row.sidecar_session_id,
    forbiddenActions: row.forbidden_actions,
    currentTaskId: row.current_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ============================================================
// 内部：I3 role_id 跨 team 校验
// ============================================================

async function assertRoleInTeam(
  teamId: string,
  roleId: string | undefined,
): Promise<{ ok: true } | { ok: false; status: 400; response: { code: string; message: string } }> {
  if (!roleId) return { ok: true }
  const parsedRoleId = parseDenTypeId("teamRole", roleId)
  if (!parsedRoleId) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "CROSS_TEAM_ROLE",
        message: `role ${roleId} does not belong to team ${teamId}`,
      },
    }
  }
  const rows = await db
    .select({ id: TeamRoleTable.id, team_id: TeamRoleTable.team_id })
    .from(TeamRoleTable)
    .where(eq(TeamRoleTable.id, parsedRoleId))
    .limit(1)
  if (!rows[0] || rows[0].team_id !== teamId) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "CROSS_TEAM_ROLE",
        message: `role ${roleId} does not belong to team ${teamId}`,
      },
    }
  }
  return { ok: true }
}

// 内部：I5 skills/connectors 校验
function validateRefsInInput(input: { skills?: string[]; connectors?: string[] }):
  | { ok: true }
  | { ok: false; status: 400; response: { code: string; message: string } } {
  if (!validateConfigObjectRefs(input.skills)) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "INVALID_CONFIG_OBJECT_REF",
        message: "skills must be a string[] of non-empty ConfigObject ids",
      },
    }
  }
  if (!validateConfigObjectRefs(input.connectors)) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "INVALID_CONFIG_OBJECT_REF",
        message: "connectors must be a string[] of non-empty ConfigObject ids",
      },
    }
  }
  return { ok: true }
}

// ============================================================
// createAgent
// ============================================================

export async function createAgent(input: CreateAgentInput, actor: Actor): Promise<CreateAgentResult> {
  if (!canManageAgents(actor.role)) {
    return {
      ok: false,
      status: 403,
      response: { code: "FORBIDDEN", message: "only owner/admin can create agents" },
    }
  }

  // I5: skills/connectors 校验
  const refsCheck = validateRefsInInput(input)
  if (!refsCheck.ok) return refsCheck

  // I1/I2: engine_config 校验（engine='cli' 时 binary + protocol 必填）
  if (!validateEngineConfig(input.engine, input.engineConfig)) {
    return engineConfigError()
  }

  // I3: role_id 同 team 校验
  const roleCheck = await assertRoleInTeam(input.teamId, input.roleId)
  if (!roleCheck.ok) return roleCheck

  const id = createDenTypeId("teamAgent")
  await db.insert(TeamAgentTable).values({
    id,
    team_id: normalizeDenTypeId("team", input.teamId),
    name: input.name,
    engine: input.engine,
    engine_config: input.engineConfig ?? null,
    role_id: input.roleId ? normalizeDenTypeId("teamRole", input.roleId) : null,
    persona: input.persona ?? null,
    skills: input.skills ?? null,
    connectors: input.connectors ?? null,
    model_default: input.modelDefault ?? null,
    status: "idle",
    sidecar_session_id: null,
    forbidden_actions: input.forbiddenActions ?? null,
    current_task_id: null,
  })

  const rows = await db.select().from(TeamAgentTable).where(eq(TeamAgentTable.id, id)).limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "agent insert did not return a row" },
    }
  }
  return { ok: true, agent: rowToAgent(rows[0]) }
}

// ============================================================
// updateAgent（I1 守门 forbidden_actions 自改）
// ============================================================

export async function updateAgent(
  agentId: string,
  patch: UpdateAgentInput,
  actor: Actor,
): Promise<UpdateAgentResult> {
  const parsedAgentId = parseDenTypeId("teamAgent", agentId)
  if (!parsedAgentId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `agent ${agentId} not found` },
    }
  }
  const existing = await db.select().from(TeamAgentTable).where(eq(TeamAgentTable.id, parsedAgentId)).limit(1)
  if (!existing[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `agent ${agentId} not found` },
    }
  }
  const current = rowToAgent(existing[0])

  // I1: agent 自身改 forbidden_actions → 403
  if (isSelfModify(actor, agentId, patch)) {
    return {
      ok: false,
      status: 403,
      response: {
        code: "FORBIDDEN_ACTION_SELF_MODIFY",
        message: "agent cannot modify its own forbidden_actions",
      },
    }
  }

  // 改 forbidden_actions 的非 agent 自身调用也必须是 owner/admin
  if (Object.prototype.hasOwnProperty.call(patch, "forbiddenActions") && !canManageAgents(actor.role)) {
    return {
      ok: false,
      status: 403,
      response: { code: "FORBIDDEN", message: "only owner/admin can modify forbidden_actions" },
    }
  }

  // 其他字段（name/persona/skills/...）的修改也要求 owner/admin（保持简洁，统一权限）
  if (!canManageAgents(actor.role)) {
    return {
      ok: false,
      status: 403,
      response: { code: "FORBIDDEN", message: "only owner/admin can update agents" },
    }
  }

  // I5: skills/connectors 校验
  const refsCheck = validateRefsInInput(patch)
  if (!refsCheck.ok) return refsCheck

  // I1/I2: engine_config 校验（合并后的 engine + engine_config 必须满足契约）
  if (patch.engineConfig !== undefined || patch.engine !== undefined) {
    const nextEngine = patch.engine ?? current.engine
    const nextEngineConfig = patch.engineConfig !== undefined ? patch.engineConfig : current.engineConfig
    if (!validateEngineConfig(nextEngine, nextEngineConfig)) {
      return engineConfigError()
    }
  }

  // I3: role_id 同 team 校验
  if (patch.roleId !== undefined) {
    const roleCheck = await assertRoleInTeam(current.teamId, patch.roleId)
    if (!roleCheck.ok) return roleCheck
  }

  const updates: Partial<typeof TeamAgentTable.$inferInsert> = { updated_at: new Date() }
  if (patch.name !== undefined) updates.name = patch.name
  if (patch.engine !== undefined) updates.engine = patch.engine
  if (patch.engineConfig !== undefined) updates.engine_config = patch.engineConfig ?? null
  if (patch.roleId !== undefined) updates.role_id = patch.roleId ? normalizeDenTypeId("teamRole", patch.roleId) : null
  if (patch.persona !== undefined) updates.persona = patch.persona ?? null
  if (patch.skills !== undefined) updates.skills = patch.skills
  if (patch.connectors !== undefined) updates.connectors = patch.connectors
  if (patch.modelDefault !== undefined) updates.model_default = patch.modelDefault ?? null
  if (patch.forbiddenActions !== undefined) updates.forbidden_actions = patch.forbiddenActions

  await db.update(TeamAgentTable).set(updates).where(eq(TeamAgentTable.id, parsedAgentId))

  const updated = await db.select().from(TeamAgentTable).where(eq(TeamAgentTable.id, parsedAgentId)).limit(1)
  return { ok: true, agent: updated[0] ? rowToAgent(updated[0]) : current }
}

// ============================================================
// deleteAgent（I4 必须先 unassignTask）
// ============================================================

export async function deleteAgent(agentId: string, actor: Actor): Promise<DeleteAgentResult> {
  if (!canManageAgents(actor.role)) {
    return {
      ok: false,
      status: 403,
      response: { code: "FORBIDDEN", message: "only owner/admin can delete agents" },
    }
  }

  const parsedAgentId = parseDenTypeId("teamAgent", agentId)
  if (!parsedAgentId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `agent ${agentId} not found` },
    }
  }

  const existing = await db.select().from(TeamAgentTable).where(eq(TeamAgentTable.id, parsedAgentId)).limit(1)
  if (!existing[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `agent ${agentId} not found` },
    }
  }

  // I4: current_task_id 非空 → 409
  if (existing[0].current_task_id) {
    return {
      ok: false,
      status: 409,
      response: {
        code: "AGENT_HAS_TASK",
        message: `agent ${agentId} is currently assigned to task ${existing[0].current_task_id}; unassign first`,
      },
    }
  }

  await db.delete(TeamAgentTable).where(eq(TeamAgentTable.id, parsedAgentId))
  return { ok: true }
}

// ============================================================
// pauseAgent / resumeAgent（状态机）
// ============================================================

export async function pauseAgent(agentId: string, actor: Actor): Promise<PauseResumeResult> {
  if (!canManageAgents(actor.role)) {
    return {
      ok: false,
      status: 403,
      response: { code: "FORBIDDEN", message: "only owner/admin can pause agents" },
    }
  }
  return transitionStatus(agentId, "paused")
}

export async function resumeAgent(agentId: string, actor: Actor): Promise<PauseResumeResult> {
  if (!canManageAgents(actor.role)) {
    return {
      ok: false,
      status: 403,
      response: { code: "FORBIDDEN", message: "only owner/admin can resume agents" },
    }
  }
  return transitionStatus(agentId, "idle")
}

async function transitionStatus(agentId: string, to: AgentStatus): Promise<PauseResumeResult> {
  const parsedAgentId = parseDenTypeId("teamAgent", agentId)
  if (!parsedAgentId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `agent ${agentId} not found` },
    }
  }
  const existing = await db.select().from(TeamAgentTable).where(eq(TeamAgentTable.id, parsedAgentId)).limit(1)
  if (!existing[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `agent ${agentId} not found` },
    }
  }
  const from = existing[0].status as AgentStatus
  if (!isValidStatusTransition(from, to)) {
    return {
      ok: false,
      status: 409,
      response: { code: "INVALID_TRANSITION", message: `cannot transition from ${from} to ${to}` },
    }
  }

  // paused → idle 隐含 resume；to=idle 时如果当前有 current_task_id，状态应回到 busy（保留 I2 不变量）
  // 但 pause/resume 不应改 current_task_id；如果 paused 时被 assignTask 已被禁止（I2 + 状态机），
  // 因此 current_task_id 在 paused 期间保持 pause 前的值。pause 来自 busy 时 current_task_id 仍非空。
  // 这里 resume 回 idle 时，若 current_task_id 非空，应该回到 busy 而非 idle。
  let targetStatus: AgentStatus = to
  if (to === "idle" && existing[0].current_task_id) {
    targetStatus = "busy"
    if (!isValidStatusTransition(from, targetStatus)) {
      return {
        ok: false,
        status: 409,
        response: {
          code: "INVALID_TRANSITION",
          message: `cannot resume from ${from} to ${targetStatus} (current_task_id is set)`,
        },
      }
    }
  }

  await db
    .update(TeamAgentTable)
    .set({ status: targetStatus, updated_at: new Date() })
    .where(eq(TeamAgentTable.id, parsedAgentId))

  const updated = await db.select().from(TeamAgentTable).where(eq(TeamAgentTable.id, parsedAgentId)).limit(1)
  return { ok: true, agent: updated[0] ? rowToAgent(updated[0]) : rowToAgent(existing[0]) }
}

// ============================================================
// assignTask / unassignTask（I2 原子更新 + TeamTaskTable）
// ============================================================

export async function assignTask(agentId: string, taskId: string, actor: Actor): Promise<AssignTaskResult> {
  if (!canManageAgents(actor.role)) {
    return {
      ok: false,
      status: 403,
      response: { code: "FORBIDDEN", message: "only owner/admin can assign tasks" },
    }
  }

  const parsedAgentId = parseDenTypeId("teamAgent", agentId)
  if (!parsedAgentId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `agent ${agentId} not found` },
    }
  }
  const parsedTaskId = parseDenTypeId("teamTask", taskId)
  if (!parsedTaskId) {
    return {
      ok: false,
      status: 400,
      response: { code: "TASK_NOT_FOUND", message: `task ${taskId} not found` },
    }
  }

  const existing = await db.select().from(TeamAgentTable).where(eq(TeamAgentTable.id, parsedAgentId)).limit(1)
  if (!existing[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `agent ${agentId} not found` },
    }
  }

  // busy agent 不能再分配（保留 I2 一致性）
  if (existing[0].current_task_id) {
    return {
      ok: false,
      status: 409,
      response: {
        code: "AGENT_BUSY",
        message: `agent ${agentId} is already assigned to task ${existing[0].current_task_id}`,
      },
    }
  }

  // 校验 task 存在且同 team
  const taskRows = await db
    .select({ id: TeamTaskTable.id, team_id: TeamTaskTable.team_id })
    .from(TeamTaskTable)
    .where(eq(TeamTaskTable.id, parsedTaskId))
    .limit(1)
  if (!taskRows[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "TASK_NOT_FOUND", message: `task ${taskId} not found` },
    }
  }
  if (taskRows[0].team_id !== existing[0].team_id) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "CROSS_TEAM_TASK",
        message: `task ${taskId} does not belong to agent's team ${existing[0].team_id}`,
      },
    }
  }

  // 状态机校验：当前 status 必须能 → busy
  const from = existing[0].status as AgentStatus
  if (!isValidStatusTransition(from, "busy")) {
    return {
      ok: false,
      status: 409,
      response: {
        code: "INVALID_TRANSITION",
        message: `cannot assign task to agent in status ${from}; must be idle`,
      },
    }
  }

  // 原子更新 TeamAgentTable.current_task_id + status=busy
  await db
    .update(TeamAgentTable)
    .set({ current_task_id: parsedTaskId, status: "busy", updated_at: new Date() })
    .where(eq(TeamAgentTable.id, parsedAgentId))

  // 同步 TeamTaskTable.assignee_*（task 被分配给 agent）
  await db
    .update(TeamTaskTable)
    .set({ assignee_type: "agent", assignee_id: agentId, updated_at: new Date() })
    .where(eq(TeamTaskTable.id, parsedTaskId))

  const updated = await db.select().from(TeamAgentTable).where(eq(TeamAgentTable.id, parsedAgentId)).limit(1)
  return { ok: true, agent: updated[0] ? rowToAgent(updated[0]) : rowToAgent(existing[0]) }
}

export async function unassignTask(agentId: string, actor: Actor): Promise<UnassignTaskResult> {
  if (!canManageAgents(actor.role)) {
    return {
      ok: false,
      status: 403,
      response: { code: "FORBIDDEN", message: "only owner/admin can unassign tasks" },
    }
  }

  const parsedAgentId = parseDenTypeId("teamAgent", agentId)
  if (!parsedAgentId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `agent ${agentId} not found` },
    }
  }

  const existing = await db.select().from(TeamAgentTable).where(eq(TeamAgentTable.id, parsedAgentId)).limit(1)
  if (!existing[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `agent ${agentId} not found` },
    }
  }

  if (!existing[0].current_task_id) {
    return {
      ok: false,
      status: 409,
      response: {
        code: "AGENT_NOT_BUSY",
        message: `agent ${agentId} has no current task to unassign`,
      },
    }
  }

  // 清空 current_task_id + status=idle
  await db
    .update(TeamAgentTable)
    .set({ current_task_id: null, status: "idle", updated_at: new Date() })
    .where(eq(TeamAgentTable.id, parsedAgentId))

  const updated = await db.select().from(TeamAgentTable).where(eq(TeamAgentTable.id, parsedAgentId)).limit(1)
  return { ok: true, agent: updated[0] ? rowToAgent(updated[0]) : rowToAgent(existing[0]) }
}

// ============================================================
// listByTeam / getById
// ============================================================

export async function listByTeam(teamId: string): Promise<AgentRow[]> {
  const parsedTeamId = parseDenTypeId("team", teamId)
  if (!parsedTeamId) return []
  const rows = await db.select().from(TeamAgentTable).where(eq(TeamAgentTable.team_id, parsedTeamId))
  return rows.map(rowToAgent)
}

export async function getById(agentId: string): Promise<AgentRow | null> {
  const parsedAgentId = parseDenTypeId("teamAgent", agentId)
  if (!parsedAgentId) return null
  const rows = await db.select().from(TeamAgentTable).where(eq(TeamAgentTable.id, parsedAgentId)).limit(1)
  return rows[0] ? rowToAgent(rows[0]) : null
}

// ============================================================
// checkForbiddenAction（角色契约执行点，1.4）
// ============================================================

export async function checkForbiddenAction(
  agentId: string,
  actionName: string,
  opts?: { glob?: boolean },
): Promise<ForbiddenCheck> {
  const parsedAgentId = parseDenTypeId("teamAgent", agentId)
  if (!parsedAgentId) {
    // agent 不存在 → exists=false，forbidden=false（其他层处理）
    return { forbidden: false, exists: false }
  }

  const rows = await db
    .select({ forbidden_actions: TeamAgentTable.forbidden_actions })
    .from(TeamAgentTable)
    .where(eq(TeamAgentTable.id, parsedAgentId))
    .limit(1)

  if (!rows[0]) {
    // agent 不存在 → exists=false，forbidden=false（其他层处理）
    return { forbidden: false, exists: false }
  }

  const forbidden = rows[0].forbidden_actions
  if (matchForbiddenAction(forbidden, actionName, opts)) {
    return { forbidden: true, action: actionName, exists: true }
  }
  return { forbidden: false, exists: true }
}
