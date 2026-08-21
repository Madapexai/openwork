/**
 * SidecarProcessPool - 全局 sidecar 进程池 & 资源控制器
 *
 * 设计目标（直接响应用户反馈：PTY 进程太多、不释放、卡死电脑）：
 *  1. 全局并发上限：同一时刻 sidecar spawn 的 PTY/ACP 子进程不超过配额，
 *     超上限的 acquire() 排队等待 release() 后唤醒。
 *  2. 进程复用（LRU idle）：对 ACP / HTTP server 模式，按 (agentId, cwd, args) 做
 *     进程句柄缓存，release() 后进入 idle 态，下次 acquire() 直接复用。
 *  3. 空闲超时回收：idle 超过 preset.idleTimeoutMs（默认 60s）自动 SIGTERM →
 *     5s 宽限期 → SIGKILL 兜底强制释放，避免"挂起的孤儿进程"。
 *  4. FinalizationRegistry 泄漏检测：如果上层忘记 stop()（句柄被 GC），
 *     由 FR 回调触发强制回收 + 指标记录 leak 计数。
 *  5. 指标：active / idle / queued / spawned / leaked / forceKilled 六项计数，
 *     供 doctor / healthz / Prometheus 风格接口导出。
 *
 * 借鉴设计：
 *  - orca worktree 隔离器的资源配额语义
 *  - paperclip 的 ProcessSupervisor（orphan reaper + heartbeat watcher）
 *  - multica 的 connection pool（per-agent LRU cache + backpressure queue）
 *
 * 使用方式：
 *   const pool = getGlobalSidecarPool({ ptyConcurrency: 3, acpConcurrency: 2 });
 *   const handle = await pool.acquire(adapter, startOpts, { keyFn });
 *   // ... use handle ...
 *   await pool.release(handle);
 */

import type { AgentSidecarAdapter, SidecarHandle, SidecarStartOptions } from "./types.js";

// ---------- 配置 ----------

export interface SidecarPoolConfig {
  /** PTY 协议全局并发上限（默认 3，保守避免爆内存/CPU） */
  ptyConcurrency?: number;
  /** ACP 协议全局并发上限（默认 2，ACP 进程重一些） */
  acpConcurrency?: number;
  /** Generic 协议并发上限（默认 4，轻量脚本） */
  genericConcurrency?: number;
  /** MCP 协议并发上限（默认 2） */
  mcpConcurrency?: number;
  /** HTTP 服务端每 agentId 允许的实例数（默认 1，单例长连接） */
  httpPerAgentConcurrency?: number;
  /** idle 回收的最小宽限时间（毫秒），默认 60_000 */
  minIdleTimeoutMs?: number;
  /** idle 回收最大宽限时间（毫秒），默认 10 * 60_000 */
  maxIdleTimeoutMs?: number;
  /** stop() 时 SIGTERM → SIGKILL 兜底的等待毫秒，默认 5000 */
  forceKillGraceMs?: number;
  /** 孤儿/泄漏扫描周期（毫秒），默认 30_000 */
  orphanScanIntervalMs?: number;
}

export const DEFAULT_POOL_CONFIG: Required<SidecarPoolConfig> = {
  ptyConcurrency: 3,
  acpConcurrency: 2,
  genericConcurrency: 4,
  mcpConcurrency: 2,
  httpPerAgentConcurrency: 1,
  minIdleTimeoutMs: 60_000,
  maxIdleTimeoutMs: 10 * 60_000,
  forceKillGraceMs: 5_000,
  orphanScanIntervalMs: 30_000,
};

// ---------- 指标 ----------

export interface SidecarPoolMetrics {
  /** 当前正在使用（acquire 未 release）的句柄数 */
  readonly active: number;
  /** 当前空闲等待复用的句柄数 */
  readonly idle: number;
  /** 排队等待配额的 acquire 数量 */
  readonly queued: number;
  /** 历史累计 spawn 次数 */
  readonly spawned: number;
  /** FinalizationRegistry 触发的泄漏回收次数 */
  readonly leaked: number;
  /** 超过宽限期被 SIGKILL 强杀的次数 */
  readonly forceKilled: number;
  /** 复用命中（从 idle 取回）次数 */
  readonly reused: number;
}

// ---------- 池化句柄 ----------

/** 由池返回的包装句柄 */
export interface PooledSidecarHandle {
  /** 内部 sidecar 句柄 */
  readonly inner: SidecarHandle;
  /** 关联 adapter */
  readonly adapter: AgentSidecarAdapter;
  /** 池内唯一 key（LRU / 复用判定） */
  readonly key: string;
  /** 创建/复用时间戳 */
  readonly acquiredAt: number;
  /** 调用方在使用完时必须 await pool.release(this)，不要手动调 inner.stop() */
}

interface IdleEntry {
  handle: SidecarHandle;
  adapter: AgentSidecarAdapter;
  key: string;
  idleSince: number;
  idleTimeoutMs: number;
  /** 启动时传的 startOpts 快照（复用前校验 cwd 等） */
  startOpts: SidecarStartOptions;
  /** 当前复用代数，每被 reuse 一次 +1 */
  generation: number;
}

interface Waiter {
  key: string;
  protocol: string;
  agentId: string;
  resolve: (value: PooledSidecarHandle | PromiseLike<PooledSidecarHandle>) => void;
  reject: (reason: unknown) => void;
}

// ---------- 池实现 ----------

export class SidecarProcessPool {
  private readonly cfg: Required<SidecarPoolConfig>;

  private readonly activeSet = new Set<string>();
  private readonly idleList: IdleEntry[] = []; // 尾进头出，LRU

  private readonly queue: Waiter[] = [];

  private _metrics: SidecarPoolMetrics = {
    active: 0,
    idle: 0,
    queued: 0,
    spawned: 0,
    leaked: 0,
    forceKilled: 0,
    reused: 0,
  };

  /** 按 protocol 的活跃计数（只含 spawn 的本地进程，不含已存在的 HTTP remote） */
  private readonly activeByProtocol = new Map<string, number>();
  /** HTTP agentId 级别活跃计数 */
  private readonly activeByHttpAgent = new Map<string, number>();

  private readonly registry: FinalizationRegistry<IdleEntry | { handle: SidecarHandle; adapter: AgentSidecarAdapter; key: string }>;
  private readonly orphanTimer: ReturnType<typeof setInterval>;

  private disposed = false;

  constructor(config: SidecarPoolConfig = {}) {
    this.cfg = { ...DEFAULT_POOL_CONFIG, ...config };
    this.registry = new FinalizationRegistry((held) => {
      this._metrics = { ...this._metrics, leaked: this._metrics.leaked + 1 };
      const handle = held.handle;
      const adapter = held.adapter;
      void this.forceStop(handle, adapter, "finalization-gc");
    });
    this.orphanTimer = setInterval(() => this.reapIdleAndOrphans(), this.cfg.orphanScanIntervalMs);
    // 避免定时器保活进程（测试/脚本退出）
    if (typeof this.orphanTimer.unref === "function") this.orphanTimer.unref();
  }

  /** 获取快照式指标 */
  get metrics(): SidecarPoolMetrics {
    return { ...this._metrics };
  }

  get config(): Required<SidecarPoolConfig> {
    return this.cfg;
  }

  /**
   * 获取池化句柄。优先 idle 复用，否则排队等配额 + spawn。
   *
   * @param adapter   要启动的 adapter 实例
   * @param startOpts start() 选项（含 cwd / env / path / idleTimeoutMs 覆盖）
   * @param opts.keyFn 自定义 key 生成器；默认 (agentId + protocol + args + cwd)
   */
  async acquire(
    adapter: AgentSidecarAdapter,
    startOpts: SidecarStartOptions,
    opts?: { keyFn?: (adapter: AgentSidecarAdapter, startOpts: SidecarStartOptions) => string },
  ): Promise<PooledSidecarHandle> {
    if (this.disposed) throw new Error("SidecarProcessPool is disposed");
    const key = opts?.keyFn ? opts.keyFn(adapter, startOpts) : this.defaultKey(adapter, startOpts);
    const protocol = adapter.protocol;

    // 1) 优先从 idle 列表命中（key 必须匹配）
    const reuseIdx = this.idleList.findIndex((e) => e.key === key && e.handle.isAlive());
    if (reuseIdx >= 0) {
      const entry = this.idleList.splice(reuseIdx, 1)[0];
      this.moveToActive(entry.key);
      this._metrics = {
        ...this._metrics,
        reused: this._metrics.reused + 1,
        active: this.activeSet.size,
        idle: this.idleList.length,
      };
      const pooled: PooledSidecarHandle = {
        inner: entry.handle,
        adapter,
        key: entry.key,
        acquiredAt: Date.now(),
      };
      this.registry.register(pooled, entry, pooled);
      return pooled;
    }

    // 2) 配额检查：不满足就排队
    const canStartNow = this.hasQuota(protocol, adapter.agentId);
    if (!canStartNow) {
      return new Promise<PooledSidecarHandle>((resolve, reject) => {
        this.queue.push({ key, protocol, agentId: adapter.agentId, resolve, reject });
        this._metrics = { ...this._metrics, queued: this.queue.length };
      }).then(async (pooled) => {
        // 被唤醒后，再走一次 spawn 路径（此时应已有配额）
        if (pooled.inner) return pooled;
        return this.doSpawnAndRegister(adapter, startOpts, key);
      });
    }

    // 3) 直接 spawn
    return this.doSpawnAndRegister(adapter, startOpts, key);
  }

  /**
   * 归还句柄。默认流程：
   *   - HTTP server / ACP 多会话 agent：进入 idle 等待复用；
   *   - PTY headless 一次性 / generic 短进程：立即 stop（不留 idle）。
   *  可通过 `{ evict: true }` 强制立即销毁。
   */
  async release(handle: PooledSidecarHandle, options?: { evict?: boolean }): Promise<void> {
    if (this.disposed) return;
    this.registry.unregister(handle);

    const { inner, adapter, key } = handle;
    const evict = !!options?.evict;

    // 先从 active 移除
    this.activeSet.delete(key);
    this.decrementProtocol(adapter.protocol, adapter.agentId);

    // stop 策略
    const shouldEvict = evict || !this.isReusableProtocol(adapter.protocol);
    if (shouldEvict || !inner.isAlive()) {
      await this.softStop(inner, adapter, "release-evict");
      this._metrics = { ...this._metrics, active: this.activeSet.size, idle: this.idleList.length };
      this.drainQueue();
      return;
    }

    // 进入 idle
    const idleTimeoutMs = this.resolveIdleTimeout(adapter);
    this.idleList.push({
      handle: inner,
      adapter,
      key,
      idleSince: Date.now(),
      idleTimeoutMs,
      startOpts: { cwd: "", ...{} },
      generation: 0,
    });
    this._metrics = { ...this._metrics, active: this.activeSet.size, idle: this.idleList.length };
    this.drainQueue();
  }

  /**
   * 显式驱逐指定 agentId / protocol 的所有 idle 句柄。
   * 用于"用户改了配置希望所有相关 agent 重启"场景。
   */
  async evict(predicate?: (entry: IdleEntry) => boolean): Promise<number> {
    const victims: IdleEntry[] = [];
    for (let i = this.idleList.length - 1; i >= 0; i--) {
      const e = this.idleList[i];
      if (!predicate || predicate(e)) {
        this.idleList.splice(i, 1);
        victims.push(e);
      }
    }
    await Promise.all(victims.map((v) => this.softStop(v.handle, v.adapter, "evict")));
    this._metrics = { ...this._metrics, idle: this.idleList.length };
    return victims.length;
  }

  /** 销毁整个池（进程退出前调用）：stop 所有 idle/active，清理定时器 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.orphanTimer);
    const allIdle = this.idleList.splice(0, this.idleList.length);
    // active: 尽力而为 stop（如果上层泄漏了，这里兜底）
    const stops: Promise<void>[] = [];
    for (const e of allIdle) stops.push(this.softStop(e.handle, e.adapter, "pool-dispose"));
    await Promise.allSettled(stops);
    this.activeSet.clear();
    this.activeByProtocol.clear();
    this.activeByHttpAgent.clear();
    this.queue.length = 0;
    this._metrics = { ...this._metrics, active: 0, idle: 0, queued: 0 };
  }

  // ---------- 内部 ----------

  private defaultKey(adapter: AgentSidecarAdapter, startOpts: SidecarStartOptions): string {
    // 规范化 args：空数组也参与 hash，避免不同 args 串用同一个进程
    const argsHash = (adapter as unknown as { config?: { args?: string[] } }).config?.args?.join(" ") ?? "";
    return [adapter.protocol, adapter.agentId, startOpts.cwd ?? "", argsHash].join("|");
  }

  private hasQuota(protocol: string, agentId: string): boolean {
    if (protocol === "pty") return (this.activeByProtocol.get("pty") ?? 0) < this.cfg.ptyConcurrency;
    if (protocol === "acp") return (this.activeByProtocol.get("acp") ?? 0) < this.cfg.acpConcurrency;
    if (protocol === "generic") return (this.activeByProtocol.get("generic") ?? 0) < this.cfg.genericConcurrency;
    if (protocol === "mcp") return (this.activeByProtocol.get("mcp") ?? 0) < this.cfg.mcpConcurrency;
    if (protocol === "http") {
      // HTTP: 每 agentId 限制 + 全局协议限制走 HTTP 并发（默认每个 agent 1）
      const perAgent = this.activeByHttpAgent.get(agentId) ?? 0;
      if (perAgent >= this.cfg.httpPerAgentConcurrency) return false;
      return true;
    }
    return true;
  }

  private incrementProtocol(protocol: string, agentId: string) {
    if (protocol === "http") {
      this.activeByHttpAgent.set(agentId, (this.activeByHttpAgent.get(agentId) ?? 0) + 1);
    }
    this.activeByProtocol.set(protocol, (this.activeByProtocol.get(protocol) ?? 0) + 1);
  }

  private decrementProtocol(protocol: string, agentId: string) {
    if (protocol === "http") {
      const cur = this.activeByHttpAgent.get(agentId) ?? 0;
      if (cur > 1) this.activeByHttpAgent.set(agentId, cur - 1);
      else this.activeByHttpAgent.delete(agentId);
    }
    const cur = this.activeByProtocol.get(protocol) ?? 0;
    if (cur > 1) this.activeByProtocol.set(protocol, cur - 1);
    else this.activeByProtocol.delete(protocol);
  }

  private moveToActive(key: string) {
    this.activeSet.add(key);
    this._metrics = { ...this._metrics, active: this.activeSet.size, idle: this.idleList.length };
  }

  private isReusableProtocol(protocol: string): boolean {
    // ACP: 多会话，单进程可复用于多次 session/prompt → 复用
    // HTTP: 单例 server → 复用
    // MCP: stdio server → 复用
    // PTY / generic: 都是一次性 prompt → 不复用（避免"用户交互状态残留" + 进程泄漏概率），
    //   除非后续明确声明 cliProfile.reusable = true。这里保守策略：不做 idle 复用。
    return protocol === "acp" || protocol === "http" || protocol === "mcp";
  }

  private resolveIdleTimeout(adapter: AgentSidecarAdapter): number {
    const fromAdapter = (adapter as unknown as { config?: { idleTimeoutMs?: number } }).config?.idleTimeoutMs ?? 0;
    const t = fromAdapter > 0 ? fromAdapter : this.cfg.minIdleTimeoutMs;
    return Math.min(this.cfg.maxIdleTimeoutMs, Math.max(this.cfg.minIdleTimeoutMs, t));
  }

  private async doSpawnAndRegister(
    adapter: AgentSidecarAdapter,
    startOpts: SidecarStartOptions,
    key: string,
  ): Promise<PooledSidecarHandle> {
    // 再次校验配额（排队被唤醒的路径也会走这里）
    while (!this.hasQuota(adapter.protocol, adapter.agentId)) {
      await new Promise<void>((resolve) => {
        // 再次进队列；外层已把 waiter 挂上，这里应该不会触发。仅做保险。
        this.queue.push({
          key,
          protocol: adapter.protocol,
          agentId: adapter.agentId,
          resolve: () => resolve(),
          reject: (e) => {
            void e;
            resolve();
          },
        });
        this._metrics = { ...this._metrics, queued: this.queue.length };
      });
    }

    this.incrementProtocol(adapter.protocol, adapter.agentId);
    let handle: SidecarHandle;
    try {
      handle = await adapter.start(startOpts);
    } catch (err) {
      this.decrementProtocol(adapter.protocol, adapter.agentId);
      this.drainQueue();
      throw err;
    }

    this._metrics = { ...this._metrics, spawned: this._metrics.spawned + 1 };
    this.moveToActive(key);

    const pooled: PooledSidecarHandle = { inner: handle, adapter, key, acquiredAt: Date.now() };
    this.registry.register(pooled, { handle, adapter, key }, pooled);
    return pooled;
  }

  private drainQueue() {
    while (this.queue.length > 0) {
      const w = this.queue[0];
      if (!this.hasQuota(w.protocol, w.agentId)) break;
      this.queue.shift();
      this._metrics = { ...this._metrics, queued: this.queue.length };
      // 唤醒：外层 waiter 的 resolve 会让 acquire() 再走 doSpawnAndRegister（此时配额已 OK）
      w.resolve({} as PooledSidecarHandle);
    }
  }

  private async softStop(handle: SidecarHandle, adapter: AgentSidecarAdapter, reason: string): Promise<void> {
    void reason;
    if (!handle.isAlive()) return;
    try {
      await Promise.race([
        handle.stop(),
        new Promise<void>((r) => setTimeout(r, this.cfg.forceKillGraceMs)),
      ]);
      if (!handle.isAlive()) return;
    } catch {
      // ignore: 走 forceStop
    }
    await this.forceStop(handle, adapter, "soft-stop-failed");
  }

  private async forceStop(handle: SidecarHandle, adapter: AgentSidecarAdapter, reason: string): Promise<void> {
    void adapter;
    void reason;
    const pid = handle.processId;
    // 先尝试 stop()
    let stopped = false;
    try {
      await Promise.race([
        handle.stop(),
        new Promise<void>((r) => setTimeout(r, this.cfg.forceKillGraceMs)),
      ]);
      if (!handle.isAlive()) stopped = true;
    } catch {
      // ignore
    }
    if (!stopped && typeof pid === "number") {
      // 兜底：unix SIGKILL（macOS/Linux），Windows 下 process.kill(pid, 9) 也可用
      try {
        process.kill(pid, "SIGKILL");
        this._metrics = { ...this._metrics, forceKilled: this._metrics.forceKilled + 1 };
      } catch {
        // 可能进程已经死了
      }
    } else if (!stopped) {
      this._metrics = { ...this._metrics, forceKilled: this._metrics.forceKilled + 1 };
    }
  }

  private reapIdleAndOrphans() {
    if (this.disposed) return;
    const now = Date.now();
    const expiredIdx: number[] = [];
    for (let i = 0; i < this.idleList.length; i++) {
      const e = this.idleList[i];
      const alive = e.handle.isAlive();
      const idleMs = now - e.idleSince;
      if (!alive || idleMs > e.idleTimeoutMs) expiredIdx.push(i);
    }
    if (expiredIdx.length === 0) return;
    // 倒序删除 + stop
    (async () => {
      for (let i = expiredIdx.length - 1; i >= 0; i--) {
        const idx = expiredIdx[i];
        const entry = this.idleList[idx];
        if (!entry) continue;
        this.idleList.splice(idx, 1);
        this.decrementProtocol(entry.adapter.protocol, entry.adapter.agentId);
        await this.softStop(entry.handle, entry.adapter, "idle-timeout");
      }
      this._metrics = { ...this._metrics, idle: this.idleList.length };
    })().catch(() => {
      /* swallow */
    });
  }

  /** 只读指标快照（供 smoke test / 监控 / 诊断使用） */
  getMetrics(): SidecarPoolMetrics {
    return { ...this._metrics, active: this.activeSet.size, idle: this.idleList.length, queued: this.queue.length };
  }
}

// ---------- 全局单例访问 ----------

let _globalPool: SidecarProcessPool | null = null;

export function getGlobalSidecarPool(config?: SidecarPoolConfig): SidecarProcessPool {
  if (!_globalPool) _globalPool = new SidecarProcessPool(config);
  return _globalPool;
}

export function resetGlobalSidecarPool(newConfig?: SidecarPoolConfig): SidecarProcessPool {
  void _globalPool?.dispose().catch(() => {});
  _globalPool = new SidecarProcessPool(newConfig);
  return _globalPool;
}
