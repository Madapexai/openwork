// AutomationService — 自动化状态机 + 降级交付 + 可行动告警（单一守门人）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-automation-service.md
//
// 不变量：
// I1: batch_id 幂等 — team_automation_run UNIQUE(automation_id, batch_id)，
//     二次 startRun 同 batch_id 返回 created=false, reason=batch_id_exists
// I2: ready_for_schedule 必须 manual_run_count>=3 — createAutomation 默认 false/0，
//     manualRun 每次 +1，达 3 翻 true；enableSchedule 在 ready=false 时拒绝 enabled=true
// I3: 状态机转换合法性 — advanceRun 调用 isValidAutomationTransition，不合法 409
// I4: alert 必须含 7 字段 — batch_id/status/trigger_time/failure_reason/completed_steps/
//     impact/suggested_actions/recovery_entry，缺任一返回 400 MISSING_ALERT_FIELDS
// I5: retry_policy.no_retry_on=[401,403] 不重试 — failRun 收到 no_retry_on 错误直接 failed
// I6: 断点续跑 — advanceRun 把 step 追加到 state.completed_steps（去重 + 顺序）
//
// 设计依据：
// - WorkBuddy Bluebook Ch25 自动化状态机 + 降级交付 + 可行动告警
// - 借鉴 Temporal RetryOptions（retry_policy JSON）
// - 借鉴 LangGraph Checkpoint（state JSON 记录 completed_steps）
//
// 注：team-autonomy 表的 JS 属性名为 snake_case（与 org.ts 不同），
// 所有 DB 列引用使用 snake_case，对外 API 使用 camelCase（通过 rowToAutomation 等映射）。

import { db } from "../db.js"
import { and, eq, isNull, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  AutomationState,
  DegradationLevel,
  TeamAutomationAlertTable,
  TeamAutomationRunTable,
  TeamAutomationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"

// 内部：非法 typeid 返回 null（保持"查不到 → 404"语义，避免 normalizeDenTypeId 抛异常）
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

export { AutomationState, DegradationLevel }

export type AutomationStateValue = (typeof AutomationState)[number]
export type DegradationLevelValue = (typeof DegradationLevel)[number]

export type RetryPolicy = {
  max_attempts: number
  backoff_coefficient: number
  retry_on: string[]
  no_retry_on: string[]
}

export type Actor = { memberId: string; role: "owner" | "admin" | "editor" | "viewer" }

export type AutomationRow = {
  id: string
  teamId: string
  name: string
  cronExpr: string
  message: string
  agentId: string | null
  scopedApprovals: Record<string, unknown> | null
  timezone: string
  enabled: boolean
  lastRunAt: Date | null
  nextRunAt: Date | null
  skipOnOverlap: boolean
  runOnceCatchUp: boolean
  manualRunCount: number
  readyForSchedule: boolean
  qualityGate: Record<string, unknown> | null
  retryPolicy: Record<string, unknown> | null
  deliveryTargets: Array<Record<string, unknown>> | null
  maxCostCentsPerRun: number | null
  ownerMemberId: string
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export type RunRow = {
  id: string
  automationId: string
  taskId: string | null
  batchId: string
  status: AutomationStateValue
  state: Record<string, unknown> | null
  degradationLevel: DegradationLevelValue | null
  startedAt: Date
  finishedAt: Date | null
  error: string | null
  artifacts: string[] | null
  tokensUsed: number | null
  costCents: number | null
  dryRun: boolean
  createdAt: Date
}

export type AlertRow = {
  id: string
  teamId: string
  automationId: string
  runId: string | null
  triggerTime: string | null
  severity: string
  failureReason: string
  completedSteps: string[] | null
  impact: string
  suggestedActions: string[]
  recoveryEntry: string
  delivered: boolean
  deliveredAt: Date | null
  acknowledgedBy: string | null
  acknowledgedAt: Date | null
  createdAt: Date
}

export type CreateAutomationInput = {
  teamId: string
  name: string
  cronExpr: string
  message: string
  agentId?: string
  timezone?: string
  scopedApprovals?: Record<string, unknown>
  skipOnOverlap?: boolean
  runOnceCatchUp?: boolean
  qualityGate?: Record<string, unknown>
  retryPolicy?: RetryPolicy
  deliveryTargets?: Array<Record<string, unknown>>
  maxCostCentsPerRun?: number
  ownerMemberId: string
  createdBy: string
}

export type CreateAutomationResult =
  | { ok: true; automation: AutomationRow }
  | { ok: false; status: 400; response: { code: string; message: string } }

export type UpdateAutomationInput = Partial<Omit<CreateAutomationInput, "teamId" | "createdBy">>

export type EnableScheduleResult =
  | { ok: true; automation: AutomationRow; enabled: boolean }
  | { ok: false; status: 403; response: { code: "NOT_READY_FOR_SCHEDULE"; manualRunCount: number } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type ManualRunResult =
  | { ok: true; run: RunRow; manualRunCount: number; readyForSchedule: boolean }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type StartRunInput = {
  automationId: string
  batchId: string
  taskId?: string
  dryRun?: boolean
}

export type StartRunResult =
  | { ok: true; run: RunRow; created: true }
  | { ok: true; run: RunRow; created: false; reason: "batch_id_exists" }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type AdvanceRunInput = {
  to: AutomationStateValue
  sourceStatus?: Record<string, "ok" | "failed" | "partial">
  artifacts?: string[]
  tokensUsed?: number
  costCents?: number
}

export type AdvanceRunResult =
  | { ok: true; run: RunRow; previousStatus: AutomationStateValue; degradationLevel?: DegradationLevelValue }
  | { ok: false; status: 409; response: { code: "INVALID_TRANSITION"; from: AutomationStateValue; to: AutomationStateValue } }
  | { ok: false; status: 402; response: { code: "BUDGET_EXCEEDED"; maxCostCentsPerRun: number; costCents: number } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type FailRunInput = {
  errorCode: string
  errorMessage: string
}

export type FailRunResult =
  | { ok: true; run: RunRow; retried: boolean; nextAttemptAt?: Date }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type CreateAlertInput = {
  teamId: string
  automationId: string
  runId?: string
  batchId: string
  status: AutomationStateValue
  triggerTime: string
  failureReason: string
  completedSteps: string[]
  impact: string
  suggestedActions: string[]
  recoveryEntry: string
  severity?: "info" | "warning" | "critical"
}

export type CreateAlertResult =
  | { ok: true; alert: AlertRow }
  | { ok: false; status: 400; response: { code: "MISSING_ALERT_FIELDS"; missing: string[] } }
  | { ok: false; status: 400; response: { code: string; message: string } }

export type AcknowledgeAlertResult =
  | { ok: true; alert: AlertRow }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type ListDueAutomationsResult = {
  due: AutomationRow[]
  skipped: Array<{ automation: AutomationRow; reason: "overlap" }>
}

// ============================================================
// 纯函数：状态机校验（I3）— 无需 DB，可单测
// ============================================================

const ALLOWED_TRANSITIONS: Record<AutomationStateValue, AutomationStateValue[]> = {
  waiting_trigger: ["fetching"],
  fetching: ["partial_aggregating", "aggregating", "blocked"],
  partial_aggregating: ["aggregating", "blocked"],
  aggregating: ["filtering", "blocked"],
  filtering: ["delivering", "blocked"],
  delivering: ["completed", "blocked"],
  completed: [],
  blocked: ["fetching", "failed"],
  failed: [],
}

export function isValidAutomationTransition(
  from: AutomationStateValue,
  to: AutomationStateValue,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

// ============================================================
// 纯函数：降级交付决策树 — 无需 DB，可单测
// ============================================================

export type SourceStatus = "ok" | "failed" | "partial"

export function computeDegradationLevel(
  sourceStatus: Record<string, SourceStatus>,
): DegradationLevelValue {
  const values = Object.values(sourceStatus)
  if (values.length === 0) return "full"

  const failedCount = values.filter((v) => v === "failed").length
  const partialCount = values.filter((v) => v === "partial").length
  const total = values.length

  // 全部 failed → blocked
  if (failedCount === total) return "blocked"
  // 部分 failed（failed > 0 且 < total）→ minimal
  if (failedCount > 0) return "minimal"
  // 部分 partial（0 failed, partial >= 1）→ partial
  if (partialCount > 0) return "partial"
  // 全部 ok → full
  return "full"
}

// ============================================================
// 纯函数：Retry 决策表（I5）— 无需 DB，可单测
// ============================================================

const DEFAULT_BACKOFF_BASE_MS = 1000

export type RetryDecision = {
  retry: boolean
  nextAttemptAt?: Date
}

export function decideRetry(
  errorCode: string,
  policy: RetryPolicy,
  attempt: number,
): RetryDecision {
  // I5: no_retry_on 优先于 retry_on（即使 attempt < max）
  if (policy.no_retry_on.includes(errorCode)) {
    return { retry: false }
  }

  // 错误不在 retry_on 中 → 不可重试
  if (!policy.retry_on.includes(errorCode)) {
    return { retry: false }
  }

  // 重试次数耗尽
  if (attempt >= policy.max_attempts) {
    return { retry: false }
  }

  // 计算退避：base * coeff^(attempt-1)
  const delay = DEFAULT_BACKOFF_BASE_MS * Math.pow(policy.backoff_coefficient, attempt - 1)
  const nextAttemptAt = new Date(Date.now() + delay)
  return { retry: true, nextAttemptAt }
}

// ============================================================
// 纯函数：qualityGate 质量门校验 — 无需 DB，可单测
// WorkBuddy Ch25 质量门禁：相关性 / 时效性 / 重复性 / 最低数量
// ============================================================

export type QualityGate = {
  // 最低数量：item 数必须 >= 该值
  min_item_count?: number
  // 去重键：items 按这些字段去重后的数量必须 >= min_item_count
  dedupe_keys?: string[]
  // 时效性：抓取时间距今不得超过 fresh_hours
  fresh_hours?: number
  // 相关性：items 文本必须命中至少一个关键词
  relevance_terms?: string[]
}

export type QualityGateInput = {
  items?: Array<Record<string, unknown>>
  fetched_at?: string | Date
}

export type QualityVerdict = {
  pass: boolean
  reasons: string[]
}

export function evaluateQualityGate(
  gate: QualityGate | Record<string, unknown> | null | undefined,
  input: QualityGateInput,
): QualityVerdict {
  if (!gate) return { pass: true, reasons: [] }
  const reasons: string[] = []
  const items = input.items ?? []

  // 最低数量
  if (typeof gate.min_item_count === "number" && items.length < gate.min_item_count) {
    reasons.push(`min_item_count: expected >= ${gate.min_item_count}, got ${items.length}`)
  }

  // 去重（重复性）：按 dedupe_keys 去重后数量仍必须 >= min_item_count（若有）
  if (Array.isArray(gate.dedupe_keys) && gate.dedupe_keys.length > 0) {
    const seen = new Set<string>()
    let uniqueCount = 0
    for (const item of items) {
      const key = gate.dedupe_keys.map((k) => String(item?.[k] ?? "")).join("\u0000")
      if (!seen.has(key)) {
        seen.add(key)
        uniqueCount++
      }
    }
    if (typeof gate.min_item_count === "number" && uniqueCount < gate.min_item_count) {
      reasons.push(`dedupe_keys: ${uniqueCount} unique < min_item_count ${gate.min_item_count}`)
    }
  }

  // 时效性：fetched_at 距今不超过 fresh_hours
  if (typeof gate.fresh_hours === "number" && input.fetched_at) {
    const fetched = new Date(input.fetched_at)
    const ageHours = (Date.now() - fetched.getTime()) / 3_600_000
    if (ageHours > gate.fresh_hours) {
      reasons.push(`fresh_hours: fetched ${ageHours.toFixed(1)}h ago > ${gate.fresh_hours}h`)
    }
  }

  // 相关性：items 序列化文本命中至少一个关键词
  if (Array.isArray(gate.relevance_terms) && gate.relevance_terms.length > 0 && items.length > 0) {
    const haystack = items.map((i) => JSON.stringify(i)).join("\n").toLowerCase()
    const hit = gate.relevance_terms.some((term) => haystack.includes(String(term).toLowerCase()))
    if (!hit) {
      reasons.push(`relevance_terms: no item matches any of ${gate.relevance_terms.join(", ")}`)
    }
  }

  return { pass: reasons.length === 0, reasons }
}

// ============================================================
// 纯函数：scopedApprovals 免审批范围判定 — 无需 DB，可单测
// 自动化免审批范围（standing rule scoped to this automation）
// ============================================================

export type ScopedApprovalRule = {
  // 免审批的工具名白名单（如 ["filesystem_write", "shell_execute"]）
  approve_tools?: string[]
  // 免审批的动作名白名单
  approve_actions?: string[]
  // 每日自动批准上限（超过则转人工审批）
  max_auto_approvals_per_day?: number
}

export type ScopedApprovalRequest = {
  toolName?: string
  action?: string
  // 当日已自动批准次数（service 层统计传入）
  approvedToday?: number
}

export type ScopedApprovalDecision = {
  approved: boolean
  reason: "scoped_rule" | "quota_exceeded" | "not_scoped"
}

export function decideScopedApproval(
  rule: ScopedApprovalRule | Record<string, unknown> | null | undefined,
  request: ScopedApprovalRequest,
): ScopedApprovalDecision {
  if (!rule) return { approved: false, reason: "not_scoped" }
  const tools = Array.isArray(rule.approve_tools) ? rule.approve_tools : []
  const actions = Array.isArray(rule.approve_actions) ? rule.approve_actions : []

  const toolHit = request.toolName ? tools.includes(request.toolName) : false
  const actionHit = request.action ? actions.includes(request.action) : false
  if (!toolHit && !actionHit) return { approved: false, reason: "not_scoped" }

  // 命中白名单但已达每日上限 → 转人工
  if (typeof rule.max_auto_approvals_per_day === "number" &&
      rule.max_auto_approvals_per_day > 0 &&
      (request.approvedToday ?? 0) >= rule.max_auto_approvals_per_day) {
    return { approved: false, reason: "quota_exceeded" }
  }

  return { approved: true, reason: "scoped_rule" }
}

// ============================================================
// 纯函数：max_cost_cents_per_run 预算检查 — 无需 DB，可单测
// ============================================================

export function checkCostBudget(
  costCents: number | undefined,
  maxCostCentsPerRun: number | null | undefined,
): { ok: boolean; exceededByCents?: number } {
  if (costCents === undefined || costCents === null) return { ok: true }
  if (maxCostCentsPerRun === null || maxCostCentsPerRun === undefined) return { ok: true }
  if (costCents <= maxCostCentsPerRun) return { ok: true }
  return { ok: false, exceededByCents: costCents - maxCostCentsPerRun }
}

// ============================================================
// 纯函数：deliveryTargets 投递幂等键 — 无需 DB，可单测
// ============================================================

export type DeliveryTarget = {
  kind: string
  target: string
  idempotency_key?: string
  enabled?: boolean
}

export function deliveryIdempotencyKey(target: DeliveryTarget, batchId: string): string {
  return target.idempotency_key ? `${target.idempotency_key}:${batchId}` : `${target.kind}:${target.target}:${batchId}`
}

// ============================================================
// Cron 解析 — 无需 DB，可单测
// ============================================================

export type ParsedCron = {
  minute: number | string
  hour: number | string
  dayOfMonth: number | string
  month: number | string
  dayOfWeek: number | string
}

export function parseCronExpr(cron: string): ParsedCron {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cron expression must have 5 fields (minute hour dayOfMonth month dayOfWeek), got ${parts.length}: "${cron}"`)
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  return {
    minute: parseCronField(minute),
    hour: parseCronField(hour),
    dayOfMonth: parseCronField(dayOfMonth),
    month: parseCronField(month),
    dayOfWeek: parseCronField(dayOfWeek),
  }
}

function parseCronField(field: string): number | string {
  // 通配符或表达式（*/N, N-M, N,M）保留为字符串
  if (field === "*" || field.includes("/") || field.includes("-") || field.includes(",")) {
    return field
  }
  // 纯数字转 number
  const n = Number(field)
  if (!Number.isNaN(n)) return n
  return field
}

function matchesCronField(field: number | string, value: number): boolean {
  if (field === "*") return true
  if (typeof field === "number") return field === value
  // */N
  if (field.startsWith("*/")) {
    const n = parseInt(field.slice(2), 10)
    return Number.isFinite(n) && n > 0 && value % n === 0
  }
  // N,M,...
  if (field.includes(",")) {
    return field.split(",").some((p) => matchesCronField(parseCronField(p.trim()), value))
  }
  // N-M
  if (field.includes("-")) {
    const [lo, hi] = field.split("-").map((s) => parseInt(s.trim(), 10))
    return Number.isFinite(lo) && Number.isFinite(hi) && value >= lo && value <= hi
  }
  // 纯数字字符串
  const n = Number(field)
  return !Number.isNaN(n) && n === value
}

function matchesCron(parsed: ParsedCron, date: Date): boolean {
  return (
    matchesCronField(parsed.minute, date.getUTCMinutes()) &&
    matchesCronField(parsed.hour, date.getUTCHours()) &&
    matchesCronField(parsed.dayOfMonth, date.getUTCDate()) &&
    matchesCronField(parsed.month, date.getUTCMonth() + 1) &&
    matchesCronField(parsed.dayOfWeek, date.getUTCDay())
  )
}

// 完整 IANA 时区支持：用 Node 内置 Intl.DateTimeFormat 计算任意 IANA 时区
// 在指定时刻的 UTC 偏移（含 DST），替换原静态 TZ_OFFSET_HOURS 表（仅支持常见时区）。
// 按 UTC 日缓存偏移，DST 切换日最多误差 1 小时（可接受边缘情况）。

const tzOffsetCache = new Map<string, { dateKey: string; offsetMs: number }>()

export function getTimezoneOffsetMs(timeZone: string, date: Date): number {
  const dateKey = date.toISOString().slice(0, 10)
  const cached = tzOffsetCache.get(timeZone)
  if (cached && cached.dateKey === dateKey) return cached.offsetMs

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
  const parts = dtf.formatToParts(date)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0")
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  const offsetMs = asUTC - date.getTime()
  tzOffsetCache.set(timeZone, { dateKey, offsetMs })
  return offsetMs
}

export function computeNextRunAt(cron: string, from: Date, timezone: string = "Asia/Shanghai"): Date {
  const parsed = parseCronExpr(cron)
  const offsetMs = getTimezoneOffsetMs(timezone, from)

  // 把 from 转换到目标时区的"本地时间"（用 UTC 方法操作）
  const shiftedMs = from.getTime() + offsetMs
  const search = new Date(shiftedMs)
  // 从下一分钟开始搜索
  search.setUTCSeconds(0, 0)
  search.setUTCMinutes(search.getUTCMinutes() + 1)

  // 最多搜 1 年（366 天 * 24 * 60 = 527040 分钟）
  const maxIterations = 366 * 24 * 60
  for (let i = 0; i < maxIterations; i++) {
    if (matchesCron(parsed, search)) {
      // 转回 UTC
      return new Date(search.getTime() - offsetMs)
    }
    search.setUTCMinutes(search.getUTCMinutes() + 1)
  }
  throw new Error(`no next run found within 1 year for cron "${cron}"`)
}

// ============================================================
// 行映射：snake_case schema → camelCase API
// ============================================================

function rowToAutomation(row: typeof TeamAutomationTable.$inferSelect): AutomationRow {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    cronExpr: row.cron_expr,
    message: row.message,
    agentId: row.agent_id,
    scopedApprovals: row.scoped_approvals,
    timezone: row.timezone,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    skipOnOverlap: row.skip_on_overlap,
    runOnceCatchUp: row.run_once_catch_up,
    manualRunCount: row.manual_run_count,
    readyForSchedule: row.ready_for_schedule,
    qualityGate: row.quality_gate,
    retryPolicy: row.retry_policy,
    deliveryTargets: row.delivery_targets,
    maxCostCentsPerRun: row.max_cost_cents_per_run,
    ownerMemberId: row.owner_member_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToRun(row: typeof TeamAutomationRunTable.$inferSelect): RunRow {
  return {
    id: row.id,
    automationId: row.automation_id,
    taskId: row.task_id,
    batchId: row.batch_id,
    status: row.status,
    state: row.state,
    degradationLevel: row.degradation_level,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    artifacts: row.artifacts,
    tokensUsed: row.tokens_used,
    costCents: row.cost_cents,
    dryRun: row.dry_run,
    createdAt: row.created_at,
  }
}

function rowToAlert(row: typeof TeamAutomationAlertTable.$inferSelect): AlertRow {
  return {
    id: row.id,
    teamId: row.team_id,
    automationId: row.automation_id,
    runId: row.run_id,
    triggerTime: row.trigger_time,
    severity: row.severity,
    failureReason: row.failure_reason,
    completedSteps: row.completed_steps,
    impact: row.impact,
    suggestedActions: row.suggested_actions,
    recoveryEntry: row.recovery_entry,
    delivered: row.delivered,
    deliveredAt: row.delivered_at,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: row.acknowledged_at,
    createdAt: row.created_at,
  }
}

// ============================================================
// 内部：mysql2 ER_DUP_ENTRY (1062) 唯一索引冲突
// ============================================================

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const e = error as Record<string, unknown>
  if (e.code === "ER_DUP_ENTRY") return true
  if (e.errno === 1062) return true
  const cause = e.cause as Record<string, unknown> | undefined
  if (cause) {
    if (cause.code === "ER_DUP_ENTRY" || cause.errno === 1062) return true
  }
  return false
}

// ============================================================
// createAutomation — I2 默认 ready_for_schedule=false
// ============================================================

export async function createAutomation(input: CreateAutomationInput): Promise<CreateAutomationResult> {
  const id = createDenTypeId("teamAutomation")
  const now = new Date()

  // 计算初始 next_run_at（基于 cron + 时区）
  let nextRunAt: Date | null = null
  try {
    nextRunAt = computeNextRunAt(input.cronExpr, now, input.timezone ?? "Asia/Shanghai")
  } catch {
    // cron 解析失败不阻塞创建，调度器会跳过
    nextRunAt = null
  }

  try {
    await db.insert(TeamAutomationTable).values({
      id,
      team_id: normalizeDenTypeId("team", input.teamId),
      name: input.name,
      cron_expr: input.cronExpr,
      message: input.message,
      agent_id: input.agentId ? normalizeDenTypeId("teamAgent", input.agentId) : null,
      scoped_approvals: input.scopedApprovals ?? null,
      timezone: input.timezone ?? "Asia/Shanghai",
      // I2: 默认 ready_for_schedule=false, manual_run_count=0
      enabled: true,
      next_run_at: nextRunAt,
      skip_on_overlap: input.skipOnOverlap ?? true,
      run_once_catch_up: input.runOnceCatchUp ?? true,
      manual_run_count: 0,
      ready_for_schedule: false,
      quality_gate: input.qualityGate ?? null,
      retry_policy: (input.retryPolicy as Record<string, unknown>) ?? null,
      delivery_targets: input.deliveryTargets ?? null,
      max_cost_cents_per_run: input.maxCostCentsPerRun ?? null,
      owner_member_id: normalizeDenTypeId("member", input.ownerMemberId),
      created_by: normalizeDenTypeId("member", input.createdBy),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message },
    }
  }

  const rows = await db.select().from(TeamAutomationTable).where(eq(TeamAutomationTable.id, id)).limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "automation insert did not return a row" },
    }
  }
  return { ok: true, automation: rowToAutomation(rows[0]) }
}

// ============================================================
// updateAutomation
// ============================================================

export async function updateAutomation(
  automationId: string,
  input: UpdateAutomationInput,
): Promise<CreateAutomationResult> {
  const parsedId = parseDenTypeId("teamAutomation", automationId)
  if (!parsedId) {
    return {
      ok: false,
      status: 400,
      response: { code: "NOT_FOUND", message: `automation ${automationId} not found` },
    }
  }

  const existing = await db
    .select()
    .from(TeamAutomationTable)
    .where(eq(TeamAutomationTable.id, parsedId))
    .limit(1)
  if (!existing[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "NOT_FOUND", message: `automation ${automationId} not found` },
    }
  }

  const updates: Partial<typeof TeamAutomationTable.$inferInsert> = { updated_at: new Date() }
  if (input.name !== undefined) updates.name = input.name
  if (input.cronExpr !== undefined) {
    updates.cron_expr = input.cronExpr
    // cron 变更时重算 next_run_at
    try {
      updates.next_run_at = computeNextRunAt(input.cronExpr, new Date(), input.timezone ?? existing[0].timezone)
    } catch {
      // 解析失败保持原值
    }
  }
  if (input.message !== undefined) updates.message = input.message
  if (input.agentId !== undefined) updates.agent_id = normalizeDenTypeId("teamAgent", input.agentId)
  if (input.timezone !== undefined) updates.timezone = input.timezone
  if (input.skipOnOverlap !== undefined) updates.skip_on_overlap = input.skipOnOverlap
  if (input.runOnceCatchUp !== undefined) updates.run_once_catch_up = input.runOnceCatchUp
  if (input.qualityGate !== undefined) updates.quality_gate = input.qualityGate
  if (input.retryPolicy !== undefined) updates.retry_policy = input.retryPolicy as Record<string, unknown>
  if (input.deliveryTargets !== undefined) updates.delivery_targets = input.deliveryTargets
  if (input.maxCostCentsPerRun !== undefined) updates.max_cost_cents_per_run = input.maxCostCentsPerRun
  if (input.ownerMemberId !== undefined) updates.owner_member_id = normalizeDenTypeId("member", input.ownerMemberId)

  await db.update(TeamAutomationTable).set(updates).where(eq(TeamAutomationTable.id, parsedId))

  const rows = await db
    .select()
    .from(TeamAutomationTable)
    .where(eq(TeamAutomationTable.id, parsedId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "UPDATE_FAILED", message: "automation update returned no row" },
    }
  }
  return { ok: true, automation: rowToAutomation(rows[0]) }
}

// ============================================================
// enableSchedule — I2 校验 ready_for_schedule
// ============================================================

export async function enableSchedule(
  automationId: string,
  enabled: boolean,
): Promise<EnableScheduleResult> {
  const parsedId = parseDenTypeId("teamAutomation", automationId)
  if (!parsedId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `automation ${automationId} not found` },
    }
  }

  const rows = await db
    .select()
    .from(TeamAutomationTable)
    .where(eq(TeamAutomationTable.id, parsedId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `automation ${automationId} not found` },
    }
  }
  const current = rowToAutomation(rows[0])

  // I2: 启用调度前必须 ready_for_schedule=true（即 manual_run_count>=3）
  if (enabled && !current.readyForSchedule) {
    return {
      ok: false,
      status: 403,
      response: { code: "NOT_READY_FOR_SCHEDULE", manualRunCount: current.manualRunCount },
    }
  }

  // 若启用且 next_run_at 为空（之前未就绪未计算），现在重算
  const updates: Partial<typeof TeamAutomationTable.$inferInsert> = {
    enabled,
    updated_at: new Date(),
  }
  if (enabled && !current.nextRunAt) {
    try {
      updates.next_run_at = computeNextRunAt(current.cronExpr, new Date(), current.timezone)
    } catch {
      // cron 解析失败保持 null
    }
  }

  await db.update(TeamAutomationTable).set(updates).where(eq(TeamAutomationTable.id, parsedId))

  const updated = await db
    .select()
    .from(TeamAutomationTable)
    .where(eq(TeamAutomationTable.id, parsedId))
    .limit(1)
  if (!updated[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `automation ${automationId} not found after update` },
    }
  }
  return { ok: true, automation: rowToAutomation(updated[0]), enabled }
}

// ============================================================
// manualRun — dry_run + manual_run_count +1，达 3 翻 ready_for_schedule
// ============================================================

export async function manualRun(automationId: string): Promise<ManualRunResult> {
  const parsedId = parseDenTypeId("teamAutomation", automationId)
  if (!parsedId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `automation ${automationId} not found` },
    }
  }

  const rows = await db
    .select()
    .from(TeamAutomationTable)
    .where(eq(TeamAutomationTable.id, parsedId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `automation ${automationId} not found` },
    }
  }
  const current = rowToAutomation(rows[0])

  // manual_run_count + 1
  const nextManualCount = current.manualRunCount + 1
  // I2: 达 3 翻 ready_for_schedule
  const nextReady = nextManualCount >= 3

  // 创建 dry_run run
  const runId = createDenTypeId("teamAutomationRun")
  const batchId = `manual-${automationId}-${Date.now()}`
  const now = new Date()
  await db.insert(TeamAutomationRunTable).values({
    id: runId,
    automation_id: parsedId,
    batch_id: batchId,
    status: "waiting_trigger",
    state: { completed_steps: [], current: "waiting_trigger", manual: true },
    started_at: now,
    dry_run: true,
  })

  // 更新 automation
  await db
    .update(TeamAutomationTable)
    .set({
      manual_run_count: nextManualCount,
      ready_for_schedule: nextReady,
      last_run_at: now,
      updated_at: now,
    })
    .where(eq(TeamAutomationTable.id, parsedId))

  const runRows = await db
    .select()
    .from(TeamAutomationRunTable)
    .where(eq(TeamAutomationRunTable.id, runId))
    .limit(1)

  if (!runRows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: "manual run insert did not return a row" },
    }
  }

  return {
    ok: true,
    run: rowToRun(runRows[0]),
    manualRunCount: nextManualCount,
    readyForSchedule: nextReady,
  }
}

// ============================================================
// startRun — I1 batch_id 幂等
// ============================================================

export async function startRun(input: StartRunInput): Promise<StartRunResult> {
  const parsedAutomationId = parseDenTypeId("teamAutomation", input.automationId)
  if (!parsedAutomationId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `automation ${input.automationId} not found` },
    }
  }

  // 先查是否已有同 batch_id 的 run
  const existing = await db
    .select()
    .from(TeamAutomationRunTable)
    .where(
      and(
        eq(TeamAutomationRunTable.automation_id, parsedAutomationId),
        eq(TeamAutomationRunTable.batch_id, input.batchId),
      ),
    )
    .limit(1)
  if (existing[0]) {
    return { ok: true, run: rowToRun(existing[0]), created: false, reason: "batch_id_exists" }
  }

  // 校验 automation 存在
  const autoRows = await db
    .select()
    .from(TeamAutomationTable)
    .where(eq(TeamAutomationTable.id, parsedAutomationId))
    .limit(1)
  if (!autoRows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `automation ${input.automationId} not found` },
    }
  }

  const runId = createDenTypeId("teamAutomationRun")
  const now = new Date()
  try {
    await db.insert(TeamAutomationRunTable).values({
      id: runId,
      automation_id: parsedAutomationId,
      task_id: input.taskId ? normalizeDenTypeId("teamTask", input.taskId) : null,
      batch_id: input.batchId,
      status: "waiting_trigger",
      state: { completed_steps: [], current: "waiting_trigger" },
      started_at: now,
      dry_run: input.dryRun ?? false,
    })
  } catch (error) {
    // 并发下两个 startRun 同时通过 pre-check，第二个撞 UNIQUE(automation_id, batch_id)
    if (isUniqueViolation(error)) {
      const existing = await db
        .select()
        .from(TeamAutomationRunTable)
        .where(
          and(
            eq(TeamAutomationRunTable.automation_id, parsedAutomationId),
            eq(TeamAutomationRunTable.batch_id, input.batchId),
          ),
        )
        .limit(1)
      if (existing[0]) {
        return { ok: true, run: rowToRun(existing[0]), created: false, reason: "batch_id_exists" }
      }
    }
    throw error
  }

  // 更新 automation.last_run_at
  await db
    .update(TeamAutomationTable)
    .set({ last_run_at: now, updated_at: now })
    .where(eq(TeamAutomationTable.id, parsedAutomationId))

  const rows = await db
    .select()
    .from(TeamAutomationRunTable)
    .where(eq(TeamAutomationRunTable.id, runId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: "run insert did not return a row" },
    }
  }
  return { ok: true, run: rowToRun(rows[0]), created: true }
}

// ============================================================
// getRun
// ============================================================

export async function getRun(runId: string): Promise<RunRow | null> {
  const parsedRunId = parseDenTypeId("teamAutomationRun", runId)
  if (!parsedRunId) return null
  const rows = await db
    .select()
    .from(TeamAutomationRunTable)
    .where(eq(TeamAutomationRunTable.id, parsedRunId))
    .limit(1)
  return rows[0] ? rowToRun(rows[0]) : null
}

// ============================================================
// advanceRun — I3 状态机 + I6 断点续跑 + 降级计算
// ============================================================

export async function advanceRun(
  runId: string,
  input: AdvanceRunInput,
): Promise<AdvanceRunResult> {
  const parsedRunId = parseDenTypeId("teamAutomationRun", runId)
  if (!parsedRunId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `run ${runId} not found` },
    }
  }

  const rows = await db
    .select()
    .from(TeamAutomationRunTable)
    .where(eq(TeamAutomationRunTable.id, parsedRunId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `run ${runId} not found` },
    }
  }
  const current = rowToRun(rows[0])
  const previousStatus = current.status
  const targetStatus = input.to

  // I3: 状态机校验
  if (!isValidAutomationTransition(previousStatus, targetStatus)) {
    return {
      ok: false,
      status: 409,
      response: { code: "INVALID_TRANSITION", from: previousStatus, to: targetStatus },
    }
  }

  // 预算检查：run.costCents 超过 automation.max_cost_cents_per_run → 402 BUDGET_EXCEEDED
  if (input.costCents !== undefined && input.costCents !== null) {
    const budgetRows = await db
      .select({ maxCostCentsPerRun: TeamAutomationTable.max_cost_cents_per_run })
      .from(TeamAutomationTable)
      .where(eq(TeamAutomationTable.id, normalizeDenTypeId("teamAutomation", current.automationId)))
      .limit(1)
    const maxCents = budgetRows[0]?.maxCostCentsPerRun ?? null
    const budget = checkCostBudget(input.costCents, maxCents)
    if (!budget.ok) {
      return {
        ok: false,
        status: 402,
        response: {
          code: "BUDGET_EXCEEDED",
          maxCostCentsPerRun: maxCents as number,
          costCents: input.costCents,
        },
      }
    }
  }

  // 计算降级级别（若提供 sourceStatus）
  let degradationLevel: DegradationLevelValue | undefined
  if (input.sourceStatus) {
    degradationLevel = computeDegradationLevel(input.sourceStatus)
  }

  // I6: 断点续跑 — 把 targetStatus 追加到 state.completed_steps（去重 + 顺序）
  const prevState = (current.state as { completed_steps?: string[]; source_status?: Record<string, SourceStatus> | null } | null) ?? { completed_steps: [] }
  const prevSteps = Array.isArray(prevState.completed_steps) ? prevState.completed_steps : []
  // 只追加前进态（非 blocked/failed）
  const isProgressState = !["blocked", "failed", "waiting_trigger"].includes(targetStatus)
  const newSteps = isProgressState && !prevSteps.includes(targetStatus)
    ? [...prevSteps, targetStatus]
    : prevSteps

  const newState: Record<string, unknown> = {
    ...prevState,
    completed_steps: newSteps,
    current: targetStatus,
    source_status: input.sourceStatus ?? prevState.source_status ?? null,
  }

  const updates: Partial<typeof TeamAutomationRunTable.$inferInsert> = {
    status: targetStatus,
    state: newState,
  }

  // 降级 blocked 时强制 status=blocked（不进 delivering）
  if (degradationLevel === "blocked" && targetStatus !== "blocked") {
    updates.status = "blocked"
    updates.degradation_level = "blocked"
  } else if (degradationLevel) {
    updates.degradation_level = degradationLevel
  }

  if (input.artifacts) updates.artifacts = input.artifacts
  if (input.tokensUsed !== undefined) updates.tokens_used = input.tokensUsed
  if (input.costCents !== undefined) updates.cost_cents = input.costCents

  // 完成态设置 finished_at
  if (updates.status === "completed") {
    updates.finished_at = new Date()
  }

  await db.update(TeamAutomationRunTable).set(updates).where(eq(TeamAutomationRunTable.id, parsedRunId))

  const updated = await db
    .select()
    .from(TeamAutomationRunTable)
    .where(eq(TeamAutomationRunTable.id, parsedRunId))
    .limit(1)

  if (!updated[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `run ${runId} not found after update` },
    }
  }

  const resultRun = rowToRun(updated[0])
  const actualDegradation = degradationLevel ?? resultRun.degradationLevel ?? undefined

  return {
    ok: true,
    run: resultRun,
    previousStatus,
    degradationLevel: actualDegradation,
  }
}

// ============================================================
// completeRun — 快捷方式：delivering → completed
// ============================================================

export async function completeRun(runId: string): Promise<AdvanceRunResult> {
  return advanceRun(runId, { to: "completed" })
}

// ============================================================
// failRun — I5 retry_policy 决策
// ============================================================

export async function failRun(
  runId: string,
  input: FailRunInput,
): Promise<FailRunResult> {
  const parsedRunId = parseDenTypeId("teamAutomationRun", runId)
  if (!parsedRunId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `run ${runId} not found` },
    }
  }

  const rows = await db
    .select()
    .from(TeamAutomationRunTable)
    .where(eq(TeamAutomationRunTable.id, parsedRunId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `run ${runId} not found` },
    }
  }
  const current = rowToRun(rows[0])

  // 拉取 automation.retry_policy
  const autoRows = await db
    .select()
    .from(TeamAutomationTable)
    .where(eq(TeamAutomationTable.id, normalizeDenTypeId("teamAutomation", current.automationId)))
    .limit(1)
  const retryPolicy = (autoRows[0]?.retry_policy as RetryPolicy | null) ?? null

  // 从 state 中取 attempt 计数
  const state = (current.state as { attempt?: number } | null) ?? {}
  const attempt = typeof state.attempt === "number" ? state.attempt : 1

  // 默认 policy（若 automation 没配）
  const policy: RetryPolicy = retryPolicy ?? {
    max_attempts: 3,
    backoff_coefficient: 2.0,
    retry_on: ["timeout", "rate_limit", "transient"],
    no_retry_on: ["401", "403"],
  }

  // I5: 调用纯函数 decideRetry
  const decision = decideRetry(input.errorCode, policy, attempt)

  const now = new Date()
  if (decision.retry) {
    // 重试：status=blocked，记录 next_attempt_at
    const newState = {
      ...state,
      last_error: { code: input.errorCode, message: input.errorMessage },
      next_attempt_at: decision.nextAttemptAt?.toISOString() ?? null,
      attempt: attempt + 1,
    }
    await db
      .update(TeamAutomationRunTable)
      .set({
        status: "blocked",
        error: `${input.errorCode}: ${input.errorMessage}`,
        state: newState,
        degradation_level: "blocked",
      })
      .where(eq(TeamAutomationRunTable.id, parsedRunId))
  } else {
    // 不重试：status=failed（终态）
    const newState = {
      ...state,
      last_error: { code: input.errorCode, message: input.errorMessage },
      attempt,
      retry_exhausted: !policy.no_retry_on.includes(input.errorCode) && attempt >= policy.max_attempts,
    }
    await db
      .update(TeamAutomationRunTable)
      .set({
        status: "failed",
        error: `${input.errorCode}: ${input.errorMessage}`,
        state: newState,
        finished_at: now,
      })
      .where(eq(TeamAutomationRunTable.id, parsedRunId))
  }

  const updated = await db
    .select()
    .from(TeamAutomationRunTable)
    .where(eq(TeamAutomationRunTable.id, parsedRunId))
    .limit(1)

  if (!updated[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `run ${runId} not found after fail` },
    }
  }

  return {
    ok: true,
    run: rowToRun(updated[0]),
    retried: decision.retry,
    nextAttemptAt: decision.nextAttemptAt,
  }
}

// ============================================================
// createAlert — I4 校验 7 字段
// ============================================================

const REQUIRED_ALERT_FIELDS = [
  "batchId",
  "status",
  "triggerTime",
  "failureReason",
  "completedSteps",
  "impact",
  "suggestedActions",
  "recoveryEntry",
] as const

export async function createAlert(input: CreateAlertInput): Promise<CreateAlertResult> {
  // I4: 校验 7 字段必填
  const missing: string[] = []
  for (const field of REQUIRED_ALERT_FIELDS) {
    const value = input[field]
    if (value === undefined || value === null || (typeof value === "string" && value === "") ||
        (Array.isArray(value) && value.length === 0)) {
      missing.push(field)
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      status: 400,
      response: { code: "MISSING_ALERT_FIELDS", missing },
    }
  }

  const id = createDenTypeId("teamAutomationAlert")
  await db.insert(TeamAutomationAlertTable).values({
    id,
    team_id: normalizeDenTypeId("team", input.teamId),
    automation_id: normalizeDenTypeId("teamAutomation", input.automationId),
    run_id: input.runId ? normalizeDenTypeId("teamAutomationRun", input.runId) : null,
    trigger_time: input.triggerTime,
    severity: input.severity ?? "warning",
    failure_reason: input.failureReason,
    completed_steps: input.completedSteps,
    impact: input.impact,
    suggested_actions: input.suggestedActions,
    recovery_entry: input.recoveryEntry,
    delivered: false,
  })

  const rows = await db
    .select()
    .from(TeamAutomationAlertTable)
    .where(eq(TeamAutomationAlertTable.id, id))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "alert insert did not return a row" },
    }
  }
  return { ok: true, alert: rowToAlert(rows[0]) }
}

// ============================================================
// acknowledgeAlert
// ============================================================

export async function acknowledgeAlert(
  alertId: string,
  memberId: string,
): Promise<AcknowledgeAlertResult> {
  const parsedAlertId = parseDenTypeId("teamAutomationAlert", alertId)
  if (!parsedAlertId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `alert ${alertId} not found` },
    }
  }

  const now = new Date()
  await db
    .update(TeamAutomationAlertTable)
    .set({ acknowledged_by: normalizeDenTypeId("member", memberId), acknowledged_at: now })
    .where(eq(TeamAutomationAlertTable.id, parsedAlertId))

  // 检查是否实际更新了行
  const rows = await db
    .select()
    .from(TeamAutomationAlertTable)
    .where(eq(TeamAutomationAlertTable.id, parsedAlertId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `alert ${alertId} not found` },
    }
  }
  return { ok: true, alert: rowToAlert(rows[0]) }
}

// ============================================================
// listAlerts
// ============================================================

export async function listAlerts(filter: {
  teamId?: string
  automationId?: string
  runId?: string
  delivered?: boolean
  acknowledged?: boolean
}): Promise<AlertRow[]> {
  const teamId = filter.teamId ? parseDenTypeId("team", filter.teamId) : undefined
  const automationId = filter.automationId ? parseDenTypeId("teamAutomation", filter.automationId) : undefined
  const runId = filter.runId ? parseDenTypeId("teamAutomationRun", filter.runId) : undefined
  // 非法 typeid → 查不到 → 空结果（与原 eq(列, 非法字符串) 语义一致）
  if ((filter.teamId && !teamId) || (filter.automationId && !automationId) || (filter.runId && !runId)) {
    return []
  }

  const conditions = []
  if (teamId) conditions.push(eq(TeamAutomationAlertTable.team_id, teamId))
  if (automationId) conditions.push(eq(TeamAutomationAlertTable.automation_id, automationId))
  if (runId) conditions.push(eq(TeamAutomationAlertTable.run_id, runId))
  if (filter.delivered !== undefined) conditions.push(eq(TeamAutomationAlertTable.delivered, filter.delivered))
  if (filter.acknowledged === true) {
    conditions.push(sql`${TeamAutomationAlertTable.acknowledged_by} IS NOT NULL`)
  } else if (filter.acknowledged === false) {
    conditions.push(isNull(TeamAutomationAlertTable.acknowledged_by))
  }

  const query = conditions.length > 0
    ? db.select().from(TeamAutomationAlertTable).where(and(...conditions))
    : db.select().from(TeamAutomationAlertTable)

  const rows = await query
  return rows.map(rowToAlert)
}

// ============================================================
// listDueAutomations — 调度器入口
// WHERE enabled=true AND (next_run_at IS NULL OR next_run_at <= now())
// skip_on_overlap=true 时检查是否有未完成的 run
// ============================================================

export async function listDueAutomations(now: Date = new Date()): Promise<ListDueAutomationsResult> {
  // 查所有 enabled 且 next_run_at <= now（或为 null）的 automation
  const rows = await db
    .select()
    .from(TeamAutomationTable)
    .where(
      and(
        eq(TeamAutomationTable.enabled, true),
        or(isNull(TeamAutomationTable.next_run_at), lte(TeamAutomationTable.next_run_at, now)),
      ),
    )

  const due: AutomationRow[] = []
  const skipped: Array<{ automation: AutomationRow; reason: "overlap" }> = []

  for (const row of rows) {
    const automation = rowToAutomation(row)

    // skip_on_overlap=true：检查是否有未完成的 run（status 不在 completed/failed 终态）
    if (automation.skipOnOverlap) {
      const runningRuns = await db
        .select({ id: TeamAutomationRunTable.id })
        .from(TeamAutomationRunTable)
        .where(
          and(
            eq(TeamAutomationRunTable.automation_id, normalizeDenTypeId("teamAutomation", automation.id)),
            // 未完成 = status 不在 completed/failed
            sql`${TeamAutomationRunTable.status} NOT IN ('completed', 'failed')`,
          ),
        )
        .limit(1)
      if (runningRuns.length > 0) {
        skipped.push({ automation, reason: "overlap" })
        continue
      }
    }

    due.push(automation)
  }

  return { due, skipped }
}

// ============================================================
// scheduleNextRun — 完成/失败后更新 next_run_at
// ============================================================

export async function scheduleNextRun(automationId: string, from: Date = new Date()): Promise<void> {
  const parsedId = parseDenTypeId("teamAutomation", automationId)
  if (!parsedId) return
  const rows = await db
    .select()
    .from(TeamAutomationTable)
    .where(eq(TeamAutomationTable.id, parsedId))
    .limit(1)
  if (!rows[0]) return
  const automation = rowToAutomation(rows[0])
  if (!automation.enabled) return

  try {
    const nextRunAt = computeNextRunAt(automation.cronExpr, from, automation.timezone)
    await db
      .update(TeamAutomationTable)
      .set({ next_run_at: nextRunAt, updated_at: new Date() })
      .where(eq(TeamAutomationTable.id, parsedId))
  } catch {
    // cron 解析失败，不更新
  }
}

// ============================================================
// scopedApprovals 审批工作流（schema 已就绪 → service 实现）
// 免审批范围判定 + 当日自动批准次数统计（quota 控制）
// ============================================================

export type CheckScopedApprovalResult =
  | { ok: true; approved: boolean; reason: ScopedApprovalDecision["reason"]; approvedToday: number }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export async function checkScopedApproval(
  automationId: string,
  request: ScopedApprovalRequest,
): Promise<CheckScopedApprovalResult> {
  const parsedId = parseDenTypeId("teamAutomation", automationId)
  if (!parsedId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `automation ${automationId} not found` },
    }
  }
  const rows = await db
    .select()
    .from(TeamAutomationTable)
    .where(eq(TeamAutomationTable.id, parsedId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `automation ${automationId} not found` },
    }
  }

  const rule = (rows[0].scoped_approvals as ScopedApprovalRule | null) ?? null
  // 当日已自动批准次数：统计今日 started_at 且 state.scoped_approved=true 的 run
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const approvedRuns = await db
    .select({ state: TeamAutomationRunTable.state })
    .from(TeamAutomationRunTable)
    .where(
      and(
        eq(TeamAutomationRunTable.automation_id, parsedId),
        sql`${TeamAutomationRunTable.started_at} >= ${todayStart}`,
      ),
    )
  const approvedToday = approvedRuns.filter(
    (r: { state: unknown }) => (r.state as { scoped_approved?: boolean } | null)?.scoped_approved === true,
  ).length

  const decision = decideScopedApproval(rule, { ...request, approvedToday })
  return { ok: true, approved: decision.approved, reason: decision.reason, approvedToday }
}

// ============================================================
// qualityGate 质量门校验（schema 已就绪 → service 实现）
// ============================================================

export type EvaluateQualityForAutomationResult =
  | { ok: true; gateConfigured: boolean; verdict: QualityVerdict }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export async function evaluateQualityForAutomation(
  automationId: string,
  input: QualityGateInput,
): Promise<EvaluateQualityForAutomationResult> {
  const parsedId = parseDenTypeId("teamAutomation", automationId)
  if (!parsedId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `automation ${automationId} not found` },
    }
  }
  const rows = await db
    .select()
    .from(TeamAutomationTable)
    .where(eq(TeamAutomationTable.id, parsedId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `automation ${automationId} not found` },
    }
  }
  const gate = (rows[0].quality_gate as QualityGate | null) ?? null
  if (!gate) return { ok: true, gateConfigured: false, verdict: { pass: true, reasons: [] } }
  return { ok: true, gateConfigured: true, verdict: evaluateQualityGate(gate, input) }
}

// ============================================================
// deliveryTargets 多渠道投递（schema 已就绪 → service 实现）
// handler 注册表 + 幂等记录（run.state.delivered_targets）
// ============================================================

export type DeliveryPayload = {
  batchId: string
  title?: string
  content: unknown
}

export type DeliveryHandlerResult = { ok: boolean; error?: string }

export type DeliveryHandlerContext = {
  target: DeliveryTarget
  payload: DeliveryPayload
  automation: AutomationRow
  run: RunRow
}

export type DeliveryHandler = (ctx: DeliveryHandlerContext) => Promise<DeliveryHandlerResult>

const deliveryHandlers = new Map<string, DeliveryHandler>()

export function registerDeliveryHandler(kind: string, handler: DeliveryHandler): void {
  deliveryHandlers.set(kind, handler)
}

export function deliveryHandlerFor(kind: string): DeliveryHandler | undefined {
  return deliveryHandlers.get(kind)
}

export type DeliverRunResultsResult = {
  delivered: string[]
  skipped: string[]
  failed: Array<{ key: string; error: string }>
}

export async function deliverRunResults(
  runId: string,
  payload: DeliveryPayload,
): Promise<DeliverRunResultsResult> {
  const parsedRunId = parseDenTypeId("teamAutomationRun", runId)
  if (!parsedRunId) {
    return { delivered: [], skipped: [], failed: [{ key: runId, error: "invalid run id" }] }
  }
  const runRows = await db
    .select()
    .from(TeamAutomationRunTable)
    .where(eq(TeamAutomationRunTable.id, parsedRunId))
    .limit(1)
  if (!runRows[0]) {
    return { delivered: [], skipped: [], failed: [{ key: runId, error: "run not found" }] }
  }
  const run = rowToRun(runRows[0])

  const autoRows = await db
    .select()
    .from(TeamAutomationTable)
    .where(eq(TeamAutomationTable.id, normalizeDenTypeId("teamAutomation", run.automationId)))
    .limit(1)
  if (!autoRows[0]) {
    return { delivered: [], skipped: [], failed: [{ key: run.automationId, error: "automation not found" }] }
  }
  const automation = rowToAutomation(autoRows[0])
  const targets: DeliveryTarget[] = (automation.deliveryTargets ?? []) as DeliveryTarget[]
  if (targets.length === 0) {
    return { delivered: [], skipped: [], failed: [] }
  }

  const state = (run.state as { delivered_targets?: string[] } | null) ?? {}
  const alreadyDelivered = new Set(state.delivered_targets ?? [])
  const delivered: string[] = []
  const skipped: string[] = []
  const failed: Array<{ key: string; error: string }> = []

  for (const target of targets) {
    if (target.enabled === false) {
      skipped.push(deliveryIdempotencyKey(target, run.batchId))
      continue
    }
    const key = deliveryIdempotencyKey(target, run.batchId)
    if (alreadyDelivered.has(key)) {
      skipped.push(key)
      continue
    }
    const handler = deliveryHandlerFor(target.kind)
    if (!handler) {
      failed.push({ key, error: `no delivery handler registered for kind "${target.kind}"` })
      continue
    }
    try {
      const result = await handler({ target, payload, automation, run })
      if (result.ok) {
        alreadyDelivered.add(key)
        delivered.push(key)
      } else {
        failed.push({ key, error: result.error ?? "delivery failed" })
      }
    } catch (error) {
      failed.push({ key, error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (delivered.length > 0 || failed.length > 0) {
    await db
      .update(TeamAutomationRunTable)
      .set({ state: { ...state, delivered_targets: [...alreadyDelivered] } })
      .where(eq(TeamAutomationRunTable.id, parsedRunId))
  }

  return { delivered, skipped, failed }
}
