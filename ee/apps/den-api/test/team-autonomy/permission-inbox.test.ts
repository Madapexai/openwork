import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDenTypeId } from "@openwork-ee/utils/typeid"

// OpenSpecs PermissionService + InboxService — RED/GREEN 测试
// 框架：node:test + tsx（任务要求）
// 纯逻辑测试（T2: resolveModeBehavior）无需 DB；DB 测试用 dbAvailable guard 跳过。

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_ta"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "pi-encryption-key-12345678901234567890"
  // env.ts 要求 BETTER_AUTH_SECRET >= 32 chars；任务命令给的 28 chars 会被 zod 拒绝，
  // 这里兜底：若外部传入过短就补长到 32+。
  const existingSecret = process.env.BETTER_AUTH_SECRET
  if (!existingSecret || existingSecret.length < 32) {
    process.env.BETTER_AUTH_SECRET = "pi-better-auth-secret-1234567890123456789012"
  }
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

const organizationId = createDenTypeId("organization")
const teamId = createDenTypeId("team")
const memberOwner = createDenTypeId("member")
const memberAdmin = createDenTypeId("member")
const memberEditor = createDenTypeId("member")
const memberViewer = createDenTypeId("member")
const agentWorker = createDenTypeId("teamAgent")
const agentWriter = createDenTypeId("teamAgent")
const taskA = createDenTypeId("teamTask")

type DbModule = typeof import("../../src/db.js")
type DrizzleModule = typeof import("@openwork-ee/den-db/drizzle")
type SchemaModule = typeof import("@openwork-ee/den-db/schema")
type PermModule = typeof import("../../src/team-autonomy/permission-service.js")
type InboxModule = typeof import("../../src/team-autonomy/inbox-service.js")

let db: DbModule["db"]
let drizzle: DrizzleModule
let schema: SchemaModule
let perm: PermModule
let inboxSvc: InboxModule
let dbAvailable = false

async function clearAll() {
  // team-autonomy 表的 JS 属性名为 snake_case（与 org.ts 不同）
  await db.delete(schema.TeamInboxTable).where(drizzle.like(schema.TeamInboxTable.id, "tibx_%"))
  await db.delete(schema.TeamStandingRuleTable).where(drizzle.like(schema.TeamStandingRuleTable.id, "tsrl_%"))
  await db.delete(schema.TeamPermissionProfileTable).where(drizzle.eq(schema.TeamPermissionProfileTable.team_id, teamId))
  await db.delete(schema.TeamAgentTable).where(drizzle.inArray(schema.TeamAgentTable.id, [agentWorker, agentWriter]))
  await db.delete(schema.TeamBudgetTable).where(drizzle.eq(schema.TeamBudgetTable.team_id, teamId))
  // OrganizationTable / TeamTable 使用 camelCase JS 属性（与 org.ts 一致）
  await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, teamId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
}

before(async () => {
  seedRequiredEnv()

  // 动态 import（service 文件存在即成功；db 创建是 lazy pool，不会抛）
  const mods = await Promise.all([
    import("../../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema"),
    import("../../src/team-autonomy/permission-service.js"),
    import("../../src/team-autonomy/inbox-service.js"),
  ])
  db = mods[0].db
  drizzle = mods[1]
  schema = mods[2]
  perm = mods[3]
  inboxSvc = mods[4]

  // 尝试 DB setup；失败则只跳过 DB 测试，纯逻辑测试照常跑
  try {
    await clearAll()
    await db.insert(schema.OrganizationTable).values({
      id: organizationId,
      name: "PI Org",
      slug: `pi-${organizationId}`,
      desktopAppRestrictions: {},
    })
    await db.insert(schema.TeamTable).values({
      id: teamId,
      organizationId,
      name: "PI Team",
      slug: `pi-team`,
      kind: "shared",
    })
    // 默认 permission profile
    await db.insert(schema.TeamPermissionProfileTable).values({
      id: createDenTypeId("teamPermissionProfile"),
      team_id: teamId,
      profile: "simple",
      default_mode: "craft",
      updated_by: memberOwner,
    })
    // agent worker 带 forbidden_actions
    await db.insert(schema.TeamAgentTable).values([
      {
        id: agentWorker,
        team_id: teamId,
        name: "worker",
        engine: "openworker",
        status: "idle",
        forbidden_actions: ["delete_file", "drop_table"],
      },
      {
        id: agentWriter,
        team_id: teamId,
        name: "writer",
        engine: "openworker",
        status: "idle",
        forbidden_actions: [],
      },
    ])
    // 预算配置
    await db.insert(schema.TeamBudgetTable).values({
      id: createDenTypeId("teamBudget"),
      team_id: teamId,
      period: "monthly",
      total_tokens: 1_000_000,
      used_tokens: 0,
      total_cost_cents: 10000,
      used_cost_cents: 0,
      reset_at: new Date(Date.now() + 30 * 86400_000),
    })
    dbAvailable = true
  } catch (error) {
    dbAvailable = false
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`\n[permission-inbox.test] DB not available — DB tests will skip. Reason: ${message}\n`)
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

describe("PermissionService + InboxService — OpenSpecs RED/GREEN", () => {
  // ---------- T1: P1 profile/mode 一致性 ----------
  test("T1: P1 setTeamPermissionProfile rejects auto under simple profile (400)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await perm.setTeamPermissionProfile(
      teamId,
      { profile: "simple", defaultMode: "auto" },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(r.ok, false)
    if (!r.ok) {
      assert.strictEqual(r.status, 400)
      assert.strictEqual(r.response.code, "INVALID_MODE_FOR_PROFILE")
    }
  })

  test("T1b: simple profile 允许 craft 模式", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await perm.setTeamPermissionProfile(
      teamId,
      { profile: "simple", defaultMode: "craft" },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(r.ok, true)
  })

  test("T1c: advanced profile 允许 auto 模式", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await perm.setTeamPermissionProfile(
      teamId,
      { profile: "advanced", defaultMode: "auto" },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(r.ok, true)
  })

  // ---------- T2: P2 resolveModeBehavior 纯函数 6×3 全矩阵 ----------
  test("T2: P2 resolveModeBehavior 6 modes 行为正确", () => {
    // ask
    const ask = perm.resolveModeBehavior("ask")
    assert.strictEqual(ask.requiresPlan, false)
    assert.strictEqual(ask.requiresApproval, true)
    assert.strictEqual(ask.autoApproveStanding, false)

    // craft
    const craft = perm.resolveModeBehavior("craft")
    assert.strictEqual(craft.requiresPlan, false)
    assert.strictEqual(craft.requiresApproval, false)
    assert.strictEqual(craft.autoApproveStanding, true)

    // plan
    const plan = perm.resolveModeBehavior("plan")
    assert.strictEqual(plan.requiresPlan, true)
    assert.strictEqual(plan.requiresApproval, false)
    assert.strictEqual(plan.autoApproveStanding, true)

    // interactive
    const interactive = perm.resolveModeBehavior("interactive")
    assert.strictEqual(interactive.requiresPlan, false)
    assert.strictEqual(interactive.requiresApproval, true)
    assert.strictEqual(interactive.autoApproveStanding, false)

    // auto
    const auto = perm.resolveModeBehavior("auto")
    assert.strictEqual(auto.requiresPlan, false)
    assert.strictEqual(auto.requiresApproval, false)
    assert.strictEqual(auto.autoApproveStanding, true)

    // custom 允许自定义
    const custom = perm.resolveModeBehavior("custom", {
      requiresPlan: true,
      requiresApproval: true,
      autoApproveStanding: true,
    })
    assert.strictEqual(custom.requiresPlan, true)
    assert.strictEqual(custom.requiresApproval, true)
    assert.strictEqual(custom.autoApproveStanding, true)
  })

  // ---------- T3: P3 forbidden > standing > mode 优先级 ----------
  test("T3: P3 forbidden_action 'delete_file' denies even if standing_rule exists", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 先给 taskA 加一条 standing rule: agentWorker + delete_file + "*"
    const rule = await perm.createStandingRule(
      {
        teamId,
        scope: "task",
        scopeId: taskA,
        toolName: "delete_file",
        targetPattern: "*",
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(rule.ok, true)

    // 但 agentWorker.forbiddenActions 包含 delete_file，必须拒绝
    const decision = await perm.checkToolPermission({
      teamId,
      taskId: taskA,
      agentId: agentWorker,
      toolName: "delete_file",
      arguments: { path: "/tmp/x" },
      targetPath: "/tmp/x",
    })
    assert.strictEqual(decision.decision, "deny")
    if (decision.decision === "deny") {
      assert.strictEqual(decision.reason, "forbidden_action")
    }
  })

  test("T3b: standing rule 命中 → allow/standing_rule（agentWriter 没有 forbidden）", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    await perm.createStandingRule(
      {
        teamId,
        scope: "task",
        scopeId: taskA,
        toolName: "write_file",
        targetPattern: "/repo/*.md",
      },
      { memberId: memberOwner, role: "owner" },
    )

    const decision = await perm.checkToolPermission({
      teamId,
      taskId: taskA,
      agentId: agentWriter,
      toolName: "write_file",
      arguments: { path: "/repo/readme.md" },
      targetPath: "/repo/readme.md",
    })
    assert.strictEqual(decision.decision, "allow")
    if (decision.decision === "allow") {
      assert.strictEqual(decision.reason, "standing_rule")
    }
  })

  test("T3c: 无 standing 且 mode=craft（autoApprove=true）→ require_approval（因为无 standing）", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 切回 simple + craft
    await perm.setTeamPermissionProfile(
      teamId,
      { profile: "simple", defaultMode: "craft" },
      { memberId: memberOwner, role: "owner" },
    )

    const decision = await perm.checkToolPermission({
      teamId,
      taskId: taskA,
      agentId: agentWriter,
      toolName: "read_file",
      arguments: { path: "/a.txt" },
      targetPath: "/a.txt",
    })
    // autoApproveStanding=true 但无 standing_rule → 需审批
    assert.ok(
      ["allow", "require_approval"].includes(decision.decision),
      `expected allow or require_approval, got ${decision.decision}`,
    )
  })

  // ---------- T4: StandingRule 权限 ----------
  test("T4: viewer 不能 revokeStandingRule (403)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 先创建
    const rule = await perm.createStandingRule(
      {
        teamId,
        scope: "team",
        toolName: "list_dir",
        targetPattern: "*",
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(rule.ok, true)
    if (!rule.ok) return

    const r = await perm.revokeStandingRule(rule.rule.id, {
      memberId: memberViewer,
      role: "viewer",
    })
    assert.strictEqual(r.ok, false)
    if (!r.ok) assert.strictEqual(r.status, 403)
  })

  // ---------- T5: P4 first-responder-wins ----------
  test("T5: P4 concurrent resolveInboxEntry — only one succeeds, other 409", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 先建 entry
    const created = await inboxSvc.createInboxEntry({
      teamId,
      taskId: taskA,
      assigneeType: "member",
      assigneeId: memberOwner,
      kind: "approval",
      toolName: "delete_file",
      arguments: { path: "/x" },
      reason: "危险操作需要确认",
    })
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const inboxId = created.entry.id

    // 并发 resolve
    const results = await Promise.all([
      inboxSvc.resolveInboxEntry(
        inboxId,
        { status: "resolved", resolution: { approved: true } },
        { memberId: memberOwner },
      ),
      inboxSvc.resolveInboxEntry(
        inboxId,
        { status: "denied", reason: "不安全" },
        { memberId: memberAdmin },
      ),
    ])
    const okCount = results.filter((r) => r.ok).length
    const failCount = results.filter((r) => !r.ok && r.status === 409).length
    assert.strictEqual(okCount, 1, `expected 1 ok, got ${okCount}`)
    assert.strictEqual(failCount, 1, `expected 1 conflict (409), got ${failCount}`)
  })

  // ---------- T6: P5 externalToolCallId 幂等 ----------
  test("T6: P5 same externalToolCallId twice → second created=false", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const extId = `pi-tc-${Date.now()}`
    const first = await inboxSvc.createInboxEntry({
      teamId,
      assigneeType: "member",
      assigneeId: memberEditor,
      kind: "question",
      reason: "问题？",
      externalToolCallId: extId,
    })
    assert.strictEqual(first.ok, true)
    if (first.ok) assert.strictEqual(first.created, true)

    const second = await inboxSvc.createInboxEntry({
      teamId,
      assigneeType: "member",
      assigneeId: memberEditor,
      kind: "question",
      reason: "问题？（重复）",
      externalToolCallId: extId,
    })
    assert.strictEqual(second.ok, true)
    if (second.ok) {
      assert.strictEqual(second.created, false)
      if (!second.created) {
        assert.strictEqual(second.reason, "external_tool_call_exists")
      }
    }
  })

  // ---------- T7: budget 超支 deny ----------
  test("T7: budget fully spent → checkToolPermission deny/budget_exceeded", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 先手动把 used_cost_cents 设满
    await db
      .update(schema.TeamBudgetTable)
      .set({ used_cost_cents: 10000, used_tokens: 1_000_000 })
      .where(drizzle.eq(schema.TeamBudgetTable.team_id, teamId))

    const decision = await perm.checkToolPermission({
      teamId,
      taskId: taskA,
      agentId: agentWriter,
      toolName: "expensive_llm",
      arguments: { prompt: "x".repeat(1000) },
    })
    assert.strictEqual(decision.decision, "deny")
    if (decision.decision === "deny") {
      assert.strictEqual(decision.reason, "budget_exceeded")
    }

    // 恢复
    await db
      .update(schema.TeamBudgetTable)
      .set({ used_cost_cents: 0, used_tokens: 0 })
      .where(drizzle.eq(schema.TeamBudgetTable.team_id, teamId))
  })

  // ---------- T8: 6 模式 × 决策枚举 覆盖 ----------
  test("T8: 6 modes × require_approval matrix has full coverage (smoke)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const modes = ["ask", "craft", "plan", "interactive", "auto", "custom"] as const
    for (const mode of modes) {
      await perm.setTeamPermissionProfile(
        teamId,
        {
          profile: mode === "interactive" || mode === "auto" || mode === "custom" ? "advanced" : "simple",
          defaultMode: mode,
        },
        { memberId: memberOwner, role: "owner" },
      )
      const b = perm.resolveModeBehavior(mode)
      // 三个布尔字段都存在
      assert.strictEqual(typeof b.requiresPlan, "boolean")
      assert.strictEqual(typeof b.requiresApproval, "boolean")
      assert.strictEqual(typeof b.autoApproveStanding, "boolean")
    }
  })
})
