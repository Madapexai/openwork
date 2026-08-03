# AutomationService — 自动化状态机 + 降级交付 + 可行动告警

> Status: Draft for scoping · Owner: team-autonomy · Schema: `team-autonomy.ts` (已落地)

## Goal

实现 WorkBuddy Bluebook Ch25 的"从能用到可靠的工程级方法论"。AutomationService 是团队自动化的运行时核心，负责：

1. **状态机驱动**：每条自动化运行都是一个可断点续跑的状态机。
2. **降级交付**：单一源失败不能整条流水线挂掉，要分级降级。
3. **可行动告警**：失败告警必须含 7 字段，能直接点链接恢复。
4. **上线门禁**：3 次手动跑过 + 5 场景演练后才能开启 cron。

## Short Answer

- **借鉴 LangGraph Checkpoint**：`team_automation_run.state` JSON 存储已完成步骤和当前状态，崩溃后可从断点恢复。
- **借鉴 Temporal RetryOptions**：`team_automation.retry_policy` JSON 配置超时 + 退避 + no_retry_on（401/403 不重试）。
- **幂等**：`(automation_id, batch_id)` 唯一索引保证同一批次不重复执行。
- **降级三档**：`full`（所有源 OK）→ `partial`（部分源 OK）→ `minimal`（仅 1 源 OK）→ `blocked`（全失败）。
- **告警必含 7 字段**：批次 ID / 状态 / 触发时间 / 失败原因 / 已完成步骤 / 影响 / 建议处理 / 恢复入口。

## Recommendation

放路径：`ee/apps/den-api/src/team-autonomy/automation-service.ts`，调度器放 `ee/apps/den-api/src/workers/automation-scheduler.ts`（与现有 `cloud-lifecycle.ts` / `reconciler.ts` 同级）。

## Data Model

参见 [team-autonomy.ts](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts)：

- `TeamAutomationTable`（[L349-L389](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts#L349-L389)）— 自动化定义（cron / agent / retry_policy / delivery_targets / 上线门禁字段）
- `TeamAutomationRunTable`（[L391-L422](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts#L391-L422)）— 单次运行（state JSON / degradation_level / batch_id 幂等）
- `TeamAutomationAlertTable`（[L426-L458](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts#L426-L458)）— 可行动告警

状态机：

```
waiting_trigger ──▶ fetching ──▶ aggregating ──▶ filtering ──▶ delivering ──▶ completed
                       │              │              │              │
                       ▼              ▼              ▼              ▼
                 partial_aggregating (某源失败但其他 OK)
                       │
                       ▼
                   blocked ──▶ failed (重试耗尽)
                       
任何阶段失败 ──▶ 写 alert ──▶ blocked 或继续降级
```

## Surface（durable contract）

```ts
// ee/apps/den-api/src/team-autonomy/automation-service.ts

export type AutomationId = string
export type AutomationRunId = string
export type AutomationState =
  | "waiting_trigger" | "fetching" | "partial_aggregating" | "aggregating"
  | "filtering" | "delivering" | "completed" | "blocked" | "failed"
export type DegradationLevel = "full" | "partial" | "minimal" | "blocked"

// ---------- 自动化 CRUD ----------
export async function createAutomation(
  input: CreateAutomationInput,
  creator: { memberId: string; role: "owner" | "admin" },
): Promise<AutomationRow>

export async function updateAutomation(
  automationId: string,
  patch: Partial<UpdateAutomationInput>,
  actor: { memberId: string; role: "owner" | "admin" },
): Promise<AutomationRow>

// ---------- 上线门禁 ----------
// WorkBuddy Ch25：上线前必须跑过 3 次手动 + 5 场景演练
export async function runManualDryRun(
  automationId: string,
  actor: { memberId: string },
): Promise<{ runId: string; dryRun: true; result: DryRunResult }>

export async function markReadyForSchedule(
  automationId: string,
  actor: { memberId: string; role: "owner" | "admin" },
): Promise<
  | { ok: true; automation: AutomationRow }
  | { ok: false; status: 409; response: { code: "GATE_NOT_MET"; manualRunCount: number; scenariosPassed: number } }
>

// ---------- 调度器入口 ----------
// 由 cron worker 调用，扫 enabled=true && ready_for_schedule=true && next_run_at<=now
export async function pollDueAutomations(now: Date): Promise<AutomationRow[]>

// 启动一次运行（写 team_automation_run，初始 state={ completed: [], current: "fetching" }）
export async function startRun(
  automationId: string,
  batchId: string,
): Promise<
  | { ok: true; run: RunRow }
  | { ok: false; status: 409; response: { code: "BATCH_ALREADY_PROCESSED"; existingRunId: string } }
>

// ---------- 状态机推进 ----------
// 通用推进器：根据当前 state 和事件决定下一步
export async function advanceRun(
  runId: string,
  event: AdvanceEvent,
): Promise<RunRow>

export type AdvanceEvent =
  | { type: "fetch_succeeded"; source: string; itemCount: number }
  | { type: "fetch_failed"; source: string; error: string }
  | { type: "all_fetches_done" }
  | { type: "filter_done"; keptCount: number; droppedCount: number }
  | { type: "delivery_succeeded"; target: string }
  | { type: "delivery_failed"; target: string; error: string }

// 断点续跑：从 state.completed 的下一步开始
export async function resumeRun(runId: string): Promise<RunRow>

// ---------- 降级决策 ----------
// 根据各源 fetch 结果决定 degradation_level
export function computeDegradationLevel(
  sourceStatus: Record<string, "ok" | "failed">,
): DegradationLevel

// ---------- 可行动告警 ----------
export async function createAlert(
  runId: string,
  alert: {
    failureReason: string
    completedSteps: string[]
    impact: string
    suggestedActions: string[]
    recoveryEntry: string
    severity?: "info" | "warning" | "critical"
  },
): Promise<AlertRow>

export async function listPendingAlerts(teamId: string): Promise<AlertRow[]>
export async function acknowledgeAlert(alertId: string, memberId: string): Promise<AlertRow>
```

## 关键不变量

1. **幂等**：`startRun` 用 `UNIQUE(automation_id, batch_id)` 防重复，第二次调用返回 409 + 已存在的 runId。
2. **state 必须可序列化**：`team_automation_run.state` 只能放 JSON 可序列化数据，禁止 Date / 函数 / 循环引用。
3. **断点续跑**：`resumeRun` 必须从 `state.completed` 的下一步开始，不重做已完成步骤。
4. **降级决策确定性**：`computeDegradationLevel` 是纯函数，相同输入永远相同输出。
5. **告警 7 字段强制**：`createAlert` 的入参 schema 必须强制 `failureReason / completedSteps / impact / suggestedActions / recoveryEntry` 非空，`suggestedActions` 至少 1 条。
6. **上线门禁**：`markReadyForSchedule` 必须校验 `manual_run_count >= 3`，否则 409。
7. **no_retry_on**：retry_policy 中 `no_retry_on: [401, 403]` 命中时直接 `failed`，不重试。

## 调度器实现

```ts
// ee/apps/den-api/src/workers/automation-scheduler.ts
// 与 cloud-lifecycle.ts / reconciler.ts 同级的 cron worker

const logger = appLogger.child({ component: "automation-scheduler" })

export async function runAutomationTick(now = new Date()) {
  const due = await pollDueAutomations(now)
  for (const automation of due) {
    const batchId = `${automation.id}-${formatDate(now, automation.timezone)}`
    const started = await startRun(automation.id, batchId)
    if (!started.ok) {
      // 已处理过这个批次，跳过
      continue
    }
    // 异步推进，不阻塞 tick
    void runAutomationPipeline(started.run.id).catch((err) =>
      createAlert(started.run.id, {
        failureReason: `Pipeline threw: ${err.message}`,
        completedSteps: [],
        impact: "本次自动化未产出任何结果",
        suggestedActions: ["检查 agent 日志", "重试运行"],
        recoveryEntry: `/teams/${automation.teamId}/automations/${automation.id}/runs/${started.run.id}`,
        severity: "critical",
      }),
    )
  }
}

async function runAutomationPipeline(runId: string) {
  // 阶段 1: fetching（多源并发）
  // 阶段 2: aggregating（合并 + 去重）
  // 阶段 3: filtering（quality_gate 过滤）
  // 阶段 4: delivering（多目标推送，每目标独立失败）
  // 每阶段结束调用 advanceRun 持久化 state
}
```

## HTTP 路由

| Method | Path | operationId |
|---|---|---|
| POST | `/v1/teams/{teamId}/automations` | `createAutomation` |
| GET | `/v1/teams/{teamId}/automations` | `listAutomations` |
| GET | `/v1/teams/{teamId}/automations/{id}` | `getAutomation` |
| PATCH | `/v1/teams/{teamId}/automations/{id}` | `updateAutomation` |
| POST | `/v1/teams/{teamId}/automations/{id}/dry-runs` | `runManualDryRun` |
| POST | `/v1/teams/{teamId}/automations/{id}/mark-ready` | `markReadyForSchedule` |
| GET | `/v1/teams/{teamId}/automations/{id}/runs` | `listRuns` |
| GET | `/v1/teams/{teamId}/automations/{id}/runs/{runId}` | `getRun` |
| POST | `/v1/teams/{teamId}/automations/{id}/runs/{runId}/resume` | `resumeRun` |
| GET | `/v1/teams/{teamId}/automation-alerts` | `listPendingAlerts` |
| POST | `/v1/teams/{teamId}/automation-alerts/{alertId}/acknowledge` | `acknowledgeAlert` |

## Test Plan

- **状态机覆盖**：每个 state × 每种 event 的转换矩阵。
- **断点续跑**：人为在 fetching 阶段崩溃，验证 resumeRun 从断点继续。
- **幂等**：并发调用 `startRun` 同一 batchId，验证只有一次成功。
- **降级矩阵**：3 源 × 8 种失败组合，验证 degradation_level 计算正确。
- **告警 7 字段**：尝试缺字段创建 alert，验证 schema 拒绝。
- **上线门禁**：manual_run_count=2 时 markReadyForSchedule 返回 409。
- **no_retry_on**：mock 401 响应，验证不重试直接 failed。
- **E2E**：从 cron 触发到 alert 产生的完整流程。
