// PersonalTeamService — 用户个人 team 自动创建 + 守门
// OpenSpecs: prds/team-autonomy/openspecs/openspec-sidecar-personal-budget.md
//
// 不变量：
// I1: 每个新 user 自动创建一个 kind=personal 的 team（owner_user_id = user.id, slug = "personal"）
//     ensurePersonalTeam 幂等：重复调用返回同一 team
// I2: personal team 的 slug 不可修改，kind 不可改为 shared/enterprise
//     → updatePersonalTeam 守门：传 slug/kind → 400 PERSONAL_TEAM_IMMUTABLE
//
// 注：TeamTable 使用 camelCase JS 属性（与 org.ts 一致，与 team-autonomy.ts 的 snake_case 不同）。
// 错误风格：discriminated union（{ ok: false, status, response: { code, message } }），
// 与 asset-service.ts / team-agent-service.ts 保持一致。

import { db } from "../db.js"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"

// ============================================================
// 类型导出
// ============================================================

// 边界转换：string → 模板字面量 DenTypeId（denTypeIdColumn 的 data 类型）
// 非法 id（前缀不匹配）→ null，调用方按"查询未命中"处理（保持原有 400/404 语义）
function normalizeIdOrNull<TName extends DenTypeIdName>(
  name: TName,
  value: string,
): DenTypeId<TName> | null {
  try {
    return normalizeDenTypeId(name, value)
  } catch {
    return null
  }
}

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
  organizationId: string
  name?: string
}

export type EnsurePersonalTeamResult =
  | { ok: true; team: PersonalTeamRow; created: boolean }
  | { ok: false; status: 400; response: { code: string; message: string } }

export type UpdatePersonalTeamInput = {
  name?: string
  settings?: Record<string, unknown>
}

export type UpdatePersonalTeamResult =
  | { ok: true; team: PersonalTeamRow }
  | { ok: false; status: 400 | 404; response: { code: string; message: string } }

// ============================================================
// 纯函数：personal team 守门（I2）
// ============================================================

// isPersonalTeamImmutable — 检测 patch 是否触及 personal team 的不可变字段
// 不可变：slug, kind；其他字段（name, settings）允许修改
// 接受 unknown 输入以便 controller 层把 zod-parsed 后的对象传进来
export function isPersonalTeamImmutable(patch: unknown): boolean {
  if (!patch || typeof patch !== "object") return false
  const p = patch as Record<string, unknown>
  return Object.prototype.hasOwnProperty.call(p, "slug") ||
    Object.prototype.hasOwnProperty.call(p, "kind")
}

// ============================================================
// 行映射：camelCase schema → camelCase API（kind 收窄为 'personal'）
// ============================================================

function rowToPersonalTeam(row: typeof TeamTable.$inferSelect): PersonalTeamRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug ?? "",
    // personal-team-service 只暴露 kind='personal' 的行；运行时 kind 可能是其他值
    // （查询时已 WHERE kind='personal' 兜底），但 TS 类型上需要收窄
    kind: row.kind as "personal",
    ownerUserId: row.ownerUserId ?? "",
    settings: (row.settings as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// ============================================================
// ensurePersonalTeam（I1 幂等）
// ============================================================

export async function ensurePersonalTeam(
  input: EnsurePersonalTeamInput,
): Promise<EnsurePersonalTeamResult> {
  const normalizedUserId = normalizeIdOrNull("user", input.userId)
  const normalizedOrgId = normalizeIdOrNull("organization", input.organizationId)
  if (!normalizedUserId || !normalizedOrgId) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "invalid user or organization id" },
    }
  }

  // I1: 先查 owner_user_id + kind='personal'
  const existing = await db
    .select()
    .from(TeamTable)
    .where(
      and(
        eq(TeamTable.ownerUserId, normalizedUserId),
        eq(TeamTable.kind, "personal"),
      ),
    )
    .limit(1)

  if (existing[0]) {
    return { ok: true, team: rowToPersonalTeam(existing[0]), created: false }
  }

  // 不存在 → 创建（slug='personal-<teamId>'、name='Personal <teamId>' 均唯一, kind='personal', owner_user_id=userId）
  // 注：team 表有 team_organization_slug/team_organization_name 两个 org 内唯一索引，
  //     同一 org 下多个用户的 personal team 必须用唯一 slug+name，否则第二个用户创建会撞索引
  const id = createDenTypeId("team")
  const name = input.name ?? `Personal ${id}`
  try {
    await db.insert(TeamTable).values({
      id,
      organizationId: normalizedOrgId,
      name,
      slug: `personal-${id}`,
      kind: "personal",
      ownerUserId: normalizedUserId,
      settings: null,
    })
  } catch (error) {
    // 并发下两个 ensurePersonalTeam 同时通过 pre-check，第二个会撞 unique 索引
    // （team_organization_slug 或其他）；回查一次
    const recheck = await db
      .select()
      .from(TeamTable)
      .where(
        and(
          eq(TeamTable.ownerUserId, normalizedUserId),
          eq(TeamTable.kind, "personal"),
        ),
      )
      .limit(1)
    if (recheck[0]) {
      return { ok: true, team: rowToPersonalTeam(recheck[0]), created: false }
    }
    return {
      ok: false,
      status: 400,
      response: {
        code: "INSERT_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }

  const row = await db.select().from(TeamTable).where(eq(TeamTable.id, id)).limit(1)
  if (!row[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "personal team insert did not return a row" },
    }
  }
  return { ok: true, team: rowToPersonalTeam(row[0]), created: true }
}

// ============================================================
// getPersonalTeam
// ============================================================

export async function getPersonalTeam(userId: string): Promise<PersonalTeamRow | null> {
  const normalizedUserId = normalizeIdOrNull("user", userId)
  if (!normalizedUserId) return null
  const rows = await db
    .select()
    .from(TeamTable)
    .where(
      and(
        eq(TeamTable.ownerUserId, normalizedUserId),
        eq(TeamTable.kind, "personal"),
      ),
    )
    .limit(1)
  return rows[0] ? rowToPersonalTeam(rows[0]) : null
}

// ============================================================
// updatePersonalTeam（I2 守门）
// ============================================================

export async function updatePersonalTeam(
  teamId: string,
  patch: UpdatePersonalTeamInput,
): Promise<UpdatePersonalTeamResult> {
  const normalizedTeamId = normalizeIdOrNull("team", teamId)
  if (!normalizedTeamId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `team ${teamId} not found` },
    }
  }

  // I2: personal team 守门 — slug/kind 不可改
  if (isPersonalTeamImmutable(patch)) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "PERSONAL_TEAM_IMMUTABLE",
        message: "personal team slug and kind cannot be changed",
      },
    }
  }

  const existing = await db.select().from(TeamTable).where(eq(TeamTable.id, normalizedTeamId)).limit(1)
  if (!existing[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `team ${teamId} not found` },
    }
  }

  // 防御性：如果 team 不是 personal，也不允许此 API 改（应走 teams.ts 的通用 update）
  if (existing[0].kind !== "personal") {
    return {
      ok: false,
      status: 400,
      response: {
        code: "NOT_PERSONAL_TEAM",
        message: `team ${teamId} is not a personal team (kind=${existing[0].kind})`,
      },
    }
  }

  const updates: Partial<typeof TeamTable.$inferInsert> = { updatedAt: new Date() }
  if (patch.name !== undefined) updates.name = patch.name
  if (patch.settings !== undefined) updates.settings = patch.settings

  await db.update(TeamTable).set(updates).where(eq(TeamTable.id, normalizedTeamId))

  const updated = await db.select().from(TeamTable).where(eq(TeamTable.id, normalizedTeamId)).limit(1)
  return { ok: true, team: updated[0] ? rowToPersonalTeam(updated[0]) : rowToPersonalTeam(existing[0]) }
}

// ============================================================
// Hook 注入点：onUserSignup
// 在 user signup / 首次登录时调用 ensurePersonalTeam
// 由调用方注入（auth.ts 的 after hook 或 controller 层）
// ============================================================

export type PersonalTeamHook = (
  userId: string,
  organizationId: string,
) => Promise<EnsurePersonalTeamResult>

export function createPersonalTeamHook(
  defaultOrgId: string,
): PersonalTeamHook {
  return (userId: string, organizationId: string = defaultOrgId) =>
    ensurePersonalTeam({ userId, organizationId })
}
