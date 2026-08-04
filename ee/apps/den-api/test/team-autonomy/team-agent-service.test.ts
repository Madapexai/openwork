import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDenTypeId } from "@openwork-ee/utils/typeid"

// OpenSpecs TeamAgentService — RED/GREEN 测试
// 框架：node:test + tsx（任务要求）
// 纯逻辑测试（T9/T12: matchForbiddenAction / isValidStatusTransition）无需 DB；
// DB 测试用 dbAvailable guard 跳过。

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_ta"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "ta-encryption-key-12345678901234567890"
  const existingSecret = process.env.BETTER_AUTH_SECRET
  if (!existingSecret || existingSecret.length < 32) {
    process.env.BETTER_AUTH_SECRET = "ta-better-auth-secret-1234567890123456789012"
  }
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

type TeamRole = "owner" | "admin" | "editor" | "viewer"

const organizationId = createDenTypeId("organization")
const teamId = createDenTypeId("team")
const otherTeamId = createDenTypeId("team")
const memberOwner = createDenTypeId("member")
const memberAdmin = createDenTypeId("member")
const memberEditor = createDenTypeId("member")
const memberViewer = createDenTypeId("member")
const roleId = createDenTypeId("teamRole")
const otherTeamRoleId = createDenTypeId("teamRole")
const taskId = createDenTypeId("teamTask")
const validConfigObjectId = createDenTypeId("configObject")

type DbModule = typeof import("../../src/db.js")
type DrizzleModule = typeof import("@openwork-ee/den-db/drizzle")
type SchemaModule = typeof import("@openwork-ee/den-db/schema")
type AgentModule = typeof import("../../src/team-autonomy/team-agent-service.js")

let db: DbModule["db"]
let drizzle: DrizzleModule
let schema: SchemaModule
let agentSvc: AgentModule
let dbAvailable = false

async function clearAll() {
  // team-autonomy 表的 JS 属性名为 snake_case
  await db.delete(schema.TeamAgentTable).where(drizzle.like(schema.TeamAgentTable.id, "tagt_%"))
  await db.delete(schema.TeamRoleTable).where(drizzle.like(schema.TeamRoleTable.id, "trol_%"))
  await db.delete(schema.TeamTaskTable).where(drizzle.like(schema.TeamTaskTable.id, "ttsk_%"))
  await db.delete(schema.TeamTable).where(drizzle.inArray(schema.TeamTable.id, [teamId, otherTeamId]))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
}

before(async () => {
  seedRequiredEnv()

  const mods = await Promise.all([
    import("../../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema"),
    import("../../src/team-autonomy/team-agent-service.js"),
  ])
  db = mods[0].db
  drizzle = mods[1]
  schema = mods[2]
  agentSvc = mods[3]

  try {
    await clearAll()
    await db.insert(schema.OrganizationTable).values({
      id: organizationId,
      name: "TA Org",
      slug: `ta-${organizationId}`,
      desktopAppRestrictions: {},
    })
    await db.insert(schema.TeamTable).values([
      {
        id: teamId,
        organizationId,
        name: "TA Team",
        slug: `ta-team`,
        kind: "shared",
      },
      {
        id: otherTeamId,
        organizationId,
        name: "Other Team",
        slug: `ta-team-other`,
        kind: "shared",
      },
    ])
    // 角色：本 team 的 role + 其他 team 的 role
    await db.insert(schema.TeamRoleTable).values([
      {
        id: roleId,
        team_id: teamId,
        name: "editor",
        permissions: { can_create_task: true },
      },
      {
        id: otherTeamRoleId,
        team_id: otherTeamId,
        name: "editor",
        permissions: { can_create_task: true },
      },
    ])
    // 一个分配用 task
    await db.insert(schema.TeamTaskTable).values({
      id: taskId,
      team_id: teamId,
      title: "TA test task",
      status: "todo",
      column_id: "todo",
      assignee_type: "member",
      assignee_id: memberOwner,
      created_by: memberOwner,
      priority: "medium",
    })
    dbAvailable = true
  } catch (error) {
    dbAvailable = false
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`\n[team-agent-service.test] DB not available — DB tests will skip. Reason: ${message}\n`)
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

describe("TeamAgentService — OpenSpecs RED/GREEN", () => {
  // ---------- T1: createAgent 默认 status=idle ----------
  test("T1: createAgent returns id, status=idle, forbidden_actions=[]", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await agentSvc.createAgent(
      {
        teamId,
        name: "worker",
        engine: "openworker",
        forbiddenActions: ["delete_file"],
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.agent.status, "idle")
      assert.strictEqual(result.agent.teamId, teamId)
      assert.deepStrictEqual(result.agent.forbiddenActions, ["delete_file"])
      assert.strictEqual(result.agent.currentTaskId, null)
    }
  })

  // ---------- T2: I3 role_id 跨 team 拒绝 ----------
  test("T2: I3 createAgent with cross-team roleId returns 400 CROSS_TEAM_ROLE", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await agentSvc.createAgent(
      {
        teamId,
        name: "bad-role",
        engine: "openworker",
        roleId: otherTeamRoleId,
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.status, 400)
      assert.strictEqual(result.response.code, "CROSS_TEAM_ROLE")
    }
  })

  // ---------- T3: I5 skills 非法（含非字符串） ----------
  test("T3: I5 createAgent with non-string skills returns 400 INVALID_CONFIG_OBJECT_REF", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await agentSvc.createAgent(
      {
        teamId,
        name: "bad-skills",
        engine: "openworker",
        // 故意传入非字符串数组（运行时仍以 unknown 进入）
        skills: ["ok-id", 123 as unknown as string],
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.status, 400)
      assert.strictEqual(result.response.code, "INVALID_CONFIG_OBJECT_REF")
    }
  })

  // ---------- T4: I5 skills 空数组 + 合法字符串 OK ----------
  test("T4: createAgent with valid skills passes I5", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await agentSvc.createAgent(
      {
        teamId,
        name: "good-skills",
        engine: "openworker",
        skills: [validConfigObjectId],
        connectors: [],
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.deepStrictEqual(result.agent.skills, [validConfigObjectId])
      assert.deepStrictEqual(result.agent.connectors, [])
    }
  })

  // ---------- T5: I1 agent 自身 updateAgent 改 forbiddenActions → 403 ----------
  test("T5: I1 agent self-modify forbiddenActions returns 403 FORBIDDEN_ACTION_SELF_MODIFY", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await agentSvc.createAgent(
      {
        teamId,
        name: "self-modify",
        engine: "openworker",
        forbiddenActions: ["delete_file"],
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const agentId = created.agent.id

    // agent 自身尝试清空 forbiddenActions → 403
    const selfModify = await agentSvc.updateAgent(
      agentId,
      { forbiddenActions: [] },
      // actor.memberId 等于 agentId 模拟 agent 自身调用
      { memberId: agentId, role: "viewer" },
    )
    assert.strictEqual(selfModify.ok, false)
    if (!selfModify.ok) {
      assert.strictEqual(selfModify.status, 403)
      assert.strictEqual(selfModify.response.code, "FORBIDDEN_ACTION_SELF_MODIFY")
    }

    // owner 改 forbiddenActions → ok
    const ownerModify = await agentSvc.updateAgent(
      agentId,
      { forbiddenActions: ["delete_file", "drop_table"] },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(ownerModify.ok, true)
    if (ownerModify.ok) {
      assert.deepStrictEqual(ownerModify.agent.forbiddenActions, ["delete_file", "drop_table"])
    }
  })

  // ---------- T6: I2 assignTask 后 status=busy + current_task_id 非空 ----------
  test("T6: I2 assignTask sets status=busy + current_task_id", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await agentSvc.createAgent(
      {
        teamId,
        name: "assign-target",
        engine: "openworker",
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const agentId = created.agent.id

    const assigned = await agentSvc.assignTask(agentId, taskId, {
      memberId: memberOwner,
      role: "owner",
    })
    assert.strictEqual(assigned.ok, true)
    if (assigned.ok) {
      assert.strictEqual(assigned.agent.status, "busy")
      assert.strictEqual(assigned.agent.currentTaskId, taskId)
    }
  })

  // ---------- T7: I2 unassignTask 后 status=idle + current_task_id=null ----------
  test("T7: I2 unassignTask sets status=idle + clears current_task_id", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await agentSvc.createAgent(
      {
        teamId,
        name: "unassign-target",
        engine: "openworker",
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const agentId = created.agent.id

    await agentSvc.assignTask(agentId, taskId, { memberId: memberOwner, role: "owner" })

    const unassigned = await agentSvc.unassignTask(agentId, {
      memberId: memberOwner,
      role: "owner",
    })
    assert.strictEqual(unassigned.ok, true)
    if (unassigned.ok) {
      assert.strictEqual(unassigned.agent.status, "idle")
      assert.strictEqual(unassigned.agent.currentTaskId, null)
    }
  })

  // ---------- T8: I4 deleteAgent 有 current_task_id → 409 ----------
  test("T8: I4 deleteAgent with current_task_id returns 409 AGENT_HAS_TASK", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await agentSvc.createAgent(
      {
        teamId,
        name: "delete-with-task",
        engine: "openworker",
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const agentId = created.agent.id

    await agentSvc.assignTask(agentId, taskId, { memberId: memberOwner, role: "owner" })

    const del = await agentSvc.deleteAgent(agentId, {
      memberId: memberOwner,
      role: "owner",
    })
    assert.strictEqual(del.ok, false)
    if (!del.ok) {
      assert.strictEqual(del.status, 409)
      assert.strictEqual(del.response.code, "AGENT_HAS_TASK")
    }

    // unassign 后再删除 → ok
    await agentSvc.unassignTask(agentId, { memberId: memberOwner, role: "owner" })
    const delAfter = await agentSvc.deleteAgent(agentId, {
      memberId: memberOwner,
      role: "owner",
    })
    assert.strictEqual(delAfter.ok, true)
  })

  // ---------- T9: pauseAgent idle → paused ----------
  test("T9: pauseAgent idle → paused, paused → paused 409", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await agentSvc.createAgent(
      {
        teamId,
        name: "pause-target",
        engine: "openworker",
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const agentId = created.agent.id

    const paused = await agentSvc.pauseAgent(agentId, {
      memberId: memberOwner,
      role: "owner",
    })
    assert.strictEqual(paused.ok, true)
    if (paused.ok) assert.strictEqual(paused.agent.status, "paused")

    // 重复 pause → 409
    const pausedAgain = await agentSvc.pauseAgent(agentId, {
      memberId: memberOwner,
      role: "owner",
    })
    assert.strictEqual(pausedAgain.ok, false)
    if (!pausedAgain.ok) {
      assert.strictEqual(pausedAgain.status, 409)
      assert.strictEqual(pausedAgain.response.code, "INVALID_TRANSITION")
    }
  })

  // ---------- T10: resumeAgent paused → idle, idle → idle 409 ----------
  test("T10: resumeAgent paused → idle, idle → idle 409", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await agentSvc.createAgent(
      {
        teamId,
        name: "resume-target",
        engine: "openworker",
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const agentId = created.agent.id

    // idle → resume → 409 (不是 paused)
    const resumeFromIdle = await agentSvc.resumeAgent(agentId, {
      memberId: memberOwner,
      role: "owner",
    })
    assert.strictEqual(resumeFromIdle.ok, false)
    if (!resumeFromIdle.ok) {
      assert.strictEqual(resumeFromIdle.status, 409)
      assert.strictEqual(resumeFromIdle.response.code, "INVALID_TRANSITION")
    }

    await agentSvc.pauseAgent(agentId, { memberId: memberOwner, role: "owner" })
    const resumed = await agentSvc.resumeAgent(agentId, {
      memberId: memberOwner,
      role: "owner",
    })
    assert.strictEqual(resumed.ok, true)
    if (resumed.ok) assert.strictEqual(resumed.agent.status, "idle")
  })

  // ---------- T11: assignTask busy agent → 409（已被分配） ----------
  test("T11: assignTask on busy agent returns 409 AGENT_BUSY", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await agentSvc.createAgent(
      {
        teamId,
        name: "double-assign",
        engine: "openworker",
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const agentId = created.agent.id

    await agentSvc.assignTask(agentId, taskId, { memberId: memberOwner, role: "owner" })
    const secondAssign = await agentSvc.assignTask(agentId, taskId, {
      memberId: memberOwner,
      role: "owner",
    })
    assert.strictEqual(secondAssign.ok, false)
    if (!secondAssign.ok) {
      assert.strictEqual(secondAssign.status, 409)
      assert.strictEqual(secondAssign.response.code, "AGENT_BUSY")
    }
  })

  // ---------- T12: listByTeam + getById ----------
  test("T12: listByTeam returns only agents of the team", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const a = await agentSvc.createAgent(
      { teamId, name: "list-a", engine: "openworker" },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(a.ok, true)
    if (!a.ok) return

    const list = await agentSvc.listByTeam(teamId)
    const names = list.map((x) => x.name)
    assert.ok(names.includes("list-a"), `expected list-a in ${JSON.stringify(names)}`)

    const fetched = await agentSvc.getById(a.agent.id)
    assert.notStrictEqual(fetched, null)
    if (fetched) assert.strictEqual(fetched.id, a.agent.id)
  })

  // ---------- T13: checkForbiddenAction DB-backed（agent 存在） ----------
  test("T13: checkForbiddenAction hits forbidden_actions array", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await agentSvc.createAgent(
      {
        teamId,
        name: "forbidden-check",
        engine: "openworker",
        forbiddenActions: ["delete_file", "drop_table"],
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const agentId = created.agent.id

    const hit = await agentSvc.checkForbiddenAction(agentId, "delete_file")
    assert.strictEqual(hit.forbidden, true)
    assert.strictEqual(hit.action, "delete_file")
    assert.strictEqual(hit.exists, true)

    const miss = await agentSvc.checkForbiddenAction(agentId, "read_file")
    assert.strictEqual(miss.forbidden, false)
    assert.strictEqual(miss.exists, true)
  })

  // ---------- T14: checkForbiddenAction on non-existent agent ----------
  test("T14: checkForbiddenAction on missing agent → exists=false, forbidden=false", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 用合法 TypeID 格式（denTypeIdColumn.toDriver 会校验 suffix 长度）
    const missingAgentId = createDenTypeId("teamAgent")
    const result = await agentSvc.checkForbiddenAction(missingAgentId, "delete_file")
    assert.strictEqual(result.exists, false)
    assert.strictEqual(result.forbidden, false)
  })

  // ---------- T15: matchForbiddenAction 纯逻辑（含 glob） ----------
  test("T15: matchForbiddenAction pure logic — exact match", () => {
    // 精确匹配模式
    assert.strictEqual(
      agentSvc.matchForbiddenAction(["delete_file", "drop_table"], "delete_file"),
      true,
    )
    assert.strictEqual(
      agentSvc.matchForbiddenAction(["delete_file", "drop_table"], "read_file"),
      false,
    )
    assert.strictEqual(
      agentSvc.matchForbiddenAction([], "anything"),
      false,
    )
    assert.strictEqual(
      agentSvc.matchForbiddenAction(null, "anything"),
      false,
    )
  })

  test("T15b: matchForbiddenAction pure logic — glob mode", () => {
    // glob 模式：* → .*
    assert.strictEqual(
      agentSvc.matchForbiddenAction(["delete_*"], "delete_file", { glob: true }),
      true,
    )
    assert.strictEqual(
      agentSvc.matchForbiddenAction(["delete_*"], "delete_table", { glob: true }),
      true,
    )
    assert.strictEqual(
      agentSvc.matchForbiddenAction(["delete_*"], "read_file", { glob: true }),
      false,
    )
    // 不开 glob 时 * 当字面量
    assert.strictEqual(
      agentSvc.matchForbiddenAction(["delete_*"], "delete_file", { glob: false }),
      false,
    )
    assert.strictEqual(
      agentSvc.matchForbiddenAction(["delete_*"], "delete_*", { glob: false }),
      true,
    )
  })

  // ---------- T16: isValidStatusTransition 纯逻辑矩阵 ----------
  test("T16: isValidStatusTransition state machine matrix", () => {
    // idle → busy, paused, offline, error ✓
    assert.strictEqual(agentSvc.isValidStatusTransition("idle", "busy"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("idle", "paused"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("idle", "offline"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("idle", "error"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("idle", "idle"), false)

    // busy → idle, paused, offline, error ✓；busy → busy ✗
    assert.strictEqual(agentSvc.isValidStatusTransition("busy", "idle"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("busy", "paused"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("busy", "offline"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("busy", "error"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("busy", "busy"), false)

    // paused → idle, offline, error ✓；paused → busy ✗（必须先 resume）
    assert.strictEqual(agentSvc.isValidStatusTransition("paused", "idle"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("paused", "offline"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("paused", "error"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("paused", "busy"), false)
    assert.strictEqual(agentSvc.isValidStatusTransition("paused", "paused"), false)

    // offline → idle/busy/paused/offline/error（外部恢复入口，本 service 不直接转）
    // 简化：offline → idle ✓，offline → offline ✗
    assert.strictEqual(agentSvc.isValidStatusTransition("offline", "idle"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("offline", "offline"), false)

    // error → idle（恢复）✓；error → error ✗
    assert.strictEqual(agentSvc.isValidStatusTransition("error", "idle"), true)
    assert.strictEqual(agentSvc.isValidStatusTransition("error", "error"), false)
  })

  // ---------- T17: validateConfigObjectRefs 纯逻辑 ----------
  test("T17: validateConfigObjectRefs pure logic", () => {
    assert.strictEqual(agentSvc.validateConfigObjectRefs(null), true)
    assert.strictEqual(agentSvc.validateConfigObjectRefs(undefined), true)
    assert.strictEqual(agentSvc.validateConfigObjectRefs([]), true)
    assert.strictEqual(agentSvc.validateConfigObjectRefs(["cob_xxx"]), true)
    assert.strictEqual(agentSvc.validateConfigObjectRefs(["cob_a", "cob_b"]), true)
    assert.strictEqual(agentSvc.validateConfigObjectRefs(["ok", 123 as unknown as string]), false)
    assert.strictEqual(agentSvc.validateConfigObjectRefs(["ok", "" as string]), false)
    assert.strictEqual(agentSvc.validateConfigObjectRefs("not-an-array" as unknown as string[]), false)
    assert.strictEqual(agentSvc.validateConfigObjectRefs([null] as unknown as string[]), false)
  })

  // ---------- T18: viewer 无权 createAgent ----------
  test("T18: viewer createAgent returns 403 FORBIDDEN", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const result = await agentSvc.createAgent(
      { teamId, name: "viewer-attempt", engine: "openworker" },
      { memberId: memberViewer, role: "viewer" as TeamRole },
    )
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.status, 403)
      assert.strictEqual(result.response.code, "FORBIDDEN")
    }
  })
})
