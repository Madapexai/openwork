/**
 * AgentSidecar 模块入口
 *
 * 设计参考：
 * - cc-connect: 模块加载时注册内置 adapter（init pattern）
 * - paperclip: Mutable Adapter Registry，运行时可扩展
 *
 * 使用示例：
 * ```ts
 * import { createAdapterForAgent } from "./agent-sidecar/index.js";
 *
 * const adapter = createAdapterForAgent("kimi");
 * const handle = await adapter.start({ cwd: "/workspace" });
 * console.log(handle.transportInfo);
 * await handle.stop();
 * ```
 */

import { AcpSidecarAdapter } from "./adapters/acp.js";
import { GenericSidecarAdapter } from "./adapters/generic.js";
import { McpSidecarAdapter } from "./adapters/mcp.js";
import { OpenCodeSidecarAdapter } from "./adapters/opencode.js";
import { PtySidecarAdapter } from "./adapters/pty.js";
import { DEFAULT_AGENT_ID, getPreset, listPresets } from "./presets.js";
import { registerAdapter, unregisterAdapter, listRegisteredProtocols, createAdapter, createAdapterForAgent } from "./registry.js";
import type { AgentSidecarAdapter, AgentSidecarConfig, SidecarProtocol } from "./types.js";
import { detectAgent, detectAllAgents, listAvailableAgents, resolveCleanPath, findBinaryInPath, getAgentVersion, getBinaryDir } from "./detect.js";

// ============================================================
// 内置 adapter 自动注册（借鉴 cc-connect init() pattern）
// ============================================================

let initialized = false;

/**
 * 注册内置 adapter
 *
 * 幂等：每次调用都把 5 个协议的工厂函数重置为内置实现。
 * 这确保测试中即使 unregisterAdapter 干扰了状态，也能通过再次调用恢复。
 */
export function registerBuiltinAdapters(): void {
  registerAdapter("acp", (config) => new AcpSidecarAdapter(config));
  registerAdapter("http", (config) => new OpenCodeSidecarAdapter(config));
  registerAdapter("pty", (config) => new PtySidecarAdapter(config));
  registerAdapter("mcp", (config) => new McpSidecarAdapter(config));
  registerAdapter("generic", (config) => new GenericSidecarAdapter(config));
  initialized = true;
}

/** 是否已初始化（用于测试断言） */
export function isBuiltinAdaptersRegistered(): boolean {
  return initialized;
}

// 模块加载时自动注册（导入即生效）
registerBuiltinAdapters();

// ============================================================
// 公共 API 导出
// ============================================================

export type {
  AgentSidecarAdapter,
  AgentSidecarConfig,
  SidecarProtocol,
  SidecarHandle,
  SidecarStartOptions,
  SidecarCapabilities,
  AgentDetectResult,
  AgentDoctorInfo,
  TransportInfo,
  AgentMessage,
  AgentEvent,
  SessionHandle,
  AdapterFactory,
} from "./types.js";

export {
  AGENT_PRESETS,
  DEFAULT_AGENT_ID,
  getPreset,
  listPresets,
  type AgentPreset,
} from "./presets.js";

export {
  registerAdapter,
  unregisterAdapter,
  listRegisteredProtocols,
  createAdapter,
  createAdapterForAgent,
} from "./registry.js";

export {
  detectAgent,
  detectAllAgents,
  listAvailableAgents,
  resolveCleanPath,
  findBinaryInPath,
  getAgentVersion,
  getBinaryDir,
} from "./detect.js";

export { AcpSidecarAdapter } from "./adapters/acp.js";
export { OpenCodeSidecarAdapter } from "./adapters/opencode.js";
export { PtySidecarAdapter } from "./adapters/pty.js";
export { McpSidecarAdapter } from "./adapters/mcp.js";
export { GenericSidecarAdapter } from "./adapters/generic.js";
export { BaseSidecarAdapter } from "./adapters/base.js";
export {
  GenericCliSidecarAdapter,
  detectCliCapabilities,
  CliAgentUnsupportedError,
  type CliCapabilities,
  type CliAutomationMode,
  type CliExecOptions,
} from "./cli-adapter/generic-cli.js";

// Re-export for convenience (for tests and external usage)
export type { AgentSidecarAdapter as Adapter };
