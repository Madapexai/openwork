// PersonalTeam — member 驱动的 personal team 自动创建（P3-A）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-personal-team.md
//
// 不变量：
// I1: 新用户注册后自动创建 kind=personal 的 Team（slug="personal", owner_user_id=userId）
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
import { createDenTypeId } from "@openwork-ee/utils/typeid"

// ============================================================
// 类型导出
// ============================================================

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
  const existing = await db
    .select()
    .from(TeamPermissionProfileTable)
    .where(eq(TeamPermissionProfileTable.team_id, teamId))
    .limit(1)
  if (existing[0]) {
    // 已有配置（可能是用户改过的）→ 保留，不覆盖
    return { ok: true, created: false }
  }

  const id = createDenTypeId("teamPermissionProfile")
  try {
    await db.insert(TeamPermissionProfileTable).values({
      id,
      team_id: teamId,
      profile: "simple",
      default_mode: "craft",
      custom_rules: null,
      updated_by: updatedByMemberId,
    })
  } catch (error) {
    // 并发下重复插入撞 unique(team_id) → 回查一次
    const recheck = await db
      .select()
      .from(TeamPermissionProfileTable)
      .where(eq(TeamPermissionProfileTable.team_id, teamId))
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
  const members = await db
    .select()
    .from(MemberTable)
    .where(eq(MemberTable.id, memberId))
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
  const existing = await db
    .select()
    .from(TeamTable)
    .where(
      and(
        eq(TeamTable.ownerUserId, userId),
        eq(TeamTable.kind, "personal"),
      ),
    )
    .limit(1)
  if (existing[0]) {
    await ensurePersonalPermissionProfile(existing[0].id, memberId)
    return { ok: true, team: rowToPersonalTeam(existing[0]), created: false }
  }

  // 不存在 → 创建（slug='personal', kind='personal', owner_user_id=userId）
  const id = createDenTypeId("team")
  try {
    await db.insert(TeamTable).values({
      id,
      organizationId,
      name: "Personal",
      slug: "personal",
      kind: "personal",
      ownerUserId: userId,
      settings: null,
    })
  } catch (error) {
    // 并发下两个 ensurePersonalTeam 同时通过 pre-check，第二个撞唯一索引 → 回查
    const recheck = await db
      .select()
      .from(TeamTable)
      .where(
        and(
          eq(TeamTable.ownerUserId, userId),
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
  const members = await db
    .select()
    .from(MemberTable)
    .where(
      and(
        eq(MemberTable.userId, userId),
        eq(MemberTable.organizationId, organizationId),
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
