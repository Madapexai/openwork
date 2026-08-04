// team-autonomy/artifacts.ts — 共享产物路由（状态机 + 版本）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-http-routes.md
// 挂载前缀: /api/teams/:teamId/artifacts

import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { TeamArtifactTable, ArtifactKind } from "@openwork-ee/den-db/schema"
import * as assetService from "../../team-autonomy/asset-service.js"
import {
  actorFromContext,
  artifactIdParamSchema,
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
  versionParamSchema,
} from "./shared.js"
import { jsonValidator, paramValidator, queryValidator } from "../../middleware/index.js"

const kindSchema = z.enum(ArtifactKind)

const createArtifactSchema = z.object({
  taskId: denTypeIdSchema("teamTask").optional(),
  name: z.string().trim().min(1).max(256),
  kind: kindSchema,
  mimeType: z.string().optional(),
  storageUri: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
}).meta({ ref: "CreateArtifactInput" })

const transitionSchema = z.object({
  to: z.enum(["in_review", "confirmed", "draft", "archived"]),
  reviewerId: denTypeIdSchema("member").optional(),
  confirmedBy: denTypeIdSchema("member").optional(),
  reason: z.string().optional(),
}).meta({ ref: "ArtifactTransitionInput" })

const createVersionSchema = z.object({
  storageUri: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  changeSummary: z.string().optional(),
}).meta({ ref: "CreateArtifactVersionInput" })

const artifactListQuerySchema = z.object({
  taskId: denTypeIdSchema("teamTask").optional(),
  kind: kindSchema.optional(),
  downstream: z.enum(["true", "false"]).optional(),
  producerType: z.enum(["member", "agent"]).optional(),
  producerId: z.string().optional(),
})

const artifactObjectSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  taskId: z.string().nullable(),
  name: z.string(),
  kind: z.string(),
  mimeType: z.string().nullable(),
  storageUri: z.string(),
  sizeBytes: z.number(),
  status: z.string(),
  currentVersion: z.number(),
  producedByType: z.string(),
  producedById: z.string(),
  confirmedBy: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const artifactResponseSchema = z.object({ artifact: artifactObjectSchema }).meta({ ref: "TeamArtifactResponse" })
const artifactListResponseSchema = z.object({ artifacts: z.array(artifactObjectSchema) }).meta({ ref: "TeamArtifactListResponse" })
const transitionResponseSchema = z.object({
  artifact: artifactObjectSchema,
  previousStatus: z.string(),
}).meta({ ref: "TeamArtifactTransitionResponse" })
const versionResponseSchema = z.object({
  version: z.object({
    id: z.string(),
    artifactId: z.string(),
    versionNumber: z.number(),
    storageUri: z.string(),
    sizeBytes: z.number(),
    changeSummary: z.string().nullable(),
    producedByType: z.string(),
    producedById: z.string(),
    createdAt: z.string(),
  }),
}).meta({ ref: "TeamArtifactVersionResponse" })

// 校验 artifact 属于该 team
async function findArtifactInTeam(artifactId: `tart_${string}`, teamId: `tem_${string}`) {
  const rows = await db
    .select({ id: TeamArtifactTable.id })
    .from(TeamArtifactTable)
    .where(and(eq(TeamArtifactTable.id, artifactId), eq(TeamArtifactTable.team_id, teamId)))
    .limit(1)
  return rows[0] ? rows[0].id : null
}

export function registerTeamArtifactRoutes<T extends { Variables: TeamAutonomyRouteVariables }>(app: Hono<T>) {
  // GET /api/teams/:teamId/artifacts — list
  app.get(
    "/api/teams/:teamId/artifacts",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "List team artifacts",
      description: "Downstream consumers see confirmed artifacts only (I3); pass producerType+producerId for the producer's own view (incl. draft/in_review).",
      responses: {
        200: jsonResponse("Artifacts listed.", artifactListResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Team or organization not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(artifactIdParamSchema.pick({ teamId: true })),
    queryValidator(artifactListQuerySchema),
    async (c) => {
      const params = c.req.valid("param")
      const q = c.req.valid("query")
      if (q.producerType && q.producerId) {
        const artifacts = await assetService.listArtifactsByProducer(params.teamId, {
          type: q.producerType,
          id: q.producerId,
        })
        return c.json({ artifacts })
      }
      const artifacts = await assetService.listArtifactsForDownstream(params.teamId, {
        taskId: q.taskId,
        kind: q.kind,
      })
      return c.json({ artifacts })
    },
  )

  // POST /api/teams/:teamId/artifacts — create
  app.post(
    "/api/teams/:teamId/artifacts",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Create team artifact",
      responses: {
        201: jsonResponse("Artifact created.", artifactResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(artifactIdParamSchema.pick({ teamId: true })),
    jsonValidator(createArtifactSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      const result = await assetService.createArtifact({
        teamId: params.teamId,
        ...input,
        producedBy: { type: "member", id: ctx.currentMember.id },
      })
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ artifact: result.artifact }, 201)
    },
  )

  // GET /api/teams/:teamId/artifacts/:artifactId — get
  app.get(
    "/api/teams/:teamId/artifacts/:artifactId",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Get team artifact",
      responses: {
        200: jsonResponse("Artifact details.", artifactResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Artifact not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(artifactIdParamSchema),
    async (c) => {
      const params = c.req.valid("param")
      if (!(await findArtifactInTeam(params.artifactId, params.teamId))) {
        return c.json({ error: "not_found", message: "artifact not found in this team" }, 404)
      }
      const artifact = await assetService.getArtifact(params.artifactId)
      if (!artifact) {
        return c.json({ error: "not_found", message: "artifact not found" }, 404)
      }
      return c.json({ artifact })
    },
  )

  // POST /api/teams/:teamId/artifacts/:artifactId/transition — transition
  app.post(
    "/api/teams/:teamId/artifacts/:artifactId/transition",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Transition artifact status",
      responses: {
        200: jsonResponse("Artifact transitioned.", transitionResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Artifact not found.", notFoundSchema),
        409: jsonResponse("Invalid transition.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(artifactIdParamSchema),
    jsonValidator(transitionSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findArtifactInTeam(params.artifactId, params.teamId))) {
        return c.json({ error: "not_found", message: "artifact not found in this team" }, 404)
      }
      const transition = {
        to: input.to,
        ...(input.reviewerId ? { reviewerId: input.reviewerId } : {}),
        ...(input.confirmedBy ? { confirmedBy: input.confirmedBy } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      } as Parameters<typeof assetService.transitionArtifact>[1]
      const result = await assetService.transitionArtifact(params.artifactId, transition, actorFromContext(ctx))
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ artifact: result.artifact, previousStatus: result.previousStatus })
    },
  )

  // POST /api/teams/:teamId/artifacts/:artifactId/versions — create version
  app.post(
    "/api/teams/:teamId/artifacts/:artifactId/versions",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Create new artifact version",
      responses: {
        201: jsonResponse("Version created.", versionResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Artifact not found.", notFoundSchema),
        409: jsonResponse("Version conflict.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(artifactIdParamSchema),
    jsonValidator(createVersionSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findArtifactInTeam(params.artifactId, params.teamId))) {
        return c.json({ error: "not_found", message: "artifact not found in this team" }, 404)
      }
      const result = await assetService.createArtifactVersion(params.artifactId, {
        storageUri: input.storageUri,
        sizeBytes: input.sizeBytes,
        changeSummary: input.changeSummary,
        producedBy: { type: "member", id: ctx.currentMember.id },
      })
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      const version = await assetService.getArtifactVersion(params.artifactId, result.version)
      return c.json({ version }, 201)
    },
  )

  // GET /api/teams/:teamId/artifacts/:artifactId/versions/:version — get version
  app.get(
    "/api/teams/:teamId/artifacts/:artifactId/versions/:version",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Get artifact version",
      responses: {
        200: jsonResponse("Version details.", versionResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Version not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(versionParamSchema),
    async (c) => {
      const params = c.req.valid("param")
      if (!(await findArtifactInTeam(params.artifactId, params.teamId))) {
        return c.json({ error: "not_found", message: "artifact not found in this team" }, 404)
      }
      const version = await assetService.getArtifactVersion(params.artifactId, params.version)
      if (!version) {
        return c.json({ error: "not_found", message: "version not found" }, 404)
      }
      return c.json({ version })
    },
  )
}
