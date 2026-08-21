/**
 * AgentScanner — Agent 自动检测与进程生命周期管理
 *
 * 设计目标：
 *   1. 启动时自动扫描本机已安装的 CLI agent
 *   2. 周期性后台刷新（可配置间隔，默认 5 分钟）
 *   3. 进程资源管理：所有 spawn 的子进程都有超时保护，用完即释放
 *   4. 不卡顿：扫描在后台异步执行，不阻塞主线程；采用分批并发（每批最多 8 个）
 *   5. 优雅关闭：应用退出时 stop 所有扫描定时器，清理残留进程
 *
 * 资源管理策略：
 *   - 检测阶段：每个 agent 仅 spawn `--version` 或 `models --json` 等短命令（<10s 超时）
 *   - 运行阶段：SidecarProcessPool 管理实际 agent 进程（已有实现）
 *   - 兜底：FinalizationRegistry 检测泄漏，orphan 扫描器定时回收
 */

import { RuntimeRegistry, type RuntimeAgentCapability } from "./runtime-registry.js";
import { invalidateModelCache } from "./agent-sidecar/model-discovery.js";
import type { CliModelInfo } from "./agent-sidecar/cli-adapter/generic-cli.js";

export interface AgentScannerConfig {
  /** 扫描间隔（毫秒），默认 5 分钟 */
  scanIntervalMs?: number;
  /** 后台刷新间隔（毫秒），默认 5 分钟 */
  backgroundRefreshMs?: number;
  /** 模型发现缓存 TTL（毫秒），默认 10 分钟 */
  modelCacheTtlMs?: number;
  /** 单次扫描最大并发（默认 8） */
  scanConcurrency?: number;
  /** 自动启动后台刷新（默认 true） */
  autoStart?: boolean;
}

const DEFAULT_CONFIG: Required<AgentScannerConfig> = {
  scanIntervalMs: 5 * 60_000,
  backgroundRefreshMs: 5 * 60_000,
  modelCacheTtlMs: 10 * 60_000,
  scanConcurrency: 8,
  autoStart: true,
};

export interface AgentScanEvent {
  type: "scan-start" | "scan-complete" | "scan-error" | "model-discovered";
  timestamp: number;
  agentId?: string;
  details?: Record<string, unknown>;
}

export class AgentScanner {
  private readonly config: Required<AgentScannerConfig>;
  private readonly registry: RuntimeRegistry;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private listeners: Array<(event: AgentScanEvent) => void> = [];
  private lastScanAt = 0;
  private scanCount = 0;
  private errorCount = 0;

  constructor(registry: RuntimeRegistry, config: AgentScannerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = registry;
    if (this.config.autoStart) {
      this.start();
    }
  }

  /** 启动扫描定时器 + 注册退出钩子 */
  start(): void {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => {
      void this.runScan().catch(() => {});
    }, this.config.scanIntervalMs);
    if (typeof this.scanTimer.unref === "function") {
      this.scanTimer.unref();
    }
    this.registry.startBackgroundRefresh(this.config.backgroundRefreshMs);
  }

  /** 停止所有定时器 + 清理 */
  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.registry.stopBackgroundRefresh();
  }

  /** 事件订阅 */
  on(listener: (event: AgentScanEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: AgentScanEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 监听器异常不影响其他监听器
      }
    }
  }

  /** 立即执行一次扫描（异步，不阻塞） */
  async runScan(): Promise<RuntimeAgentCapability[]> {
    if (this.scanning) {
      // 已在扫描中，返回缓存
      return this.registry.list();
    }
    this.scanning = true;
    this.emit({ type: "scan-start", timestamp: Date.now() });

    try {
      const capabilities = await this.registry.refresh();
      this.lastScanAt = Date.now();
      this.scanCount++;
      this.emit({
        type: "scan-complete",
        timestamp: Date.now(),
        details: { agentCount: capabilities.length, availableCount: capabilities.filter((c) => c.available).length },
      });
      return capabilities;
    } catch (error) {
      this.errorCount++;
      this.emit({
        type: "scan-error",
        timestamp: Date.now(),
        details: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * 懒发现指定 agent 的模型（在后台扫描完成后按需调用）
   * spawn 一个短进程查询模型 → 解析 → 缓存 → 立即退出
   */
  async discoverModels(agentId: string, forceRefresh = false) {
    const models = await this.registry.discoverAgentModels(agentId, forceRefresh);
    this.emit({
      type: "model-discovered",
      timestamp: Date.now(),
      agentId,
      details: { count: models.length },
    });
    return models;
  }

  /** 一次性发现所有可用 agent 的模型（并发控制） */
  async discoverAllModels(forceRefresh = false): Promise<Record<string, Awaited<ReturnType<RuntimeRegistry["discoverAgentModels"]>>>> {
    const caps = await this.registry.list();
    const available = caps.filter((c) => c.available);

    const results: Record<string, Awaited<ReturnType<RuntimeRegistry["discoverAgentModels"]>>> = {};
    const concurrency = this.config.scanConcurrency;

    for (let i = 0; i < available.length; i += concurrency) {
      const batch = available.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (c) => {
          try {
            const models = await this.discoverModels(c.agentId, forceRefresh);
            return [c.agentId, models] as const;
          } catch {
            return [c.agentId, [] as CliModelInfo[]] as const;
          }
        }),
      );
      for (const [agentId, models] of batchResults) {
        results[agentId] = models;
      }
    }

    return results;
  }

  /** 获取扫描状态（health 检查用） */
  getStatus(): {
    scanning: boolean;
    lastScanAt: number;
    scanCount: number;
    errorCount: number;
    cacheAgeMs: number;
  } {
    const now = Date.now();
    return {
      scanning: this.scanning,
      lastScanAt: this.lastScanAt,
      scanCount: this.scanCount,
      errorCount: this.errorCount,
      cacheAgeMs: this.lastScanAt > 0 ? now - this.lastScanAt : -1,
    };
  }

  /** 失效所有缓存（安装/卸载新 agent 后调用） */
  invalidate(): void {
    this.registry.invalidate();
    invalidateModelCache();
  }
}

/** 全局单例（供 server.ts / Electron 入口复用） */
let globalScanner: AgentScanner | null = null;
let globalRegistry: RuntimeRegistry | null = null;

export function getGlobalAgentScanner(
  registry?: RuntimeRegistry,
  config?: AgentScannerConfig,
): AgentScanner {
  if (!globalScanner) {
    globalRegistry = registry ?? new RuntimeRegistry();
    globalScanner = new AgentScanner(globalRegistry, config);
  } else if (registry && registry !== globalRegistry) {
    // Caller supplied a different registry; rebuild the scanner with it
    globalScanner.stop();
    globalRegistry = registry;
    globalScanner = new AgentScanner(globalRegistry, config);
  }
  return globalScanner;
}

/** 获取全局 scanner 绑定的 registry（供外部共享） */
export function getGlobalScannerRegistry(): RuntimeRegistry | null {
  return globalRegistry;
}

/** 测试/多实例场景下重置全局单例 */
export function resetGlobalAgentScanner(): void {
  if (globalScanner) {
    globalScanner.stop();
    globalScanner = null;
  }
  globalRegistry = null;
}
