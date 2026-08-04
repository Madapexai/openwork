// BudgetService — 团队预算配额 + 原子 increment + 超额判定 + 自动 reset
// OpenSpecs: prds/team-autonomy/openspecs/openspec-sidecar-personal-budget.md
//
// 不变量：
// I3: budget used_tokens/used_cost_cents 不可超过 total
//     → checkBudget 比较 used<total（任一超额即 exceeded=true）
//     → recordUsage 写入前 checkBudget 判定，超额返回 409 BUDGET_EXCEEDED（避免脏写）
//     → 原子 UPDATE used_tokens = used_tokens + ?, used_cost_cents = used_cost_cents + ?
// I4: budget reset_at 到期后自动 reset
//     → shouldResetBudget(reset_at, now): reset_at <= now → true（纯函数）
//     → resetBudgetIfDue 检查 reset_at <= now 则 UPDATE used=0, reset_at=computeNextResetAt(period, reset_at)
//     → computeNextResetAt(period, from): daily+1d / weekly+7d / monthly+30d（纯函数）
//
// 注：TeamBudgetTable 使用 snake_case JS 属性（与 team-autonomy.ts 其他表一致）。
// 错误风格：discriminated union（{ ok: false, status, response: { code, message } }）。

import { db } from "../db.js"
import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import {
  BudgetEntityType,
  BudgetPeriod,
  TeamBudgetAllocationTable,
  TeamBudgetTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

// ============================================================
// 类型导出
// ============================================================

export { BudgetEntityType, BudgetPeriod }

export type BudgetPeriodValue = typeof BudgetPeriod[number]
export type BudgetEntityTypeValue = typeof BudgetEntityType[number]
export type BudgetExceedReason = "tokens" | "cost"

// P3-B: entity（member / agent / role）级配额
export type BudgetEntity = { type: BudgetEntityTypeValue; id: string }

export type AllocationRow = {
  id: string
  budgetId: string
  entityType: BudgetEntityTypeValue
  entityId: string
  allocatedTokens: number
  usedTokens: number
  createdAt: Date
  updatedAt: Date
}

export type BudgetRow = {
  id: string
  teamId: string
  period: BudgetPeriodValue
  totalTokens: number
  usedTokens: number
  totalCostCents: number
  usedCostCents: number
  resetAt: Date
  createdAt: Date
  updatedAt: Date
}

export type AllocateBudgetInput = {
  teamId: string
  period: BudgetPeriodValue
  totalTokens: number
  totalCostCents: number
  resetAt?: Date
}

export type AllocateBudgetResult =
  | { ok: true; budget: BudgetRow; created: boolean }
  | { ok: false; status: 400 | 403; response: { code: string; message: string } }

export type RecordUsageInput = {
  teamId: string
  tokensUsed: number
  costCentsUsed: number
}

export type RecordUsageResult =
  | { ok: true; budget: BudgetRow; allocation?: AllocationRow }
  | { ok: false; status: 404 | 409; response: { code: string; message: string } }

// P3-B: createBudget = allocateBudget 幂等 upsert
export type CreateBudgetResult = AllocateBudgetResult

export type AllocateToEntityResult =
  | { ok: true; allocation: AllocationRow }
  | { ok: false; status: 400 | 404; response: { code: string; message: string } }

export type RecordConsumptionResult =
  | { ok: true; allocation: AllocationRow }
  | { ok: false; status: 400 | 404 | 409; response: { code: string; message: string } }

export type BudgetCheck = {
  exceeded: boolean
  reason?: BudgetExceedReason
  usedTokens: number
  totalTokens: number
  usedCostCents: number
  totalCostCents: number
}

// ============================================================
// 纯函数：超额判定（I3）
// ============================================================

type BudgetState = {
  usedTokens: number
  totalTokens: number
  usedCostCents: number
  totalCostCents: number
}

// isBudgetExceeded — used >= total 任一即超额
// 边界：total=0 视为超额（无配额）—— 与 permission-service.checkBudget 的 tokenExceeded 行为一致
export function isBudgetExceeded(state: BudgetState): boolean {
  if (state.totalTokens <= 0) return true
  if (state.totalCostCents <= 0) return true
  if (state.usedTokens >= state.totalTokens) return true
  if (state.usedCostCents >= state.totalCostCents) return true
  return false
}

// budgetExceedReason — 返回超额原因（tokens / cost），未超额返回 null
// 优先级：tokens > cost（与 checkToolPermission 决策顺序一致）
export function budgetExceedReason(state: BudgetState): BudgetExceedReason | null {
  if (state.totalTokens <= 0) return "tokens"
  if (state.totalCostCents <= 0) return "cost"
  if (state.usedTokens >= state.totalTokens) return "tokens"
  if (state.usedCostCents >= state.totalCostCents) return "cost"
  return null
}

// ============================================================
// 纯函数：reset 算法（I4）
// ============================================================

const PERIOD_DURATION_MS: Record<BudgetPeriodValue, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
}

// computeNextResetAt — 给定 period 和起始时间，返回下一次 reset_at
export function computeNextResetAt(period: BudgetPeriodValue, from: Date): Date {
  const delta = PERIOD_DURATION_MS[period]
  return new Date(from.getTime() + delta)
}

// shouldResetBudget — reset_at 到期判定
// reset_at <= now → true（已过期，应 reset）
export function shouldResetBudget(resetAt: Date, now: Date): boolean {
  return resetAt.getTime() <= now.getTime()
}

// ============================================================
// 行映射：snake_case schema → camelCase API
// ============================================================

function rowToBudget(row: typeof TeamBudgetTable.$inferSelect): BudgetRow {
  return {
    id: row.id,
    teamId: row.team_id,
    period: row.period,
    totalTokens: row.total_tokens,
    usedTokens: row.used_tokens,
    totalCostCents: row.total_cost_cents,
    usedCostCents: row.used_cost_cents,
    resetAt: row.reset_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// P3-B: allocation 行映射（snake_case → camelCase）
function rowToAllocation(row: typeof TeamBudgetAllocationTable.$inferSelect): AllocationRow {
  return {
    id: row.id,
    budgetId: row.budget_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    allocatedTokens: row.allocated_tokens,
    usedTokens: row.used_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ============================================================
// 内部：从 drizzle update 结果中提取 affectedRows
// ============================================================

function extractAffectedRows(result: unknown): number {
  if (!result) return 0
  if (typeof result === "object") {
    const r = result as Record<string, unknown>
    if (typeof r.affectedRows === "number") return r.affectedRows
    if (typeof r.rowsAffected === "number") return r.rowsAffected
    if (Array.isArray(r)) {
      const first = r[0] as Record<string, unknown> | undefined
      if (first) {
        if (typeof first.affectedRows === "number") return first.affectedRows
        if (typeof first.rowsAffected === "number") return first.rowsAffected
      }
    }
  }
  return 0
}

// ============================================================
// allocateBudget（upsert：同 team_id + period 唯一）
// ============================================================

export async function allocateBudget(
  input: AllocateBudgetInput,
): Promise<AllocateBudgetResult> {
  if (input.totalTokens < 0 || input.totalCostCents < 0) {
    return {
      ok: false,
      status: 400,
      response: { code: "INVALID_BUDGET", message: "total must be non-negative" },
    }
  }

  const existing = await db
    .select()
    .from(TeamBudgetTable)
    .where(
      and(
        eq(TeamBudgetTable.team_id, input.teamId),
        eq(TeamBudgetTable.period, input.period),
      ),
    )
    .limit(1)

  const resetAt = input.resetAt ?? computeNextResetAt(input.period, new Date())

  if (existing[0]) {
    // 已存在 → 更新 totals（保留 used）
    await db
      .update(TeamBudgetTable)
      .set({
        total_tokens: input.totalTokens,
        total_cost_cents: input.totalCostCents,
        reset_at: resetAt,
        updated_at: new Date(),
      })
      .where(eq(TeamBudgetTable.id, existing[0].id))

    const updated = await db
      .select()
      .from(TeamBudgetTable)
      .where(eq(TeamBudgetTable.id, existing[0].id))
      .limit(1)

    return { ok: true, budget: updated[0] ? rowToBudget(updated[0]) : rowToBudget(existing[0]), created: false }
  }

  const id = createDenTypeId("teamBudget")
  await db.insert(TeamBudgetTable).values({
    id,
    team_id: input.teamId,
    period: input.period,
    total_tokens: input.totalTokens,
    used_tokens: 0,
    total_cost_cents: input.totalCostCents,
    used_cost_cents: 0,
    reset_at: resetAt,
  })

  const row = await db
    .select()
    .from(TeamBudgetTable)
    .where(eq(TeamBudgetTable.id, id))
    .limit(1)

  if (!row[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "budget insert did not return a row" },
    }
  }
  return { ok: true, budget: rowToBudget(row[0]), created: true }
}

// ============================================================
// getBudget
// ============================================================

export async function getBudget(teamId: string): Promise<BudgetRow | null> {
  const rows = await db
    .select()
    .from(TeamBudgetTable)
    .where(eq(TeamBudgetTable.team_id, teamId))
    .limit(1)
  return rows[0] ? rowToBudget(rows[0]) : null
}

// ============================================================
// checkBudget（I3 纯逻辑判定）
// ============================================================

export async function checkBudget(teamId: string): Promise<BudgetCheck> {
  const budget = await getBudget(teamId)
  if (!budget) {
    return {
      exceeded: false,
      usedTokens: 0,
      totalTokens: 0,
      usedCostCents: 0,
      totalCostCents: 0,
    }
  }

  const state: BudgetState = {
    usedTokens: budget.usedTokens,
    totalTokens: budget.totalTokens,
    usedCostCents: budget.usedCostCents,
    totalCostCents: budget.totalCostCents,
  }
  const exceeded = isBudgetExceeded(state)
  const reason = exceeded ? budgetExceedReason(state) ?? undefined : undefined
  return {
    exceeded,
    reason,
    usedTokens: budget.usedTokens,
    totalTokens: budget.totalTokens,
    usedCostCents: budget.usedCostCents,
    totalCostCents: budget.totalCostCents,
  }
}

// ============================================================
// recordUsage（I2 原子条件更新 + I3 双表原子）
//  - recordUsage(input)                        P2 兼容（团队级，原子 WHERE 守门）
//  - recordUsage(teamId, entity, tokens, cost) P3-B（budget + allocation 双表原子）
// ============================================================

class RecordUsageRejected extends Error {
  constructor(
    readonly code: "BUDGET_EXCEEDED" | "ALLOCATION_EXCEEDED",
    message: string,
  ) {
    super(message)
    this.name = "RecordUsageRejected"
  }
}

export async function recordUsage(
  input: RecordUsageInput,
): Promise<RecordUsageResult>
export async function recordUsage(
  teamId: string,
  entity: BudgetEntity,
  tokens: number,
  cost: number,
): Promise<RecordUsageResult>
export async function recordUsage(
  inputOrTeamId: RecordUsageInput | string,
  entity?: BudgetEntity,
  tokens?: number,
  cost?: number,
): Promise<RecordUsageResult> {
  if (typeof inputOrTeamId === "string") {
    return recordEntityUsage(inputOrTeamId, entity!, tokens!, cost!)
  }
  return recordTeamUsage(inputOrTeamId)
}

// ---------- 团队级（P2 兼容，原子条件更新） ----------
async function recordTeamUsage(input: RecordUsageInput): Promise<RecordUsageResult> {
  if (input.tokensUsed < 0 || input.costCentsUsed < 0) {
    return {
      ok: false,
      status: 400,
      response: { code: "INVALID_USAGE", message: "usage must be non-negative" },
    }
  }

  const existing = await db
    .select()
    .from(TeamBudgetTable)
    .where(eq(TeamBudgetTable.team_id, input.teamId))
    .limit(1)

  if (!existing[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "BUDGET_NOT_FOUND", message: `no budget for team ${input.teamId}` },
    }
  }

  const current = rowToBudget(existing[0])
  // I2 原子：UPDATE ... SET used = used + ? WHERE used + ? <= total（允许打满 ==）
  const updateResult = await db
    .update(TeamBudgetTable)
    .set({
      used_tokens: sql`${TeamBudgetTable.used_tokens} + ${input.tokensUsed}`,
      used_cost_cents: sql`${TeamBudgetTable.used_cost_cents} + ${input.costCentsUsed}`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(TeamBudgetTable.id, current.id),
        sql`${TeamBudgetTable.used_tokens} + ${input.tokensUsed} <= ${TeamBudgetTable.total_tokens}`,
        sql`${TeamBudgetTable.used_cost_cents} + ${input.costCentsUsed} <= ${TeamBudgetTable.total_cost_cents}`,
      ),
    )

  const affected = extractAffectedRows(updateResult)
  if (affected === 0) {
    // 超限（或并发已推进）→ 回查最新值给出精确 reason
    const refreshed = await db
      .select()
      .from(TeamBudgetTable)
      .where(eq(TeamBudgetTable.id, current.id))
      .limit(1)
    const latest = refreshed[0] ? rowToBudget(refreshed[0]) : current
    const projected: BudgetState = {
      usedTokens: latest.usedTokens + input.tokensUsed,
      totalTokens: latest.totalTokens,
      usedCostCents: latest.usedCostCents + input.costCentsUsed,
      totalCostCents: latest.totalCostCents,
    }
    const reason = budgetExceedReason(projected) ?? "tokens"
    return {
      ok: false,
      status: 409,
      response: {
        code: "BUDGET_EXCEEDED",
        message: `usage would exceed ${reason} budget (used=${reason === "tokens" ? projected.usedTokens : projected.usedCostCents}, total=${reason === "tokens" ? projected.totalTokens : projected.totalCostCents})`,
      },
    }
  }

  const updated = await db
    .select()
    .from(TeamBudgetTable)
    .where(eq(TeamBudgetTable.id, current.id))
    .limit(1)

  return { ok: true, budget: updated[0] ? rowToBudget(updated[0]) : current }
}

// ---------- 实体级（P3-B：budget + allocation 双表原子） ----------
async function recordEntityUsage(
  teamId: string,
  entity: BudgetEntity,
  tokens: number,
  cost: number,
): Promise<RecordUsageResult> {
  if (tokens < 0 || cost < 0) {
    return {
      ok: false,
      status: 400,
      response: { code: "INVALID_USAGE", message: "usage must be non-negative" },
    }
  }

  // I4: 先自动重置过期预算
  await resetBudgetIfDue(teamId)

  const budgets = await db
    .select()
    .from(TeamBudgetTable)
    .where(eq(TeamBudgetTable.team_id, teamId))
    .limit(1)
  if (!budgets[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "BUDGET_NOT_FOUND", message: `no budget for team ${teamId}` },
    }
  }
  const current = rowToBudget(budgets[0])

  const allocationRows = await db
    .select()
    .from(TeamBudgetAllocationTable)
    .where(
      and(
        eq(TeamBudgetAllocationTable.budget_id, current.id),
        eq(TeamBudgetAllocationTable.entity_type, entity.type),
        eq(TeamBudgetAllocationTable.entity_id, entity.id),
      ),
    )
    .limit(1)
  const allocation = allocationRows[0] ? rowToAllocation(allocationRows[0]) : undefined

  // I2+I3: 事务内双表原子条件更新，任一 affectedRows=0 → 回滚 + 409
  try {
    await db.transaction(async (tx) => {
      const budgetRes = await tx
        .update(TeamBudgetTable)
        .set({
          used_tokens: sql`${TeamBudgetTable.used_tokens} + ${tokens}`,
          used_cost_cents: sql`${TeamBudgetTable.used_cost_cents} + ${cost}`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(TeamBudgetTable.id, current.id),
            sql`${TeamBudgetTable.used_tokens} + ${tokens} <= ${TeamBudgetTable.total_tokens}`,
            sql`${TeamBudgetTable.used_cost_cents} + ${cost} <= ${TeamBudgetTable.total_cost_cents}`,
          ),
        )
      if (extractAffectedRows(budgetRes) === 0) {
        throw new RecordUsageRejected(
          "BUDGET_EXCEEDED",
          `usage would exceed budget for team ${teamId}`,
        )
      }
      if (allocation) {
        const allocRes = await tx
          .update(TeamBudgetAllocationTable)
          .set({
            used_tokens: sql`${TeamBudgetAllocationTable.used_tokens} + ${tokens}`,
            updated_at: new Date(),
          })
          .where(
            and(
              eq(TeamBudgetAllocationTable.id, allocation.id),
              sql`${TeamBudgetAllocationTable.used_tokens} + ${tokens} <= ${TeamBudgetAllocationTable.allocated_tokens}`,
            ),
          )
        if (extractAffectedRows(allocRes) === 0) {
          throw new RecordUsageRejected(
            "ALLOCATION_EXCEEDED",
            `usage would exceed allocation for ${entity.type}:${entity.id}`,
          )
        }
      }
      return true
    })
  } catch (error) {
    if (error instanceof RecordUsageRejected) {
      return { ok: false, status: 409, response: { code: error.code, message: error.message } }
    }
    throw error
  }

  const updated = await db
    .select()
    .from(TeamBudgetTable)
    .where(eq(TeamBudgetTable.id, current.id))
    .limit(1)
  const updatedAlloc = allocation
    ? await db
        .select()
        .from(TeamBudgetAllocationTable)
        .where(eq(TeamBudgetAllocationTable.id, allocation.id))
        .limit(1)
    : []
  return {
    ok: true,
    budget: updated[0] ? rowToBudget(updated[0]) : current,
    allocation: updatedAlloc[0] ? rowToAllocation(updatedAlloc[0]) : allocation,
  }
}

// ============================================================
// resetBudgetIfDue（I4 自动 reset + 推进 reset_at）
// ============================================================

export async function resetBudgetIfDue(
  teamId: string,
  now: Date = new Date(),
): Promise<{ reset: boolean; budget?: BudgetRow }> {
  const existing = await db
    .select()
    .from(TeamBudgetTable)
    .where(eq(TeamBudgetTable.team_id, teamId))
    .limit(1)

  if (!existing[0]) {
    return { reset: false }
  }

  const current = rowToBudget(existing[0])
  if (!shouldResetBudget(current.resetAt, now)) {
    return { reset: false, budget: current }
  }

  // 推进 reset_at 到当前 reset_at + period
  // （不用 now + period 是为了保持周期边界稳定：避免 reset 滞后导致下次 reset 提前）
  const nextReset = computeNextResetAt(current.period, current.resetAt)

  const updateResult = await db
    .update(TeamBudgetTable)
    .set({
      used_tokens: 0,
      used_cost_cents: 0,
      reset_at: nextReset,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(TeamBudgetTable.id, current.id),
        eq(TeamBudgetTable.reset_at, current.resetAt),
      ),
    )

  const affected = extractAffectedRows(updateResult)
  if (affected === 0) {
    // 并发下另一个 reset 已推进；回查最新状态
    const refreshed = await db
      .select()
      .from(TeamBudgetTable)
      .where(eq(TeamBudgetTable.id, current.id))
      .limit(1)
    return { reset: false, budget: refreshed[0] ? rowToBudget(refreshed[0]) : current }
  }

  const updated = await db
    .select()
    .from(TeamBudgetTable)
    .where(eq(TeamBudgetTable.id, current.id))
    .limit(1)

  return { reset: true, budget: updated[0] ? rowToBudget(updated[0]) : { ...current, usedTokens: 0, usedCostCents: 0, resetAt: nextReset } }
}

// ============================================================
// P3-B：resetIfDue（I4 别名）
// ============================================================

/** @deprecated 用 resetBudgetIfDue；P3-B 统一命名为 resetIfDue */
export const resetIfDue = resetBudgetIfDue

// ============================================================
// P3-B：createBudget（I1 幂等 upsert，同 team_id + period 唯一）
// ============================================================

export async function createBudget(input: AllocateBudgetInput): Promise<CreateBudgetResult> {
  return allocateBudget(input)
}

// ============================================================
// P3-B：allocateToEntity（I3 支撑 — upsert allocation）
// ============================================================

export async function allocateToEntity(
  teamId: string,
  entity: BudgetEntity,
  allocatedTokens: number,
): Promise<AllocateToEntityResult> {
  if (allocatedTokens < 0) {
    return {
      ok: false,
      status: 400,
      response: { code: "INVALID_ALLOCATION", message: "allocated tokens must be non-negative" },
    }
  }

  const budgets = await db
    .select()
    .from(TeamBudgetTable)
    .where(eq(TeamBudgetTable.team_id, teamId))
    .limit(1)
  if (!budgets[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "BUDGET_NOT_FOUND", message: `no budget for team ${teamId}` },
    }
  }
  const budget = rowToBudget(budgets[0])

  const existing = await db
    .select()
    .from(TeamBudgetAllocationTable)
    .where(
      and(
        eq(TeamBudgetAllocationTable.budget_id, budget.id),
        eq(TeamBudgetAllocationTable.entity_type, entity.type),
        eq(TeamBudgetAllocationTable.entity_id, entity.id),
      ),
    )
    .limit(1)

  if (existing[0]) {
    await db
      .update(TeamBudgetAllocationTable)
      .set({
        allocated_tokens: allocatedTokens,
        updated_at: new Date(),
      })
      .where(eq(TeamBudgetAllocationTable.id, existing[0].id))
    const updated = await db
      .select()
      .from(TeamBudgetAllocationTable)
      .where(eq(TeamBudgetAllocationTable.id, existing[0].id))
      .limit(1)
    return { ok: true, allocation: updated[0] ? rowToAllocation(updated[0]) : rowToAllocation(existing[0]) }
  }

  const id = createDenTypeId("teamBudgetAllocation")
  await db.insert(TeamBudgetAllocationTable).values({
    id,
    budget_id: budget.id,
    entity_type: entity.type,
    entity_id: entity.id,
    allocated_tokens: allocatedTokens,
    used_tokens: 0,
  })

  const row = await db
    .select()
    .from(TeamBudgetAllocationTable)
    .where(eq(TeamBudgetAllocationTable.id, id))
    .limit(1)
  if (!row[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "allocation insert did not return a row" },
    }
  }
  return { ok: true, allocation: rowToAllocation(row[0]) }
}

// ============================================================
// P3-B：recordConsumption（I3 — allocation 单独原子消耗）
// ============================================================

export async function recordConsumption(
  budgetId: string,
  entity: BudgetEntity,
  tokens: number,
): Promise<RecordConsumptionResult> {
  if (tokens < 0) {
    return {
      ok: false,
      status: 400,
      response: { code: "INVALID_CONSUMPTION", message: "tokens must be non-negative" },
    }
  }

  const existing = await db
    .select()
    .from(TeamBudgetAllocationTable)
    .where(
      and(
        eq(TeamBudgetAllocationTable.budget_id, budgetId),
        eq(TeamBudgetAllocationTable.entity_type, entity.type),
        eq(TeamBudgetAllocationTable.entity_id, entity.id),
      ),
    )
    .limit(1)
  if (!existing[0]) {
    return {
      ok: false,
      status: 404,
      response: {
        code: "ALLOCATION_NOT_FOUND",
        message: `no allocation for ${entity.type}:${entity.id} under budget ${budgetId}`,
      },
    }
  }

  // I3 原子：UPDATE ... WHERE used + ? <= allocated（超限 → affectedRows=0）
  const updateResult = await db
    .update(TeamBudgetAllocationTable)
    .set({
      used_tokens: sql`${TeamBudgetAllocationTable.used_tokens} + ${tokens}`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(TeamBudgetAllocationTable.id, existing[0].id),
        sql`${TeamBudgetAllocationTable.used_tokens} + ${tokens} <= ${TeamBudgetAllocationTable.allocated_tokens}`,
      ),
    )

  const affected = extractAffectedRows(updateResult)
  if (affected === 0) {
    const refreshed = await db
      .select()
      .from(TeamBudgetAllocationTable)
      .where(eq(TeamBudgetAllocationTable.id, existing[0].id))
      .limit(1)
    const latest = refreshed[0] ? rowToAllocation(refreshed[0]) : rowToAllocation(existing[0])
    return {
      ok: false,
      status: 409,
      response: {
        code: "ALLOCATION_EXCEEDED",
        message: `usage would exceed allocation (used=${latest.usedTokens}, allocated=${latest.allocatedTokens})`,
      },
    }
  }

  const updated = await db
    .select()
    .from(TeamBudgetAllocationTable)
    .where(eq(TeamBudgetAllocationTable.id, existing[0].id))
    .limit(1)
  return { ok: true, allocation: updated[0] ? rowToAllocation(updated[0]) : rowToAllocation(existing[0]) }
}

// ============================================================
// P3-B：listAllocations（查询 budget 下全部 allocation）
// ============================================================

export async function listAllocations(budgetId: string): Promise<AllocationRow[]> {
  const rows = await db
    .select()
    .from(TeamBudgetAllocationTable)
    .where(eq(TeamBudgetAllocationTable.budget_id, budgetId))
  return rows.map(rowToAllocation)
}
