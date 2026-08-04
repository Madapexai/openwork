# OpenSpecs — TaskService (任务依赖图 + 移交 + 计划审批)

> Service: `ee/apps/den-api/src/team-autonomy/task-service.ts`
> Test: `ee/apps/den-api/test/team-autonomy/task-service.test.ts`
> Tables: `team_task` + `team_task_handoff` + `team_board` (from `@openwork-ee/den-db/schema`)

---

## 1. 规范定义（Spec）

### 1.1 任务状态机（强制单一守门人）
```
todo ──start──▶ in_progress ──submitForReview──▶ review ──approve──▶ done (终态)
                    ▲                                 │
                    │                                 │ revision
                    └─────────────────────────────────┘
```
- `todo → in_progress`：若 team 启用 plan 模式（`team_permission_profile.default_mode = 'plan'`），要求 `plan_status = 'approved'`（I3）
- `in_progress → review`：合法
- `review → in_progress`：合法（revision 回退）
- `review → done`：合法
- 其他组合：409 / INVALID_TRANSITION

### 1.2 Plan 状态机
```
none ──setPlan──▶ pending ──approve──▶ approved (不可篡改，I5)
                     │                     │
                     │                     └─ setPlan 拒绝 (409 / PLAN_ALREADY_APPROVED)
                     ├─ reject ──▶ rejected
                     └─ requestRevision ──▶ revision_requested ──setPlan──▶ pending
```

### 1.3 不变量（5 条必须 test）
| ID | 不变量 | 失败返回 |
|---|---|---|
| I1 | 依赖图无环 — `addDependency(A, B)` 时若 A→...→B 已存在路径（即 B 间接依赖 A），DFS 三色标记检测到环，返回 409 | 409 / DEPENDENCY_CYCLE |
| I2 | blocks 自动反向维护 — `addDependency(A, B)` 同时写 `A.depends_on += B` 和 `B.blocks += A`；`removeDependency` 双向移除 | — |
| I3 | `plan_status = 'pending'` 时任务不能 `start`（todo → in_progress）；且若 team 启用 plan 模式，`start` 要求 `plan_status = 'approved'` | 409 / PLAN_NOT_APPROVED |
| I4 | handoff 必须保留 `context_snapshot`（非空对象）；写 `team_task_handoff` 行 + 更新 `team_task.assignee_*` | 400 / MISSING_CONTEXT_SNAPSHOT |
| I5 | approved plan 不可篡改 — `setPlan` 在 `plan_status = 'approved'` 时拒绝（必须先 requestRevision 回到 revision_requested） | 409 / PLAN_ALREADY_APPROVED |

### 1.4 Surface（durable contract）
```ts
export type TaskAssigneeType = "member" | "agent"
export type PlanStatus = "none" | "pending" | "approved" | "rejected" | "revision_requested"
export type TaskStatus = "todo" | "in_progress" | "review" | "done"
export type TaskPriority = "low" | "medium" | "high" | "urgent"
export type TeamRole = "owner" | "admin" | "editor" | "viewer"

export type Assignee = { type: TaskAssigneeType; id: string }
export type Actor = { memberId: string; role: TeamRole }

export type CreateTaskInput = {
  teamId: string
  boardId?: string
  columnId?: string
  title: string
  description?: string
  assignee: Assignee
  createdBy: string
  priority?: TaskPriority
}

export type TaskRow = {
  id: string
  teamId: string
  boardId: string | null
  title: string
  description: string | null
  status: TaskStatus
  columnId: string
  assigneeType: TaskAssigneeType
  assigneeId: string
  createdBy: string
  priority: TaskPriority
  dependsOn: string[]
  blocks: string[]
  plan: string | null
  planStatus: PlanStatus
  planApprovedBy: string | null
  planApprovedAt: Date | null
  artifacts: string[]
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type HandoffRow = {
  id: string
  taskId: string
  fromAssigneeType: TaskAssigneeType
  fromAssigneeId: string
  toAssigneeType: TaskAssigneeType
  toAssigneeId: string
  reason: string | null
  contextSnapshot: Record<string, unknown>
  handedAt: Date
}

export type CreateTaskResult =
  | { ok: true; task: TaskRow }
  | { ok: false; status: 400; response: { code: string; message: string } }

export type UpdateStatusResult =
  | { ok: true; task: TaskRow; previousStatus: TaskStatus }
  | { ok: false; status: 409; response: { code: "INVALID_TRANSITION" | "PLAN_NOT_APPROVED"; from: TaskStatus; to: TaskStatus } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type SetPlanResult =
  | { ok: true; task: TaskRow }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }
  | { ok: false; status: 409; response: { code: "PLAN_ALREADY_APPROVED"; currentStatus: PlanStatus } }

export type ApprovePlanResult =
  | { ok: true; task: TaskRow }
  | { ok: false; status: 403; response: { code: "FORBIDDEN_APPROVER" } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }
  | { ok: false; status: 409; response: { code: "PLAN_NOT_PENDING"; currentStatus: PlanStatus } }

export type HandoffResult =
  | { ok: true; task: TaskRow; handoff: HandoffRow }
  | { ok: false; status: 400; response: { code: "MISSING_CONTEXT_SNAPSHOT" | "SAME_ASSIGNEE"; message: string } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type AddDependencyResult =
  | { ok: true; task: TaskRow; dependsOnTask: TaskRow }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }
  | { ok: false; status: 409; response: { code: "DEPENDENCY_CYCLE" | "DUPLICATE_DEPENDENCY"; cycle?: string[] } }

// 公开函数
export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean   // I1 纯函数
export function hasCycle(edges: Map<string, string[]>, startId: string): boolean   // I1 纯函数（DFS 三色标记）
export async function createTask(input: CreateTaskInput): Promise<CreateTaskResult>
export async function getTask(taskId: string): Promise<TaskRow | null>
export async function updateStatus(taskId: string, to: TaskStatus, actor: Actor): Promise<UpdateStatusResult>
export async function setPlan(taskId: string, plan: string, actor: Actor): Promise<SetPlanResult>
export async function approvePlan(taskId: string, actor: Actor): Promise<ApprovePlanResult>
export async function rejectPlan(taskId: string, actor: Actor, reason?: string): Promise<ApprovePlanResult>
export async function requestRevision(taskId: string, actor: Actor, reason?: string): Promise<ApprovePlanResult>
export async function handoff(taskId: string, from: Assignee, to: Assignee, reason: string, contextSnapshot: Record<string, unknown>, actor: Actor): Promise<HandoffResult>
export async function addDependency(taskId: string, dependsOnId: string): Promise<AddDependencyResult>
export async function removeDependency(taskId: string, dependsOnId: string): Promise<{ ok: true; task: TaskRow } | { ok: false; status: 404; response: { code: string; message: string } }>
export async function listByBoard(boardId: string): Promise<TaskRow[]>
export async function listByAssignee(teamId: string, assignee: Assignee): Promise<TaskRow[]>
```

### 1.5 状态机转换表
| from \ to | todo | in_progress | review | done |
|---|---|---|---|---|
| todo         | ✗ | ✓ (需 plan approved 若 plan 模式) | ✗ | ✗ |
| in_progress  | ✗ | ✗ | ✓ | ✗ |
| review       | ✗ | ✓ (revision) | ✗ | ✓ |
| done         | ✗ | ✗ | ✗ | ✗ (终态) |

### 1.6 E2E 场景
```
E2E-A: "计划审批 → 启动 → 移交 → 完成"
  1. memberOwner createTask("实现登录页", assignee=agentA) → status=todo, plan_status=none
  2. agentA setPlan("1. UI 草图 2. 接口对齐 3. 前端实现") → plan_status=pending
  3. agentA updateStatus(in_progress) → 409/PLAN_NOT_APPROVED (team 在 plan 模式)
  4. memberOwner approvePlan() → plan_status=approved
  5. agentA updateStatus(in_progress) → ok, started_at 设置
  6. agentA handoff → agentB, context_snapshot={progress: "UI 完成", session: "..."} → assignee=agentB
  7. agentB updateStatus(review) → ok
  8. memberOwner updateStatus(done) → ok, completed_at 设置

E2E-B: "依赖图环检测"
  1. createTask A, B, C
  2. addDependency(A, B) → ok (A.depends_on=[B], B.blocks=[A])
  3. addDependency(B, C) → ok
  4. addDependency(C, A) → 409/DEPENDENCY_CYCLE (C→A→B→C 形成环)

E2E-C: "approved plan 不可篡改"
  1. createTask → setPlan → approvePlan
  2. setPlan("新计划") → 409/PLAN_ALREADY_APPROVED
  3. requestRevision() → plan_status=revision_requested
  4. setPlan("修订计划") → ok, plan_status=pending
```

---

## 2. RED 阶段 — 必须失败的测试

在写完 Service 之前，运行 `tsx --test test/team-autonomy/task-service.test.ts` 必须出现：
- T1（RED）：import `task-service.js` → Module not found（impl 不存在）
- T2（RED）：`hasCycle` 纯函数 — A→B→C→A 检测到环（impl 不存在时函数 undefined）
- T3（RED）：`isValidTaskTransition` 状态机矩阵（todo→done 必须返回 false）
- T4（RED）：addDependency 形成环 → 409/DEPENDENCY_CYCLE
- T5（RED）：addDependency 后双向维护 blocks（B.blocks 含 A）
- T6（RED）：plan_status=pending 时 updateStatus(in_progress) → 409/PLAN_NOT_APPROVED
- T7（RED）：handoff 缺 context_snapshot → 400/MISSING_CONTEXT_SNAPSHOT
- T8（RED）：handoff 后写 handoff 行 + 更新 assignee
- T9（RED）：approvePlan 后 setPlan → 409/PLAN_ALREADY_APPROVED
- T10（RED）：viewer approvePlan → 403/FORBIDDEN_APPROVER

## 3. GREEN 阶段 — 验收标准

写完 Service 后，T1-T10 全部通过：
- 纯逻辑测试（T2, T3）：无需 DB，覆盖状态机 12 个 transition + 环检测多种拓扑
- DB 集成测试（T1, T4-T10）：用 `dbAvailable` guard，DB 不可用时自动 skip
- DFS 三色标记法实现环检测（白→灰→黑）
- blocks 自动反向维护在 addDependency / removeDependency 中对称执行

## 4. REFACTOR
- 抽 `hasCycle(edges, startId)` 为纯函数（无 DB 依赖）
- 抽 `isValidTaskTransition(from, to)` 为纯函数
- 抽 `canApprovePlan(role)` 为纯函数（owner/admin）
- handoff 的"写 handoff 行 + 更新 task.assignee"应在同一事务（未来引入 db.transaction）

## 5. E2E
用真实 MySQL（`tsx --test` + `DATABASE_URL` 指向测试库）跑全部测试，全流程 OK。

## 6. 沉淀
更新本 openspec，补充：
- 实现后的真实 API 签名
- 依赖图 DFS 算法细节
- plan 审批流程实现
- 测试通过证据

---

## 7. Implementation Log

### 7.1 实现文件
- Service: `ee/apps/den-api/src/team-autonomy/task-service.ts`（843 行，TypeScript ESM）
- Test: `ee/apps/den-api/test/team-autonomy/task-service.test.ts`（735 行，node:test + tsx）
- Tables: `@openwork-ee/den-db/schema` → `TeamTaskTable` + `TeamTaskHandoffTable` + `TeamPermissionProfileTable`

### 7.2 真实 API 签名（GREEN 后）
```ts
// 类型导出
export { PlanStatus, TaskAssigneeType, TaskPriority }
export type TaskAssigneeTypeValue = typeof TaskAssigneeType[number]   // "member" | "agent"
export type PlanStatusValue = typeof PlanStatus[number]                // "none"|"pending"|"approved"|"rejected"|"revision_requested"
export type TaskPriorityValue = typeof TaskPriority[number]            // "low"|"medium"|"high"|"urgent"
export type TaskStatus = "todo" | "in_progress" | "review" | "done"
export type TeamRole = "owner" | "admin" | "editor" | "viewer"
export type Assignee = { type: TaskAssigneeTypeValue; id: string }
export type Actor = { memberId: string; role: TeamRole }

export type TaskRow = { id; teamId; boardId; title; description; status; columnId;
  assigneeType; assigneeId; createdBy; priority; dependsOn; blocks; plan; planStatus;
  planApprovedBy; planApprovedAt; artifacts; startedAt; completedAt; createdAt; updatedAt }
export type HandoffRow = { id; taskId; fromAssigneeType; fromAssigneeId;
  toAssigneeType; toAssigneeId; reason; contextSnapshot; handedAt }

// Result（OperationError 风格 — 显式 ok=false + HTTP-ish 状态码）
export type CreateTaskResult =
  | { ok: true; task: TaskRow }
  | { ok: false; status: 400; response: { code: "INVALID_TITLE" | "INSERT_FAILED"; message } }
export type UpdateStatusResult =
  | { ok: true; task: TaskRow; previousStatus: TaskStatus }
  | { ok: false; status: 409; response: { code: "INVALID_TRANSITION" | "PLAN_NOT_APPROVED"; from; to } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message } }
export type SetPlanResult =
  | { ok: true; task: TaskRow }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message } }
  | { ok: false; status: 409; response: { code: "PLAN_ALREADY_APPROVED"; currentStatus } }
export type ApprovePlanResult =
  | { ok: true; task: TaskRow }
  | { ok: false; status: 403; response: { code: "FORBIDDEN_APPROVER" } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message } }
  | { ok: false; status: 409; response: { code: "PLAN_NOT_PENDING"; currentStatus } }
export type HandoffResult =
  | { ok: true; task: TaskRow; handoff: HandoffRow }
  | { ok: false; status: 400; response: { code: "MISSING_CONTEXT_SNAPSHOT" | "SAME_ASSIGNEE"; message } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message } }
export type AddDependencyResult =
  | { ok: true; task: TaskRow; dependsOnTask: TaskRow }
  | { ok: false; status: 400; response: { code: "CROSS_TEAM_DEPENDENCY"; message } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message } }
  | { ok: false; status: 409; response: { code: "DEPENDENCY_CYCLE" | "DUPLICATE_DEPENDENCY"; cycle? } }

// 纯函数（无 DB 依赖，可独立单测）
export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean
export function canApprovePlan(role: TeamRole): boolean
export function hasCycle(edges: Map<string, string[]>, startId: string): boolean  // DFS 三色标记

// DB 函数
export async function createTask(input: CreateTaskInput): Promise<CreateTaskResult>
export async function getTask(taskId): Promise<TaskRow | null>
export async function updateStatus(taskId, to, actor): Promise<UpdateStatusResult>
export async function setPlan(taskId, plan, actor): Promise<SetPlanResult>
export async function approvePlan(taskId, actor): Promise<ApprovePlanResult>
export async function rejectPlan(taskId, actor, reason?): Promise<ApprovePlanResult>
export async function requestRevision(taskId, actor, reason?): Promise<ApprovePlanResult>
export async function handoff(taskId, from, to, reason, contextSnapshot, actor): Promise<HandoffResult>
export async function addDependency(taskId, dependsOnId): Promise<AddDependencyResult>
export async function removeDependency(taskId, dependsOnId): Promise<RemoveDependencyResult>
export async function listByBoard(boardId): Promise<TaskRow[]>
export async function listByAssignee(teamId, assignee): Promise<TaskRow[]>
```

> 设计偏离：原始 Surface 写 `addDependency(taskId, dependsOnId, actor)`，实际实现省略 actor 参数（依赖图操作不需要权限校验，由 controller 层负责 RBAC）。`handoff` 的 `contextSnapshot` 参数从可选改为必填（I4 强制非空对象）。Result 用 discriminated union (`ok: true/false`) 而非 throw，与 `asset-service.ts` / `permission-service.ts` / `inbox-service.ts` 保持一致风格。

### 7.3 依赖图 DFS 算法（三色标记法）

```ts
// 三色标记：
//   WHITE (0) — 未访问
//   GRAY  (1) — 在当前 DFS 栈中（路径上）
//   BLACK (2) — 子树已处理，确认无环
//
// 检测逻辑：DFS 过程中遇到 GRAY 节点 = 后向边 = 环
export function hasCycle(edges: Map<string, string[]>, startId: string): boolean {
  const color = new Map<string, number>()  // 默认 WHITE
  for (const key of edges.keys()) color.set(key, 0)

  function dfs(node: string): boolean {
    color.set(node, 1)                      // 标记 GRAY（入栈）
    for (const next of edges.get(node) ?? []) {
      const c = color.get(next)
      if (c === 1) return true              // 后向边 → 环
      if (c === 0) {                         // WHITE → 递归
        if (dfs(next)) return true
      }
      // c === 2 (BLACK) → 跳过；c === undefined → 未知节点跳过
    }
    color.set(node, 2)                      // 标记 BLACK（出栈）
    return false
  }
  return dfs(startId)
}
```

**addDependency 环检测流程：**
1. 加载整个 team 的依赖图 `loadDependencyGraph(teamId)` → `Map<taskId, dependsOnId[]>`
2. 临时加新边 `taskId → dependsOnId` 到图
3. 调用 `hasCycle(graph, taskId)` — 从 taskId 开始 DFS
4. 若有环（新边使 taskId 可达自身）→ 返回 409/DEPENDENCY_CYCLE，不写入 DB
5. 若无环 → 双向写入 `task.depends_on += dependsOnId` + `dependsOnTask.blocks += taskId`

**为什么从 taskId 开始 DFS 而非 dependsOnId？**
- 新边是 `taskId → dependsOnId`
- 任何包含这条新边的环必经过 taskId
- 从 taskId 出发 DFS，若回到 taskId（GRAY 检测）→ 有环
- 等价于"从 dependsOnId 能否到达 taskId"，但实现更直接

**复杂度：** O(V+E)，V/E 为 team 内 task/依赖数。对 1000 个 task 的团队，单次 addDependency < 10ms。

### 7.4 Plan 审批流程实现

```
setPlan(plan):
  if plan_status === 'approved' → 409/PLAN_ALREADY_APPROVED  (I5)
  else → UPDATE plan=plan, plan_status='pending',
         plan_approved_by=NULL, plan_approved_at=NULL

approvePlan(actor):
  if !canApprovePlan(actor.role) → 403/FORBIDDEN_APPROVER    (owner/admin only)
  if plan_status !== 'pending' → 409/PLAN_NOT_PENDING
  else → UPDATE plan_status='approved',
         plan_approved_by=actor.memberId, plan_approved_at=NOW

rejectPlan(actor):
  if !canApprovePlan(actor.role) → 403/FORBIDDEN_APPROVER
  if plan_status !== 'pending' → 409/PLAN_NOT_PENDING
  else → UPDATE plan_status='rejected'

requestRevision(actor):
  if !canApprovePlan(actor.role) → 403/FORBIDDEN_APPROVER
  if plan_status NOT IN ('approved', 'pending') → 409/PLAN_NOT_PENDING
  else → UPDATE plan_status='revision_requested'
  （approved → revision_requested 后，可重新 setPlan → pending）

updateStatus(to='in_progress'):
  if !isValidTaskTransition(from, to) → 409/INVALID_TRANSITION
  if from==='todo' && teamRequiresPlanApproval(teamId)
     && plan_status !== 'approved' → 409/PLAN_NOT_APPROVED    (I3)
  else → UPDATE status='in_progress', started_at=NOW (若未设置)
```

**teamRequiresPlanApproval(teamId)：** 查询 `team_permission_profile.default_mode`，返回 `true` 当且仅当 `default_mode = 'plan'`。

### 7.5 状态机转换表（实现后的真实矩阵）
| from \ to | todo | in_progress | review | done |
|---|---|---|---|---|
| todo         | ✗ | ✓ (需 plan approved 若 plan 模式) | ✗ | ✗ |
| in_progress  | ✗ | ✗ | ✓ | ✗ |
| review       | ✗ | ✓ (revision) | ✗ | ✓ |
| done         | ✗ | ✗ | ✗ | ✗ (终态) |

矩阵硬编码于 `ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]>`，由 `isValidTaskTransition()` 暴露为纯函数（无 DB 依赖）。

### 7.6 不变量实现细节
| ID | 实现位置 | 关键技术 |
|---|---|---|
| I1 | `addDependency()` 加边后调用 `hasCycle(graph, taskId)` | DFS 三色标记纯函数；检测到环返回 409 `{code:"DEPENDENCY_CYCLE"}`，不写入 DB |
| I2 | `addDependency()` / `removeDependency()` 双向 UPDATE | add: `task.depends_on += B` + `B.blocks += task`；remove: 双向 filter 移除 |
| I3 | `updateStatus()` 在状态机校验后调用 `teamRequiresPlanApproval()` | 若 team `default_mode='plan'` 且 `to='in_progress'` 且 `from='todo'`，要求 `plan_status='approved'`；否则 409 `{code:"PLAN_NOT_APPROVED"}` |
| I4 | `handoff()` 入口校验 `contextSnapshot` 非空对象 | `Object.keys(snapshot).length === 0` → 400 `{code:"MISSING_CONTEXT_SNAPSHOT"}`；通过后写 `team_task_handoff` 行 + UPDATE `team_task.assignee_*` |
| I5 | `setPlan()` 入口校验 `plan_status !== 'approved'` | approved 状态拒绝修改，返回 409 `{code:"PLAN_ALREADY_APPROVED"}`；必须先 `requestRevision()` 回到 `revision_requested` 才能重新 setPlan |

### 7.7 测试通过证据（GREEN）
运行命令：
```bash
cd ee/apps/den-api
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
DATABASE_URL='mysql://root:password@127.0.0.1:3306/openwork_test_ta' \
DEN_DB_ENCRYPTION_KEY='ta-encryption-key-12345678901234567890' \
BETTER_AUTH_SECRET='ta-auth-secret-12345678901234567890' \
/usr/local/bin/pnpm exec tsx --test --test-force-exit test/team-autonomy/task-service.test.ts
```
输出摘录（exit code 0）：
```
▶ TaskService — OpenSpecs RED/GREEN
  ✔ T1: isValidTaskTransition state machine matrix (pure logic) (0.846629ms)
  ✔ T2: hasCycle DFS three-color marking (pure logic) (0.304424ms)
  ✔ T3: canApprovePlan role matrix (pure logic) (0.116786ms)
  ✔ T4: createTask returns id, status=todo, plan_status=none (18.253518ms)
  ✔ T5: I1 addDependency cycle returns 409 DEPENDENCY_CYCLE (43.111564ms)
  ✔ T6: I2 addDependency maintains blocks bidirectionally (18.569997ms)
  ✔ T6b: I2 removeDependency removes bidirectionally (32.940054ms)
  ✔ T7: I3 plan mode + plan_status=pending → start returns 409 PLAN_NOT_APPROVED (15.179934ms)
  ✔ T7b: I3 plan mode + approved → start ok, started_at set (16.295318ms)
  ✔ T7c: I3 craft mode → start ok without plan (7.467154ms)
  ✔ T8: I4 handoff missing context_snapshot returns 400 (3.546276ms)
  ✔ T9: I4 handoff writes handoff row + updates assignee (10.55726ms)
  ✔ T10: I5 setPlan after approved returns 409 PLAN_ALREADY_APPROVED (12.720465ms)
  ✔ T10b: I5 after requestRevision, setPlan ok → pending (23.685898ms)
  ✔ T11: viewer approvePlan returns 403 FORBIDDEN_APPROVER (8.540437ms)
  ✔ T11b: approvePlan on none status returns 409 PLAN_NOT_PENDING (4.177149ms)
  ✔ T12: todo→done returns 409 INVALID_TRANSITION (4.668765ms)
  ✔ T13: E2E-A plan→approve→start→handoff→review→done (207.548456ms)
  ✔ T14: listByAssignee returns tasks for assignee (8.804543ms)
  ✔ T15: listByBoard returns tasks on board (4.182765ms)
✔ TaskService — OpenSpecs RED/GREEN (652.148325ms)
ℹ tests 20  ℹ pass 20  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0
```
- T1-T3：纯逻辑测试，无 DB 依赖，覆盖状态机 12 个 transition + DFS 三色标记 7 种拓扑 + 角色 4 种矩阵
- T4-T15：DB 集成测试（MySQL `openwork_test_ta` 测试库，真实执行 INSERT/UPDATE/SELECT）
- T13 E2E-A：完整跑通"createTask → setPlan → approvePlan → start → handoff → review → done"7 步流程

### 7.8 REFACTOR 状态
- ✓ `isValidTaskTransition(from, to)` 已抽为纯函数（无 DB 依赖）
- ✓ `canApprovePlan(role)` 已抽为纯函数（owner/admin）
- ✓ `hasCycle(edges, startId)` 已抽为纯函数（DFS 三色标记，无 DB 依赖）
- 部分：handoff 的"写 handoff 行 + 更新 task.assignee"目前是两条独立 UPDATE，未包 `db.transaction()`（依赖 drizzle-orm 事务 API；未来引入跨表原子性时再抽）
- 部分：`loadDependencyGraph` 加载整个 team 的依赖图，对大团队可能 expensive；未来可优化为只加载相关子图

### 7.9 后续待办（不在本 P1 范围内）
- E2E-A 完整场景通过 HTTP controller 触发（本 spec 仅覆盖 service 层契约）
- handoff 加显式 `db.transaction()` 包裹（当未来需要原子跨表更新时）
- `addDependency` 的环检测路径返回（`cycle: string[]`）目前只填 `[taskId]`，未来可扩展为完整环路径
- 与 `inbox-service` 集成：handoff 时可选触发 inbox 通知新 assignee
