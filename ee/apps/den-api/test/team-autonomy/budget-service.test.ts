import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDenTypeId } from "@openwork-ee/utils/typeid"

// OpenSpecs P3-B — BudgetService RED/GREEN 测试
// 框架：node:test + tsx（任务要求）
// 不变量：
//   I1: budget 周期唯一 team+period（createBudget 幂等 upsert）
//   I2: used_tokens <= total_tokens（recordUsage 原子条件更新，affectedRows=0 → 409 BUDGET_EXCEEDED；
//       允许打满 used == total，≤ 语义）
//   I3: allocation 消耗不超过 budget（recordUsage(teamId, entity, …) 双表原子；超 allocation → 409 ALLOCATION_EXCEEDED）
//   I4: reset_at 到期自动重置（resetIfDue）
//
// Spec: prds/team-autonomy/openspecs/openspec-budget-service.md
// 注：TeamBudgetTable / TeamBudgetAllocationTable 使用 snake_case JS 属性（与 team-autonomy.ts 一致）。
// 纯逻辑测试无需 DB；DB 测试用 dbAvailable guard。

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_ta"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "bg-encryption-key-12345678901234567890"
  const existingSecret = process.env.BETTER_AUTH_SECRET
  if (!existingSecret || existingSecret.length < 32) {
    process.env.BETTER_AUTH_SECRET = "bg-better-auth-secret-1234567890123456789012"
  }
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

// ---------- 测试夹具 ID ----------
const organizationId = createDenTypeId("organization")
const teamId = createDenTypeId("team")
const agentA = createDenTypeId("teamAgent")
const memberX = createDenTypeId("member")

type DbModule = typeof import("../../src/db.js")
type DrizzleModule = typeof import("@openwork-ee/den-db/drizzle")
type SchemaModule = typeof import("@openwork-ee/den-db/schema")
type BudgetModule = typeof import("../../src/team-autonomy/budget-service.js")

let db: DbModule["db"]
let drizzle: DrizzleModule
let schema: SchemaModule
let budgetSvc: BudgetModule
let dbAvailable = false

async function clearAll() {
  await db.delete(schema.TeamBudgetAllocationTable).where(drizzle.like(schema.TeamBudgetAllocationTable.id, "tbal_%"))
  await db.delete(schema.TeamBudgetTable).where(drizzle.like(schema.TeamBudgetTable.id, "tbgt_%"))
  await db.delete(schema.TeamAgentTable).where(drizzle.eq(schema.TeamAgentTable.id, agentA))
  await db.delete(schema.TeamTable).where(drizzle.like(schema.TeamTable.slug, "bg-team-%"))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
}

async function insertStandaloneTeam(prefix: string): Promise<string> {
  const id = createDenTypeId("team")
  await db.insert(schema.TeamTable).values({
    id,
    organizationId,
    name: `BG ${prefix} Team`,
    slug: `bg-team-${prefix}-${id}`,
    kind: "shared",
  })
  return id
}

before(async () => {
  seedRequiredEnv()

  // 动态 import（RED 阶段：新 API 不存在 → 调用时 TypeError）
  const mods = await Promise.all([
    import("../../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema"),
    import("../../src/team-autonomy/budget-service.js"),
  ])
  db = mods[0].db
  drizzle = mods[1]
  schema = mods[2]
  budgetSvc = mods[3]

  try {
    await clearAll()
    await db.insert(schema.OrganizationTable).values({
      id: organizationId,
      name: "BG Org",
      slug: `bg-${organizationId}`,
      desktopAppRestrictions: {},
    })
    // agentA 属于主 org（allocation entity 校验用）
    await db.insert(schema.TeamAgentTable).values({
      id: agentA,
      team_id: teamId,
      name: "bg-agent-a",
      engine: "openworker",
      status: "idle",
    })
    dbAvailable = true
  } catch (error) {
    dbAvailable = false
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`\n[budget-service.test] DB not available — DB tests will skip. Reason: ${message}\n`)
  }
})

after(async () => {
  if (!dbAvailable) return
  try {
    await clearAll()
  } catch {
    // ignore cleanup errors
  }
})

describe("P3-B BudgetService — OpenSpecs RED/GREEN", () => {
  // ============================================================
  // 纯逻辑测试（无需 DB）
  // ============================================================

  // ---------- T0a: I2 isBudgetExceeded 边界 ----------
  test("T0a: I2 isBudgetExceeded — used==total 视为超额（check 语义）", () => {
    // 未超额
    assert.strictEqual(
      budgetSvc.isBudgetExceeded({ usedTokens: 500, totalTokens: 1000, usedCostCents: 500, totalCostCents: 1000 }),
      false,
    )
    // == 视为超额（与 P2 一致：checkBudget 的 ≥ 语义）
    assert.strictEqual(
      budgetSvc.isBudgetExceeded({ usedTokens: 1000, totalTokens: 1000, usedCostCents: 0, totalCostCents: 1000 }),
      true,
    )
    // total=0 → 超额
    assert.strictEqual(
      budgetSvc.isBudgetExceeded({ usedTokens: 0, totalTokens: 0, usedCostCents: 0, totalCostCents: 0 }),
      true,
    )
  })

  // ---------- T0b: I4 reset 算法 ----------
  test("T0b: I4 computeNextResetAt / shouldResetBudget", () => {
    const from = new Date("2026-01-15T10:00:00Z")
    assert.strictEqual(budgetSvc.computeNextResetAt("daily", from).toISOString(), "2026-01-16T10:00:00.000Z")
    assert.strictEqual(budgetSvc.computeNextResetAt("weekly", from).toISOString(), "2026-01-22T10:00:00.000Z")
    assert.strictEqual(budgetSvc.computeNextResetAt("monthly", from).toISOString(), "2026-02-14T10:00:00.000Z")
    assert.strictEqual(
      budgetSvc.shouldResetBudget(new Date("2026-08-04T11:59:59Z"), new Date("2026-08-04T12:00:00Z")),
      true,
    )
    assert.strictEqual(
      budgetSvc.shouldResetBudget(new Date("2026-08-05T12:00:00Z"), new Date("2026-08-04T12:00:00Z")),
      false,
    )
  })

  // ============================================================
  // DB 测试（I1-I4）
  // ============================================================

  // ---------- T1: I1 createBudget 幂等 upsert ----------
  test("T1: I1 createBudget idempotent upsert — same team+period reuses row", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const team = await insertStandaloneTeam("t1")
    try {
      const first = await budgetSvc.createBudget({
        teamId: team,
        period: "monthly",
        totalTokens: 1000,
        totalCostCents: 1000,
      })
      assert.strictEqual(first.ok, true)
      if (!first.ok) return
      assert.strictEqual(first.created, true)

      // 同 team + 同 period → 复用同一行，更新 totals
      const second = await budgetSvc.createBudget({
        teamId: team,
        period: "monthly",
        totalTokens: 2000,
        totalCostCents: 2000,
      })
      assert.strictEqual(second.ok, true)
      if (second.ok) {
        assert.strictEqual(second.created, false)
        assert.strictEqual(second.budget.id, first.budget.id)
        assert.strictEqual(second.budget.totalTokens, 2000)
        assert.strictEqual(second.budget.totalCostCents, 2000)
      }

      // 同 team + 不同 period → 独立行
      const weekly = await budgetSvc.createBudget({
        teamId: team,
        period: "weekly",
        totalTokens: 500,
        totalCostCents: 500,
      })
      assert.strictEqual(weekly.ok, true)
      if (weekly.ok) {
        assert.strictEqual(weekly.created, true)
        assert.notStrictEqual(weekly.budget.id, first.budget.id)
      }
    } finally {
      await db.delete(schema.TeamBudgetTable).where(drizzle.eq(schema.TeamBudgetTable.team_id, team))
      await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, team))
    }
  })

  // ---------- T2: I3 allocation 超额 → 409 ALLOCATION_EXCEEDED（事务回滚） ----------
  test("T2: I3 recordUsage entity over allocation → 409 ALLOCATION_EXCEEDED with rollback", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const team = await insertStandaloneTeam("t2")
    try {
      const created = await budgetSvc.createBudget({
        teamId: team,
        period: "monthly",
        totalTokens: 1000,
        totalCostCents: 1000,
      })
      assert.strictEqual(created.ok, true)
      if (!created.ok) return

      const allocated = await budgetSvc.allocateToEntity(team, { type: "agent", id: agentA }, 400)
      assert.strictEqual(allocated.ok, true)

      // 500 tokens > allocation 400 → 409 ALLOCATION_EXCEEDED
      const r = await budgetSvc.recordUsage(team, { type: "agent", id: agentA }, 500, 500)
      assert.strictEqual(r.ok, false)
      if (!r.ok) {
        assert.strictEqual(r.status, 409)
        assert.strictEqual(r.response.code, "ALLOCATION_EXCEEDED")
      }

      // 事务回滚：budget 与 allocation 的 used 均未变
      const budget = await budgetSvc.getBudget(team)
      assert.notStrictEqual(budget, null)
      if (budget) {
        assert.strictEqual(budget.usedTokens, 0)
        assert.strictEqual(budget.usedCostCents, 0)
      }
      const allocations = await budgetSvc.listAllocations(budget?.id ?? created.budget.id)
      assert.strictEqual(allocations.length, 1)
      assert.strictEqual(allocations[0].usedTokens, 0)
    } finally {
      await db.delete(schema.TeamBudgetAllocationTable).where(drizzle.eq(schema.TeamBudgetAllocationTable.budget_id, (await db.select({ id: schema.TeamBudgetTable.id }).from(schema.TeamBudgetTable).where(drizzle.eq(schema.TeamBudgetTable.team_id, team)))[0]?.id ?? ""))
      await db.delete(schema.TeamBudgetTable).where(drizzle.eq(schema.TeamBudgetTable.team_id, team))
      await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, team))
    }
  })

  // ---------- T3: I2 团队级超额 → 409 BUDGET_EXCEEDED（原子） ----------
  test("T3: I2 recordUsage over team budget → 409 BUDGET_EXCEEDED, data unchanged", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const team = await insertStandaloneTeam("t3")
    try {
      await budgetSvc.createBudget({ teamId: team, period: "monthly", totalTokens: 1000, totalCostCents: 1000 })

      // 无 allocation 的 entity → 只受 budget 约束
      const ok1 = await budgetSvc.recordUsage(team, { type: "member", id: memberX }, 300, 300)
      assert.strictEqual(ok1.ok, true)

      // 300 + 900 = 1200 > 1000 → 409 BUDGET_EXCEEDED（原子条件更新）
      const r2 = await budgetSvc.recordUsage(team, { type: "member", id: memberX }, 900, 0)
      assert.strictEqual(r2.ok, false)
      if (!r2.ok) {
        assert.strictEqual(r2.status, 409)
        assert.strictEqual(r2.response.code, "BUDGET_EXCEEDED")
      }

      // 数据未变
      const budget = await budgetSvc.getBudget(team)
      assert.notStrictEqual(budget, null)
      if (budget) {
        assert.strictEqual(budget.usedTokens, 300)
        assert.strictEqual(budget.usedCostCents, 300)
      }
    } finally {
      await db.delete(schema.TeamBudgetTable).where(drizzle.eq(schema.TeamBudgetTable.team_id, team))
      await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, team))
    }
  })

  // ---------- T4: I2 打满（used == total 允许） ----------
  test("T4: I2 recordUsage allows hitting the cap exactly (used == total)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const team = await insertStandaloneTeam("t4")
    try {
      await budgetSvc.createBudget({ teamId: team, period: "monthly", totalTokens: 1000, totalCostCents: 1000 })

      const r = await budgetSvc.recordUsage(team, { type: "member", id: memberX }, 1000, 1000)
      assert.strictEqual(r.ok, true)
      if (r.ok) {
        assert.strictEqual(r.budget.usedTokens, 1000)
        assert.strictEqual(r.budget.usedCostCents, 1000)
      }

      // 打满后 checkBudget（≥ 语义）→ exceeded=true
      const check = await budgetSvc.checkBudget(team)
      assert.strictEqual(check.exceeded, true)

      // 再多 1 token → 原子拒绝
      const over = await budgetSvc.recordUsage(team, { type: "member", id: memberX }, 1, 0)
      assert.strictEqual(over.ok, false)
      if (!over.ok) {
        assert.strictEqual(over.status, 409)
        assert.strictEqual(over.response.code, "BUDGET_EXCEEDED")
      }
    } finally {
      await db.delete(schema.TeamBudgetTable).where(drizzle.eq(schema.TeamBudgetTable.team_id, team))
      await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, team))
    }
  })

  // ---------- T5: I3 recordConsumption 超额 ----------
  test("T5: I3 recordConsumption over allocation → 409 ALLOCATION_EXCEEDED", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const team = await insertStandaloneTeam("t5")
    try {
      const created = await budgetSvc.createBudget({ teamId: team, period: "monthly", totalTokens: 1000, totalCostCents: 1000 })
      assert.strictEqual(created.ok, true)
      if (!created.ok) return

      await budgetSvc.allocateToEntity(team, { type: "agent", id: agentA }, 400)

      const ok = await budgetSvc.recordConsumption(created.budget.id, { type: "agent", id: agentA }, 300)
      assert.strictEqual(ok.ok, true)
      if (ok.ok) {
        assert.strictEqual(ok.allocation.usedTokens, 300)
      }

      // 300 + 200 = 500 > 400 → 409
      const over = await budgetSvc.recordConsumption(created.budget.id, { type: "agent", id: agentA }, 200)
      assert.strictEqual(over.ok, false)
      if (!over.ok) {
        assert.strictEqual(over.status, 409)
        assert.strictEqual(over.response.code, "ALLOCATION_EXCEEDED")
      }
    } finally {
      await db.delete(schema.TeamBudgetAllocationTable).where(drizzle.like(schema.TeamBudgetAllocationTable.id, "tbal_%"))
      await db.delete(schema.TeamBudgetTable).where(drizzle.eq(schema.TeamBudgetTable.team_id, team))
      await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, team))
    }
  })

  // ---------- T6: I4 resetIfDue 到期自动重置 ----------
  test("T6: I4 resetIfDue resets used and advances reset_at when due", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const team = await insertStandaloneTeam("t6")
    try {
      const pastReset = new Date(Date.now() - 86400_000) // 1d 前
      const created = await budgetSvc.createBudget({
        teamId: team,
        period: "monthly",
        totalTokens: 1000,
        totalCostCents: 1000,
        resetAt: pastReset,
      })
      assert.strictEqual(created.ok, true)
      if (!created.ok) return

      // recordUsage 内部先自动重置（I4）→ used 归 0 后再记 500，reset_at 已推进到未来
      const usage = await budgetSvc.recordUsage(team, { type: "member", id: memberX }, 500, 500)
      assert.strictEqual(usage.ok, true)
      if (usage.ok) {
        assert.strictEqual(usage.budget.usedTokens, 500)
        const expectedReset = budgetSvc.computeNextResetAt("monthly", pastReset)
        assert.strictEqual(usage.budget.resetAt.toISOString(), expectedReset.toISOString())
      }

      // reset_at 已是未来 → 不再重置
      const notDue = await budgetSvc.resetIfDue(team, new Date())
      assert.strictEqual(notDue.reset, false)

      // 把 reset_at 拨回过去 → 到期触发重置
      const budgets = await db
        .select()
        .from(schema.TeamBudgetTable)
        .where(drizzle.eq(schema.TeamBudgetTable.team_id, team))
        .limit(1)
      if (budgets[0]) {
        await db
          .update(schema.TeamBudgetTable)
          .set({ reset_at: pastReset })
          .where(drizzle.eq(schema.TeamBudgetTable.id, budgets[0].id))
      }

      const now = new Date()
      const result = await budgetSvc.resetIfDue(team, now)
      assert.strictEqual(result.reset, true)
      assert.ok(result.budget, "budget should be returned after reset")
      if (result.budget) {
        assert.strictEqual(result.budget.usedTokens, 0)
        assert.strictEqual(result.budget.usedCostCents, 0)
        const expectedReset = budgetSvc.computeNextResetAt("monthly", pastReset)
        assert.strictEqual(result.budget.resetAt.toISOString(), expectedReset.toISOString())
      }

      // reset_at 已是未来 → 不再重置
      const result2 = await budgetSvc.resetIfDue(team, now)
      assert.strictEqual(result2.reset, false)
    } finally {
      await db.delete(schema.TeamBudgetTable).where(drizzle.eq(schema.TeamBudgetTable.team_id, team))
      await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, team))
    }
  })

  // ---------- T7: I3 listAllocations ----------
  test("T7: I3 listAllocations returns all allocations of a budget", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const team = await insertStandaloneTeam("t7")
    try {
      const created = await budgetSvc.createBudget({ teamId: team, period: "monthly", totalTokens: 1000, totalCostCents: 1000 })
      assert.strictEqual(created.ok, true)
      if (!created.ok) return

      await budgetSvc.allocateToEntity(team, { type: "agent", id: agentA }, 400)
      await budgetSvc.allocateToEntity(team, { type: "member", id: memberX }, 300)

      const allocations = await budgetSvc.listAllocations(created.budget.id)
      assert.strictEqual(allocations.length, 2)
      const byEntity = new Map(allocations.map((a) => [`${a.entityType}:${a.entityId}`, a]))
      assert.ok(byEntity.has(`agent:${agentA}`))
      assert.ok(byEntity.has(`member:${memberX}`))
      assert.strictEqual(byEntity.get(`agent:${agentA}`)?.allocatedTokens, 400)
      assert.strictEqual(byEntity.get(`member:${memberX}`)?.allocatedTokens, 300)

      // budget 不存在 → 空数组
      const none = await budgetSvc.listAllocations(createDenTypeId("teamBudget"))
      assert.deepStrictEqual(none, [])
    } finally {
      await db.delete(schema.TeamBudgetAllocationTable).where(drizzle.like(schema.TeamBudgetAllocationTable.id, "tbal_%"))
      await db.delete(schema.TeamBudgetTable).where(drizzle.eq(schema.TeamBudgetTable.team_id, team))
      await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, team))
    }
  })
})
