import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDenTypeId } from "@openwork-ee/utils/typeid"

// OpenSpecs SkillValidationService — RED/GREEN 测试
// 框架：node:test + tsx（任务要求）
// 纯逻辑测试（bait/execution 判定 / 三重验证门禁）无需 DB；
// DB 集成测试用 dbAvailable guard 跳过（CI 无 DB 时只跑纯逻辑）。
// executor 用可注入接口，测试用 mock。

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_ta"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "ta-encryption-key-12345678901234567890"
  const existingSecret = process.env.BETTER_AUTH_SECRET
  if (!existingSecret || existingSecret.length < 32) {
    process.env.BETTER_AUTH_SECRET = "svs-better-auth-secret-1234567890123456789012"
  }
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

const organizationId = createDenTypeId("organization")
const teamId = createDenTypeId("team")
const memberOwner = createDenTypeId("member")
// 用合法的 configObject typeids 模拟 skill
const skillA = createDenTypeId("configObject")
const skillB = createDenTypeId("configObject")
// 404 场景：合法 typeid 但 DB 中不存在的记录
const missingValidationId = createDenTypeId("skillValidation")
const missingTestCaseId = createDenTypeId("skillTestCase")

type DbModule = typeof import("../../src/db.js")
type DrizzleModule = typeof import("@openwork-ee/den-db/drizzle")
type SchemaModule = typeof import("@openwork-ee/den-db/schema")
type SvsModule = typeof import("../../src/team-autonomy/skill-validation-service.js")

let db: DbModule["db"]
let drizzle: DrizzleModule
let schema: SchemaModule
let svs: SvsModule
let dbAvailable = false

async function clearAll() {
  await db.delete(schema.SkillLinkTable).where(drizzle.like(schema.SkillLinkTable.id, "slnk_%"))
  await db.delete(schema.SkillTestCaseTable).where(drizzle.like(schema.SkillTestCaseTable.id, "stst_%"))
  await db.delete(schema.SkillValidationTable).where(drizzle.like(schema.SkillValidationTable.id, "svld_%"))
  await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, teamId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
}

before(async () => {
  seedRequiredEnv()

  const mods = await Promise.all([
    import("../../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema"),
    import("../../src/team-autonomy/skill-validation-service.js"),
  ])
  db = mods[0].db
  drizzle = mods[1]
  schema = mods[2]
  svs = mods[3]

  try {
    await clearAll()
    await db.insert(schema.OrganizationTable).values({
      id: organizationId,
      name: "SVS Org",
      slug: `svs-${organizationId}`,
      desktopAppRestrictions: {},
    })
    await db.insert(schema.TeamTable).values({
      id: teamId,
      organizationId,
      name: "SVS Team",
      slug: `svs-team`,
      kind: "shared",
    })
    dbAvailable = true
  } catch (error) {
    dbAvailable = false
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`\n[skill-validation-service.test] DB not available — DB tests will skip. Reason: ${message}\n`)
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

// ============================================================
// Mock SkillTestExecutor — 用于 runTestCase
// ============================================================

function makeMockExecutor(result: { output: string; activated: boolean }): svs.SkillTestExecutor {
  return {
    async run() {
      return { ...result }
    },
  }
}

// ============================================================
// 工具：为 skill 完整跑通三重验证（create → start → complete）
// ============================================================

async function completeTripleValidation(
  configObjectId: string,
  opts: { evidenceOverride?: Record<string, unknown> } = {},
): Promise<{ ok: boolean; overall?: svs.TripleValidationSummary }> {
  const types = ["cross_domain", "predictive_power", "uniqueness"] as const
  const ids: string[] = []
  for (const t of types) {
    const c = await svs.createValidation({ teamId, configObjectId, validationType: t })
    if (!c.ok) return { ok: false }
    ids.push(c.validation.id)
    const s = await svs.startValidation(c.validation.id)
    if (!s.ok) return { ok: false }
  }

  const evidenceByType: Record<string, Record<string, unknown>> = {
    cross_domain: { domains: ["domain-a", "domain-b"] },
    predictive_power: { derivations: ["derivation-1"] },
    uniqueness: { contrastsWith: [skillB] },
  }
  if (opts.evidenceOverride) {
    for (const [t, ev] of Object.entries(opts.evidenceOverride)) {
      evidenceByType[t] = ev
    }
  }

  let lastOverall: svs.TripleValidationSummary | undefined
  for (let i = 0; i < ids.length; i++) {
    const r = await svs.completeValidation(ids[i], {
      evidence: evidenceByType[types[i]],
      reviewer: { memberId: memberOwner },
    })
    if (!r.ok) return { ok: false }
    lastOverall = r.overall
  }
  return { ok: true, overall: lastOverall }
}

describe("SkillValidationService — OpenSpecs RED/GREEN", () => {

  // ============================================================
  // 纯逻辑测试（无 DB 依赖）
  // ============================================================

  // ---------- I1: isBaitPassed ----------
  describe("pure logic: isBaitPassed (I1)", () => {
    test("T-I1-a: activated=false → passed=true（忍住不激活才算通过）", () => {
      assert.strictEqual(svs.isBaitPassed({ activated: false }), true)
    })

    test("T-I1-b: activated=true → passed=false（激活了即失败）", () => {
      assert.strictEqual(svs.isBaitPassed({ activated: true }), false)
    })
  })

  // ---------- I2: isExecutionPassed ----------
  describe("pure logic: isExecutionPassed (I2)", () => {
    test("T-I2-a: '1. 安装\\n2. 配置' → passed=true（含编号步骤）", () => {
      assert.strictEqual(svs.isExecutionPassed({ output: "1. 安装\n2. 配置" }), true)
    })

    test("T-I2-b: '好的' → passed=false（无步骤）", () => {
      assert.strictEqual(svs.isExecutionPassed({ output: "好的" }), false)
    })

    test("T-I2-c: 'Step 1: foo\\nStep 2: bar' → passed=true（英文 Step N）", () => {
      assert.strictEqual(svs.isExecutionPassed({ output: "Step 1: foo\nStep 2: bar" }), true)
    })

    test("T-I2-d: 代码块 → passed=true", () => {
      assert.strictEqual(
        svs.isExecutionPassed({ output: "```js\nconsole.log('hi')\n```" }),
        true,
      )
    })

    test("T-I2-e: '步骤 1 安装' → passed=true（中文 步骤 N）", () => {
      assert.strictEqual(svs.isExecutionPassed({ output: "步骤 1 安装" }), true)
    })

    test("T-I2-f: '- 安装依赖\\n- 配置环境' → passed=true（动作动词列表）", () => {
      assert.strictEqual(svs.isExecutionPassed({ output: "- 安装依赖\n- 配置环境" }), true)
    })

    test("T-I2-g: '1、安装\\n2、配置' → passed=true（中文编号 1、）", () => {
      assert.strictEqual(svs.isExecutionPassed({ output: "1、安装\n2、配置" }), true)
    })

    test("T-I2-h: 空字符串 → passed=false", () => {
      assert.strictEqual(svs.isExecutionPassed({ output: "" }), false)
    })

    test("T-I2-i: 纯叙述无步骤 → passed=false", () => {
      assert.strictEqual(
        svs.isExecutionPassed({ output: "这是一个很好的 skill，可以用于多种场景" }),
        false,
      )
    })
  })

  // ---------- judgeTestCase 统一判定分发 ----------
  describe("pure logic: judgeTestCase (I1 + I2 分发)", () => {
    test("T-judge-tc-bait: bait + activated=false → true", () => {
      assert.strictEqual(
        svs.judgeTestCase("bait", { activated: false, output: "我不应该激活" }),
        true,
      )
    })

    test("T-judge-tc-bait-fail: bait + activated=true → false", () => {
      assert.strictEqual(
        svs.judgeTestCase("bait", { activated: true, output: "调用了 skill X" }),
        false,
      )
    })

    test("T-judge-tc-exec: execution + 含步骤 → true", () => {
      assert.strictEqual(
        svs.judgeTestCase("execution", { activated: true, output: "1. 安装\n2. 配置" }),
        true,
      )
    })

    test("T-judge-tc-exec-fail: execution + 无步骤 → false", () => {
      assert.strictEqual(
        svs.judgeTestCase("execution", { activated: true, output: "好的" }),
        false,
      )
    })
  })

  // ---------- 三重验证判定函数 ----------
  describe("pure logic: judgeCrossDomain", () => {
    test("T-judge-cross: domains.length>=2 → passed", () => {
      const r = svs.judgeCrossDomain({ domains: ["a", "b"] })
      assert.strictEqual(r.passed, true)
      assert.match(r.reason, /2 domains/)
    })

    test("T-judge-cross-fail: domains.length=1 → failed", () => {
      const r = svs.judgeCrossDomain({ domains: ["a"] })
      assert.strictEqual(r.passed, false)
      assert.match(r.reason, /need >= 2/)
    })

    test("T-judge-cross-empty: domains=[] → failed", () => {
      const r = svs.judgeCrossDomain({ domains: [] })
      assert.strictEqual(r.passed, false)
    })
  })

  describe("pure logic: judgePredictivePower", () => {
    test("T-judge-pred: derivations.length>=1 → passed", () => {
      const r = svs.judgePredictivePower({ derivations: ["x"] })
      assert.strictEqual(r.passed, true)
      assert.match(r.reason, /1 novel/)
    })

    test("T-judge-pred-fail: derivations=[] → failed", () => {
      const r = svs.judgePredictivePower({ derivations: [] })
      assert.strictEqual(r.passed, false)
      assert.match(r.reason, /0 novel/)
    })
  })

  describe("pure logic: judgeUniqueness", () => {
    test("T-judge-uni: contrastsWith.length>=1 → passed", () => {
      const r = svs.judgeUniqueness({ contrastsWith: ["y"] })
      assert.strictEqual(r.passed, true)
      assert.match(r.reason, /1 similar/)
    })

    test("T-judge-uni-fail: contrastsWith=[] → failed", () => {
      const r = svs.judgeUniqueness({ contrastsWith: [] })
      assert.strictEqual(r.passed, false)
      assert.match(r.reason, /0 contrast/)
    })
  })

  // ---------- I3 + I4: isTripleValidationPassed ----------
  describe("pure logic: isTripleValidationPassed (I3 + I4)", () => {
    const threePassed = [
      { type: "cross_domain" as const, status: "passed" as const, reviewedBy: "om_1" },
      { type: "predictive_power" as const, status: "passed" as const, reviewedBy: "om_2" },
      { type: "uniqueness" as const, status: "passed" as const, reviewedBy: "om_3" },
    ]

    test("T-triple-pass: 3 类全 passed + reviewedBy 非空 → { passed: true }", () => {
      const r = svs.isTripleValidationPassed(threePassed)
      assert.strictEqual(r.passed, true)
      assert.deepEqual(r.failures, [])
    })

    test("T-triple-missing: 缺 uniqueness → { passed: false, failures 含 uniqueness }", () => {
      const r = svs.isTripleValidationPassed(threePassed.slice(0, 2))
      assert.strictEqual(r.passed, false)
      assert.ok(r.failures.some((f) => f.issue === "missing" && f.type === "uniqueness"))
    })

    test("T-triple-reviewer-missing: 全 passed 但某条 reviewedBy 为空 → { passed: false }（I4）", () => {
      const r = svs.isTripleValidationPassed([
        { type: "cross_domain", status: "passed", reviewedBy: "om_1" },
        { type: "predictive_power", status: "passed", reviewedBy: null },
        { type: "uniqueness", status: "passed", reviewedBy: "om_3" },
      ])
      assert.strictEqual(r.passed, false)
      assert.ok(r.failures.some((f) => f.issue === "missing_reviewer" && f.type === "predictive_power"))
    })

    test("T-triple-not-passed: 某条 failed → { passed: false, failures 含 not_passed }", () => {
      const r = svs.isTripleValidationPassed([
        { type: "cross_domain", status: "passed", reviewedBy: "om_1" },
        { type: "predictive_power", status: "failed", reviewedBy: "om_2" },
        { type: "uniqueness", status: "passed", reviewedBy: "om_3" },
      ])
      assert.strictEqual(r.passed, false)
      assert.ok(r.failures.some((f) => f.issue === "not_passed" && f.type === "predictive_power"))
    })

    test("T-triple-empty: 空数组 → { passed: false, failures 含全部 3 类 }", () => {
      const r = svs.isTripleValidationPassed([])
      assert.strictEqual(r.passed, false)
      assert.strictEqual(r.failures.filter((f) => f.issue === "missing").length, 3)
    })
  })

  // ============================================================
  // DB 集成测试（dbAvailable guard）— executor 用 mock
  // ============================================================

  // ---------- createValidation / startValidation ----------
  test("T-create-validation: createValidation(cross_domain) → status=pending", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await svs.createValidation({
      teamId,
      configObjectId: skillA,
      validationType: "cross_domain",
    })
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.validation.status, "pending")
      assert.strictEqual(r.validation.validationType, "cross_domain")
      assert.strictEqual(r.validation.configObjectId, skillA)
    }
  })

  test("T-start-validation: startValidation → status=in_progress", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await svs.createValidation({
      teamId,
      configObjectId: skillA,
      validationType: "cross_domain",
    })
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    const r = await svs.startValidation(created.validation.id)
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.validation.status, "in_progress")
    }
  })

  test("T-start-validation-404: startValidation(unknown) → 404", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await svs.startValidation(missingValidationId)
    assert.strictEqual(r.ok, false)
    if (!r.ok) {
      assert.strictEqual(r.status, 404)
      assert.strictEqual(r.response.code, "NOT_FOUND")
    }
  })

  // ---------- completeValidation（I3 + I4） ----------
  test("T-complete-reviewer-required: completeValidation 缺 reviewer → 400 REVIEWER_REQUIRED (I4)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await svs.createValidation({
      teamId,
      configObjectId: skillA,
      validationType: "cross_domain",
    })
    assert.strictEqual(created.ok, true)
    if (!created.ok) return
    // 缺 reviewer（undefined）
    const r = await svs.completeValidation(created.validation.id, {
      evidence: { domains: ["a", "b"] },
      reviewer: undefined as unknown as { memberId: string },
    })
    assert.strictEqual(r.ok, false)
    if (!r.ok) {
      assert.strictEqual(r.status, 400)
      assert.strictEqual(r.response.code, "REVIEWER_REQUIRED")
    }
  })

  test("T-complete-single-fail: 单条判定 failed → status=failed", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await svs.createValidation({
      teamId,
      configObjectId: skillA,
      validationType: "cross_domain",
    })
    if (!created.ok) return
    // 只有 1 个 domain → 跨域判定 failed
    const r = await svs.completeValidation(created.validation.id, {
      evidence: { domains: ["d1"] },
      reviewer: { memberId: memberOwner },
    })
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.validation.status, "failed")
      assert.strictEqual(r.overall.tripleValidation, "failed")
    }
  })

  test("T-complete-404: completeValidation(unknown) → 404", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await svs.completeValidation(missingValidationId, {
      evidence: {},
      reviewer: { memberId: memberOwner },
    })
    assert.strictEqual(r.ok, false)
    if (!r.ok) {
      assert.strictEqual(r.status, 404)
      assert.strictEqual(r.response.code, "NOT_FOUND")
    }
  })

  test("T-complete-gate-not-met: 只完成 2 类 → overall.tripleValidation=failed, failures 含 missing uniqueness (I3)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const freshSkill = createDenTypeId("configObject")
    // 只创建 + 完成 cross_domain + predictive_power（无 uniqueness 记录）
    for (const vtype of ["cross_domain", "predictive_power"] as const) {
      const c = await svs.createValidation({ teamId, configObjectId: freshSkill, validationType: vtype })
      if (!c.ok) return t.skip("create failed")
      await svs.startValidation(c.validation.id)
    }
    const pred = await svs.completeValidation(
      (await svs.listValidations(freshSkill, teamId)).find((v) => v.validationType === "predictive_power")!.id,
      {
        evidence: { derivations: ["q1"] },
        reviewer: { memberId: memberOwner },
      },
    )
    assert.strictEqual(pred.ok, true)
    if (pred.ok) {
      assert.strictEqual(pred.overall.tripleValidation, "failed")
      assert.ok(
        pred.overall.failures.some((f) => f.issue === "missing" && f.type === "uniqueness"),
        `expected missing uniqueness in ${JSON.stringify(pred.overall.failures)}`,
      )
    }
  })

  test("T-complete-e2e-pass: 三条全 passed + reviewer → overall.tripleValidation=passed (I3)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const freshSkill = createDenTypeId("configObject")
    const r = await completeTripleValidation(freshSkill)
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.overall?.tripleValidation, "passed")

    // 每条记录都应有 reviewed_by + reviewed_at（I4）
    const rows = await svs.listValidations(freshSkill, teamId)
    assert.strictEqual(rows.length, 3)
    for (const v of rows) {
      assert.strictEqual(v.status, "passed")
      assert.notStrictEqual(v.reviewedBy, null, "reviewed_by must be set on passed (I4)")
      assert.notStrictEqual(v.reviewedAt, null)
    }
  })

  // ---------- createTestCase / runTestCase（I1 + I2 + 评分） ----------
  test("T-create-tc: createTestCase → status=pending, darwinScore=0", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await svs.createTestCase({
      teamId,
      configObjectId: skillA,
      kind: "bait",
      input: "闲聊打招呼",
      expectedBehavior: "不应激活该 skill",
    })
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.testCase.status, "pending")
      assert.strictEqual(r.testCase.darwinScore, 0)
      assert.strictEqual(r.testCase.actualBehavior, null)
    }
  })

  test("T-create-tc-empty-input: createTestCase with empty input → 400", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await svs.createTestCase({
      teamId,
      configObjectId: skillA,
      kind: "bait",
      input: "",
      expectedBehavior: "y",
    })
    assert.strictEqual(r.ok, false)
    if (!r.ok) {
      assert.strictEqual(r.status, 400)
    }
  })

  test("T-run-bait-pass: runTestCase(bait) activated=false → passed (I1), darwin_score +1", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await svs.createTestCase({
      teamId,
      configObjectId: skillA,
      kind: "bait",
      input: "闲聊打招呼",
      expectedBehavior: "不应激活该 skill",
    })
    assert.strictEqual(created.ok, true)
    if (!created.ok) return

    const r = await svs.runTestCase(created.testCase.id, makeMockExecutor({ output: "好的，我没有激活", activated: false }))
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.passed, true, "bait with activated=false must pass (I1)")
      assert.strictEqual(r.testCase.status, "passed")
      assert.strictEqual(r.testCase.darwinScore, 1, "darwin_score should +1 on pass")
      assert.notStrictEqual(r.testCase.lastRunAt, null)
    }
  })

  test("T-run-bait-fail: runTestCase(bait) activated=true → failed (I1), darwin_score -2", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await svs.createTestCase({
      teamId,
      configObjectId: skillA,
      kind: "bait",
      input: "闲聊打招呼",
      expectedBehavior: "不应激活该 skill",
    })
    if (!created.ok) return

    const r = await svs.runTestCase(created.testCase.id, makeMockExecutor({ output: "调用了 skill X", activated: true }))
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.passed, false, "bait with activated=true must fail (I1)")
      assert.strictEqual(r.testCase.status, "failed")
      assert.strictEqual(r.testCase.darwinScore, -2, "darwin_score should -2 on fail")
    }
  })

  test("T-run-exec-pass: runTestCase(execution) with steps → passed (I2), darwin_score +1", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await svs.createTestCase({
      teamId,
      configObjectId: skillA,
      kind: "execution",
      input: "部署这个 API",
      expectedBehavior: "输出可落地步骤",
    })
    if (!created.ok) return

    const r = await svs.runTestCase(created.testCase.id, makeMockExecutor({ output: "1. 安装依赖\n2. 配置环境\n3. 启动服务", activated: true }))
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.passed, true, "execution with steps must pass (I2)")
      assert.strictEqual(r.testCase.status, "passed")
      assert.strictEqual(r.testCase.darwinScore, 1)
    }
  })

  test("T-run-exec-fail: runTestCase(execution) without steps → failed (I2), darwin_score -2", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await svs.createTestCase({
      teamId,
      configObjectId: skillA,
      kind: "execution",
      input: "部署这个 API",
      expectedBehavior: "输出可落地步骤",
    })
    if (!created.ok) return

    const r = await svs.runTestCase(created.testCase.id, makeMockExecutor({ output: "好的", activated: true }))
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.passed, false, "execution without steps must fail (I2)")
      assert.strictEqual(r.testCase.status, "failed")
      assert.strictEqual(r.testCase.darwinScore, -2)
    }
  })

  test("T-run-tc-404: runTestCase(unknown id) → 404", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await svs.runTestCase(missingTestCaseId, makeMockExecutor({ output: "", activated: false }))
    assert.strictEqual(r.ok, false)
    if (!r.ok) {
      assert.strictEqual(r.status, 404)
      assert.strictEqual(r.response.code, "NOT_FOUND")
    }
  })

  // ---------- evaluateTestCase（人工回填判定） ----------
  test("T-evaluate-bait-pass: evaluateTestCase(bait, 未激活 JSON) → passed (I1)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await svs.createTestCase({
      teamId,
      configObjectId: skillA,
      kind: "bait",
      input: "闲聊打招呼",
      expectedBehavior: "不应激活该 skill",
    })
    if (!created.ok) return

    const r = await svs.evaluateTestCase(created.testCase.id, {
      actualBehavior: JSON.stringify({ output: "我没有激活", activated: false }),
    })
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.passed, true)
      assert.strictEqual(r.testCase.status, "passed")
      assert.strictEqual(r.testCase.darwinScore, 1)
    }
  })

  test("T-evaluate-bait-fail: evaluateTestCase(bait, 激活 JSON) → failed (I1)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await svs.createTestCase({
      teamId,
      configObjectId: skillA,
      kind: "bait",
      input: "闲聊打招呼",
      expectedBehavior: "不应激活该 skill",
    })
    if (!created.ok) return

    const r = await svs.evaluateTestCase(created.testCase.id, {
      actualBehavior: JSON.stringify({ output: "我调用了 skill", activated: true }),
    })
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.passed, false)
      assert.strictEqual(r.testCase.status, "failed")
      assert.strictEqual(r.testCase.darwinScore, -2)
    }
  })

  test("T-evaluate-exec-pass: evaluateTestCase(execution, 步骤文本) → passed (I2)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await svs.createTestCase({
      teamId,
      configObjectId: skillA,
      kind: "execution",
      input: "部署这个 API",
      expectedBehavior: "输出可落地步骤",
    })
    if (!created.ok) return

    const r = await svs.evaluateTestCase(created.testCase.id, {
      actualBehavior: JSON.stringify({ output: "1. 安装\n2. 配置", activated: true }),
    })
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.passed, true)
      assert.strictEqual(r.testCase.status, "passed")
    }
  })

  test("T-evaluate-exec-fail: evaluateTestCase(execution, 无步骤文本) → failed (I2)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const created = await svs.createTestCase({
      teamId,
      configObjectId: skillA,
      kind: "execution",
      input: "部署这个 API",
      expectedBehavior: "输出可落地步骤",
    })
    if (!created.ok) return

    const r = await svs.evaluateTestCase(created.testCase.id, {
      actualBehavior: JSON.stringify({ output: "好的", activated: true }),
    })
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.passed, false)
      assert.strictEqual(r.testCase.status, "failed")
    }
  })

  test("T-evaluate-tc-404: evaluateTestCase(unknown) → 404", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await svs.evaluateTestCase(missingTestCaseId, { actualBehavior: "x" })
    assert.strictEqual(r.ok, false)
    if (!r.ok) {
      assert.strictEqual(r.status, 404)
    }
  })

  // ---------- createSkillLink（I5 唯一性） ----------
  test("T-link-ok: createSkillLink(A→B, dependency) → ok", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await svs.createSkillLink({
      teamId,
      sourceConfigObjectId: skillA,
      targetConfigObjectId: skillB,
      kind: "dependency",
    })
    assert.strictEqual(r.ok, true)
    if (r.ok) {
      assert.strictEqual(r.link.sourceConfigObjectId, skillA)
      assert.strictEqual(r.link.targetConfigObjectId, skillB)
      assert.strictEqual(r.link.kind, "dependency")
    }
  })

  test("T-link-dup: createSkillLink(A→B, dependency) 重复 → 409 DUPLICATE_LINK (I5)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    // 独立 skill 对，避免与 T-link-ok 共享 (skillA→skillB, dependency) 造成干扰
    const src = createDenTypeId("configObject")
    const dst = createDenTypeId("configObject")
    const first = await svs.createSkillLink({
      teamId,
      sourceConfigObjectId: src,
      targetConfigObjectId: dst,
      kind: "dependency",
    })
    assert.strictEqual(first.ok, true)
    if (!first.ok) return

    const dup = await svs.createSkillLink({
      teamId,
      sourceConfigObjectId: src,
      targetConfigObjectId: dst,
      kind: "dependency",
    })
    assert.strictEqual(dup.ok, false)
    if (!dup.ok) {
      assert.strictEqual(dup.status, 409)
      assert.strictEqual(dup.response.code, "DUPLICATE_LINK")
    }
  })

  test("T-link-diff-kind: createSkillLink(A→B, contrast) 不同 kind → ok (I5)", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const r = await svs.createSkillLink({
      teamId,
      sourceConfigObjectId: skillA,
      targetConfigObjectId: skillB,
      kind: "contrast",
    })
    assert.strictEqual(r.ok, true)
  })

  // ---------- listValidations / listTestCases ----------
  test("T-list-validations: listValidations 返回该 skill 全部 validation", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const freshSkill = createDenTypeId("configObject")
    await svs.createValidation({ teamId, configObjectId: freshSkill, validationType: "cross_domain" })
    await svs.createValidation({ teamId, configObjectId: freshSkill, validationType: "predictive_power" })

    const rows = await svs.listValidations(freshSkill, teamId)
    assert.ok(rows.length >= 2)
    const types = rows.map((r) => r.validationType)
    assert.ok(types.includes("cross_domain"))
    assert.ok(types.includes("predictive_power"))
  })

  test("T-list-tcs-filter: listTestCases with kind filter", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const freshSkill = createDenTypeId("configObject")
    await svs.createTestCase({ teamId, configObjectId: freshSkill, kind: "bait", input: "x", expectedBehavior: "y" })
    await svs.createTestCase({ teamId, configObjectId: freshSkill, kind: "execution", input: "x", expectedBehavior: "y" })

    const baitOnly = await svs.listTestCases(freshSkill, teamId, { kind: "bait" })
    assert.ok(baitOnly.length >= 1)
    assert.ok(baitOnly.every((tc) => tc.kind === "bait"))

    const execOnly = await svs.listTestCases(freshSkill, teamId, { kind: "execution" })
    assert.ok(execOnly.length >= 1)
    assert.ok(execOnly.every((tc) => tc.kind === "execution"))
  })

  // ---------- getSkillPassStatus（汇总守门） ----------
  test("T-pass-status-empty: 无任何数据 → overall=not_ready", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const freshSkill = createDenTypeId("configObject")
    const r = await svs.getSkillPassStatus(freshSkill, teamId)
    assert.strictEqual(r.tripleValidation, "failed")
    assert.strictEqual(r.baitTests, "failed")
    assert.strictEqual(r.executionTests, "failed")
    assert.strictEqual(r.overall, "not_ready")
  })

  test("T-pass-status-e2e-ready: 三重验证全过 + bait/execution 用例全过 → overall=ready", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const freshSkill = createDenTypeId("configObject")

    // 三重验证
    const triple = await completeTripleValidation(freshSkill)
    assert.strictEqual(triple.ok, true)

    // bait + execution 用例跑通
    const bait = await svs.createTestCase({
      teamId, configObjectId: freshSkill, kind: "bait",
      input: "闲聊", expectedBehavior: "不应激活",
    })
    if (bait.ok) {
      await svs.runTestCase(bait.testCase.id, makeMockExecutor({ output: "不激活", activated: false }))
    }
    const exec = await svs.createTestCase({
      teamId, configObjectId: freshSkill, kind: "execution",
      input: "部署", expectedBehavior: "输出步骤",
    })
    if (exec.ok) {
      await svs.runTestCase(exec.testCase.id, makeMockExecutor({ output: "1. 安装\n2. 配置", activated: true }))
    }

    const r = await svs.getSkillPassStatus(freshSkill, teamId)
    assert.strictEqual(r.tripleValidation, "passed")
    assert.strictEqual(r.baitTests, "passed")
    assert.strictEqual(r.executionTests, "passed")
    assert.strictEqual(r.overall, "ready")
  })

  test("T-pass-status-bait-fail: bait 用例失败 → baitTests=failed, overall=not_ready", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const freshSkill = createDenTypeId("configObject")
    await completeTripleValidation(freshSkill)

    const bait = await svs.createTestCase({
      teamId, configObjectId: freshSkill, kind: "bait",
      input: "闲聊", expectedBehavior: "不应激活",
    })
    if (bait.ok) {
      await svs.runTestCase(bait.testCase.id, makeMockExecutor({ output: "激活了", activated: true }))
    }

    const r = await svs.getSkillPassStatus(freshSkill, teamId)
    assert.strictEqual(r.tripleValidation, "passed")
    assert.strictEqual(r.baitTests, "failed")
    assert.strictEqual(r.overall, "not_ready")
  })

  test("T-pass-status-no-tests: 三重验证过但无用例 → 各测试维度 failed, overall=not_ready", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    const freshSkill = createDenTypeId("configObject")
    await completeTripleValidation(freshSkill)

    const r = await svs.getSkillPassStatus(freshSkill, teamId)
    assert.strictEqual(r.tripleValidation, "passed")
    assert.strictEqual(r.baitTests, "failed", "no bait case → not covered")
    assert.strictEqual(r.executionTests, "failed", "no execution case → not covered")
    assert.strictEqual(r.overall, "not_ready")
  })

  // ---------- 跨团队隔离 ----------
  test("T-cross-team: listValidations 跨团队 → 返回空", async (t) => {
    if (!dbAvailable) return t.skip("DB not available")
    await svs.createValidation({ teamId, configObjectId: skillA, validationType: "cross_domain" })
    const otherTeam = createDenTypeId("team")
    const rows = await svs.listValidations(skillA, otherTeam)
    assert.strictEqual(rows.length, 0, "cross-team query should return empty")
  })
})
