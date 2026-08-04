// team-autonomy/permissions.ts — 双轨权限路由（Profile + Standing Rule + 工具调用检查）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-http-routes.md
// 挂载前缀: /api/teams/:teamId/permissions

import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { PermissionMode, PermissionProfile } from "@openwork-ee/den-db/schema"
import * as permissionService from "../../team-autonomy/permission-service.js"
import {
  actorFromContext,
  authenticatedRoute,
  denTypeIdSchema,
  forbiddenSchema,
  invalidRequestSchema,
  jsonResponse,
  jsonServiceError,
  notFoundSchema,
  resolveTeamContext,
  ruleIdParamSchema,
  teamRoleCheck,
  type TeamAutonomyRouteVariables,
  unauthorizedSchema,
} from "./shared.js"
import { jsonValidator, paramValidator, queryValidator } from "../../middleware/index.js"

const setProfileSchema = z.object({
  profile: z.enum(PermissionProfile),
  defaultMode: z.enum(PermissionMode),
  customRules: z.record(z.string(), z.unknown()).optional(),
}).meta({ ref: "SetTeamPermissionProfileInput" })

const createRuleSchema = z.object({
  scope: z.enum(["team", "agent", "task"]),
  scopeId: denTypeIdSchema("teamAgent").or(denTypeIdSchema("teamTask")).or(denTypeIdSchema("team")).optional(),
  toolName: z.string().min(1),
  targetPattern: z.string().min(1),
  expiresAt: z.string().datetime().optional(),
}).meta({ ref: "CreateStandingRuleInput" })

const listRulesQuerySchema = z.object({
  scope: z.enum(["team", "agent", "task"]).optional(),
  scopeId: z.string().optional(),
  toolName: z.string().optional(),
})

const checkToolSchema = z.object({
  taskId: denTypeIdSchema("teamTask").optional(),
  agentId: denTypeIdSchema("teamAgent"),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  targetPath: z.string().optional(),
}).meta({ ref: "CheckToolPermissionInput" })

const profileObjectSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  profile: z.enum(PermissionProfile),
  defaultMode: z.enum(PermissionMode),
  customRules: z.record(z.string(), z.unknown()).nullable(),
  updatedBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const ruleObjectSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  scope: z.enum(["team", "agent", "task"]),
  scopeId: z.string().nullable(),
  toolName: z.string(),
  targetPattern: z.string(),
  grantedBy: z.string(),
  grantedAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedBy: z.string().nullable(),
})

const profileResponseSchema = z.object({ profile: profileObjectSchema.nullable() }).meta({ ref: "TeamPermissionProfileResponse" })
const ruleResponseSchema = z.object({ rule: ruleObjectSchema }).meta({ ref: "TeamStandingRuleResponse" })
const ruleListResponseSchema = z.object({ rules: z.array(ruleObjectSchema) }).meta({ ref: "TeamStandingRuleListResponse" })
const checkResponseSchema = z.object({
  decision: z.enum(["allow", "require_approval", "require_plan", "deny"]),
  reason: z.string(),
  ruleId: z.string().optional(),
  mode: z.enum(PermissionMode).optional(),
  inboxId: z.string().optional(),
}).meta({ ref: "TeamToolPermissionCheckResponse" })

export function registerTeamPermissionRoutes<T extends { Variables: TeamAutonomyRouteVariables }>(app: Hono<T>) {
  // GET /api/teams/:teamId/permissions/profile
  app.get(
    "/api/teams/:teamId/permissions/profile",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Get team permission profile",
      responses: {
        200: jsonResponse("Permission profile (null if unset).", profileResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Team or organization not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(ruleIdParamSchema.pick({ teamId: true })),
    async (c) => {
      const params = c.req.valid("param")
      const profile = await permissionService.getTeamPermissionProfile(params.teamId)
      return c.json({ profile })
    },
  )

  // PUT /api/teams/:teamId/permissions/profile
  app.put(
    "/api/teams/:teamId/permissions/profile",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Set team permission profile",
      responses: {
        200: jsonResponse("Permission profile set.", profileResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can set the profile.", forbiddenSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(ruleIdParamSchema.pick({ teamId: true })),
    jsonValidator(setProfileSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      const result = await permissionService.setTeamPermissionProfile(params.teamId, input, actorFromContext(ctx))
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ profile: result.profile })
    },
  )

  // GET /api/teams/:teamId/permissions/rules
  app.get(
    "/api/teams/:teamId/permissions/rules",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "List standing rules",
      responses: {
        200: jsonResponse("Standing rules listed.", ruleListResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Team or organization not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(ruleIdParamSchema.pick({ teamId: true })),
    queryValidator(listRulesQuerySchema),
    async (c) => {
      const params = c.req.valid("param")
      const q = c.req.valid("query")
      const rules = await permissionService.listStandingRules(params.teamId, {
        scope: q.scope,
        scopeId: q.scopeId,
        toolName: q.toolName,
      })
      return c.json({ rules })
    },
  )

  // POST /api/teams/:teamId/permissions/rules
  app.post(
    "/api/teams/:teamId/permissions/rules",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Create standing rule",
      responses: {
        201: jsonResponse("Standing rule created.", ruleResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can create standing rules.", forbiddenSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(ruleIdParamSchema.pick({ teamId: true })),
    jsonValidator(createRuleSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      const result = await permissionService.createStandingRule(
        {
          teamId: params.teamId,
          scope: input.scope,
          ...(input.scopeId ? { scopeId: input.scopeId } : {}),
          toolName: input.toolName,
          targetPattern: input.targetPattern,
          ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
        },
        actorFromContext(ctx),
      )
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ rule: result.rule }, 201)
    },
  )

  // POST /api/teams/:teamId/permissions/rules/:ruleId/revoke
  app.post(
    "/api/teams/:teamId/permissions/rules/:ruleId/revoke",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Revoke standing rule",
      responses: {
        200: jsonResponse("Standing rule revoked.", ruleResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can revoke standing rules.", forbiddenSchema),
        404: jsonResponse("Standing rule not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(ruleIdParamSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const result = await permissionService.revokeStandingRule(params.ruleId, actorFromContext(ctx))
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ rule: result.rule })
    },
  )

  // POST /api/teams/:teamId/permissions/check
  app.post(
    "/api/teams/:teamId/permissions/check",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Check tool call permission",
      responses: {
        200: jsonResponse("Permission decision.", checkResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Team or organization not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(ruleIdParamSchema.pick({ teamId: true })),
    jsonValidator(checkToolSchema),
    async (c) => {
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      const decision = await permissionService.checkToolPermission({
        teamId: params.teamId,
        agentId: input.agentId,
        toolName: input.toolName,
        arguments: input.arguments,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.targetPath ? { targetPath: input.targetPath } : {}),
      })
      return c.json(decision)
    },
  )
}
