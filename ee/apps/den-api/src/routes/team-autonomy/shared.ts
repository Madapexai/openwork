// team-autonomy 路由共享层 — 中间件链 + 辅助函数
// OpenSpecs: prds/team-autonomy/openspecs/openspec-http-routes.md
//
// 中间件链：
//   authenticatedRoute()   → requireUserMiddleware (401 if no user) [route-access-policy marker]
//   resolveTeamContext     → 注入 organizationContext + memberTeams (test 短路)
//   teamRoleCheck(roles)   → 403 if role insufficient
//   requireTeamMember      → 403 if :teamId not in memberTeams
//
// 设计要点：
// - resolveTeamContext 检测 organizationContext 是否已注入（test 模式），短路避免查 DB
// - 生产模式委托 resolveOrganizationContextMiddleware + resolveMemberTeamsMiddleware
// - teamRoleCheck 复用 verifyOrgRole，与 org 路由一致

import type { MiddlewareHandler } from "hono"
import { z } from "zod"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import {
  authenticatedRoute,
  resolveMemberTeamsMiddleware,
  resolveOrganizationContextMiddleware,
  verifyOrgRole,
  type MemberTeamsContext,
  type OrganizationContextVariables,
} from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"

export type TeamAutonomyRouteVariables =
  & AuthContextVariables
  & Partial<OrganizationContextVariables>
  & Partial<MemberTeamsContext>

export { authenticatedRoute, denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema }

// ============================================================
// resolveTeamContext — test 短路 + 生产解析
// ============================================================

export const resolveTeamContext: MiddlewareHandler<{
  Variables: TeamAutonomyRouteVariables
}> = async (c, next) => {
  // test 模式：organizationContext 已注入 → 短路
  if (c.get("organizationContext")) {
    await next()
    return
  }
  // 生产模式：解析 org context + member teams
  return resolveOrganizationContextMiddleware(c, async () => {
    await resolveMemberTeamsMiddleware(c, next)
  })
}

// ============================================================
// teamRoleCheck — 基于 org role + isOwner 的角色检查
// ============================================================

export function teamRoleCheck(roles: readonly string[]): MiddlewareHandler<{
  Variables: TeamAutonomyRouteVariables
}> {
  return async (c, next) => {
    const ctx = c.get("organizationContext")
    if (!ctx) {
      return c.json({ error: "organization_not_found" }, 404)
    }
    const allowed = verifyOrgRole({ roles, userContext: ctx.currentMember })
    if (!allowed) {
      return c.json({ error: "forbidden", message: "Insufficient role." }, 403)
    }
    await next()
  }
}

// ============================================================
// requireTeamMember — :teamId 必须在 memberTeams 中
// ============================================================

export const requireTeamMember: MiddlewareHandler<{
  Variables: TeamAutonomyRouteVariables
}> = async (c, next) => {
  const ctx = c.get("organizationContext")
  if (!ctx) {
    return c.json({ error: "organization_not_found" }, 404)
  }
  const memberTeams = c.get("memberTeams") ?? []
  const teamId = c.req.param("teamId")
  if (!teamId) {
    await next()
    return
  }
  // test 模式下 memberTeams 可能预注入；生产模式下由 resolveMemberTeamsMiddleware 解析
  const isMember = memberTeams.some((t) => t.id === teamId)
  if (!isMember) {
    return c.json({ error: "forbidden", message: "Not a member of this team." }, 403)
  }
  await next()
}

// ============================================================
// teamRoleFromOrgContext — 从 org context 派生 team-level role
// 用于 service 层 Actor.role 参数
// ============================================================

export type TeamRole = "owner" | "admin" | "editor" | "viewer"

export function teamRoleFromOrgContext(ctx: {
  currentMember: { role: string; isOwner: boolean }
}): TeamRole {
  if (ctx.currentMember.isOwner) return "owner"
  // org admin → team admin
  const role = ctx.currentMember.role ?? ""
  if (role.includes("admin") || role.includes("owner")) return "admin"
  // org member → team editor（成员默认可编辑）
  if (role.includes("member")) return "editor"
  return "viewer"
}

export function actorFromContext(ctx: {
  currentMember: { id: string; role: string; isOwner: boolean }
}): { memberId: string; role: TeamRole } {
  return {
    memberId: ctx.currentMember.id,
    role: teamRoleFromOrgContext(ctx),
  }
}

// ============================================================
// 通用 param schemas
// ============================================================

export const teamIdParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
})

export const agentIdParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  agentId: denTypeIdSchema("teamAgent"),
})

export const taskIdParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  taskId: denTypeIdSchema("teamTask"),
})

export const artifactIdParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  artifactId: denTypeIdSchema("teamArtifact"),
})

export const automationIdParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  automationId: denTypeIdSchema("teamAutomation"),
})

export const runIdParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  runId: denTypeIdSchema("teamAutomationRun"),
})

export const alertIdParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  alertId: denTypeIdSchema("teamAutomationAlert"),
})

export const inboxIdParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  inboxId: denTypeIdSchema("teamInbox"),
})

export const roleIdParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  roleId: denTypeIdSchema("teamRole"),
})

export const ruleIdParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  ruleId: denTypeIdSchema("teamStandingRule"),
})

export const dependencyParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  taskId: denTypeIdSchema("teamTask"),
  dependsOnId: denTypeIdSchema("teamTask"),
})

export const assignTaskParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  agentId: denTypeIdSchema("teamAgent"),
  taskId: denTypeIdSchema("teamTask"),
})

export const versionParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  artifactId: denTypeIdSchema("teamArtifact"),
  version: z.coerce.number().int().min(1),
})

export const boardIdParamSchema = z.object({
  teamId: denTypeIdSchema("team"),
  boardId: denTypeIdSchema("teamBoard"),
})

// ============================================================
// 通用错误响应辅助
// ============================================================

// service 层返回 { ok: false, status, response: { code, message } }
// route 层统一映射为 { error: { code, message } } + status
export function serviceErrorToResponse(result: {
  ok: false
  status: number
  response: Record<string, unknown>
}): Response {
  return new Response(JSON.stringify({ error: result.response }), {
    status: result.status,
    headers: { "content-type": "application/json" },
  })
}

// Hono 兼容的返回方式
export function jsonServiceError(c: { json: (body: unknown, status?: number) => Response }, result: {
  ok: false
  status: number
  response: Record<string, unknown>
}): Response {
  return c.json({ error: result.response }, result.status)
}
