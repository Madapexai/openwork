# OpenSpecs — TeamAgentService（团队 Agent 池 + 角色契约 + forbidden_actions 守门）

> Service: `ee/apps/den-api/src/team-autonomy/team-agent-service.ts`
> Test: `ee/apps/den-api/test/team-autonomy/team-agent-service.test.ts`
> Tables: `team_agent` + `team_role` + `team_task`（来自 `@openwork-ee/den-db/schema`）
> TypeID: `teamAgent=tagt`、`teamRole=trol`、`teamTask=ttsk`

---

## 1. 规范定义（Spec）

### 1.1 角色
WorkBuddy Bluebook Ch24 角色契约：每个 agent 持有 `role_id`（指向 `team_role`）、`persona`、`skills[]`、`connectors[]`、`forbidden_actions[]`。

### 1.2 不变量（5 条必须 test）
| ID | 不变量 | 失败返回 |
|---|---|---|
| I1 | `forbidden_actions` 不可被 agent 自身修改；只能由 team member（owner/admin）通过 `updateAgent` 设置 | 403 / FORBIDDEN_ACTION_SELF_MODIFY |
| I2 | `status=busy` 时 `current_task_id` 必须非空；`assignTask` 原子置 `current_task_id` + `status=busy`；`unassignTask` 原子清空两者 | 409 / INCONSISTENT_STATE |
| I3 | `role_id` 必须属于同 `team_id`（防跨团队污染） | 400 / CROSS_TEAM_ROLE |
| I4 | 删除 agent 前 `current_task_id` 必须为空（先 `unassignTask` 再 `deleteAgent`） | 409 / AGENT_HAS_TASK |
| I5 | `skills` / `connectors` 必须是有效 `ConfigObject` id 列表（字符串数组、可空） | 400 / INVALID_CONFIG_OBJECT_REF |

### 1.3 状态机
```
idle ──assignTask──▶ busy ──unassignTask──▶ idle
  │                    │
  │ pauseAgent         │ pauseAgent
  ▼                    ▼
paused ◀──resumeAgent──▶ paused
                              │
                              │ (idle ↔ busy ↔ paused 任意状态可 → offline / error)
                              ▼
                          offline / error
```
合法转换：
- `idle ↔ busy`（`assignTask` / `unassignTask`）
- `idle/busy ↔ paused`（`pauseAgent` / `resumeAgent`）
- 任意 → `offline` / `error`（外部系统触发，本 service 暴露 `setStatus`）
- `paused` 不可直接 `busy`（必须先 `resumeAgent` 回到 `idle`）

### 1.4 角色契约执行点
Agent 执行工具前**必须**调用 `checkForbiddenAction(agentId, actionName)`：
- 命中 `forbidden_actions` 数组 → 返回 `{ forbidden: true, action }`，调用方必须拒绝执行
- 未命中 → `{ forbidden: false }`，继续后续 permission 检查
- agent 不存在 → `{ forbidden: false, exists: false }`（其他层处理）

匹配规则：`forbidden_actions.includes(actionName)`，支持 glob（`*` → `.*`，`?` → `.`）可选；当前实现默认精确匹配，glob 作为 `checkForbiddenAction` 的可选参数。

### 1.5 Surface（durable contract）
```ts
export type AgentEngine = "openworker" | "opencode" | "mcp" | "generic"
export type AgentStatus = "idle" | "busy" | "paused" | "offline" | "error"
export type TeamRole = "owner" | "admin" | "editor" | "viewer"

export type Actor = { memberId: string; role: TeamRole }

export type AgentRow = {
  id: string; teamId: string; name: string; engine: AgentEngine; roleId: string | null
  persona: string | null; skills: string[] | null; connectors: string[] | null
  modelDefault: string | null; status: AgentStatus; sidecarSessionId: string | null
  forbiddenActions: string[] | null; currentTaskId: string | null
  createdAt: Date; updatedAt: Date
}

export type CreateAgentInput = {
  teamId: string; name: string; engine: AgentEngine; roleId?: string
  persona?: string; skills?: string[]; connectors?: string[]; modelDefault?: string
  forbiddenActions?: string[]
}

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, "teamId">>

export function createAgent(input: CreateAgentInput, actor: Actor)
  → { ok: true; agent: AgentRow } | { ok: false; status: 400 | 403; response: { code, message } }
export function updateAgent(id: string, patch: UpdateAgentInput, actor: Actor)
  → { ok: true; agent: AgentRow } | { ok: false; status: 400 | 403 | 404; response: { code, message } }
export function deleteAgent(id: string, actor: Actor)
  → { ok: true } | { ok: false; status: 403 | 404 | 409; response: { code, message } }
export function pauseAgent(id: string, actor: Actor)
  → { ok: true; agent: AgentRow } | { ok: false; status: 409 | 404; response: { code, message } }
export function resumeAgent(id: string, actor: Actor)
  → { ok: true; agent: AgentRow } | { ok: false; status: 409 | 404; response: { code, message } }
export function assignTask(id: string, taskId: string, actor: Actor)
  → { ok: true; agent: AgentRow } | { ok: false; status: 400 | 404 | 409; response: { code, message } }
export function unassignTask(id: string, actor: Actor)
  → { ok: true; agent: AgentRow } | { ok: false; status: 404 | 409; response: { code, message } }
export function listByTeam(teamId: string): Promise<AgentRow[]>
export function getById(id: string): Promise<AgentRow | null>
export function checkForbiddenAction(agentId: string, actionName: string, opts?: { glob?: boolean })
  → { forbidden: boolean; action?: string; exists: boolean }
```

### 1.6 E2E 场景
```
E2E-TA: "Agent 创建 + 任务分配 + forbidden_action 守门"
  1. memberOwner createAgent("worker", engine="openworker", forbiddenActions=["delete_file"]) → idle
  2. checkForbiddenAction(agentId, "delete_file") → forbidden=true (I1 命中)
  3. checkForbiddenAction(agentId, "read_file") → forbidden=false
  4. assignTask(agentId, taskId) → status=busy, current_task_id=taskId (I2)
  5. agent 尝试 updateAgent 自身 forbiddenActions=[] → 403 (I1)
  6. memberOwner updateAgent forbiddenActions=["delete_file","drop_table"] → ok
  7. deleteAgent(agentId) → 409 AGENT_HAS_TASK (I4)
  8. unassignTask(agentId) → status=idle, current_task_id=null
  9. deleteAgent(agentId) → ok
 10. createAgent(roleId=otherTeamRoleId) → 400 CROSS_TEAM_ROLE (I3)
 11. createAgent(skills=["not-a-cob-id"]) → 400 INVALID_CONFIG_OBJECT_REF (I5)
```

---

## 2. RED 阶段 — 必须失败的测试
在写完 Service 之前：
- T1（RED）：调用 `createAgent` → 抛 `Module not found`
- T2（RED）：`createAgent` 默认 status=idle
- T3（RED）：`assignTask` 后 status=busy, current_task_id 非空（I2）
- T4（RED）：`unassignTask` 后 status=idle, current_task_id=null（I2）
- T5（RED）：`deleteAgent` 时 current_task_id 非空 → 409 AGENT_HAS_TASK（I4）
- T6（RED）：`createAgent` 用跨 team 的 roleId → 400 CROSS_TEAM_ROLE（I3）
- T7（RED）：agent 自身调 `updateAgent` 改 forbiddenActions → 403 FORBIDDEN_ACTION_SELF_MODIFY（I1）
- T8（RED）：`createAgent` skills 非法（含非字符串） → 400 INVALID_CONFIG_OBJECT_REF（I5）
- T9（RED）：`checkForbiddenAction` 命中返回 forbidden=true
- T10（RED）：`pauseAgent` idle→paused 合法；busy→paused 合法；paused→paused → 409 INVALID_TRANSITION
- T11（RED）：`resumeAgent` paused→idle 合法；idle→idle → 409 INVALID_TRANSITION
- T12（RED）：纯逻辑测试（`isValidStatusTransition`、`matchForbiddenAction`）无需 DB

## 3. GREEN 阶段
写完 Service 并通过全部 T1-T12 测试。

## 4. REFACTOR
- 抽 `isValidStatusTransition(from, to): boolean` 为纯函数
- 抽 `matchForbiddenAction(forbidden: string[], action: string, opts?): boolean` 为纯函数（含 glob 选项）
- 抽 `validateConfigObjectRefs(refs: unknown): boolean` 为纯函数

## 5. E2E
真实 MySQL 跑 E2E-TA 全流程；纯逻辑测试（T9/T12）无需 DB。

## 6. 沉淀
- 新不变量加入 1.2 表
- 新状态转换加入 1.3 图
- API 签名 / 状态机 / 角色契约执行流程追加到第 7 节 Implementation Log

---

## 7. Implementation Log

### 7.1 实现文件
- Service: `ee/apps/den-api/src/team-autonomy/team-agent-service.ts`（TypeScript ESM，模块级函数 + `db` 单例）
- Test: `ee/apps/den-api/test/team-autonomy/team-agent-service.test.ts`（node:test + tsx，19 个测试）
- Tables: `@openwork-ee/den-db/schema` → `TeamAgentTable` + `TeamRoleTable` + `TeamTaskTable`
- TypeID: `teamAgent=tagt`、`teamRole=trol`、`teamTask=ttsk`（`@openwork-ee/utils/typeid`）

### 7.2 真实 API 签名（GREEN 后冻结）

```ts
// 类型导出
export { TeamAgentEngine, TeamAgentStatus }
export type AgentEngine = "openworker" | "opencode" | "mcp" | "generic"
export type AgentStatus = "idle" | "busy" | "paused" | "offline" | "error"
export type TeamRole = "owner" | "admin" | "editor" | "viewer"
export type Actor = { memberId: string; role: TeamRole }

export type AgentRow = {
  id; teamId; name; engine; roleId; persona; skills; connectors;
  modelDefault; status; sidecarSessionId; forbiddenActions; currentTaskId;
  createdAt; updatedAt
}

export type CreateAgentInput = {
  teamId; name; engine; roleId?; persona?; skills?; connectors?;
  modelDefault?; forbiddenActions?
}
export type UpdateAgentInput = Partial<Omit<CreateAgentInput, "teamId">>

// Result（operational-errors.ts 风格 discriminated union）
export type CreateAgentResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; status: 400 | 403; response: { code: "FORBIDDEN" | "CROSS_TEAM_ROLE" | "INVALID_CONFIG_OBJECT_REF" | "INSERT_FAILED"; message } }

export type UpdateAgentResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; status: 400 | 403 | 404; response: { code: "FORBIDDEN" | "FORBIDDEN_ACTION_SELF_MODIFY" | "CROSS_TEAM_ROLE" | "INVALID_CONFIG_OBJECT_REF" | "NOT_FOUND"; message } }

export type DeleteAgentResult =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 409; response: { code: "FORBIDDEN" | "NOT_FOUND" | "AGENT_HAS_TASK"; message } }

export type PauseResumeResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; status: 403 | 404 | 409; response: { code: "FORBIDDEN" | "NOT_FOUND" | "INVALID_TRANSITION"; message } }

export type AssignTaskResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; status: 400 | 403 | 404 | 409; response: { code: "FORBIDDEN" | "NOT_FOUND" | "AGENT_BUSY" | "TASK_NOT_FOUND" | "CROSS_TEAM_TASK" | "INVALID_TRANSITION"; message } }

export type UnassignTaskResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; status: 403 | 404 | 409; response: { code: "FORBIDDEN" | "NOT_FOUND" | "AGENT_NOT_BUSY"; message } }

export type ForbiddenCheck = { forbidden: boolean; action?: string; exists: boolean }

// 纯函数（无 DB 依赖，可单测）
export function isValidStatusTransition(from: AgentStatus, to: AgentStatus): boolean
export function matchForbiddenAction(forbidden: string[] | null | undefined, action: string, opts?: { glob?: boolean }): boolean
export function validateConfigObjectRefs(refs: unknown): boolean

// DB 操作（async）
export async function createAgent(input: CreateAgentInput, actor: Actor): Promise<CreateAgentResult>
export async function updateAgent(id: string, patch: UpdateAgentInput, actor: Actor): Promise<UpdateAgentResult>
export async function deleteAgent(id: string, actor: Actor): Promise<DeleteAgentResult>
export async function pauseAgent(id: string, actor: Actor): Promise<PauseResumeResult>
export async function resumeAgent(id: string, actor: Actor): Promise<PauseResumeResult>
export async function assignTask(id: string, taskId: string, actor: Actor): Promise<AssignTaskResult>
export async function unassignTask(id: string, actor: Actor): Promise<UnassignTaskResult>
export async function listByTeam(teamId: string): Promise<AgentRow[]>
export async function getById(id: string): Promise<AgentRow | null>
export async function checkForbiddenAction(agentId: string, actionName: string, opts?: { glob?: boolean }): Promise<ForbiddenCheck>
```

> 设计偏离：原始 Surface 写 `createAgentService(deps)` 工厂模式，实际实现采用模块级函数 + `db` 单例（与 `asset-service.ts` / `permission-service.ts` / `inbox-service.ts` 保持一致）。Result 用 discriminated union (`ok: true/false`) 而非 throw，让调用方在 controller 层显式 pattern-match，避免 try/catch 吞错。

### 7.3 状态机转换表（实现后的真实矩阵）
| from \ to | idle | busy | paused | offline | error |
|---|---|---|---|---|---|
| idle    | ✗ | ✓ (assignTask) | ✓ (pauseAgent) | ✓ | ✓ |
| busy    | ✓ (unassignTask) | ✗ | ✓ (pauseAgent) | ✓ | ✓ |
| paused  | ✓ (resumeAgent) | ✗ (必须先 resume→idle) | ✗ | ✓ | ✓ |
| offline | ✓ (外部恢复) | ✗ | ✗ | ✗ | ✗ |
| error   | ✓ (外部恢复) | ✗ | ✗ | ✗ | ✗ |

矩阵硬编码于 `ALLOWED_TRANSITIONS: Record<AgentStatus, AgentStatus[]>`，由 `isValidStatusTransition()` 暴露为纯函数。

**特殊处理**：`resumeAgent` 调用 `transitionStatus(id, "idle")`，但若 agent 当前 `current_task_id` 非空（即 paused 前是 busy），目标状态自动从 `idle` 调整为 `busy` 以保持 I2 不变量。这避免了 pause→resume 期间任务被错误标记为未分配。

### 7.4 不变量实现细节
| ID | 实现位置 | 关键技术 |
|---|---|---|
| I1 | `updateAgent()` 调用 `isSelfModify(actor, agentId, patch)` | 纯函数检查 `actor.memberId === agentId && "forbiddenActions" in patch`；命中返回 403 + `{code:"FORBIDDEN_ACTION_SELF_MODIFY"}`。owner/admin 改 forbidden_actions 走另一条路径，仍要求 `canManageAgents(role)` |
| I2 | `assignTask()` 原子 `UPDATE TeamAgentTable SET current_task_id=?, status='busy'` + 同步 `UPDATE TeamTaskTable SET assignee_type='agent', assignee_id=?`；`unassignTask()` 原子清空两者 + status=idle | 单条 UPDATE 语句保证原子性；状态机校验先于 UPDATE 拒绝 paused/busy agent 的非法 assign |
| I3 | `assertRoleInTeam(teamId, roleId)` 内部函数 | `SELECT TeamRoleTable.id, team_id WHERE id=roleId`；不存在或 team_id 不匹配返回 400 + `{code:"CROSS_TEAM_ROLE"}` |
| I4 | `deleteAgent()` 检查 `existing[0].current_task_id` | 非空时返回 409 + `{code:"AGENT_HAS_TASK", message}`；调用方必须先 `unassignTask` |
| I5 | `validateConfigObjectRefs(refs)` 纯函数 | 拒绝非数组、含非字符串、含空字符串的列表；null/undefined 视为合法（可空字段）。`validateRefsInInput()` 在 createAgent/updateAgent 调用 |

### 7.5 角色契约执行流程（1.4 实现细节）

```
agent 执行工具前:
  checkForbiddenAction(agentId, actionName, opts?)
    ↓
  SELECT forbidden_actions FROM team_agent WHERE id=agentId
    ↓
  if !row: return { forbidden: false, exists: false }
    ↓
  if matchForbiddenAction(row.forbidden_actions, actionName, opts):
    return { forbidden: true, action: actionName, exists: true }
  else:
    return { forbidden: false, exists: true }
```

**匹配规则**（`matchForbiddenAction`）：
- 默认精确匹配：`forbidden.includes(actionName)`
- `opts.glob=true` 时启用 glob：`* → .*`、`? → .`、其他字符转义（与 `permission-service.ts::matchGlob` 一致）
- null/空数组直接返回 false

调用方在 controller 层 / agent runtime 拦截器检查 `forbidden=true` 时必须拒绝执行工具调用；这与 `permission-service.ts::checkRoleContract` 的语义对齐（实际上 `checkRoleContract` 是 `checkForbiddenAction` 的简化版本，本 service 提供更完整的 API）。

### 7.6 E2E 验证结果

#### 7.6.1 场景 1：DB 可用（完整集成测试）

```bash
$ export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
$ cd /Users/yason/Documents/trae_projects/openwork/ee/apps/den-api
$ DATABASE_URL='mysql://root:password@127.0.0.1:3306/openwork_test_ta' \
  DB_MODE=mysql DEN_DB_ENCRYPTION_KEY='ta-encryption-key-12345678901234567890' \
  BETTER_AUTH_SECRET='ta-better-auth-secret-1234567890123456789012' \
  BETTER_AUTH_URL='http://127.0.0.1:8790' CORS_ORIGINS='http://127.0.0.1:8790' \
  node --import tsx --test --test-reporter=spec --test-force-exit \
  test/team-autonomy/team-agent-service.test.ts

▶ TeamAgentService — OpenSpecs RED/GREEN
  ✔ T1: createAgent returns id, status=idle, forbidden_actions=[]
  ✔ T2: I3 createAgent with cross-team roleId returns 400 CROSS_TEAM_ROLE
  ✔ T3: I5 createAgent with non-string skills returns 400 INVALID_CONFIG_OBJECT_REF
  ✔ T4: createAgent with valid skills passes I5
  ✔ T5: I1 agent self-modify forbiddenActions returns 403 FORBIDDEN_ACTION_SELF_MODIFY
  ✔ T6: I2 assignTask sets status=busy + current_task_id
  ✔ T7: I2 unassignTask sets status=idle + clears current_task_id
  ✔ T8: I4 deleteAgent with current_task_id returns 409 AGENT_HAS_TASK
  ✔ T9: pauseAgent idle → paused, paused → paused 409
  ✔ T10: resumeAgent paused → idle, idle → idle 409
  ✔ T11: assignTask on busy agent returns 409 AGENT_BUSY
  ✔ T12: listByTeam returns only agents of the team
  ✔ T13: checkForbiddenAction hits forbidden_actions array
  ✔ T14: checkForbiddenAction on missing agent → exists=false, forbidden=false
  ✔ T15: matchForbiddenAction pure logic — exact match
  ✔ T15b: matchForbiddenAction pure logic — glob mode
  ✔ T16: isValidStatusTransition state machine matrix
  ✔ T17: validateConfigObjectRefs pure logic
  ✔ T18: viewer createAgent returns 403 FORBIDDEN
✔ TeamAgentService — OpenSpecs RED/GREEN (259.375802ms)
ℹ tests 19  ℹ pass 19  ℹ fail 0  ℹ skipped 0
```

#### 7.6.2 场景 2：DB 不可用（纯逻辑测试）

```
$ DATABASE_URL='mysql://root:wrongpassword@127.0.0.1:3306/nonexistent' \
  DB_MODE=mysql ... \
  node --import tsx --test --test-reporter=spec --test-force-exit \
  test/team-autonomy/team-agent-service.test.ts

▶ TeamAgentService — OpenSpecs RED/GREEN
  ﹣ T1-T14, T18: skipped (DB not available)
  ✔ T15: matchForbiddenAction pure logic — exact match
  ✔ T15b: matchForbiddenAction pure logic — glob mode
  ✔ T16: isValidStatusTransition state machine matrix
  ✔ T17: validateConfigObjectRefs pure logic
ℹ tests 19  ℹ pass 4  ℹ fail 0  ℹ skipped 15
```

`--test-force-exit` 用于绕过 mysql2 连接池保持 event loop alive 的问题。

### 7.7 Schema 属性命名约定（与现有 service 一致）
team-autonomy schema（`ee/packages/den-db/src/schema/team-autonomy.ts`）的 JS 属性名为 **snake_case**（如 `team_id`、`forbidden_actions`、`current_task_id`、`role_id`、`sidecar_session_id`、`model_default`），与 `org.ts` 的 camelCase 约定不同。实现中所有 team-autonomy 表的 DB 列引用使用 snake_case，对外 API 通过 `rowToAgent()` 映射函数转换为 camelCase。

### 7.8 REFACTOR 状态
- ✓ `isValidStatusTransition(from, to)` 已抽为纯函数（无 DB 依赖，可独立单测）
- ✓ `matchForbiddenAction(forbidden, action, opts)` 已抽为纯函数（含 glob 选项）
- ✓ `validateConfigObjectRefs(refs)` 已抽为纯函数（防御性校验 ConfigObject id 列表）
- ✓ `assertRoleInTeam(teamId, roleId)` 内部 helper（I3 跨 team 校验，createAgent + updateAgent 复用）
- ✓ `validateRefsInInput(input)` 内部 helper（I5 校验，createAgent + updateAgent 复用）

### 7.9 后续待办（不在本 P1 范围内）
- E2E-TA 完整场景跑通需在 den-api 启动后通过 HTTP controller 触发，本 spec 仅覆盖 service 层契约
- `assignTask` / `unassignTask` 跨 `TeamAgentTable` + `TeamTaskTable` 的更新目前是顺序执行（非事务），高并发下需引入 `db.transaction()` 包裹（参考 inbox-service.ts 的 first-responder-wins 模式）
- TypeID 模板字面量类型问题（`string` vs `tagt_${string}`）是 den-db schema 的预先存在问题，影响全 team-autonomy service（asset/permission/inbox/agent），需在 den-db 层统一修复，不在本 service 范围内
- `checkForbiddenAction` 与 `permission-service.ts::checkRoleContract` 语义重叠，未来可统一到本 service 作为单一事实源（permission-service 改为调用本 service）
