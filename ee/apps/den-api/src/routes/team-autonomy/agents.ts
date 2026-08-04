// team-autonomy/agents.ts — Agent 池路由
// OpenSpecs: prds/team-autonomy/openspecs/openspec-http-routes.md
// 挂载前缀: /api/teams/:teamId/agents（app.ts → registerTeamAutonomyRoutes）

import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { TeamAgentTable, TeamAgentEngine } from "@openwork-ee/den-db/schema"
import * as agentService from "../../team-autonomy/team-agent-service.js"
import {
  actorFromContext,
  agentIdParamSchema,
  assignTaskParamSchema,
  authenticatedRoute,
  denTypeIdSchema,
  forbiddenSchema,
  invalidRequestSchema,
  jsonResponse,
  jsonServiceError,
  notFoundSchema,
  resolveTeamContext,
  teamRoleCheck,
  type TeamAutonomyRouteVariables,
  unauthorizedSchema,
} from "./shared.js"
import { jsonValidator, paramValidator } from "../../middleware/index.js"

const engineSchema = z.enum(TeamAgentEngine)

const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(128),
  engine: engineSchema,
  roleId: denTypeIdSchema("teamRole").optional(),
  persona: z.string().optional(),
  skills: z.array(z.string()).optional(),
  connectors: z.array(z.string()).optional(),
  modelDefault: z.string().optional(),
  forbiddenActions: z.array(z.string()).optional(),
})

const updateAgentSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  engine: engineSchema.optional(),
  roleId: denTypeIdSchema("teamRole").nullable().optional(),
  persona: z.string().nullable().optional(),
  skills: z.array(z.string()).nullable().optional(),
  connectors: z.array(z.string()).nullable().optional(),
  modelDefault: z.string().nullable().optional(),
  forbiddenActions: z.array(z.string()).nullable().optional(),
})

const agentResponseSchema = z.object({
  agent: z.object({
    id: z.string(),
    teamId: z.string(),
    name: z.string(),
    engine: z.string(),
    roleId: z.string().nullable(),
    persona: z.string().nullable(),
    skills: z.array(z.string()).nullable(),
    connectors: z.array(z.string()).nullable(),
    modelDefault: z.string().nullable(),
    status: z.string(),
    sidecarSessionId: z.string().nullable(),
    forbiddenActions: z.array(z.string()).nullable(),
    currentTaskId: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
}).meta({ ref: "TeamAgentResponse" })

const agentListResponseSchema = z.object({
  agents: z.array(agentResponseSchema.shape.agent),
}).meta({ ref: "TeamAgentListResponse" })

export function registerTeamAgentRoutes<T extends { Variables: TeamAutonomyRouteVariables }>(app: Hono<T>) {
  // GET /api/teams/:teamId/agents — list
  app.get(
    "/api/teams/:teamId/agents",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "List team agents",
      description: "Lists all agents belonging to the team.",
      responses: {
        200: jsonResponse("Agents listed.", agentListResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Team or organization not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(agentIdParamSchema.pick({ teamId: true })),
    async (c) => {
      const params = c.req.valid("param")
      const agents = await agentService.listByTeam(params.teamId)
      return c.json({ agents })
    },
  )

  // POST /api/teams/:teamId/agents — create
  app.post(
    "/api/teams/:teamId/agents",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Create team agent",
      description: "Creates a new agent in the team. Requires admin role.",
      responses: {
        201: jsonResponse("Agent created.", agentResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can create agents.", forbiddenSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(agentIdParamSchema.pick({ teamId: true })),
    jsonValidator(createAgentSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      const result = await agentService.createAgent(
        { teamId: params.teamId, ...input },
        actorFromContext(ctx),
      )
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ agent: result.agent }, 201)
    },
  )

  // GET /api/teams/:teamId/agents/:agentId — get
  app.get(
    "/api/teams/:teamId/agents/:agentId",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Get team agent",
      responses: {
        200: jsonResponse("Agent details.", agentResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Agent not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(agentIdParamSchema),
    async (c) => {
      const params = c.req.valid("param")
      // 校验 agent 属于该 team
      const rows = await db.select({ teamId: TeamAgentTable.team_id })
        .from(TeamAgentTable)
        .where(and(eq(TeamAgentTable.id, params.agentId), eq(TeamAgentTable.team_id, params.teamId)))
        .limit(1)
      if (!rows[0]) {
        return c.json({ error: "not_found", message: "agent not found in this team" }, 404)
      }
      const agent = await agentService.getById(params.agentId)
      if (!agent) {
        return c.json({ error: "not_found", message: "agent not found" }, 404)
      }
      return c.json({ agent })
    },
  )

  // PATCH /api/teams/:teamId/agents/:agentId — update
  app.patch(
    "/api/teams/:teamId/agents/:agentId",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Update team agent",
      responses: {
        200: jsonResponse("Agent updated.", agentResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can update agents.", forbiddenSchema),
        404: jsonResponse("Agent not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(agentIdParamSchema),
    jsonValidator(updateAgentSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      // zod 允许 null 以表达"清除字段"，但 service 层 UpdateAgentInput 不接受 null → 过滤
      const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null)) as Parameters<typeof agentService.updateAgent>[1]
      const result = await agentService.updateAgent(params.agentId, patch, actorFromContext(ctx))
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ agent: result.agent })
    },
  )

  // DELETE /api/teams/:teamId/agents/:agentId — delete
  app.delete(
    "/api/teams/:teamId/agents/:agentId",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Delete team agent",
      responses: {
        204: { description: "Agent deleted." },
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can delete agents.", forbiddenSchema),
        404: jsonResponse("Agent not found.", notFoundSchema),
        409: jsonResponse("Agent has a current task.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(agentIdParamSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const result = await agentService.deleteAgent(params.agentId, actorFromContext(ctx))
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.body(null, 204)
    },
  )

  // POST /api/teams/:teamId/agents/:agentId/assign/:taskId
  app.post(
    "/api/teams/:teamId/agents/:agentId/assign/:taskId",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Assign task to agent",
      responses: {
        200: jsonResponse("Task assigned.", agentResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can assign tasks.", forbiddenSchema),
        404: jsonResponse("Agent or task not found.", notFoundSchema),
        409: jsonResponse("Agent is busy or invalid state.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(assignTaskParamSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const result = await agentService.assignTask(params.agentId, params.taskId, actorFromContext(ctx))
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ agent: result.agent })
    },
  )

  // POST /api/teams/:teamId/agents/:agentId/unassign
  app.post(
    "/api/teams/:teamId/agents/:agentId/unassign",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Unassign task from agent",
      responses: {
        200: jsonResponse("Task unassigned.", agentResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can unassign tasks.", forbiddenSchema),
        404: jsonResponse("Agent not found.", notFoundSchema),
        409: jsonResponse("Agent has no task.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(agentIdParamSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const result = await agentService.unassignTask(params.agentId, actorFromContext(ctx))
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ agent: result.agent })
    },
  )

  // POST /api/teams/:teamId/agents/:agentId/pause
  app.post(
    "/api/teams/:teamId/agents/:agentId/pause",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Pause agent",
      responses: {
        200: jsonResponse("Agent paused.", agentResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can pause agents.", forbiddenSchema),
        404: jsonResponse("Agent not found.", notFoundSchema),
        409: jsonResponse("Invalid state transition.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(agentIdParamSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const result = await agentService.pauseAgent(params.agentId, actorFromContext(ctx))
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ agent: result.agent })
    },
  )

  // POST /api/teams/:teamId/agents/:agentId/resume
  app.post(
    "/api/teams/:teamId/agents/:agentId/resume",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Resume agent",
      responses: {
        200: jsonResponse("Agent resumed.", agentResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can resume agents.", forbiddenSchema),
        404: jsonResponse("Agent not found.", notFoundSchema),
        409: jsonResponse("Invalid state transition.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(agentIdParamSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const result = await agentService.resumeAgent(params.agentId, actorFromContext(ctx))
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ agent: result.agent })
    },
  )
}
