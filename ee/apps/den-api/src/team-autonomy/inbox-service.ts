// InboxService — 团队 Inbox（5 类消息 + first-responder-wins 幂等 + durable resume）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-permission-inbox.md
//
// 不变量：
// P4: resolveInboxEntry 用 UPDATE ... WHERE status='pending' 乐观锁，影响行数=0 → 409 ALREADY_RESOLVED
// P5: createInboxEntry 在 externalToolCallId 非空时，UNIQUE 索引冲突 → 返回 created=false, reason="external_tool_call_exists"
//
// 注：team-autonomy 表的 JS 属性名为 snake_case（与 org.ts 不同），
// 所有 DB 列引用使用 snake_case，对外 API 使用 camelCase（通过 rowToInbox 映射）。

import { db } from "../db.js"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import {
  TeamInboxAssigneeType,
  TeamInboxKind,
  TeamInboxStatus,
  TeamInboxTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

// ============================================================
// 类型
// ============================================================

export { TeamInboxKind, TeamInboxStatus, TeamInboxAssigneeType }

export type InboxKind = typeof TeamInboxKind[number]
export type InboxStatus = typeof TeamInboxStatus[number]
export type InboxAssigneeType = typeof TeamInboxAssigneeType[number]

export type InboxRow = {
  id: string
  teamId: string
  sessionId: string | null
  taskId: string | null
  assigneeType: InboxAssigneeType
  assigneeId: string
  kind: InboxKind
  toolName: string | null
  arguments: Record<string, unknown> | null
  reason: string | null
  status: InboxStatus
  resolvedBy: string | null
  resolvedAt: Date | null
  resolution: Record<string, unknown> | null
  externalToolCallId: string | null
  createdAt: Date
  updatedAt: Date
}

export type InboxResolution =
  | { status: "resolved"; resolution: Record<string, unknown> }
  | { status: "denied"; reason: string }
  | { status: "superseded"; supersededBy: string }

export type CreateInboxInput = {
  teamId: string
  sessionId?: string
  taskId?: string
  assigneeType: InboxAssigneeType
  assigneeId: string
  kind: InboxKind
  toolName?: string
  arguments?: Record<string, unknown>
  reason?: string
  externalToolCallId?: string
}

export type CreateInboxResult =
  | { ok: true; entry: InboxRow; created: true }
  | { ok: true; entry: InboxRow; created: false; reason: "external_tool_call_exists" }
  | { ok: false; status: 400; response: { code: string; message: string } }

export type ResolveInboxResult =
  | { ok: true; entry: InboxRow }
  | { ok: false; status: 409; response: { code: "ALREADY_RESOLVED"; currentStatus: InboxStatus; resolvedBy: string } }
  | { ok: false; status: 404; response: { code: string; message: string } }

// ============================================================
// 行映射：snake_case schema → camelCase API
// ============================================================

function rowToInbox(row: typeof TeamInboxTable.$inferSelect): InboxRow {
  return {
    id: row.id,
    teamId: row.team_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    assigneeType: row.assignee_type,
    assigneeId: row.assignee_id,
    kind: row.kind,
    toolName: row.tool_name,
    arguments: row.arguments,
    reason: row.reason,
    status: row.status,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    externalToolCallId: row.external_tool_call_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ============================================================
// 内部：从 drizzle update 结果中提取 affectedRows
// ============================================================

// drizzle-orm/mysql2 的 db.update() 在不使用 .returning() 时返回 ResultSetHeader
// （含 affectedRows 字段）。不同版本/模式可能返回 tuple，统一兜底。
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

// mysql2 ER_DUP_ENTRY (1062) 唯一索引冲突
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const e = error as Record<string, unknown>
  if (e.code === "ER_DUP_ENTRY") return true
  if (e.errno === 1062) return true
  const cause = e.cause as Record<string, unknown> | undefined
  if (cause) {
    if (cause.code === "ER_DUP_ENTRY" || cause.errno === 1062) return true
  }
  return false
}

// ============================================================
// createInboxEntry（P5 幂等）
// ============================================================

export async function createInboxEntry(input: CreateInboxInput): Promise<CreateInboxResult> {
  // P5: externalToolCallId 非空时先查 UNIQUE 索引
  if (input.externalToolCallId) {
    const existing = await db
      .select()
      .from(TeamInboxTable)
      .where(eq(TeamInboxTable.external_tool_call_id, input.externalToolCallId))
      .limit(1)
    if (existing[0]) {
      return {
        ok: true,
        entry: rowToInbox(existing[0]),
        created: false,
        reason: "external_tool_call_exists",
      }
    }
  }

  const id = createDenTypeId("teamInbox")

  try {
    await db.insert(TeamInboxTable).values({
      id,
      team_id: input.teamId,
      session_id: input.sessionId ?? null,
      task_id: input.taskId ?? null,
      assignee_type: input.assigneeType,
      assignee_id: input.assigneeId,
      kind: input.kind,
      tool_name: input.toolName ?? null,
      arguments: input.arguments ?? null,
      reason: input.reason ?? null,
      status: "pending",
      external_tool_call_id: input.externalToolCallId ?? null,
    })
  } catch (error) {
    // 并发下两个 create 同时通过 pre-check，第二个会撞 UNIQUE 约束
    if (isUniqueViolation(error) && input.externalToolCallId) {
      const existing = await db
        .select()
        .from(TeamInboxTable)
        .where(eq(TeamInboxTable.external_tool_call_id, input.externalToolCallId))
        .limit(1)
      if (existing[0]) {
        return {
          ok: true,
          entry: rowToInbox(existing[0]),
          created: false,
          reason: "external_tool_call_exists",
        }
      }
    }
    throw error
  }

  const row = await db
    .select()
    .from(TeamInboxTable)
    .where(eq(TeamInboxTable.id, id))
    .limit(1)

  if (!row[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "inbox entry insert returned no row" },
    }
  }

  return { ok: true, entry: rowToInbox(row[0]), created: true }
}

// ============================================================
// listPendingInbox
// ============================================================

export async function listPendingInbox(
  teamId: string,
  assignee: { type: InboxAssigneeType; id: string },
): Promise<InboxRow[]> {
  const rows = await db
    .select()
    .from(TeamInboxTable)
    .where(
      and(
        eq(TeamInboxTable.team_id, teamId),
        eq(TeamInboxTable.assignee_type, assignee.type),
        eq(TeamInboxTable.assignee_id, assignee.id),
        eq(TeamInboxTable.status, "pending"),
      ),
    )
  return rows.map(rowToInbox)
}

// ============================================================
// resolveInboxEntry（first-responder-wins，P4）
// ============================================================

export async function resolveInboxEntry(
  inboxId: string,
  resolution: InboxResolution,
  resolvedBy: { memberId: string },
): Promise<ResolveInboxResult> {
  const now = new Date()

  const updateValues: Partial<typeof TeamInboxTable.$inferInsert> = {
    resolved_by: resolvedBy.memberId,
    resolved_at: now,
    updated_at: now,
  }

  if (resolution.status === "resolved") {
    updateValues.status = "resolved"
    updateValues.resolution = resolution.resolution
  } else if (resolution.status === "denied") {
    updateValues.status = "denied"
    updateValues.resolution = { reason: resolution.reason }
  } else {
    updateValues.status = "superseded"
    updateValues.resolution = { supersededBy: resolution.supersededBy }
  }

  // P4: 原子 UPDATE ... WHERE status='pending'
  // 两个并发 resolve 只会有一个 affectedRows=1，另一个 affectedRows=0 → 409
  const updateResult = await db
    .update(TeamInboxTable)
    .set(updateValues)
    .where(and(eq(TeamInboxTable.id, inboxId), eq(TeamInboxTable.status, "pending")))

  const affectedRows = extractAffectedRows(updateResult)

  if (affectedRows === 0) {
    // 行不存在或已被 resolve
    const current = await db
      .select()
      .from(TeamInboxTable)
      .where(eq(TeamInboxTable.id, inboxId))
      .limit(1)

    if (!current[0]) {
      return {
        ok: false,
        status: 404,
        response: { code: "NOT_FOUND", message: `inbox entry '${inboxId}' not found` },
      }
    }

    return {
      ok: false,
      status: 409,
      response: {
        code: "ALREADY_RESOLVED",
        currentStatus: current[0].status,
        resolvedBy: current[0].resolved_by ?? "",
      },
    }
  }

  const updated = await db
    .select()
    .from(TeamInboxTable)
    .where(eq(TeamInboxTable.id, inboxId))
    .limit(1)

  return { ok: true, entry: rowToInbox(updated[0]) }
}

// ============================================================
// durable resume
// ============================================================

export async function findInboxByExternalToolCallId(
  externalToolCallId: string,
): Promise<InboxRow | null> {
  const rows = await db
    .select()
    .from(TeamInboxTable)
    .where(eq(TeamInboxTable.external_tool_call_id, externalToolCallId))
    .limit(1)
  return rows[0] ? rowToInbox(rows[0]) : null
}

export async function findInboxById(inboxId: string): Promise<InboxRow | null> {
  const rows = await db
    .select()
    .from(TeamInboxTable)
    .where(eq(TeamInboxTable.id, inboxId))
    .limit(1)
  return rows[0] ? rowToInbox(rows[0]) : null
}

export async function resumeToolCall(
  inboxId: string,
  resolution: Record<string, unknown>,
): Promise<{ resumed: boolean; sessionId?: string }> {
  const inbox = await findInboxById(inboxId)
  if (!inbox) {
    return { resumed: false }
  }
  // 只有 resolved 状态的 inbox 才能 resume
  if (inbox.status !== "resolved") {
    return { resumed: false }
  }
  return {
    resumed: true,
    sessionId: inbox.sessionId ?? undefined,
  }
}
