// team-autonomy/inbox.ts — Inbox 路由（幂等 + resolve）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-http-routes.md
// 挂载前缀: /api/teams/:teamId/inbox

import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { TeamInboxTable, TeamInboxKind, TeamInboxAssigneeType } from "@openwork-ee/den-db/schema"
import * as inboxService from "../../team-autonomy/inbox-service.js"
import {
  authenticatedRoute,
  denTypeIdSchema,
  forbiddenSchema,
  inboxIdParamSchema,
  invalidRequestSchema,
  jsonResponse,
  jsonServiceError,
  notFoundSchema,
  resolveTeamContext,
  teamRoleCheck,
  type TeamAutonomyRouteVariables,
  unauthorizedSchema,
} from "./shared.js"
import { jsonValidator, paramValidator, queryValidator } from "../../middleware/index.js"

const createInboxSchema = z.object({
  sessionId: denTypeIdSchema("session").optional(),
  taskId: denTypeIdSchema("teamTask").optional(),
  assigneeType: z.enum(TeamInboxAssigneeType),
  assigneeId: z.string().min(1),
  kind: z.enum(TeamInboxKind),
  toolName: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().optional(),
  externalToolCallId: z.string().optional(),
}).meta({ ref: "CreateInboxEntryInput" })

const resolveInboxSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("resolved"), resolution: z.record(z.string(), z.unknown()) }),
    z.object({ status: z.literal("denied"), reason: z.string() }),
    z.object({ status: z.literal("superseded"), supersededBy: z.string() }),
  ])
  .meta({ ref: "ResolveInboxEntryInput" })

const inboxListQuerySchema = z.object({
  assigneeType: z.enum(TeamInboxAssigneeType),
  assigneeId: z.string().min(1),
})

const entryObjectSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  sessionId: z.string().nullable(),
  taskId: z.string().nullable(),
  assigneeType: z.enum(TeamInboxAssigneeType),
  assigneeId: z.string(),
  kind: z.enum(TeamInboxKind),
  toolName: z.string().nullable(),
  arguments: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  status: z.string(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolution: z.record(z.string(), z.unknown()).nullable(),
  externalToolCallId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const inboxResponseSchema = z.object({ entry: entryObjectSchema }).meta({ ref: "TeamInboxEntryResponse" })
const inboxListResponseSchema = z.object({ entries: z.array(entryObjectSchema) }).meta({ ref: "TeamInboxEntryListResponse" })
const createInboxResponseSchema = z.object({
  entry: entryObjectSchema,
  created: z.boolean(),
}).meta({ ref: "TeamInboxCreateResponse" })

// 校验 inbox 条目属于该 team
async function findInboxInTeam(inboxId: `tibx_${string}`, teamId: `tem_${string}`) {
  const rows = await db
    .select({ id: TeamInboxTable.id })
    .from(TeamInboxTable)
    .where(and(eq(TeamInboxTable.id, inboxId), eq(TeamInboxTable.team_id, teamId)))
    .limit(1)
  return rows[0] ? rows[0].id : null
}

export function registerTeamInboxRoutes<T extends { Variables: TeamAutonomyRouteVariables }>(app: Hono<T>) {
  // GET /api/teams/:teamId/inbox — list pending
  app.get(
    "/api/teams/:teamId/inbox",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "List pending inbox entries",
      responses: {
        200: jsonResponse("Entries listed.", inboxListResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Team or organization not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(inboxIdParamSchema.pick({ teamId: true })),
    queryValidator(inboxListQuerySchema),
    async (c) => {
      const params = c.req.valid("param")
      const q = c.req.valid("query")
      const entries = await inboxService.listPendingInbox(params.teamId, {
        type: q.assigneeType,
        id: q.assigneeId,
      })
      return c.json({ entries })
    },
  )

  // POST /api/teams/:teamId/inbox — create
  app.post(
    "/api/teams/:teamId/inbox",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Create inbox entry",
      responses: {
        201: jsonResponse("Entry created.", createInboxResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(inboxIdParamSchema.pick({ teamId: true })),
    jsonValidator(createInboxSchema),
    async (c) => {
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      const result = await inboxService.createInboxEntry({ teamId: params.teamId, ...input })
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ entry: result.entry, created: result.created }, 201)
    },
  )

  // GET /api/teams/:teamId/inbox/:inboxId — get
  app.get(
    "/api/teams/:teamId/inbox/:inboxId",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Get inbox entry",
      responses: {
        200: jsonResponse("Entry details.", inboxResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Entry not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(inboxIdParamSchema),
    async (c) => {
      const params = c.req.valid("param")
      if (!(await findInboxInTeam(params.inboxId, params.teamId))) {
        return c.json({ error: "not_found", message: "inbox entry not found in this team" }, 404)
      }
      const entry = await inboxService.findInboxById(params.inboxId)
      if (!entry) {
        return c.json({ error: "not_found", message: "inbox entry not found" }, 404)
      }
      return c.json({ entry })
    },
  )

  // POST /api/teams/:teamId/inbox/:inboxId/resolve
  app.post(
    "/api/teams/:teamId/inbox/:inboxId/resolve",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Resolve inbox entry",
      responses: {
        200: jsonResponse("Entry resolved.", inboxResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Entry not found.", notFoundSchema),
        409: jsonResponse("Entry already resolved.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(inboxIdParamSchema),
    jsonValidator(resolveInboxSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findInboxInTeam(params.inboxId, params.teamId))) {
        return c.json({ error: "not_found", message: "inbox entry not found in this team" }, 404)
      }
      const result = await inboxService.resolveInboxEntry(params.inboxId, input, ctx.currentMember.id)
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ entry: result.entry })
    },
  )
}
