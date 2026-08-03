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
import { getPreset } from "./presets.js";

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

/**
 * 工厂函数：根据 agentId 创建 adapter（自动从 preset 加载配置）
 */
export function createAdapterForAgent(agentId: string, overrides?: Partial<AgentSidecarConfig>): AgentSidecarAdapter {
  const preset = getPreset(agentId);
  const config: AgentSidecarConfig = {
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
    ...overrides,
  };
  return createAdapter(config);
}
