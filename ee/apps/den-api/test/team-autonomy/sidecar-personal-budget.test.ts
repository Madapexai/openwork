import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDenTypeId } from "@openwork-ee/utils/typeid"

// OpenSpecs P3 — Sidecar + PersonalTeam + Budget + Mailbox RED/GREEN 测试
// 框架：node:test + tsx（任务要求）
// 纯逻辑测试（T5-T9）无需 DB；DB 测试用 dbAvailable guard 跳过。
//
// Spec: prds/team-autonomy/openspecs/openspec-sidecar-personal-budget.md

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_ta"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "spb-encryption-key-12345678901234567890"
  const existingSecret = process.env.BETTER_AUTH_SECRET
  if (!existingSecret || existingSecret.length < 32) {
    process.env.BETTER_AUTH_SECRET = "spb-better-auth-secret-1234567890123456789012"
  }
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

// ---------- 测试夹具 ID ----------
const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const otherUserId = createDenTypeId("user")
const teamId = createDenTypeId("team") // shared team（用于 budget/mailbox/sidecar 测试）
const otherTeamId = createDenTypeId("team") // 跨 team 校验用
const memberOwner = createDenTypeId("member")
const memberEditor = createDenTypeId("member")
const agentA = createDenTypeId("teamAgent")
const otherTeamAgent = createDenTypeId("teamAgent")

type DbModule = typeof import("../../src/db.js")
type DrizzleModule = typeof import("@openwork-ee/den-db/drizzle")
type SchemaModule = typeof import("@openwork-ee/den-db/schema")
type PersonalTeamModule = typeof import("../../src/team-autonomy/personal-team-service.js")
type BudgetModule = typeof import("../../src/team-autonomy/budget-service.js")
type MailboxModule = typeof import("../../src/team-autonomy/mailbox-service.js")
type SidecarModule = typeof import("../../src/team-autonomy/sidecar-service.js")

let db: DbModule["db"]
let drizzle: DrizzleModule
let schema: SchemaModule
let personalTeamSvc: PersonalTeamModule
let budgetSvc: BudgetModule
let mailboxSvc: MailboxModule
let sidecarSvc: SidecarModule
let dbAvailable = false

async function clearAll() {
  // team-autonomy 表的 JS 属性名为 snake_case
  await db.delete(schema.TeamMailboxTable).where(drizzle.like(schema.TeamMailboxTable.id, "tmbx_%"))
  await db.delete(schema.TeamBudgetAllocationTable).where(drizzle.like(schema.TeamBudgetAllocationTable.id, "tbal_%"))
  await db.delete(schema.TeamBudgetTable).where(drizzle.like(schema.TeamBudgetTable.id, "tbgt_%"))
  await db.delete(schema.TeamAgentTable).where(drizzle.inArray(schema.TeamAgentTable.id, [agentA, otherTeamAgent]))
  // TeamTable / OrganizationTable 使用 camelCase JS 属性（与 org.ts 一致）
  await db.delete(schema.TeamTable).where(drizzle.inArray(schema.TeamTable.id, [teamId, otherTeamId]))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, [organizationId, otherOrganizationId]))
  // 清理 personal team（按 owner_user_id 过滤）
  await db.delete(schema.TeamTable).where(drizzle.inArray(schema.TeamTable.ownerUserId, [userId, otherUserId]))
}

before(async () => {
  seedRequiredEnv()

  // 动态 import 4 个 service（RED 阶段：文件不存在则 before 抛错，所有测试 fail）
  const mods = await Promise.all([
    import("../../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema"),
    import("../../src/team-autonomy/personal-team-service.js"),
    import("../../src/team-autonomy/budget-service.js"),
    import("../../src/team-autonomy/mailbox-service.js"),
    import("../../src/team-autonomy/sidecar-service.js"),
  ])
  db = mods[0].db
  drizzle = mods[1]
  schema = mods[2]
  personalTeamSvc = mods[3]
  budgetSvc = mods[4]
  mailboxSvc = mods[5]
  sidecarSvc = mods[6]

  try {
    await clearAll()
    // 主组织 + 主 shared team（用于 budget/mailbox/sidecar 测试）
    await db.insert(schema.OrganizationTable).values({
      id: organizationId,
      name: "SPB Org",
      slug: `spb-${organizationId}`,
      desktopAppRestrictions: {},
    })
    await db.insert(schema.TeamTable).values({
      id: teamId,
      organizationId,
      name: "SPB Team",
      slug: `spb-team`,
      kind: "shared",
    })
    // 第二个 org + 跨 team 校验用 team
    await db.insert(schema.OrganizationTable).values({
      id: otherOrganizationId,
      name: "Other Org",
      slug: `spb-other-${otherOrganizationId}`,
      desktopAppRestrictions: {},
    })
    await db.insert(schema.TeamTable).values({
      id: otherTeamId,
      organizationId: otherOrganizationId,
      name: "Other Team",
      slug: `spb-other-team`,
      kind: "shared",
    })
    // 同 team agent + 跨 team agent
    await db.insert(schema.TeamAgentTable).values([
      {
        id: agentA,
        team_id: teamId,
        name: "agent-a",
        engine: "openworker",
        status: "idle",
      },
      {
        id: otherTeamAgent,
        team_id: otherTeamId,
        name: "other-agent",
        engine: "openworker",
        status: "idle",
      },
    ])
    dbAvailable = true
  } catch (error) {
    dbAvailable = false
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`\n[sidecar-personal-budget.test] DB not available — DB tests will skip. Reason: ${message}\n`)
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

describe("P3 Sidecar + PersonalTeam + Budget + Mailbox — OpenSpecs RED/GREEN", () => {
  // ============================================================
  // 纯逻辑测试（T5-T9）— 无需 DB
  // ============================================================

  // ---------- T5: I2 isPersonalTeamImmutable ----------
  test("T5: I2 isPersonalTeamImmutable — slug/kind 不可改", () => {
    // 改 slug → 不可改
    assert.strictEqual(
      personalTeamSvc.isPersonalTeamImmutable({ slug: "changed" } as never),
      true,
    )
    // 改 kind → 不可改
    assert.strictEqual(
      personalTeamSvc.isPersonalTeamImmutable({ kind: "shared" } as never),
      true,
    )
    assert.strictEqual(
      personalTeamSvc.isPersonalTeamImmutable({ kind: "enterprise" } as never),
      true,
    )
    // 改 name / settings → 允许
    assert.strictEqual(
      personalTeamSvc.isPersonalTeamImmutable({ name: "My Personal" } as never),
      false,
    )
    assert.strictEqual(
      personalTeamSvc.isPersonalTeamImmutable({ settings: { theme: "dark" } } as never),
      false,
    )
    // 空对象 → 允许
    assert.strictEqual(
      personalTeamSvc.isPersonalTeamImmutable({} as never),
      false,
    )
  })

  // ---------- T6: I3 isBudgetExceeded ----------
  test("T6: I3 isBudgetExceeded — used >= total 任一即超额", () => {
    // 未超额
    assert.strictEqual(
      budgetSvc.isBudgetExceeded({
        usedTokens: 0, totalTokens: 1000,
        usedCostCents: 0, totalCostCents: 1000,
      }),
      false,
    )
    assert.strictEqual(
      budgetSvc.isBudgetExceeded({
        usedTokens: 500, totalTokens: 1000,
        usedCostCents: 500, totalCostCents: 1000,
      }),
      false,
    )
    // token 超额（==）
    assert.strictEqual(
      budgetSvc.isBudgetExceeded({
        usedTokens: 1000, totalTokens: 1000,
        usedCostCents: 0, totalCostCents: 1000,
      }),
      true,
    )
    // token 超额（>）
    assert.strictEqual(
      budgetSvc.isBudgetExceeded({
        usedTokens: 1001, totalTokens: 1000,
        usedCostCents: 0, totalCostCents: 1000,
      }),
      true,
    )
    // cost 超额
    assert.strictEqual(
      budgetSvc.isBudgetExceeded({
        usedTokens: 0, totalTokens: 1000,
        usedCostCents: 1001, totalCostCents: 1000,
      }),
      true,
    )
    // total=0 视为超额（无配额）
    assert.strictEqual(
      budgetSvc.isBudgetExceeded({
        usedTokens: 0, totalTokens: 0,
        usedCostCents: 0, totalCostCents: 0,
      }),
      true,
    )
  })

  // ---------- T6b: I3 budgetExceedReason ----------
  test("T6b: I3 budgetExceedReason — tokens / cost / both", () => {
    assert.strictEqual(
      budgetSvc.budgetExceedReason({
        usedTokens: 1001, totalTokens: 1000,
        usedCostCents: 0, totalCostCents: 1000,
      }),
      "tokens",
    )
    assert.strictEqual(
      budgetSvc.budgetExceedReason({
        usedTokens: 0, totalTokens: 1000,
        usedCostCents: 1001, totalCostCents: 1000,
      }),
      "cost",
    )
    // 两者都超额 → 返回 'tokens'（优先级，按检查顺序）
    assert.strictEqual(
      budgetSvc.budgetExceedReason({
        usedTokens: 1001, totalTokens: 1000,
        usedCostCents: 1001, totalCostCents: 1000,
      }),
      "tokens",
    )
    // 未超额 → null
    assert.strictEqual(
      budgetSvc.budgetExceedReason({
        usedTokens: 500, totalTokens: 1000,
        usedCostCents: 500, totalCostCents: 1000,
      }),
      null,
    )
  })

  // ---------- T7: I4 computeNextResetAt ----------
  test("T7: I4 computeNextResetAt — daily/weekly/monthly 推进", () => {
    const from = new Date("2026-01-15T10:00:00Z")
    // daily +1d
    const daily = budgetSvc.computeNextResetAt("daily", from)
    assert.strictEqual(daily.toISOString(), "2026-01-16T10:00:00.000Z")
    // weekly +7d
    const weekly = budgetSvc.computeNextResetAt("weekly", from)
    assert.strictEqual(weekly.toISOString(), "2026-01-22T10:00:00.000Z")
    // monthly +30d
    const monthly = budgetSvc.computeNextResetAt("monthly", from)
    assert.strictEqual(monthly.toISOString(), "2026-02-14T10:00:00.000Z")
  })

  // ---------- T8: I4 shouldResetBudget ----------
  test("T8: I4 shouldResetBudget — resetAt<=now → true", () => {
    const now = new Date("2026-08-04T12:00:00Z")
    // resetAt 已过 → true
    assert.strictEqual(
      budgetSvc.shouldResetBudget(new Date("2026-08-04T11:59:59Z"), now),
      true,
    )
    // resetAt == now → true（边界：到期）
    assert.strictEqual(
      budgetSvc.shouldResetBudget(new Date("2026-08-04T12:00:00Z"), now),
      true,
    )
    // resetAt 未来 → false
    assert.strictEqual(
      budgetSvc.shouldResetBudget(new Date("2026-08-05T12:00:00Z"), now),
      false,
    )
  })

  // ---------- T9: I5 isRecipientInTeam ----------
  test("T9: I5 isRecipientInTeam — recipient 不在 team 则拒绝", () => {
    // 在 team → true
    assert.strictEqual(
      mailboxSvc.isRecipientInTeam("member", true),
      true,
    )
    assert.strictEqual(
      mailboxSvc.isRecipientInTeam("agent", true),
      true,
    )
    // 不在 team → false
    assert.strictEqual(
      mailboxSvc.isRecipientInTeam("member", false),
      false,
    )
    assert.strictEqual(
      mailboxSvc.isRecipientInTeam("agent", false),
      false,
    )
    // channel 类型不强制校验（广播）
    assert.strictEqual(
      mailboxSvc.isRecipientInTeam("channel", false),
      true,
    )
    assert.strictEqual(
      mailboxSvc.isRecipientInTeam("channel", true),
      true,
    )
  })

  // ============================================================
  // DB 测试（T10-T22）— dbAvailable guard
  // ============================================================

  // ---------- T10: I1 ensurePersonalTeam 幂等 ----------
  test("T10: I1 ensurePersonalTeam idempotent — second call created=false", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const first = await personalTeamSvc.ensurePersonalTeam({
      userId,
      organizationId,
      name: "My Personal",
    })
    assert.strictEqual(first.ok, true)
    if (first.ok) {
      assert.strictEqual(first.created, true)
      assert.strictEqual(first.team.kind, "personal")
      assert.strictEqual(first.team.slug, "personal")
      assert.strictEqual(first.team.ownerUserId, userId)
    }

    const second = await personalTeamSvc.ensurePersonalTeam({
      userId,
      organizationId,
    })
    assert.strictEqual(second.ok, true)
    if (second.ok) {
      assert.strictEqual(second.created, false)
      // 幂等：返回同一 team
      assert.strictEqual(second.team.id, first.team.id)
    }
  })

  // ---------- T11: I2 updatePersonalTeam 拒绝改 slug ----------
  test("T11: I2 updatePersonalTeam rejects slug change → 400 PERSONAL_TEAM_IMMUTABLE", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const ensured = await personalTeamSvc.ensurePersonalTeam({
      userId: otherUserId,
      organizationId,
      name: "Personal 2",
    })
    assert.strictEqual(ensured.ok, true)
    if (!ensured.ok) return

    const result = await personalTeamSvc.updatePersonalTeam(ensured.team.id, {
      // 故意传不允许的字段（类型断言绕过编译期校验）
      ...({ slug: "changed" } as unknown as { name: string }),
    })
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.status, 400)
      assert.strictEqual(result.response.code, "PERSONAL_TEAM_IMMUTABLE")
    }
  })

  // ---------- T12: I2 updatePersonalTeam 拒绝改 kind ----------
  test("T12: I2 updatePersonalTeam rejects kind change → 400 PERSONAL_TEAM_IMMUTABLE", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const ensured = await personalTeamSvc.ensurePersonalTeam({
      userId: otherUserId,
      organizationId,
      name: "Personal 3",
    })
    assert.strictEqual(ensured.ok, true)
    if (!ensured.ok) return

    const result = await personalTeamSvc.updatePersonalTeam(ensured.team.id, {
      ...({ kind: "shared" } as unknown as { name: string }),
    })
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.status, 400)
      assert.strictEqual(result.response.code, "PERSONAL_TEAM_IMMUTABLE")
    }

    // name 改 → ok
    const okResult = await personalTeamSvc.updatePersonalTeam(ensured.team.id, {
      name: "Renamed Personal",
    })
    assert.strictEqual(okResult.ok, true)
    if (okResult.ok) {
      assert.strictEqual(okResult.team.name, "Renamed Personal")
      // slug / kind 仍不变
      assert.strictEqual(okResult.team.slug, "personal")
      assert.strictEqual(okResult.team.kind, "personal")
    }
  })

  // ---------- T13: I3 recordUsage 原子 increment ----------
  test("T13: I3 recordUsage atomically increments used_tokens/used_cost_cents", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const allocated = await budgetSvc.allocateBudget({
      teamId,
      period: "monthly",
      totalTokens: 1_000_000,
      totalCostCents: 10000,
    })
    assert.strictEqual(allocated.ok, true)
    if (!allocated.ok) return

    const r1 = await budgetSvc.recordUsage({
      teamId,
      tokensUsed: 500_000,
      costCentsUsed: 5000,
    })
    assert.strictEqual(r1.ok, true)
    if (r1.ok) {
      assert.strictEqual(r1.budget.usedTokens, 500_000)
      assert.strictEqual(r1.budget.usedCostCents, 5000)
    }

    const r2 = await budgetSvc.recordUsage({
      teamId,
      tokensUsed: 100_000,
      costCentsUsed: 1000,
    })
    assert.strictEqual(r2.ok, true)
    if (r2.ok) {
      // 累加 = 600_000 / 6000
      assert.strictEqual(r2.budget.usedTokens, 600_000)
      assert.strictEqual(r2.budget.usedCostCents, 6000)
    }
  })

  // ---------- T14: I3 recordUsage 超额 → 409 ----------
  test("T14: I3 recordUsage overage → 409 BUDGET_EXCEEDED", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 用一个独立 team 避免与 T13 干扰
    const standaloneTeamId = createDenTypeId("team")
    try {
      await db.insert(schema.TeamTable).values({
        id: standaloneTeamId,
        organizationId,
        name: "Standalone Budget Team",
        slug: `spb-standalone-${standaloneTeamId}`,
        kind: "shared",
      })
      const allocated = await budgetSvc.allocateBudget({
        teamId: standaloneTeamId,
        period: "monthly",
        totalTokens: 1000,
        totalCostCents: 1000,
      })
      assert.strictEqual(allocated.ok, true)
      if (!allocated.ok) return

      // 用 500 → 剩 500
      const r1 = await budgetSvc.recordUsage({
        teamId: standaloneTeamId,
        tokensUsed: 500,
        costCentsUsed: 500,
      })
      assert.strictEqual(r1.ok, true)

      // 再用 600 tokens → 500+600=1100 > 1000 → 409
      const r2 = await budgetSvc.recordUsage({
        teamId: standaloneTeamId,
        tokensUsed: 600,
        costCentsUsed: 0,
      })
      assert.strictEqual(r2.ok, false)
      if (!r2.ok) {
        assert.strictEqual(r2.status, 409)
        assert.strictEqual(r2.response.code, "BUDGET_EXCEEDED")
      }

      // 数据未变（500/500）
      const final = await budgetSvc.getBudget(standaloneTeamId)
      assert.notStrictEqual(final, null)
      if (final) {
        assert.strictEqual(final.usedTokens, 500)
        assert.strictEqual(final.usedCostCents, 500)
      }
    } finally {
      await db.delete(schema.TeamBudgetTable).where(drizzle.eq(schema.TeamBudgetTable.team_id, standaloneTeamId))
      await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, standaloneTeamId))
    }
  })

  // ---------- T15: I3 checkBudget 超额返回 exceeded + reason ----------
  test("T15: I3 checkBudget returns exceeded=true with reason", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const standaloneTeamId = createDenTypeId("team")
    try {
      await db.insert(schema.TeamTable).values({
        id: standaloneTeamId,
        organizationId,
        name: "Standalone Check Team",
        slug: `spb-check-${standaloneTeamId}`,
        kind: "shared",
      })
      await budgetSvc.allocateBudget({
        teamId: standaloneTeamId,
        period: "monthly",
        totalTokens: 1000,
        totalCostCents: 1000,
      })
      // 直接打满
      await budgetSvc.recordUsage({
        teamId: standaloneTeamId,
        tokensUsed: 1000,
        costCentsUsed: 1000,
      })

      const check = await budgetSvc.checkBudget(standaloneTeamId)
      assert.strictEqual(check.exceeded, true)
      assert.strictEqual(check.usedTokens, 1000)
      assert.strictEqual(check.totalTokens, 1000)
      assert.strictEqual(check.usedCostCents, 1000)
      assert.strictEqual(check.totalCostCents, 1000)
      // reason 必须是 'tokens' 或 'cost'
      assert.ok(["tokens", "cost"].includes(check.reason ?? ""), `expected tokens/cost, got ${check.reason}`)
    } finally {
      await db.delete(schema.TeamBudgetTable).where(drizzle.eq(schema.TeamBudgetTable.team_id, standaloneTeamId))
      await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, standaloneTeamId))
    }
  })

  // ---------- T16: I4 resetBudgetIfDue 推进 reset_at + 清零 used ----------
  test("T16: I4 resetBudgetIfDue advances reset_at + zeros used", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const standaloneTeamId = createDenTypeId("team")
    try {
      await db.insert(schema.TeamTable).values({
        id: standaloneTeamId,
        organizationId,
        name: "Standalone Reset Team",
        slug: `spb-reset-${standaloneTeamId}`,
        kind: "shared",
      })
      const pastReset = new Date(Date.now() - 86400_000) // 1d 前
      const allocated = await budgetSvc.allocateBudget({
        teamId: standaloneTeamId,
        period: "monthly",
        totalTokens: 1000,
        totalCostCents: 1000,
        resetAt: pastReset,
      })
      assert.strictEqual(allocated.ok, true)
      if (!allocated.ok) return

      // 用一些
      await budgetSvc.recordUsage({
        teamId: standaloneTeamId,
        tokensUsed: 500,
        costCentsUsed: 500,
      })

      const now = new Date()
      const result = await budgetSvc.resetBudgetIfDue(standaloneTeamId, now)
      assert.strictEqual(result.reset, true)
      assert.ok(result.budget, "budget should be returned after reset")
      if (result.budget) {
        assert.strictEqual(result.budget.usedTokens, 0)
        assert.strictEqual(result.budget.usedCostCents, 0)
        // reset_at 已推进到过去 + 30d ≈ 29d 后
        const expectedReset = budgetSvc.computeNextResetAt("monthly", pastReset)
        assert.strictEqual(result.budget.resetAt.toISOString(), expectedReset.toISOString())
      }

      // 再调一次（reset_at 已是未来） → reset=false
      const result2 = await budgetSvc.resetBudgetIfDue(standaloneTeamId, now)
      assert.strictEqual(result2.reset, false)
    } finally {
      await db.delete(schema.TeamBudgetTable).where(drizzle.eq(schema.TeamBudgetTable.team_id, standaloneTeamId))
      await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, standaloneTeamId))
    }
  })

  // ---------- T17: I5 sendMessage 跨 team recipient → 400 ----------
  test("T17: I5 sendMessage cross-team agent recipient → 400 CROSS_TEAM_RECIPIENT", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 同 team agent → ok
    const ok = await mailboxSvc.sendMessage({
      teamId,
      recipientType: "agent",
      recipientId: agentA,
      senderType: "member",
      senderId: memberOwner,
      kind: "message",
      body: "hello from owner",
    })
    assert.strictEqual(ok.ok, true)
    if (ok.ok) {
      assert.strictEqual(ok.message.teamId, teamId)
      assert.strictEqual(ok.message.recipientId, agentA)
    }

    // 跨 team agent → 400
    const bad = await mailboxSvc.sendMessage({
      teamId,
      recipientType: "agent",
      recipientId: otherTeamAgent,
      senderType: "member",
      senderId: memberOwner,
      kind: "message",
      body: "should fail",
    })
    assert.strictEqual(bad.ok, false)
    if (!bad.ok) {
      assert.strictEqual(bad.status, 400)
      assert.strictEqual(bad.response.code, "CROSS_TEAM_RECIPIENT")
    }
  })

  // ---------- T18: markRead 更新 read_at ----------
  test("T18: markRead updates read_at", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const sent = await mailboxSvc.sendMessage({
      teamId,
      recipientType: "agent",
      recipientId: agentA,
      senderType: "member",
      senderId: memberOwner,
      kind: "notification",
      body: "please read",
    })
    assert.strictEqual(sent.ok, true)
    if (!sent.ok) return

    const before = await mailboxSvc.markRead(sent.message.id)
    assert.strictEqual(before.ok, true)
    if (before.ok) {
      assert.notStrictEqual(before.message.readAt, null)
    }

    // 不存在 → 404
    const missing = await mailboxSvc.markRead("tmbx_nonexistent_0000000000000000")
    assert.strictEqual(missing.ok, false)
    if (!missing.ok) {
      assert.strictEqual(missing.status, 404)
      assert.strictEqual(missing.response.code, "NOT_FOUND")
    }
  })

  // ---------- T19: listInbox / listSent 按 team_id 过滤 ----------
  test("T19: listInbox/listSent filter by team_id", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 在 otherTeamId 也插一条
    await mailboxSvc.sendMessage({
      teamId: otherTeamId,
      recipientType: "agent",
      recipientId: otherTeamAgent,
      senderType: "member",
      senderId: memberOwner,
      kind: "message",
      body: "in other team",
    })

    const inboxTeamA = await mailboxSvc.listInbox(teamId, { type: "agent", id: agentA })
    const inboxTeamB = await mailboxSvc.listInbox(otherTeamId, { type: "agent", id: otherTeamAgent })
    // team A 的 inbox 不应包含 team B 的消息
    const inboxTeamAIds = inboxTeamA.map((m) => m.id)
    for (const m of inboxTeamB) {
      assert.ok(!inboxTeamAIds.includes(m.id), `team A inbox should not include team B message ${m.id}`)
    }
    // team B 的 inbox 至少有 1 条
    assert.ok(inboxTeamB.length >= 1, "team B inbox should have at least 1 message")

    // listSent：按 sender 过滤
    const sentTeamA = await mailboxSvc.listSent(teamId, { type: "member", id: memberOwner })
    for (const m of sentTeamA) {
      assert.strictEqual(m.teamId, teamId, `sent list should only contain teamId messages, got ${m.teamId}`)
    }
  })

  // ---------- T20: I6 registerSidecarSession 写 sidecar_session_id ----------
  test("T20: I6 registerSidecarSession writes sidecar_session_id", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await sidecarSvc.registerSidecarSession(agentA, "sess_abc_001")
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.session.agentId, agentA)
      assert.strictEqual(result.session.sessionId, "sess_abc_001")
    }

    // agent 不存在 → 404
    const missing = await sidecarSvc.registerSidecarSession(
      createDenTypeId("teamAgent"),
      "sess_xyz",
    )
    assert.strictEqual(missing.ok, false)
    if (!missing.ok) {
      assert.strictEqual(missing.status, 404)
      assert.strictEqual(missing.response.code, "NOT_FOUND")
    }
  })

  // ---------- T21: getSidecarSession 返回 sessionId + agentStatus ----------
  test("T21: getSidecarSession returns sessionId + agentStatus", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // T20 已写入 sess_abc_001
    const session = await sidecarSvc.getSidecarSession(agentA)
    assert.notStrictEqual(session, null)
    if (session) {
      assert.strictEqual(session.agentId, agentA)
      assert.strictEqual(session.sessionId, "sess_abc_001")
      assert.strictEqual(session.agentStatus, "idle")
    }

    // 不存在的 agent → null
    const missing = await sidecarSvc.getSidecarSession(createDenTypeId("teamAgent"))
    assert.strictEqual(missing, null)
  })

  // ---------- T22: I6 invalidateSidecarSession 清空 + status=offline ----------
  test("T22: I6 invalidateSidecarSession clears session + sets status=offline", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 先确保有 session（T20 已写，但顺序不保证，这里独立注册）
    await sidecarSvc.registerSidecarSession(agentA, "sess_invalidate_me")

    const result = await sidecarSvc.invalidateSidecarSession(agentA)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.session.agentId, agentA)
      assert.strictEqual(result.session.sessionId, null)
      assert.strictEqual(result.session.agentStatus, "offline")
    }

    // 不存在的 agent → 404
    const missing = await sidecarSvc.invalidateSidecarSession(createDenTypeId("teamAgent"))
    assert.strictEqual(missing.ok, false)
    if (!missing.ok) {
      assert.strictEqual(missing.status, 404)
      assert.strictEqual(missing.response.code, "NOT_FOUND")
    }
  })
})
