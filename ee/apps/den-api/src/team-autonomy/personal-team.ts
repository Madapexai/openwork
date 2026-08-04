// PersonalTeam — member 驱动的 personal team 自动创建（P3-A）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-personal-team.md
//
// 不变量：
// I1: 新用户注册后自动创建 kind=personal 的 Team（slug="personal-<teamId>" 唯一, owner_user_id=userId）
//     ensurePersonalTeam(memberId, userId) 幂等：重复调用返回同一 team
// I2: personal team 的 ownerUserId = 传入的 userId（member 必须属于该 userId）
//     → member.userId ≠ userId → 403 MEMBER_USER_MISMATCH
// I3: personal team 创建时自动创建 team_permission_profile
//     （profile="simple", default_mode="craft", updated_by=memberId）
//
// 注：MemberTable / TeamTable 使用 camelCase JS 属性（与 org.ts 一致）；
//     TeamPermissionProfileTable 使用 snake_case JS 属性（与 team-autonomy.ts 一致）。
// 错误风格：discriminated union（{ ok: false, status, response: { code, message } }）。
//
// 与 personal-team-service.ts 的关系：后者是低层（显式传 organizationId，无 permission profile），
// 本文件是 member 驱动的高层入口（从 member 行解析 org + 自动建 profile），并供 auth.ts hook 使用。

import { db } from "../db.js"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  MemberTable,
  TeamPermissionProfileTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"

// ============================================================
// 类型导出
// ============================================================

// 边界转换：string → 模板字面量 DenTypeId（denTypeIdColumn 的 data 类型）
// 非法 id（前缀不匹配）→ null，调用方按"查询未命中"处理（保持原有 404/400 语义）
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

export type MemberScopedPersonalTeamRow = {
  id: string
  organizationId: string
  name: string
  slug: string
  kind: "personal"
  ownerUserId: string
  createdAt: Date
}

export type EnsurePersonalTeamResult =
  | { ok: true; team: MemberScopedPersonalTeamRow; created: boolean }
  | { ok: false; status: 403 | 404; response: { code: string; message: string } }

// ============================================================
// 行映射
// ============================================================

function rowToPersonalTeam(row: typeof TeamTable.$inferSelect): MemberScopedPersonalTeamRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug ?? "",
    kind: "personal",
    ownerUserId: row.ownerUserId ?? "",
    createdAt: row.createdAt,
  }
}

// ============================================================
// ensurePersonalPermissionProfile（I3：幂等建默认 profile）
// ============================================================

export async function ensurePersonalPermissionProfile(
  teamId: string,
  updatedByMemberId: string,
): Promise<{ ok: boolean; created: boolean }> {
  const normalizedTeamId = normalizeIdOrNull("team", teamId)
  if (!normalizedTeamId) {
    // 非法 teamId（非 tem_ 前缀）→ 无既有 profile，幂等视为已存在
    return { ok: true, created: false }
  }
  const existing = await db
    .select()
    .from(TeamPermissionProfileTable)
    .where(eq(TeamPermissionProfileTable.team_id, normalizedTeamId))
    .limit(1)
  if (existing[0]) {
    // 已有配置（可能是用户改过的）→ 保留，不覆盖
    return { ok: true, created: false }
  }

  const normalizedUpdatedBy = normalizeIdOrNull("member", updatedByMemberId)
  if (!normalizedUpdatedBy) {
    return { ok: false, created: false }
  }

  const id = createDenTypeId("teamPermissionProfile")
  try {
    await db.insert(TeamPermissionProfileTable).values({
      id,
      team_id: normalizedTeamId,
      profile: "simple",
      default_mode: "craft",
      custom_rules: null,
      updated_by: normalizedUpdatedBy,
    })
  } catch (error) {
    // 并发下重复插入撞 unique(team_id) → 回查一次
    const recheck = await db
      .select()
      .from(TeamPermissionProfileTable)
      .where(eq(TeamPermissionProfileTable.team_id, normalizedTeamId))
      .limit(1)
    if (recheck[0]) return { ok: true, created: false }
    return { ok: false, created: false }
  }
  return { ok: true, created: true }
}

// ============================================================
// ensurePersonalTeam（I1 幂等 + I2 身份校验 + I3 自动建 profile）
// ============================================================

export async function ensurePersonalTeam(
  memberId: string,
  userId: string,
): Promise<EnsurePersonalTeamResult> {
  // I2/I1: 先解析 member（不存在 → 404；不属于该 user → 403）
  const normalizedMemberId = normalizeIdOrNull("member", memberId)
  if (!normalizedMemberId) {
    return {
      ok: false,
      status: 404,
      response: { code: "MEMBER_NOT_FOUND", message: `member ${memberId} not found` },
    }
  }
  const members = await db
    .select()
    .from(MemberTable)
    .where(eq(MemberTable.id, normalizedMemberId))
    .limit(1)

  if (!members[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "MEMBER_NOT_FOUND", message: `member ${memberId} not found` },
    }
  }
  if (members[0].userId !== userId) {
    return {
      ok: false,
      status: 403,
      response: {
        code: "MEMBER_USER_MISMATCH",
        message: `member ${memberId} does not belong to user ${userId}`,
      },
    }
  }

  const organizationId = members[0].organizationId

  // I1: 幂等 — 已存在 personal team 直接返回（同时补建 profile，兼容旧数据）
  const normalizedUserId = normalizeIdOrNull("user", userId)
  if (!normalizedUserId) {
    return {
      ok: false,
      status: 404,
      response: { code: "INSERT_FAILED", message: `invalid user id: ${userId}` },
    }
  }
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
    await ensurePersonalPermissionProfile(existing[0].id, memberId)
    return { ok: true, team: rowToPersonalTeam(existing[0]), created: false }
  }

  // 不存在 → 创建（slug='personal-<teamId>'、name='Personal <teamId>' 均唯一, kind='personal', owner_user_id=userId）
  // 注：team 表有 team_organization_slug/team_organization_name 两个 org 内唯一索引，
  //     同一 org 下多个用户的 personal team 必须用唯一 slug+name，否则第二个用户创建会撞索引
  const id = createDenTypeId("team")
  try {
    await db.insert(TeamTable).values({
      id,
      organizationId,
      name: `Personal ${id}`,
      slug: `personal-${id}`,
      kind: "personal",
      ownerUserId: normalizedUserId,
      settings: null,
    })
  } catch (error) {
    // 并发下两个 ensurePersonalTeam 同时通过 pre-check，第二个撞唯一索引 → 回查
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
      await ensurePersonalPermissionProfile(recheck[0].id, memberId)
      return { ok: true, team: rowToPersonalTeam(recheck[0]), created: false }
    }
    return {
      ok: false,
      status: 404,
      response: {
        code: "INSERT_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }

  // I3: 自动创建默认 permission profile（simple / craft）
  await ensurePersonalPermissionProfile(id, memberId)

  const row = await db.select().from(TeamTable).where(eq(TeamTable.id, id)).limit(1)
  if (!row[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "INSERT_FAILED", message: "personal team insert did not return a row" },
    }
  }
  return { ok: true, team: rowToPersonalTeam(row[0]), created: true }
}

// ============================================================
// ensurePersonalTeamForUser — auth hook 入口（按 userId + org 解析 member）
// 供 auth.ts databaseHooks.session.create.before 调用
// ============================================================

export async function ensurePersonalTeamForUser(
  userId: string,
  organizationId: string,
): Promise<EnsurePersonalTeamResult> {
  const normalizedUserId = normalizeIdOrNull("user", userId)
  const normalizedOrgId = normalizeIdOrNull("organization", organizationId)
  if (!normalizedUserId || !normalizedOrgId) {
    return {
      ok: false,
      status: 404,
      response: {
        code: "MEMBER_NOT_FOUND",
        message: `no member for user ${userId} in org ${organizationId}`,
      },
    }
  }

  const members = await db
    .select()
    .from(MemberTable)
    .where(
      and(
        eq(MemberTable.userId, normalizedUserId),
        eq(MemberTable.organizationId, normalizedOrgId),
      ),
    )
    .limit(1)

  if (!members[0]) {
    return {
      ok: false,
      status: 404,
      response: {
        code: "MEMBER_NOT_FOUND",
        message: `no member for user ${userId} in org ${organizationId}`,
      },
    }
  }
  return ensurePersonalTeam(members[0].id, userId)
}
