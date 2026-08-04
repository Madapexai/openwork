// OpenSpecs HTTP Routes — RED/GREEN 端到端测试
// 框架：node:test + tsx + Hono app.request()（不启动真实 server）
//
// 测试策略：
// - 纯逻辑（T2/T3/T4/T5/T6/T9）：无 DB 依赖，mock user/orgContext，验证 401/403/400/404 + 错误映射
// - 集成（T7/T8）：需要 DB（dbAvailable guard，与 asset-service.test.ts 一致），DB 不可用自动 skip
//
// mock 中间件注入 user + organizationContext + memberTeams，
// resolveTeamContext 检测到 organizationContext 已设置时短路（不查 DB）。

import assert from "node:assert/strict"
import { after, before, describe, test, type TestContext } from "node:test"

import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_ta"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "ta-encryption-key-12345678901234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "ta-better-auth-secret-123456789012"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

// ---- 固定测试 ID ----
const organizationId = createDenTypeId("organization")
const teamId = createDenTypeId("team")
const memberIdAdmin = createDenTypeId("member")
const memberIdViewer = createDenTypeId("member")
const agentId = createDenTypeId("teamAgent")
const taskId = createDenTypeId("teamTask")
const boardId = createDenTypeId("teamBoard")
const artifactId = createDenTypeId("teamArtifact")
const automationId = createDenTypeId("teamAutomation")
const inboxId = createDenTypeId("teamInbox")
const ruleId = createDenTypeId("teamStandingRule")

// ---- 模拟 OrganizationContext ----
type MockOrgContext = {
  organization: { id: string; slug: string; name: string }
  currentMember: {
    id: string
    role: string
    isOwner: boolean
    userId: string
  }
}

function buildMockContext(role: string, isOwner: boolean, memberId: string): MockOrgContext {
  return {
    organization: { id: organizationId, slug: "ta-org", name: "TA Org" },
    currentMember: {
      id: memberId,
      role,
      isOwner,
      userId: "usr_test",
    },
  }
}

// ---- 测试 App 构建 ----
type RouteModule = typeof import("../../src/routes/team-autonomy/index.js")

let routes: RouteModule
let dbAvailable = false

type DbModule = typeof import("../../src/db.js")
type SchemaModule = typeof import("@openwork-ee/den-db/schema")
type DrizzleModule = typeof import("@openwork-ee/den-db/drizzle")

let db: DbModule["db"]
let schema: SchemaModule
let drizzle: DrizzleModule

before(async () => {
  seedRequiredEnv()

  // 动态 import — GREEN 阶段 index.ts 存在即可成功；RED 阶段 Module not found
  routes = await import("../../src/routes/team-autonomy/index.js")

  try {
    const mods = await Promise.all([
      import("../../src/db.js"),
      import("@openwork-ee/den-db/schema"),
      import("@openwork-ee/den-db/drizzle"),
    ])
    db = mods[0].db
    schema = mods[1]
    drizzle = mods[2]
    // 探测 DB 是否可用
    await db.execute(drizzle.sql`select 1`)
    dbAvailable = true
  } catch (error) {
    dbAvailable = false
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : ""
    console.warn(`\n[http-routes.test] DB not available — T7/T8 集成测试将 skip。Reason: ${message}\n${stack}\n`)
  }
})

after(async () => {
  if (!dbAvailable) return
  try {
    // 清理本测试写入的行（按 typeID 前缀）
    await db.delete(schema.TeamStandingRuleTable).where(drizzle.like(schema.TeamStandingRuleTable.id, "tsrl_%"))
    await db.delete(schema.TeamPermissionProfileTable).where(drizzle.like(schema.TeamPermissionProfileTable.id, "tppr_%"))
    await db.delete(schema.TeamInboxTable).where(drizzle.like(schema.TeamInboxTable.id, "tibx_%"))
    await db.delete(schema.TeamAutomationAlertTable).where(drizzle.like(schema.TeamAutomationAlertTable.id, "taal_%"))
    await db.delete(schema.TeamAutomationRunTable).where(drizzle.like(schema.TeamAutomationRunTable.id, "taur_%"))
    await db.delete(schema.TeamAutomationTable).where(drizzle.like(schema.TeamAutomationTable.id, "taut_%"))
    await db.delete(schema.TeamArtifactVersionTable).where(drizzle.like(schema.TeamArtifactVersionTable.id, "tarv_%"))
    await db.delete(schema.TeamArtifactTable).where(drizzle.like(schema.TeamArtifactTable.id, "tart_%"))
    await db.delete(schema.TeamTaskHandoffTable).where(drizzle.like(schema.TeamTaskHandoffTable.id, "tthd_%"))
    await db.delete(schema.TeamTaskTable).where(drizzle.like(schema.TeamTaskTable.id, "ttsk_%"))
    await db.delete(schema.TeamBoardTable).where(drizzle.like(schema.TeamBoardTable.id, "tbrd_%"))
    await db.delete(schema.TeamAgentTable).where(drizzle.like(schema.TeamAgentTable.id, "tagt_%"))
    await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, teamId))
    await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  } catch {
    // ignore cleanup errors
  }
})

// ---- DB 可用性运行时 guard ----
// 注意：`{ skip: !dbAvailable }` 静态选项在注册时求值（before 尚未运行），永远为 false，
// 必须用此包装器在测试运行时判断。
function maybeDb(fn: (t: TestContext) => Promise<void> | void) {
  return async (t: TestContext) => {
    if (!dbAvailable) return t.skip("db not available")
    return fn(t)
  }
}

// ---- 构建测试 Hono app ----
// 注入 mock user + organizationContext，让 resolveTeamContext 短路。
function buildTestApp(opts: {
  user?: { id: string; email: string } | null
  orgContext?: MockOrgContext | null
}) {
  const app = new Hono<any>()

  // mock sessionMiddleware：注入 user（或不注入 → 401）
  app.use("*", async (c: any, next: () => Promise<void>) => {
    if (opts.user) {
      c.set("user", { id: opts.user.id, email: opts.user.email })
      c.set("session", { id: "ses_test", activeOrganizationId: organizationId })
    }
    if (opts.orgContext) {
      c.set("organizationContext", opts.orgContext)
      c.set("memberTeams", [{ id: teamId, name: "TA Team", role: opts.orgContext.currentMember.role }])
    }
    await next()
  })

  // 注册 team-autonomy 路由
  routes.registerTeamAutonomyRoutes(app)

  app.notFound((c: any) => c.json({ error: "not_found" }, 404))
  return app
}

// ---- 辅助 ----
async function req(app: Hono<any>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers } }
  if (body !== undefined) init.body = JSON.stringify(body)
  return app.request(path, init)
}

async function jsonRes(res: Response) {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

// ---- DB seed helper ----
async function seedDbForHappyPath() {
  await db.delete(schema.TeamStandingRuleTable).where(drizzle.like(schema.TeamStandingRuleTable.id, "tsrl_%"))
  await db.delete(schema.TeamPermissionProfileTable).where(drizzle.like(schema.TeamPermissionProfileTable.id, "tppr_%"))
  await db.delete(schema.TeamInboxTable).where(drizzle.like(schema.TeamInboxTable.id, "tibx_%"))
  await db.delete(schema.TeamAutomationAlertTable).where(drizzle.like(schema.TeamAutomationAlertTable.id, "taal_%"))
  await db.delete(schema.TeamAutomationRunTable).where(drizzle.like(schema.TeamAutomationRunTable.id, "taur_%"))
  await db.delete(schema.TeamAutomationTable).where(drizzle.like(schema.TeamAutomationTable.id, "taut_%"))
  await db.delete(schema.TeamArtifactVersionTable).where(drizzle.like(schema.TeamArtifactVersionTable.id, "tarv_%"))
  await db.delete(schema.TeamArtifactTable).where(drizzle.like(schema.TeamArtifactTable.id, "tart_%"))
  await db.delete(schema.TeamTaskHandoffTable).where(drizzle.like(schema.TeamTaskHandoffTable.id, "tthd_%"))
  await db.delete(schema.TeamTaskTable).where(drizzle.like(schema.TeamTaskTable.id, "ttsk_%"))
  await db.delete(schema.TeamBoardTable).where(drizzle.like(schema.TeamBoardTable.id, "tbrd_%"))
  await db.delete(schema.TeamAgentTable).where(drizzle.like(schema.TeamAgentTable.id, "tagt_%"))

  // 确保 org + team 存在
  const orgRows = await db.select().from(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId)).limit(1)
  if (!orgRows[0]) {
    await db.insert(schema.OrganizationTable).values({
      id: organizationId,
      name: "TA Org",
      slug: `ta-${organizationId}`,
      desktopAppRestrictions: {},
    })
  }
  const teamRows = await db.select().from(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, teamId)).limit(1)
  if (!teamRows[0]) {
    await db.insert(schema.TeamTable).values({
      id: teamId,
      organizationId,
      name: "TA Team",
      slug: "ta-team",
      kind: "shared",
    })
  }
}

const adminApp = () => buildTestApp({
  user: { id: "usr_admin", email: "admin@test" },
  orgContext: buildMockContext("admin", false, memberIdAdmin),
})

// ============================================================
// 测试开始
// ============================================================

describe("HTTP Routes — team-autonomy (RED/GREEN, /api/teams/:teamId)", () => {

  // ---- T1: 模块可导入 ----
  test("T1: registerTeamAutonomyRoutes is importable and callable", () => {
    assert.equal(typeof routes.registerTeamAutonomyRoutes, "function")
  })

  // ---- T2: 未知路由 404 ----
  test("T2: unknown route → 404", async () => {
    const app = buildTestApp({ user: null, orgContext: null })
    const res = await req(app, "GET", "/api/teams/nonexistent-resource")
    assert.equal(res.status, 404)
    const body = await jsonRes(res)
    assert.equal(body.error, "not_found")
  })

  // ---- T3: 鉴权 401（7 组 route 各代表） ----
  test("T3: no user → 401 on agents list", async () => {
    const app = buildTestApp({ user: null, orgContext: null })
    const res = await req(app, "GET", `/api/teams/${teamId}/agents`)
    assert.equal(res.status, 401)
    const body = await jsonRes(res)
    assert.equal(body.error, "unauthorized")
  })

  test("T3b: no user → 401 on POST task", async () => {
    const app = buildTestApp({ user: null, orgContext: null })
    const res = await req(app, "POST", `/api/teams/${teamId}/tasks`, { title: "T", assignee: { type: "member", id: memberIdAdmin } })
    assert.equal(res.status, 401)
  })

  test("T3c: no user → 401 on inbox list", async () => {
    const app = buildTestApp({ user: null, orgContext: null })
    const res = await req(app, "GET", `/api/teams/${teamId}/inbox?assigneeType=member&assigneeId=${memberIdAdmin}`)
    assert.equal(res.status, 401)
  })

  // ---- T4: 权限 403（viewer 调 admin-only） ----
  test("T4: viewer → 403 on create agent (admin-only)", async () => {
    const app = buildTestApp({
      user: { id: "usr_viewer", email: "viewer@test" },
      orgContext: buildMockContext("member", false, memberIdViewer),
    })
    const res = await req(app, "POST", `/api/teams/${teamId}/agents`, { name: "Agent A", engine: "openworker" })
    assert.equal(res.status, 403)
    const body = await jsonRes(res)
    assert.equal(body.error, "forbidden")
  })

  test("T4b: viewer → 403 on create task (admin-only)", async () => {
    const app = buildTestApp({
      user: { id: "usr_viewer", email: "viewer@test" },
      orgContext: buildMockContext("member", false, memberIdViewer),
    })
    const res = await req(app, "POST", `/api/teams/${teamId}/tasks`, {
      title: "T",
      assignee: { type: "member", id: memberIdViewer },
    })
    assert.equal(res.status, 403)
  })

  test("T4c: viewer → 403 on set permission profile (admin-only)", async () => {
    const app = buildTestApp({
      user: { id: "usr_viewer", email: "viewer@test" },
      orgContext: buildMockContext("member", false, memberIdViewer),
    })
    const res = await req(app, "PUT", `/api/teams/${teamId}/permissions/profile`, {
      profile: "simple",
      defaultMode: "craft",
    })
    assert.equal(res.status, 403)
  })

  // ---- T5: 入参校验 400 ----
  test("T5: invalid body → 400 (missing agent name)", async () => {
    const app = adminApp()
    const res = await req(app, "POST", `/api/teams/${teamId}/agents`, { engine: "openworker" })
    assert.equal(res.status, 400)
    const body = await jsonRes(res)
    assert.equal(body.error, "invalid_request")
    assert.ok(body.details, "should have details array")
  })

  // ---- T6: 非法 typeID 路径参数 400 ----
  test("T6: invalid typeID path param → 400", async () => {
    const app = adminApp()
    const res = await req(app, "GET", "/api/teams/not-a-valid-typeid/agents")
    assert.equal(res.status, 400)
  })

  // ---- T9: 错误映射纯逻辑（无 DB） ----
  test("T9: serviceErrorToResponse maps {ok:false,status,response} → {error:{...}} + status", async () => {
    const mod = await import("../../src/routes/team-autonomy/shared.js")
    // serviceErrorToResponse 返回原生 Response
    const res = mod.serviceErrorToResponse({
      ok: false,
      status: 409,
      response: { code: "INVALID_TRANSITION", from: "draft", to: "confirmed" },
    })
    assert.equal(res.status, 409)
    const body = JSON.parse(await res.text())
    assert.equal(body.error.code, "INVALID_TRANSITION")
    assert.equal(body.error.from, "draft")
  })

  test("T9b: jsonServiceError maps via c.json with status", async () => {
    const mod = await import("../../src/routes/team-autonomy/shared.js")
    let captured: { body: unknown; status?: number } | null = null
    const fakeC = { json: (body: unknown, status?: number) => { captured = { body, status }; return new Response("") } }
    const res = mod.jsonServiceError(fakeC, {
      ok: false,
      status: 403,
      response: { code: "FORBIDDEN_CONFIRMER" },
    })
    assert.ok(res)
    assert.equal(captured!.status, 403)
    assert.equal((captured!.body as any).error.code, "FORBIDDEN_CONFIRMER")
  })

  // ---- T7: happy path 200（DB 可用时，7 组 route） ----
  test("T7a: GET agents → 200 { agents: [] }", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/agents`)
    assert.equal(res.status, 200)
    const body = await jsonRes(res)
    assert.ok(Array.isArray(body.agents))
  }))

  test("T7b: GET tasks → 200 { tasks: [] }", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/tasks`)
    assert.equal(res.status, 200)
    const body = await jsonRes(res)
    assert.ok(Array.isArray(body.tasks))
  }))

  test("T7c: GET boards → 200 { boards: [] }", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/boards`)
    assert.equal(res.status, 200)
    const body = await jsonRes(res)
    assert.ok(Array.isArray(body.boards))
  }))

  test("T7d: GET artifacts → 200 { artifacts: [] }", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/artifacts`)
    assert.equal(res.status, 200)
    const body = await jsonRes(res)
    assert.ok(Array.isArray(body.artifacts))
  }))

  test("T7e: GET automations → 200 { automations: [] }", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/automations`)
    assert.equal(res.status, 200)
    const body = await jsonRes(res)
    assert.ok(Array.isArray(body.automations))
  }))

  test("T7f: GET inbox → 200 { entries: [] }", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/inbox?assigneeType=member&assigneeId=${memberIdAdmin}`)
    assert.equal(res.status, 200)
    const body = await jsonRes(res)
    assert.ok(Array.isArray(body.entries))
  }))

  test("T7g: GET permissions/profile → 200 { profile: null|object }", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/permissions/profile`)
    assert.equal(res.status, 200)
    const body = await jsonRes(res)
    assert.ok(body.profile === null || typeof body.profile === "object")
  }))

  // ---- T8: 不存在资源 404（DB 可用时） ----
  test("T8a: GET non-existent agent → 404", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/agents/${agentId}`)
    assert.equal(res.status, 404)
  }))

  test("T8b: GET non-existent task → 404", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/tasks/${taskId}`)
    assert.equal(res.status, 404)
  }))

  test("T8c: GET non-existent board → 404", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/boards/${boardId}`)
    assert.equal(res.status, 404)
  }))

  test("T8d: GET non-existent artifact → 404", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/artifacts/${artifactId}`)
    assert.equal(res.status, 404)
  }))

  test("T8e: GET non-existent automation → 404", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/automations/${automationId}`)
    assert.equal(res.status, 404)
  }))

  test("T8f: GET non-existent inbox entry → 404", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "GET", `/api/teams/${teamId}/inbox/${inboxId}`)
    assert.equal(res.status, 404)
  }))

  test("T8g: revoke non-existent standing rule → 404", maybeDb(async () => {
    await seedDbForHappyPath()
    const res = await req(adminApp(), "POST", `/api/teams/${teamId}/permissions/rules/${ruleId}/revoke`)
    assert.equal(res.status, 404)
  }))
})
