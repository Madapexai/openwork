# OpenSpecs — P3 Sidecar + PersonalTeam + Budget + Mailbox (端到端)

> Services:
> - `ee/apps/den-api/src/team-autonomy/personal-team-service.ts`
> - `ee/apps/den-api/src/team-autonomy/budget-service.ts`
> - `ee/apps/den-api/src/team-autonomy/mailbox-service.ts`
> - `ee/apps/den-api/src/team-autonomy/sidecar-service.ts`
>
> Test: `ee/apps/den-api/test/team-autonomy/sidecar-personal-budget.test.ts`
> Tables: `team` + `team_budget` + `team_budget_allocation` + `team_mailbox` + `team_agent` (from `@openwork-ee/den-db/schema`)
>
> 设计依据：
> - WorkBuddy Bluebook Ch3：个人 / 团队双轨（personal team 是用户私有命名空间）
> - WorkBuddy Bluebook Ch5：管理员 / 编辑者 / 查看者三级 + Token 预算
> - OpenWorker sidecar 集成：sidecar session 绑定 team_agent，agent 删除时 session 失效
> - 借鉴 operational-errors 风格：Result discriminated union + HTTP-ish 状态码

---

## 1. 规范定义（Spec）

### 1.1 P3 总览（4 个 service 协同）

```
┌───────────────────────────────────────────────────────────────┐
│  user signup / first login                                    │
│        │                                                      │
│        ▼                                                      │
│  ensurePersonalTeam(userId)                                   │
│   ├─ 查 team WHERE owner_user_id=userId AND kind='personal'   │
│   ├─ 存在 → 返回 (idempotent)                                  │
│   └─ 不存在 → INSERT team(slug='personal', kind='personal',   │
│                           owner_user_id=userId)               │
└─────────────────────────┬─────────────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │ personal team 守门     │
              │  - slug 不可改         │  I2
              │  - kind 不可改         │  I2
              └───────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│  Budget（团队级配额 + 角色/agent 分配）                        │
│   getBudget(teamId)                                           │
│   allocateBudget(teamId, period, total, ...)                  │
│   recordUsage(teamId, {tokens, costCents})  ← 原子 increment  │
│   checkBudget(teamId) → { exceeded: boolean }                 │
│   resetBudgetIfDue(teamId, now) → 自动 reset + 推进 reset_at   │
└───────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│  Mailbox（成员 + agent 间异步通信）                            │
│   sendMessage({teamId, recipient, sender, kind, body, ...})   │
│     ├─ 校验 recipient 属于同 team                              │
│     │   - recipient_type=member → TeamMemberTable 校验         │
│     │   - recipient_type=agent  → TeamAgentTable 校验          │
│     └─ INSERT team_mailbox                                     │
│   markRead(messageId)                                         │
│   listInbox(teamId, recipient)  按 team_id 过滤                │
│   listSent(teamId, sender)      按 team_id 过滤                │
└───────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│  Sidecar（OpenWorker session 生命周期）                        │
│   registerSidecarSession(agentId, sessionId)                  │
│     → UPDATE team_agent SET sidecar_session_id=sessionId      │
│   getSidecarSession(agentId) → { sessionId, status }          │
│   invalidateSidecarSession(agentId)                           │
│     → UPDATE team_agent SET sidecar_session_id=NULL,          │
│                              status='offline'                 │
│   agent 删除时自动失效（sidecar-service hook）                  │
└───────────────────────────────────────────────────────────────┘
```

### 1.2 不变量（6 条必须 test）

| ID | 不变量 | 失败返回 |
|---|---|---|
| I1 | 每个新 user 自动创建一个 `kind=personal` 的 team（owner_user_id = user.id, slug = "personal"）；重复调用 `ensurePersonalTeam` 幂等返回同一 team | — |
| I2 | personal team 的 slug 不可修改；kind 不可改为 shared/enterprise | 400 / PERSONAL_TEAM_IMMUTABLE |
| I3 | budget `used_tokens` / `used_cost_cents` 不可超过 total（超额时 `checkBudget` 返回 `exceeded=true`）；`recordUsage` 原子 increment，超额时拒绝写入 | 409 / BUDGET_EXCEEDED |
| I4 | budget `reset_at` 到期后自动 reset `used_tokens=0, used_cost_cents=0` + 推进 `reset_at`（按 period：daily+1d / weekly+7d / monthly+30d） | — |
| I5 | mailbox recipient 必须属于同 team（member 走 TeamMemberTable 校验，agent 走 TeamAgentTable 校验） | 400 / CROSS_TEAM_RECIPIENT |
| I6 | sidecar session 绑定 team_agent；agent 删除时 sidecar session 自动失效（清空 session_id + status=offline） | — |

### 1.3 Surface（durable contract）

```ts
// ---------- PersonalTeam ----------
export type PersonalTeamRow = {
  id: string
  organizationId: string
  name: string
  slug: string
  kind: "personal"
  ownerUserId: string
  settings: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

export type EnsurePersonalTeamInput = {
  userId: string
  organizationId: string  // personal team 必须挂在某 org 下（schema 约束）
  name?: string            // 默认 "Personal"
}

export type EnsurePersonalTeamResult =
  | { ok: true; team: PersonalTeamRow; created: boolean }
  | { ok: false; status: 400; response: { code: string; message: string } }

export type UpdatePersonalTeamResult =
  | { ok: true; team: PersonalTeamRow }
  | { ok: false; status: 400 | 404; response: { code: string; message: string } }

export function ensurePersonalTeam(input: EnsurePersonalTeamInput): Promise<EnsurePersonalTeamResult>
export function getPersonalTeam(userId: string): Promise<PersonalTeamRow | null>
export function updatePersonalTeam(
  teamId: string,
  patch: { name?: string; settings?: Record<string, unknown> },
): Promise<UpdatePersonalTeamResult>

// ---------- Budget ----------
export type BudgetPeriod = "daily" | "weekly" | "monthly"
export type BudgetRow = {
  id: string
  teamId: string
  period: BudgetPeriod
  totalTokens: number
  usedTokens: number
  totalCostCents: number
  usedCostCents: number
  resetAt: Date
  createdAt: Date
  updatedAt: Date
}

export type AllocateBudgetInput = {
  teamId: string
  period: BudgetPeriod
  totalTokens: number
  totalCostCents: number
  resetAt?: Date  // 默认按 period 推算
}

export type AllocateBudgetResult =
  | { ok: true; budget: BudgetRow; created: boolean }
  | { ok: false; status: 400 | 403; response: { code: string; message: string } }

export type RecordUsageInput = {
  teamId: string
  tokensUsed: number
  costCentsUsed: number
}

export type RecordUsageResult =
  | { ok: true; budget: BudgetRow }
  | { ok: false; status: 404 | 409; response: { code: string; message: string } }

export type BudgetCheck = {
  exceeded: boolean
  reason?: "tokens" | "cost"
  usedTokens: number
  totalTokens: number
  usedCostCents: number
  totalCostCents: number
}

export function allocateBudget(input: AllocateBudgetInput): Promise<AllocateBudgetResult>
export function getBudget(teamId: string): Promise<BudgetRow | null>
export function recordUsage(input: RecordUsageInput): Promise<RecordUsageResult>
export function checkBudget(teamId: string): Promise<BudgetCheck>
export function resetBudgetIfDue(teamId: string, now?: Date): Promise<{ reset: boolean; budget?: BudgetRow }>

// ---------- Mailbox ----------
export type MailboxRecipientType = "member" | "agent" | "channel"
export type MailboxSenderType = "member" | "agent" | "system"
export type MailboxKind = "message" | "task_update" | "approval_request" | "notification"

export type MailboxRow = {
  id: string
  teamId: string
  recipientType: MailboxRecipientType
  recipientId: string
  senderType: MailboxSenderType
  senderId: string
  kind: MailboxKind
  subject: string | null
  body: string | null
  attachmentRefs: string[] | null
  relatedTaskId: string | null
  readAt: Date | null
  createdAt: Date
}

export type SendMessageInput = {
  teamId: string
  recipientType: MailboxRecipientType
  recipientId: string
  senderType: MailboxSenderType
  senderId: string
  kind: MailboxKind
  subject?: string
  body?: string
  attachmentRefs?: string[]
  relatedTaskId?: string
}

export type SendMessageResult =
  | { ok: true; message: MailboxRow }
  | { ok: false; status: 400 | 404; response: { code: string; message: string } }

export function sendMessage(input: SendMessageInput): Promise<SendMessageResult>
export function markRead(messageId: string): Promise<{ ok: true; message: MailboxRow } | { ok: false; status: 404; response: { code: string; message: string } }>
export function listInbox(teamId: string, recipient: { type: MailboxRecipientType; id: string }): Promise<MailboxRow[]>
export function listSent(teamId: string, sender: { type: MailboxSenderType; id: string }): Promise<MailboxRow[]>

// ---------- Sidecar ----------
export type SidecarSession = {
  agentId: string
  sessionId: string | null
  agentStatus: "idle" | "busy" | "paused" | "offline" | "error"
}

export type RegisterSidecarResult =
  | { ok: true; session: SidecarSession }
  | { ok: false; status: 404; response: { code: string; message: string } }

export type InvalidateSidecarResult =
  | { ok: true; session: SidecarSession }
  | { ok: false; status: 404; response: { code: string; message: string } }

export function registerSidecarSession(agentId: string, sessionId: string): Promise<RegisterSidecarResult>
export function getSidecarSession(agentId: string): Promise<SidecarSession | null>
export function invalidateSidecarSession(agentId: string): Promise<InvalidateSidecarResult>
```

### 1.4 E2E 场景（端到端验证）

```
E2E-P3: "用户注册 → 个人 team → budget → mailbox → sidecar 全链路"
  1. ensurePersonalTeam({userId, organizationId})
     → team.kind=personal, slug='personal', owner_user_id=userId
  2. 再次 ensurePersonalTeam({userId, organizationId})
     → 返回同一 team（created=false，幂等）
  3. updatePersonalTeam(teamId, {name: 'My Personal'})
     → ok；但 updatePersonalTeam(teamId, {slug: 'changed'} as any) → 400 PERSONAL_TEAM_IMMUTABLE
  4. allocateBudget({teamId, period: 'monthly', totalTokens: 1_000_000, totalCostCents: 10000})
     → budget row 创建
  5. recordUsage({teamId, tokensUsed: 500_000, costCentsUsed: 5000})
     → used_tokens=500_000, used_cost_cents=5000
  6. checkBudget(teamId)
     → exceeded=false（未超额）
  7. recordUsage({teamId, tokensUsed: 600_000, costCentsUsed: 0})
     → 409 BUDGET_EXCEEDED（500_000 + 600_000 > 1_000_000）
  8. resetBudgetIfDue(teamId, now=future+31d)
     → reset=true, used_tokens=0, reset_at 推进 30d
  9. sendMessage({teamId, recipientType: 'agent', recipientId: agentA, ...})
     → ok（agentA 属于同 team）
 10. sendMessage({teamId, recipientType: 'agent', recipientId: otherTeamAgent, ...})
     → 400 CROSS_TEAM_RECIPIENT
 11. registerSidecarSession(agentA, 'sess_abc')
     → sidecar_session_id='sess_abc'
 12. getSidecarSession(agentA) → { sessionId: 'sess_abc', agentStatus: 'idle' }
 13. invalidateSidecarSession(agentA)
     → sidecar_session_id=null, status='offline'
 14. （agent 删除时 sidecar-service hook 自动 invalidate）
```

---

## 2. RED 阶段 — 必须失败的测试

在写完 4 个 Service 之前，`node --import tsx --test test/team-autonomy/sidecar-personal-budget.test.ts` 必须出现：

- T1（RED）：调用 `ensurePersonalTeam` → 抛 `Module not found`（personal-team-service 还不存在）
- T2（RED）：调用 `allocateBudget` → 抛 `Module not found`
- T3（RED）：调用 `sendMessage` → 抛 `Module not found`
- T4（RED）：调用 `registerSidecarSession` → 抛 `Module not found`

纯逻辑测试（无需 DB）：
- T5（RED）：`isPersonalTeamImmutable(patch)` 纯函数：传入 `{slug: 'x'}` 或 `{kind: 'shared'}` → 返回 true（不可改）
- T6（RED）：`isBudgetExceeded({usedTokens, totalTokens, usedCostCents, totalCostCents})` 纯函数：超额判定
- T7（RED）：`computeNextResetAt(period, from)` 纯函数：daily+1d / weekly+7d / monthly+30d
- T8（RED）：`shouldResetBudget(resetAt, now)` 纯函数：resetAt<=now → true
- T9（RED）：`isRecipientInTeam(recipientType, existsInTeam)` 纯函数：member/agent 跨 team 拒绝逻辑

DB 测试（dbAvailable guard 自动跳过）：
- T10：ensurePersonalTeam 幂等（同 userId 第二次调用 created=false）
- T11：updatePersonalTeam 拒绝改 slug → 400 PERSONAL_TEAM_IMMUTABLE
- T12：updatePersonalTeam 拒绝改 kind → 400 PERSONAL_TEAM_IMMUTABLE
- T13：recordUsage 原子 increment used_tokens/used_cost_cents
- T14：recordUsage 超额 → 409 BUDGET_EXCEEDED
- T15：checkBudget 超额返回 exceeded=true + reason
- T16：resetBudgetIfDue 推进 reset_at + 清零 used
- T17：sendMessage 跨 team recipient → 400 CROSS_TEAM_RECIPIENT
- T18：markRead 更新 read_at
- T19：listInbox / listSent 按 team_id 过滤
- T20：registerSidecarSession 写 sidecar_session_id
- T21：getSidecarSession 返回 sessionId + agentStatus
- T22：invalidateSidecarSession 清空 + status=offline

## 3. GREEN 阶段

写完 4 个 Service 并通过全部 T1-T22 测试。

### 3.1 PersonalTeamService
- `ensurePersonalTeam` 在用户注册/首次登录时调用（hook 注入点：`onUserSignup?: (userId, orgId) => Promise<void>`）
- personal team 不可改 kind/slug（I2 守门：纯函数 `isPersonalTeamImmutable(patch)`）

### 3.2 BudgetService
- `recordUsage` 用 `UPDATE ... SET used_tokens = used_tokens + ?` 原子 increment
- 写入前先 `checkBudget` 判定，超额返回 409（避免脏写）
- `checkBudget` 比较 `used < total`（任一超额即 exceeded=true）
- `resetBudgetIfDue` 检查 `reset_at <= now` 则 reset used=0 + 推进 reset_at（用 `computeNextResetAt` 纯函数）

### 3.3 MailboxService
- `sendMessage` 校验 recipient 同 team：
  - recipient_type=member → SELECT TeamMemberTable WHERE team_id + id（注意：team_member 表通过 orgMembershipId 关联；这里用 TeamAgentTable 的 team_id + agent_id 校验 agent）
  - recipient_type=agent → SELECT TeamAgentTable WHERE team_id + id
- `markRead` 更新 read_at
- `listInbox` / `listSent` 按 team_id + recipient/sender 过滤

### 3.4 SidecarService
- `registerSidecarSession` 写 `TeamAgentTable.sidecar_session_id`
- `invalidateSidecarSession` 清空 sidecar_session_id + status=offline
- 提供 `onAgentDeleted(agentId)` hook，由 team-agent-service 的 deleteAgent 调用（保证 I6）

## 4. REFACTOR
- `isPersonalTeamImmutable` / `isBudgetExceeded` / `computeNextResetAt` / `shouldResetBudget` 抽为纯函数
- 错误码统一 `PERSONAL_TEAM_IMMUTABLE` / `BUDGET_EXCEEDED` / `CROSS_TEAM_RECIPIENT` / `NOT_FOUND`
- mailbox 校验抽 `assertRecipientInTeam(teamId, recipient)` 内部函数

## 5. E2E
- 纯逻辑测试（T5-T9）无需 DB，直接跑
- DB 测试用 `dbAvailable` guard，DB 不存在时自动 skip

## 6. 沉淀
- 实现后把 API 签名、personal team 自动创建流程、budget reset 算法、sidecar session 生命周期追加到本 openspec 的 "Implementation Log"

---

## 7. Implementation Log

（实现后填充）
