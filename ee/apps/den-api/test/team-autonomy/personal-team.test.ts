import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDenTypeId } from "@openwork-ee/utils/typeid"

// OpenSpecs P3-A — PersonalTeam 自动创建 RED/GREEN 测试
// 框架：node:test + tsx（任务要求）
// 不变量：
//   I1: 新用户注册后自动创建 kind=personal 的 Team（slug='personal-<teamId>' 唯一, owner_user_id=userId）
//       ensurePersonalTeam(memberId, userId) 幂等：重复调用返回同一 team
//   I2: personal team 的 ownerUserId=该用户（member 必须属于该 userId）→ 403 MEMBER_USER_MISMATCH
//   I3: personal team 自动创建 team_permission_profile（profile='simple', default_mode='craft'）
//
// Spec: prds/team-autonomy/openspecs/openspec-personal-team.md
// 注：member 行用 MemberTable（camelCase JS 属性，与 org.ts 一致）；
//     team 用 TeamTable（camelCase）；team_permission_profile 用 TeamPermissionProfileTable（snake_case）。

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_ta"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "pt-encryption-key-12345678901234567890"
  const existingSecret = process.env.BETTER_AUTH_SECRET
  if (!existingSecret || existingSecret.length < 32) {
    process.env.BETTER_AUTH_SECRET = "pt-better-auth-secret-1234567890123456789012"
  }
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

// ---------- 测试夹具 ID ----------
const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const otherUserId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const otherMemberId = createDenTypeId("member")
// 同一 org（organizationId）下的第二个用户 + member（slug 唯一性回归测试 T8 用）
const secondUserId = createDenTypeId("user")
const secondMemberId = createDenTypeId("member")

type DbModule = typeof import("../../src/db.js")
type DrizzleModule = typeof import("@openwork-ee/den-db/drizzle")
type SchemaModule = typeof import("@openwork-ee/den-db/schema")
type PersonalTeamModule = typeof import("../../src/team-autonomy/personal-team.js")

let db: DbModule["db"]
let drizzle: DrizzleModule
let schema: SchemaModule
let personalTeamSvc: PersonalTeamModule
let dbAvailable = false

async function clearAll() {
  // team_permission_profile（snake_case）— 按 team 的 owner_user_id 反查后清理
  const personalTeams = await db
    .select({ id: schema.TeamTable.id })
    .from(schema.TeamTable)
    .where(drizzle.inArray(schema.TeamTable.ownerUserId, [userId, otherUserId, secondUserId]))
  const teamIds = personalTeams.map((t) => t.id)
  if (teamIds.length > 0) {
    await db.delete(schema.TeamPermissionProfileTable).where(drizzle.inArray(schema.TeamPermissionProfileTable.team_id, teamIds))
  }
  await db.delete(schema.TeamTable).where(drizzle.inArray(schema.TeamTable.ownerUserId, [userId, otherUserId, secondUserId]))
  await db.delete(schema.MemberTable).where(drizzle.inArray(schema.MemberTable.id, [memberId, otherMemberId, secondMemberId]))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, [organizationId, otherOrganizationId]))
}

before(async () => {
  seedRequiredEnv()

  // 动态 import（RED 阶段：personal-team.js 不存在则 before 抛错，所有测试 fail）
  const mods = await Promise.all([
    import("../../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema"),
    import("../../src/team-autonomy/personal-team.js"),
  ])
  db = mods[0].db
  drizzle = mods[1]
  schema = mods[2]
  personalTeamSvc = mods[3]

  try {
    await clearAll()
    // 主 org + 用户 member（member.userId=userId）
    await db.insert(schema.OrganizationTable).values({
      id: organizationId,
      name: "PT Org",
      slug: `pt-${organizationId}`,
      desktopAppRestrictions: {},
    })
    await db.insert(schema.MemberTable).values({
      id: memberId,
      organizationId,
      userId,
      role: "owner",
      status: "active",
    })
    // 同一 org 下的第二个用户 member（slug 唯一性回归测试 T8 用）
    await db.insert(schema.MemberTable).values({
      id: secondMemberId,
      organizationId,
      userId: secondUserId,
      role: "member",
      status: "active",
    })
    // 其他 org + 其他用户 member（用于跨用户校验）
    await db.insert(schema.OrganizationTable).values({
      id: otherOrganizationId,
      name: "PT Other Org",
      slug: `pt-other-${otherOrganizationId}`,
      desktopAppRestrictions: {},
    })
    await db.insert(schema.MemberTable).values({
      id: otherMemberId,
      organizationId: otherOrganizationId,
      userId: otherUserId,
      role: "owner",
      status: "active",
    })
    dbAvailable = true
  } catch (error) {
    dbAvailable = false
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`\n[personal-team.test] DB not available — DB tests will skip. Reason: ${message}\n`)
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

describe("P3-A PersonalTeam 自动创建 — OpenSpecs RED/GREEN", () => {
  // ---------- T1: I1+I2 创建 personal team ----------
  test("T1: I1+I2 ensurePersonalTeam creates kind=personal team owned by userId", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await personalTeamSvc.ensurePersonalTeam(memberId, userId)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.created, true)
      assert.strictEqual(result.team.kind, "personal")
      // slug 唯一（personal-<teamId>），防同 org 下撞 team_organization_slug 唯一索引
      assert.ok(result.team.slug.startsWith("personal-"), `slug should start with personal-, got ${result.team.slug}`)
      // I2: ownerUserId = userId
      assert.strictEqual(result.team.ownerUserId, userId)
      assert.strictEqual(result.team.organizationId, organizationId)
    }
  })

  // ---------- T2: I1 幂等 ----------
  test("T2: I1 ensurePersonalTeam idempotent — second call returns same team with created=false", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const first = await personalTeamSvc.ensurePersonalTeam(memberId, userId)
    assert.strictEqual(first.ok, true)
    if (!first.ok) return

    const second = await personalTeamSvc.ensurePersonalTeam(memberId, userId)
    assert.strictEqual(second.ok, true)
    if (second.ok) {
      assert.strictEqual(second.created, false)
      assert.strictEqual(second.team.id, first.team.id)
      assert.strictEqual(second.team.ownerUserId, userId)
    }
  })

  // ---------- T3: I3 自动创建 permission profile ----------
  test("T3: I3 personal team auto-creates team_permission_profile (simple/craft)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await personalTeamSvc.ensurePersonalTeam(memberId, userId)
    assert.strictEqual(result.ok, true)
    if (!result.ok) return

    const rows = await db
      .select()
      .from(schema.TeamPermissionProfileTable)
      .where(drizzle.eq(schema.TeamPermissionProfileTable.team_id, result.team.id))
      .limit(1)
    assert.ok(rows[0], "team_permission_profile should exist for the personal team")
    if (rows[0]) {
      assert.strictEqual(rows[0].profile, "simple")
      assert.strictEqual(rows[0].default_mode, "craft")
      // updated_by = memberId（I3 中"创建人"）
      assert.strictEqual(rows[0].updated_by, memberId)
    }
  })

  // ---------- T4: I2 身份校验（member 属于其他 userId） ----------
  test("T4: I2 ensurePersonalTeam with mismatched userId → 403 MEMBER_USER_MISMATCH", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await personalTeamSvc.ensurePersonalTeam(memberId, otherUserId)
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.status, 403)
      assert.strictEqual(result.response.code, "MEMBER_USER_MISMATCH")
    }
  })

  // ---------- T5: I1 守卫（member 不存在） ----------
  test("T5: I1 ensurePersonalTeam with unknown member → 404 MEMBER_NOT_FOUND", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await personalTeamSvc.ensurePersonalTeam(createDenTypeId("member"), userId)
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.status, 404)
      assert.strictEqual(result.response.code, "MEMBER_NOT_FOUND")
    }
  })

  // ---------- T6: I3 幂等（不重建 profile） ----------
  test("T6: I3 repeated ensurePersonalTeam keeps single permission profile", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const first = await personalTeamSvc.ensurePersonalTeam(memberId, userId)
    assert.strictEqual(first.ok, true)
    if (!first.ok) return

    // 显式改 profile 后再次 ensure —— 不覆盖已有配置（幂等，保留用户设置）
    await db
      .update(schema.TeamPermissionProfileTable)
      .set({ default_mode: "plan" })
      .where(drizzle.eq(schema.TeamPermissionProfileTable.team_id, first.team.id))

    await personalTeamSvc.ensurePersonalTeam(memberId, userId)

    const rows = await db
      .select()
      .from(schema.TeamPermissionProfileTable)
      .where(drizzle.eq(schema.TeamPermissionProfileTable.team_id, first.team.id))
    assert.strictEqual(rows.length, 1, "should still be exactly one profile row")
    if (rows[0]) {
      // 已有配置不被覆盖
      assert.strictEqual(rows[0].default_mode, "plan")
    }
  })

  // ---------- T7: session hook 入口一致性 ----------
  test("T7: ensurePersonalTeamForUser resolves member and returns same team", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 用其他 org 的 member（otherMemberId 属于 otherOrganizationId）验证 hook 入口按 org 查 member
    const result = await personalTeamSvc.ensurePersonalTeamForUser(otherUserId, otherOrganizationId)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.team.ownerUserId, otherUserId)
      assert.strictEqual(result.team.organizationId, otherOrganizationId)
      assert.strictEqual(result.team.kind, "personal")
    }

    // org 下没有该用户 member → 404
    const missing = await personalTeamSvc.ensurePersonalTeamForUser(otherUserId, organizationId)
    assert.strictEqual(missing.ok, false)
    if (!missing.ok) {
      assert.strictEqual(missing.status, 404)
      assert.strictEqual(missing.response.code, "MEMBER_NOT_FOUND")
    }
  })

  // ---------- T8: slug 唯一性回归（同一 org 下两个用户的 personal team） ----------
  test("T8: same-org second user gets a distinct personal team slug (unique index safe)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // first user（memberId/userId）的 personal team 已由 T1 创建（同 organizationId）
    const first = await personalTeamSvc.ensurePersonalTeam(memberId, userId)
    assert.strictEqual(first.ok, true)
    if (!first.ok) return

    // 同一 org（organizationId）下的第二个用户 → 旧实现会撞 team_organization_slug/name 唯一索引
    const second = await personalTeamSvc.ensurePersonalTeam(secondMemberId, secondUserId)
    assert.strictEqual(second.ok, true)
    if (second.ok) {
      assert.strictEqual(second.created, true)
      assert.notStrictEqual(second.team.id, first.team.id)
      // 两个 slug 必须不同，且都遵循 personal-<teamId> 格式
      assert.notStrictEqual(second.team.slug, first.team.slug)
      assert.ok(second.team.slug.startsWith("personal-"), `slug should start with personal-, got ${second.team.slug}`)
      assert.strictEqual(second.team.organizationId, organizationId)
      assert.strictEqual(second.team.ownerUserId, secondUserId)
    }
  })
})
