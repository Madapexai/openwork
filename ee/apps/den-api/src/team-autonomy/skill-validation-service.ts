// SkillValidationService — 三重验证 + 诱饵/执行测试 + 发布守门（单一守门人）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-skill-validation-service.md
//
// 不变量：
// I1: bait 测试"忍住不激活"才算通过 — isBaitPassed(actual) === (actual.activated === false)
//     （bait 测试失败 = skill 应通过，即 agent 忍住不激活）
// I2: execution 测试"输出可落地步骤"才算通过 — isExecutionPassed 检查编号/Step/动作动词/代码块
// I3: 三重验证全部通过才可 passed — completeValidation / getSkillPassStatus 中
//     cross_domain / predictive_power / uniqueness 三类记录全部 passed（且 reviewed_by 非空）
//     才报告 tripleValidation=passed
// I4: 验证记录不可伪造 — completeValidation 必须携带 reviewer（memberId 非空），
//     否则 400 REVIEWER_REQUIRED；passed 记录必有 reviewed_by + reviewed_at
// I5: skill_link 唯一性 — (source, target, kind) 三元组唯一，重复 409 DUPLICATE_LINK（DB uniqueIndex 兜底）
//
// 设计依据：
// - WorkBuddy Bluebook Ch22 知识精馏六阶段（阶段 1.5 三重验证 + 阶段 5 诱饵/执行测试）
// - 借鉴 CrewAI expected_output（升级为"诱饵反向契约"：bait 期望不激活）
// - 错误风格：operational-errors.ts 风格的 discriminated union（{ ok: false, status, response: { code, message } }）
// - SkillTestExecutor 是可注入接口（便于 mock，不绑定具体 agent 实现）
//
// 注：team-autonomy 表的 JS 属性名为 snake_case（与 org.ts 不同），
// 所有 DB 列引用使用 snake_case，对外 API 使用 camelCase（通过 rowToValidation 等映射）。

import { db } from "../db.js"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  SkillLinkKind,
  SkillLinkTable,
  SkillTestKind,
  SkillTestStatus,
  SkillTestCaseTable,
  SkillValidationStatus,
  SkillValidationTable,
  SkillValidationType,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

// ============================================================
// 类型导出
// ============================================================

export {
  SkillLinkKind,
  SkillTestKind,
  SkillTestStatus,
  SkillValidationStatus,
  SkillValidationType,
}

export type ConfigObjectId = string
export type ValidationType = (typeof SkillValidationType)[number]
export type ValidationStatus = (typeof SkillValidationStatus)[number]
export type TestKind = (typeof SkillTestKind)[number]
export type TestStatus = (typeof SkillTestStatus)[number]
export type SkillLinkKindValue = (typeof SkillLinkKind)[number]

export type ValidationRow = {
  id: string
  teamId: string
  configObjectId: string
  validationType: ValidationType
  status: ValidationStatus
  evidence: Record<string, unknown> | null
  reason: string | null
  reviewedBy: string | null
  reviewedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type TestCaseRow = {
  id: string
  teamId: string
  configObjectId: string
  kind: TestKind
  input: string
  expectedBehavior: string
  actualBehavior: string | null
  status: TestStatus
  lastRunAt: Date | null
  darwinScore: number | null
  createdAt: Date
  updatedAt: Date
}

export type SkillLinkRow = {
  id: string
  teamId: string
  sourceConfigObjectId: string
  targetConfigObjectId: string
  kind: SkillLinkKindValue
  note: string | null
  createdAt: Date
}

// ============================================================
// 可注入的测试执行器接口（便于 mock）
// ============================================================

export interface SkillTestExecutor {
  run(input: string, configObjectId: string): Promise<{ output: string; activated: boolean }>
}

// ============================================================
// 三重验证判定输入类型（I3 + I4 纯逻辑）
// ============================================================

export type TripleValidationInput = {
  type: ValidationType
  status: ValidationStatus
  reviewedBy: string | null
}

export type TripleValidationFailure =
  | { issue: "missing"; type: ValidationType }
  | { issue: "not_passed"; type: ValidationType; status: ValidationStatus }
  | { issue: "missing_reviewer"; type: ValidationType }

export type TripleValidationSummary = {
  tripleValidation: "passed" | "failed"
  failures: TripleValidationFailure[]
}

// ============================================================
// Result 联合类型（错误码即契约）
// ============================================================

export type CreateValidationResult =
  | { ok: true; validation: ValidationRow }
  | { ok: false; status: 400; response: { code: string; message: string } }

export type StartValidationResult =
  | { ok: true; validation: ValidationRow }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type CompleteValidationResult =
  | { ok: true; validation: ValidationRow; overall: TripleValidationSummary }
  | { ok: false; status: 400 | 404; response: { code: string; message: string } }

export type CreateTestCaseResult =
  | { ok: true; testCase: TestCaseRow }
  | { ok: false; status: 400; response: { code: string; message: string } }

export type RunTestCaseResult =
  | { ok: true; testCase: TestCaseRow; actualBehavior: string; passed: boolean }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type EvaluateTestCaseResult =
  | { ok: true; testCase: TestCaseRow; passed: boolean }
  | { ok: false; status: 400 | 404; response: { code: string; message: string } }

export type CreateSkillLinkResult =
  | { ok: true; link: SkillLinkRow }
  | { ok: false; status: 400 | 409; response: { code: string; message: string } }

export type SkillPassStatus = {
  skillId: string
  teamId: string
  tripleValidation: "passed" | "failed"
  baitTests: "passed" | "failed"
  executionTests: "passed" | "failed"
  overall: "ready" | "not_ready"
}

// ============================================================
// 纯函数：bait 判定（I1）— 无需 DB，可单测
// ============================================================

/**
 * I1: bait test "忍住不激活" 才算通过
 * agent 输出任何 tool_call / skill 激活 → activated=true → passed=false
 * agent 输出 "我不应该激活该 skill" → activated=false → passed=true
 */
export function isBaitPassed(actual: { activated: boolean }): boolean {
  return actual.activated === false
}

// ============================================================
// 纯函数：execution 判定（I2）— 无需 DB，可单测
// ============================================================

// 可落地步骤模式：
//   1. 编号步骤："1. " / "1、" / "Step 1" / "步骤 1"
//   2. 动作动词引导的列表："- 安装" / "- 创建" / "- 运行"
//   3. 代码块（```）
const STEP_PATTERNS: ReadonlyArray<RegExp> = [
  /^\s*\d+[\.\、]\s?/m, // "1. "（点后空格）或 "1、"（顿号后可不带空格）
  /^\s*step\s+\d+/im, // "Step 1"
  /^\s*步骤\s*\d+/m, // "步骤 1"
  /^\s*[-*]\s+(安装|创建|运行|配置|部署|删除|添加|检查|执行|启动|停止)/m,
  /```/, // 代码块
]

/**
 * I2: execution test "输出可落地步骤" 才算通过
 * 输出含编号步骤 / Step N / 动作动词列表 / 代码块 → passed
 * 输出 "好的" / "OK" 之类无步骤 → failed
 */
export function isExecutionPassed(actual: { output: string }): boolean {
  if (typeof actual.output !== "string" || actual.output.length === 0) return false
  return STEP_PATTERNS.some((re) => re.test(actual.output))
}

// ============================================================
// 纯函数：bait/execution 统一判定分发（I1 + I2）— 无需 DB
// ============================================================

/**
 * 统一判定：runTestCase / evaluateTestCase 共用
 * bait: activated=false → passed；execution: 输出含可落地步骤 → passed
 */
export function judgeTestCase(
  kind: TestKind,
  actual: { output: string; activated: boolean },
): boolean {
  return kind === "bait" ? isBaitPassed(actual) : isExecutionPassed(actual)
}

// ============================================================
// 纯函数：skill_link 自环检测 — 无需 DB，可单测
// ============================================================

/**
 * skill_link 不可自环：source === target → false（不允许）
 */
export function isValidSkillLink(source: string, target: string): boolean {
  return source !== target
}

// ============================================================
// 纯函数：三重验证判定 — 无需 DB，可单测
// ============================================================

export type JudgeResult = { passed: boolean; reason: string }

/**
 * cross_domain 判定：domains.length >= 2 才算 passed
 * 一个 skill 必须在 >= 2 个领域出现才算"跨域"
 */
export function judgeCrossDomain(evidence: { domains: unknown[] }): JudgeResult {
  const count = Array.isArray(evidence.domains) ? evidence.domains.length : 0
  if (count >= 2) {
    return { passed: true, reason: `skill appears in ${count} domains` }
  }
  return { passed: false, reason: `skill only appears in ${count} domain(s), need >= 2` }
}

/**
 * predictive_power 判定：derivations.length >= 1 才算 passed
 * skill 必须能推导出至少 1 个未讨论问题
 */
export function judgePredictivePower(evidence: { derivations: unknown[] }): JudgeResult {
  const count = Array.isArray(evidence.derivations) ? evidence.derivations.length : 0
  if (count >= 1) {
    return { passed: true, reason: `skill derives ${count} novel question(s)` }
  }
  return { passed: false, reason: "skill derives 0 novel questions, need >= 1" }
}

/**
 * uniqueness 判定：contrastsWith.length >= 1 才算 passed
 * skill 必须与至少 1 个相似 skill 形成对比
 */
export function judgeUniqueness(evidence: { contrastsWith: unknown[] }): JudgeResult {
  const count = Array.isArray(evidence.contrastsWith) ? evidence.contrastsWith.length : 0
  if (count >= 1) {
    return { passed: true, reason: `skill contrasts with ${count} similar skill(s)` }
  }
  return { passed: false, reason: "skill has 0 contrast links, need >= 1" }
}

// ============================================================
// 纯函数：三重验证整体门禁（I3 + I4）— 无需 DB，可单测
// ============================================================

/**
 * I3 + I4 门禁纯逻辑：
 * - 3 类记录（cross_domain / predictive_power / uniqueness）必须全部存在
 * - 每类取最新一条（输入数组后面覆盖前面，与 DB 查询排序一致）
 * - 全部 status='passed'（I3）+ reviewedBy 非空（I4）才算整体通过
 * 返回 { passed, failures }，failures 列出 missing / not_passed / missing_reviewer
 */
export function isTripleValidationPassed(validations: TripleValidationInput[]): {
  passed: boolean
  failures: TripleValidationFailure[]
} {
  const byType = new Map<ValidationType, TripleValidationInput>()
  for (const v of validations) {
    // 多条同 type 时，后出现覆盖前面（调用方保证按 created_at 排序，后=最新）
    byType.set(v.type, v)
  }

  const requiredTypes: ValidationType[] = ["cross_domain", "predictive_power", "uniqueness"]
  const failures: TripleValidationFailure[] = []
  for (const t of requiredTypes) {
    const v = byType.get(t)
    if (!v) {
      failures.push({ issue: "missing", type: t })
      continue
    }
    if (v.status !== "passed") {
      failures.push({ issue: "not_passed", type: t, status: v.status })
    } else if (!v.reviewedBy) {
      failures.push({ issue: "missing_reviewer", type: t })
    }
  }
  return { passed: failures.length === 0, failures }
}

// ============================================================
// 行映射：snake_case schema → camelCase API
// ============================================================

function rowToValidation(row: typeof SkillValidationTable.$inferSelect): ValidationRow {
  return {
    id: row.id,
    teamId: row.team_id,
    configObjectId: row.config_object_id,
    validationType: row.validation_type,
    status: row.status,
    evidence: row.evidence,
    reason: row.reason,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToTestCase(row: typeof SkillTestCaseTable.$inferSelect): TestCaseRow {
  return {
    id: row.id,
    teamId: row.team_id,
    configObjectId: row.config_object_id,
    kind: row.kind,
    input: row.input,
    expectedBehavior: row.expected_behavior,
    actualBehavior: row.actual_behavior,
    status: row.status,
    lastRunAt: row.last_run_at,
    darwinScore: row.darwin_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToSkillLink(row: typeof SkillLinkTable.$inferSelect): SkillLinkRow {
  return {
    id: row.id,
    teamId: row.team_id,
    sourceConfigObjectId: row.source_config_object_id,
    targetConfigObjectId: row.target_config_object_id,
    kind: row.kind,
    note: row.note,
    createdAt: row.created_at,
  }
}

// ============================================================
// 内部：mysql2 ER_DUP_ENTRY (1062) 唯一索引冲突
// ============================================================

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const e = error as Record<string, unknown>
  if (e.code === "ER_DUP_ENTRY") return true
  if (e.errno === 1062) return true
  const cause = e.cause as Record<string, unknown> | undefined
  if (cause) {
    if (cause.code === "ER_DUP_ENTRY" || cause.errno === 1062) return true
  }
  return false
}

// ============================================================
// 内部：actual_behavior 解析（runTestCase 写入 JSON {output, activated}，
// evaluateTestCase 优先按同一格式解析，退化则文本判定）
// ============================================================

function parseActualBehavior(raw: string): { output: string; activated: boolean } | null {
  try {
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.output === "string" &&
      typeof parsed.activated === "boolean"
    ) {
      return { output: parsed.output, activated: parsed.activated }
    }
  } catch {
    // not JSON — fall through
  }
  return null
}

// 文本退化判定的"激活信号"（bait 时文本含这些词视为激活了）
const ACTIVATION_SIGNALS: ReadonlyArray<RegExp> = [/激活|调用|tool_call|activated/i]

function judgeTextFallback(kind: TestKind, raw: string): boolean {
  if (kind === "bait") {
    // 文本含激活信号 → 视为激活 → FAIL；否则视为忍住不激活 → PASS
    return !ACTIVATION_SIGNALS.some((re) => re.test(raw))
  }
  return isExecutionPassed({ output: raw })
}

// ============================================================
// createValidation
// ============================================================

export async function createValidation(input: {
  teamId: string
  configObjectId: string
  validationType: ValidationType
  reviewer?: { memberId: string }
}): Promise<CreateValidationResult> {
  const id = createDenTypeId("skillValidation")
  try {
    await db.insert(SkillValidationTable).values({
      id,
      team_id: input.teamId,
      config_object_id: input.configObjectId,
      validation_type: input.validationType,
      status: "pending",
      evidence: null,
      reason: null,
      reviewed_by: input.reviewer?.memberId ?? null,
      reviewed_at: null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message },
    }
  }

  const rows = await db
    .select()
    .from(SkillValidationTable)
    .where(eq(SkillValidationTable.id, id))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "validation insert did not return a row" },
    }
  }
  return { ok: true, validation: rowToValidation(rows[0]) }
}

// ============================================================
// startValidation — pending → in_progress
// ============================================================

export async function startValidation(validationId: string): Promise<StartValidationResult> {
  const rows = await db
    .select()
    .from(SkillValidationTable)
    .where(eq(SkillValidationTable.id, validationId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `validation ${validationId} not found` },
    }
  }

  await db
    .update(SkillValidationTable)
    .set({ status: "in_progress", updated_at: new Date() })
    .where(eq(SkillValidationTable.id, validationId))

  const updated = await db
    .select()
    .from(SkillValidationTable)
    .where(eq(SkillValidationTable.id, validationId))
    .limit(1)
  if (!updated[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `validation ${validationId} not found after update` },
    }
  }
  return { ok: true, validation: rowToValidation(updated[0]) }
}

// ============================================================
// completeValidation — 单条完成 + 三重验证整体门禁（I3 + I4）
// ============================================================

export async function completeValidation(
  validationId: string,
  input: {
    evidence?: Record<string, unknown>
    reason?: string
    reviewer: { memberId: string }
  },
): Promise<CompleteValidationResult> {
  const rows = await db
    .select()
    .from(SkillValidationTable)
    .where(eq(SkillValidationTable.id, validationId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `validation ${validationId} not found` },
    }
  }
  const current = rowToValidation(rows[0])

  // I4: 验证记录不可伪造 — reviewer 必填才算 passed
  if (!input.reviewer?.memberId || input.reviewer.memberId.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "REVIEWER_REQUIRED",
        message: "reviewer.memberId is required to complete a validation",
      },
    }
  }

  // 按 validation_type 调用对应纯函数判定（evidence 显式传入，缺省空）
  const evidence = input.evidence ?? {}
  let judge: JudgeResult
  if (current.validationType === "cross_domain") {
    judge = judgeCrossDomain({ domains: Array.isArray(evidence.domains) ? evidence.domains : [] })
  } else if (current.validationType === "predictive_power") {
    judge = judgePredictivePower({
      derivations: Array.isArray(evidence.derivations) ? evidence.derivations : [],
    })
  } else {
    judge = judgeUniqueness({
      contrastsWith: Array.isArray(evidence.contrastsWith) ? evidence.contrastsWith : [],
    })
  }

  const newStatus: ValidationStatus = judge.passed ? "passed" : "failed"
  await db
    .update(SkillValidationTable)
    .set({
      status: newStatus,
      evidence,
      reason: input.reason ?? judge.reason,
      reviewed_by: input.reviewer.memberId,
      reviewed_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(SkillValidationTable.id, validationId))

  // 读回本条
  const updated = await db
    .select()
    .from(SkillValidationTable)
    .where(eq(SkillValidationTable.id, validationId))
    .limit(1)
  if (!updated[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `validation ${validationId} not found after update` },
    }
  }

  // I3 整体门禁：读该 skill 全部 3 类记录（每类取最新），全 passed + reviewed_by 非空才算整体通过
  const all = await listValidations(current.configObjectId, current.teamId)
  const sorted = [...all].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const summary = isTripleValidationPassed(
    sorted.map((v) => ({ type: v.validationType, status: v.status, reviewedBy: v.reviewedBy })),
  )

  // 整体通过时做幂等确认：把该 skill 全部验证记录置 passed（确保 passed 态完整落库）
  if (summary.passed) {
    await db
      .update(SkillValidationTable)
      .set({ status: "passed", updated_at: new Date() })
      .where(
        and(
          eq(SkillValidationTable.team_id, current.teamId),
          eq(SkillValidationTable.config_object_id, current.configObjectId),
        ),
      )
  }

  return {
    ok: true,
    validation: rowToValidation(updated[0]),
    overall: {
      tripleValidation: summary.passed ? "passed" : "failed",
      failures: summary.failures,
    },
  }
}

// ============================================================
// createTestCase
// ============================================================

export async function createTestCase(input: {
  teamId: string
  configObjectId: string
  kind: TestKind
  input: string
  expectedBehavior: string
}): Promise<CreateTestCaseResult> {
  if (!input.input || input.input.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      response: { code: "VALIDATION_FAILED", message: "input must not be empty" },
    }
  }
  if (!input.expectedBehavior || input.expectedBehavior.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      response: { code: "VALIDATION_FAILED", message: "expectedBehavior must not be empty" },
    }
  }

  const id = createDenTypeId("skillTestCase")
  try {
    await db.insert(SkillTestCaseTable).values({
      id,
      team_id: input.teamId,
      config_object_id: input.configObjectId,
      kind: input.kind,
      input: input.input,
      expected_behavior: input.expectedBehavior,
      actual_behavior: null,
      status: "pending",
      last_run_at: null,
      darwin_score: 0,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message },
    }
  }

  const rows = await db
    .select()
    .from(SkillTestCaseTable)
    .where(eq(SkillTestCaseTable.id, id))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "test case insert did not return a row" },
    }
  }
  return { ok: true, testCase: rowToTestCase(rows[0]) }
}

// ============================================================
// runTestCase — 调用注入 executor，按 kind 判定（I1/I2），更新 darwin_score
// ============================================================

export async function runTestCase(
  testCaseId: string,
  executor: SkillTestExecutor,
): Promise<RunTestCaseResult> {
  const rows = await db
    .select()
    .from(SkillTestCaseTable)
    .where(eq(SkillTestCaseTable.id, testCaseId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `test case ${testCaseId} not found` },
    }
  }
  const current = rowToTestCase(rows[0])

  // 调用注入的 executor（bait: 期望 activated=false 忍住不激活；execution: 期望可落地输出）
  const result = await executor.run(current.input, current.configObjectId)
  const actualBehavior = JSON.stringify({ output: result.output, activated: result.activated })

  // 统一判定分发（I1: bait activated=false 则 pass；I2: execution 输出步骤则 pass）
  const passed = judgeTestCase(current.kind, result)

  const newStatus: TestStatus = passed ? "passed" : "failed"
  const now = new Date()
  await db
    .update(SkillTestCaseTable)
    .set({
      actual_behavior: actualBehavior,
      status: newStatus,
      last_run_at: now,
      updated_at: now,
    })
    .where(eq(SkillTestCaseTable.id, testCaseId))

  // 诱饵测试评分规则：PASS +1 / FAIL -2（自动进化，覆盖式累加）
  const delta = passed ? 1 : -2
  const prevScore = current.darwinScore ?? 0
  await db
    .update(SkillTestCaseTable)
    .set({ darwin_score: prevScore + delta, updated_at: new Date() })
    .where(eq(SkillTestCaseTable.id, testCaseId))

  const updated = await db
    .select()
    .from(SkillTestCaseTable)
    .where(eq(SkillTestCaseTable.id, testCaseId))
    .limit(1)
  if (!updated[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `test case ${testCaseId} not found after update` },
    }
  }
  return {
    ok: true,
    testCase: rowToTestCase(updated[0]),
    actualBehavior,
    passed,
  }
}

// ============================================================
// evaluateTestCase — 人工/外部回填 actual_behavior，按 kind 判定（I1/I2）
// ============================================================

export async function evaluateTestCase(
  testCaseId: string,
  input: { actualBehavior: string },
): Promise<EvaluateTestCaseResult> {
  if (!input.actualBehavior || input.actualBehavior.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      response: { code: "VALIDATION_FAILED", message: "actualBehavior must not be empty" },
    }
  }

  const rows = await db
    .select()
    .from(SkillTestCaseTable)
    .where(eq(SkillTestCaseTable.id, testCaseId))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `test case ${testCaseId} not found` },
    }
  }
  const current = rowToTestCase(rows[0])

  // 优先解析 JSON {output, activated}（与 runTestCase 写入格式一致），退化用文本判定
  const parsed = parseActualBehavior(input.actualBehavior)
  const passed = parsed ? judgeTestCase(current.kind, parsed) : judgeTextFallback(current.kind, input.actualBehavior)

  const newStatus: TestStatus = passed ? "passed" : "failed"
  const now = new Date()
  await db
    .update(SkillTestCaseTable)
    .set({
      actual_behavior: input.actualBehavior,
      status: newStatus,
      last_run_at: now,
      updated_at: now,
    })
    .where(eq(SkillTestCaseTable.id, testCaseId))

  // 诱饵测试评分规则：PASS +1 / FAIL -2
  const delta = passed ? 1 : -2
  const prevScore = current.darwinScore ?? 0
  await db
    .update(SkillTestCaseTable)
    .set({ darwin_score: prevScore + delta, updated_at: new Date() })
    .where(eq(SkillTestCaseTable.id, testCaseId))

  const updated = await db
    .select()
    .from(SkillTestCaseTable)
    .where(eq(SkillTestCaseTable.id, testCaseId))
    .limit(1)
  if (!updated[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `test case ${testCaseId} not found after update` },
    }
  }
  return { ok: true, testCase: rowToTestCase(updated[0]), passed }
}

// ============================================================
// createSkillLink — I5 唯一性（DB uniqueIndex("skill_link_unique") 兜底并发）
// ============================================================

export async function createSkillLink(input: {
  teamId: string
  sourceConfigObjectId: string
  targetConfigObjectId: string
  kind: SkillLinkKindValue
  note?: string
}): Promise<CreateSkillLinkResult> {
  // 自环检测（source === target 无意义）
  if (!isValidSkillLink(input.sourceConfigObjectId, input.targetConfigObjectId)) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "SELF_LINK_NOT_ALLOWED",
        message: "source and target must be different config objects",
      },
    }
  }

  const id = createDenTypeId("skillLink")
  try {
    await db.insert(SkillLinkTable).values({
      id,
      team_id: input.teamId,
      source_config_object_id: input.sourceConfigObjectId,
      target_config_object_id: input.targetConfigObjectId,
      kind: input.kind,
      note: input.note ?? null,
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        status: 409,
        response: {
          code: "DUPLICATE_LINK",
          message: `link (${input.sourceConfigObjectId} → ${input.targetConfigObjectId}, kind=${input.kind}) already exists`,
        },
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message },
    }
  }

  const rows = await db
    .select()
    .from(SkillLinkTable)
    .where(eq(SkillLinkTable.id, id))
    .limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "skill link insert did not return a row" },
    }
  }
  return { ok: true, link: rowToSkillLink(rows[0]) }
}

// ============================================================
// listValidations
// ============================================================

export async function listValidations(
  configObjectId: string,
  teamId: string,
): Promise<ValidationRow[]> {
  const rows = await db
    .select()
    .from(SkillValidationTable)
    .where(
      and(
        eq(SkillValidationTable.config_object_id, configObjectId),
        eq(SkillValidationTable.team_id, teamId),
      ),
    )
  return rows.map(rowToValidation)
}

// ============================================================
// listTestCases
// ============================================================

export async function listTestCases(
  configObjectId: string,
  teamId: string,
  filter?: { kind?: TestKind; status?: TestStatus },
): Promise<TestCaseRow[]> {
  const conditions = [
    eq(SkillTestCaseTable.config_object_id, configObjectId),
    eq(SkillTestCaseTable.team_id, teamId),
  ]
  if (filter?.kind) conditions.push(eq(SkillTestCaseTable.kind, filter.kind))
  if (filter?.status) conditions.push(eq(SkillTestCaseTable.status, filter.status))

  const rows = await db
    .select()
    .from(SkillTestCaseTable)
    .where(and(...conditions))
  return rows.map(rowToTestCase)
}

// ============================================================
// getSkillPassStatus — I3 + I1 + I2 汇总守门
// ============================================================

export async function getSkillPassStatus(skillId: string, teamId: string): Promise<SkillPassStatus> {
  const [validations, testCases] = await Promise.all([
    listValidations(skillId, teamId),
    listTestCases(skillId, teamId),
  ])

  // 三重验证（I3 + I4）：3 类记录全部 passed + reviewed_by 非空
  const sortedValidations = [...validations].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )
  const triple = isTripleValidationPassed(
    sortedValidations.map((v) => ({
      type: v.validationType,
      status: v.status,
      reviewedBy: v.reviewedBy,
    })),
  )
  const tripleValidation: "passed" | "failed" = triple.passed ? "passed" : "failed"

  // 测试用例维度（I1 + I2）：该 kind 存在 ≥1 个用例且全部 passed 才算通过；无用例=未覆盖=failed
  const baitCases = testCases.filter((tc) => tc.kind === "bait")
  const executionCases = testCases.filter((tc) => tc.kind === "execution")
  const baitTests: "passed" | "failed" =
    baitCases.length > 0 && baitCases.every((tc) => tc.status === "passed") ? "passed" : "failed"
  const executionTests: "passed" | "failed" =
    executionCases.length > 0 && executionCases.every((tc) => tc.status === "passed")
      ? "passed"
      : "failed"

  const overall: "ready" | "not_ready" =
    tripleValidation === "passed" && baitTests === "passed" && executionTests === "passed"
      ? "ready"
      : "not_ready"

  return { skillId, teamId, tripleValidation, baitTests, executionTests, overall }
}
