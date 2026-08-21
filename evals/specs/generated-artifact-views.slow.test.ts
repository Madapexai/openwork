import { expect } from "vitest"
import { needs, server, test } from "@openwork/testkit"
import { denFetch } from "@openwork/behaviors"

const requirements = {
  optIn: ["OPENWORK_EVAL_APP_SPECS", "OPENWORK_EVAL_GENERATED_ARTIFACT_VIEWS_SPEC"],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${String(JSON.stringify(value)).slice(0, 500)}`)
  return value
}

let requestId = 0

async function agentRpc(apiUrl: string, token: string, method: string, params: Record<string, unknown>) {
  const currentRequestId = ++requestId
  const response = await fetch(`${apiUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: currentRequestId, method, params }),
    signal: AbortSignal.timeout(180_000),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`MCP ${method} failed: HTTP ${response.status} ${raw.slice(0, 500)}`)
  const payload = raw.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as unknown)
    .find((candidate) => isRecord(candidate) && candidate.id === currentRequestId)
  if (!payload) throw new Error(`MCP ${method} returned no matching SSE response: ${raw.slice(0, 500)}`)
  const message = requireRecord(payload, `${method} response`)
  if (message.error) throw new Error(`MCP ${method} returned an error: ${JSON.stringify(message.error)}`)
  return requireRecord(message.result, `${method} result`)
}

function toolResourceUri(result: Record<string, unknown>, name: string): string | null {
  const tools = Array.isArray(result.tools) ? result.tools.filter(isRecord) : []
  const tool = tools.find((candidate) => candidate.name === name)
  const meta = isRecord(tool?._meta) ? tool._meta : {}
  return isRecord(meta.ui) && typeof meta.ui.resourceUri === "string" ? meta.ui.resourceUri : null
}

function resourceContent(result: Record<string, unknown>): Record<string, unknown> {
  const contents = Array.isArray(result.contents) ? result.contents.filter(isRecord) : []
  return requireRecord(contents[0], "resource content")
}

test("the agent MCP exposes the custom Artifact view authoring lifecycle", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs(requirements)
  await using den = await server({
    place,
    org: { name: `Generated Artifact Views ${Date.now()}`, admin: { name: "Avery" } },
  })
  const orgs = await denFetch(den.admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  })
  const rows = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.filter(isRecord) : []
  const organizationId = String(rows[0]?.id ?? "")
  expect(organizationId).not.toBe("")
  const enabled = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ capabilities: { codemodeScripts: true } }),
  })
  expect(enabled.response.ok, enabled.text).toBe(true)

  const tokenResponse = await denFetch(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${den.admin.token}`,
      "x-openwork-org-id": organizationId,
    },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  })
  const mcpToken = isRecord(tokenResponse.body) ? String(tokenResponse.body.token ?? "") : ""
  expect(tokenResponse.response.ok, tokenResponse.text).toBe(true)
  expect(mcpToken).toMatch(/^ow_mcp_at_/)

  const initialized = await denFetch(den.admin, "/mcp/agent", {
    method: "POST",
    headers: {
      authorization: `Bearer ${mcpToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
        clientInfo: { name: "generated-artifact-view-eval", version: "1.0.0" },
      },
    }),
  })
  expect(initialized.response.ok, initialized.text).toBe(true)
  expect(initialized.text).toContain("io.modelcontextprotocol/ui")

  const initialTools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(initialTools, "save_artifact_view")).toBeNull()

  const code = 'return { title: "Quarterly plan", status: "Ready" }'
  const executed = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "execute_capability_script",
    arguments: { code },
  })
  expect(executed.isError, JSON.stringify(executed)).not.toBe(true)

  const savedScript = await denFetch(den.admin, "/v1/codemode-scripts", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({
      name: "Quarterly plan source",
      description: "Deterministic source for generated Artifact view verification.",
      code,
      currentInput: {},
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: { title: { type: "string" }, status: { type: "string" } },
        required: ["title", "status"],
        additionalProperties: false,
      },
    }),
  })
  expect(savedScript.response.status, savedScript.text).toBe(201)
  const saved = requireRecord(savedScript.body, "saved Script")
  const configObjectId = String(saved.configObjectId ?? "")
  expect(configObjectId).toMatch(/^cob_/)

  const scriptRun = await denFetch(den.admin, `/v1/codemode-scripts/${configObjectId}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({
      pluginId: saved.pluginId,
      configObjectVersionId: saved.configObjectVersionId,
      input: {},
    }),
  })
  expect(scriptRun.response.ok, scriptRun.text).toBe(true)

  const firstSave = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "save_artifact_view",
    arguments: {
      configObjectId,
      title: "Quarterly plan",
      description: "Agent-authored custom Artifact view.",
      reactSource: "export default function QuarterlyPlan({ data }) { return <article><h1>{data.title}</h1><p>{data.status}</p></article> }",
      cssSource: "article{padding:20px;border:2px solid #2563eb;border-radius:16px}",
    },
  })
  expect(firstSave.isError, JSON.stringify(firstSave)).not.toBe(true)
  const firstView = requireRecord(requireRecord(firstSave.structuredContent, "first save result").view, "first view")
  const artifactViewId = String(firstView.id ?? "")
  const firstRevisionId = String(firstView.activeRevisionId ?? "")
  const firstRevision = Array.isArray(firstView.revisions) ? firstView.revisions.filter(isRecord)[0] : undefined
  const firstUri = String(firstRevision?.resourceUri ?? "")
  expect(firstUri).toBe(`ui://openwork/artifacts/${artifactViewId}/views/${firstRevisionId}/index.html`)
  expect(JSON.stringify(firstSave.content)).toContain(`render_artifact_${artifactViewId}`)

  const firstRead = resourceContent(await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", { uri: firstUri }))
  const firstHtml = String(firstRead.text ?? "")
  expect(firstRead.mimeType).toBe("text/html;profile=mcp-app")
  expect(firstHtml).toContain("ui/initialize")
  expect(firstHtml).toContain("2026-01-26")
  expect(firstHtml).toContain("ResizeObserver")
  expect(firstHtml).toContain("MCP_APP_DOCUMENT_RUNTIME_ERROR")
  expect(firstHtml).not.toContain("<script src=")
  expect(firstHtml).not.toContain('"Ready"')

  const renderName = `render_artifact_${artifactViewId}`
  let tools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(tools, renderName)).toBe(firstUri)
  const rendered = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", { name: renderName, arguments: {} })
  expect(rendered.isError, JSON.stringify(rendered)).not.toBe(true)
  expect(requireRecord(rendered.structuredContent, "render result").data).toEqual({ title: "Quarterly plan", status: "Ready" })

  const secondSave = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "save_artifact_view",
    arguments: {
      artifactViewId,
      configObjectId,
      title: "Quarterly plan",
      description: "Second immutable custom revision.",
      reactSource: "export default function QuarterlyPlanV2({ data }) { return <section><h1>{data.title}</h1><strong>{data.status}</strong></section> }",
      cssSource: "section{padding:24px;border:3px solid #16a34a;border-radius:18px}",
    },
  })
  const secondView = requireRecord(requireRecord(secondSave.structuredContent, "second save result").view, "second view")
  const revisions = Array.isArray(secondView.revisions) ? secondView.revisions.filter(isRecord) : []
  const secondRevision = revisions.find((revision) => revision.id !== firstRevisionId)
  const secondRevisionId = String(secondRevision?.id ?? "")
  const secondUri = String(secondRevision?.resourceUri ?? "")
  expect(secondUri).toBe(`ui://openwork/artifacts/${artifactViewId}/views/${secondRevisionId}/index.html`)
  expect(secondUri).not.toBe(firstUri)

  const secondHtml = String(resourceContent(await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", { uri: secondUri })).text ?? "")
  expect(secondHtml).not.toBe(firstHtml)
  expect(String(resourceContent(await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", { uri: firstUri })).text ?? "")).toBe(firstHtml)
  tools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(tools, renderName)).toBe(firstUri)
  expect(toolResourceUri(tools, `preview_artifact_${artifactViewId}`)).toBe(secondUri)

  await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "activate_artifact_view_revision",
    arguments: { artifactViewId, revisionId: secondRevisionId },
  })
  tools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(tools, renderName)).toBe(secondUri)

  await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "activate_artifact_view_revision",
    arguments: { artifactViewId, revisionId: firstRevisionId },
  })
  tools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(tools, renderName)).toBe(firstUri)

  await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "retire_artifact_view",
    arguments: { artifactViewId },
  })
  tools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(tools, renderName)).toBeNull()
  expect(String(resourceContent(await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", { uri: firstUri })).text ?? "")).toBe(firstHtml)
  expect(String(resourceContent(await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", { uri: secondUri })).text ?? "")).toBe(secondHtml)

  evidence.fact(
    "Custom Artifact view provider is available only on the Code Mode agent MCP",
    "The live provider built two custom React revisions, preserved both immutable resources, injected Script data through structuredContent, activated the second revision, rolled back to the first, and retired the render tool without deleting either resource.",
    true,
  )
})
