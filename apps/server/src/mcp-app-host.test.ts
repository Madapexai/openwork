import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { addMcp } from "./mcp.js";
import {
  callMcpAppTool,
  projectedMcpToolName,
  resolveMcpAppResource,
  toolUiResourceUri,
} from "./mcp-app-host.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_mcp_apps_host";
const RESOURCE_URI = "ui://fixture/v1/view.html";
const UPDATED_RESOURCE_URI = "ui://fixture/v2/view.html";
const RESOURCE_HTML = "<!doctype html><html><head></head><body>Fixture</body></html>";
const UPDATED_RESOURCE_HTML = "<!doctype html><html><head></head><body>Updated fixture</body></html>";
const stops: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
});

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

async function startFixtureMcp(resourceContent: { text?: string; blob?: string } = { text: RESOURCE_HTML }) {
  let activeResourceUri = RESOURCE_URI;
  const mcp = new Server(
    { name: "mcp-app-fixture", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
        },
      },
    },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "render_fixture",
        description: "Render the fixture",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { ui: { resourceUri: activeResourceUri, visibility: ["model", "app"] } },
      },
      {
        name: "render_missing",
        description: "Render a missing fixture resource",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { ui: { resourceUri: "ui://fixture/missing/view.html", visibility: ["model", "app"] } },
      },
      {
        name: "save_artifact_view",
        description: "Save fixture state without rendering it",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      {
        name: "read_detail",
        description: "Read fixture detail",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: "model_only_detail",
        description: "Read model-only fixture detail",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { ui: { visibility: ["model"] } },
      },
      {
        name: "write_detail",
        description: "Write fixture detail",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ],
  }));
  mcp.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri !== RESOURCE_URI && params.uri !== UPDATED_RESOURCE_URI) throw new Error("not found");
    const content = params.uri === UPDATED_RESOURCE_URI ? { text: UPDATED_RESOURCE_HTML } : resourceContent;
    return {
      contents: [{
        uri: params.uri,
        mimeType: "text/html;profile=mcp-app",
        ...content,
        _meta: {
          ui: {
            csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
            prefersBorder: true,
          },
        },
      }],
    };
  });
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
    content: [{ type: "text", text: `detail:${String(params.arguments?.id ?? "")}` }],
    structuredContent: { id: params.arguments?.id ?? null },
  }));

  let transport: WebStandardStreamableHTTPServerTransport;
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => transport.handleRequest(request),
  });
  const reconnect = async () => {
    await mcp.close();
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${http.port}`, `localhost:${http.port}`],
    });
    await mcp.connect(transport);
  };
  await reconnect();
  stops.push(async () => {
    await mcp.close();
    http.stop(true);
  });
  return {
    url: `http://127.0.0.1:${http.port}`,
    activateUpdatedResource: async () => {
      activeResourceUri = UPDATED_RESOURCE_URI;
      // A stateful SDK server transport owns one initialized MCP session. The
      // host deliberately creates a fresh client for each exact resolution,
      // so reset the fixture transport before exercising the second lookup.
      await reconnect();
    },
  };
}

async function configuredFixture(
  prefix: string,
  resourceContent?: { text?: string; blob?: string },
): Promise<{ config: ServerConfig; root: string; activateUpdatedResource: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
  const previousDevMode = process.env.OPENWORK_DEV_MODE;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.OPENWORK_DEV_MODE = "1";
  stops.push(async () => {
    if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
    if (previousDevMode === undefined) delete process.env.OPENWORK_DEV_MODE;
    else process.env.OPENWORK_DEV_MODE = previousDevMode;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, ".git"), { recursive: true });
  const config = serverConfig(root);
  const fixture = await startFixtureMcp(resourceContent);
  await addMcp(config, WORKSPACE_ID, "fixture", {
    type: "remote",
    url: fixture.url,
    enabled: true,
  });
  return { config, root, activateUpdatedResource: fixture.activateUpdatedResource };
}

describe("MCP Apps host transport", () => {
  test("uses OpenCode's exact projected MCP tool naming", () => {
    expect(projectedMcpToolName("sales force", "render.pipeline")).toBe("sales_force_render_pipeline");
    expect(toolUiResourceUri({ _meta: { ui: { resourceUri: RESOURCE_URI } } })).toBe(RESOURCE_URI);
  });

  test("negotiates and resolves one fixed remote MCP App fixture", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-host-");

    const app = await resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_fixture",
    });
    expect(app).toEqual({
      serverName: "fixture",
      toolName: "render_fixture",
      resourceUri: RESOURCE_URI,
      html: RESOURCE_HTML,
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
      prefersBorder: true,
    });

  });

  test("treats a management tool without a UI resource as a normal result", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-host-management-");

    expect(await resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_save_artifact_view",
    })).toBeNull();
  });

  test("refreshes the current tool definition before reading its exact resource", async () => {
    const { config, root, activateUpdatedResource } = await configuredFixture("openwork-mcp-app-host-refresh-");

    const first = await resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_fixture",
    });
    await activateUpdatedResource();
    const updated = await resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_fixture",
    });

    expect(first?.resourceUri).toBe(RESOURCE_URI);
    expect(updated).toMatchObject({ resourceUri: UPDATED_RESOURCE_URI, html: UPDATED_RESOURCE_HTML });
  });

  test("reports an advertised resource that resources/read cannot load", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-host-missing-");

    await expect(resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_missing",
    })).rejects.toMatchObject({ code: "resource_read_failed" });
  });

  test("decodes a stable-spec blob-backed HTML resource", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-host-blob-", {
      blob: Buffer.from(RESOURCE_HTML, "utf8").toString("base64"),
    });

    const app = await resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_fixture",
    });
    expect(app?.html).toBe(RESOURCE_HTML);
  });

  test("rejects non-UTF-8 blob-backed HTML", async () => {
    const invalidUtf8 = await configuredFixture("openwork-mcp-app-host-bad-utf8-", {
      blob: Buffer.from([0xff]).toString("base64"),
    });
    await expect(resolveMcpAppResource({
      serverConfig: invalidUtf8.config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: invalidUtf8.root,
      projectedToolName: "fixture_render_fixture",
    })).rejects.toMatchObject({ code: "invalid_resource" });
  });

  test("preserves an unreachable provider error for host diagnostics", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-host-unreachable-");
    await stops.pop()?.();

    await expect(resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_fixture",
    })).rejects.toMatchObject({ code: "mcp_unreachable" });
  });

  test("mediates explicitly read-only same-server tool calls", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-call-");

    const result = await callMcpAppTool({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      serverName: "fixture",
      name: "read_detail",
      arguments: { id: "42" },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "detail:42" }],
      structuredContent: { id: "42" },
    });
  });

  test("rejects model-only same-server tools", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-model-only-");
    await expect(callMcpAppTool({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      serverName: "fixture",
      name: "model_only_detail",
    })).rejects.toMatchObject({ code: "tool_not_visible" });
  });

  test("rejects same-server tools that require approval", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-write-");
    await expect(callMcpAppTool({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      serverName: "fixture",
      name: "write_detail",
    })).rejects.toMatchObject({ code: "tool_requires_approval" });
  });

  test("rejects private MCP egress outside explicit development mode", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-private-");
    delete process.env.OPENWORK_DEV_MODE;

    await expect(resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_fixture",
    })).rejects.toMatchObject({ code: "unsafe_server_url" });
  });
});
