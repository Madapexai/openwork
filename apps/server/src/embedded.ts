/**
 * Single entry point for embedding the OpenWork server in-process.
 *
 * Handles config resolution, managed OpenCode spawn, and server start
 * in one call -- mirrors what cli.ts does but returns a handle instead
 * of owning the process lifecycle.
 *
 * Agent Sidecar Adapter:
 * 通过 OPENWORK_AGENT_ID 环境变量切换 CLI agent（默认 "opencode-serve" 走 HTTP）。
 * 可选值见 agent-sidecar/presets.ts，覆盖 35+ CLI agent。
 * 不指定时保持向后兼容（沿用现有 managed-opencode.ts）。
 *
 * 协议分叉：
 * - HTTP 协议（"opencode-serve"）：走原有 managed-opencode，注入 opencodeBaseUrl
 * - ACP/PTY/MCP/Generic 协议：通过 agent-sidecar 抽象层启动，handle 暴露在返回值
 *   供后续 session-based API 使用（agent-sidecar/sessions 模块）
 */
import { mkdir } from "node:fs/promises";
import { resolveServerConfig, type CliArgs } from "./config.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer, type OpencodeExecutionSnapshot } from "./managed-opencode.js";
import {
  clearTrustedOpencodeProcess,
  registerTrustedOpencodeProcess,
  startServer,
  syncAllWorkspacesRuntimeMcpToEngine,
} from "./server.js";
import { ensureLocalWorkspaceFiles } from "./workspace-init.js";
import { findManagedEngineWorkspace } from "./workspaces.js";
import { keepOpenworkRuntimeConfigFileFresh, writeOpenworkRuntimeConfigFile } from "./openwork-runtime-config.js";
import { sweepLegacyOpenCodeConfig } from "./legacy-config-sweep.js";
import { resolveOpencodeModelsUrl } from "./opencode-models-url.js";
import type { ServeResult } from "./serve-node.js";
import type { ServerConfig } from "./types.js";
import {
  createAdapterForAgent,
  type AgentSidecarAdapter,
  type SidecarHandle,
  type TransportInfo,
} from "./agent-sidecar/index.js";

/** 内置 HTTP agent ID，走原有 managed-opencode 路径 */
const HTTP_AGENT_ID = "opencode-serve";

export type EmbeddedServerOptions = CliArgs & {
  /** When true, spawn a managed OpenCode child process. */
  manageOpencode?: boolean;
  /** Path to the OpenCode binary. Falls back to OPENWORK_OPENCODE_BIN env. */
  opencodeBin?: string;
  /** Working directory for the managed OpenCode process. */
  opencodeCwd?: string;
  /**
   * Agent ID to use as sidecar (overrides OPENWORK_AGENT_ID env).
   * Default: "opencode-serve" (HTTP) for backward compat.
   * Examples: "kimi", "traecli", "goose", "claude-code", ...
   * See agent-sidecar/presets.ts for the full list.
   */
  agentId?: string;
};

export type EmbeddedServerHandle = {
  /** Bound port the HTTP server is listening on. */
  port: number;
  /** Full base URL, e.g. http://127.0.0.1:48123 */
  url: string;
  /** The resolved server config (with OpenCode URLs populated). */
  config: ServerConfig;
  /** Redacted details for the managed OpenCode child process, when spawned. */
  managedOpencodeExecution: OpencodeExecutionSnapshot | null;
  /** Liveness for the managed OpenCode child process, when spawned. */
  managedOpencode: { pid: number | null; isAlive: () => boolean } | null;
  /** Agent sidecar handle, when a non-HTTP agent (ACP/PTY/MCP/Generic) was spawned. */
  agentSidecar: { agentId: string; protocol: string; transportInfo: TransportInfo; pid: number | null; isAlive: () => boolean } | null;
  /** Stop the HTTP server and managed OpenCode (if any). */
  stop: () => Promise<void>;
};

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  const config = await resolveServerConfig(options);
  const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;

  // Spawn managed OpenCode if requested and no explicit base URL was provided.
  let managedOpencode: ManagedOpencodeServer | null = null;
  let managedOpencodeIdentity: string | null = null;

  // Agent Sidecar (ACP/PTY/MCP/Generic) handle
  let agentSidecarAdapter: AgentSidecarAdapter | null = null;
  let agentSidecarHandle: SidecarHandle | null = null;

  // 解析 agentId：优先 options.agentId，其次 OPENWORK_AGENT_ID 环境变量
  // 未指定时为 undefined → 走原有 managed-opencode 路径（向后兼容）
  const requestedAgentId = options.agentId?.trim()
    || process.env.OPENWORK_AGENT_ID?.trim()
    || null;
  const isHttpAgent = requestedAgentId === HTTP_AGENT_ID;

  if (!config.readOnly) {
    await ensureLocalWorkspaceFiles(config.workspaces);
  }

  if (!config.opencodeBaseUrl && options.manageOpencode) {
    const workspace = findManagedEngineWorkspace(config.workspaces);
    if (workspace) {
      // Server-managed config file: the engine re-reads it from disk on every
      // instance rebuild, and keepOpenworkRuntimeConfigFileFresh synchronizes it
      // on every runtime-DB write — so disposes always pick up current state.
      const { path: runtimeConfigPath } = await writeOpenworkRuntimeConfigFile(config, workspace.id);
      keepOpenworkRuntimeConfigFileFresh(config, workspace.id);
      const cwd = options.opencodeCwd
        || process.env.OPENWORK_MANAGED_OPENCODE_CWD?.trim()
        || workspace.path;
      await mkdir(cwd, { recursive: true });
      await sweepLegacyOpenCodeConfig(config).catch(() => undefined);
      const opencodeModelsUrl = await resolveOpencodeModelsUrl();

      const sidecarEnv = {
        ...(process.env.OPENWORK_DEV_MODE ? { OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE } : {}),
        ...(process.env.OPENWORK_UI_CONTROL_DISCOVERY ? { OPENWORK_UI_CONTROL_DISCOVERY: process.env.OPENWORK_UI_CONTROL_DISCOVERY } : {}),
        OPENWORK_SERVER_URL: serverUrl,
        OPENWORK_SERVER_TOKEN: config.token,
        OPENCODE_CONFIG: runtimeConfigPath,
        OPENCODE_MODELS_URL: opencodeModelsUrl,
      };

      if (requestedAgentId && !isHttpAgent) {
        // ============================================================
        // 非 HTTP agent (ACP/PTY/MCP/Generic)：通过 agent-sidecar 抽象层启动
        // ============================================================
        agentSidecarAdapter = createAdapterForAgent(requestedAgentId, {
          binaryPath: options.opencodeBin || process.env.OPENWORK_OPENCODE_BIN || undefined,
        });

        // 启动前先做 detect，给用户清晰的错误信息
        const detection = await agentSidecarAdapter.detect();
        if (!detection.available) {
          throw new Error(
            `Agent '${requestedAgentId}' is not available: ${detection.error ?? "binary not found in PATH"}.\n`
            + `Install hint: ${agentSidecarAdapter.displayName} — see agent-sidecar/presets.ts`,
          );
        }

        agentSidecarHandle = await agentSidecarAdapter.start({
          cwd,
          excludedPorts: [config.port],
          env: sidecarEnv,
        });

        // 非 HTTP agent 不修改 config.opencodeBaseUrl
        // 后续 session-based API 可通过返回的 agentSidecar handle 接入
      } else {
        // ============================================================
        // HTTP agent (opencode-serve) 或未指定 agentId：走原有 managed-opencode
        // ============================================================
        managedOpencode = await createManagedOpencodeServer({
          bin: options.opencodeBin || process.env.OPENWORK_OPENCODE_BIN,
          cwd,
          excludedPorts: [config.port],
          env: sidecarEnv,
        });

        config.opencodeBaseUrl = managedOpencode.url;
        config.opencodeUsername = managedOpencode.username;
        config.opencodePassword = managedOpencode.password;
        for (const entry of config.workspaces) {
          if (entry.workspaceType === "remote") {
            entry.baseUrl ??= managedOpencode.url;
            entry.opencodeUsername ??= managedOpencode.username;
            entry.opencodePassword ??= managedOpencode.password;
            entry.directory ??= entry.path;
            continue;
          }
          entry.baseUrl = managedOpencode.url;
          entry.opencodeUsername = managedOpencode.username;
          entry.opencodePassword = managedOpencode.password;
          entry.directory = entry.path;
        }
        managedOpencodeIdentity = [
          managedOpencode.pid ?? "unknown",
          managedOpencode.username,
          managedOpencode.password,
        ].join(":");
        registerTrustedOpencodeProcess(config, {
          baseUrl: managedOpencode.url,
          identity: managedOpencodeIdentity,
          isAlive: managedOpencode.isAlive,
        });
      }
    }
  }

  const server = await startServer(config);

  // The runtime config file above only covers workspaces[0]. Push every
  // workspace's runtime-DB MCPs into the engine so they aren't invisible
  // until a manual reload. Best-effort.
  if (managedOpencode) {
    void syncAllWorkspacesRuntimeMcpToEngine(config);
  }

  return {
    port: server.port,
    url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`,
    config,
    managedOpencodeExecution: managedOpencode?.execution ?? null,
    managedOpencode: managedOpencode
      ? { pid: managedOpencode.pid ?? null, isAlive: managedOpencode.isAlive }
      : null,
    agentSidecar: agentSidecarHandle
      ? {
          agentId: agentSidecarHandle.agentId,
          protocol: agentSidecarHandle.protocol,
          transportInfo: agentSidecarHandle.transportInfo,
          pid: agentSidecarHandle.processId ?? null,
          isAlive: agentSidecarHandle.isAlive,
        }
      : null,
    async stop() {
      if (managedOpencodeIdentity) {
        clearTrustedOpencodeProcess(config, managedOpencodeIdentity);
      }
      await managedOpencode?.close();
      if (agentSidecarHandle) {
        await agentSidecarHandle.stop();
      }
      await server.stop();
    },
  };
}
