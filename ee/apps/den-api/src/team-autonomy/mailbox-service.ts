// MailboxService — 团队信箱（成员 + agent 间异步通信）+ recipient 同 team 守门
// OpenSpecs: prds/team-autonomy/openspecs/openspec-sidecar-personal-budget.md
//
// 不变量：
// I5: mailbox recipient 必须属于同 team
//     → recipient_type='member' 时校验 TeamMemberTable（teamId + orgMembershipId=recipientId）
//     → recipient_type='agent'  时校验 TeamAgentTable（team_id + id=recipientId）
//     → recipient_type='channel' 时不强制校验（广播语义）
//     → 校验失败返回 400 CROSS_TEAM_RECIPIENT
//
// 注：TeamMailboxTable / TeamAgentTable 使用 snake_case JS 属性；
// TeamMemberTable 使用 camelCase JS 属性（与 org.ts 一致）。
// 错误风格：discriminated union（{ ok: false, status, response: { code, message } }）。

import { db } from "../db.js"
import { and, desc, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  MailboxKind,
  MailboxRecipientType,
  MailboxSenderType,
  TeamAgentTable,
  TeamMailboxTable,
  TeamMemberTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"

// 内部：非法 typeid 返回 null（保持"查不到 → 404/空结果"语义，避免 normalizeDenTypeId 抛异常）
function parseDenTypeId<TName extends DenTypeIdName>(name: TName, value: string): DenTypeId<TName> | null {
  try {
    return normalizeDenTypeId(name, value)
  } catch {
    return null
  }
}

// ============================================================
// 类型导出
// ============================================================

export { MailboxKind, MailboxRecipientType, MailboxSenderType }

export type MailboxRecipientTypeValue = typeof MailboxRecipientType[number]
export type MailboxSenderTypeValue = typeof MailboxSenderType[number]
export type MailboxKindValue = typeof MailboxKind[number]

export type MailboxRow = {
  id: string
  teamId: string
  recipientType: MailboxRecipientTypeValue
  recipientId: string
  senderType: MailboxSenderTypeValue
  senderId: string
  kind: MailboxKindValue
  subject: string | null
  body: string | null
  attachmentRefs: string[] | null
  relatedTaskId: string | null
  readAt: Date | null
  createdAt: Date
}

export type SendMessageInput = {
  teamId: string
  recipientType: MailboxRecipientTypeValue
  recipientId: string
  senderType: MailboxSenderTypeValue
  senderId: string
  kind: MailboxKindValue
  subject?: string
  body?: string
  attachmentRefs?: string[]
  relatedTaskId?: string
}

export type SendMessageResult =
  | { ok: true; message: MailboxRow }
  | { ok: false; status: 400 | 404; response: { code: string; message: string } }

export type MarkReadResult =
  | { ok: true; message: MailboxRow }
  | { ok: false; status: 403 | 404; response: { code: string; message: string } }

// P3-C I1: markRead 的 actor（必须是收件人本人）
export type MailboxRecipient = {
  type: MailboxRecipientTypeValue
  id: string
}

// ============================================================
// 纯函数：recipient 同 team 守门（I5）
// ============================================================

// isRecipientInTeam — 给定 recipientType 和"是否在 team 中"的判定结果，决定是否允许发送
// - member / agent：existsInTeam=true 才允许
// - channel：广播，不强制校验（始终 true）
export function isRecipientInTeam(
  recipientType: MailboxRecipientTypeValue,
  existsInTeam: boolean,
): boolean {
  if (recipientType === "channel") return true
  return existsInTeam
}

// ============================================================
// 行映射：snake_case schema → camelCase API
// ============================================================

function rowToMailbox(row: typeof TeamMailboxTable.$inferSelect): MailboxRow {
  return {
    id: row.id,
    teamId: row.team_id,
    recipientType: row.recipient_type,
    recipientId: row.recipient_id,
    senderType: row.sender_type,
    senderId: row.sender_id,
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    attachmentRefs: row.attachment_refs,
    relatedTaskId: row.related_task_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  }
}

// ============================================================
// 内部：从 drizzle update 结果中提取 affectedRows
// ============================================================

function extractAffectedRows(result: unknown): number {
  if (!result) return 0
  if (typeof result === "object") {
    const r = result as Record<string, unknown>
    if (typeof r.affectedRows === "number") return r.affectedRows
    if (typeof r.rowsAffected === "number") return r.rowsAffected
    if (Array.isArray(r)) {
      const first = r[0] as Record<string, unknown> | undefined
      if (first) {
        if (typeof first.affectedRows === "number") return first.affectedRows
        if (typeof first.rowsAffected === "number") return first.rowsAffected
      }
    }
  }
  return 0
}

// ============================================================
// 内部：assertRecipientInTeam（I5 守门）
// ============================================================

async function assertRecipientInTeam(
  teamId: string,
  recipientType: MailboxRecipientTypeValue,
  recipientId: string,
): Promise<
  | { ok: true; existsInTeam: boolean }
  | { ok: false; status: 400; response: { code: string; message: string } }
> {
  if (recipientType === "channel") {
    return { ok: true, existsInTeam: true }
  }

  if (recipientType === "agent") {
    const parsedRecipientId = parseDenTypeId("teamAgent", recipientId)
    const parsedTeamId = parseDenTypeId("team", teamId)
    if (!parsedRecipientId || !parsedTeamId) return { ok: true, existsInTeam: false }
    const rows = await db
      .select({ id: TeamAgentTable.id })
      .from(TeamAgentTable)
      .where(
        and(
          eq(TeamAgentTable.id, parsedRecipientId),
          eq(TeamAgentTable.team_id, parsedTeamId),
        ),
      )
      .limit(1)
    return { ok: true, existsInTeam: !!rows[0] }
  }

  if (recipientType === "member") {
    // TeamMemberTable.teamId / orgMembershipId 是 camelCase
    const parsedTeamId = parseDenTypeId("team", teamId)
    const parsedRecipientId = parseDenTypeId("member", recipientId)
    if (!parsedTeamId || !parsedRecipientId) return { ok: true, existsInTeam: false }
    const rows = await db
      .select({ id: TeamMemberTable.id })
      .from(TeamMemberTable)
      .where(
        and(
          eq(TeamMemberTable.teamId, parsedTeamId),
          eq(TeamMemberTable.orgMembershipId, parsedRecipientId),
        ),
      )
      .limit(1)
    return { ok: true, existsInTeam: !!rows[0] }
  }

  return { ok: true, existsInTeam: true }
}

// ============================================================
// sendMessage（I5 守门）
// ============================================================

export async function sendMessage(
  input: SendMessageInput,
): Promise<SendMessageResult> {
  // P3-C I2: approval_request 必须携带 related_task_id
  if (input.kind === "approval_request" && !input.relatedTaskId) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "APPROVAL_REQUEST_REQUIRES_TASK",
        message: "approval_request messages must carry a relatedTaskId",
      },
    }
  }

  const check = await assertRecipientInTeam(
    input.teamId,
    input.recipientType,
    input.recipientId,
  )
  if (!check.ok) return check

  if (!isRecipientInTeam(input.recipientType, check.existsInTeam)) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "CROSS_TEAM_RECIPIENT",
        message: `recipient ${input.recipientType}:${input.recipientId} does not belong to team ${input.teamId}`,
      },
    }
  }

  const id = createDenTypeId("teamMailbox")
  await db.insert(TeamMailboxTable).values({
    id,
    team_id: normalizeDenTypeId("team", input.teamId),
    recipient_type: input.recipientType,
    recipient_id: input.recipientId,
    sender_type: input.senderType,
    sender_id: input.senderId,
    kind: input.kind,
    subject: input.subject ?? null,
    body: input.body ?? null,
    attachment_refs: input.attachmentRefs ?? null,
    related_task_id: input.relatedTaskId ? normalizeDenTypeId("teamTask", input.relatedTaskId) : null,
    read_at: null,
  })

  const row = await db
    .select()
    .from(TeamMailboxTable)
    .where(eq(TeamMailboxTable.id, id))
    .limit(1)

  if (!row[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "mailbox insert did not return a row" },
    }
  }
  return { ok: true, message: rowToMailbox(row[0]) }
}

// ============================================================
// markRead（P3-C I1：只允许本人标记已读）
//  - markRead(messageId)                    P2 兼容（无身份校验）
//  - markRead(messageId, actor)             校验 actor 必须是收件人 → 403 MAILBOX_READ_FORBIDDEN
// ============================================================

const MAILBOX_ID_PATTERN = /^tmbx_[a-z0-9]{26}$/

export async function markRead(messageId: string): Promise<MarkReadResult>
export async function markRead(
  messageId: string,
  actor: MailboxRecipient,
): Promise<MarkReadResult>
export async function markRead(
  messageId: string,
  actor?: MailboxRecipient,
): Promise<MarkReadResult> {
  // 服务层守卫：非法 typeid 直接 404（避免 drizzle 列映射对无效 typeid 抛错）
  if (!MAILBOX_ID_PATTERN.test(messageId)) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `mailbox message ${messageId} not found` },
    }
  }
  const parsedMessageId = parseDenTypeId("teamMailbox", messageId)
  if (!parsedMessageId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `mailbox message ${messageId} not found` },
    }
  }

  // I1: actor 提供时校验收件人身份
  if (actor) {
    const existing = await db
      .select()
      .from(TeamMailboxTable)
      .where(eq(TeamMailboxTable.id, parsedMessageId))
      .limit(1)
    if (!existing[0]) {
      return {
        ok: false,
        status: 404,
        response: { code: "NOT_FOUND", message: `mailbox message ${messageId} not found` },
      }
    }
    if (existing[0].recipient_type !== actor.type || existing[0].recipient_id !== actor.id) {
      return {
        ok: false,
        status: 403,
        response: {
          code: "MAILBOX_READ_FORBIDDEN",
          message: `message ${messageId} is addressed to ${existing[0].recipient_type}:${existing[0].recipient_id}, not ${actor.type}:${actor.id}`,
        },
      }
    }
  }

  const now = new Date()
  const updateResult = await db
    .update(TeamMailboxTable)
    .set({ read_at: now })
    .where(eq(TeamMailboxTable.id, parsedMessageId))

  const affected = extractAffectedRows(updateResult)
  if (affected === 0) {
    // 检查是"已读"还是"不存在"
    const existing = await db
      .select()
      .from(TeamMailboxTable)
      .where(eq(TeamMailboxTable.id, parsedMessageId))
      .limit(1)
    if (!existing[0]) {
      return {
        ok: false,
        status: 404,
        response: { code: "NOT_FOUND", message: `mailbox message ${messageId} not found` },
      }
    }
    // 已读 → 返回当前行（幂等）
    return { ok: true, message: rowToMailbox(existing[0]) }
  }

  const updated = await db
    .select()
    .from(TeamMailboxTable)
    .where(eq(TeamMailboxTable.id, parsedMessageId))
    .limit(1)

  // affected > 0 时行必然存在；若极端情况下读不到，回退到查询一次
  if (!updated[0]) {
    const fallback = await db
      .select()
      .from(TeamMailboxTable)
      .where(eq(TeamMailboxTable.id, parsedMessageId))
      .limit(1)
    if (!fallback[0]) {
      return {
        ok: false,
        status: 404,
        response: { code: "NOT_FOUND", message: `mailbox message ${messageId} not found after update` },
      }
    }
    return { ok: true, message: rowToMailbox(fallback[0]) }
  }
  return { ok: true, message: rowToMailbox(updated[0]) }
}

// ============================================================
// listInbox / listSent
// ============================================================

export async function listInbox(
  teamId: string,
  recipient: { type: MailboxRecipientTypeValue; id: string },
): Promise<MailboxRow[]> {
  const parsedTeamId = parseDenTypeId("team", teamId)
  if (!parsedTeamId) return []
  const rows = await db
    .select()
    .from(TeamMailboxTable)
    .where(
      and(
        eq(TeamMailboxTable.team_id, parsedTeamId),
        eq(TeamMailboxTable.recipient_type, recipient.type),
        eq(TeamMailboxTable.recipient_id, recipient.id),
      ),
    )
    .orderBy(desc(TeamMailboxTable.created_at))
  return rows.map(rowToMailbox)
}

export async function listSent(
  teamId: string,
  sender: { type: MailboxSenderTypeValue; id: string },
): Promise<MailboxRow[]> {
  const parsedTeamId = parseDenTypeId("team", teamId)
  if (!parsedTeamId) return []
  const rows = await db
    .select()
    .from(TeamMailboxTable)
    .where(
      and(
        eq(TeamMailboxTable.team_id, parsedTeamId),
        eq(TeamMailboxTable.sender_type, sender.type),
        eq(TeamMailboxTable.sender_id, sender.id),
      ),
    )
    .orderBy(desc(TeamMailboxTable.created_at))
  return rows.map(rowToMailbox)
}

// ============================================================
// getById（供 controller / 测试用）
// ============================================================

export async function getById(messageId: string): Promise<MailboxRow | null> {
  const parsedMessageId = parseDenTypeId("teamMailbox", messageId)
  if (!parsedMessageId) return null
  const rows = await db
    .select()
    .from(TeamMailboxTable)
    .where(eq(TeamMailboxTable.id, parsedMessageId))
    .limit(1)
  return rows[0] ? rowToMailbox(rows[0]) : null
}

// ============================================================
// P3-C 新增查询 API（I3 强制 team 作用域）
// ============================================================

// listByRecipient — 与 listInbox 同语义（team 强制作用域 I3）
export async function listByRecipient(
  teamId: string,
  recipient: MailboxRecipient,
): Promise<MailboxRow[]> {
  return listInbox(teamId, recipient)
}

// listUnread — WHERE team_id + recipient + read_at IS NULL
export async function listUnread(
  teamId: string,
  recipient: MailboxRecipient,
): Promise<MailboxRow[]> {
  const parsedTeamId = parseDenTypeId("team", teamId)
  if (!parsedTeamId) return []
  const rows = await db
    .select()
    .from(TeamMailboxTable)
    .where(
      and(
        eq(TeamMailboxTable.team_id, parsedTeamId),
        eq(TeamMailboxTable.recipient_type, recipient.type),
        eq(TeamMailboxTable.recipient_id, recipient.id),
        isNull(TeamMailboxTable.read_at),
      ),
    )
    .orderBy(desc(TeamMailboxTable.created_at))
  return rows.map(rowToMailbox)
}

// listByTask — WHERE related_task_id=taskId AND team_id=teamId（I3）
export async function listByTask(
  taskId: string,
  teamId: string,
): Promise<MailboxRow[]> {
  const parsedTaskId = parseDenTypeId("teamTask", taskId)
  const parsedTeamId = parseDenTypeId("team", teamId)
  if (!parsedTaskId || !parsedTeamId) return []
  const rows = await db
    .select()
    .from(TeamMailboxTable)
    .where(
      and(
        eq(TeamMailboxTable.related_task_id, parsedTaskId),
        eq(TeamMailboxTable.team_id, parsedTeamId),
      ),
    )
    .orderBy(desc(TeamMailboxTable.created_at))
  return rows.map(rowToMailbox)
}

// countUnread — COUNT 查询 → number（I3 强制 team 作用域）
export async function countUnread(
  teamId: string,
  recipient: MailboxRecipient,
): Promise<number> {
  const parsedTeamId = parseDenTypeId("team", teamId)
  if (!parsedTeamId) return 0
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(TeamMailboxTable)
    .where(
      and(
        eq(TeamMailboxTable.team_id, parsedTeamId),
        eq(TeamMailboxTable.recipient_type, recipient.type),
        eq(TeamMailboxTable.recipient_id, recipient.id),
        isNull(TeamMailboxTable.read_at),
      ),
    )
  return Number(rows[0]?.count ?? 0)
}
