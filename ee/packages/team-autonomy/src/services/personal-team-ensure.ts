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
// 注：MemberTable / TeamTable 使用 camelCase JS 属性；
//     TeamPermissionProfileTable 使用 snake_case JS 属性。
// 错误风格：discriminated union（{ ok: false, status, response: { code, message } }）。

import { and, eq } from "@openwork-ee/den-db/drizzle";
import { MemberTable } from "@openwork-ee/den-db/schema/org";
import { TeamTable } from "@openwork-ee/den-db/schema/teams";
import { TeamPermissionProfileTable } from "@openwork-ee/den-db/schema/team-autonomy";
import { createDenTypeId, normalizeDenTypeId, type DenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"

type AnyDrizzleDb = {
  select: any;
  insert: any;
};

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

type EnsurePersonalTeamForUserDeps = {
  /**
   * Drizzle db instance wired from the host application (den-api).
   *
   * Optional for backward-compat during the migration bridge: when omitted,
   * the implementation falls back to a dynamic import of the host's db
   * singleton. New callers should always pass this.
   */
  db?: AnyDrizzleDb;
};

type EnsurePersonalTeamDeps = EnsurePersonalTeamForUserDeps;

// ============================================================
// 边界转换：string → 模板字面量 DenTypeId
// ============================================================

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
  deps?: EnsurePersonalTeamDeps,
): Promise<{ ok: boolean; created: boolean }> {
  const db = await resolveDb(deps);
  if (!db) return { ok: false, created: false };

  const normalizedTeamId = normalizeIdOrNull("team", teamId)
  if (!normalizedTeamId) {
    return { ok: true, created: false }
  }
  const existing = await db
    .select()
    .from(TeamPermissionProfileTable)
    .where(eq(TeamPermissionProfileTable.team_id, normalizedTeamId))
    .limit(1)
  if (existing[0]) {
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
  deps?: EnsurePersonalTeamDeps,
): Promise<EnsurePersonalTeamResult> {
  const db = await resolveDb(deps);
  if (!db) {
    return {
      ok: false,
      status: 404,
      response: { code: "DB_UNAVAILABLE", message: "no db instance wired into personal-team ensure" },
    }
  }

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
    await ensurePersonalPermissionProfile(existing[0].id, memberId, deps)
    return { ok: true, team: rowToPersonalTeam(existing[0]), created: false }
  }

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
      await ensurePersonalPermissionProfile(recheck[0].id, memberId, deps)
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

  await ensurePersonalPermissionProfile(id, memberId, deps)

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
  deps?: EnsurePersonalTeamDeps,
): Promise<EnsurePersonalTeamResult> {
  const db = await resolveDb(deps);
  if (!db) {
    return {
      ok: false,
      status: 404,
      response: {
        code: "DB_UNAVAILABLE",
        message: `no db instance wired for ensurePersonalTeamForUser(${userId})`,
      },
    }
  }

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
  return ensurePersonalTeam(members[0].id, userId, deps)
}

// ============================================================
// db 解析（显式注入 → 动态导入 den-api 单例 fallback）
// ============================================================

async function resolveDb(deps: EnsurePersonalTeamDeps | undefined): Promise<AnyDrizzleDb | null> {
  if (deps?.db) return deps.db;
  return resolveDbFallback();
}

async function resolveDbFallback(): Promise<AnyDrizzleDb | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - dynamic runtime import of host app's db singleton (migration bridge)
    const mod = await import("@openwork-ee/den-api/src/db.js");
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - dynamic runtime import
    return (mod as { db?: AnyDrizzleDb }).db ?? null;
  } catch {
    return null;
  }
}