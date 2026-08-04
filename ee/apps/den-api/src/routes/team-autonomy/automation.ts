// team-autonomy/automation.ts — 自动化路由（状态机 + 降级 + 告警）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-http-routes.md
// 挂载前缀: /api/teams/:teamId/automations
//
// 注意：/automations/runs/... 与 /automations/alerts 静态段先于 /:automationId 注册，
// 避免被动态段吞掉。

import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { TeamAutomationTable, TeamAutomationRunTable, TeamAutomationAlertTable, AutomationState, DegradationLevel } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import * as automationService from "../../team-autonomy/automation-service.js"
import {
  actorFromContext,
  alertIdParamSchema,
  authenticatedRoute,
  automationIdParamSchema,
  denTypeIdSchema,
  forbiddenSchema,
  invalidRequestSchema,
  jsonResponse,
  jsonServiceError,
  notFoundSchema,
  resolveTeamContext,
  runIdParamSchema,
  teamRoleCheck,
  type TeamAutonomyRouteVariables,
  unauthorizedSchema,
} from "./shared.js"
import { jsonValidator, paramValidator } from "../../middleware/index.js"

const retryPolicySchema = z.object({
  max_attempts: z.number().int().nonnegative(),
  backoff_coefficient: z.number().nonnegative(),
  retry_on: z.array(z.string()),
  no_retry_on: z.array(z.string()),
}).meta({ ref: "AutomationRetryPolicy" })

const createAutomationSchema = z.object({
  name: z.string().trim().min(1).max(128),
  cronExpr: z.string().min(1).max(64),
  message: z.string().min(1),
  agentId: denTypeIdSchema("teamAgent").optional(),
  timezone: z.string().optional(),
  scopedApprovals: z.record(z.string(), z.unknown()).optional(),
  skipOnOverlap: z.boolean().optional(),
  runOnceCatchUp: z.boolean().optional(),
  qualityGate: z.record(z.string(), z.unknown()).optional(),
  retryPolicy: retryPolicySchema.optional(),
  deliveryTargets: z.array(z.record(z.string(), z.unknown())).optional(),
  maxCostCentsPerRun: z.number().int().nonnegative().optional(),
}).meta({ ref: "CreateAutomationInput" })

const updateAutomationSchema = createAutomationSchema.partial().omit({ agentId: true }).meta({ ref: "UpdateAutomationInput" })

const scheduleSchema = z.object({
  enabled: z.boolean(),
}).meta({ ref: "EnableAutomationScheduleInput" })

const startRunSchema = z.object({
  batchId: z.string().min(1).max(128),
  taskId: denTypeIdSchema("teamTask").optional(),
  dryRun: z.boolean().optional(),
}).meta({ ref: "StartAutomationRunInput" })

const advanceRunSchema = z.object({
  to: z.enum(AutomationState),
  sourceStatus: z.record(z.string(), z.enum(["ok", "failed", "partial"])).optional(),
  artifacts: z.array(z.string()).optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  costCents: z.number().int().nonnegative().optional(),
}).meta({ ref: "AdvanceAutomationRunInput" })

const failRunSchema = z.object({
  errorCode: z.string().min(1),
  errorMessage: z.string().min(1),
}).meta({ ref: "FailAutomationRunInput" })

const createAlertSchema = z.object({
  automationId: denTypeIdSchema("teamAutomation"),
  runId: denTypeIdSchema("teamAutomationRun").optional(),
  batchId: z.string().min(1).max(128),
  status: z.enum(AutomationState),
  triggerTime: z.string().min(1),
  failureReason: z.string().min(1),
  completedSteps: z.array(z.string()),
  impact: z.string().min(1),
  suggestedActions: z.array(z.string()),
  recoveryEntry: z.string().min(1),
  severity: z.enum(["info", "warning", "critical"]).optional(),
}).meta({ ref: "CreateAutomationAlertInput" })

const automationObjectSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  cronExpr: z.string(),
  message: z.string(),
  agentId: z.string().nullable(),
  scopedApprovals: z.record(z.string(), z.unknown()).nullable(),
  timezone: z.string(),
  enabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  skipOnOverlap: z.boolean(),
  runOnceCatchUp: z.boolean(),
  manualRunCount: z.number(),
  readyForSchedule: z.boolean(),
  qualityGate: z.record(z.string(), z.unknown()).nullable(),
  retryPolicy: z.record(z.string(), z.unknown()).nullable(),
  deliveryTargets: z.array(z.record(z.string(), z.unknown())).nullable(),
  maxCostCentsPerRun: z.number().nullable(),
  ownerMemberId: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const runObjectSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  taskId: z.string().nullable(),
  batchId: z.string(),
  status: z.enum(AutomationState),
  state: z.record(z.string(), z.unknown()).nullable(),
  degradationLevel: z.enum(DegradationLevel).nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  artifacts: z.array(z.string()).nullable(),
  tokensUsed: z.number().nullable(),
  costCents: z.number().nullable(),
  dryRun: z.boolean(),
  createdAt: z.string(),
})

const alertObjectSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  automationId: z.string(),
  runId: z.string().nullable(),
  triggerTime: z.string().nullable(),
  severity: z.string(),
  failureReason: z.string(),
  completedSteps: z.array(z.string()).nullable(),
  impact: z.string(),
  suggestedActions: z.array(z.string()),
  recoveryEntry: z.string(),
  delivered: z.boolean(),
  deliveredAt: z.string().nullable(),
  acknowledgedBy: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  createdAt: z.string(),
})

const automationResponseSchema = z.object({ automation: automationObjectSchema }).meta({ ref: "TeamAutomationResponse" })
const automationListResponseSchema = z.object({ automations: z.array(automationObjectSchema) }).meta({ ref: "TeamAutomationListResponse" })
const runResponseSchema = z.object({ run: runObjectSchema }).meta({ ref: "TeamAutomationRunResponse" })
const alertResponseSchema = z.object({ alert: alertObjectSchema }).meta({ ref: "TeamAutomationAlertResponse" })
const alertListResponseSchema = z.object({ alerts: z.array(alertObjectSchema) }).meta({ ref: "TeamAutomationAlertListResponse" })
const advanceRunResponseSchema = z.object({
  run: runObjectSchema,
  previousStatus: z.enum(AutomationState),
  degradationLevel: z.enum(DegradationLevel).optional(),
}).meta({ ref: "TeamAutomationAdvanceRunResponse" })
const failRunResponseSchema = z.object({
  run: runObjectSchema,
  retried: z.boolean(),
  nextAttemptAt: z.string().nullable(),
}).meta({ ref: "TeamAutomationFailRunResponse" })
const scheduleResponseSchema = z.object({
  automation: automationObjectSchema,
  enabled: z.boolean(),
}).meta({ ref: "TeamAutomationScheduleResponse" })
const manualRunResponseSchema = z.object({
  run: runObjectSchema,
  manualRunCount: z.number(),
  readyForSchedule: z.boolean(),
}).meta({ ref: "TeamAutomationManualRunResponse" })
const startRunResponseSchema = z.object({
  run: runObjectSchema,
  created: z.boolean(),
}).meta({ ref: "TeamAutomationStartRunResponse" })

// TeamAutomationTable 行 → camelCase API 对象
function rowToAutomation(row: typeof TeamAutomationTable.$inferSelect) {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    cronExpr: row.cron_expr,
    message: row.message,
    agentId: row.agent_id,
    scopedApprovals: row.scoped_approvals,
    timezone: row.timezone,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    skipOnOverlap: row.skip_on_overlap,
    runOnceCatchUp: row.run_once_catch_up,
    manualRunCount: row.manual_run_count,
    readyForSchedule: row.ready_for_schedule,
    qualityGate: row.quality_gate,
    retryPolicy: row.retry_policy,
    deliveryTargets: row.delivery_targets,
    maxCostCentsPerRun: row.max_cost_cents_per_run,
    ownerMemberId: row.owner_member_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// 校验 run 属于该 team（run → automation.team_id）
async function findRunInTeam(runId: `taur_${string}`, teamId: `tem_${string}`) {
  const rows = await db
    .select({ id: TeamAutomationRunTable.id })
    .from(TeamAutomationRunTable)
    .innerJoin(TeamAutomationTable, eq(TeamAutomationTable.id, TeamAutomationRunTable.automation_id))
    .where(and(eq(TeamAutomationRunTable.id, runId), eq(TeamAutomationTable.team_id, teamId)))
    .limit(1)
  return rows[0] ? rows[0].id : null
}

// 校验 automation 属于该 team
async function findAutomationInTeam(automationId: `taut_${string}`, teamId: `tem_${string}`) {
  const rows = await db
    .select({ id: TeamAutomationTable.id })
    .from(TeamAutomationTable)
    .where(and(eq(TeamAutomationTable.id, automationId), eq(TeamAutomationTable.team_id, teamId)))
    .limit(1)
  return rows[0] ? rows[0].id : null
}

// 校验 alert 属于该 team
async function findAlertInTeam(alertId: `taal_${string}`, teamId: `tem_${string}`) {
  const rows = await db
    .select({ id: TeamAutomationAlertTable.id })
    .from(TeamAutomationAlertTable)
    .where(and(eq(TeamAutomationAlertTable.id, alertId), eq(TeamAutomationAlertTable.team_id, teamId)))
    .limit(1)
  return rows[0] ? rows[0].id : null
}

export function registerTeamAutomationRoutes<T extends { Variables: TeamAutonomyRouteVariables }>(app: Hono<T>) {
  // GET /api/teams/:teamId/automations — list
  app.get(
    "/api/teams/:teamId/automations",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "List team automations",
      responses: {
        200: jsonResponse("Automations listed.", automationListResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Team or organization not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(automationIdParamSchema.pick({ teamId: true })),
    async (c) => {
      const params = c.req.valid("param")
      const rows = await db.select().from(TeamAutomationTable).where(eq(TeamAutomationTable.team_id, params.teamId))
      return c.json({ automations: rows.map(rowToAutomation) })
    },
  )

  // POST /api/teams/:teamId/automations — create
  app.post(
    "/api/teams/:teamId/automations",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Create team automation",
      responses: {
        201: jsonResponse("Automation created.", automationResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(automationIdParamSchema.pick({ teamId: true })),
    jsonValidator(createAutomationSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      const result = await automationService.createAutomation({
        teamId: params.teamId,
        ...input,
        ownerMemberId: ctx.currentMember.id,
        createdBy: ctx.currentMember.id,
      })
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ automation: result.automation }, 201)
    },
  )

  // GET /api/teams/:teamId/automations/runs/:runId — get run
  app.get(
    "/api/teams/:teamId/automations/runs/:runId",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Get automation run",
      responses: {
        200: jsonResponse("Run details.", runResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Run not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(runIdParamSchema),
    async (c) => {
      const params = c.req.valid("param")
      if (!(await findRunInTeam(params.runId, params.teamId))) {
        return c.json({ error: "not_found", message: "run not found in this team" }, 404)
      }
      const run = await automationService.getRun(params.runId)
      if (!run) {
        return c.json({ error: "not_found", message: "run not found" }, 404)
      }
      return c.json({ run })
    },
  )

  // POST /api/teams/:teamId/automations/runs/:runId/advance
  app.post(
    "/api/teams/:teamId/automations/runs/:runId/advance",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Advance automation run",
      responses: {
        200: jsonResponse("Run advanced.", advanceRunResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Run not found.", notFoundSchema),
        409: jsonResponse("Invalid transition.", z.object({ error: z.string() })),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(runIdParamSchema),
    jsonValidator(advanceRunSchema),
    async (c) => {
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findRunInTeam(params.runId, params.teamId))) {
        return c.json({ error: "not_found", message: "run not found in this team" }, 404)
      }
      const result = await automationService.advanceRun(params.runId, input)
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({
        run: result.run,
        previousStatus: result.previousStatus,
        ...(result.degradationLevel !== undefined ? { degradationLevel: result.degradationLevel } : {}),
      })
    },
  )

  // POST /api/teams/:teamId/automations/runs/:runId/fail
  app.post(
    "/api/teams/:teamId/automations/runs/:runId/fail",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Mark automation run failed",
      responses: {
        200: jsonResponse("Run marked failed.", failRunResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Run not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(runIdParamSchema),
    jsonValidator(failRunSchema),
    async (c) => {
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findRunInTeam(params.runId, params.teamId))) {
        return c.json({ error: "not_found", message: "run not found in this team" }, 404)
      }
      const result = await automationService.failRun(params.runId, input)
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({
        run: result.run,
        retried: result.retried,
        nextAttemptAt: result.nextAttemptAt ?? null,
      })
    },
  )

  // GET /api/teams/:teamId/automations/alerts — list alerts
  app.get(
    "/api/teams/:teamId/automations/alerts",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "List team automation alerts",
      responses: {
        200: jsonResponse("Alerts listed.", alertListResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Team or organization not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(automationIdParamSchema.pick({ teamId: true })),
    async (c) => {
      const params = c.req.valid("param")
      const alerts = await automationService.listAlerts({ teamId: params.teamId })
      return c.json({ alerts })
    },
  )

  // POST /api/teams/:teamId/automations/alerts — create alert
  app.post(
    "/api/teams/:teamId/automations/alerts",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Create automation alert",
      responses: {
        201: jsonResponse("Alert created.", alertResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(automationIdParamSchema.pick({ teamId: true })),
    jsonValidator(createAlertSchema),
    async (c) => {
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findAutomationInTeam(input.automationId, params.teamId))) {
        return c.json({ error: "not_found", message: "automation not found in this team" }, 404)
      }
      const result = await automationService.createAlert({
        teamId: params.teamId,
        ...input,
      })
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ alert: result.alert }, 201)
    },
  )

  // POST /api/teams/:teamId/automations/alerts/:alertId/acknowledge
  app.post(
    "/api/teams/:teamId/automations/alerts/:alertId/acknowledge",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Acknowledge automation alert",
      responses: {
        200: jsonResponse("Alert acknowledged.", alertResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Alert not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(alertIdParamSchema),
    async (c) => {
      const ctx = c.get("organizationContext")!
      const params = c.req.valid("param")
      if (!(await findAlertInTeam(params.alertId, params.teamId))) {
        return c.json({ error: "not_found", message: "alert not found in this team" }, 404)
      }
      const result = await automationService.acknowledgeAlert(params.alertId, ctx.currentMember.id)
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ alert: result.alert })
    },
  )

  // GET /api/teams/:teamId/automations/:automationId — get
  app.get(
    "/api/teams/:teamId/automations/:automationId",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Get team automation",
      responses: {
        200: jsonResponse("Automation details.", automationResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Automation not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(automationIdParamSchema),
    async (c) => {
      const params = c.req.valid("param")
      const rows = await db
        .select()
        .from(TeamAutomationTable)
        .where(and(eq(TeamAutomationTable.id, params.automationId), eq(TeamAutomationTable.team_id, params.teamId)))
        .limit(1)
      if (!rows[0]) {
        return c.json({ error: "not_found", message: "automation not found in this team" }, 404)
      }
      return c.json({ automation: rowToAutomation(rows[0]) })
    },
  )

  // PATCH /api/teams/:teamId/automations/:automationId — update
  app.patch(
    "/api/teams/:teamId/automations/:automationId",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Update team automation",
      responses: {
        200: jsonResponse("Automation updated.", automationResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Automation not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(automationIdParamSchema),
    jsonValidator(updateAutomationSchema),
    async (c) => {
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findAutomationInTeam(params.automationId, params.teamId))) {
        return c.json({ error: "not_found", message: "automation not found in this team" }, 404)
      }
      const result = await automationService.updateAutomation(params.automationId, input)
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ automation: result.automation })
    },
  )

  // PATCH /api/teams/:teamId/automations/:automationId/schedule
  app.patch(
    "/api/teams/:teamId/automations/:automationId/schedule",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Enable or disable automation schedule",
      responses: {
        200: jsonResponse("Schedule updated.", scheduleResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Automation not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(automationIdParamSchema),
    jsonValidator(scheduleSchema),
    async (c) => {
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findAutomationInTeam(params.automationId, params.teamId))) {
        return c.json({ error: "not_found", message: "automation not found in this team" }, 404)
      }
      const result = await automationService.enableSchedule(params.automationId, input.enabled)
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ automation: result.automation, enabled: result.enabled })
    },
  )

  // POST /api/teams/:teamId/automations/:automationId/manual-run
  app.post(
    "/api/teams/:teamId/automations/:automationId/manual-run",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Manually run automation",
      responses: {
        200: jsonResponse("Manual run started.", manualRunResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Automation not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(automationIdParamSchema),
    async (c) => {
      const params = c.req.valid("param")
      if (!(await findAutomationInTeam(params.automationId, params.teamId))) {
        return c.json({ error: "not_found", message: "automation not found in this team" }, 404)
      }
      const result = await automationService.manualRun(params.automationId)
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({
        run: result.run,
        manualRunCount: result.manualRunCount,
        readyForSchedule: result.readyForSchedule,
      })
    },
  )

  // POST /api/teams/:teamId/automations/:automationId/runs — start run
  app.post(
    "/api/teams/:teamId/automations/:automationId/runs",
    describeRoute({
      tags: ["Team Autonomy"],
      summary: "Start an automation run",
      responses: {
        200: jsonResponse("Run started.", startRunResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Caller lacks permission.", forbiddenSchema),
        404: jsonResponse("Automation not found.", notFoundSchema),
      },
    }),
    authenticatedRoute(),
    resolveTeamContext,
    teamRoleCheck(["member"]),
    paramValidator(automationIdParamSchema),
    jsonValidator(startRunSchema),
    async (c) => {
      const params = c.req.valid("param")
      const input = c.req.valid("json")
      if (!(await findAutomationInTeam(params.automationId, params.teamId))) {
        return c.json({ error: "not_found", message: "automation not found in this team" }, 404)
      }
      const result = await automationService.startRun({
        automationId: params.automationId,
        batchId: input.batchId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      })
      if (!result.ok) {
        return jsonServiceError(c, result)
      }
      return c.json({ run: result.run, created: result.created })
    },
  )
}
