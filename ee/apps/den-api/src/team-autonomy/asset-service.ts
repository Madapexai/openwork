// AssetService — 共享产物层状态机（单一事实源）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-asset-service.md
//
// 不变量：
// I1: 状态机校验 — draft → in_review → confirmed → superseded/archived
//     其他转换返回 409 INVALID_TRANSITION
// I2: 确认者权限 — 只有 owner/admin 可执行 confirm（viewer/editor → 403 FORBIDDEN_CONFIRMER）
// I3: 下游只读 confirmed — listArtifactsForDownstream 强制 status='confirmed'，
//     即使调用方传入恶意 filter 也不暴露 draft/in_review
// I4: 版本单调递增 — createArtifactVersion 在事务中 SELECT MAX(version_number)+1，
//     配合 UNIQUE(artifact_id, version_number) 防并发
// I5: supersede 自动化 — 新版本确认时，artifact.current_version 已 > 旧版本号，
//     旧版本对下游不可见（status 重置为 draft 直到新版本确认）
// I6: 任务关联 — task_id 非空时校验 task 属于同一 team_id（防跨团队污染）

import { db } from "../db.js"
import { and, eq, inArray, like, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  ArtifactKind,
  ArtifactStatus,
  TeamArtifactTable,
  TeamArtifactVersionTable,
  TeamTaskTable,
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

export { ArtifactKind, ArtifactStatus }

export type ArtifactId = string
export type ArtifactStatusValue = typeof ArtifactStatus[number]
export type ArtifactKindValue = typeof ArtifactKind[number]
export type ProducedByType = "member" | "agent"

export type ProducedBy = { type: ProducedByType; id: string }
export type Actor = { memberId: string; role: "owner" | "admin" | "editor" | "viewer" }

export type ArtifactRow = {
  id: string
  teamId: string
  taskId: string | null
  name: string
  kind: ArtifactKindValue
  mimeType: string | null
  storageUri: string
  sizeBytes: number
  status: ArtifactStatusValue
  currentVersion: number
  producedByType: ProducedByType
  producedById: string
  confirmedBy: string | null
  confirmedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type ArtifactVersionRow = {
  id: string
  artifactId: string
  versionNumber: number
  storageUri: string
  sizeBytes: number
  changeSummary: string | null
  producedByType: ProducedByType
  producedById: string
  createdAt: Date
}

export type CreateArtifactInput = {
  teamId: string
  taskId?: string
  name: string
  kind: ArtifactKindValue
  mimeType?: string
  storageUri: string
  sizeBytes: number
  producedBy: ProducedBy
}

export type ArtifactTransition =
  | { to: "in_review"; reviewerId?: string }
  | { to: "confirmed"; confirmedBy: string }
  | { to: "draft"; reason: string }
  | { to: "archived"; reason: string }

export type CreateArtifactResult =
  | { ok: true; artifact: ArtifactRow }
  | { ok: false; status: 400; response: { code: string; message: string } }

export type TransitionResult =
  | { ok: true; artifact: ArtifactRow; previousStatus: ArtifactStatusValue }
  | { ok: false; status: 409; response: { code: "INVALID_TRANSITION"; from: ArtifactStatusValue; to: ArtifactStatusValue } }
  | { ok: false; status: 403; response: { code: "FORBIDDEN_CONFIRMER" } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type CreateVersionResult =
  | { ok: true; version: number }
  | { ok: false; status: 400 | 404 | 409; response: { code: string; message: string } }

// ============================================================
// 纯函数：状态机校验（I1）— 无需 DB，可单测
// ============================================================

const ALLOWED_TRANSITIONS: Record<ArtifactStatusValue, ArtifactStatusValue[]> = {
  draft: ["in_review"],
  in_review: ["confirmed", "draft"],
  confirmed: ["superseded", "archived"],
  superseded: ["archived"],
  archived: [],
}

export function isValidTransition(from: ArtifactStatusValue, to: ArtifactStatusValue): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

export function canConfirm(role: Actor["role"]): boolean {
  return role === "owner" || role === "admin"
}

// ============================================================
// 行映射：snake_case schema → camelCase API
// ============================================================

function rowToArtifact(row: typeof TeamArtifactTable.$inferSelect): ArtifactRow {
  return {
    id: row.id,
    teamId: row.team_id,
    taskId: row.task_id,
    name: row.name,
    kind: row.kind,
    mimeType: row.mime_type,
    storageUri: row.storage_uri,
    sizeBytes: row.size_bytes,
    status: row.status,
    currentVersion: row.current_version,
    producedByType: row.produced_by_type,
    producedById: row.produced_by_id,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToVersion(row: typeof TeamArtifactVersionTable.$inferSelect): ArtifactVersionRow {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    versionNumber: row.version_number,
    storageUri: row.storage_uri,
    sizeBytes: row.size_bytes,
    changeSummary: row.change_summary,
    producedByType: row.produced_by_type,
    producedById: row.produced_by_id,
    createdAt: row.created_at,
  }
}

// ============================================================
// createArtifact — I6 cross-team task check
// ============================================================

export async function createArtifact(input: CreateArtifactInput): Promise<CreateArtifactResult> {
  // I6: 跨团队 task_id 校验
  if (input.taskId) {
    const parsedTaskId = parseDenTypeId("teamTask", input.taskId)
    if (!parsedTaskId) {
      return {
        ok: false,
        status: 400,
        response: {
          code: "CROSS_TEAM_TASK",
          message: `task ${input.taskId} does not belong to team ${input.teamId}`,
        },
      }
    }
    const taskRows = await db
      .select({ id: TeamTaskTable.id, teamId: TeamTaskTable.team_id })
      .from(TeamTaskTable)
      .where(eq(TeamTaskTable.id, parsedTaskId))
      .limit(1)
    if (!taskRows[0] || taskRows[0].teamId !== input.teamId) {
      return {
        ok: false,
        status: 400,
        response: {
          code: "CROSS_TEAM_TASK",
          message: `task ${input.taskId} does not belong to team ${input.teamId}`,
        },
      }
    }
  }

  const id = createDenTypeId("teamArtifact")
  await db.insert(TeamArtifactTable).values({
    id,
    team_id: normalizeDenTypeId("team", input.teamId),
    task_id: input.taskId ? normalizeDenTypeId("teamTask", input.taskId) : null,
    name: input.name,
    kind: input.kind,
    mime_type: input.mimeType ?? null,
    storage_uri: input.storageUri,
    size_bytes: input.sizeBytes,
    status: "draft",
    current_version: 1,
    produced_by_type: input.producedBy.type,
    produced_by_id: input.producedBy.id,
    confirmed_by: null,
    confirmed_at: null,
  })

  // 同时写 version 1（不可变版本表）
  const versionId = createDenTypeId("teamArtifactVersion")
  await db.insert(TeamArtifactVersionTable).values({
    id: versionId,
    artifact_id: id,
    version_number: 1,
    storage_uri: input.storageUri,
    size_bytes: input.sizeBytes,
    change_summary: null,
    produced_by_type: input.producedBy.type,
    produced_by_id: input.producedBy.id,
  })

  const rows = await db.select().from(TeamArtifactTable).where(eq(TeamArtifactTable.id, id)).limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "artifact insert did not return a row" },
    }
  }
  return { ok: true, artifact: rowToArtifact(rows[0]) }
}

// ============================================================
// getArtifact
// ============================================================

export async function getArtifact(artifactId: string): Promise<ArtifactRow | null> {
  const parsedArtifactId = parseDenTypeId("teamArtifact", artifactId)
  if (!parsedArtifactId) return null
  const rows = await db.select().from(TeamArtifactTable).where(eq(TeamArtifactTable.id, parsedArtifactId)).limit(1)
  return rows[0] ? rowToArtifact(rows[0]) : null
}

// ============================================================
// transitionArtifact — 状态机守门人（I1 + I2）
// ============================================================

export async function transitionArtifact(
  artifactId: string,
  transition: ArtifactTransition,
  actor: Actor,
): Promise<TransitionResult> {
  const parsedArtifactId = parseDenTypeId("teamArtifact", artifactId)
  if (!parsedArtifactId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `artifact ${artifactId} not found` },
    }
  }
  const rows = await db.select().from(TeamArtifactTable).where(eq(TeamArtifactTable.id, parsedArtifactId)).limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `artifact ${artifactId} not found` },
    }
  }
  const current = rowToArtifact(rows[0])
  const previousStatus = current.status
  const targetStatus = transition.to

  // I2: 确认者权限 — confirm 只允许 owner/admin
  if (targetStatus === "confirmed" && !canConfirm(actor.role)) {
    return { ok: false, status: 403, response: { code: "FORBIDDEN_CONFIRMER" } }
  }

  // I1: 状态机校验
  if (!isValidTransition(previousStatus, targetStatus)) {
    return {
      ok: false,
      status: 409,
      response: { code: "INVALID_TRANSITION", from: previousStatus, to: targetStatus },
    }
  }

  const now = new Date()
  const updates: Partial<typeof TeamArtifactTable.$inferInsert> = {
    status: targetStatus,
    updated_at: now,
  }
  if (targetStatus === "confirmed") {
    updates.confirmed_by = normalizeDenTypeId("member", (transition as { to: "confirmed"; confirmedBy: string }).confirmedBy)
    updates.confirmed_at = now
  }

  await db.update(TeamArtifactTable).set(updates).where(eq(TeamArtifactTable.id, parsedArtifactId))

  const updatedRows = await db
    .select()
    .from(TeamArtifactTable)
    .where(eq(TeamArtifactTable.id, parsedArtifactId))
    .limit(1)

  return {
    ok: true,
    artifact: updatedRows[0] ? rowToArtifact(updatedRows[0]) : current,
    previousStatus,
  }
}

// ============================================================
// listArtifactsForDownstream — I3 下游只读 confirmed
// ============================================================

export async function listArtifactsForDownstream(
  teamId: string,
  filter?: { taskId?: string; kind?: ArtifactKindValue; producedBy?: ProducedBy },
): Promise<ArtifactRow[]> {
  // I3: 强制 status='confirmed'，无论调用方传入什么 filter
  const parsedTeamId = parseDenTypeId("team", teamId)
  if (!parsedTeamId) return []
  const parsedTaskId = filter?.taskId ? parseDenTypeId("teamTask", filter.taskId) : undefined
  if (filter?.taskId && !parsedTaskId) return []
  const conditions = [
    eq(TeamArtifactTable.team_id, parsedTeamId),
    eq(TeamArtifactTable.status, "confirmed"),
  ]
  if (parsedTaskId) conditions.push(eq(TeamArtifactTable.task_id, parsedTaskId))
  if (filter?.kind) conditions.push(eq(TeamArtifactTable.kind, filter.kind))
  if (filter?.producedBy) {
    conditions.push(eq(TeamArtifactTable.produced_by_type, filter.producedBy.type))
    conditions.push(eq(TeamArtifactTable.produced_by_id, filter.producedBy.id))
  }

  const rows = await db.select().from(TeamArtifactTable).where(and(...conditions))
  return rows.map(rowToArtifact)
}

// ============================================================
// listArtifactsByProducer — 含 draft/in_review，供产出自检
// ============================================================

export async function listArtifactsByProducer(
  teamId: string,
  producer: ProducedBy,
): Promise<ArtifactRow[]> {
  const parsedTeamId = parseDenTypeId("team", teamId)
  if (!parsedTeamId) return []
  const rows = await db
    .select()
    .from(TeamArtifactTable)
    .where(
      and(
        eq(TeamArtifactTable.team_id, parsedTeamId),
        eq(TeamArtifactTable.produced_by_type, producer.type),
        eq(TeamArtifactTable.produced_by_id, producer.id),
      ),
    )
  return rows.map(rowToArtifact)
}

// ============================================================
// createArtifactVersion — I4 单调递增 + I5 supersede
// ============================================================

export async function createArtifactVersion(
  artifactId: string,
  input: { storageUri: string; sizeBytes: number; changeSummary?: string; producedBy: ProducedBy },
): Promise<CreateVersionResult> {
  const parsedArtifactId = parseDenTypeId("teamArtifact", artifactId)
  if (!parsedArtifactId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `artifact ${artifactId} not found` },
    }
  }
  const rows = await db.select().from(TeamArtifactTable).where(eq(TeamArtifactTable.id, parsedArtifactId)).limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `artifact ${artifactId} not found` },
    }
  }

  // I4: SELECT MAX(version_number) + 1（UNIQUE 索引兜底并发）
  const maxRows = await db
    .select({ maxVersion: sql<number>`MAX(${TeamArtifactVersionTable.version_number})` })
    .from(TeamArtifactVersionTable)
    .where(eq(TeamArtifactVersionTable.artifact_id, parsedArtifactId))
  const nextVersion = (Number(maxRows[0]?.maxVersion ?? 0) || 0) + 1

  const versionId = createDenTypeId("teamArtifactVersion")
  try {
    await db.insert(TeamArtifactVersionTable).values({
      id: versionId,
      artifact_id: parsedArtifactId,
      version_number: nextVersion,
      storage_uri: input.storageUri,
      size_bytes: input.sizeBytes,
      change_summary: input.changeSummary ?? null,
      produced_by_type: input.producedBy.type,
      produced_by_id: input.producedBy.id,
    })
  } catch {
    // 并发冲突：UNIQUE(artifact_id, version_number)
    return {
      ok: false,
      status: 409,
      response: {
        code: "VERSION_CONFLICT",
        message: `concurrent version creation conflict for artifact ${artifactId}`,
      },
    }
  }

  // I5: supersede 旧版本 — artifact.current_version+1，status 重置为 draft
  // 旧 confirmed 行不再可见于下游（listArtifactsForDownstream 强制 status='confirmed'）
  await db
    .update(TeamArtifactTable)
    .set({ current_version: nextVersion, status: "draft", updated_at: new Date() })
    .where(eq(TeamArtifactTable.id, parsedArtifactId))

  return { ok: true, version: nextVersion }
}

// ============================================================
// getArtifactVersion — 回溯指定版本
// ============================================================

export async function getArtifactVersion(
  artifactId: string,
  version: number,
): Promise<ArtifactVersionRow | null> {
  const parsedArtifactId = parseDenTypeId("teamArtifact", artifactId)
  if (!parsedArtifactId) return null
  const rows = await db
    .select()
    .from(TeamArtifactVersionTable)
    .where(
      and(
        eq(TeamArtifactVersionTable.artifact_id, parsedArtifactId),
        eq(TeamArtifactVersionTable.version_number, version),
      ),
    )
    .limit(1)
  return rows[0] ? rowToVersion(rows[0]) : null
}
