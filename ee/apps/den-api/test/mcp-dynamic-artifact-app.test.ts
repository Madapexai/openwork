import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { expect, test } from "bun:test"
import {
  DYNAMIC_ARTIFACT_APP_HTML,
  DYNAMIC_ARTIFACT_APP_RESOURCE_URI,
  DYNAMIC_ARTIFACT_APP_TOOL_NAME,
  dynamicArtifactAppPayloadSchema,
  dynamicArtifactAppServerCapabilities,
  registerAgentDynamicArtifactApp,
} from "../src/mcp/dynamic-artifact-app.js"

const payload = dynamicArtifactAppPayloadSchema.parse({
  schemaVersion: "1",
  artifact: {
    title: "Weekly pipeline",
    description: "Validated opportunities by stage.",
    pluginId: "plugin_sales",
    configObjectId: "configObject_pipeline",
    configObjectVersionId: "configObjectVersion_4",
    receiptId: "codemodeRun_week_32",
    automationRunId: "automationRun_week_32",
    source: "scheduled",
    generatedAt: "2026-08-11T10:30:00.000Z",
    resultDigest: `sha256:${"a".repeat(64)}`,
    rendererVersion: "codemode-markdown-v1",
    freshness: { state: "fresh", ageMs: 42_000 },
  },
  data: [
    { stage: "Qualified", value: 12 },
    { stage: "Proposal", value: 5 },
  ],
})

type LoadDynamicArtifact = Parameters<typeof registerAgentDynamicArtifactApp>[0]["load"]

async function withClient<T>(
  run: (client: Client) => Promise<T>,
  load: LoadDynamicArtifact = async ({ receiptId }) => receiptId === "missing"
    ? { ok: false, error: "saved_script_snapshot_not_found", message: "Snapshot not found." }
    : { ok: true, payload, markdown: "| Stage | Value |\n| --- | --- |\n| Qualified | 12 |" },
): Promise<T> {
  const server = new McpServer(
    { name: "dynamic-artifact-test", version: "1.0.0" },
    { capabilities: dynamicArtifactAppServerCapabilities },
  )
  registerAgentDynamicArtifactApp({
    server,
    load,
  })
  const client = new Client(
    { name: "mcp-app-host-test", version: "1.0.0" },
    {
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
    },
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

test("negotiates MCP Apps and links the render tool to a ui:// resource", async () => {
  await withClient(async (client) => {
    expect(client.getServerCapabilities()?.extensions).toEqual({
      "io.modelcontextprotocol/ui": {
        mimeTypes: ["text/html;profile=mcp-app"],
      },
    })

    const tools = await client.listTools()
    const tool = tools.tools.find((candidate) => candidate.name === DYNAMIC_ARTIFACT_APP_TOOL_NAME)
    expect(tool?._meta).toMatchObject({
      ui: {
        resourceUri: DYNAMIC_ARTIFACT_APP_RESOURCE_URI,
        visibility: ["model", "app"],
      },
      "ui/resourceUri": DYNAMIC_ARTIFACT_APP_RESOURCE_URI,
    })

    const resources = await client.listResources()
    const resource = resources.resources.find((candidate) => candidate.uri === DYNAMIC_ARTIFACT_APP_RESOURCE_URI)
    expect(resource).toMatchObject({
      uri: DYNAMIC_ARTIFACT_APP_RESOURCE_URI,
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
          prefersBorder: true,
        },
      },
    })
  })
})

test("serves a self-contained HTML5 app and a structured result with Markdown fallback", async () => {
  await withClient(async (client) => {
    const resource = await client.readResource({ uri: DYNAMIC_ARTIFACT_APP_RESOURCE_URI })
    expect(resource.contents).toHaveLength(1)
    expect(resource.contents[0]).toMatchObject({
      uri: DYNAMIC_ARTIFACT_APP_RESOURCE_URI,
      mimeType: "text/html;profile=mcp-app",
    })
    const content = resource.contents[0]
    expect(content && "text" in content ? content.text : "").toBe(DYNAMIC_ARTIFACT_APP_HTML)
    expect(DYNAMIC_ARTIFACT_APP_HTML).toStartWith("<!doctype html>")
    expect(DYNAMIC_ARTIFACT_APP_HTML).toContain("method: 'ui/initialize'")
    expect(DYNAMIC_ARTIFACT_APP_HTML).toContain("ui/notifications/initialized")
    expect(DYNAMIC_ARTIFACT_APP_HTML).toContain("ui/notifications/tool-result")
    expect(DYNAMIC_ARTIFACT_APP_HTML).toContain("ui/notifications/size-changed")
    expect(DYNAMIC_ARTIFACT_APP_HTML).not.toContain("<script src=")
    expect(DYNAMIC_ARTIFACT_APP_HTML).not.toContain("fetch(")
    const scriptStart = DYNAMIC_ARTIFACT_APP_HTML.indexOf("<script>")
    const scriptEnd = DYNAMIC_ARTIFACT_APP_HTML.lastIndexOf("</script>")
    const inlineScript = scriptStart === -1 || scriptEnd <= scriptStart
      ? undefined
      : DYNAMIC_ARTIFACT_APP_HTML.slice(scriptStart + "<script>".length, scriptEnd)
    expect(inlineScript).toBeDefined()
    expect(() => Function(inlineScript ?? "")).not.toThrow()

    const result = await client.callTool({
      name: DYNAMIC_ARTIFACT_APP_TOOL_NAME,
      arguments: { configObjectId: "configObject_pipeline" },
    })
    expect(result.isError).not.toBe(true)
    expect(dynamicArtifactAppPayloadSchema.parse(result.structuredContent)).toEqual(payload)
    const first = result.content[0]
    expect(first?.type === "text" ? first.text : "").toContain("# Weekly pipeline")
    expect(first?.type === "text" ? first.text : "").toContain("| Qualified | 12 |")
    expect(result._meta).toEqual({
      schemaVersion: "1",
      receiptId: "codemodeRun_week_32",
      resultDigest: `sha256:${"a".repeat(64)}`,
    })
  })
})

test("forwards exact receipt and freshness selection without executing a Script", async () => {
  const requests: Array<{ configObjectId: string; receiptId?: string; maxAgeMs?: number }> = []
  await withClient(async (client) => {
    const result = await client.callTool({
      name: DYNAMIC_ARTIFACT_APP_TOOL_NAME,
      arguments: {
        configObjectId: "configObject_pipeline",
        receiptId: "codemodeRun_week_32",
        maxAgeMs: 3_600_000,
      },
    })
    expect(result.isError).not.toBe(true)
  }, async (request) => {
    requests.push(request)
    return { ok: true, payload, markdown: "# Weekly pipeline" }
  })
  expect(requests).toEqual([{
    configObjectId: "configObject_pipeline",
    receiptId: "codemodeRun_week_32",
    maxAgeMs: 3_600_000,
  }])
})

test("preserves fail-closed authorization errors for non-UI clients", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: DYNAMIC_ARTIFACT_APP_TOOL_NAME,
      arguments: { configObjectId: "configObject_denied" },
    })
    expect(result.isError).toBe(true)
    const first = result.content[0]
    expect(first?.type === "text" ? JSON.parse(first.text) : null).toEqual({
      error: "saved_script_not_found",
      message: "The saved Script is unavailable to this member.",
    })
    expect(result.structuredContent).toBeUndefined()
  }, async () => ({
    ok: false,
    error: "saved_script_not_found",
    message: "The saved Script is unavailable to this member.",
  }))
})

test("keeps missing snapshots useful to clients without a UI", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: DYNAMIC_ARTIFACT_APP_TOOL_NAME,
      arguments: {
        configObjectId: "configObject_pipeline",
        receiptId: "missing",
      },
    })
    expect(result.isError).toBe(true)
    const first = result.content[0]
    expect(first?.type === "text" ? JSON.parse(first.text) : null).toEqual({
      error: "saved_script_snapshot_not_found",
      message: "Snapshot not found.",
    })
  })
})

test("exposes codex rendering hints in the payload schema", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools()
    const tool = tools.tools.find((candidate) => candidate.name === DYNAMIC_ARTIFACT_APP_TOOL_NAME)
    expect(tool).toBeDefined()
    const outputSchema = tool?.outputSchema as Record<string, unknown>
    expect(outputSchema).toBeDefined()
    const properties = (outputSchema as Record<string, { properties: Record<string, unknown> }>)?.properties
    expect(properties?.codex).toBeDefined()
  })
})
