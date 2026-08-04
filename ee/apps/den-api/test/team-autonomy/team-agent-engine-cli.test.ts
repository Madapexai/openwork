import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDenTypeId } from "@openwork-ee/utils/typeid"

// OpenSpecs TeamAgentEngine "cli" + engine_config — RED/GREEN 测试
// 框架：node:test + tsx
// 纯逻辑测试（T1-T11: validateEngineConfig）无需 DB；
// DB 测试（T12-T17: createAgent/updateAgent）用 dbAvailable guard 跳过。
// RED 阶段（模块不存在 / engine 无 'cli' / 无 validateEngineConfig 导出）：
//   moduleLoaded=false → 纯逻辑测试 skip，证明功能缺失。

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
const memberOwner = createDenTypeId("member")

type DbModule = typeof import("../../src/db.js")
type DrizzleModule = typeof import("@openwork-ee/den-db/drizzle")
type SchemaModule = typeof import("@openwork-ee/den-db/schema")
type AgentModule = typeof import("../../src/team-autonomy/team-agent-service.js")

let db: DbModule["db"]
let drizzle: DrizzleModule
let schema: SchemaModule
let agentSvc: AgentModule | null = null
let moduleLoaded = false
let dbAvailable = false

async function clearAll() {
  await db.delete(schema.TeamAgentTable).where(drizzle.like(schema.TeamAgentTable.id, "tagt_%"))
  await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, teamId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
}

before(async () => {
  seedRequiredEnv()

  try {
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
    moduleLoaded = true
  } catch (error) {
    moduleLoaded = false
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`\n[team-agent-engine-cli.test] service module not loaded (RED phase?) — logic tests will skip. Reason: ${message}\n`)
    return
  }

  try {
    await clearAll()
    await db.insert(schema.OrganizationTable).values({
      id: organizationId,
      name: "TA CLI Org",
      slug: `ta-cli-${organizationId}`,
      desktopAppRestrictions: {},
    })
    await db.insert(schema.TeamTable).values({
      id: teamId,
      organizationId,
      name: "TA CLI Team",
      slug: "ta-cli-team",
      kind: "shared",
    })
    dbAvailable = true
  } catch (error) {
    dbAvailable = false
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`\n[team-agent-engine-cli.test] DB not available — DB tests will skip. Reason: ${message}\n`)
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

describe("TeamAgentEngine cli + engine_config — OpenSpecs RED/GREEN", () => {
  // ---------- 纯逻辑：validateEngineConfig（T1-T11） ----------
  test("T1: validateEngineConfig('cli', undefined) → false (I1: cli 必须 binary)", () => {
    if (!agentSvc) return tSkip()
    assert.strictEqual(agentSvc.validateEngineConfig("cli", undefined), false)
  })

  test("T2: validateEngineConfig('cli', {}) → false (I1)", () => {
    if (!agentSvc) return tSkip()
    assert.strictEqual(agentSvc.validateEngineConfig("cli", {}), false)
  })

  test("T3: validateEngineConfig('cli', { binary: 'claude' }) → false (I2: cli 缺 protocol)", () => {
    if (!agentSvc) return tSkip()
    assert.strictEqual(agentSvc.validateEngineConfig("cli", { binary: "claude" }), false)
  })

  test("T4: validateEngineConfig('cli', { binary, protocol: 'serial' }) → false (I2: 非法 protocol)", () => {
    if (!agentSvc) return tSkip()
    assert.strictEqual(agentSvc.validateEngineConfig("cli", { binary: "claude", protocol: "serial" }), false)
  })

  test("T5: validateEngineConfig('cli', { binary, protocol: 'jsonrpc' }) → true (合法)", () => {
    if (!agentSvc) return tSkip()
    assert.strictEqual(agentSvc.validateEngineConfig("cli", { binary: "claude", protocol: "jsonrpc" }), true)
  })

  test("T6: validateEngineConfig('cli', { binary: '', protocol: 'pty' }) → false (I1: 空 binary)", () => {
    if (!agentSvc) return tSkip()
    assert.strictEqual(agentSvc.validateEngineConfig("cli", { binary: "", protocol: "pty" }), false)
  })

  test("T7: validateEngineConfig('opencode', undefined) → true (非 cli 可空, I1)", () => {
    if (!agentSvc) return tSkip()
    assert.strictEqual(agentSvc.validateEngineConfig("opencode", undefined), true)
  })

  test("T8: validateEngineConfig('opencode', null) → true (I1)", () => {
    if (!agentSvc) return tSkip()
    assert.strictEqual(agentSvc.validateEngineConfig("opencode", null), true)
  })

  test("T9: validateEngineConfig('openworker', { protocol: 'pty' }) → true (非 cli 带合法 protocol)", () => {
    if (!agentSvc) return tSkip()
    assert.strictEqual(agentSvc.validateEngineConfig("openworker", { protocol: "pty" }), true)
  })

  test("T10: validateEngineConfig('openworker', { protocol: 'nope' }) → false (I2 对任意 engine 生效)", () => {
    if (!agentSvc) return tSkip()
    assert.strictEqual(agentSvc.validateEngineConfig("openworker", { protocol: "nope" }), false)
  })

  test("T11: validateEngineConfig('cli', { binary, protocol, args: 'not-array' }) → false (可选字段类型约束)", () => {
    if (!agentSvc) return tSkip()
    assert.strictEqual(
      agentSvc.validateEngineConfig("cli", { binary: "claude", protocol: "pty", args: "not-array" }),
      false,
    )
  })

  // ---------- DB 集成：createAgent / updateAgent（T12-T17） ----------
  test("T12: createAgent engine='cli' + engineConfig → ok 且回读一致", async (t) => {
    if (!dbAvailable || !agentSvc) return t.skip("DB not available")
    const config = {
      binary: "claude",
      args: ["-p"],
      protocol: "jsonrpc",
      cwd: "/tmp",
      env: { HOME: "/tmp" },
      supported: ["task", "tool"],
    }
    const result = await agentSvc.createAgent(
      { teamId, name: "cli-agent", engine: "cli", engineConfig: config },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.agent.engine, "cli")
      assert.deepStrictEqual(result.agent.engineConfig, config)
    }
  })

  test("T13: createAgent engine='cli' 无 engineConfig → 400 INVALID_ENGINE_CONFIG", async (t) => {
    if (!dbAvailable || !agentSvc) return t.skip("DB not available")
    const result = await agentSvc.createAgent(
      { teamId, name: "cli-no-config", engine: "cli" },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.status, 400)
      assert.strictEqual(result.response.code, "INVALID_ENGINE_CONFIG")
    }
  })

  test("T14: createAgent engine='cli' 非法 protocol → 400 INVALID_ENGINE_CONFIG", async (t) => {
    if (!dbAvailable || !agentSvc) return t.skip("DB not available")
    const result = await agentSvc.createAgent(
      {
        teamId,
        name: "cli-bad-protocol",
        engine: "cli",
        engineConfig: { binary: "x", protocol: "serial" as never },
      },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(result.ok, false)
    if (!result.ok) {
      assert.strictEqual(result.status, 400)
      assert.strictEqual(result.response.code, "INVALID_ENGINE_CONFIG")
    }
  })

  test("T15: createAgent engine='opencode' 无 engineConfig → ok, engineConfig=null", async (t) => {
    if (!dbAvailable || !agentSvc) return t.skip("DB not available")
    const result = await agentSvc.createAgent(
      { teamId, name: "opencode-agent", engine: "opencode" },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.agent.engineConfig, null)
    }
  })

  test("T16: createAgent engine='openworker' → ok（存量 engine 不受影响, I4）", async (t) => {
    if (!dbAvailable || !agentSvc) return t.skip("DB not available")
    const result = await agentSvc.createAgent(
      { teamId, name: "ow-agent", engine: "openworker" },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.agent.engine, "openworker")
    }
  })

  test("T17: updateAgent 改 engineConfig ok 回读一致；非法 engineConfig → 400", async (t) => {
    if (!dbAvailable || !agentSvc) return t.skip("DB not available")
    const created = await agentSvc.createAgent(
      { teamId, name: "cli-update", engine: "cli", engineConfig: { binary: "atomcode", protocol: "pty" } },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const agentId = created.agent.id

    const good = await agentSvc.updateAgent(
      agentId,
      { engineConfig: { binary: "freebuff", protocol: "headless", args: ["--headless"] } },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(good.ok, true)
    if (good.ok) {
      assert.deepStrictEqual(good.agent.engineConfig, { binary: "freebuff", protocol: "headless", args: ["--headless"] })
    }

    const bad = await agentSvc.updateAgent(
      agentId,
      { engineConfig: { binary: "" } },
      { memberId: memberOwner, role: "owner" },
    )
    assert.strictEqual(bad.ok, false)
    if (!bad.ok) {
      assert.strictEqual(bad.status, 400)
      assert.strictEqual(bad.response.code, "INVALID_ENGINE_CONFIG")
    }
  })
})

// 若 agentSvc 未加载（RED 阶段），测试无法断言 → 抛"模块未加载"以体现 RED
function tSkip(): never {
  throw new Error("service module not loaded — RED phase: validateEngineConfig 不存在")
}
