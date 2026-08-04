# OpenSpecs — MailboxService（P3-C 端到端）

> Service: `ee/apps/den-api/src/team-autonomy/mailbox-service.ts`
> Test: `ee/apps/den-api/test/team-autonomy/mailbox-service.test.ts`
> Table: `team_mailbox`（from `@openwork-ee/den-db/schema`）
>
> 设计依据：
> - WorkBuddy Bluebook Ch5：agent 与 member 通过 mailbox 异步协作（消息/任务更新/审批请求/通知）
> - 邮箱安全边界：**消息不可跨 team 访问**；**读标记只允许本人**；**审批请求必须绑定任务**
> - 借鉴 operational-errors 风格：Result discriminated union + HTTP-ish 状态码
>
> 前置：P2 已实现 `sendMessage` / `markRead(messageId)` / `listInbox` / `listSent` / `getById`。
> 本 openspec 在既有实现上补齐 P3 能力：**markRead 收件人身份校验**（I1）、**approval_request 必须带 related_task_id**（I2）、
> **全部查询 API 强制 team 作用域**（I3）+ 新增 `listByRecipient` / `listUnread` / `listByTask` / `countUnread`。

---

## 1. 规范定义（Spec）

### 1.1 不变量（3 条必须 test）

| ID | 不变量 | 失败返回 |
|---|---|---|
| I1 | 读消息标记 `read_at` 只允许**本人**（recipient_type + recipient_id 必须匹配消息的 recipient） | 403 / MAILBOX_READ_FORBIDDEN |
| I2 | `kind='approval_request'` 的消息必须携带 `related_task_id` | 400 / APPROVAL_REQUEST_REQUIRES_TASK |
| I3 | 消息不可跨 team 访问：所有公开查询 API 以 `teamId` 为强制作用域（listInbox / listByRecipient / listUnread / countUnread）；`listByTask` 也强制 team 作用域 | — |

### 1.2 流程

```
sendMessage({teamId, recipientType, recipientId, senderType, senderId, kind, subject, body, attachmentRefs, relatedTaskId})
   ├─ kind='approval_request' && !relatedTaskId → 400 APPROVAL_REQUEST_REQUIRES_TASK（I2）
   ├─ recipient 在 team 内校验（isRecipientInTeam；channel 恒真；跨 team → 400 CROSS_TEAM_RECIPIENT）
   └─ INSERT team_mailbox

markRead(messageId, actor?)                          ← I1
   ├─ messageId 非法 typeid → 404 NOT_FOUND（服务层守卫，不抛给 drizzle 列映射）
   ├─ actor 提供时：
   │    ├─ 消息不存在 → 404 NOT_FOUND
   │    └─ actor.recipient ≠ message.recipient → 403 MAILBOX_READ_FORBIDDEN（I1）
   ├─ UPDATE read_at=now（本人/无 actor 兼容路径）
   └─ 返回 { ok: true, message }

listByRecipient(teamId, recipient) / listInbox(teamId, recipient)   ← I3（team 强制作用域）
listUnread(teamId, recipient)   ← read_at IS NULL + I3
listByTask(taskId, teamId)      ← related_task_id + I3
countUnread(teamId, recipient)  ← 未读数（number）
```

### 1.3 Surface（durable contract）

```ts
// ---------- Mailbox（P3-C）----------
export type MailboxRecipient =
  | { type: "member" | "agent"; id: string }
  | { type: "channel"; id: "all" | "admins" }

export type MarkReadResult =
  | { ok: true; message: MailboxRow }
  | { ok: false; status: 403 | 404; response: { code: string; message: string } }

export function sendMessage(input: SendMessageInput): Promise<SendMessageResult>            // + I2 校验
export function markRead(messageId: string): Promise<MarkReadResult>                        // P2 兼容（无身份校验）
export function markRead(messageId: string, actor: MailboxRecipient): Promise<MarkReadResult> // I1 收件人身份校验
export function listByRecipient(teamId: string, recipient: MailboxRecipient): Promise<MailboxRow[]> // I3（= listInbox 语义）
export function listInbox(teamId: string, recipient: MailboxRecipient): Promise<MailboxRow[]>        // P2 保持
export function listUnread(teamId: string, recipient: MailboxRecipient): Promise<MailboxRow[]>        // I1+（read_at IS NULL）
export function listByTask(taskId: string, teamId: string): Promise<MailboxRow[]>                    // I3（强制 team 作用域）
export function countUnread(teamId: string, recipient: MailboxRecipient): Promise<number>            // 未读数
```

### 1.4 E2E 场景（端到端验证）

```
E2E-P3C: "邮箱安全边界全链路"
  1. sendMessage({teamId, recipient agentA, kind:'notification'}) → ok（I3 基础）
  2. sendMessage({kind:'approval_request', 无 relatedTaskId}) → 400 APPROVAL_REQUEST_REQUIRES_TASK（I2）
  3. sendMessage({kind:'approval_request', relatedTaskId}) → ok（I2）
  4. markRead(msg1.id, {type:'agent', id:agentB})（非收件人）→ 403 MAILBOX_READ_FORBIDDEN（I1）
  5. markRead(msg1.id, {type:'agent', id:agentA})（收件人本人）→ ok，readAt 非空（I1）
  6. markRead('tmbx_非法typeid', …) → 404 NOT_FOUND（服务层守卫）
  7. listUnread(teamId, agentA) → 未读消息（已读的 msg1 不出现）
  8. listByTask(taskId, teamId) → 该任务相关消息
  9. listByTask(taskId, otherTeamId) → []（I3 跨 team 隔离）
 10. countUnread(teamId, agentA) → 未读数
```

---

## 2. RED 阶段 — 必须失败的测试

`node --import tsx --test test/team-autonomy/mailbox-service.test.ts` 在实现前必须失败：

- T1（RED）：`markRead(msgId, actor)` 非收件人 → `403 MAILBOX_READ_FORBIDDEN`（现有 markRead 无身份校验）
- T2（RED）：`sendMessage(approval_request 无 task)` → `400 APPROVAL_REQUEST_REQUIRES_TASK`（现有未校验）
- T3（RED）：`listUnread` → `Function not implemented`
- T4（RED）：`listByTask` → `Function not implemented`
- T5（RED）：`countUnread` → `Function not implemented`
- T6（RED）：`listByRecipient` → `Function not implemented`

GREEN 后（DB 可用）验证：
- T1：I1 markRead 本人 ok / 非本人 403 / 无效 typeid 404
- T2：I2 approval_request 无 related_task_id → 400
- T3：I3 跨 team 查询隔离（listByTask / listUnread 空）
- T4：I3 listByRecipient 返回本 team 消息
- T5：listUnread 只含未读
- T6：listByTask 按任务过滤 + countUnread 计数

## 3. GREEN 阶段

- `sendMessage`：追加 I2 校验（`kind==='approval_request' && !relatedTaskId` → 400 `APPROVAL_REQUEST_REQUIRES_TASK`）
- `markRead` 重载（可选 actor）：
  - 消息不存在 → 404 `NOT_FOUND`
  - actor 提供时校验 recipient 身份（I1）：非本人 → 403 `MAILBOX_READ_FORBIDDEN`
  - 非法 typeid → 服务层守卫返回 404（避免 drizzle 列映射崩溃）
  - 无 actor（P2 兼容）→ 原逻辑
- `listByRecipient`：与 `listInbox` 同语义（team 强制作用域 I3）
- `listUnread(teamId, recipient)`：`WHERE team_id + recipient + read_at IS NULL`（`isNull`）
- `listByTask(taskId, teamId)`：`WHERE related_task_id=taskId AND team_id=teamId`（I3）
- `countUnread(teamId, recipient)`：COUNT 查询 → number
- 错误码：`MAILBOX_READ_FORBIDDEN` / `APPROVAL_REQUEST_REQUIRES_TASK` / `NOT_FOUND`

## 4. REFACTOR

- 复用现有 `isRecipientInTeam` / `buildRecipientWhere` / `rowToMailbox` / `extractAffectedRows`
- `markRead` 的 typeid 守卫：`/^tmbx_[a-z0-9]{26}$/` 校验失败 → 404（统一 NOT_FOUND）
- 查询一律从 `teamId` 出发拼 `eq(team_id)`，杜绝跨 team 泄露

## 5. E2E

- 纯逻辑测试（isRecipientInTeam）无需 DB
- DB 测试用 `dbAvailable` guard（同 `sidecar-personal-budget.test.ts` 模式）
- 兼容性回归：P2 的 `sidecar-personal-budget.test.ts` T17/T18/T19 必须继续通过

## 6. 沉淀

- 实现后把实际签名、守卫逻辑、错误码追加到本 openspec 的 "Implementation Log"。

---

## 7. Implementation Log

### GREEN 实现（2026-08-04）
- 文件：`ee/apps/den-api/src/team-autonomy/mailbox-service.ts`（在 P2 基础上扩展，保持 P2 签名兼容：`sendMessage/listInbox/listSent/getById/isRecipientInTeam` 原样保留）
- P3 导出签名：
  - `sendMessage(input: SendMessageInput)`：新增 I2 校验（`kind='approval_request'` 且无 relatedTaskId → 400 APPROVAL_REQUEST_REQUIRES_TASK）
  - `markRead(messageId)` / `markRead(messageId, actor: MailboxRecipient)` 重载：I1 身份校验 + `MAILBOX_ID_PATTERN` typeid 守卫
  - `listByRecipient(teamId, recipient: MailboxRecipient)`（= listInbox，I3 强制 team 作用域）
  - `listUnread(teamId, recipient)`（`WHERE read_at IS NULL`，`isNull` 过滤）
  - `listByTask(taskId, teamId)`（`WHERE related_task_id + team_id`，I3）
  - `countUnread(teamId, recipient): Promise<number>`（`COUNT(*)`）
- 守卫逻辑：
  - I1：markRead 提供 actor 时校验收件人身份，非本人 → 403 MAILBOX_READ_FORBIDDEN；未提供 actor 保持 P2 语义
  - 非法 typeid（不匹配 `/^tmbx_[a-z0-9]{26}$/`）→ 404 NOT_FOUND（避免 drizzle 列映射对无效 typeid 崩溃）
  - 消息不存在 → 404 NOT_FOUND；已读重复调用幂等返回当前行
- 错误码：400 APPROVAL_REQUEST_REQUIRES_TASK / 400 CROSS_TEAM_RECIPIENT / 403 MAILBOX_READ_FORBIDDEN / 404 NOT_FOUND
- 注意：`related_task_id` 列是 `denTypeIdColumn("teamTask")`（前缀 `ttsk`），调用方必须传 `ttsk_` typeid，否则 drizzle 列映射抛 TypeID prefix mismatch
- 测试：`ee/apps/den-api/test/team-autonomy/mailbox-service.test.ts`（T0-T8，GREEN 9/9）
