# OpenSpecs — BudgetService（P3-B 端到端）

> Service: `ee/apps/den-api/src/team-autonomy/budget-service.ts`
> Test: `ee/apps/den-api/test/team-autonomy/budget-service.test.ts`
> Tables: `team_budget` + `team_budget_allocation`（from `@openwork-ee/den-db/schema`）
>
> 设计依据：
> - WorkBuddy Bluebook Ch5：管理员 / 编辑者 / 查看者三级 + Token 预算
> - 角色级配额（role/member/agent 三级 allocation，`team_budget_allocation` 表）
> - 原子条件更新（`UPDATE ... SET used = used + ? WHERE used + ? <= total`，affectedRows=0 → 拒绝）
> - 借鉴 operational-errors 风格：Result discriminated union + HTTP-ish 状态码
>
> 前置：P2 已实现 `allocateBudget` / `recordUsage(input)` / `checkBudget` / `resetBudgetIfDue`。
> 本 openspec 在既有实现上补齐 P3 能力：**allocation 级配额** + **原子条件更新** + 任务要求的新 API 面
> （`createBudget` / `recordUsage(teamId, entity, tokens, cost)` / `recordConsumption` / `resetIfDue` / `listAllocations`）。

---

## 1. 规范定义（Spec）

### 1.1 不变量（4 条必须 test）

| ID | 不变量 | 失败返回 |
|---|---|---|
| I1 | budget 周期唯一 `team_id + period`（`team_budget_team_period` 唯一索引）；`createBudget` 幂等 upsert，同 team 同 period 复用同一行 | — |
| I2 | `used_tokens` ≤ `total_tokens`（且 `used_cost_cents` ≤ `total_cost_cents`）；`recordUsage` 用原子条件更新 `SET used_tokens = used_tokens + ? WHERE used_tokens + ? <= total_tokens`，affectedRows=0 → 拒绝 | 409 / BUDGET_EXCEEDED |
| I3 | allocation 消耗不超过 budget 自身配额：`recordConsumption` 原子更新 allocation（`WHERE used_tokens + ? <= allocated_tokens`）；`recordUsage(teamId, entity, …)` 同时受 budget 上限 + allocation 上限约束（两表原子更新，任一失败整体回滚） | 409 / ALLOCATION_EXCEEDED |
| I4 | budget `reset_at` 到期后自动重置 `used_tokens=0, used_cost_cents=0` + 推进 `reset_at`（`resetIfDue`，按 period：daily+1d / weekly+7d / monthly+30d） | — |

### 1.2 流程

```
allocateBudget / createBudget(teamId, period, totalTokens, totalCostCents)
   ├─ SELECT budget WHERE team_id + period
   │    ├─ 存在 → UPDATE totals（保留 used）→ created=false（I1 幂等）
   │    └─ 不存在 → INSERT → created=true

allocateToEntity(teamId, entity, allocatedTokens)          ← I3 支撑（upsert allocation）
   ├─ SELECT budget WHERE team_id（无 → 404 BUDGET_NOT_FOUND）
   ├─ SELECT allocation WHERE budget_id + entity_type + entity_id
   │    ├─ 存在 → UPDATE allocated_tokens
   │    └─ 不存在 → INSERT

recordUsage(teamId, entity, tokens, cost)                   ← I2 + I3 原子
   ├─ resetIfDue(teamId)（I4 先自动重置）
   ├─ SELECT budget（无 → 404 BUDGET_NOT_FOUND）
   ├─ SELECT allocation（entity 无 allocation → 只受 budget 约束）
   ├─ db.transaction：
   │    ├─ UPDATE budget SET used+=tokens WHERE used + tokens <= total 且 cost 同理
   │    │    └─ affectedRows=0 → 409 BUDGET_EXCEEDED（I2，事务回滚）
   │    └─ allocation 存在 → UPDATE allocation SET used+=tokens
   │         WHERE used + tokens <= allocated_tokens
   │         └─ affectedRows=0 → 409 ALLOCATION_EXCEEDED（I3，事务回滚）
   └─ 返回 { ok: true, budget, allocation? }

recordConsumption(budgetId, entity, tokens)                 ← I3 原子（allocation 单独消耗）
   ├─ UPDATE allocation SET used+=tokens WHERE used + tokens <= allocated_tokens
   │    └─ affectedRows=0 → 409 ALLOCATION_EXCEEDED
   └─ 返回 { ok: true, allocation }

resetIfDue(teamId, now?)                                    ← I4（= resetBudgetIfDue 别名）
listAllocations(budgetId)                                   ← 查询全部 allocation
```

### 1.3 Surface（durable contract）

```ts
// ---------- Budget（P3-B）----------
export type BudgetEntity = { type: BudgetEntityTypeValue; id: string } // type: "member" | "agent" | "role"

export type CreateBudgetResult =
  | { ok: true; budget: BudgetRow; created: boolean }
  | { ok: false; status: 400 | 403; response: { code: string; message: string } }

export type AllocationRow = {
  id: string
  budgetId: string
  entityType: BudgetEntityTypeValue
  entityId: string
  allocatedTokens: number
  usedTokens: number
  createdAt: Date
  updatedAt: Date
}

export type RecordUsageResult =
  | { ok: true; budget: BudgetRow; allocation?: AllocationRow }
  | { ok: false; status: 404 | 409; response: { code: string; message: string } }

export function createBudget(input: AllocateBudgetInput): Promise<CreateBudgetResult>          // I1 幂等 upsert
export function allocateToEntity(
  teamId: string,
  entity: BudgetEntity,
  allocatedTokens: number,
): Promise<{ ok: true; allocation: AllocationRow } | { ok: false; status: 404 | 409; response: { code: string; message: string } }>
export function recordUsage(input: RecordUsageInput): Promise<RecordUsageResult>               // P2 兼容（团队级原子）
export function recordUsage(teamId: string, entity: BudgetEntity, tokens: number, cost: number): Promise<RecordUsageResult> // I2+I3（entity 级原子）
export function recordConsumption(
  budgetId: string,
  entity: BudgetEntity,
  tokens: number,
): Promise<{ ok: true; allocation: AllocationRow } | { ok: false; status: 404 | 409; response: { code: string; message: string } }>
export function resetIfDue(teamId: string, now?: Date): Promise<{ reset: boolean; budget?: BudgetRow }> // I4
export function listAllocations(budgetId: string): Promise<AllocationRow[]>
```

### 1.4 E2E 场景（端到端验证）

```
E2E-P3B: "团队预算 + entity allocation 全链路"
  1. createBudget({teamId, period:'monthly', totalTokens:1000, totalCostCents:1000})
     → created=true
  2. createBudget({teamId, period:'monthly', totalTokens:2000, ...})（同 team+period）
     → created=false，同一行（I1）
  3. allocateToEntity(teamId, {type:'agent', id:agentA}, 400) → ok（I3）
  4. recordUsage(teamId, {type:'agent', id:agentA}, 500, 500)
     → budget used=500/1000，allocation used=500/400 超 allocation → 409 ALLOCATION_EXCEEDED
     → 数据不变（事务回滚）
  5. recordUsage(teamId, {type:'agent', id:agentA}, 300, 300)
     → ok：budget used=300，allocation used=300（I2+I3）
  6. recordUsage(teamId, {type:'member', id:memberX}, 900, 0)（memberX 无 allocation）
     → 300+900=1200 > 1000 → 409 BUDGET_EXCEEDED（I2 原子）
  7. recordUsage(teamId, {type:'member', id:memberX}, 700, 0)
     → ok：budget used=1000（打满 ==total 允许，I2 ≤ 语义）
  8. recordConsumption(budget.id, {type:'agent', id:agentA}, 200)（allocation 400 已用 300）
     → 300+200=500 > 400 → 409 ALLOCATION_EXCEEDED（I3）
  9. listAllocations(budget.id) → 1 条（agentA / allocated=400 / used=300）
 10. resetIfDue(teamId, now=resetAt+1d)
     → reset=true，used=0，reset_at 推进（I4）
```

---

## 2. RED 阶段 — 必须失败的测试

`node --import tsx --test test/team-autonomy/budget-service.test.ts` 在实现前必须失败：

- T1（RED）：`createBudget` → `Function not implemented`（新 API）
- T2（RED）：`allocateToEntity` → `Function not implemented`
- T3（RED）：`recordUsage(teamId, entity, tokens, cost)` 实体形式 → `Function not implemented`
- T4（RED）：`recordConsumption` → `Function not implemented`
- T5（RED）：`resetIfDue` → `Function not implemented`
- T6（RED）：`listAllocations` → `Function not implemented`

GREEN 后（DB 可用）验证：
- T1：createBudget 幂等 upsert（I1）
- T2：recordUsage 实体形式 — allocation 超额 → 409 ALLOCATION_EXCEEDED 且数据回滚（I3）
- T3：recordUsage 实体形式 — 团队级超额 → 409 BUDGET_EXCEEDED（I2 原子）
- T4：recordUsage 打满（used == total 允许）→ ok（I2 ≤ 语义）
- T5：recordConsumption 超额 → 409 ALLOCATION_EXCEEDED（I3）
- T6：resetIfDue 到期自动重置（I4）
- T7：listAllocations 返回全部（I3）

## 3. GREEN 阶段

- `createBudget`：包装 `allocateBudget`（I1 幂等 upsert，同 team+period 唯一）
- `recordUsage` 重载：
  - 对象形式（P2 兼容）：改为**原子条件更新** `SET used = used + ? WHERE used + ? <= total`，
    affectedRows=0 → 409 `BUDGET_EXCEEDED`（任务要求：允许打满 ==total，≤ 语义）
  - 实体形式 `(teamId, entity, tokens, cost)`：先 `resetIfDue`，再 `db.transaction` 内
    原子更新 budget + allocation（任一 affectedRows=0 → 对应 409，整体回滚）
- `allocateToEntity(teamId, entity, allocatedTokens)`：upsert `team_budget_allocation`（I3 支撑）
- `recordConsumption(budgetId, entity, tokens)`：原子更新 allocation（`WHERE used + ? <= allocated`），
  affectedRows=0 → 409 `ALLOCATION_EXCEEDED`
- `resetIfDue`：别名导出 `resetBudgetIfDue`（I4）
- `listAllocations(budgetId)`：`SELECT team_budget_allocation WHERE budget_id`
- 错误码：`BUDGET_NOT_FOUND` / `BUDGET_EXCEEDED` / `ALLOCATION_EXCEEDED`

## 4. REFACTOR

- `extractAffectedRows` 复用现有内部函数
- 原子条件用 `sql` 模板：`sql\`used_tokens + ${tokens} <= total_tokens\``
- 事务用 `db.transaction(async (tx) => …)`；事务内 throw 标记（如 `__ALLOCATION_EXCEEDED__`）回滚后映射为 409

## 5. E2E

- 纯逻辑测试（computeNextResetAt / shouldResetBudget / isBudgetExceeded / budgetExceedReason）无需 DB
- DB 测试用 `dbAvailable` guard（同 `sidecar-personal-budget.test.ts` 模式）
- 兼容性回归：P2 的 `sidecar-personal-budget.test.ts` T13/T14/T15 必须继续通过（对象形式 recordUsage）

## 6. 沉淀

- 实现后把实际签名、原子 SQL、事务边界追加到本 openspec 的 "Implementation Log"。

---

## 7. Implementation Log

### GREEN 实现（2026-08-04）
- 文件：`ee/apps/den-api/src/team-autonomy/budget-service.ts`（在 P2 基础上扩展，保持 P2 签名兼容：`allocateBudget/getBudget/checkBudget/resetBudgetIfDue` 原样保留）
- P3 导出签名：
  - `createBudget(input: AllocateBudgetInput): Promise<CreateBudgetResult>`（= allocateBudget 幂等 upsert，I1）
  - `recordUsage` 三重重载：`(input: RecordUsageInput)`（team 级，P2 语义）/ `(teamId, entity: BudgetEntity, tokens: number, costCents: number)`（实体级，P3）/ 无参形式（recordTeamUsage 内部）
  - `recordConsumption(budgetId: string, entity: BudgetEntity, tokens: number, costCents: number)`（allocation 原子消耗）
  - `resetIfDue(teamId: string)`（I4 别名，= `resetBudgetIfDue`）
  - `listAllocations(budgetId: string): Promise<AllocationRow[]>`
  - `allocateToEntity(budgetId: string, entity: BudgetEntity, allocatedTokens: number)`（allocation upsert）
- 原子性落实：
  - team 级（I2）：`UPDATE team_budget SET used_tokens = used_tokens + ?, used_cost_cents = used_cost_cents + ? WHERE id = ? AND used_tokens + ? <= total_tokens AND used_cost_cents + ? <= total_cost_cents`，affectedRows=0 → 409 BUDGET_EXCEEDED（`extractAffectedRows` 兼容 affectedRows/rowsAffected/数组）
  - 实体级（I3）：`db.transaction` 内先校验 allocation（`used_tokens + ? <= allocated_tokens` 等），双表原子更新，任一 affectedRows=0 抛标记类 `RecordUsageRejected` → 回滚 → 409 ALLOCATION_EXCEEDED
  - 允许打满（≤ 语义，used == total 不超额）
- I4：`recordEntityUsage` 前置 `resetIfDue`；`resetBudgetIfDue` 到期 `UPDATE used_tokens=0, used_cost_cents=0, reset_at=computeNextResetAt(period, reset_at)`
- 错误码：409 BUDGET_EXCEEDED / 409 ALLOCATION_EXCEEDED / 404 BUDGET_NOT_FOUND / 400 INVALID_ALLOCATION / 400 ALLOCATION_EXCEEDS_BUDGET
- 测试：`ee/apps/den-api/test/team-autonomy/budget-service.test.ts`（T0a/T0b/T1-T7，GREEN 9/9）
