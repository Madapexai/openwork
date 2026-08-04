# OpenSpecs — SkillValidationService（三重验证 + 诱饵/执行测试 + 发布门禁）

> Service: `ee/apps/den-api/src/team-autonomy/skill-validation-service.ts`
> Test: `ee/apps/den-api/test/team-autonomy/skill-validation-service.test.ts`
> Tables: `skill_validation` + `skill_test_case` + `skill_link` (from `@openwork-ee/den-db/schema`)
> ConfigObject: 复用 `config_object` 表中 `objectType='skill'` 的记录（不重新发明轮子）
>
> 设计依据：
> - WorkBuddy Bluebook Ch22：知识精馏六阶段
>   - 阶段 1.5 三重验证：跨域验证（cross_domain）/ 预测力测试（predictive_power）/ 独特性检验（uniqueness）
>   - 阶段 5 压力测试：诱饵测试（bait，不该触发的场景应忍住不激活）+ 执行验证（execution，真实问题应输出可落地步骤）
> - 借鉴 CrewAI expected_output（升级为"诱饵反向契约"：bait 用例期望"不激活"）
> - 错误风格：operational-errors.ts 风格的 discriminated union（`{ ok: false, status, response: { code, message } }`），
>   与 asset-service.ts / team-agent-service.ts 保持一致

---

## 1. 规范定义（Spec）

### 1.1 总览

```
                    ┌──────────────────────────────────────────┐
                    │   ConfigObject (objectType='skill')       │
                    │   ← 复用现有表，不重新发明轮子              │
                    └──────────────────┬───────────────────────┘
                                       │
       ┌───────────────────────────────┼─────────────────────────────┐
       ▼                               ▼                             ▼
┌──────────────┐              ┌────────────────┐           ┌────────────────┐
│ skill_       │              │ skill_test_    │           │ skill_link     │
│ validation   │              │ case           │           │ (依赖/对比/组合)│
│              │              │                │           │                │
│ cross_domain │              │ kind=bait      │           │ I5: source+    │
│ predictive_  │              │  (反向：不激活)│           │     target+    │
│ power        │              │ kind=execution │           │     kind 唯一  │
│ uniqueness   │              │  (正向：可落地)│           │                │
└──────┬───────┘              └────────┬───────┘           └────────────────┘
       │                               │
       └───────────────┬───────────────┘
                       ▼
              ┌────────────────────┐
              │ getSkillPassStatus │  三重验证全 passed + 测试用例全 passed
              │ (skillId, teamId)  │  → overall=ready，否则 not_ready
              └────────────────────┘
```

流程契约（9 个 API）：
```
createValidation → startValidation → completeValidation（单条完成 + 三重验证整体门禁）
createTestCase → runTestCase（真实 agent / mock executor）或 evaluateTestCase（人工回填判定）
createSkillLink（唯一性门禁）
listValidations / listTestCases / getSkillPassStatus（汇总守门）
```

### 1.2 不变量（5 条必须 test）

| ID | 不变量 | 失败返回 |
|---|---|---|
| I1 | **bait 测试"忍住不激活"才算通过**：`kind='bait'` 的用例期望 agent 不激活该 skill。`isBaitPassed({ activated: false })` → true；`activated: true` → false（激活了即 FAIL，skill 应通过=agent 忍住） | test_case.status=`failed` |
| I2 | **execution 测试"输出可落地步骤"才算通过**：`kind='execution'` 的用例期望输出含编号步骤 / "Step N" / 动作动词列表 / 代码块。`isExecutionPassed({ output: "1. 安装…" })` → true；`output: "好的"` → false（没输出即 FAIL，skill 应失败） | test_case.status=`failed` |
| I3 | **三重验证全部通过才可 passed**：`completeValidation` / `getSkillPassStatus` 中，`tripleValidation=passed` 仅当该 skill 的 cross_domain / predictive_power / uniqueness 三类记录全部存在、全部 `status='passed'`（且满足 I4 reviewed_by 非空） | overall.failures 列出缺失/未通过项 |
| I4 | **验证记录不可伪造**：`completeValidation` 必须携带 `reviewer`（memberId 非空），否则 400 `REVIEWER_REQUIRED`；任何 `status='passed'` 的验证记录必须有 reviewed_by + reviewed_at | 400 / `REVIEWER_REQUIRED` |
| I5 | **skillLink 唯一性**：`createSkillLink` 中 (source_config_object_id, target_config_object_id, kind) 三元组唯一，重复返回 409 `DUPLICATE_LINK`（DB `uniqueIndex("skill_link_unique")` 兜底并发） | 409 / `DUPLICATE_LINK` |

### 1.3 Surface（durable contract）

```ts
// ---------- 类型 ----------
export type ConfigObjectId = string  // 复用 ConfigObjectTable.id (objectType='skill')

export type ValidationType = "cross_domain" | "predictive_power" | "uniqueness"
export type ValidationStatus = "pending" | "in_progress" | "passed" | "failed" | "skipped"
export type TestKind = "bait" | "execution"
export type TestStatus = "pending" | "passed" | "failed"
export type SkillLinkKind = "dependency" | "contrast" | "composition"

// ---------- 行映射（snake_case schema → camelCase API） ----------
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
  kind: SkillLinkKind
  note: string | null
  createdAt: Date
}

// ---------- 可注入的测试执行器接口（service 不绑定具体 agent 实现） ----------
export interface SkillTestExecutor {
  run(input: string, configObjectId: string): Promise<{ output: string; activated: boolean }>
}

// ---------- Result 联合类型（错误码即契约） ----------
export type CreateValidationResult =
  | { ok: true; validation: ValidationRow }
  | { ok: false; status: 400; response: { code: string; message: string } }

export type StartValidationResult =
  | { ok: true; validation: ValidationRow }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type CompleteValidationResult =
  | { ok: true; validation: ValidationRow; overall: TripleValidationSummary }
  | { ok: false; status: 400 | 404; response: { code: string; message: string } }

export type TripleValidationSummary = {
  tripleValidation: "passed" | "failed"
  failures: Array<
    | { issue: "missing"; type: ValidationType }
    | { issue: "not_passed"; type: ValidationType; status: ValidationStatus }
    | { issue: "missing_reviewer"; type: ValidationType }
  >
}

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

// ---------- API（模块级函数 + db 单例） ----------
export async function createValidation(input: {
  teamId: string
  configObjectId: string
  validationType: ValidationType
  reviewer?: { memberId: string }
}): Promise<CreateValidationResult>

export async function startValidation(validationId: string): Promise<StartValidationResult>

// I4: reviewer 必填；I3: 完成后汇总三重验证整体状态
export async function completeValidation(
  validationId: string,
  input: {
    evidence?: Record<string, unknown>
    reason?: string
    reviewer: { memberId: string }
  },
): Promise<CompleteValidationResult>

export async function createTestCase(input: {
  teamId: string
  configObjectId: string
  kind: TestKind
  input: string
  expectedBehavior: string
}): Promise<CreateTestCaseResult>

// runTestCase：调用注入 executor → 按 kind 判定（bait: activated=false 则 pass；execution: 输出可落地步骤则 pass）
// → 写回 actual_behavior/status/last_run_at + darwin_score（PASS +1 / FAIL -2）
export async function runTestCase(
  testCaseId: string,
  executor: SkillTestExecutor,
): Promise<RunTestCaseResult>

// evaluateTestCase：人工/外部回填 actual_behavior，按 kind 判定并写回（bait: 激活了=FAIL 忍住=PASS；execution: 输出了=PASS 没输出=FAIL）
export async function evaluateTestCase(
  testCaseId: string,
  input: { actualBehavior: string },
): Promise<EvaluateTestCaseResult>

// I5: (source, target, kind) 唯一；重复 → 409 DUPLICATE_LINK
export async function createSkillLink(input: {
  teamId: string
  sourceConfigObjectId: string
  targetConfigObjectId: string
  kind: SkillLinkKind
  note?: string
}): Promise<CreateSkillLinkResult>

export async function listValidations(configObjectId: string, teamId: string): Promise<ValidationRow[]>

export async function listTestCases(
  configObjectId: string,
  teamId: string,
  filter?: { kind?: TestKind; status?: TestStatus },
): Promise<TestCaseRow[]>

// I3+I1+I2 汇总守门
export async function getSkillPassStatus(skillId: string, teamId: string): Promise<SkillPassStatus>
```

### 1.4 三重验证流程（createValidation → startValidation → completeValidation）

```
createValidation({ teamId, configObjectId, validationType }) → status=pending
startValidation(validationId)                                → status=in_progress
completeValidation(validationId, { evidence, reason, reviewer })
  │
  ├─ 1. 读 validation row（不存在 → 404 NOT_FOUND）
  ├─ 2. I4: reviewer.memberId 必填 → 400 REVIEWER_REQUIRED
  ├─ 3. 按 validation_type 调用纯函数判定：
  │    ├─ cross_domain:      judgeCrossDomain({ domains })          → passed iff domains.length >= 2
  │    ├─ predictive_power:  judgePredictivePower({ derivations })  → passed iff derivations.length >= 1
  │    └─ uniqueness:        judgeUniqueness({ contrastsWith })     → passed iff contrastsWith.length >= 1
  ├─ 4. 写回本条：status（判定结果）+ evidence + reason + reviewed_by + reviewed_at
  ├─ 5. I3 汇总门禁：读该 skill 全部 3 类记录（cross_domain/predictive_power/uniqueness）：
  │      3 类都存在 && 全部 status='passed' && 全部 reviewed_by 非空
  │      → tripleValidation=passed（把 3 条全部置 passed 确认态）
  │      → 否则 tripleValidation=failed + failures（missing / not_passed / missing_reviewer）
  └─ 6. 返回 { ok: true, validation: 本条, overall: TripleValidationSummary }
```

### 1.5 Bait/Execution 判定逻辑（纯函数）

**Bait test（I1）— 反向契约**：
```ts
export function isBaitPassed(actual: { activated: boolean }): boolean {
  return actual.activated === false
}
```
- agent 输出任何 tool_call / skill 激活 → `activated=true` → FAIL
- agent 输出"我不应该激活该 skill" → `activated=false` → PASS

**Execution test（I2）— 正向契约**：
```ts
export function isExecutionPassed(actual: { output: string }): boolean {
  // 可落地步骤模式：
  //   1. 编号步骤："1. " / "1、" / "Step 1" / "步骤 1"
  //   2. 动作动词引导的列表："- 安装" / "- 创建" / "- 运行"
  //   3. 代码块（```）
  const STEP_PATTERNS = [
    /^\s*\d+[\.\、]\s/m,
    /^\s*step\s+\d+/im,
    /^\s*步骤\s*\d+/m,
    /^\s*[-*]\s+(安装|创建|运行|配置|部署|删除|添加|检查|执行|启动|停止)/m,
    /```/,
  ]
  return typeof actual.output === "string" && actual.output.length > 0 && STEP_PATTERNS.some((re) => re.test(actual.output))
}
```

**统一判定分发（evaluateTestCase / runTestCase 共用）**：
```ts
export function judgeTestCase(
  kind: TestKind,
  actual: { output: string; activated: boolean },
): boolean {
  return kind === "bait" ? isBaitPassed(actual) : isExecutionPassed(actual)
}
```

### 1.6 诱饵测试评分规则（darwin_score）

| 事件 | darwin_score delta |
|---|---|
| 用例创建 | 初始 0 |
| 测试通过（PASS） | `+1` |
| 测试失败（FAIL） | `-2` |

- 由 `runTestCase` / `evaluateTestCase` 自动更新；每次运行覆盖式累加。
- 兼容 darwin-skill 自动进化（WorkBuddy Ch22）：连续失败快速扣分，分数低于阈值的 skill 后续可由上游降级（本 service 只负责计分）。

### 1.7 E2E 场景（端到端验证）

```
E2E-A: "创建 skill → 三重验证 → 跑诱饵 + 执行测试 → getSkillPassStatus=ready"
  1. createValidation(cross_domain) → status=pending
  2. createValidation(predictive_power) → status=pending
  3. createValidation(uniqueness) → status=pending
  4. startValidation × 3 → status=in_progress
  5. completeValidation(cross_domain, { evidence:{domains:["a","b"]}, reviewer }) → passed
  6. completeValidation(predictive_power, { evidence:{derivations:["x"]}, reviewer }) → passed
  7. completeValidation(uniqueness, { evidence:{contrastsWith:["y"]}, reviewer }) → passed
  8. createTestCase(bait, input="闲聊", expected="不应激活") → pending, darwin_score=0
  9. createTestCase(execution, input="部署 API", expected="输出步骤") → pending
  10. runTestCase(bait_id, mockExecutor{ activated: false }) → passed (I1), darwin_score=+1
  11. runTestCase(execution_id, mockExecutor{ output: "1. 安装\n2. 配置" }) → passed (I2), darwin_score=+1
  12. getSkillPassStatus(skillId) → { tripleValidation: passed, baitTests: passed, executionTests: passed, overall: ready }

E2E-B: "bait 激活即失败"
  1. createTestCase(bait, ...)
  2. runTestCase(id, mockExecutor{ activated: true, output: "调用了 skill" })
  3. → status=failed, darwin_score -= 2

E2E-C: "execution 输出无步骤即失败"
  1. createTestCase(execution, ...)
  2. runTestCase(id, mockExecutor{ activated: true, output: "好的" })
  3. → status=failed

E2E-D: "completeValidation 缺 reviewer 被拒（I4）"
  1. completeValidation(id, { evidence, reviewer: 缺 }) → 400 REVIEWER_REQUIRED

E2E-E: "三重验证缺一项 → overall.failures 列出（I3）"
  1. 只完成 cross_domain + predictive_power（无 uniqueness 记录）
  2. completeValidation(predictive_power) → overall.tripleValidation=failed, failures=[{issue:'missing', type:'uniqueness'}]

E2E-F: "skillLink 唯一性（I5）"
  1. createSkillLink(A→B, dependency) → ok
  2. createSkillLink(A→B, dependency) 重复 → 409 DUPLICATE_LINK
  3. createSkillLink(A→B, contrast) → ok（不同 kind 允许）
```

---

## 2. RED 阶段 — 必须失败的测试

在写完 Service 之前，`node --import tsx --test test/team-autonomy/skill-validation-service.test.ts` 必须出现（模块缺少新 API 或导入失败）：
- T-RED-import：导入 `skill-validation-service.js` → 缺 `startValidation` / `completeValidation` / `evaluateTestCase` / `getSkillPassStatus` 等新 API
- T-I1-a（RED）：`isBaitPassed({ activated: false })` → true
- T-I1-b（RED）：`isBaitPassed({ activated: true })` → false
- T-I2-a（RED）：`isExecutionPassed({ output: "1. 安装\n2. 配置" })` → true
- T-I2-b（RED）：`isExecutionPassed({ output: "好的" })` → false
- T-I2-c（RED）：`isExecutionPassed({ output: "Step 1: foo\nStep 2: bar" })` → true
- T-I2-d（RED）：`isExecutionPassed({ output: "```js\nconsole.log('hi')\n```" })` → true
- T-I2-e（RED）：`isExecutionPassed({ output: "步骤 1 安装" })` → true
- T-I2-f（RED）：`isExecutionPassed({ output: "- 安装依赖\n- 配置环境" })` → true
- T-I2-g（RED）：`isExecutionPassed({ output: "1、安装\n2、配置" })` → true
- T-I2-h（RED）：`isExecutionPassed({ output: "" })` → false
- T-judge-tc-bait（RED）：`judgeTestCase("bait", { activated: false, output: "不激活" })` → true
- T-judge-tc-bait-fail（RED）：`judgeTestCase("bait", { activated: true, output: "调用了" })` → false
- T-judge-tc-exec（RED）：`judgeTestCase("execution", { activated: true, output: "1. 安装" })` → true
- T-judge-tc-exec-fail（RED）：`judgeTestCase("execution", { activated: true, output: "好的" })` → false
- T-judge-cross（RED）：`judgeCrossDomain({ domains: ["a","b"] })` → passed
- T-judge-cross-fail（RED）：`judgeCrossDomain({ domains: ["a"] })` → failed
- T-judge-pred（RED）：`judgePredictivePower({ derivations: ["x"] })` → passed
- T-judge-pred-fail（RED）：`judgePredictivePower({ derivations: [] })` → failed
- T-judge-uni（RED）：`judgeUniqueness({ contrastsWith: ["y"] })` → passed
- T-judge-uni-fail（RED）：`judgeUniqueness({ contrastsWith: [] })` → failed
- T-triple-pass（RED）：`isTripleValidationPassed`（3 类全 passed + reviewedBy 非空）→ { passed: true }
- T-triple-missing（RED）：缺 uniqueness → { passed: false, failures 含 uniqueness }
- T-triple-reviewer-missing（RED）：全 passed 但某条 reviewedBy 为空 → { passed: false }（I4）

## 3. GREEN 阶段

写完 Service 并通过全部测试。

### 3.1 纯函数（无 DB 依赖，可独立单测）
- `isBaitPassed(actual): boolean` — I1
- `isExecutionPassed(actual): boolean` — I2
- `judgeTestCase(kind, actual): boolean` — bait/execution 统一判定分发
- `judgeCrossDomain(evidence): { passed; reason }` — 跨域判定
- `judgePredictivePower(evidence): { passed; reason }` — 预测力判定
- `judgeUniqueness(evidence): { passed; reason }` — 独特性判定
- `isTripleValidationPassed(validations): { passed; failures }` — I3+I4 整体门禁纯逻辑

### 3.2 GREEN 验收标准
- 所有纯逻辑测试在无 DB 环境下全部通过（CI 友好，executor 用 mock）
- DB 集成测试在 `dbAvailable=false` 时自动 skip，不阻塞 CI
- `runTestCase` 必须接受 `SkillTestExecutor` 接口参数（便于 mock）
- `completeValidation` 强制 `reviewer`（I4），并返回 `TripleValidationSummary`（I3）
- `getSkillPassStatus` 是 I1/I2/I3 汇总守门人，返回 `SkillPassStatus`
- 错误一律使用 operational-errors.ts 风格的 discriminated union

---

## 4. REFACTOR
- 把"判定逻辑"与"DB 操作"分离：所有判定都是纯函数（导出）
- DB 函数走模块级 `db` 单例（与 asset-service / team-agent-service 一致）
- `SkillTestExecutor` 是可注入接口（不绑定具体 agent 实现）
- `evaluateTestCase` 与 `runTestCase` 共用 `judgeTestCase` 判定内核

---

## 5. E2E
- 纯逻辑测试（bait/execution 判定、三重验证门禁、评分规则）无需 DB，在 CI 无 DB 环境下也跑
- DB 集成测试用真实 MySQL（`DATABASE_URL` 指向测试库），executor 用 mock 避免依赖真实 agent

---

## 6. 沉淀
更新本 openspec，补充：
- 每次测试发现的新不变量加入 1.2 表
- API 签名 / 三重验证流程 / bait+execution 判定 / 诱饵评分规则 / 测试通过证据 追加到 Implementation Log

---

## 7. Implementation Log

### 7.1 交付物（2026-08-04, branch: feat/team-autonomy）

| 文件 | 说明 |
|---|---|
| `ee/apps/den-api/src/team-autonomy/skill-validation-service.ts` | Service（模块级函数 + db 单例） |
| `ee/apps/den-api/test/team-autonomy/skill-validation-service.test.ts` | RED/GREEN 测试（node:test + tsx） |
| `prds/team-autonomy/openspecs/openspec-skill-validation-service.md` | 本规范 |

### 7.2 最终 API 签名（与实现一一对应）

模块级函数（全部导出，错误用 operational-errors.ts 风格 discriminated union）：

```ts
createValidation({ teamId, configObjectId, validationType, reviewer? }) → { ok, validation } | 400
startValidation(validationId)                                  → { ok, validation } | 404 NOT_FOUND
completeValidation(validationId, { evidence?, reason?, reviewer: { memberId } })
  → { ok, validation, overall: TripleValidationSummary } | 400 REVIEWER_REQUIRED | 404
createTestCase({ teamId, configObjectId, kind, input, expectedBehavior }) → { ok, testCase } | 400
runTestCase(testCaseId, executor: SkillTestExecutor)           → { ok, testCase, actualBehavior, passed } | 404
evaluateTestCase(testCaseId, { actualBehavior })               → { ok, testCase, passed } | 400 | 404
createSkillLink({ teamId, sourceConfigObjectId, targetConfigObjectId, kind, note? })
  → { ok, link } | 400 SELF_LINK_NOT_ALLOWED | 409 DUPLICATE_LINK
listValidations(configObjectId, teamId)                        → ValidationRow[]
listTestCases(configObjectId, teamId, filter?: { kind?, status? }) → TestCaseRow[]
getSkillPassStatus(skillId, teamId) → { skillId, teamId, tripleValidation, baitTests, executionTests, overall }
```

纯函数（无 DB 依赖，单测直达）：
```ts
isBaitPassed({ activated: boolean }) → boolean                       // I1
isExecutionPassed({ output: string }) → boolean                      // I2
judgeTestCase(kind, { output, activated }) → boolean                 // I1+I2 统一判定分发
judgeCrossDomain({ domains }) / judgePredictivePower({ derivations }) / judgeUniqueness({ contrastsWith })
isTripleValidationPassed(validations) → { passed, failures }         // I3+I4 门禁纯逻辑
isValidSkillLink(source, target) → boolean                           // 自环检测
```

### 7.3 执行流程与判定逻辑（GREEN 落地要点）

- **runTestCase**：调用注入的 `SkillTestExecutor.run(input, configObjectId)`（bait 期望 `activated=false` 忍住不激活；execution 期望可落地输出）→ `actual_behavior=JSON.stringify({ output, activated })` → `judgeTestCase(kind, result)` 判定 → 写回 status/last_run_at → 评分。
- **evaluateTestCase**：人工/外部回填 `actualBehavior` → 优先 `JSON.parse` 为 `{ output, activated }` 走 `judgeTestCase`；非 JSON 退化：bait 查激活信号（激活|调用|tool_call|activated）判定，execution 走 `isExecutionPassed` → 写回 + 评分。
- **completeValidation**：I4 先校验 `reviewer.memberId` 非空（缺 → 400 REVIEWER_REQUIRED）→ 按 validation_type 调纯函数判定 → 写回 status/evidence/reason/reviewed_by/reviewed_at → I3 汇总该 skill 三类记录（每类取最新）`isTripleValidationPassed` → 全 passed + reviewed_by 非空时整体 passed（幂等确认全量置 passed），否则返回 failures。
- **getSkillPassStatus**（I1/I2/I3 汇总守门）：`tripleValidation` = 三类记录全 passed + reviewed_by 非空；`baitTests`/`executionTests` = 该 kind 存在 ≥1 用例且全部 passed（无用例=未覆盖=failed）；`overall = ready` 当且仅当三者全 passed。

### 7.4 诱饵测试评分规则（darwin_score，落地确认）

| 事件 | darwin_score delta |
|---|---|
| 用例创建 | 初始 0 |
| 测试通过（PASS，`judgeTestCase` 返回 true） | `+1` |
| 测试失败（FAIL） | `-2` |

由 `runTestCase` / `evaluateTestCase` 覆盖式累加（取当前值 + delta 写回）。连续失败快速扣分，供 darwin-skill 自动进化（Ch22）消费。

### 7.5 不变量落地对照

| 不变量 | 落地点 | 测试 |
|---|---|---|
| I1 bait 忍住不激活才通过 | `isBaitPassed` + `judgeTestCase("bait")` + `runTestCase`/`evaluateTestCase` bait 分支 | T-I1-a/b, T-judge-tc-bait*, T-run-bait-*, T-evaluate-bait-* |
| I2 execution 输出可落地步骤才通过 | `isExecutionPassed`（编号/Step/步骤/动作动词/代码块）+ execution 分支 | T-I2-a~i, T-judge-tc-exec*, T-run-exec-*, T-evaluate-exec-* |
| I3 三重验证全部通过才可 passed | `isTripleValidationPassed` + `completeValidation` 整体门禁 + `getSkillPassStatus.tripleValidation` | T-triple-*, T-complete-gate-not-met, T-complete-e2e-pass, T-pass-status-* |
| I4 reviewed_by 必填才算 passed | `completeValidation` 400 REVIEWER_REQUIRED + `isTripleValidationPassed` missing_reviewer | T-complete-reviewer-required, T-triple-reviewer-missing |
| I5 skillLink 唯一性 | `createSkillLink` 409 DUPLICATE_LINK（DB `uniqueIndex("skill_link_unique")` 兜底） | T-link-dup, T-link-diff-kind |

### 7.6 测试通过证据（e2e）

```
> node --import tsx --test --test-force-exit test/team-autonomy/skill-validation-service.test.ts
ℹ tests 57
ℹ suites 8
ℹ pass 57
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms ~1660
```

- 纯逻辑测试（bait/execution 判定、三重验证门禁、评分规则）无 DB 依赖，CI 无 DB 环境可跑；
- DB 集成测试（create→start→complete 全流程、run/evaluate 写回、link 唯一性、list、getSkillPassStatus 守门）在真实 MySQL（openwork_test_ta）通过，executor 用 mock（不依赖真实 agent）。

### 7.7 关键实现决策（REFACTOR 沉淀）

1. **判定与 DB 分离**：所有判定都是导出的纯函数，`runTestCase` / `evaluateTestCase` / `completeValidation` 共用同一判定内核，避免逻辑漂移。
2. **`SkillTestExecutor` 可注入接口**：service 不绑定具体 agent 实现，测试/路由可注入 mock；`evaluateTestCase` 提供人工回填路径（无 agent 时也能验收）。
3. **404 语义**：id 必须为合法 typeid（`createDenTypeId` 生成）；非法 suffix 会在 drizzle driver 层抛 `InvalidSuffixLengthError`（den-db typeid 列特性），404 测试用"合法但不存在"的 id 覆盖。
4. **`actual_behavior` 契约**：`runTestCase` 写入 `JSON.stringify({ output, activated })`；`evaluateTestCase` 优先按此解析，非 JSON 退化用激活信号文本判定（bait）或步骤模式（execution）。
5. **测试隔离**：skill_link 有唯一索引，重复 (source,target,kind) 的用例必须用独立 id 对，避免同文件测试间互相污染；validation/test_case 无唯一约束，可复用 skill。
6. **`isExecutionPassed` 编号模式**：`/^\s*\d+[\.\、]\s?/m` 同时覆盖 "1. "（点+空格）与 "1、"（顿号+无空格，中文习惯）。

