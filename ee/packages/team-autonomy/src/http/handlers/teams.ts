// @ts-nocheck
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  authenticatedRoute,
  jsonResponse,
  resolveTeamContext,
  unauthorizedSchema,
  type TeamAutonomyRouteVariables,
} from "./shared-bridge.js"

const teamSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  organizationId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const teamListResponseSchema = z
  .object({ teams: z.array(teamSummarySchema) })
  .meta({ ref: "TeamListResponse" })

export function registerTeamListRoutes<T extends { Variables: TeamAutonomyRouteVariables }>(app: Hono<T>) {
  app.get(
    "/api/teams",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "List teams the current member belongs to",
      responses: {
        200: jsonResponse("Teams listed.", teamListResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        500: jsonResponse("Organization context missing.", unauthorizedSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    async (c) => {
      const memberTeams = c.get("memberTeams") ?? []
      return c.json({ teams: memberTeams })
    },
  )
}