// team-autonomy/tasks.ts — 任务路由（依赖图 + 移交 + 计划审批）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-http-routes.md
// 挂载前缀: /api/teams/:teamId/tasks

import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { TeamTaskTable, TaskPriority, TaskAssigneeType } from "@openwork-ee/den-db/schema"
import * as taskService from "../../team-autonomy/task-service.js"
import {
  actorFromContext,
  authenticatedRoute,
  denTypeIdSchema,
  dependencyParamSchema,
  forbiddenSchema,
  invalidRequestSchema,
  jsonResponse,
  jsonServiceError,
  notFoundSchema,
  resolveTeamContext,
  taskIdParamSchema,
  teamRoleCheck,
  type TeamAutonomyRouteVariables,
  unauthorizedSchema,
} from "./shared.js"
import { jsonValidator, paramValidator, queryValidator } from "../../middleware/index.js"

// task status 是 varchar 列（无对应 enum const 导出），本地定义
const TASK_STATUSES = ["todo", "in_progress", "review", "done"] as const

const assigneeSchema = z.object({
  type: z.enum(TaskAssigneeType),
  id: denTypeIdSchema("member").or(denTypeIdSchema("teamAgent")),
})

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(256),
  description: z.string().optional(),
  boardId: denTypeIdSchema("teamBoard").optional(),
  columnId: z.string().optional(),
  priority: z.enum(TaskPriority).optional(),
  assignee: assigneeSchema,
}).meta({ ref: "CreateTaskInput" })

const updateStatusSchema = z.object({
  to: z.enum(TASK_STATUSES),
}).meta({ ref: "UpdateTaskStatusInput" })

const setPlanSchema = z.object({
  plan: z.string().trim().min(1),
}).meta({ ref: "SetTaskPlanInput" })

const rejectPlanSchema = z.object({
  reason: z.string().optional(),
}).meta({ ref: "RejectTaskPlanInput" })

const handoffSchema = z.object({
  from: assigneeSchema,
  to: assigneeSchema,
  reason: z.string().optional(),
  contextSnapshot: z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length > 0, {
    message: "context_snapshot must be a non-empty object",
  }),
}).meta({ ref: "HandoffTaskInput" })

const addDependencySchema = z.object({
  dependsOnId: denTypeIdSchema("teamTask"),
}).meta({ ref: "AddTaskDependencyInput" })

const taskObjectSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  boardId: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(TASK_STATUSES),
  columnId: z.string(),
  assigneeType: z.enum(TaskAssigneeType),
  assigneeId: z.string(),
  createdBy: z.string(),
  priority: z.enum(TaskPriority),
  dependsOn: z.array(z.string()),
  blocks: z.array(z.string()),
  plan: z.string().nullable(),
  planStatus: z.string(),
  planApprovedBy: z.string().nullable(),
  planApprovedAt: z.string().nullable(),
  artifacts: z.array(z.string()),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const taskResponseSchema = z.object({ task: taskObjectSchema }).meta({ ref: "TeamTaskResponse" })
const taskListResponseSchema = z.object({ tasks: z.array(taskObjectSchema) }).meta({ ref: "TeamTaskListResponse" })
const statusResponseSchema = z.object({
  task: taskObjectSchema,
  previousStatus: z.enum(TASK_STATUSES),
}).meta({ ref: "TeamTaskStatusResponse" })
const handoffResponseSchema = z.object({
  task: taskObjectSchema,
  handoff: z.object({
    id: z.string(),
    taskId: z.string(),
    fromAssigneeType: z.enum(TaskAssigneeType),
    fromAssigneeId: z.string(),
    toAssigneeType: z.enum(TaskAssigneeType),
    toAssigneeId: z.string(),
    reason: z.string().nullable(),
    contextSnapshot: z.record(z.string(), z.unknown()),
    handedAt: z.string(),
  }),
}).meta({ ref: "TeamTaskHandoffResponse" })
const dependencyResponseSchema = z.object({
  task: taskObjectSchema,
  dependsOnTask: taskObjectSchema,
}).meta({ ref: "TeamTaskDependencyResponse" })

const taskListQuerySchema = z.object({
  boardId: denTypeIdSchema("teamBoard").optional(),
  assigneeType: z.enum(TaskAssigneeType).optional(),
  assigneeId: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
})

// 校验 task 属于该 team；不属于 → null
async function findTaskInTeam(taskId: `ttsk_${string}`, teamId: `tem_${string}`) {
  const rows = await db
    .select({ id: TeamTaskTable.id })
    .from(TeamTaskTable)
    .where(and(eq(TeamTaskTable.id, taskId), eq(TeamTaskTable.team_id, teamId)))
    .limit(1)
  return rows[0] ? rows[0].id : null
}

export function registerTeamTaskRoutes<T extends { Variables: TeamAutonomyRouteVariables }>(app: Hono<T>) {
  // GET /api/teams/:teamId/tasks — list
  app.get(
    "/api/teams/:teamId/tasks",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "List team tasks",
      responses: {
        200: jsonResponse("Tasks listed.", taskListResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Team or organization not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(taskIdParamSchema.pick({ teamId: true })),
    queryValidator(taskListQuerySchema),
    async (c) => {
      const params = c.req.valid("param")
      const q = c.req.valid("query")
      const conditions = [eq(TeamTaskTable.team_id, params.teamId)]
      if (q.boardId) conditions.push(eq(TeamTaskTable.board_id, q.boardId))
      if (q.assigneeType) conditions.push(eq(TeamTaskTable.assignee_type, q.assigneeType))
      if (q.assigneeId) conditions.push(eq(TeamTaskTable.assignee_id, q.assigneeId))
      if (q.status) conditions.push(eq(TeamTaskTable.status, q.status))
      const rows = await db.select().from(TeamTaskTable).where(and(...conditions))
      return c.json({ tasks: rows })
    },
  )

  // POST /api/teams/:teamId/tasks — create
  app.post(
    "/api/teams/:teamId/tasks",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Create team task",
      responses: {
        201: jsonResponse("Task created.", taskResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can create tasks.", forbiddenSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(taskIdParamSchema.pick({ teamId: true })),
    jsonValidator(createTaskSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      const result = await taskService.createTask({
        teamId: params.teamId,
        ...input,
        createdBy: ctx.currentMember.id,
      })
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ task: result.task }, 201)
    },
  )

  // GET /api/teams/:teamId/tasks/:taskId — get
  app.get(
    "/api/teams/:teamId/tasks/:taskId",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Get team task",
      responses: {
        200: jsonResponse("Task details.", taskResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Task not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(taskIdParamSchema),
    async (c) => {
      const params = c.req.valid("param")
      if (!(await findTaskInTeam(params.taskId, params.teamId))) {
        return c.json({ error: "not_found", message: "task not found in this team" }, 404)
      }
      const task = await taskService.getTask(params.taskId)
      if (!task) {
        return c.json({ error: "not_found", message: "task not found" }, 404)
      }
      return c.json({ task })
    },
  )

  // PATCH /api/teams/:teamId/tasks/:taskId/status — update status
  app.patch(
    "/api/teams/:teamId/tasks/:taskId/status",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Transition task status",
      responses: {
        200: jsonResponse("Task status updated.", statusResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Task not found.", notFoundSchema),
        409: jsonResponse("Invalid transition or plan gate.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(taskIdParamSchema),
    jsonValidator(updateStatusSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findTaskInTeam(params.taskId, params.teamId))) {
        return c.json({ error: "not_found", message: "task not found in this team" }, 404)
      }
      const result = await taskService.updateStatus(params.taskId, input.to, actorFromContext(ctx))
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ task: result.task, previousStatus: result.previousStatus })
    },
  )

  // PUT /api/teams/:teamId/tasks/:taskId/plan — set plan
  app.put(
    "/api/teams/:teamId/tasks/:taskId/plan",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Set task plan",
      responses: {
        200: jsonResponse("Plan set.", taskResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Task not found.", notFoundSchema),
        409: jsonResponse("Plan already approved.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(taskIdParamSchema),
    jsonValidator(setPlanSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findTaskInTeam(params.taskId, params.teamId))) {
        return c.json({ error: "not_found", message: "task not found in this team" }, 404)
      }
      const result = await taskService.setPlan(params.taskId, input.plan, actorFromContext(ctx))
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ task: result.task })
    },
  )

  // POST /api/teams/:teamId/tasks/:taskId/plan/approve — approve plan
  app.post(
    "/api/teams/:teamId/tasks/:taskId/plan/approve",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Approve task plan",
      responses: {
        200: jsonResponse("Plan approved.", taskResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can approve plans.", forbiddenSchema),
        404: jsonResponse("Task not found.", notFoundSchema),
        409: jsonResponse("Plan not pending.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(taskIdParamSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      if (!(await findTaskInTeam(params.taskId, params.teamId))) {
        return c.json({ error: "not_found", message: "task not found in this team" }, 404)
      }
      const result = await taskService.approvePlan(params.taskId, actorFromContext(ctx))
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ task: result.task })
    },
  )

  // POST /api/teams/:teamId/tasks/:taskId/plan/reject — reject plan
  app.post(
    "/api/teams/:teamId/tasks/:taskId/plan/reject",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Reject task plan",
      responses: {
        200: jsonResponse("Plan rejected.", taskResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only admins can reject plans.", forbiddenSchema),
        404: jsonResponse("Task not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["admin"]),
    paramValidator(taskIdParamSchema),
    jsonValidator(rejectPlanSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findTaskInTeam(params.taskId, params.teamId))) {
        return c.json({ error: "not_found", message: "task not found in this team" }, 404)
      }
      const result = await taskService.rejectPlan(params.taskId, actorFromContext(ctx), input.reason)
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ task: result.task })
    },
  )

  // POST /api/teams/:teamId/tasks/:taskId/handoff — handoff
  app.post(
    "/api/teams/:teamId/tasks/:taskId/handoff",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Hand off task to another assignee",
      responses: {
        200: jsonResponse("Task handed off.", handoffResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Task not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(taskIdParamSchema),
    jsonValidator(handoffSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findTaskInTeam(params.taskId, params.teamId))) {
        return c.json({ error: "not_found", message: "task not found in this team" }, 404)
      }
      const result = await taskService.handoff(
        params.taskId,
        input.from,
        input.to,
        input.reason ?? "",
        input.contextSnapshot,
        actorFromContext(ctx),
      )
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ task: result.task, handoff: result.handoff })
    },
  )

  // POST /api/teams/:teamId/tasks/:taskId/dependencies — add dependency
  app.post(
    "/api/teams/:teamId/tasks/:taskId/dependencies",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Add task dependency",
      responses: {
        200: jsonResponse("Dependency added.", dependencyResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Task not found.", notFoundSchema),
        409: jsonResponse("Cycle or duplicate dependency.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(taskIdParamSchema),
    jsonValidator(addDependencySchema),
    async (c) => {
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findTaskInTeam(params.taskId, params.teamId))) {
        return c.json({ error: "not_found", message: "task not found in this team" }, 404)
      }
      const result = await taskService.addDependency(params.taskId, input.dependsOnId)
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ task: result.task, dependsOnTask: result.dependsOnTask })
    },
  )

  // DELETE /api/teams/:teamId/tasks/:taskId/dependencies/:dependsOnId — remove dependency
  app.delete(
    "/api/teams/:teamId/tasks/:taskId/dependencies/:dependsOnId",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Remove task dependency",
      responses: {
        200: jsonResponse("Dependency removed.", taskResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Task not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(dependencyParamSchema),
    async (c) => {
      const params = c.req.valid("param")
      if (!(await findTaskInTeam(params.taskId, params.teamId))) {
        return c.json({ error: "not_found", message: "task not found in this team" }, 404)
      }
      const result = await taskService.removeDependency(params.taskId, params.dependsOnId)
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ task: result.task })
    },
  )
}
