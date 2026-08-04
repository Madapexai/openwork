import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDenTypeId } from "@openwork-ee/utils/typeid"

// OpenSpecs P3-C — MailboxService RED/GREEN 测试
// 框架：node:test + tsx（任务要求）
// 不变量：
//   I1: 读消息标记 read_at 只允许本人（markRead 校验 recipient 身份 → 非本人 403 MAILBOX_READ_FORBIDDEN）
//   I2: approval_request 必须有 related_task_id（sendMessage → 400 APPROVAL_REQUEST_REQUIRES_TASK）
//   I3: 消息不可跨 team 访问（查询 API 强制 team 作用域）
//
// Spec: prds/team-autonomy/openspecs/openspec-mailbox-service.md
// 注：TeamMailboxTable 使用 snake_case JS 属性（与 team-autonomy.ts 一致）。

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_ta"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "mb-encryption-key-12345678901234567890"
  const existingSecret = process.env.BETTER_AUTH_SECRET
  if (!existingSecret || existingSecret.length < 32) {
    process.env.BETTER_AUTH_SECRET = "mb-better-auth-secret-1234567890123456789012"
  }
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

// ---------- 测试夹具 ID ----------
const organizationId = createDenTypeId("organization")
const teamId = createDenTypeId("team")
const otherTeamId = createDenTypeId("team")
const agentA = createDenTypeId("teamAgent")
const agentB = createDenTypeId("teamAgent")
const agentOther = createDenTypeId("teamAgent")
const memberOwner = createDenTypeId("member")
// related_task_id 列是 denTypeIdColumn("teamTask") → 前缀 ttsk
const relatedTaskId = createDenTypeId("teamTask")

type DbModule = typeof import("../../src/db.js")
type DrizzleModule = typeof import("@openwork-ee/den-db/drizzle")
type SchemaModule = typeof import("@openwork-ee/den-db/schema")
type MailboxModule = typeof import("../../src/team-autonomy/mailbox-service.js")

let db: DbModule["db"]
let drizzle: DrizzleModule
let schema: SchemaModule
let mailboxSvc: MailboxModule
let dbAvailable = false

async function clearAll() {
  await db.delete(schema.TeamMailboxTable).where(drizzle.like(schema.TeamMailboxTable.id, "tmbx_%"))
  await db.delete(schema.TeamAgentTable).where(drizzle.inArray(schema.TeamAgentTable.id, [agentA, agentB, agentOther]))
  await db.delete(schema.TeamTable).where(drizzle.inArray(schema.TeamTable.id, [teamId, otherTeamId]))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
}

before(async () => {
  seedRequiredEnv()

  // 动态 import（RED 阶段：listUnread/listByTask/countUnread/listByRecipient 不存在 → 调用时 TypeError）
  const mods = await Promise.all([
    import("../../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema"),
    import("../../src/team-autonomy/mailbox-service.js"),
  ])
  db = mods[0].db
  drizzle = mods[1]
  schema = mods[2]
  mailboxSvc = mods[3]

  try {
    await clearAll()
    await db.insert(schema.OrganizationTable).values({
      id: organizationId,
      name: "MB Org",
      slug: `mb-${organizationId}`,
      desktopAppRestrictions: {},
    })
    await db.insert(schema.TeamTable).values({
      id: teamId,
      organizationId,
      name: "MB Team",
      slug: `mb-team-${teamId}`,
      kind: "shared",
    })
    await db.insert(schema.TeamTable).values({
      id: otherTeamId,
      organizationId,
      name: "MB Other Team",
      slug: `mb-team-other-${otherTeamId}`,
      kind: "shared",
    })
    await db.insert(schema.TeamAgentTable).values({
      id: agentA,
      team_id: teamId,
      name: "mb-agent-a",
      engine: "openworker",
      status: "idle",
    })
    await db.insert(schema.TeamAgentTable).values({
      id: agentB,
      team_id: teamId,
      name: "mb-agent-b",
      engine: "openworker",
      status: "idle",
    })
    await db.insert(schema.TeamAgentTable).values({
      id: agentOther,
      team_id: otherTeamId,
      name: "mb-agent-other",
      engine: "openworker",
      status: "idle",
    })
    dbAvailable = true
  } catch (error) {
    dbAvailable = false
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`\n[mailbox-service.test] DB not available — DB tests will skip. Reason: ${message}\n`)
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

describe("P3-C MailboxService — OpenSpecs RED/GREEN", () => {
  // ============================================================
  // 纯逻辑测试（无需 DB）
  // ============================================================

  // ---------- T0: I3 isRecipientInTeam ----------
  test("T0: I3 isRecipientInTeam — channel always in, member/agent scoped to team", () => {
    // channel 恒真
    assert.strictEqual(mailboxSvc.isRecipientInTeam("channel", false), true)
    // agent/member 需 existsInTeam=true
    assert.strictEqual(mailboxSvc.isRecipientInTeam("agent", true), true)
    assert.strictEqual(mailboxSvc.isRecipientInTeam("agent", false), false)
    assert.strictEqual(mailboxSvc.isRecipientInTeam("member", false), false)
  })

  // ============================================================
  // DB 测试（I1-I3）
  // ============================================================

  // ---------- T1: I2 approval_request 必须带 related_task_id ----------
  test("T1: I2 sendMessage approval_request without relatedTaskId → 400 APPROVAL_REQUEST_REQUIRES_TASK", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await mailboxSvc.sendMessage({
      teamId,
      recipientType: "agent",
      recipientId: agentA,
      senderType: "member",
      senderId: memberOwner,
      kind: "approval_request",
      subject: "Approve this",
      body: "Please approve",
    })
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.status, 400)
      assert.strictEqual(result.response.code, "APPROVAL_REQUEST_REQUIRES_TASK")
    }
  })

  // ---------- T2: I2 approval_request 带 related_task_id → 成功 ----------
  test("T2: I2 sendMessage approval_request with relatedTaskId → ok", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await mailboxSvc.sendMessage({
      teamId,
      recipientType: "agent",
      recipientId: agentA,
      senderType: "member",
      senderId: memberOwner,
      kind: "approval_request",
      subject: "Approve this",
      body: "Please approve",
      relatedTaskId,
    })
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.message.relatedTaskId, relatedTaskId)
    }
  })

  // ---------- T3: I1 markRead 只允许本人 ----------
  test("T3: I1 markRead by non-recipient → 403 MAILBOX_READ_FORBIDDEN; by recipient → ok", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const sent = await mailboxSvc.sendMessage({
      teamId,
      recipientType: "agent",
      recipientId: agentA,
      senderType: "member",
      senderId: memberOwner,
      kind: "notification",
      body: "for agent A only",
    })
    assert.strictEqual(sent.ok, true)
    if (!sent.ok) return

    // 非收件人（agentB）→ 403
    const forbidden = await mailboxSvc.markRead(sent.message.id, { type: "agent", id: agentB })
    assert.strictEqual(forbidden.ok, false)
    if (!forbidden.ok) {
      assert.strictEqual(forbidden.status, 403)
      assert.strictEqual(forbidden.response.code, "MAILBOX_READ_FORBIDDEN")
    }
    // 数据未被修改
    const row1 = await db
      .select()
      .from(schema.TeamMailboxTable)
      .where(drizzle.eq(schema.TeamMailboxTable.id, sent.message.id))
      .limit(1)
    assert.strictEqual(row1[0]?.read_at, null)

    // 收件人本人（agentA）→ ok
    const ok = await mailboxSvc.markRead(sent.message.id, { type: "agent", id: agentA })
    assert.strictEqual(ok.ok, true)
    if (ok.ok) {
      assert.notStrictEqual(ok.message.readAt, null)
    }
  })

  // ---------- T4: I1 markRead 无效 typeid → 404（服务层守卫） ----------
  test("T4: I1 markRead invalid typeid → 404 NOT_FOUND (no crash)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await mailboxSvc.markRead("tmbx_nonexistent_0000000000000000", { type: "agent", id: agentA })
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.status, 404)
      assert.strictEqual(result.response.code, "NOT_FOUND")
    }
  })

  // ---------- T5: I3 listByRecipient 只返回本 team 消息 ----------
  test("T5: I3 listByRecipient scoped to team — cross-team messages excluded", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 发一条给其他 team 的消息（agentOther 属于 otherTeamId；I5 守门放行）
    const cross = await mailboxSvc.sendMessage({
      teamId: otherTeamId,
      recipientType: "agent",
      recipientId: agentOther,
      senderType: "member",
      senderId: memberOwner,
      kind: "notification",
      body: "cross team",
    })
    assert.strictEqual(cross.ok, true)

    const scoped = await mailboxSvc.listByRecipient(teamId, { type: "agent", id: agentA })
    // 只包含本 team 的消息（T2 的 approval_request + T3 的 notification）
    const ids = scoped.map((m) => m.id)
    assert.ok(!ids.includes(cross.ok && cross.message.id), "cross-team message must not leak")
    assert.strictEqual(ids.length, 2)

    const other = await mailboxSvc.listByRecipient(otherTeamId, { type: "agent", id: agentOther })
    assert.strictEqual(other.length, 1)
  })

  // ---------- T6: listUnread 只含未读 ----------
  test("T6: listUnread returns only unread messages", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // T3 已把一条 notification 标记已读；再发一条新的未读
    const fresh = await mailboxSvc.sendMessage({
      teamId,
      recipientType: "agent",
      recipientId: agentA,
      senderType: "member",
      senderId: memberOwner,
      kind: "notification",
      body: "fresh unread",
    })
    assert.strictEqual(fresh.ok, true)

    const unread = await mailboxSvc.listUnread(teamId, { type: "agent", id: agentA })
    const ids = unread.map((m) => m.id)
    // fresh 未读在内；T3 已读的 notification 不在
    if (fresh.ok) assert.ok(ids.includes(fresh.message.id))
    // 全部 readAt 为 null
    for (const m of unread) {
      assert.strictEqual(m.readAt, null)
    }
  })

  // ---------- T7: I3 listByTask 强制 team 作用域 ----------
  test("T7: I3 listByTask scoped to team — other team returns empty", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 本 team 有 T2 的 approval_request（relatedTaskId）
    const inTeam = await mailboxSvc.listByTask(relatedTaskId, teamId)
    assert.ok(inTeam.length >= 1)
    for (const m of inTeam) {
      assert.strictEqual(m.relatedTaskId, relatedTaskId)
    }

    // 其他 team 查同 task → 空（跨 team 隔离）
    const crossTeam = await mailboxSvc.listByTask(relatedTaskId, otherTeamId)
    assert.deepStrictEqual(crossTeam, [])

    // 不存在的 task → 空
    const none = await mailboxSvc.listByTask(createDenTypeId("teamTask"), teamId)
    assert.deepStrictEqual(none, [])
  })

  // ---------- T8: countUnread 计数 ----------
  test("T8: countUnread returns unread count", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const before = await mailboxSvc.countUnread(teamId, { type: "agent", id: agentA })
    assert.ok(typeof before === "number" && before >= 0)

    // 新增一条未读 → +1
    const sent = await mailboxSvc.sendMessage({
      teamId,
      recipientType: "agent",
      recipientId: agentA,
      senderType: "member",
      senderId: memberOwner,
      kind: "notification",
      body: "count me",
    })
    assert.strictEqual(sent.ok, true)
    if (!sent.ok) return

    const after = await mailboxSvc.countUnread(teamId, { type: "agent", id: agentA })
    assert.strictEqual(after, before + 1)

    // 标记已读 → -1
    const marked = await mailboxSvc.markRead(sent.message.id, { type: "agent", id: agentA })
    assert.strictEqual(marked.ok, true)
    const final = await mailboxSvc.countUnread(teamId, { type: "agent", id: agentA })
    assert.strictEqual(final, before)

    // 跨 team 计数隔离（otherTeamId 中 agentOther 只有 1 条未读 cross-team 消息）
    const other = await mailboxSvc.countUnread(otherTeamId, { type: "agent", id: agentOther })
    assert.strictEqual(other, 1)
  })
})
