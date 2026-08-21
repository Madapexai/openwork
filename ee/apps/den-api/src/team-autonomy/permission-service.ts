// PermissionService — 双轨权限模式 + Standing Rule + 工具调用守门
// OpenSpecs: prds/team-autonomy/openspecs/openspec-permission-inbox.md
//
// 不变量：
// P1: profile='simple' 时 default_mode 只能是 ask/craft/plan；'advanced' 只能 plan/interactive/auto/custom
// P2: resolveModeBehavior 是纯函数，6 模式 × 3 字段确定性输出
// P3: checkToolPermission 决策顺序 forbidden_action → budget → standing_rule → mode_behavior（不能变）
// P6: team_budget 超支必须 deny/budget_exceeded
// P7: scope='task' 的 standing rule 只对 scope_id 指定的 task 生效
//
// 注：team-autonomy 表的 JS 属性名为 snake_case（与 org.ts 不同），
// 所有 DB 列引用使用 snake_case，对外 API 使用 camelCase（通过 rowTo* 映射）。

import { db } from "../db.js"
import { and, eq, isNull, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  PermissionMode,
  PermissionProfile,
  TeamAgentTable,
  TeamBudgetTable,
  TeamPermissionProfileTable,
  TeamStandingRuleTable,
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
// 类型
// ============================================================

export { PermissionMode, PermissionProfile }

export type PermissionProfileRow = {
  id: string
  teamId: string
  profile: "simple" | "advanced"
  defaultMode: typeof PermissionMode[number]
  customRules: Record<string, unknown> | null
  updatedBy: string
  createdAt: Date
  updatedAt: Date
}

export type StandingRuleRow = {
  id: string
  teamId: string
  scope: "team" | "agent" | "task"
  scopeId: string | null
  toolName: string
  targetPattern: string
  grantedBy: string
  grantedAt: Date
  expiresAt: Date | null
  revokedAt: Date | null
  revokedBy: string | null
}

export type ModeBehavior = {
  requiresPlan: boolean
  requiresApproval: boolean
  autoApproveStanding: boolean
  allowCustomRules: boolean
}

export type ToolCallRequest = {
  teamId: string
  taskId?: string
  agentId: string
  toolName: string
  arguments: Record<string, unknown>
  targetPath?: string
}

export type PermissionDecision =
  | { decision: "allow"; reason: "standing_rule"; ruleId: string }
  | { decision: "allow"; reason: "mode_auto"; mode: typeof PermissionMode[number] }
  | { decision: "require_approval"; reason: "no_standing_rule"; inboxId?: string }
  | { decision: "require_plan"; reason: "mode_plan" }
  | { decision: "deny"; reason: "forbidden_action" | "role_contract" | "budget_exceeded" }

type Actor = { memberId: string; role: "owner" | "admin" | "editor" | "viewer" }

type ProfileSetResult =
  | { ok: true; profile: PermissionProfileRow }
  | { ok: false; status: 400 | 403; response: { code: string; message: string } }

type StandingRuleCreateResult =
  | { ok: true; rule: StandingRuleRow }
  | { ok: false; status: 400 | 403; response: { code: string; message: string } }

type StandingRuleRevokeResult =
  | { ok: true; rule: StandingRuleRow }
  | { ok: false; status: 403 | 404; response: { code: string; message: string } }

// ============================================================
// 内部工具：glob 匹配（支持 * 和 ?，* 跨 / 也匹配）
// ============================================================

// 将 glob 模式转换为正则；* → .*，? → .，其他字符转义。
// 选择 `* → .*`（而非 `[^/]*`）是为了让 `targetPattern: "*"` 能匹配任意路径（含 /），
// 这与 OpenWorker "永久授权全工具+全目标" 语义一致。
export function matchGlob(pattern: string, target: string): boolean {
  if (pattern === "*" || pattern === "") return true
  let regex = "^"
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") regex += ".*"
    else if (c === "?") regex += "."
    else regex += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  regex += "$"
  return new RegExp(regex).test(target)
}

// ============================================================
// 模式 → 行为映射（纯函数，P2）
// ============================================================

const MODE_BEHAVIOR_TABLE: Record<typeof PermissionMode[number], ModeBehavior> = {
  ask: { requiresPlan: false, requiresApproval: true, autoApproveStanding: false, allowCustomRules: false },
  craft: { requiresPlan: false, requiresApproval: false, autoApproveStanding: true, allowCustomRules: false },
  plan: { requiresPlan: true, requiresApproval: false, autoApproveStanding: true, allowCustomRules: false },
  interactive: { requiresPlan: false, requiresApproval: true, autoApproveStanding: false, allowCustomRules: false },
  auto: { requiresPlan: false, requiresApproval: false, autoApproveStanding: true, allowCustomRules: false },
  custom: { requiresPlan: false, requiresApproval: false, autoApproveStanding: false, allowCustomRules: true },
}

export function resolveModeBehavior(
  mode: typeof PermissionMode[number],
  customOverride?: Partial<ModeBehavior>,
): ModeBehavior {
  const base = MODE_BEHAVIOR_TABLE[mode]
  if (mode === "custom" && customOverride) {
    return {
      requiresPlan: customOverride.requiresPlan ?? base.requiresPlan,
      requiresApproval: customOverride.requiresApproval ?? base.requiresApproval,
      autoApproveStanding: customOverride.autoApproveStanding ?? base.autoApproveStanding,
      allowCustomRules: true,
    }
  }
  return { ...base }
}

// ============================================================
// profile 与 mode 一致性校验（P1）
// ============================================================

const SIMPLE_MODES = new Set<typeof PermissionMode[number]>(["ask", "craft", "plan"])
const ADVANCED_MODES = new Set<typeof PermissionMode[number]>(["plan", "interactive", "auto", "custom"])

export function isModeAllowedForProfile(
  profile: "simple" | "advanced",
  mode: typeof PermissionMode[number],
): boolean {
  return profile === "simple" ? SIMPLE_MODES.has(mode) : ADVANCED_MODES.has(mode)
}

// ============================================================
// 行映射：snake_case schema → camelCase API
// ============================================================

function rowToProfile(row: typeof TeamPermissionProfileTable.$inferSelect): PermissionProfileRow {
  return {
    id: row.id,
    teamId: row.team_id,
    profile: row.profile,
    defaultMode: row.default_mode,
    customRules: row.custom_rules,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToStandingRule(row: typeof TeamStandingRuleTable.$inferSelect): StandingRuleRow {
  return {
    id: row.id,
    teamId: row.team_id,
    scope: row.scope,
    scopeId: row.scope_id,
    toolName: row.tool_name,
    targetPattern: row.target_pattern,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  }
}

// ============================================================
// Profile 管理
// ============================================================

export async function getTeamPermissionProfile(teamId: string): Promise<PermissionProfileRow | null> {
  const parsedTeamId = parseDenTypeId("team", teamId)
  if (!parsedTeamId) return null
  const rows = await db
    .select()
    .from(TeamPermissionProfileTable)
    .where(eq(TeamPermissionProfileTable.team_id, parsedTeamId))
    .limit(1)
  return rows[0] ? rowToProfile(rows[0]) : null
}

export async function setTeamPermissionProfile(
  teamId: string,
  input: {
    profile: "simple" | "advanced"
    defaultMode: typeof PermissionMode[number]
    customRules?: Record<string, unknown>
  },
  actor: Actor,
): Promise<ProfileSetResult> {
  // P1: profile 与 mode 一致性
  if (!isModeAllowedForProfile(input.profile, input.defaultMode)) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "INVALID_MODE_FOR_PROFILE",
        message: `mode '${input.defaultMode}' is not allowed under profile '${input.profile}'`,
      },
    }
  }

  // 只有 owner/admin 能改
  if (actor.role !== "owner" && actor.role !== "admin") {
    return {
      ok: false,
      status: 403,
      response: { code: "FORBIDDEN", message: "only owner/admin can set permission profile" },
    }
  }

  const existing = await getTeamPermissionProfile(teamId)
  const now = new Date()

  if (existing) {
    await db
      .update(TeamPermissionProfileTable)
      .set({
        profile: input.profile,
        default_mode: input.defaultMode,
        custom_rules: input.customRules ?? null,
        updated_by: normalizeDenTypeId("member", actor.memberId),
        updated_at: now,
      })
      .where(eq(TeamPermissionProfileTable.id, normalizeDenTypeId("teamPermissionProfile", existing.id)))
    return {
      ok: true,
      profile: {
        ...existing,
        profile: input.profile,
        defaultMode: input.defaultMode,
        customRules: input.customRules ?? null,
        updatedBy: actor.memberId,
        updatedAt: now,
      },
    }
  }

  const id = createDenTypeId("teamPermissionProfile")
  await db.insert(TeamPermissionProfileTable).values({
    id,
    team_id: normalizeDenTypeId("team", teamId),
    profile: input.profile,
    default_mode: input.defaultMode,
    custom_rules: input.customRules ?? null,
    updated_by: normalizeDenTypeId("member", actor.memberId),
  })

  return {
    ok: true,
    profile: {
      id,
      teamId,
      profile: input.profile,
      defaultMode: input.defaultMode,
      customRules: input.customRules ?? null,
      updatedBy: actor.memberId,
      createdAt: now,
      updatedAt: now,
    },
  }
}

// ============================================================
// Standing Rule 管理
// ============================================================

export async function createStandingRule(
  input: {
    teamId: string
    scope: "team" | "agent" | "task"
    scopeId?: string
    toolName: string
    targetPattern: string
    expiresAt?: Date
  },
  grantedBy: Actor,
): Promise<StandingRuleCreateResult> {
  if (grantedBy.role !== "owner" && grantedBy.role !== "admin") {
    return {
      ok: false,
      status: 403,
      response: { code: "FORBIDDEN", message: "only owner/admin can create standing rules" },
    }
  }

  if (input.scope !== "team" && !input.scopeId) {
    return {
      ok: false,
      status: 400,
      response: { code: "SCOPE_ID_REQUIRED", message: `scope '${input.scope}' requires scopeId` },
    }
  }

  const id = createDenTypeId("teamStandingRule")
  const scopeIdValue = input.scope === "team" ? null : (input.scopeId ?? null)
  await db.insert(TeamStandingRuleTable).values({
    id,
    team_id: normalizeDenTypeId("team", input.teamId),
    scope: input.scope,
    scope_id: scopeIdValue,
    tool_name: input.toolName,
    target_pattern: input.targetPattern,
    granted_by: normalizeDenTypeId("member", grantedBy.memberId),
    expires_at: input.expiresAt ?? null,
  })

  const row = await db
    .select()
    .from(TeamStandingRuleTable)
    .where(eq(TeamStandingRuleTable.id, id))
    .limit(1)

  if (!row[0]) {
    // 极端情况：插入成功但读不到，构造一个回退行
    return {
      ok: true,
      rule: {
        id,
        teamId: input.teamId,
        scope: input.scope,
        scopeId: scopeIdValue,
        toolName: input.toolName,
        targetPattern: input.targetPattern,
        grantedBy: grantedBy.memberId,
        grantedAt: new Date(),
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
        revokedBy: null,
      },
    }
  }
  return { ok: true, rule: rowToStandingRule(row[0]) }
}

export async function revokeStandingRule(
  ruleId: string,
  revokedBy: Actor,
): Promise<StandingRuleRevokeResult> {
  if (revokedBy.role !== "owner" && revokedBy.role !== "admin") {
    return {
      ok: false,
      status: 403,
      response: { code: "FORBIDDEN", message: "only owner/admin can revoke standing rules" },
    }
  }

  const parsedRuleId = parseDenTypeId("teamStandingRule", ruleId)
  if (!parsedRuleId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `standing rule '${ruleId}' not found` },
    }
  }

  const existing = await db
    .select()
    .from(TeamStandingRuleTable)
    .where(eq(TeamStandingRuleTable.id, parsedRuleId))
    .limit(1)

  if (!existing[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `standing rule '${ruleId}' not found` },
    }
  }

  await db
    .update(TeamStandingRuleTable)
    .set({ revoked_at: new Date(), revoked_by: normalizeDenTypeId("member", revokedBy.memberId) })
    .where(eq(TeamStandingRuleTable.id, parsedRuleId))

  const updated = await db
    .select()
    .from(TeamStandingRuleTable)
    .where(eq(TeamStandingRuleTable.id, parsedRuleId))
    .limit(1)

  return { ok: true, rule: updated[0] ? rowToStandingRule(updated[0]) : rowToStandingRule(existing[0]) }
}

export async function listStandingRules(
  teamId: string,
  filter?: { scope?: string; scopeId?: string; toolName?: string },
): Promise<StandingRuleRow[]> {
  const parsedTeamId = parseDenTypeId("team", teamId)
  if (!parsedTeamId) return []
  const conditions = [eq(TeamStandingRuleTable.team_id, parsedTeamId)]
  if (filter?.scope) conditions.push(eq(TeamStandingRuleTable.scope, filter.scope as "team" | "agent" | "task"))
  if (filter?.scopeId) conditions.push(eq(TeamStandingRuleTable.scope_id, filter.scopeId))
  if (filter?.toolName) conditions.push(eq(TeamStandingRuleTable.tool_name, filter.toolName))

  const rows = await db
    .select()
    .from(TeamStandingRuleTable)
    .where(and(...conditions))

  return rows.map(rowToStandingRule)
}

// ============================================================
// 角色契约校验（forbidden_actions）
// ============================================================

export async function checkRoleContract(
  agentId: string,
  toolName: string,
): Promise<{ allowed: boolean; forbiddenAction?: string }> {
  const parsedAgentId = parseDenTypeId("teamAgent", agentId)
  if (!parsedAgentId) {
    // agent 不存在视为无契约 → 允许（其他层会处理）
    return { allowed: true }
  }
  const rows = await db
    .select({ forbidden_actions: TeamAgentTable.forbidden_actions })
    .from(TeamAgentTable)
    .where(eq(TeamAgentTable.id, parsedAgentId))
    .limit(1)

  if (!rows[0]) {
    // agent 不存在视为无契约 → 允许（其他层会处理）
    return { allowed: true }
  }

  const forbidden = rows[0].forbidden_actions ?? []
  if (forbidden.includes(toolName)) {
    return { allowed: false, forbiddenAction: toolName }
  }
  return { allowed: true }
}

// ============================================================
// Standing Rule 匹配（内部，P3 + P7）
// ============================================================

export async function findMatchingStandingRule(
  request: ToolCallRequest,
): Promise<StandingRuleRow | null> {
  const parsedTeamId = parseDenTypeId("team", request.teamId)
  if (!parsedTeamId) return null
  // P7: scope='task' 的规则只对 scope_id 指定的 task 生效
  // 查询：team 级 + (agent 级且 scope_id=agentId) + (task 级且 scope_id=taskId)
  const scopeConditions = or(
    eq(TeamStandingRuleTable.scope, "team"),
    and(eq(TeamStandingRuleTable.scope, "agent"), eq(TeamStandingRuleTable.scope_id, request.agentId)),
    request.taskId
      ? and(eq(TeamStandingRuleTable.scope, "task"), eq(TeamStandingRuleTable.scope_id, request.taskId))
      : sql`false`,
  )

  const rows = await db
    .select()
    .from(TeamStandingRuleTable)
    .where(
      and(
        eq(TeamStandingRuleTable.team_id, parsedTeamId),
        eq(TeamStandingRuleTable.tool_name, request.toolName),
        isNull(TeamStandingRuleTable.revoked_at),
        scopeConditions,
      ),
    )

  const now = Date.now()
  const target = request.targetPath ?? ""

  for (const row of rows) {
    // 过期跳过
    if (row.expires_at && row.expires_at.getTime() < now) continue
    if (matchGlob(row.target_pattern, target)) {
      return rowToStandingRule(row)
    }
  }
  return null
}

// ============================================================
// 预算检查（P6）
// ============================================================

export async function checkBudget(
  teamId: string,
): Promise<{ exceeded: boolean; usedTokens: number; totalTokens: number }> {
  const parsedTeamId = parseDenTypeId("team", teamId)
  if (!parsedTeamId) {
    return { exceeded: false, usedTokens: 0, totalTokens: 0 }
  }
  const rows = await db
    .select()
    .from(TeamBudgetTable)
    .where(eq(TeamBudgetTable.team_id, parsedTeamId))
    .limit(1)

  if (!rows[0]) {
    return { exceeded: false, usedTokens: 0, totalTokens: 0 }
  }

  const budget = rows[0]
  const tokenExceeded = budget.used_tokens >= budget.total_tokens
  const costExceeded = budget.used_cost_cents >= budget.total_cost_cents
  return {
    exceeded: tokenExceeded || costExceeded,
    usedTokens: budget.used_tokens,
    totalTokens: budget.total_tokens,
  }
}

// ============================================================
// 核心守门：checkToolPermission（P3 决策顺序）
// ============================================================

export async function checkToolPermission(request: ToolCallRequest): Promise<PermissionDecision> {
  // Step 1: forbidden_action 优先级最高（P3）
  const roleContract = await checkRoleContract(request.agentId, request.toolName)
  if (!roleContract.allowed) {
    return { decision: "deny", reason: "forbidden_action" }
  }

  // Step 2: budget 检查（P6）
  const budget = await checkBudget(request.teamId)
  if (budget.exceeded) {
    return { decision: "deny", reason: "budget_exceeded" }
  }

  // Step 3: standing rule 匹配（P3）
  const standingRule = await findMatchingStandingRule(request)
  if (standingRule) {
    return { decision: "allow", reason: "standing_rule", ruleId: standingRule.id }
  }

  // Step 4: mode_behavior（P3）
  const profile = await getTeamPermissionProfile(request.teamId)
  const mode = profile?.defaultMode ?? "craft"
  const behavior = resolveModeBehavior(mode, profile?.customRules as Partial<ModeBehavior> | undefined)

  if (behavior.requiresPlan) {
    return { decision: "require_plan", reason: "mode_plan" }
  }

  if (behavior.requiresApproval) {
    return { decision: "require_approval", reason: "no_standing_rule" }
  }

  if (behavior.autoApproveStanding) {
    // craft/plan/auto 模式：无 standing → 需审批（不能裸 allow）
    return { decision: "require_approval", reason: "no_standing_rule" }
  }

  // 默认放行（mode_auto 语义）
  return { decision: "allow", reason: "mode_auto", mode }
}
