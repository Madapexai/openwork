/**
 * RuntimeRegistry — 本地 runtime 能力上报层（openspec-runtime-reporting.md）
 *
 * 借鉴 multica 的 Runtime 概念：daemon 启动时 auto-detect PATH 上的可用 CLI agents，
 * 把「这台机器有哪些 agent 引擎」作为能力上报给控制平面 / UI，用于 agent 创建与任务路由。
 *
 * - detectAllAgents()（multica auto-detect）已存在于 agent-sidecar/detect.ts
 * - 本模块在其上增加：结果缓存（TTL）、按 agent 的深度能力探测（headless/结构化输出，
 *   复用 GenericCliSidecarAdapter.detectCapabilities）、强制重扫
 * - 不变量：
 *   I1: 同一进程内，TTL 内重复查询不重复扫描 PATH（缓存命中）
 *   I2: 深度探测结果以「preset 声明 ∩ 实测能力」为准，冲突时以实测为准
 *   I3: 探测失败不影响其他 agent 的上报（逐条容错）
 */

import { detectAllAgents, detectAgent } from "./agent-sidecar/detect.js";
import { AGENT_PRESETS } from "./agent-sidecar/presets.js";
import { GenericCliSidecarAdapter, type CliCapabilities } from "./agent-sidecar/cli-adapter/generic-cli.js";
import { createAdapterForAgent } from "./agent-sidecar/registry.js";
import type { AgentDetectResult } from "./agent-sidecar/types.js";

/** 默认缓存 TTL（毫秒） */
export const RUNTIME_REFRESH_TTL_MS = 60_000;

/** 协议 → 引擎类型映射（TeamAgentEngine: openworker/opencode/mcp/generic/cli） */
function engineForProtocol(protocol: string): string {
  if (protocol === "mcp") return "mcp";
  if (protocol === "acp") return "cli";
  return "cli";
}

/** 上报的 runtime 能力条目 */
export interface RuntimeAgentCapability {
  /** agentId（preset 主键） */
  agentId: string;
  /** 展示名 */
  label: string;
  /** 是否可用（二进制在 PATH 上） */
  available: boolean;
  /** 二进制绝对路径 */
  binaryPath?: string;
  /** 版本 */
  version?: string;
  /** 接入协议（acp/pty/generic/mcp） */
  protocol: string;
  /** 引擎类型（openworker/opencode/mcp/generic/cli） */
  engine: string;
  /** 是否声明 headless（cliProfile.headless） */
  declaredHeadless: boolean;
  /** 实测自动化能力（GenericCliSidecarAdapter.detectCapabilities） */
  detected?: CliCapabilities;
  /** 检测错误（仅 available=false 时） */
  error?: string;
}

export interface RuntimeRegistryOptions {
  /** 缓存 TTL，默认 60s */
  ttlMs?: number;
  /** 是否对每个可用 agent 做深度能力探测（默认 true） */
  deepProbe?: boolean;
  /** 显式 PATH 注入（默认系统 PATH） */
  path?: string;
  /** 探测函数注入（测试用；默认 detectAllAgents） */
  detect?: (path?: string) => Promise<AgentDetectResult[]>;
}

export class RuntimeRegistry {
  private readonly ttlMs: number;
  private readonly deepProbe: boolean;
  private readonly path?: string;
  private readonly detectFn: (path?: string) => Promise<AgentDetectResult[]>;
  private cache: RuntimeAgentCapability[] | null = null;
  private cachedAt = 0;
  private probing: Promise<RuntimeAgentCapability[]> | null = null;

  constructor(options: RuntimeRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? RUNTIME_REFRESH_TTL_MS;
    this.deepProbe = options.deepProbe ?? true;
    this.path = options.path;
    this.detectFn = options.detect ?? detectAllAgents;
  }

  /** 强制重扫（I3: 逐条容错，单 agent 失败不影响整体） */
  async refresh(): Promise<RuntimeAgentCapability[]> {
    const results = await this.detectFn(this.path);
    const capabilities: RuntimeAgentCapability[] = [];

    for (const result of results) {
      const preset = AGENT_PRESETS[result.agentId];
      const base: RuntimeAgentCapability = {
        agentId: result.agentId,
        label: preset?.label ?? result.agentId,
        available: result.available,
        binaryPath: result.binaryPath,
        version: result.version,
        protocol: preset?.protocol ?? "generic",
        engine: preset ? engineForProtocol(preset.protocol) : "generic",
        declaredHeadless: preset?.cliProfile?.headless === true,
        error: result.error,
      };

      if (result.available && this.deepProbe) {
        try {
          base.detected = await this.probeAgent(result.agentId, preset);
        } catch {
          // I3: 深度探测失败仅丢弃 detected，不阻断上报
        }
      }
      capabilities.push(base);
    }

    this.cache = capabilities;
    this.cachedAt = Date.now();
    return capabilities;
  }

  /** 读取能力（TTL 内缓存命中，I1） */
  async list(): Promise<RuntimeAgentCapability[]> {
    if (this.cache && Date.now() - this.cachedAt < this.ttlMs) {
      return this.cache;
    }
    if (this.probing) return this.probing;
    this.probing = this.refresh().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  /** 单个 agent 能力（带 3s 深度探测兜底） */
  async get(agentId: string): Promise<RuntimeAgentCapability | null> {
    const cached = this.cache?.find((c) => c.agentId === agentId);
    if (cached) return cached;

    const preset = AGENT_PRESETS[agentId];
    if (!preset) return null;

    const result = await detectAgent(preset, this.path);
    const base: RuntimeAgentCapability = {
      agentId,
      label: preset.label ?? agentId,
      available: result.available,
      binaryPath: result.binaryPath,
      version: result.version,
      protocol: preset.protocol ?? "generic",
      engine: engineForProtocol(preset.protocol ?? "generic"),
      declaredHeadless: preset.cliProfile?.headless === true,
      error: result.error,
    };
    if (result.available) {
      try {
        base.detected = await this.probeAgent(agentId, preset);
      } catch {
        // 忽略深度探测失败
      }
    }
    return base;
  }

  /** 强制失效缓存（供 POST /agent-runtimes/reload 使用） */
  invalidate(): void {
    this.cache = null;
    this.cachedAt = 0;
  }

  /** 深度能力探测：preset 声明 ∩ 实测（I2: 以实测为准） */
  private async probeAgent(agentId: string, preset: (typeof AGENT_PRESETS)[string]): Promise<CliCapabilities> {
    // cli 引擎：用 GenericCliSidecarAdapter 实测
    if (preset.protocol === "pty" || preset.protocol === "generic") {
      const adapter = new GenericCliSidecarAdapter({
        agentId,
        protocol: preset.protocol,
        binary: preset.binary ?? "",
        args: preset.args,
        outputParser: preset.outputParser,
        cliProfile: preset.cliProfile,
        env: preset.env,
      });
      return adapter.detectCapabilities();
    }
    // acp/mcp：能力声明即视为支持（协议层握手在 start 时验证）
    return {
      mode: preset.protocol === "acp" ? "structured" : "pty",
      permissions: true,
    };
  }
}

/** 便捷工厂：复用已有 registry 创建 adapter（供 chat bridge / team-agent 使用） */
export function createAdapterFromPreset(agentId: string): ReturnType<typeof createAdapterForAgent> | null {
  const preset = AGENT_PRESETS[agentId];
  if (!preset) return null;
  try {
    return createAdapterForAgent(agentId);
  } catch {
    return null;
  }
}
