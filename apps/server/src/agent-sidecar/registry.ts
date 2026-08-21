/**
 * AgentSidecar Registry
 *
 * 借鉴 paperclip 的 Mutable Adapter Registry：
 * - registerAdapter(protocol, factory) 运行时注册
 * - unregisterAdapter(protocol) 卸载
 * - createAdapter(config) 工厂函数
 *
 * 借鉴 cc-connect 的 init() pattern：
 * - 内置 adapter 在模块加载时自动注册
 * - 外部 plugin 可调用 registerAdapter 扩展
 */

import type { AgentSidecarAdapter, AgentSidecarConfig, AdapterFactory, SidecarProtocol } from "./types.js";
import { resolveExecutionMode, selectPresetForAgent, type AgentPreset, type PtyExecutionMode } from "./presets.js";
import type { PtySidecarAdapter } from "./adapters/pty.js";

const registry = new Map<SidecarProtocol, AdapterFactory>();

/**
 * 注册一个 adapter 工厂
 */
export function registerAdapter(protocol: SidecarProtocol, factory: AdapterFactory): void {
  registry.set(protocol, factory);
}

/**
 * 卸载一个 adapter 工厂
 */
export function unregisterAdapter(protocol: SidecarProtocol): void {
  registry.delete(protocol);
}

/**
 * 列出已注册的协议
 */
export function listRegisteredProtocols(): SidecarProtocol[] {
  return Array.from(registry.keys());
}

/**
 * 工厂函数：根据 config 创建 adapter
 *
 * 优先使用 config.protocol 找已注册的 factory；
 * 如果没有，抛错并列出可用协议。
 */
export function createAdapter(config: AgentSidecarConfig): AgentSidecarAdapter {
  const factory = registry.get(config.protocol);
  if (!factory) {
    throw new Error(
      `No adapter registered for protocol '${config.protocol}'. Registered: ${listRegisteredProtocols().join(", ") || "(none)"}`,
    );
  }
  return factory(config);
}

export interface CreateAdapterForAgentOptions {
  /** 用户显式强制 protocol */
  protocol?: SidecarProtocol;
  /** 用户显式强制 PTY 执行模式 */
  executionMode?: PtyExecutionMode;
  /** 用户覆盖协议优先级顺序 */
  preferProtocolOrder?: Array<SidecarProtocol | "headless-oneshot">;
  /** 额外的 AgentSidecarConfig 覆盖（env/args/binaryPath/timeout/cwd 等） */
  overrides?: Partial<AgentSidecarConfig>;
}

/**
 * 工厂函数：根据 agentId 创建 adapter（自动从 preset 加载 + 协议优选）
 *
 * 【长连接优先策略】：
 *   优先走 preset.preferProtocolOrder / 默认：acp > http > headless-oneshot > pty
 *   - ACP/HTTP：单进程复用 + 多会话 → 进入 SidecarProcessPool 做 idle 缓存 + 配额
 *   - headless-oneshot：PTY 一次性短进程（用完 exit，0 泄漏）
 *   - pty (persistent)：最后兜底，强制进入进程池（默认上限 3），防爆炸
 */
export function createAdapterForAgent(
  agentId: string,
  options: CreateAdapterForAgentOptions = {},
): AgentSidecarAdapter & { selectedPreset: AgentPreset; resolvedExecutionMode: PtyExecutionMode } {
  const preset = selectPresetForAgent(agentId, {
    protocol: options.protocol,
    executionMode: options.executionMode,
    preferProtocolOrder: options.preferProtocolOrder,
  });
  const resolvedExecutionMode = resolveExecutionMode(preset);
  const config: AgentSidecarConfig & { cliProfile?: AgentSidecarConfig["cliProfile"] } = {
    agentId: preset.agentId,
    protocol: preset.protocol,
    binary: preset.binary,
    binaryPath: preset.binaryPath,
    args: preset.args,
    env: preset.env,
    capabilities: preset.capabilities,
    cwd: preset.cwd,
    startupTimeoutMs: preset.startupTimeoutMs,
    idleTimeoutMs: preset.idleTimeoutMs,
    commandTemplate: preset.commandTemplate,
    outputParser: preset.outputParser,
    outputPattern: preset.outputPattern,
    displayName: preset.label,
    disabled: preset.disabled,
    cliProfile: preset.cliProfile,
    ...options.overrides,
  };
  const adapter = createAdapter(config) as AgentSidecarAdapter & {
    selectedPreset: AgentPreset;
    resolvedExecutionMode: PtyExecutionMode;
    executionMode?: PtyExecutionMode;
  };
  adapter.selectedPreset = preset;
  adapter.resolvedExecutionMode = resolvedExecutionMode;
  if (preset.protocol === "pty") {
    (adapter as unknown as PtySidecarAdapter).executionMode = resolvedExecutionMode;
  }
  return adapter;
}

