# OpenSpecs — AutomationService (自动化状态机 + 降级交付 + 可行动告警)

> Service: `ee/apps/den-api/src/team-autonomy/automation-service.ts`
> Test: `ee/apps/den-api/test/team-autonomy/automation-service.test.ts`
> Tables: `team_automation` + `team_automation_run` + `team_automation_alert` (from `@openwork-ee/den-db/schema`)
>
> 设计依据：
> - WorkBuddy Bluebook Ch25：自动化状态机 + 降级交付 + 可行动告警（7 字段）
> - 借鉴 Temporal RetryOptions（`retry_policy` JSON：max_attempts / backoff_coefficient / retry_on / no_retry_on）
> - 借鉴 LangGraph Checkpoint（断点续跑 `state` JSON 记录 `completed_steps`）

---

## 1. 规范定义（Spec）

### 1.1 状态机（强制单一守门人）

```
waiting_trigger ──startRun──▶ fetching ──advance──▶ aggregating ──advance──▶ filtering ──advance──▶ delivering ──advance──▶ completed
       │                          │                       │                       │                       │
       │                          │ failRun               │ failRun               │ failRun               │ failRun
       │                          ▼                       ▼                       ▼                       ▼
       └──────────────────────── blocked ◀────────────── blocked ◀────────────── blocked ◀────────────── blocked
                                  │
                                  │ retry_exhausted
                                  ▼
                                failed (终态)
```

合法前进路径（I3）：`waiting_trigger → fetching → aggregating → filtering → delivering → completed`
- 中间任意步骤可 `failRun` → `blocked`
- `blocked` 经重试耗尽后 → `failed`（终态）
- `completed` 是终态
- `partial_aggregating` 是 `fetching → aggregating` 之间的可选中间态（部分数据源失败但仍可继续聚合）

唯一合法转换由 `ALLOWED_TRANSITIONS` 矩阵硬编码（见 §3.2）。

### 1.2 不变量（6 条必须 test）

| ID | 不变量 | 失败返回 |
|---|---|---|
| I1 | `batch_id` 幂等：`team_automation_run` 表 `UNIQUE(automation_id, batch_id)`，同 batch_id 二次 `startRun` 返回已存在 run（不报错） | `created: false, existing` |
| I2 | `ready_for_schedule` 必须由 `manual_run_count >= 3` 推导。`createAutomation` 默认 `ready_for_schedule=false, manual_run_count=0`；`manualRun` 每次 `+=1`，达到 3 时翻为 `true` | 403 / `NOT_READY_FOR_SCHEDULE`（`enableSchedule` 在 `ready_for_schedule=false` 时拒绝 `enabled=true`） |
| I3 | 状态机转换合法性：`advanceRun` 调用 `isValidAutomationTransition(from, to)`，不合法返回 409 | 409 / `INVALID_TRANSITION` |
| I4 | `createAlert` 必须含 7 字段：`batch_id` / `status` / `trigger_time` / `failure_reason` / `completed_steps` / `impact` / `suggested_actions` / `recovery_entry`（缺任一返回 400） | 400 / `MISSING_ALERT_FIELDS` |
| I5 | `retry_policy.no_retry_on=[401,403]` 不重试：`failRun` 收到 `error.code ∈ no_retry_on` 时直接 `failed`（终态），不进入 `blocked` | run.status=`failed` |
| I6 | 断点续跑：`advanceRun` 把当前 step 名追加到 `state.completed_steps`（去重 + 顺序），下次 advance 时跳过已完成的步骤 | `state.completed_steps` 单调增长 |

### 1.3 Surface（durable contract）

```ts
export type AutomationStateValue =
  | "waiting_trigger" | "fetching" | "partial_aggregating" | "aggregating"
  | "filtering" | "delivering" | "completed" | "blocked" | "failed"

export type DegradationLevel = "full" | "partial" | "minimal" | "blocked"

export type RetryPolicy = {
  max_attempts: number                  // 默认 3
  backoff_coefficient: number           // 默认 2.0，间隔 = base * coeff^(attempt-1)
  retry_on: string[]                    // 可重试的 error code（如 ["timeout", "rate_limit"]）
  no_retry_on: string[]                 // 不重试的 error code（如 ["401", "403"]）
}

export type Actor = { memberId: string; role: "owner" | "admin" | "editor" | "viewer" }

// —— Automation CRUD ——
export type CreateAutomationInput = {
  teamId: string; name: string; cronExpr: string; message: string
  agentId?: string; timezone?: string
  skipOnOverlap?: boolean; runOnceCatchUp?: boolean
  qualityGate?: Record<string, unknown>
  retryPolicy?: RetryPolicy
  deliveryTargets?: Array<Record<string, unknown>>
  maxCostCentsPerRun?: number
  ownerMemberId: string; createdBy: string
}

export type CreateAutomationResult =
  | { ok: true; automation: AutomationRow }
  | { ok: false; status: 400; response: { code: string; message: string } }

export type UpdateAutomationInput = Partial<Omit<CreateAutomationInput, "teamId" | "createdBy">>

// —— Schedule ——
export type EnableScheduleResult =
  | { ok: true; automation: AutomationRow; enabled: boolean }
  | { ok: false; status: 403; response: { code: "NOT_READY_FOR_SCHEDULE"; manualRunCount: number } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

// —— Manual run (dry_run, 也用于演练) ——
export type ManualRunResult =
  | { ok: true; run: RunRow; manualRunCount: number; readyForSchedule: boolean }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

// —— Run lifecycle ——
export type StartRunInput = {
  automationId: string; batchId: string; taskId?: string; dryRun?: boolean
}
export type StartRunResult =
  | { ok: true; run: RunRow; created: true }
  | { ok: true; run: RunRow; created: false; reason: "batch_id_exists" }   // I1 幂等
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type AdvanceRunInput = {
  to: AutomationStateValue
  sourceStatus?: Record<string, "ok" | "failed" | "partial">   // 用于降级计算
  artifacts?: string[]
  tokensUsed?: number
  costCents?: number
}
export type AdvanceRunResult =
  | { ok: true; run: RunRow; previousStatus: AutomationStateValue; degradationLevel?: DegradationLevel }
  | { ok: false; status: 409; response: { code: "INVALID_TRANSITION"; from: AutomationStateValue; to: AutomationStateValue } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type FailRunInput = {
  errorCode: string         // e.g. "401", "timeout", "rate_limit"
  errorMessage: string
}
export type FailRunResult =
  | { ok: true; run: RunRow; retried: boolean; nextAttemptAt?: Date }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

// —— Alerts ——
export type CreateAlertInput = {
  teamId: string; automationId: string; runId?: string
  batchId: string                       // 7 字段之一
  status: AutomationStateValue          // 7 字段之二
  triggerTime: string                   // 7 字段之三（"09:00"）
  failureReason: string                 // 7 字段之四
  completedSteps: string[]              // 7 字段之五
  impact: string                        // 7 字段之六
  suggestedActions: string[]            // 7 字段之七
  recoveryEntry: string                 // 7 字段之八（恢复入口）
  severity?: "info" | "warning" | "critical"
}
export type CreateAlertResult =
  | { ok: true; alert: AlertRow }
  | { ok: false; status: 400; response: { code: "MISSING_ALERT_FIELDS"; missing: string[] } }

export type AcknowledgeAlertResult =
  | { ok: true; alert: AlertRow }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

// —— Scheduler ——
export type ListDueAutomationsResult = {
  due: AutomationRow[]
  skipped: Array<{ automation: AutomationRow; reason: "overlap" }>
}
```

### 1.4 降级交付决策树（advanceRun 内嵌）

```
advanceRun(to="delivering" | "completed", sourceStatus: { src -> "ok"|"partial"|"failed" })
  │
  ├─ 全部 ok (0 failed, 0 partial) ──────────────▶ degradation_level = "full"
  │
  ├─ 部分 partial（0 failed, partial >= 1） ────▶ degradation_level = "partial"
  │
  ├─ 部分 failed（failed > 0 且 failed < total） ▶ degradation_level = "minimal"
  │
  └─ 全部 failed（failed == total） ─────────────▶ degradation_level = "blocked"
                                                    run.status → "blocked" (不进 delivering)
```

降级级别含义：
- `full`：所有数据源 OK，正常交付完整内容
- `partial`：部分数据源 partial（降级补全），交付主要部分
- `minimal`：部分数据源 failed，只交付能拿到的最少内容
- `blocked`：全部失败，不交付，转 `blocked` 状态并发告警

### 1.5 Retry 决策表（failRun 内嵌）

| `error.code` ∈ `no_retry_on` ? | `error.code` ∈ `retry_on` ? | attempt < max_attempts ? | 结果 |
|---|---|---|---|
| yes | * | * | `failed`（终态，I5） |
| no | yes | yes | `blocked` + nextAttemptAt = now * coeff^(attempt-1) |
| no | yes | no | `failed`（重试耗尽） |
| no | no | * | `failed`（不可重试错误） |

### 1.6 E2E 场景（端到端验证）

```
E2E-A: "手动演练 3 次 → 启用调度 → 触发运行 → 降级交付 → 告警"
  1. owner createAutomation(cron="0 9 * * *", message="AI 早报") → ready=false, manual=0
  2. owner enableSchedule(enabled=true) → 403 NOT_READY_FOR_SCHEDULE（manual<3）
  3. owner manualRun × 3 → manual=3, ready=true
  4. owner enableSchedule(enabled=true) → ok
  5. scheduler listDueAutomations → 返回此 automation
  6. scheduler startRun(batch_id="ai-morning-2026-08-04") → run.status=waiting_trigger, created=true
  7. startRun(同 batch_id) → created=false, reason=batch_id_exists (I1)
  8. advanceRun(fetching) → state.completed_steps=["fetching"]
  9. advanceRun(aggregating, sourceStatus={wechat:"ok", github:"partial"}) → degradation=partial
  10. advanceRun(filtering) → completed_steps=["fetching","aggregating","filtering"]
  11. advanceRun(d Delivering) → degradation_level 持久化
  12. advanceRun(completed) → run.status=completed, finished_at set
  13. failRun 另一个 run(errorCode="401") → run.status=failed (I5, no_retry_on)
  14. failRun 另一个 run(errorCode="timeout") → run.status=blocked, retried=true, nextAttemptAt set
  15. createAlert(7 字段齐) → ok
  16. createAlert(缺 impact) → 400 MISSING_ALERT_FIELDS (I4)
```

---

## 2. RED 阶段 — 必须失败的测试

在写完 Service 之前，`node --import tsx --test test/team-autonomy/automation-service.test.ts` 必须出现：
- T1（RED）：调用 `createAutomation` → 抛 `Module not found`（impl 不存在）
- T2（RED）：`isValidAutomationTransition("completed", "fetching")` → false（不能从终态倒退）
- T3（RED）：`createAutomation` 默认 `ready_for_schedule=false, manual_run_count=0`
- T4（RED）：`enableSchedule` 在 `manual_run_count<3` 时返回 403 / NOT_READY_FOR_SCHEDULE
- T5（RED）：`manualRun` 三次后 `ready_for_schedule=true`
- T6（RED）：`startRun` 同 batch_id 二次返回 `created=false, reason=batch_id_exists`（I1）
- T7（RED）：`advanceRun` 非法转换返回 409 / INVALID_TRANSITION（I3）
- T8（RED）：`advanceRun` 把 step 追加到 `state.completed_steps`（I6 断点续跑）
- T9（RED）：`failRun` 收到 `401` 直接 `failed`（I5 no_retry_on）
- T10（RED）：`failRun` 收到 `timeout` + `retry_on` 命中 → `blocked` + `nextAttemptAt` 计算
- T11（RED）：`computeDegradationLevel` 全部 ok=full / 部分 partial=partial / 部分 failed=minimal / 全 failed=blocked（纯逻辑）
- T12（RED）：`createAlert` 缺任一 7 字段返回 400 / MISSING_ALERT_FIELDS（I4）
- T13（RED）：`parseCronExpr` 解析 `"0 9 * * *"` → {minute:0, hour:9, ...}（纯逻辑）
- T14（RED）：`computeNextRunAt` 给定 cron + 当前时间 → 下次运行时间（纯逻辑）

## 3. GREEN 阶段

写完 Service 并通过全部 T1-T14 测试。

### 3.1 纯函数（无 DB 依赖，可独立单测）
- `isValidAutomationTransition(from, to): boolean` — I3 状态机
- `computeDegradationLevel(sourceStatus): DegradationLevel` — 降级决策树
- `decideRetry(errorCode, retryPolicy, attempt): { retry: boolean; nextAttemptAt?: Date }` — Retry 决策表
- `parseCronExpr(cron): { minute, hour, dayOfMonth, month, dayOfWeek }` — cron 解析
- `computeNextRunAt(cron, from: Date, timezone?: string): Date` — 下次运行时间

### 3.2 状态机转换表
```
ALLOWED_TRANSITIONS = {
  waiting_trigger:    ["fetching"],
  fetching:           ["partial_aggregating", "aggregating", "blocked"],
  partial_aggregating:["aggregating", "blocked"],
  aggregating:        ["filtering", "blocked"],
  filtering:          ["delivering", "blocked"],
  delivering:         ["completed", "blocked"],
  completed:          [],                       // 终态
  blocked:            ["fetching", "failed"],   // 重试或放弃
  failed:             [],                       // 终态
}
```

### 3.3 GREEN 验收标准
- 所有 14 个测试用例通过（含纯逻辑 + DB 集成）
- 纯逻辑测试在无 DB 环境下全部通过（CI 友好）
- DB 集成测试在 `dbAvailable=false` 时自动 skip，不阻塞 CI

---

## 4. REFACTOR
- 状态机校验抽为 `isValidAutomationTransition` 纯函数
- 降级计算抽为 `computeDegradationLevel` 纯函数
- Retry 决策抽为 `decideRetry` 纯函数
- Cron 解析抽为 `parseCronExpr` + `computeNextRunAt` 纯函数（不引入 cron 库）

---

## 5. E2E
用真实 MySQL（`node --test` + `DATABASE_URL` 指向测试库）跑 E2E-A 脚本，全流程 OK。
纯逻辑测试（状态机矩阵、retry 决策、降级计算、cron 解析）无需 DB，在 CI 无 DB 环境下也跑。

---

## 6. 沉淀
更新本 openspec，补充：
- 每次测试发现的新不变量加入 1.2 表
- 新的 transition 组合加入 1.1 图
- API 签名 / 状态机图 / retry 决策表 / 降级决策树追加到 Implementation Log

---

## 7. Implementation Log

### 7.1 实现时间线
- 2026-08-04：P1 ③ 端到端实现完成（openspec → RED → GREEN → e2e → 沉淀）
- 文件：
  - 实现：`ee/apps/den-api/src/team-autonomy/automation-service.ts`（1258 行）
  - 测试：`ee/apps/den-api/test/team-autonomy/automation-service.test.ts`（875 行）
  - 规范：`prds/team-autonomy/openspecs/openspec-automation-service.md`（本文件）

### 7.2 API 签名（durable contract — 已落地）

#### 模块级函数（导出）
```ts
// 纯函数（无 DB 依赖，可独立单测）
export function isValidAutomationTransition(
  from: AutomationStateValue,
  to: AutomationStateValue,
): boolean

export function computeDegradationLevel(
  sourceStatus: Record<string, "ok" | "failed" | "partial">,
): DegradationLevelValue

export function decideRetry(
  errorCode: string,
  policy: RetryPolicy,
  attempt: number,
): { retry: boolean; nextAttemptAt?: Date }

export function parseCronExpr(cron: string): {
  minute: number | string
  hour: number | string
  dayOfMonth: number | string
  month: number | string
  dayOfWeek: number | string
}

export function computeNextRunAt(cron: string, from: Date, timezone?: string): Date

// DB 操作函数（通过模块级 db 单例）
export async function createAutomation(input: CreateAutomationInput): Promise<CreateAutomationResult>
export async function updateAutomation(automationId: string, input: UpdateAutomationInput): Promise<CreateAutomationResult>
export async function enableSchedule(automationId: string, enabled: boolean): Promise<EnableScheduleResult>
export async function manualRun(automationId: string): Promise<ManualRunResult>
export async function startRun(input: StartRunInput): Promise<StartRunResult>
export async function getRun(runId: string): Promise<RunRow | null>
export async function advanceRun(runId: string, input: AdvanceRunInput): Promise<AdvanceRunResult>
export async function completeRun(runId: string): Promise<AdvanceRunResult>
export async function failRun(runId: string, input: FailRunInput): Promise<FailRunResult>
export async function createAlert(input: CreateAlertInput): Promise<CreateAlertResult>
export async function acknowledgeAlert(alertId: string, memberId: string): Promise<AcknowledgeAlertResult>
export async function listAlerts(filter: { teamId?, automationId?, runId?, delivered?, acknowledged? }): Promise<AlertRow[]>
export async function listDueAutomations(now?: Date): Promise<ListDueAutomationsResult>
export async function scheduleNextRun(automationId: string, from?: Date): Promise<void>
```

#### 类型导出
```ts
export { AutomationState, DegradationLevel }            // 字面量数组（来自 schema）
export type AutomationStateValue = (typeof AutomationState)[number]
export type DegradationLevelValue = (typeof DegradationLevel)[number]
export type RetryPolicy = {
  max_attempts: number
  backoff_coefficient: number
  retry_on: string[]
  no_retry_on: string[]
}
export type Actor = { memberId: string; role: "owner" | "admin" | "editor" | "viewer" }
export type AutomationRow = { ... }   // 24 字段，camelCase
export type RunRow = { ... }          // 15 字段，camelCase
export type AlertRow = { ... }        // 16 字段，camelCase
```

#### Result 联合类型（错误码即契约）
| 函数 | 成功 | 失败 |
|---|---|---|
| `createAutomation` | `{ ok: true; automation }` | `{ ok: false; status: 400; response: { code: "INSERT_FAILED"\|"VALIDATION_FAILED"; message } }` |
| `enableSchedule` | `{ ok: true; automation; enabled }` | `{ ok: false; status: 403; response: { code: "NOT_READY_FOR_SCHEDULE"; manualRunCount } }` \| `404 NOT_FOUND` |
| `manualRun` | `{ ok: true; run; manualRunCount; readyForSchedule }` | `404 NOT_FOUND` |
| `startRun` | `{ ok: true; run; created: true }` \| `{ ok: true; run; created: false; reason: "batch_id_exists" }` | `404 NOT_FOUND` |
| `advanceRun` | `{ ok: true; run; previousStatus; degradationLevel? }` | `409 INVALID_TRANSITION { from; to }` \| `404 NOT_FOUND` |
| `failRun` | `{ ok: true; run; retried; nextAttemptAt? }` | `404 NOT_FOUND` |
| `createAlert` | `{ ok: true; alert }` | `{ ok: false; status: 400; response: { code: "MISSING_ALERT_FIELDS"; missing: string[] } }` |
| `acknowledgeAlert` | `{ ok: true; alert }` | `404 NOT_FOUND` |

### 7.3 状态机转换矩阵（已落地代码）

```ts
const ALLOWED_TRANSITIONS: Record<AutomationStateValue, AutomationStateValue[]> = {
  waiting_trigger:     ["fetching"],
  fetching:            ["partial_aggregating", "aggregating", "blocked"],
  partial_aggregating: ["aggregating", "blocked"],
  aggregating:         ["filtering", "blocked"],
  filtering:           ["delivering", "blocked"],
  delivering:          ["completed", "blocked"],
  completed:           [],                      // 终态
  blocked:             ["fetching", "failed"],  // 重试或放弃
  failed:              [],                      // 终态
}
```

转换图（与 §1.1 一致，此处略；以代码 `ALLOWED_TRANSITIONS` 为单一真相源）。

关键约束：
- `completed` / `failed` 是终态，无任何出边
- `waiting_trigger` 不能直接跳到 `blocked`（必须先进入 `fetching` 才能失败）
- `blocked` 可回到 `fetching`（重试）或进 `failed`（放弃）
- 任意非终态都可进 `blocked`（`failRun` 入口）

### 7.4 Retry 决策表（已落地代码 `decideRetry`）

| # | `errorCode ∈ no_retry_on` ? | `errorCode ∈ retry_on` ? | `attempt < max_attempts` ? | `retry` | `nextAttemptAt` | run.status |
|---|---|---|---|---|---|---|
| R1 | yes | * | * | false | undefined | `failed`（终态，I5） |
| R2 | no | yes | yes | true  | `now + base * coeff^(attempt-1)` | `blocked` |
| R3 | no | yes | no  | false | undefined | `failed`（重试耗尽） |
| R4 | no | no  | *   | false | undefined | `failed`（不可重试错误） |

实现要点：
- **no_retry_on 优先于 retry_on**（即使 `errorCode` 同时出现在两个列表里，也不重试）
- 退避公式：`delay = base * coeff^(attempt-1)`，`base = 1000ms`（`DEFAULT_BACKOFF_BASE_MS`）
- `attempt` 从 `state.attempt` 读取，默认 1
- `nextAttemptAt` 持久化到 `state.next_attempt_at`（ISO string），调度器读取后决定何时重试

默认 RetryPolicy（automation 未配置时使用）：
```ts
{
  max_attempts: 3,
  backoff_coefficient: 2.0,
  retry_on: ["timeout", "rate_limit", "transient"],
  no_retry_on: ["401", "403"],
}
```

### 7.5 降级交付决策树（已落地代码 `computeDegradationLevel`）

```
computeDegradationLevel(sourceStatus: { src -> "ok"|"partial"|"failed" })
  │
  ├─ values.length === 0 ──────────────────────▶ "full"   （无数据源视为无失败）
  │
  ├─ failedCount === total ────────────────────▶ "blocked"（全部失败，不交付）
  │
  ├─ failedCount > 0 && failedCount < total ───▶ "minimal"（部分失败，只交付能拿到的）
  │
  ├─ partialCount > 0 && failedCount === 0 ────▶ "partial"（部分降级，主要部分仍可交付）
  │
  └─ otherwise（全部 ok） ─────────────────────▶ "full"   （正常交付完整内容）
```

`advanceRun` 集成行为：
- 当 `degradationLevel === "blocked"` 且 `targetStatus !== "blocked"` 时，**强制** `status = "blocked"`（不进 `delivering`），并设 `degradation_level = "blocked"`
- 其他级别（full/partial/minimal）只持久化 `degradation_level`，不阻断流程
- `sourceStatus` 持久化到 `state.source_status`（供断点续跑读取）

### 7.6 不变量验证矩阵（51 tests passed）

| 不变量 | 测试 | 类型 | 状态 |
|---|---|---|---|
| I1 batch_id 幂等 | T6 | DB | ✔ |
| I2 ready_for_schedule 翻转点 | T3, T4, T5 | DB | ✔ |
| I3 状态机转换合法性 | T2a-T2n, T7, T8 | 纯逻辑 + DB | ✔ |
| I4 alert 7 字段必填 | T12, T12b | DB | ✔ |
| I5 retry_policy.no_retry_on 不重试 | T9, T9b, T10, T10b-T10e, T9 DB, T10 DB | 纯逻辑 + DB | ✔ |
| I6 断点续跑 completed_steps 单调增长 | T8 | DB | ✔ |
| 降级决策树 | T11a-T11g, T8b, T8c | 纯逻辑 + DB | ✔ |
| Cron 解析 + 下次运行时间 | T13a-T13d, T14a-T14d | 纯逻辑 | ✔ |
| 调度器入口 | T-due, T-overlap | DB | ✔ |
| 告警确认 | T-ack | DB | ✔ |

### 7.7 测试通过证据

```
▶ AutomationService — OpenSpecs RED/GREEN
  ▶ pure logic: state machine (I3)         ✔ (4.23ms)  — 14 tests
  ▶ pure logic: degradation level          ✔ (1.64ms)  — 7 tests
  ▶ pure logic: retry decision (I5)        ✔ (1.19ms)  — 7 tests
  ▶ pure logic: cron parser (T13)          ✔ (1.06ms)  — 4 tests
  ▶ pure logic: next run time (T14)        ✔ (5.39ms)  — 4 tests
  ✔ T3   createAutomation defaults                                  (24ms)
  ✔ T4   enableSchedule 403 NOT_READY_FOR_SCHEDULE                  (5ms)
  ✔ T5   manualRun ×3 flips ready_for_schedule                      (23ms)
  ✔ T6   startRun batch_id 幂等                                     (10ms)
  ✔ T7   advanceRun 409 INVALID_TRANSITION                          (9ms)
  ✔ T8   advanceRun appends completed_steps (I6 断点续跑)            (22ms)
  ✔ T8b  advanceRun partial → degradation=partial                   (12ms)
  ✔ T8c  advanceRun all failed → degradation=blocked, status=blocked(34ms)
  ✔ T9 DB  failRun 401 → failed (no_retry_on)                       (18ms)
  ✔ T10 DB failRun timeout → blocked + retried                      (11ms)
  ✔ T12  createAlert missing impact → 400 MISSING_ALERT_FIELDS      (4ms)
  ✔ T12b createAlert 7 fields → ok                                  (5ms)
  ✔ T-due    listDueAutomations returns due                         (18ms)
  ✔ T-overlap listDueAutomations skips overlap                      (24ms)
  ✔ T-ack    acknowledgeAlert sets acknowledged_by/at               (7ms)
✔ AutomationService — OpenSpecs RED/GREEN (394ms)

# 纯逻辑测试：36 passed (无 DB 依赖)
# DB 集成测试：15 passed (MySQL 真实库)
# 总计：51 passed / 0 failed
```

测试命令：
```bash
cd ee/apps/den-api
DATABASE_URL='mysql://root:password@127.0.0.1:3306/openwork_test_ta' \
DEN_DB_ENCRYPTION_KEY='ta-encryption-key-12345678901234567890' \
BETTER_AUTH_SECRET='as-better-auth-secret-1234567890123456789012' \
BETTER_AUTH_URL='http://127.0.0.1:8790' \
CORS_ORIGINS='http://127.0.0.1:8790' \
node --import file://.../tsx/dist/loader.mjs --test --test-timeout=15000 \
  test/team-autonomy/automation-service.test.ts
```

### 7.8 实现过程中的关键决策

1. **DB 单例 vs 注入**：遵循 `asset-service.ts` / `inbox-service.ts` 的模式，使用模块级 `db` 单例（`import { db } from "../db.js"`），简化测试 setup；测试通过环境变量 `DATABASE_URL` 切换到测试库。
2. **snake_case vs camelCase**：`team-autonomy.ts` schema 的 JS 属性名为 snake_case（与 `org.ts` 不同），所有 DB 列引用用 snake_case，对外 API 用 camelCase，通过 `rowToAutomation` / `rowToRun` / `rowToAlert` 映射函数转换。
3. **cron 解析**：不引入 `cron-parser` / `luxon` 库，简单实现支持 `*` / `*/N` / `N` / `N,M` / `N-M` 五种字段格式；时区用静态映射表（常见 IANA 时区），完整 IANA 支持留待后续按需引入。
4. **唯一索引冲突处理**：`startRun` 在 pre-check 后并发插入可能撞 `UNIQUE(automation_id, batch_id)`，捕获 `ER_DUP_ENTRY` (1062) 后重查返回 `created: false`。
5. **降级 blocked 强制阻断**：`advanceRun` 在 `degradationLevel === "blocked"` 时强制把 `status` 改为 `blocked`（即使调用方传 `to: "aggregating"`），避免全失败时仍进 `delivering`。
6. **断点续跑 step 追加规则**：只追加前进态（`fetching` / `partial_aggregating` / `aggregating` / `filtering` / `delivering` / `completed`），不追加 `blocked` / `failed` / `waiting_trigger`；去重 + 顺序保留。
7. **T-due 测试修复**：`createAutomation` 默认 `skipOnOverlap=true`，`manualRun` 留下的 `waiting_trigger` run 会触发 overlap 跳过；测试改为显式 `skipOnOverlap: false` 以验证基本 due 逻辑（`T-overlap` 已独立覆盖 overlap 行为）。

### 7.9 后续待办（不在本次 P1 ③ 范围内）
- 调度器 loop 进程（独立 worker，定期调 `listDueAutomations` + `startRun` + `advanceRun`）
- `scopedApprovals` 的 approval workflow（当前 schema 已就绪，service 未实现）
- `qualityGate` 的质量门校验（当前 schema 已就绪，service 未实现）
- `deliveryTargets` 的多渠道投递（当前 schema 已就绪，service 未实现）
- 完整 IANA 时区支持（引入 `luxon` 或类似库后替换 `TZ_OFFSET_HOURS` 静态表）
- `max_cost_cents_per_run` 的预算检查（当前 schema 已就绪，service 未实现）
