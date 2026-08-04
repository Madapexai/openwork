import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDenTypeId } from "@openwork-ee/utils/typeid"

// OpenSpecs TaskService — RED/GREEN 测试
// 框架：node:test + tsx（任务要求）
// 纯逻辑测试（T1/T2/T3: isValidTaskTransition / hasCycle / canApprovePlan）无需 DB；
// DB 测试用 dbAvailable guard 跳过。

function seedRequiredEnv() {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_ta"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY =
    process.env.DEN_DB_ENCRYPTION_KEY ?? "ta-encryption-key-12345678901234567890"
  // env.ts 要求 BETTER_AUTH_SECRET >= 32 chars；任务命令给的 28 chars 会被 zod 拒绝，
  // 这里兜底：若外部传入过短就补长到 32+。
  const existingSecret = process.env.BETTER_AUTH_SECRET
  if (!existingSecret || existingSecret.length < 32) {
    process.env.BETTER_AUTH_SECRET = "ts-better-auth-secret-1234567890123456789012"
  }
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

const organizationId = createDenTypeId("organization")
const teamId = createDenTypeId("team")
const teamIdPlan = createDenTypeId("team") // 启用 plan 模式的 team
const memberOwner = createDenTypeId("member")
const memberAdmin = createDenTypeId("member")
const memberEditor = createDenTypeId("member")
const memberViewer = createDenTypeId("member")
const agentA = createDenTypeId("teamAgent")
const agentB = createDenTypeId("teamAgent")
const boardId = createDenTypeId("teamBoard")

type DbModule = typeof import("../../src/db.js")
type DrizzleModule = typeof import("@openwork-ee/den-db/drizzle")
type SchemaModule = typeof import("@openwork-ee/den-db/schema")
type TaskModule = typeof import("../../src/team-autonomy/task-service.js")

let db: DbModule["db"]
let drizzle: DrizzleModule
let schema: SchemaModule
let taskSvc: TaskModule
let dbAvailable = false

async function clearAll() {
  // team-autonomy 表的 JS 属性名为 snake_case
  await db
    .delete(schema.TeamTaskHandoffTable)
    .where(drizzle.like(schema.TeamTaskHandoffTable.id, "tthd_%"))
  await db
    .delete(schema.TeamTaskTable)
    .where(drizzle.like(schema.TeamTaskTable.id, "ttsk_%"))
  await db
    .delete(schema.TeamBoardTable)
    .where(drizzle.like(schema.TeamBoardTable.id, "tbrd_%"))
  await db
    .delete(schema.TeamPermissionProfileTable)
    .where(
      drizzle.inArray(schema.TeamPermissionProfileTable.team_id, [teamId, teamIdPlan]),
    )
  await db
    .delete(schema.TeamAgentTable)
    .where(drizzle.inArray(schema.TeamAgentTable.id, [agentA, agentB]))
  // OrganizationTable / TeamTable 使用 camelCase JS 属性
  await db
    .delete(schema.TeamTable)
    .where(drizzle.inArray(schema.TeamTable.id, [teamId, teamIdPlan]))
  await db
    .delete(schema.OrganizationTable)
    .where(drizzle.eq(schema.OrganizationTable.id, organizationId))
}

before(async () => {
  seedRequiredEnv()

  // 动态 import（service 文件存在即成功；db 创建是 lazy pool，不会抛）
  const mods = await Promise.all([
    import("../../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema"),
    import("../../src/team-autonomy/task-service.js"),
  ])
  db = mods[0].db
  drizzle = mods[1]
  schema = mods[2]
  taskSvc = mods[3]

  // 尝试 DB setup；失败则只跳过 DB 测试，纯逻辑测试照常跑
  try {
    await clearAll()
    await db.insert(schema.OrganizationTable).values({
      id: organizationId,
      name: "TS Org",
      slug: `ts-${organizationId}`,
      desktopAppRestrictions: {},
    })
    await db.insert(schema.TeamTable).values([
      {
        id: teamId,
        organizationId,
        name: "TS Team",
        slug: `ts-team`,
        kind: "shared",
      },
      {
        id: teamIdPlan,
        organizationId,
        name: "TS Team Plan",
        slug: `ts-team-plan`,
        kind: "shared",
      },
    ])
    // teamId: craft 模式（不强制 plan）
    // teamIdPlan: plan 模式（强制 plan approved 才能 start）
    await db.insert(schema.TeamPermissionProfileTable).values([
      {
        id: createDenTypeId("teamPermissionProfile"),
        team_id: teamId,
        profile: "simple",
        default_mode: "craft",
        updated_by: memberOwner,
      },
      {
        id: createDenTypeId("teamPermissionProfile"),
        team_id: teamIdPlan,
        profile: "simple",
        default_mode: "plan",
        updated_by: memberOwner,
      },
    ])
    await db.insert(schema.TeamAgentTable).values([
      {
        id: agentA,
        team_id: teamId,
        name: "agentA",
        engine: "openworker",
        status: "idle",
        forbidden_actions: [],
      },
      {
        id: agentB,
        team_id: teamId,
        name: "agentB",
        engine: "openworker",
        status: "idle",
        forbidden_actions: [],
      },
    ])
    await db.insert(schema.TeamBoardTable).values({
      id: boardId,
      team_id: teamId,
      name: "TS Board",
      columns: ["todo", "in_progress", "review", "done"],
      created_by: memberOwner,
    })
    dbAvailable = true
  } catch (error) {
    dbAvailable = false
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `\n[task-service.test] DB not available — DB tests will skip. Reason: ${message}\n`,
    )
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

describe("TaskService — OpenSpecs RED/GREEN", () => {
  // ---------- T1: isValidTaskTransition 状态机矩阵（纯逻辑） ----------
  test("T1: isValidTaskTransition state machine matrix (pure logic)", () => {
    // todo → in_progress ✓
    assert.strictEqual(taskSvc.isValidTaskTransition("todo", "in_progress"), true)
    // todo → review ✗
    assert.strictEqual(taskSvc.isValidTaskTransition("todo", "review"), false)
    // todo → done ✗
    assert.strictEqual(taskSvc.isValidTaskTransition("todo", "done"), false)

    // in_progress → review ✓
    assert.strictEqual(taskSvc.isValidTaskTransition("in_progress", "review"), true)
    // in_progress → todo ✗
    assert.strictEqual(taskSvc.isValidTaskTransition("in_progress", "todo"), false)
    // in_progress → done ✗（必须先 review）
    assert.strictEqual(taskSvc.isValidTaskTransition("in_progress", "done"), false)

    // review → done ✓
    assert.strictEqual(taskSvc.isValidTaskTransition("review", "done"), true)
    // review → in_progress ✓（revision 回退）
    assert.strictEqual(taskSvc.isValidTaskTransition("review", "in_progress"), true)
    // review → todo ✗
    assert.strictEqual(taskSvc.isValidTaskTransition("review", "todo"), false)

    // done → anything ✗（终态）
    assert.strictEqual(taskSvc.isValidTaskTransition("done", "todo"), false)
    assert.strictEqual(taskSvc.isValidTaskTransition("done", "in_progress"), false)
    assert.strictEqual(taskSvc.isValidTaskTransition("done", "review"), false)
  })

  // ---------- T2: hasCycle DFS 三色标记（纯逻辑） ----------
  test("T2: hasCycle DFS three-color marking (pure logic)", () => {
    // 无环：A→B→C
    const acyclic = new Map<string, string[]>([
      ["A", ["B"]],
      ["B", ["C"]],
      ["C", []],
    ])
    assert.strictEqual(taskSvc.hasCycle(acyclic, "A"), false)

    // 有环：A→B→C→A
    const cyclic = new Map<string, string[]>([
      ["A", ["B"]],
      ["B", ["C"]],
      ["C", ["A"]],
    ])
    assert.strictEqual(taskSvc.hasCycle(cyclic, "A"), true)

    // 自环：A→A
    const selfLoop = new Map<string, string[]>([["A", ["A"]]])
    assert.strictEqual(taskSvc.hasCycle(selfLoop, "A"), true)

    // 菱形无环：A→B, A→C, B→D, C→D
    const diamond = new Map<string, string[]>([
      ["A", ["B", "C"]],
      ["B", ["D"]],
      ["C", ["D"]],
      ["D", []],
    ])
    assert.strictEqual(taskSvc.hasCycle(diamond, "A"), false)

    // 环在分支上：A→B, B→C, C→B（B-C 环）
    const branchCycle = new Map<string, string[]>([
      ["A", ["B"]],
      ["B", ["C"]],
      ["C", ["B"]],
    ])
    assert.strictEqual(taskSvc.hasCycle(branchCycle, "A"), true)

    // 空图
    assert.strictEqual(taskSvc.hasCycle(new Map(), "A"), false)

    // 不连通节点
    const disconnected = new Map<string, string[]>([
      ["A", ["B"]],
      ["B", []],
      ["X", ["Y"]],
      ["Y", []],
    ])
    assert.strictEqual(taskSvc.hasCycle(disconnected, "A"), false)
  })

  // ---------- T3: canApprovePlan 角色矩阵（纯逻辑） ----------
  test("T3: canApprovePlan role matrix (pure logic)", () => {
    assert.strictEqual(taskSvc.canApprovePlan("owner"), true)
    assert.strictEqual(taskSvc.canApprovePlan("admin"), true)
    assert.strictEqual(taskSvc.canApprovePlan("editor"), false)
    assert.strictEqual(taskSvc.canApprovePlan("viewer"), false)
  })

  // ---------- T4: createTask 基本功能 ----------
  test("T4: createTask returns id, status=todo, plan_status=none", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await taskSvc.createTask({
      teamId,
      boardId,
      columnId: "todo",
      title: "实现登录页",
      assignee: { type: "agent", id: agentA },
      createdBy: memberOwner,
    })
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.task.status, "todo")
      assert.strictEqual(result.task.planStatus, "none")
      assert.strictEqual(result.task.assigneeType, "agent")
      assert.strictEqual(result.task.assigneeId, agentA)
      assert.deepStrictEqual(result.task.dependsOn, [])
      assert.deepStrictEqual(result.task.blocks, [])
      assert.strictEqual(result.task.startedAt, null)
      assert.strictEqual(result.task.completedAt, null)
    }
  })

  // ---------- T5: I1 addDependency 形成环 → 409 ----------
  test("T5: I1 addDependency cycle returns 409 DEPENDENCY_CYCLE", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const a = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T5-A",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    const b = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T5-B",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    const c = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T5-C",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(a.ok && b.ok && c.ok)
    if (!(a.ok && b.ok && c.ok)) return

    // A→B, B→C 合法
    const ab = await taskSvc.addDependency(a.task.id, b.task.id)
    assert.strictEqual(ab.ok, true)
    const bc = await taskSvc.addDependency(b.task.id, c.task.id)
    assert.strictEqual(bc.ok, true)

    // C→A 形成环 → 409
    const ca = await taskSvc.addDependency(c.task.id, a.task.id)
    assert.strictEqual(ca.ok, false)
    if (!ca.ok) {
      assert.strictEqual(ca.status, 409)
      assert.strictEqual(ca.response.code, "DEPENDENCY_CYCLE")
    }
  })

  // ---------- T6: I2 addDependency 双向维护 blocks ----------
  test("T6: I2 addDependency maintains blocks bidirectionally", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const a = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T6-A",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    const b = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T6-B",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(a.ok && b.ok)
    if (!(a.ok && b.ok)) return

    const r = await taskSvc.addDependency(a.task.id, b.task.id)
    assert.strictEqual(r.ok, true)

    // 重新查询两个 task，验证双向
    const aAfter = await taskSvc.getTask(a.task.id)
    const bAfter = await taskSvc.getTask(b.task.id)
    assert.ok(aAfter && bAfter)
    if (aAfter && bAfter) {
      assert.ok(aAfter.dependsOn.includes(b.task.id), "A.dependsOn should include B")
      assert.ok(bAfter.blocks.includes(a.task.id), "B.blocks should include A")
    }
  })

  // ---------- T6b: I2 removeDependency 双向移除 ----------
  test("T6b: I2 removeDependency removes bidirectionally", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const a = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T6b-A",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    const b = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T6b-B",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(a.ok && b.ok)
    if (!(a.ok && b.ok)) return
    await taskSvc.addDependency(a.task.id, b.task.id)

    const r = await taskSvc.removeDependency(a.task.id, b.task.id)
    assert.strictEqual(r.ok, true)

    const aAfter = await taskSvc.getTask(a.task.id)
    const bAfter = await taskSvc.getTask(b.task.id)
    assert.ok(aAfter && bAfter)
    if (aAfter && bAfter) {
      assert.ok(!aAfter.dependsOn.includes(b.task.id), "A.dependsOn should NOT include B")
      assert.ok(!bAfter.blocks.includes(a.task.id), "B.blocks should NOT include A")
    }
  })

  // ---------- T7: I3 plan 模式下 plan_status=pending 不能 start ----------
  test("T7: I3 plan mode + plan_status=pending → start returns 409 PLAN_NOT_APPROVED", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const task = await taskSvc.createTask({
      teamId: teamIdPlan, columnId: "todo", title: "T7-task",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(task.ok)
    if (!task.ok) return

    // setPlan → pending
    const sp = await taskSvc.setPlan(task.task.id, "1. UI 2. 接口", {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(sp.ok, true)

    // start (todo→in_progress) → 409/PLAN_NOT_APPROVED
    const start = await taskSvc.updateStatus(task.task.id, "in_progress", {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(start.ok, false)
    if (!start.ok) {
      assert.strictEqual(start.status, 409)
      assert.strictEqual(start.response.code, "PLAN_NOT_APPROVED")
    }
  })

  // ---------- T7b: I3 plan 模式 + approved → start ok ----------
  test("T7b: I3 plan mode + approved → start ok, started_at set", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const task = await taskSvc.createTask({
      teamId: teamIdPlan, columnId: "todo", title: "T7b-task",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(task.ok)
    if (!task.ok) return

    await taskSvc.setPlan(task.task.id, "plan", {
      memberId: memberOwner, role: "owner",
    })
    const ap = await taskSvc.approvePlan(task.task.id, {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(ap.ok, true)

    const start = await taskSvc.updateStatus(task.task.id, "in_progress", {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(start.ok, true)
    if (start.ok) {
      assert.strictEqual(start.task.status, "in_progress")
      assert.notStrictEqual(start.task.startedAt, null)
      assert.strictEqual(start.previousStatus, "todo")
    }
  })

  // ---------- T7c: I3 craft 模式（非 plan）→ 不要求 plan approved ----------
  test("T7c: I3 craft mode → start ok without plan", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const task = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T7c-task",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(task.ok)
    if (!task.ok) return

    // craft 模式下，不 setPlan 也能 start
    const start = await taskSvc.updateStatus(task.task.id, "in_progress", {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(start.ok, true)
  })

  // ---------- T8: I4 handoff 缺 context_snapshot → 400 ----------
  test("T8: I4 handoff missing context_snapshot returns 400", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const task = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T8-task",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(task.ok)
    if (!task.ok) return

    // 空对象 → MISSING_CONTEXT_SNAPSHOT
    const r = await taskSvc.handoff(
      task.task.id,
      { type: "agent", id: agentA },
      { type: "agent", id: agentB },
      "移交",
      {} as Record<string, unknown>,
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(r.ok, false)
    if (!r.ok) {
      assert.strictEqual(r.status, 400)
      assert.strictEqual(r.response.code, "MISSING_CONTEXT_SNAPSHOT")
    }
  })

  // ---------- T9: I4 handoff 写 handoff 行 + 更新 assignee ----------
  test("T9: I4 handoff writes handoff row + updates assignee", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const task = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T9-task",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(task.ok)
    if (!task.ok) return

    const snapshot = { progress: "UI 完成", session: "sess-123", artifacts: ["tart_x"] }
    const r = await taskSvc.handoff(
      task.task.id,
      { type: "agent", id: agentA },
      { type: "agent", id: agentB },
      "agentA 离线，移交 agentB",
      snapshot,
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      // task.assignee 已更新
      assert.strictEqual(r.task.assigneeId, agentB)
      assert.strictEqual(r.task.assigneeType, "agent")
      // handoff 行字段
      assert.strictEqual(r.handoff.taskId, task.task.id)
      assert.strictEqual(r.handoff.fromAssigneeId, agentA)
      assert.strictEqual(r.handoff.toAssigneeId, agentB)
      assert.deepStrictEqual(r.handoff.contextSnapshot, snapshot)
      assert.notStrictEqual(r.handoff.handedAt, null)
    }
  })

  // ---------- T10: I5 approved plan 不可篡改 ----------
  test("T10: I5 setPlan after approved returns 409 PLAN_ALREADY_APPROVED", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const task = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T10-task",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(task.ok)
    if (!task.ok) return

    await taskSvc.setPlan(task.task.id, "原计划", {
      memberId: memberOwner, role: "owner",
    })
    await taskSvc.approvePlan(task.task.id, {
      memberId: memberOwner, role: "owner",
    })

    // 再 setPlan → 409
    const r = await taskSvc.setPlan(task.task.id, "新计划", {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(r.ok, false)
    if (!r.ok) {
      assert.strictEqual(r.status, 409)
      assert.strictEqual(r.response.code, "PLAN_ALREADY_APPROVED")
    }
  })

  // ---------- T10b: I5 requestRevision 后可重新 setPlan ----------
  test("T10b: I5 after requestRevision, setPlan ok → pending", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const task = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T10b-task",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(task.ok)
    if (!task.ok) return

    await taskSvc.setPlan(task.task.id, "原计划", {
      memberId: memberOwner, role: "owner",
    })
    await taskSvc.approvePlan(task.task.id, {
      memberId: memberOwner, role: "owner",
    })
    const rev = await taskSvc.requestRevision(task.task.id, {
      memberId: memberOwner, role: "owner",
    }, "需要补充性能章节")
    assert.strictEqual(rev.ok, true)

    // 重新 setPlan → ok
    const r = await taskSvc.setPlan(task.task.id, "修订计划", {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.task.planStatus, "pending")
      assert.strictEqual(r.task.plan, "修订计划")
    }
  })

  // ---------- T11: approvePlan 权限 — viewer → 403 ----------
  test("T11: viewer approvePlan returns 403 FORBIDDEN_APPROVER", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const task = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T11-task",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(task.ok)
    if (!task.ok) return

    await taskSvc.setPlan(task.task.id, "plan", {
      memberId: memberOwner, role: "owner",
    })

    const r = await taskSvc.approvePlan(task.task.id, {
      memberId: memberViewer, role: "viewer",
    })
    assert.strictEqual(r.ok, false)
    if (!r.ok) {
      assert.strictEqual(r.status, 403)
      assert.strictEqual(r.response.code, "FORBIDDEN_APPROVER")
    }
  })

  // ---------- T11b: approvePlan 在非 pending 状态 → 409 ----------
  test("T11b: approvePlan on none status returns 409 PLAN_NOT_PENDING", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const task = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T11b-task",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(task.ok)
    if (!task.ok) return

    // 没有 setPlan，plan_status=none
    const r = await taskSvc.approvePlan(task.task.id, {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(r.ok, false)
    if (!r.ok) {
      assert.strictEqual(r.status, 409)
      assert.strictEqual(r.response.code, "PLAN_NOT_PENDING")
    }
  })

  // ---------- T12: 状态机非法转换 → 409 INVALID_TRANSITION ----------
  test("T12: todo→done returns 409 INVALID_TRANSITION", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const task = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T12-task",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(task.ok)
    if (!task.ok) return

    const r = await taskSvc.updateStatus(task.task.id, "done", {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(r.ok, false)
    if (!r.ok) {
      assert.strictEqual(r.status, 409)
      assert.strictEqual(r.response.code, "INVALID_TRANSITION")
    }
  })

  // ---------- T13: E2E-A 完整流程 ----------
  test("T13: E2E-A plan→approve→start→handoff→review→done", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const task = await taskSvc.createTask({
      teamId: teamIdPlan, columnId: "todo", title: "E2E-A 登录页",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(task.ok)
    if (!task.ok) return
    const id = task.task.id

    // 1. setPlan → pending
    const sp = await taskSvc.setPlan(id, "1. UI 2. 接口 3. 实现", {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(sp.ok, true)

    // 2. start before approve → 409
    const early = await taskSvc.updateStatus(id, "in_progress", {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(early.ok, false)

    // 3. approvePlan
    const ap = await taskSvc.approvePlan(id, {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(ap.ok, true)

    // 4. start → ok
    const st = await taskSvc.updateStatus(id, "in_progress", {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(st.ok, true)

    // 5. handoff agentA → agentB
    const ho = await taskSvc.handoff(
      id,
      { type: "agent", id: agentA },
      { type: "agent", id: agentB },
      "agentA 下班",
      { progress: "UI 完成 80%", session: "sess-e2e" },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(ho.ok, true)

    // 6. review
    const rv = await taskSvc.updateStatus(id, "review", {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(rv.ok, true)

    // 7. done
    const dn = await taskSvc.updateStatus(id, "done", {
      memberId: memberOwner, role: "owner",
    })
    assert.strictEqual(dn.ok, true)
    if (dn.ok) {
      assert.strictEqual(dn.task.status, "done")
      assert.notStrictEqual(dn.task.completedAt, null)
    }
  })

  // ---------- T14: listByAssignee ----------
  test("T14: listByAssignee returns tasks for assignee", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const t1 = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T14-1",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    const t2 = await taskSvc.createTask({
      teamId, columnId: "todo", title: "T14-2",
      assignee: { type: "agent", id: agentB }, createdBy: memberOwner,
    })
    assert.ok(t1.ok && t2.ok)
    if (!(t1.ok && t2.ok)) return

    const listA = await taskSvc.listByAssignee(teamId, { type: "agent", id: agentA })
    const listB = await taskSvc.listByAssignee(teamId, { type: "agent", id: agentB })
    assert.ok(listA.some((x) => x.id === t1.task.id))
    assert.ok(!listA.some((x) => x.id === t2.task.id))
    assert.ok(listB.some((x) => x.id === t2.task.id))
  })

  // ---------- T15: listByBoard ----------
  test("T15: listByBoard returns tasks on board", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await taskSvc.createTask({
      teamId, boardId, columnId: "todo", title: "T15-task",
      assignee: { type: "agent", id: agentA }, createdBy: memberOwner,
    })
    assert.ok(r.ok)
    if (!r.ok) return

    const list = await taskSvc.listByBoard(boardId)
    assert.ok(list.some((x) => x.id === r.task.id))
  })
})
