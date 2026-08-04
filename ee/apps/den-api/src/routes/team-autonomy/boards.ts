// team-autonomy/boards.ts — 看板路由（看板 CRUD + 看板任务视图）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-http-routes.md
// 挂载前缀: /api/teams/:teamId/boards
//
// 说明：board 无独立 service，CRUD 直接走 TeamBoardTable；
// 看板任务视图复用 task-service.listByBoard。

import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { TeamBoardTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import * as taskService from "../../team-autonomy/task-service.js"
import {
  authenticatedRoute,
  boardIdParamSchema,
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

const boardObjectSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  columns: z.array(z.string()),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const boardResponseSchema = z.object({ board: boardObjectSchema }).meta({ ref: "TeamBoardResponse" })
const boardListResponseSchema = z.object({ boards: z.array(boardObjectSchema) }).meta({ ref: "TeamBoardListResponse" })

const createBoardSchema = z.object({
  name: z.string().trim().min(1).max(128),
  columns: z.array(z.string().trim().min(1)).min(1).optional(),
}).meta({ ref: "CreateTeamBoardInput" })

// TeamBoardTable 行 → camelCase API 对象
function rowToBoard(row: typeof TeamBoardTable.$inferSelect) {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    columns: row.columns,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function registerTeamBoardRoutes<T extends { Variables: TeamAutonomyRouteVariables }>(app: Hono<T>) {
  // GET /api/teams/:teamId/boards — list
  app.get(
    "/api/teams/:teamId/boards",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "List team boards",
      responses: {
        200: jsonResponse("Boards listed.", boardListResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Team or organization not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(boardIdParamSchema.pick({ teamId: true })),
    async (c) => {
      const params = c.req.valid("param")
      const rows = await db.select().from(TeamBoardTable).where(eq(TeamBoardTable.team_id, params.teamId))
      return c.json({ boards: rows.map(rowToBoard) })
    },
  )

  // POST /api/teams/:teamId/boards — create
  app.post(
    "/api/teams/:teamId/boards",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Create team board",
      responses: {
        201: jsonResponse("Board created.", boardResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can create boards.", forbiddenSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(boardIdParamSchema.pick({ teamId: true })),
    jsonValidator(createBoardSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      const id = createDenTypeId("teamBoard")
      try {
        await db.insert(TeamBoardTable).values({
          id,
          team_id: params.teamId,
          name: input.name,
          columns: input.columns ?? ["todo", "in_progress", "review", "done"],
          created_by: ctx.currentMember.id,
        })
      } catch {
        return jsonServiceError(c, {
          ok: false,
          status: 409,
          response: { code: "BOARD_EXISTS", message: "board with this id already exists" },
        })
      }
      const rows = await db.select().from(TeamBoardTable).where(eq(TeamBoardTable.id, id)).limit(1)
      if (!rows[0]) {
        return jsonServiceError(c, {
          ok: false,
          status: 400,
          response: { code: "INSERT_FAILED", message: "board insert did not return a row" },
        })
      }
      return c.json({ board: rowToBoard(rows[0]) }, 201)
    },
  )

  // GET /api/teams/:teamId/boards/:boardId — get
  app.get(
    "/api/teams/:teamId/boards/:boardId",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Get team board",
      responses: {
        200: jsonResponse("Board details.", boardResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Board not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(boardIdParamSchema),
    async (c) => {
      const params = c.req.valid("param")
      const rows = await db
        .select()
        .from(TeamBoardTable)
        .where(and(eq(TeamBoardTable.id, params.boardId), eq(TeamBoardTable.team_id, params.teamId)))
        .limit(1)
      if (!rows[0]) {
        return c.json({ error: "not_found", message: "board not found in this team" }, 404)
      }
      return c.json({ board: rowToBoard(rows[0]) })
    },
  )

  // GET /api/teams/:teamId/boards/:boardId/tasks — board task view
  app.get(
    "/api/teams/:teamId/boards/:boardId/tasks",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "List tasks on a board",
      responses: {
        200: jsonResponse("Tasks listed.", z.object({ tasks: z.array(z.any()) }).meta({ ref: "TeamBoardTaskListResponse" })),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Board not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(boardIdParamSchema),
    async (c) => {
      const params = c.req.valid("param")
      const rows = await db
        .select({ id: TeamBoardTable.id })
        .from(TeamBoardTable)
        .where(and(eq(TeamBoardTable.id, params.boardId), eq(TeamBoardTable.team_id, params.teamId)))
        .limit(1)
      if (!rows[0]) {
        return c.json({ error: "not_found", message: "board not found in this team" }, 404)
      }
      const tasks = await taskService.listByBoard(params.boardId)
      return c.json({ tasks })
    },
  )
}
