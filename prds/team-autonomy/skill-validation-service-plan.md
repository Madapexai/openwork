# SkillValidationService — Skill 三重验证 + 诱饵测试发布门禁

> Status: Draft for scoping · Owner: team-autonomy · Schema: `team-autonomy.ts` (已落地)

## Goal

实现 WorkBuddy Bluebook Ch22 的"知识精馏六阶段"中的工程化门禁：

1. **阶段 1.5 三重验证**：跨域验证 / 预测力测试 / 独特性检验——任一不通过即不能发布。
2. **阶段 5 压力测试**：诱饵测试（不该触发的场景应忍住不激活）+ 执行验证（真实问题应输出可落地步骤）。
3. **发布门禁**：3 项验证全 passed + N 条测试用例全 passed 才能升级到 team-wide 可用。

## Short Answer

- **复用现有 ConfigObject**：Skill 仍是 `config_object` 表中 `objectType='skill'` 的记录，不重新发明轮子。
- **验证元数据独立**：`skill_validation` / `skill_test_case` / `skill_link` 三表只存验证元数据，不动 ConfigObject 本身。
- **三重验证并行**：cross_domain / predictive_power / uniqueness 三项可并发执行，全部 passed 才算通过阶段 1.5。
- **诱饵测试是负向测试**：`kind='bait'` 的用例期望"不应激活"，agent 若激活即失败。
- **darwin_score 自动进化**：执行测试通过后 darwin_score+1，失败 -2；分数低于阈值的 skill 自动降级为 inactive。
- **发布门禁由本服务守门**：升级 skill 到 team-wide 前必须调用 `assertPublishable()`。

## Recommendation

放路径：`ee/apps/den-api/src/team-autonomy/skill-validation-service.ts`，验证执行器放 `ee/apps/den-api/src/team-autonomy/skill-test-runner.ts`（调用 OpenWorker sidecar 跑测试）。

## Data Model

参见 [team-autonomy.ts](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts)：

- `SkillValidationTable`（[L470-L495](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts#L470-L495)）— 三重验证记录
- `SkillTestCaseTable`（[L501-L526](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts#L501-L526)）— 诱饵 / 执行测试用例
- `SkillLinkTable`（[L531-L548](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts#L531-L548)）— 依赖 / 对比 / 组合关系

## Surface

```ts
// ee/apps/den-api/src/team-autonomy/skill-validation-service.ts

export type ConfigObjectId = string  // 复用现有 ConfigObjectTable 的 id
export type ValidationType = "cross_domain" | "predictive_power" | "uniqueness"
export type ValidationStatus = "pending" | "in_progress" | "passed" | "failed" | "skipped"
export type TestKind = "bait" | "execution"
export type TestStatus = "pending" | "passed" | "failed"

// ---------- 三重验证 ----------

// 启动三重验证（并发执行三项）
export async function startValidation(
  configObjectId: string,
  teamId: string,
  initiator: { memberId: string },
): Promise<{
  validations: Array<{ id: string; type: ValidationType; status: ValidationStatus }>
}>

// 单项验证结果回填（由验证执行器调用）
export async function recordValidationResult(
  validationId: string,
  result: {
    status: "passed" | "failed" | "skipped"
    evidence?: Record<string, unknown>
    reason?: string
  },
  reviewer?: { memberId: string },
): Promise<ValidationRow>

// 读取某 skill 的三重验证总览
export async function getValidationSummary(
  configObjectId: string,
  teamId: string,
): Promise<{
  crossDomain: ValidationRow | null
  predictivePower: ValidationRow | null
  uniqueness: ValidationRow | null
  allPassed: boolean
}>

// ---------- 测试用例管理 ----------

export async function createTestCase(
  input: {
    configObjectId: string
    teamId: string
    kind: TestKind
    input: string
    expectedBehavior: string
  },
  creator: { memberId: string },
): Promise<TestCaseRow>

export async function listTestCases(
  configObjectId: string,
  teamId: string,
  filter?: { kind?: TestKind; status?: TestStatus },
): Promise<TestCaseRow[]>

// 执行测试用例（调用 OpenWorker sidecar）
export async function runTestCase(
  testCaseId: string,
  agentId: string,
): Promise<
  | { ok: true; testCase: TestCaseRow; actualBehavior: string }
  | { ok: false; status: 4xx; response: ... }
>

// 批量执行（发布前回归）
export async function runAllTestCases(
  configObjectId: string,
  teamId: string,
  agentId: string,
): Promise<{ passed: number; failed: number; results: TestCaseRow[] }>

// ---------- Skill 关系网 ----------

export async function createSkillLink(
  input: {
    teamId: string
    sourceConfigObjectId: string
    targetConfigObjectId: string
    kind: "dependency" | "contrast" | "composition"
    note?: string
  },
  creator: { memberId: string },
): Promise<SkillLinkRow>

export async function listSkillLinks(
  configObjectId: string,
  teamId: string,
): Promise<{ outgoing: SkillLinkRow[]; incoming: SkillLinkRow[] }>

// ---------- 发布门禁 ----------

// 升级到 team-wide 前必须调用
export async function assertPublishable(
  configObjectId: string,
  teamId: string,
): Promise<
  | { ok: true; summary: PublishabilitySummary }
  | {
      ok: false
      status: 409
      response: {
        code: "PUBLISH_GATE_NOT_MET"
        failures: Array<
          | { gate: "validation"; type: ValidationType; status: ValidationStatus }
          | { gate: "test_case"; kind: TestKind; status: TestStatus; testCaseId: string }
        >
      }
    }
>

export type PublishabilitySummary = {
  configObjectId: string
  validationsPassed: number  // 必须 = 3
  testCasesPassed: number
  testCasesTotal: number
  darwinScore: number
  readyForPublish: boolean
}

// ---------- darwin_score 自动进化 ----------

// 由 runTestCase 内部调用：通过 +1，失败 -2
export async function adjustDarwinScore(
  configObjectId: string,
  teamId: string,
  delta: number,
): Promise<{ newScore: number; autoArchived: boolean }>
```

## 关键不变量

1. **三重验证独立**：`skill_validation` 表 `(config_object_id, validation_type)` 不强制 UNIQUE（保留历史），但 `getValidationSummary` 只取每个 type 最新一条。
2. **诱饵测试逻辑反转**：`kind='bait'` 时，`expected_behavior="不应激活"`；如果 agent 输出了任何动作 → status='failed'。
3. **发布门禁三段式**：3 项验证全 passed + 所有 test_case 全 passed + darwin_score >= 阈值，缺一不可。
4. **darwin_score 自动降级**：分数 < -5 时自动调用 `ConfigObjectTable.update({ status: 'inactive' })`，并由本服务写入一条 `team_mailbox` 通知团队 owner。
5. **关系网无环**：`skill_link` 中 `kind='dependency'` 不能形成环，`createSkillLink` 必须做 DFS 检测。
6. **跨团队隔离**：所有查询必须带 `team_id` 过滤，防止跨团队读到 skill 验证数据。

## 验证执行器（与 OpenWorker sidecar 集成）

```ts
// ee/apps/den-api/src/team-autonomy/skill-test-runner.ts

export async function executeTestCase(
  testCase: TestCaseRow,
  agentId: string,
): Promise<{ actualBehavior: string; passed: boolean }>

// 内部实现：
// 1. 通过 TeamAgentTable 找到 agent 的 sidecar_session_id
// 2. 调用 OpenWorker sidecar 的 /v1/sessions/{id}/test 接口
// 3. 接收 agent 输出
// 4. 对照 expected_behavior 判定 passed
//    - kind=bait: agent 输出任何 tool_call → failed
//    - kind=execution: agent 输出包含可落地步骤 → passed
// 5. 写回 actual_behavior + status + last_run_at
// 6. 调用 adjustDarwinScore
```

## HTTP 路由

| Method | Path | operationId |
|---|---|---|
| POST | `/v1/teams/{teamId}/skills/{configObjectId}/validations` | `startValidation` |
| GET | `/v1/teams/{teamId}/skills/{configObjectId}/validations` | `getValidationSummary` |
| POST | `/v1/teams/{teamId}/skills/{configObjectId}/test-cases` | `createTestCase` |
| GET | `/v1/teams/{teamId}/skills/{configObjectId}/test-cases` | `listTestCases` |
| POST | `/v1/teams/{teamId}/skills/{configObjectId}/test-cases/{id}/run` | `runTestCase` |
| POST | `/v1/teams/{teamId}/skills/{configObjectId}/test-cases:run-all` | `runAllTestCases` |
| POST | `/v1/teams/{teamId}/skills/{configObjectId}/links` | `createSkillLink` |
| GET | `/v1/teams/{teamId}/skills/{configObjectId}/links` | `listSkillLinks` |
| POST | `/v1/teams/{teamId}/skills/{configObjectId}/assert-publishable` | `assertPublishable` |

## Test Plan

- **三重验证**：mock 3 项验证器，验证 `getValidationSummary.allPassed` 只在全部 passed 时为 true。
- **诱饵测试反向逻辑**：bait 用例下 agent 输出 tool_call → failed；agent 输出"我不应该激活"→ passed。
- **发布门禁**：构造 3 验证 passed + 2 测试 passed + 1 测试 failed 的场景，验证 `assertPublishable` 返回 409。
- **darwin_score 自动降级**：连续失败到 -5，验证 ConfigObject.status 自动变 inactive。
- **关系网无环**：A→B→C→A 的 dependency 链应被拒绝。
- **跨团队隔离**：team1 的用户读 team2 的 skill，应返回空。
- **E2E**：从创建 skill → 启动验证 → 跑测试 → 发布的完整流程。
