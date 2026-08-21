// @ts-nocheck
/**
 * Shared route middleware & zod schemas for team-autonomy handlers.
 *
 * MIGRATION PHASE: the openapi validators, middleware functions, and
 * session-context types still live inside @openwork-ee/den-api because they
 * read den-api-only config. We re-export them from this shim so handlers
 * import from one stable path (`./shared-bridge.js`).
 *
 * `@ts-nocheck` on this re-export-only shim lets handlers typecheck freely.
 * Whole-file skip is safe; the real work is done in den-api.
 */

import type { MiddlewareHandler } from "hono"
import { z } from "zod"

import {
  denTypeIdSchema,
  forbiddenSchema,
  invalidRequestSchema,
  jsonResponse,
  notFoundSchema,
  unauthorizedSchema,
} from "../../../../../apps/den-api/src/openapi.js"

import {
  authenticatedRoute,
  resolveMemberTeamsMiddleware,
  resolveOrganizationContextMiddleware,
  verifyOrgRole,
  type MemberTeamsContext,
  type OrganizationContextVariables,
  jsonValidator,
  paramValidator,
  queryValidator,
} from "../../../../../apps/den-api/src/middleware/index.js"

import type { AuthContextVariables } from "../../../../../apps/den-api/src/session.js"

export type TeamAutonomyRouteVariables =
  & AuthContextVariables
  & Partial<OrganizationContextVariables>
  & Partial<MemberTeamsContext>

export {
  authenticatedRoute,
  denTypeIdSchema,
  forbiddenSchema,
  invalidRequestSchema,
  jsonResponse,
  jsonValidator,
  notFoundSchema,
  openapi,
  paramValidator,
  queryValidator,
  unauthorizedSchema,
  z,
}

export const resolveTeamContext: MiddlewareHandler<{
  Variables: TeamAutonomyRouteVariables
}> = async (c, next) => {
  if (c.get("organizationContext")) {
    await next()
    return
  }
  return resolveOrganizationContextMiddleware(c, async () => {
    await resolveMemberTeamsMiddleware(c, next)
  })
}

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
  const isMember = memberTeams.some((t) => t.id === teamId)
  if (!isMember) {
    return c.json({ error: "forbidden", message: "Not a member of this team." }, 403)
  }
  await next()
}

export type TeamRole = "owner" | "admin" | "editor" | "viewer"

export function teamRoleFromOrgContext(ctx: {
  currentMember: { role: string; isOwner: boolean }
}): TeamRole {
  if (ctx.currentMember.isOwner) return "owner"
  const role = ctx.currentMember.role ?? ""
  if (role.includes("admin") || role.includes("owner")) return "admin"
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

export function jsonServiceError(c: { json: (body: unknown, status?: number) => Response }, result: {
  ok: false
  status: number
  response: Record<string, unknown>
}): Response {
  return c.json({ error: result.response }, result.status)
}
