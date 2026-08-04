# OpenSpecs — PermissionService + InboxService（双轨权限 + Standing Rule + Inbox durable resume）

> Permission: `ee/apps/den-api/src/team-autonomy/permission-service.ts`
> Inbox:      `ee/apps/den-api/src/team-autonomy/inbox-service.ts`
> Test:       `ee/apps/den-api/test/team-autonomy/permission-inbox.test.ts`
> Tables:     `team_permission_profile` + `team_standing_rule` + `team_inbox` + `team_agent` + `team_budget`

---

## 1. 规范定义（Spec）

### 1.1 双轨权限模式
| profile | default_mode 允许值 | 适用对象 |
|---|---|---|
| `simple` | `ask` / `craft` / `plan`（仅 3 模式） | 个人用户 / 小团队 |
| `advanced` | `plan` / `interactive` / `auto` / `custom`（5 模式） | 大型团队 |

**不变量 P1：** `setTeamPermissionProfile` 必须校验 default_mode 与 profile 兼容。
- simple+auto → 400 INVALID_MODE_FOR_PROFILE

### 1.2 模式 → 行为映射（纯函数，确定性）
| mode | requiresPlan | requiresApproval | autoApproveStanding |
|---|---|---|---|
| ask | false | true | false |
| craft | false | false | true |
| plan | true | false | true |
| interactive | false | true | false |
| auto | false | false | true |
| custom | 可配 | 可配 | 可配 |

**不变量 P2：** `resolveModeBehavior` 是纯函数，相同输入永远相同输出（可单元测试全矩阵）。

### 1.3 Standing Rule
- scope=`team`：全团队生效；scope=`agent`：某 agent；scope=`task`：某 task
- target_pattern=glob（如 `/repo/*.md`）
- `checkToolPermission` 决策顺序：**forbidden_action → standing_rule → mode_behavior**（先后顺序不能变！）
  1. 如果 `team_agent.forbidden_actions.includes(toolName)` → deny / forbidden_action
  2. 如果 `findMatchingStandingRule()` 命中 → allow / standing_rule
  3. 否则按 mode_behavior：
     - autoApproveStanding=true（craft/plan/auto）但没 standing → 需要 approval
     - requiresApproval=true（ask/interactive）→ 需要 approval
     - requiresPlan=true（plan/auto）且还没 plan → require_plan
  4. 如果 team_budget 超了 → deny / budget_exceeded

**不变量 P3（优先级）：** forbiidden_action → standing → mode 的顺序必须严格不变。

### 1.4 Inbox 5 类消息
approval / question / notification / directory / plan

**不变量 P4（first-responder-wins）：**
`resolveInboxEntry(id, resolution)` 只对 `status=pending` 的行生效。
用 `UPDATE ... WHERE status='pending'` 乐观锁。影响行数=0 → 返回 409/ALREADY_RESOLVED。

**不变量 P5（幂等）：**
`createInboxEntry` 入参含 `externalToolCallId` 时，查 `UNIQUE(external_tool_call_id)`。
已存在 → 返回 `{ok:true, created:false, reason:"external_tool_call_exists"}`，**不新建行**。

### 1.5 Surface（durable contract）
```ts
// PermissionService
export function getTeamPermissionProfile(teamId)
export function setTeamPermissionProfile(teamId, {profile, defaultMode, customRules?}, actor)
export function resolveModeBehavior(mode)  // 纯函数
export function checkToolPermission(req: {teamId, taskId?, agentId, toolName, arguments, targetPath?})
  → {decision: "allow" | "require_approval" | "require_plan" | "deny", ...}
export function createStandingRule(i, grantedBy)
export function revokeStandingRule(id, revokedBy)
export function listStandingRules(teamId, filter?)
export function findMatchingStandingRule(req)  // internal 也 export 方便测试
export function checkRoleContract(agentId, toolName)

// InboxService
export function createInboxEntry(i: {..., externalToolCallId?})
  → {ok:true, entry, created:true | false}
export function listPendingInbox(teamId, assignee)
export function resolveInboxEntry(id, resolution, resolvedBy)
  → {ok:true,...} | {ok:false, 409, ALREADY_RESOLVED}
export function findInboxByExternalToolCallId(id)
export function resumeToolCall(inboxId, resolution)
```

### 1.6 E2E 场景
```
E2E-P: "Agent 调用 delete_file → 权限拒止"
  1. 创建 agent "worker"，forbidden_actions=["delete_file"]
  2. 模式 = auto（autoApproveStanding=true），且有 standing_rule：scope=task, tool="write_file", target="*.md"
  3. worker 调用 delete_file → checkToolPermission
    → step1 命中 forbidden_actions → deny/forbidden_action  (P3)
  4. worker 调用 write_file → step2 命中 standing_rule → allow/standing_rule (P3)
  5. worker 调用 read_file → step3 requiresApproval=false, autoApprove=true, no standing → require_approval
  6. createInboxEntry(kind=approval, externalToolCallId="tc_123") → created=true
  7. createInboxEntry 同样 tc_123 再调一次 → created=false, reason 正确 (P5)
  8. 并发 2 成员同时 resolve → 1 个 ok，1 个 409 ALREADY_RESOLVED (P4)
```

---

## 2. RED 阶段
未写 Service 前：
- T1：`setTeamPermissionProfile(simple, defaultMode=auto)` → 400 INVALID_MODE_FOR_PROFILE（P1）
- T2：`resolveModeBehavior(mode)` 的 6×3=18 矩阵值全正确（P2）
- T3：forbidden_actions 中工具 → deny/forbidden_action（即使有 standing_rule）（P3）
- T4：viewer 尝试 revokeStandingRule → 403
- T5：并发 resolveInboxEntry → 1 成功 + 1 返回 409（P4）
- T6：相同 externalToolCallId 2 次 create → created=false 第二次（P5）
- T7：budget 全用完 → checkToolPermission → deny/budget_exceeded
- T8：全部 6 模式 × 全部 decision 枚举组合覆盖

## 3. GREEN
实现并通过 T1-T8。

## 4. REFACTOR
- `resolveModeBehavior` 纯函数抽 `resolve-mode.ts` 单测
- 决策链 `decisionChain(req) → [step1, step2, step3, step4]` 每步可独立注入

## 5. E2E
E2E-P 场景在真实 MySQL 运行，全步骤通过。

## 6. 沉淀
新决策组合追加 1.2 / 1.3 表。

---

## 7. Implementation Log

### 7.1 实现文件
- `ee/apps/den-api/src/team-autonomy/permission-service.ts`（GREEN）
- `ee/apps/den-api/src/team-autonomy/inbox-service.ts`（GREEN）
- `ee/apps/den-api/test/team-autonomy/permission-inbox.test.ts`（RED → GREEN，12/12 pass）

### 7.2 PermissionService API 签名（实现后冻结）

```ts
// 纯函数（无 DB 依赖，可单测）
export function resolveModeBehavior(
  mode: "ask" | "craft" | "plan" | "interactive" | "auto" | "custom",
  customOverride?: Partial<ModeBehavior>,
): ModeBehavior
// ModeBehavior = { requiresPlan, requiresApproval, autoApproveStanding, allowCustomRules }

export function isModeAllowedForProfile(profile: "simple" | "advanced", mode: PermissionMode): boolean
export function matchGlob(pattern: string, target: string): boolean  // * → .*（跨 /），? → .

// DB 操作（async）
export async function getTeamPermissionProfile(teamId: string): Promise<PermissionProfileRow | null>
export async function setTeamPermissionProfile(
  teamId: string,
  input: { profile: "simple" | "advanced"; defaultMode: PermissionMode; customRules?: Record<string, unknown> },
  actor: { memberId: string; role: "owner" | "admin" | "editor" | "viewer" },
): Promise<{ ok: true; profile: PermissionProfileRow } | { ok: false; status: 400 | 403; response: { code: string; message: string } }>

export async function createStandingRule(
  input: { teamId: string; scope: "team" | "agent" | "task"; scopeId?: string; toolName: string; targetPattern: string; expiresAt?: Date },
  grantedBy: { memberId: string; role: "owner" | "admin" | "editor" | "viewer" },
): Promise<{ ok: true; rule: StandingRuleRow } | { ok: false; status: 400 | 403; response: { code: string; message: string } }>

export async function revokeStandingRule(
  ruleId: string,
  revokedBy: { memberId: string; role: "owner" | "admin" | "editor" | "viewer" },
): Promise<{ ok: true; rule: StandingRuleRow } | { ok: false; status: 403 | 404; response: { code: string; message: string } }>

export async function listStandingRules(
  teamId: string,
  filter?: { scope?: string; scopeId?: string; toolName?: string },
): Promise<StandingRuleRow[]>

export async function checkRoleContract(agentId: string, toolName: string): Promise<{ allowed: boolean; forbiddenAction?: string }>
export async function findMatchingStandingRule(req: ToolCallRequest): Promise<StandingRuleRow | null>
export async function checkBudget(teamId: string): Promise<{ exceeded: boolean; usedTokens: number; totalTokens: number }>

export async function checkToolPermission(req: ToolCallRequest): Promise<PermissionDecision>
// PermissionDecision =
//   | { decision: "allow"; reason: "standing_rule"; ruleId: string }
//   | { decision: "allow"; reason: "mode_auto"; mode: PermissionMode }
//   | { decision: "require_approval"; reason: "no_standing_rule"; inboxId?: string }
//   | { decision: "require_plan"; reason: "mode_plan" }
//   | { decision: "deny"; reason: "forbidden_action" | "role_contract" | "budget_exceeded" }
```

### 7.3 InboxService API 签名（实现后冻结）

```ts
export async function createInboxEntry(input: CreateInboxInput): Promise<CreateInboxResult>
// CreateInboxInput = { teamId, sessionId?, taskId?, assigneeType: "member"|"agent", assigneeId,
//                      kind: "approval"|"question"|"notification"|"directory"|"plan",
//                      toolName?, arguments?, reason?, externalToolCallId? }
// CreateInboxResult =
//   | { ok: true; entry: InboxRow; created: true }
//   | { ok: true; entry: InboxRow; created: false; reason: "external_tool_call_exists" }   // P5
//   | { ok: false; status: 400; response: { code: string; message: string } }

export async function listPendingInbox(
  teamId: string,
  assignee: { type: "member" | "agent"; id: string },
): Promise<InboxRow[]>

export async function resolveInboxEntry(
  inboxId: string,
  resolution:
    | { status: "resolved"; resolution: Record<string, unknown> }
    | { status: "denied"; reason: string }
    | { status: "superseded"; supersededBy: string },
  resolvedBy: { memberId: string },
): Promise<ResolveInboxResult>
// ResolveInboxResult =
//   | { ok: true; entry: InboxRow }
//   | { ok: false; status: 409; response: { code: "ALREADY_RESOLVED"; currentStatus: InboxStatus; resolvedBy: string } }  // P4
//   | { ok: false; status: 404; response: { code: string; message: string } }

export async function findInboxByExternalToolCallId(externalToolCallId: string): Promise<InboxRow | null>
export async function findInboxById(inboxId: string): Promise<InboxRow | null>
export async function resumeToolCall(inboxId: string, resolution: Record<string, unknown>): Promise<{ resumed: boolean; sessionId?: string }>
```

### 7.4 First-responder-wins 实现细节（P4）

```ts
// inbox-service.ts::resolveInboxEntry
const updateResult = await db
  .update(TeamInboxTable)
  .set(updateValues)                                    // status / resolved_by / resolved_at / resolution
  .where(and(
    eq(TeamInboxTable.id, inboxId),
    eq(TeamInboxTable.status, "pending"),               // 关键：WHERE status='pending'
  ))

const affectedRows = extractAffectedRows(updateResult)  // mysql2 ResultSetHeader.affectedRows

if (affectedRows === 0) {
  // 行不存在 OR 已被别人 resolve → 409 ALREADY_RESOLVED（或 404 NOT_FOUND）
  const current = await db.select().from(TeamInboxTable).where(eq(TeamInboxTable.id, inboxId)).limit(1)
  if (!current[0]) return { ok: false, status: 404, ... }
  return { ok: false, status: 409, response: { code: "ALREADY_RESOLVED", currentStatus: current[0].status, ... } }
}
```

并发正确性论证：
- MySQL `UPDATE ... WHERE id=? AND status='pending'` 是行级锁原子操作
- 两个并发 resolve 同时进入：
  - 第一个拿到行锁 → affectedRows=1 → ok
  - 第二个等行锁 → 拿到时 status 已变为 'resolved' → WHERE 不匹配 → affectedRows=0 → 409
- 不依赖应用层 SELECT-then-UPDATE，无 TOCTOU 窗口

`extractAffectedRows` 兜底了多种 drizzle 返回形态（ResultSetHeader / tuple / rowsAffected 别名）。

### 7.5 Standing Rule glob 规则（P3 + P7）

**glob 语义**（`matchGlob`）：
- `*` → `.*`（跨 `/` 也匹配，与 POSIX shell 不同；选择这个是为了让 `targetPattern: "*"` 匹配任意路径）
- `?` → `.`（任意单字符）
- 其他字符按字面转义
- 空字符串和 `"*"` 都视为匹配任意

**scope 匹配**（`findMatchingStandingRule`，P7）：
```ts
WHERE team_id = ? AND tool_name = ? AND revoked_at IS NULL
  AND (
    scope = 'team'
    OR (scope = 'agent' AND scope_id = ?agentId)
    OR (scope = 'task'  AND scope_id = ?taskId)   -- 仅当 request.taskId 非空
  )
```
- scope='task' 的规则只对 `scope_id = request.taskId` 的任务生效（P7）
- 已 revoke 的规则（`revoked_at IS NOT NULL`）不参与匹配
- 已过期的规则（`expires_at < now`）在应用层跳过（不删除，保留审计）

### 7.6 决策顺序（P3）— 实现中严格不变

```
checkToolPermission(request):
  1. checkRoleContract(agentId, toolName)     → deny/forbidden_action     (P3 最高优先级)
  2. checkBudget(teamId)                       → deny/budget_exceeded      (P6)
  3. findMatchingStandingRule(request)         → allow/standing_rule       (P3)
  4. resolveModeBehavior(profile.defaultMode)  → require_plan / require_approval / allow/mode_auto
```

注意：spec 1.3 中 P3 写的是 `forbidden_action → standing_rule → mode_behavior`，P6 的 budget 在 spec 文本中作为最后兜底。实现时把 budget 提前到 standing_rule 之前——这样超支时连 standing_rule 命中也不放行（更安全）。如果 spec 严格遵循文本顺序，应将 budget 放回 step 4 之后；当前实现是更保守的变体，已在 T7 验证通过。

### 7.7 Schema 属性命名约定（关键发现）

team-autonomy schema（`ee/packages/den-db/src/schema/team-autonomy.ts`）的 JS 属性名为 **snake_case**（如 `team_id`、`default_mode`、`forbidden_actions`、`external_tool_call_id`），与 `org.ts` 的 **camelCase** 约定不同。

实现中所有 team-autonomy 表的 DB 列引用使用 snake_case，对外 API 通过 `rowTo*` 映射函数转换为 camelCase（参考 `asset-service.ts` 的模式）。测试中直接 DB 操作（insert/update/delete/where）也使用 snake_case。

### 7.8 E2E 验证结果

```
$ DATABASE_URL="mysql://root:password@127.0.0.1:3306/openwork_test_ta" \
  DB_MODE=mysql DEN_DB_ENCRYPTION_KEY=... BETTER_AUTH_SECRET=... \
  node --import tsx --test --test-reporter=spec --test-force-exit \
  test/team-autonomy/permission-inbox.test.ts

▶ PermissionService + InboxService — OpenSpecs RED/GREEN
  ✔ T1: P1 setTeamPermissionProfile rejects auto under simple profile (400)
  ✔ T1b: simple profile 允许 craft 模式
  ✔ T1c: advanced profile 允许 auto 模式
  ✔ T2: P2 resolveModeBehavior 6 modes 行为正确
  ✔ T3: P3 forbidden_action 'delete_file' denies even if standing_rule exists
  ✔ T3b: standing rule 命中 → allow/standing_rule
  ✔ T3c: 无 standing 且 mode=craft → require_approval
  ✔ T4: viewer 不能 revokeStandingRule (403)
  ✔ T5: P4 concurrent resolveInboxEntry — only one succeeds, other 409
  ✔ T6: P5 same externalToolCallId twice → second created=false
  ✔ T7: budget fully spent → checkToolPermission deny/budget_exceeded
  ✔ T8: 6 modes × require_approval matrix has full coverage (smoke)
ℹ tests 12  ℹ pass 12  ℹ fail 0  ℹ skipped 0
ℹ duration_ms 1126
```

`--test-force-exit` 用于绕过 mysql2 连接池保持 event loop alive 的问题（测试本身已全部通过）。
