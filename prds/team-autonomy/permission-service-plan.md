# PermissionService — 双轨权限 + Standing Rule + 团队 Inbox

> Status: Draft for scoping · Owner: team-autonomy · Schema: `team-autonomy.ts` (已落地)

## Goal

实现 WorkBuddy Bluebook Ch3 + OpenWorker 的权限模型融合：

1. **双轨权限模式**：个人/简单用户用 3 模式（Ask/Craft/Plan），团队/自治场景用 5 模式（Discuss/Plan/Interactive/Auto/Custom）。团队 admin 在 `team_permission_profile` 中决定团队用哪套。
2. **Standing Rule**：任务级"工具+目标"永久授权，避免每次工具调用都审批。OpenWorker 移植。
3. **团队 Inbox**：5 类消息（approval/question/notification/directory/plan），first-responder-wins 幂等，durable resume。

## Short Answer

- **不重新发明 RBAC**：复用现有 `PluginAccessGrantTable` 的 viewer/editor/manager 三级，本服务在其上加模式层。
- **模式切换由 admin 决定**：`team_permission_profile.profile` 字段切换 simple/advanced。
- **Standing Rule 是白名单**：`scope=task` 的规则只对该 task 生效；`scope=team` 对全团队生效。
- **Inbox 是 OpenWorker Inbox 的团队版**：5 类消息 + first-responder-wins + external_tool_call_id 幂等。
- **PermissionService 是工具调用的前置守门人**：所有工具调用前必须调用 `checkToolPermission()`。

## Recommendation

放路径：`ee/apps/den-api/src/team-autonomy/permission-service.ts`，Inbox 相关放 `ee/apps/den-api/src/team-autonomy/inbox-service.ts`。

## Data Model

参见 [team-autonomy.ts](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts)：

- `TeamPermissionProfileTable`（[L554-L570](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts#L554-L570)）— 团队权限模式选择
- `TeamStandingRuleTable`（[L575-L596](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts#L575-L596)）— 永久授权规则
- `TeamInboxTable`（[L605-L634](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts#L605-L634)）— 5 类消息 + 幂等

## Surface

```ts
// ee/apps/den-api/src/team-autonomy/permission-service.ts

export type PermissionMode =
  | "ask" | "craft" | "plan"           // simple profile（3 模式）
  | "interactive" | "auto" | "custom"  // advanced profile（5 模式中的 3 个）
                                        // plan 在两个 profile 中都有
export type PermissionProfile = "simple" | "advanced"

// ---------- 模式管理 ----------

export async function getTeamPermissionProfile(
  teamId: string,
): Promise<PermissionProfileRow>

export async function setTeamPermissionProfile(
  teamId: string,
  input: {
    profile: PermissionProfile
    defaultMode: PermissionMode
    customRules?: Record<string, unknown>
  },
  actor: { memberId: string; role: "owner" | "admin" },
): Promise<PermissionProfileRow>

// ---------- 模式 → 行为映射 ----------

// 给定当前模式，决定工具调用应走哪条路径
export function resolveModeBehavior(
  mode: PermissionMode,
): {
  requiresPlan: boolean           // plan/auto 模式 true
  requiresApproval: boolean       // ask/interactive 模式 true
  autoApproveStanding: boolean    // craft/plan/auto 模式 true（standing rule 命中即放行）
  allowCustomRules: boolean       // custom 模式 true
}

// ---------- 工具调用守门 ----------

export type ToolCallRequest = {
  teamId: string
  taskId?: string
  agentId: string
  toolName: string
  arguments: Record<string, unknown>
  targetPath?: string  // 用于 standing rule 的 glob 匹配
}

export type PermissionDecision =
  | { decision: "allow"; reason: "standing_rule"; ruleId: string }
  | { decision: "allow"; reason: "mode_auto"; mode: PermissionMode }
  | { decision: "require_approval"; inboxId: string; reason: "no_standing_rule" }
  | { decision: "require_plan"; reason: "mode_plan" }
  | { decision: "deny"; reason: "forbidden_action" | "role_contract" | "budget_exceeded" }

// 核心守门函数：所有工具调用前必须调用
export async function checkToolPermission(
  request: ToolCallRequest,
): Promise<PermissionDecision>

// ---------- Standing Rule 管理 ----------

export async function createStandingRule(
  input: {
    teamId: string
    scope: "team" | "agent" | "task"
    scopeId?: string  // agent_id 或 task_id
    toolName: string
    targetPattern: string  // glob
    expiresAt?: Date
  },
  grantedBy: { memberId: string; role: "owner" | "admin" },
): Promise<StandingRuleRow>

export async function revokeStandingRule(
  ruleId: string,
  revokedBy: { memberId: string; role: "owner" | "admin" },
): Promise<StandingRuleRow>

export async function listStandingRules(
  teamId: string,
  filter?: { scope?: string; scopeId?: string; toolName?: string },
): Promise<StandingRuleRow[]>

// 内部：检查是否有 standing rule 命中
export async function findMatchingStandingRule(
  request: ToolCallRequest,
): Promise<StandingRuleRow | null>

// ---------- 角色契约校验 ----------

// 检查 agent 的 forbidden_actions 是否包含当前工具
export async function checkRoleContract(
  agentId: string,
  toolName: string,
): Promise<{ allowed: boolean; forbiddenAction?: string }>
```

```ts
// ee/apps/den-api/src/team-autonomy/inbox-service.ts

export type InboxKind = "approval" | "question" | "notification" | "directory" | "plan"
export type InboxStatus = "pending" | "resolved" | "denied" | "superseded"

// ---------- 创建消息 ----------

export async function createInboxEntry(
  input: {
    teamId: string
    sessionId?: string
    taskId?: string
    assigneeType: "member" | "agent"
    assigneeId: string
    kind: InboxKind
    toolName?: string
    arguments?: Record<string, unknown>
    reason: string
    externalToolCallId?: string  // OpenWorker tool_call_id，幂等
  },
): Promise<
  | { ok: true; entry: InboxRow; created: true }
  | { ok: true; entry: InboxRow; created: false; reason: "external_tool_call_exists" }
>

// ---------- 查询 ----------

export async function listPendingInbox(
  teamId: string,
  assignee: { type: "member" | "agent"; id: string },
): Promise<InboxRow[]>

// ---------- 解决（first-responder-wins） ----------

export type InboxResolution =
  | { status: "resolved"; resolution: Record<string, unknown> }
  | { status: "denied"; reason: string }
  | { status: "superseded"; supersededBy: string }

export async function resolveInboxEntry(
  inboxId: string,
  resolution: InboxResolution,
  resolvedBy: { memberId: string },
): Promise<
  | { ok: true; entry: InboxRow }
  | { ok: false; status: 409; response: { code: "ALREADY_RESOLVED"; currentStatus: InboxStatus; resolvedBy: string } }
>

// ---------- durable resume ----------

// OpenWorker sidecar 重启后，调用此函数找到待恢复的 tool_call
export async function findInboxByExternalToolCallId(
  externalToolCallId: string,
): Promise<InboxRow | null>

// 标记为已解决并通知 sidecar resume
export async function resumeToolCall(
  inboxId: string,
  resolution: Record<string, unknown>,
): Promise<{ resumed: boolean; sessionId?: string }>
```

## 关键不变量

1. **模式与 profile 一致性**：`profile='simple'` 时 `default_mode` 只能是 ask/craft/plan；`profile='advanced'` 时只能是 plan/interactive/auto/custom。`setTeamPermissionProfile` 必须校验。
2. **Standing Rule 优先级**：`checkToolPermission` 决策顺序：forbidden_action → standing_rule → mode_behavior。forbidden 优先于一切。
3. **first-responder-wins**：`resolveInboxEntry` 用 `UPDATE ... WHERE status='pending'` 乐观锁，影响行数=0 即返回 409。
4. **external_tool_call_id 幂等**：`createInboxEntry` 在 `externalToolCallId` 非空时，先查 `UNIQUE` 索引，已存在则返回 `created=false`。
5. **角色契约强制**：`team_agent.forbidden_actions` 数组中的工具名，`checkRoleContract` 必须拒绝。
6. **预算耗尽拒止**：`checkToolPermission` 必须查 `team_budget` 当前用量，超预算返回 `deny: budget_exceeded`。
7. **scope 隔离**：`scope='task'` 的 standing rule 只对 `scope_id` 指定的 task 生效，不能被其他 task 误用。

## 模式 → 行为对照表

| Mode | requiresPlan | requiresApproval | autoApproveStanding | 典型场景 |
|---|---|---|---|---|
| ask | false | true | false | 个人简单用，每个工具都问 |
| craft | false | false | true | 个人创作，standing rule 放行 |
| plan | true | false | true | 复杂任务，先规划再执行 |
| interactive | false | true | false | 团队协作，每个工具团队成员确认 |
| auto | false | false | true | 自动化，standing rule 全放行 |
| custom | 可配 | 可配 | 可配 | admin 自定义 |

## HTTP 路由

| Method | Path | operationId |
|---|---|---|
| GET | `/v1/teams/{teamId}/permission-profile` | `getTeamPermissionProfile` |
| PUT | `/v1/teams/{teamId}/permission-profile` | `setTeamPermissionProfile` |
| GET | `/v1/teams/{teamId}/standing-rules` | `listStandingRules` |
| POST | `/v1/teams/{teamId}/standing-rules` | `createStandingRule` |
| DELETE | `/v1/teams/{teamId}/standing-rules/{id}` | `revokeStandingRule` |
| POST | `/v1/teams/{teamId}/inbox` | `createInboxEntry` |
| GET | `/v1/teams/{teamId}/inbox` | `listPendingInbox` |
| POST | `/v1/teams/{teamId}/inbox/{id}/resolve` | `resolveInboxEntry` |
| POST | `/v1/teams/{teamId}/inbox/{id}/resume` | `resumeToolCall` |

## 与 OpenWorker sidecar 的集成

```
OpenWorker sidecar 准备调用工具 X
        │
        ▼
POST /v1/teams/{teamId}/inbox/prepare  (带 toolName + arguments + externalToolCallId)
        │
        ▼
PermissionService.checkToolPermission()
        │
        ├── allow (standing_rule) ──▶ sidecar 直接执行，无需等待
        │
        ├── require_approval ──▶ 写入 team_inbox，sidecar 挂起等待
        │                              │
        │                              ▼
        │                       团队成员看到 inbox，调用 resolve
        │                              │
        │                              ▼
        │                       POST /v1/teams/{teamId}/inbox/{id}/resume
        │                              │
        │                              ▼
        │                       sidecar 收到 resolution，继续执行
        │
        └── deny ──▶ sidecar 收到拒绝，向 LLM 反馈"工具不可用"
```

## Test Plan

- **模式/profile 一致性**：尝试在 simple profile 下设 default_mode=auto，验证返回 400。
- **standing_rule 优先级**：agent.forbidden_actions 含 tool_X，即使有 standing_rule，也返回 deny。
- **first-responder-wins**：并发 2 个成员同时 resolve 同一 inbox，验证只有 1 个成功。
- **external_tool_call_id 幂等**：相同 externalToolCallId 调用 2 次 createInboxEntry，第二次返回 created=false。
- **角色契约**：agent.forbidden_actions=["delete_file"]，调用 delete_file 工具，验证返回 deny: forbidden_action。
- **预算耗尽**：mock team_budget.used_tokens >= total_tokens，验证返回 deny: budget_exceeded。
- **scope 隔离**：task_A 的 standing rule 不能让 task_B 的工具调用放行。
- **E2E**：sidecar → inbox → resolve → resume 完整链路。
