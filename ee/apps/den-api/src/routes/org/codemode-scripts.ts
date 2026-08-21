import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  savedScriptArtifactSnapshotSchema,
  savedScriptCapabilitySchema,
  savedScriptDetailSchema,
  savedScriptTestResultSchema,
  savedScriptVersionSchema,
} from "@openwork/types/dynamic-artifacts"
import {
  createCodemodeScriptVersion,
  deleteCodemodeScriptSnapshotContent,
  getCodemodeScriptDetail,
  getCodemodeScriptSnapshot,
  listCodemodeScriptSnapshots,
  listCodemodeScriptVersions,
  saveCodemodeScript,
  testCodemodeScriptDraft,
} from "../../codemode-scripts.js"
import { orgMemberRoute, jsonValidator, queryValidator } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { listTeamsForMember } from "../../orgs.js"
import { env } from "../../env.js"
import { getCatalog } from "../../mcp/index.js"
import { buildCapabilityToolTree, createCapabilityRegistryContext } from "../../mcp/capability-registry.js"
import {
  executeMarketplaceCapability,
  listAccessibleSavedCodemodeScripts,
} from "../../mcp/marketplace-capabilities.js"
import { DEN_MCP_REQUESTED_SCOPES } from "../../mcp/scopes.js"
import { codemodeScriptsEnabled } from "../../capability-sources/codemode-rollout.js"
import { PluginArchAuthorizationError } from "./plugin-system/access.js"
import type { OrgRouteVariables } from "./shared.js"
import { codemodeCodeDigest } from "../../codemode-runs.js"

const capabilitySchema = z.object({ capabilityName: z.string(), scriptPath: z.string() })
const scriptSchema = z.object({
  pluginId: z.string(),
  configObjectId: z.string(),
  configObjectVersionId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  inputSchema: z.unknown().nullable(),
  outputSchema: z.unknown().nullable(),
  requiredCapabilities: z.array(capabilitySchema),
})
const listSchema = z.object({ items: z.array(scriptSchema) })
const saveSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(4_000).optional(),
  code: z.string().min(1).max(200_000),
  currentInput: z.unknown().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional().describe("JSON Schema for the returned value. Include this when the Script will back a custom Artifact view."),
})
const savedSchema = z.object({ pluginId: z.string(), configObjectId: z.string(), configObjectVersionId: z.string() })
const runParamsSchema = z.object({ configObjectId: z.string().min(1).max(160) })
const runSchema = z.object({
  pluginId: z.string().min(1).max(160),
  configObjectVersionId: z.string().min(1).max(160),
  input: z.unknown().optional(),
})
const runResultSchema = z.object({
  status: z.literal("succeeded"),
  value: z.unknown(),
  markdown: z.string(),
  receiptId: z.string().nullable(),
  resultDigest: z.string(),
  inputSchemaDigest: z.string().nullable(),
  outputSchemaDigest: z.string().nullable(),
  rendererVersion: z.literal("codemode-markdown-v1"),
})
const detailParamsSchema = z.object({
  configObjectId: z.string().min(1).max(160),
  receiptId: z.string().min(1).max(160).optional(),
})
const detailQuerySchema = z.object({
  maxAgeMs: z.coerce.number().int().min(60_000).max(30 * 24 * 60 * 60_000).optional(),
})
const snapshotsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() })
const draftSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(4_000).optional(),
  code: z.string().min(1).max(200_000),
  exampleInput: z.unknown().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional().describe("Explicit JSON Schema for the returned value. It must be present before this Script can back a custom Artifact view."),
  requiredCapabilities: z.array(savedScriptCapabilitySchema).max(100),
})
const testSchema = draftSchema.extend({ configObjectId: z.string().min(1).max(160) })
const versionSchema = draftSchema.extend({
  receiptId: z.string().min(1).max(160).describe("Copy receiptId from the immediately preceding successful draft test. Submit the exact same name, description, code, exampleInput, inputSchema, outputSchema, and requiredCapabilities used by that test."),
})
const versionsResponseSchema = z.object({ items: z.array(savedScriptVersionSchema) })
const snapshotsResponseSchema = z.object({ items: z.array(savedScriptArtifactSnapshotSchema) })

function routeFailure(error: unknown) {
  if (error instanceof PluginArchAuthorizationError) {
    return { status: error.status, body: { error: error.error, message: error.message } } as const
  }
  const message = error instanceof Error ? error.message : "Saved Script request failed."
  if (message.includes("not_found")) return { status: 404, body: { error: "saved_script_not_found", message } } as const
  if (message === "saved_script_matching_test_receipt_required") {
    return {
      status: 400,
      body: {
        error: message,
        message: "Test the draft first, then immediately create the version using that successful test's receiptId and the exact unchanged name, description, code, exampleInput, inputSchema, outputSchema, and requiredCapabilities. Do not reuse an older receipt or alter any draft field between the two calls.",
      },
    } as const
  }
  if (message === "saved_script_recent_receipt_required") {
    return {
      status: 400,
      body: {
        error: message,
        message: "Run the exact Script code successfully with execute_capability_script, then retry saving the Script without changing the code. The successful run must be less than 15 minutes old.",
      },
    } as const
  }
  return { status: 400, body: { error: "saved_script_rejected", message } } as const
}

export function registerOrgCodemodeScriptRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  const contextFor = async (c: {
    get(name: "organizationContext"): OrgRouteVariables["organizationContext"]
    get(name: "session"): OrgRouteVariables["session"]
    env: unknown
  }) => {
    const context = c.get("organizationContext")
    if (!context) throw new Error("organization_context_required")
    const teams = await listTeamsForMember({ organizationId: context.organization.id, memberId: context.currentMember.id })
    const member = { orgMembershipId: context.currentMember.id, teamIds: teams.map((team) => team.id) }
    const catalog = await getCatalog(app as unknown as Hono, c.env)
    const principal = {
      userId: context.currentMember.userId,
      organizationId: context.organization.id,
      scopes: new Set(DEN_MCP_REQUESTED_SCOPES),
      payload: {},
    }
    const codemodeEnabled = codemodeScriptsEnabled(context.organization.metadata)
    const capabilityContext = createCapabilityRegistryContext({
      app: app as unknown as Hono,
      env: c.env,
      catalog,
      principal,
      organizationId: context.organization.id,
      member,
      redirectUriBase: env.apiPublicUrl ?? "http://127.0.0.1",
      codemodeEnabled,
      organizationMetadata: context.organization.metadata,
      mcpConnectionsGatingEnabled: env.mcpConnectionsGatingEnabled,
    })
    const buildTools = () => buildCapabilityToolTree(capabilityContext)
    const actorContext = { organizationContext: context, memberTeams: teams, session: c.get("session") }
    return { context, member, actorContext, buildTools, codemodeEnabled }
  }

  app.get(
    "/v1/codemode-scripts",
    describeRoute({
      tags: ["Codemode Runs"], summary: "List accessible saved Code Mode scripts",
      responses: { 200: jsonResponse("Saved scripts returned.", listSchema), 401: jsonResponse("Sign-in required.", unauthorizedSchema) },
    }),
    orgMemberRoute(),
    async (c) => {
      const { context, member, codemodeEnabled } = await contextFor(c)
      if (!codemodeEnabled) return c.json({ items: [] })
      return c.json({ items: await listAccessibleSavedCodemodeScripts({ organizationId: context.organization.id, member }) })
    },
  )

  app.post(
    "/v1/codemode-scripts",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Save a successful Code Mode run as a reusable script; include outputSchema when it will back an Artifact view",
      responses: { 201: jsonResponse("Script saved.", savedSchema), 400: jsonResponse("Invalid request.", invalidRequestSchema) },
    }),
    orgMemberRoute(), jsonValidator(saveSchema),
    async (c) => {
      try {
        const { context, buildTools, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) throw new Error("codemode_scripts_disabled")
        const saved = await saveCodemodeScript({
          organizationId: context.organization.id,
          ownerMemberId: context.currentMember.id,
          script: c.req.valid("json"),
          buildTools,
        })
        return c.json(saved, 201)
      } catch (error) {
        return c.json({ error: "saved_script_rejected", message: error instanceof Error ? error.message : "Script could not be saved." }, 400)
      }
    },
  )

  app.get(
    "/v1/codemode-scripts/:configObjectId",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Inspect a saved Script and its artifact lifecycle",
      responses: {
        200: jsonResponse("Saved Script returned.", savedScriptDetailSchema),
        404: jsonResponse("Saved Script not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(), queryValidator(detailQuerySchema),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Script id." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) return c.json({ error: "saved_script_not_found" }, 404)
        return c.json(await getCodemodeScriptDetail({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          maxAgeMs: c.req.valid("query").maxAgeMs,
        }))
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/codemode-scripts/:configObjectId/versions",
    describeRoute({
      tags: ["Codemode Runs"], summary: "List immutable saved Script versions",
      responses: { 200: jsonResponse("Script versions returned.", versionsResponseSchema) },
    }),
    orgMemberRoute(),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Script id." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) return c.json({ items: [] })
        return c.json({ items: await listCodemodeScriptVersions({ context: actorContext, configObjectId: params.data.configObjectId }) })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/codemode-scripts/:configObjectId/snapshots",
    describeRoute({
      tags: ["Codemode Runs"], summary: "List saved Script artifact snapshots",
      responses: { 200: jsonResponse("Artifact snapshots returned.", snapshotsResponseSchema) },
    }),
    orgMemberRoute(), queryValidator(snapshotsQuerySchema),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Script id." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) return c.json({ items: [] })
        return c.json({ items: await listCodemodeScriptSnapshots({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          limit: c.req.valid("query").limit,
        }) })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/codemode-scripts/:configObjectId/snapshots/:receiptId",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Inspect one saved Script artifact snapshot",
      responses: {
        200: jsonResponse("Artifact snapshot returned.", savedScriptArtifactSnapshotSchema),
        404: jsonResponse("Artifact snapshot not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success || !params.data.receiptId) return c.json({ error: "invalid_request", message: "Invalid snapshot id." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) return c.json({ error: "saved_script_snapshot_not_found" }, 404)
        const snapshot = await getCodemodeScriptSnapshot({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          receiptId: params.data.receiptId,
        })
        return snapshot ? c.json(snapshot) : c.json({ error: "saved_script_snapshot_not_found" }, 404)
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/codemode-scripts/test",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Test the exact saved Script draft and return the receiptId required to create that unchanged version",
      responses: { 200: jsonResponse("Script draft tested.", savedScriptTestResultSchema), 400: jsonResponse("Test rejected.", invalidRequestSchema) },
    }),
    orgMemberRoute(), jsonValidator(testSchema),
    async (c) => {
      try {
        const { actorContext, buildTools, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) throw new Error("codemode_scripts_disabled")
        const body = c.req.valid("json")
        const { configObjectId, ...draft } = body
        const result = await testCodemodeScriptDraft({ context: actorContext, configObjectId, draft, buildTools })
        if (!result.ok) return c.json({ error: result.error, message: result.message }, 400)
        return c.json({
          receiptId: result.receiptId,
          value: result.value,
          markdown: result.markdown,
          codeDigest: codemodeCodeDigest(draft.code),
          resultDigest: result.resultDigest,
          inputSchemaDigest: result.inputSchemaDigest,
          outputSchemaDigest: result.outputSchemaDigest,
          rendererVersion: result.rendererVersion,
          requiredCapabilities: result.requiredCapabilities,
          finishedAt: result.finishedAt,
        })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/codemode-scripts/:configObjectId/versions",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Create an immutable saved Script version using the immediately preceding matching test receipt and unchanged draft",
      responses: { 201: jsonResponse("Script version created.", savedScriptDetailSchema), 400: jsonResponse("Version rejected.", invalidRequestSchema) },
    }),
    orgMemberRoute(), jsonValidator(versionSchema),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Script id." }, 400)
      try {
        const { actorContext, buildTools, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) throw new Error("codemode_scripts_disabled")
        const body = c.req.valid("json")
        const { receiptId, ...draft } = body
        return c.json(await createCodemodeScriptVersion({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          receiptId,
          draft,
          buildTools,
        }), 201)
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/codemode-scripts/:configObjectId/run",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Run an exact saved Code Mode script version",
      responses: {
        200: jsonResponse("Script executed.", runResultSchema),
        400: jsonResponse("Execution rejected.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(), jsonValidator(runSchema),
    async (c) => {
      const params = runParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid script id." }, 400)
      const { context, member, buildTools, codemodeEnabled } = await contextFor(c)
      const body = c.req.valid("json")
      const result = await executeMarketplaceCapability({
        organizationId: context.organization.id,
        member,
        pluginId: body.pluginId,
        configObjectId: params.data.configObjectId,
        configObjectVersionId: body.configObjectVersionId,
        body: body.input,
        codemodeEnabled,
        validateScriptOutput: true,
        buildTools,
      })
      if (!result.ok) return c.json({ error: result.error, message: result.message }, 400)
      if (result.result.status !== "executed") {
        return c.json({ error: "script_not_executable", message: result.result.hint ?? "Script could not execute." }, 400)
      }
      const canonical = result.result.canonicalResult ?? JSON.stringify(result.result.value)
      return c.json({
        status: "succeeded" as const,
        value: result.result.value,
        markdown: result.result.markdown ?? `\`\`\`json\n${canonical}\n\`\`\``,
        receiptId: result.result.receiptId,
        resultDigest: result.result.resultDigest ?? "",
        inputSchemaDigest: result.result.inputSchemaDigest ?? null,
        outputSchemaDigest: result.result.outputSchemaDigest ?? null,
        rendererVersion: result.result.rendererVersion ?? "codemode-markdown-v1",
      })
    },
  )

  app.delete(
    "/v1/codemode-scripts/:configObjectId/snapshots/:receiptId/content",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Delete artifact content while retaining its audit receipt",
      responses: { 200: jsonResponse("Artifact content deleted.", savedScriptArtifactSnapshotSchema) },
    }),
    orgMemberRoute(),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success || !params.data.receiptId) return c.json({ error: "invalid_request", message: "Invalid snapshot id." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) throw new Error("codemode_scripts_disabled")
        const snapshot = await deleteCodemodeScriptSnapshotContent({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          receiptId: params.data.receiptId,
        })
        return snapshot ? c.json(snapshot) : c.json({ error: "saved_script_snapshot_not_found" }, 404)
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )
}
