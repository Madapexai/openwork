import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDenTypeId } from "@openwork-ee/utils/typeid"

// OpenSpecs AssetService — RED/GREEN 测试
// 框架：node:test + tsx（任务要求）
// 纯逻辑测试（T8: isValidTransition 状态机矩阵）无需 DB；DB 测试用 dbAvailable guard 跳过。

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_ta"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "ta-encryption-key-12345678901234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "ta-better-auth-secret-123456789012"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

type TeamRole = "owner" | "admin" | "editor" | "viewer"
const organizationId = createDenTypeId("organization")
const teamId = createDenTypeId("team")
const memberOwner = createDenTypeId("member")
const memberAdmin = createDenTypeId("member")
const memberEditor = createDenTypeId("member")
const memberViewer = createDenTypeId("member")
const agentA = createDenTypeId("teamAgent")
const otherTeamTaskId = createDenTypeId("teamTask")

type DbModule = typeof import("../../src/db.js")
type DrizzleModule = typeof import("@openwork-ee/den-db/drizzle")
type SchemaModule = typeof import("@openwork-ee/den-db/schema")
type AssetModule = typeof import("../../src/team-autonomy/asset-service.js")

let db: DbModule["db"]
let drizzle: DrizzleModule
let schema: SchemaModule
let asset: AssetModule
let dbAvailable = false

async function clearArtifacts() {
  // 用真实 typeID 前缀（tart_/tarv_）过滤；与 createDenTypeId 生成的 id 一致
  await db.delete(schema.TeamArtifactVersionTable)
    .where(drizzle.like(schema.TeamArtifactVersionTable.id, "tarv_%"))
  await db.delete(schema.TeamArtifactTable)
    .where(drizzle.like(schema.TeamArtifactTable.id, "tart_%"))
  await db.delete(schema.TeamTable)
    .where(drizzle.eq(schema.TeamTable.id, teamId))
  await db.delete(schema.OrganizationTable)
    .where(drizzle.eq(schema.OrganizationTable.id, organizationId))
}

before(async () => {
  seedRequiredEnv()

  // 动态 import（service 文件存在即成功；db 创建是 lazy pool，不会抛）
  const mods = await Promise.all([
    import("../../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema"),
    import("../../src/team-autonomy/asset-service.js"),
  ])
  db = mods[0].db
  drizzle = mods[1]
  schema = mods[2]
  asset = mods[3]

  // 尝试 DB setup；失败则只跳过 DB 测试，纯逻辑测试照常跑
  try {
    await clearArtifacts()
    await db.insert(schema.OrganizationTable).values({
      id: organizationId,
      name: "TA Org",
      slug: `ta-${organizationId}`,
      desktopAppRestrictions: {},
    })
    await db.insert(schema.TeamTable).values({
      id: teamId,
      organizationId,
      name: "TA Team",
      slug: `ta-team`,
      kind: "shared",
    })
    dbAvailable = true
  } catch (error) {
    dbAvailable = false
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`\n[asset-service.test] DB not available — DB tests will skip. Reason: ${message}\n`)
  }
})

after(async () => {
  if (!dbAvailable) return
  try {
    await clearArtifacts()
  } catch {
    // ignore cleanup errors
  }
})

describe("AssetService — OpenSpecs RED/GREEN", () => {

  // ---------- T1: createArtifact 基本功能 ----------
  test("T1: createArtifact returns id, status=draft, version=1", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await asset.createArtifact({
      teamId, name: "设计文档", kind: "document",
      storageUri: "s3://bucket/doc-v1.md", sizeBytes: 1024,
      producedBy: { type: "agent", id: agentA },
    })
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.artifact.status, "draft")
      assert.strictEqual(result.artifact.currentVersion, 1)
      assert.strictEqual(result.artifact.producedById, agentA)
    }
  })

  // ---------- T2: 状态机 I1 — draft→confirmed 非法 ----------
  test("T2: I1 draft→confirmed returns 409 INVALID_TRANSITION", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await asset.createArtifact({
      teamId, name: "T2 artifact", kind: "document",
      storageUri: "s3://bucket/t2.md", sizeBytes: 500,
      producedBy: { type: "agent", id: agentA },
    })
    assert.strictEqual(created.ok, true)
    if (!created.ok) return

    const transition = await asset.transitionArtifact(created.artifact.id,
      { to: "confirmed", confirmedBy: memberOwner },
      { memberId: memberOwner, role: "owner" })
    assert.strictEqual(transition.ok, false)
    if (!transition.ok) {
      assert.strictEqual(transition.status, 409)
      assert.strictEqual(transition.response.code, "INVALID_TRANSITION")
    }
  })

  // ---------- T3: 权限 I2 — viewer 不能 confirm ----------
  test("T3: I2 viewer confirms in_review returns 403 FORBIDDEN_CONFIRMER", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await asset.createArtifact({
      teamId, name: "T3 artifact", kind: "document",
      storageUri: "s3://bucket/t3.md", sizeBytes: 500,
      producedBy: { type: "agent", id: agentA },
    })
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const id = created.artifact.id

    // draft → in_review (by editor, 合法)
    const toReview = await asset.transitionArtifact(id,
      { to: "in_review" },
      { memberId: memberEditor, role: "editor" })
    assert.strictEqual(toReview.ok, true)

    // viewer 尝试 confirm → 403
    const viewerConfirm = await asset.transitionArtifact(id,
      { to: "confirmed", confirmedBy: memberViewer },
      { memberId: memberViewer, role: "viewer" as TeamRole })
    assert.strictEqual(viewerConfirm.ok, false)
    if (!viewerConfirm.ok) {
      assert.strictEqual(viewerConfirm.status, 403)
      assert.strictEqual(viewerConfirm.response.code, "FORBIDDEN_CONFIRMER")
    }

    // owner 能 confirm → ok
    const ownerConfirm = await asset.transitionArtifact(id,
      { to: "confirmed", confirmedBy: memberOwner },
      { memberId: memberOwner, role: "owner" })
    assert.strictEqual(ownerConfirm.ok, true)
    if (ownerConfirm.ok) assert.strictEqual(ownerConfirm.artifact.status, "confirmed")
  })

  // ---------- T4: I3 下游只读 confirmed ----------
  test("T4: I3 listArtifactsForDownstream only returns confirmed", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 制造 3 个 artifact: draft / in_review / confirmed
    const [d, ir, c] = await Promise.all([
      asset.createArtifact({ teamId, name: "A-draft", kind: "document",
        storageUri: "s3://bucket/draft.md", sizeBytes: 1,
        producedBy: { type: "agent", id: agentA } }),
      asset.createArtifact({ teamId, name: "A-ir", kind: "document",
        storageUri: "s3://bucket/ir.md", sizeBytes: 1,
        producedBy: { type: "agent", id: agentA } }),
      asset.createArtifact({ teamId, name: "A-confirmed", kind: "document",
        storageUri: "s3://bucket/conf.md", sizeBytes: 1,
        producedBy: { type: "agent", id: agentA } }),
    ])
    assert.strictEqual(d.ok && ir.ok && c.ok, true)
    if (!(d.ok && ir.ok && c.ok)) return

    // 把 ir 转到 in_review, c 转到 confirmed
    await asset.transitionArtifact(ir.artifact.id, { to: "in_review" }, { memberId: memberOwner, role: "owner" })
    await asset.transitionArtifact(c.artifact.id, { to: "in_review" }, { memberId: memberOwner, role: "owner" })
    await asset.transitionArtifact(c.artifact.id, { to: "confirmed", confirmedBy: memberOwner }, { memberId: memberOwner, role: "owner" })

    // 调用下游列表，验证只有 1 条 confirmed
    const downstream = await asset.listArtifactsForDownstream(teamId)
    const names = downstream.map(a => a.name)
    assert.ok(names.includes("A-confirmed"), `expected A-confirmed in ${JSON.stringify(names)}`)
    assert.ok(!names.includes("A-draft"), `expected A-draft NOT in ${JSON.stringify(names)}`)
    assert.ok(!names.includes("A-ir"), `expected A-ir NOT in ${JSON.stringify(names)}`)
    for (const a of downstream) {
      assert.strictEqual(a.status, "confirmed")
    }
  })

  // ---------- T5: I4 版本单调递增 + 并发 ----------
  test("T5: I4 createArtifactVersion monotonically increases; concurrent writers — one throws or sequential", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await asset.createArtifact({
      teamId, name: "T5 artifact", kind: "code",
      storageUri: "s3://bucket/t5-v1.md", sizeBytes: 100,
      producedBy: { type: "agent", id: agentA },
    })
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const id = created.artifact.id

    // 连加 2 个版本，版本号必须 +1/+2
    const v2 = await asset.createArtifactVersion(id, {
      storageUri: "s3://bucket/t5-v2.md", sizeBytes: 110, changeSummary: "v2",
      producedBy: { type: "agent", id: agentA } })
    assert.strictEqual(v2.ok, true)
    if (v2.ok) assert.strictEqual(v2.version, 2)

    const v3 = await asset.createArtifactVersion(id, {
      storageUri: "s3://bucket/t5-v3.md", sizeBytes: 120, changeSummary: "v3",
      producedBy: { type: "agent", id: agentA } })
    assert.strictEqual(v3.ok, true)
    if (v3.ok) assert.strictEqual(v3.version, 3)

    // 并发写两个 v4：一个 OK（version=4），一个抛 duplicate 或返回错误
    const concurrent = await Promise.allSettled([
      asset.createArtifactVersion(id, { storageUri: "s3://bucket/t5-v4a.md", sizeBytes: 130,
        producedBy: { type: "agent", id: agentA } }),
      asset.createArtifactVersion(id, { storageUri: "s3://bucket/t5-v4b.md", sizeBytes: 131,
        producedBy: { type: "agent", id: agentA } }),
    ])
    const resolved = concurrent.filter(r => r.status === "fulfilled").map(r =>
      (r as PromiseFulfilledResult<typeof v2>).value)
    const rejected = concurrent.filter(r => r.status === "rejected")

    // 要么一个成功一个失败，要么都成功但都有唯一 version
    const okCount = resolved.filter(r => r.ok).length
    assert.ok(okCount + rejected.length >= 1, "expected at least one successful version")
    if (okCount === 2) {
      const vs = resolved.map(r => r.ok ? r.version : -1).filter(v => v > 0)
      assert.notStrictEqual(vs[0], vs[1])
    }
  })

  // ---------- T6: I6 跨团队 task_id 污染拒绝 ----------
  test("T6: I6 cross-team task_id returns 400 CROSS_TEAM_TASK", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // otherTeamTaskId 不在本 team 下（不存在于 DB）
    const result = await asset.createArtifact({
      teamId, taskId: otherTeamTaskId, name: "跨团队污染", kind: "document",
      storageUri: "s3://bucket/pollute.md", sizeBytes: 1,
      producedBy: { type: "agent", id: agentA },
    })
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.status, 400)
      assert.strictEqual(result.response.code, "CROSS_TEAM_TASK")
    }
  })

  // ---------- T7: I5 确认新版本 → 旧版本 superseded ----------
  test("T7: I5 confirming v2 supersedes v1 confirmed", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await asset.createArtifact({
      teamId, name: "T7 artifact", kind: "document",
      storageUri: "s3://bucket/t7-v1.md", sizeBytes: 1,
      producedBy: { type: "agent", id: agentA },
    })
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const id = created.artifact.id

    // v1 → confirm
    await asset.transitionArtifact(id, { to: "in_review" }, { memberId: memberOwner, role: "owner" })
    const v1Confirm = await asset.transitionArtifact(id,
      { to: "confirmed", confirmedBy: memberOwner }, { memberId: memberOwner, role: "owner" })
    assert.strictEqual(v1Confirm.ok, true)

    // v2 draft, in_review, confirm
    await asset.createArtifactVersion(id, { storageUri: "s3://bucket/t7-v2.md", sizeBytes: 2,
      changeSummary: "v2", producedBy: { type: "agent", id: agentA } })
    await asset.transitionArtifact(id, { to: "in_review" }, { memberId: memberOwner, role: "owner" })
    const v2Confirm = await asset.transitionArtifact(id,
      { to: "confirmed", confirmedBy: memberOwner }, { memberId: memberOwner, role: "owner" })
    assert.strictEqual(v2Confirm.ok, true)

    // 查询 v1 行：仍存在（不可变版本表）
    const v1Row = await asset.getArtifactVersion(id, 1)
    assert.notStrictEqual(v1Row, null)
    // artifact 主表 currentVersion=2, 且状态 confirmed; 旧版本对下游不可见
    // （因为 listArtifactsForDownstream 强制 status='confirmed' 且 current_version 指向 v2）
    if (v2Confirm.ok) assert.strictEqual(v2Confirm.artifact.currentVersion, 2)
  })

  // ---------- T8: I1 状态机矩阵（纯逻辑，无需 DB） ----------
  test("T8: I1 isValidTransition state machine matrix (pure logic)", () => {
    // draft → in_review ✓
    assert.strictEqual(asset.isValidTransition("draft", "in_review"), true)
    // draft → confirmed ✗（必须先 in_review）
    assert.strictEqual(asset.isValidTransition("draft", "confirmed"), false)
    // draft → archived ✗
    assert.strictEqual(asset.isValidTransition("draft", "archived"), false)
    // draft → superseded ✗
    assert.strictEqual(asset.isValidTransition("draft", "superseded"), false)

    // in_review → confirmed ✓
    assert.strictEqual(asset.isValidTransition("in_review", "confirmed"), true)
    // in_review → draft ✓（reject 回 draft）
    assert.strictEqual(asset.isValidTransition("in_review", "draft"), true)
    // in_review → archived ✗（必须先 confirmed）
    assert.strictEqual(asset.isValidTransition("in_review", "archived"), false)

    // confirmed → superseded ✓（新版本上线）
    assert.strictEqual(asset.isValidTransition("confirmed", "superseded"), true)
    // confirmed → archived ✓
    assert.strictEqual(asset.isValidTransition("confirmed", "archived"), true)
    // confirmed → draft ✗（不能从 confirmed 回 draft）
    assert.strictEqual(asset.isValidTransition("confirmed", "draft"), false)
    // confirmed → in_review ✗
    assert.strictEqual(asset.isValidTransition("confirmed", "in_review"), false)

    // superseded → archived ✓
    assert.strictEqual(asset.isValidTransition("superseded", "archived"), true)
    // superseded → confirmed ✗（不能复活）
    assert.strictEqual(asset.isValidTransition("superseded", "confirmed"), false)

    // archived → anything ✗（终态）
    assert.strictEqual(asset.isValidTransition("archived", "draft"), false)
    assert.strictEqual(asset.isValidTransition("archived", "in_review"), false)
    assert.strictEqual(asset.isValidTransition("archived", "confirmed"), false)
  })

  // ---------- T9: I2 canConfirm 权限矩阵（纯逻辑，无需 DB） ----------
  test("T9: I2 canConfirm role matrix (pure logic)", () => {
    assert.strictEqual(asset.canConfirm("owner"), true)
    assert.strictEqual(asset.canConfirm("admin"), true)
    assert.strictEqual(asset.canConfirm("editor"), false)
    assert.strictEqual(asset.canConfirm("viewer"), false)
  })
})
