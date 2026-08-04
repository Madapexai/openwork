// SidecarService — OpenWorker sidecar session 生命周期 + agent 删除级联失效
// OpenSpecs: prds/team-autonomy/openspecs/openspec-sidecar-personal-budget.md
//
// 不变量：
// I6: sidecar session 绑定 team_agent
//     → registerSidecarSession 写 TeamAgentTable.sidecar_session_id
//     → invalidateSidecarSession 清空 sidecar_session_id + 设 status='offline'
//     → agent 删除时自动失效（onAgentDeleted hook，由 team-agent-service.deleteAgent 调用）
//
// 注：TeamAgentTable 使用 snake_case JS 属性。
// 错误风格：discriminated union（{ ok: false, status, response: { code, message } }）。

import { db } from "../db.js"
import { eq } from "@openwork-ee/den-db/drizzle"
import { TeamAgentStatus, TeamAgentTable } from "@openwork-ee/den-db/schema"

// ============================================================
// 类型导出
// ============================================================

export { TeamAgentStatus }

export type AgentStatusValue = typeof TeamAgentStatus[number]

export type SidecarSession = {
  agentId: string
  sessionId: string | null
  agentStatus: AgentStatusValue
}

export type RegisterSidecarResult =
  | { ok: true; session: SidecarSession }
  | { ok: false; status: 404; response: { code: string; message: string } }

export type InvalidateSidecarResult =
  | { ok: true; session: SidecarSession }
  | { ok: false; status: 404; response: { code: string; message: string } }

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
// 内部：行映射
// ============================================================

function rowToSession(row: {
  id: string
  sidecar_session_id: string | null
  status: typeof TeamAgentStatus[number]
}): SidecarSession {
  return {
    agentId: row.id,
    sessionId: row.sidecar_session_id,
    agentStatus: row.status,
  }
}

// ============================================================
// registerSidecarSession（I6 写 sidecar_session_id）
// ============================================================

export async function registerSidecarSession(
  agentId: string,
  sessionId: string,
): Promise<RegisterSidecarResult> {
  const updateResult = await db
    .update(TeamAgentTable)
    .set({
      sidecar_session_id: sessionId,
      updated_at: new Date(),
    })
    .where(eq(TeamAgentTable.id, agentId))

  const affected = extractAffectedRows(updateResult)
  if (affected === 0) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `agent ${agentId} not found` },
    }
  }

  const row = await db
    .select({
      id: TeamAgentTable.id,
      sidecar_session_id: TeamAgentTable.sidecar_session_id,
      status: TeamAgentTable.status,
    })
    .from(TeamAgentTable)
    .where(eq(TeamAgentTable.id, agentId))
    .limit(1)

  if (!row[0]) {
    // 极端情况：UPDATE 成功但读不到，构造一个回退 session
    return {
      ok: true,
      session: { agentId, sessionId, agentStatus: "idle" },
    }
  }
  return { ok: true, session: rowToSession(row[0]) }
}

// ============================================================
// getSidecarSession
// ============================================================

export async function getSidecarSession(agentId: string): Promise<SidecarSession | null> {
  const rows = await db
    .select({
      id: TeamAgentTable.id,
      sidecar_session_id: TeamAgentTable.sidecar_session_id,
      status: TeamAgentTable.status,
    })
    .from(TeamAgentTable)
    .where(eq(TeamAgentTable.id, agentId))
    .limit(1)
  return rows[0] ? rowToSession(rows[0]) : null
}

// ============================================================
// invalidateSidecarSession（I6 清空 + status=offline）
// ============================================================

export async function invalidateSidecarSession(
  agentId: string,
): Promise<InvalidateSidecarResult> {
  const updateResult = await db
    .update(TeamAgentTable)
    .set({
      sidecar_session_id: null,
      status: "offline",
      updated_at: new Date(),
    })
    .where(eq(TeamAgentTable.id, agentId))

  const affected = extractAffectedRows(updateResult)
  if (affected === 0) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `agent ${agentId} not found` },
    }
  }

  const row = await db
    .select({
      id: TeamAgentTable.id,
      sidecar_session_id: TeamAgentTable.sidecar_session_id,
      status: TeamAgentTable.status,
    })
    .from(TeamAgentTable)
    .where(eq(TeamAgentTable.id, agentId))
    .limit(1)

  if (!row[0]) {
    return {
      ok: true,
      session: { agentId, sessionId: null, agentStatus: "offline" },
    }
  }
  return { ok: true, session: rowToSession(row[0]) }
}

// ============================================================
// onAgentDeleted — agent 删除时 sidecar session 自动失效（I6 级联）
// ============================================================

// 由 team-agent-service.deleteAgent 在删除前调用
// （agent 行存在时执行 invalidate；行已删除则 no-op）
export async function onAgentDeleted(agentId: string): Promise<void> {
  // 直接 UPDATE sidecar_session_id=NULL, status='offline' WHERE id=agentId
  // 若 agent 已被删（行不存在），UPDATE 影响 0 行，no-op
  await db
    .update(TeamAgentTable)
    .set({
      sidecar_session_id: null,
      status: "offline",
      updated_at: new Date(),
    })
    .where(eq(TeamAgentTable.id, agentId))
  // 不抛错：调用方（deleteAgent）已经在 DELETE agent；此处只是兜底
  // 实际 agent 行会被 DELETE，sidecar_session_id 自然消失；
  // 此 hook 的价值在于"agent 删除前先 mark offline"以便 sidecar 侧清理资源。
}
