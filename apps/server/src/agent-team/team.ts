/**
 * AgentTeam - 团队编排实现（v2 增强版）
 *
 * 增强能力（对比 v1）：
 * - Worktree 隔离：每个 agent 独立 git worktree，防止文件冲突
 * - 消息总线：agent 间直接通信（direct/broadcast/system）
 * - Supervisor：LLM 驱动的智能任务分解与路由
 * - 进程池集成：通过 SidecarProcessPool 管理并发与资源
 * - 成本-效率路由：按角色分配不同模型，优化成本效益
 * - Kill-switch：单个 agent 失控可独立 kill
 *
 * 设计参考：
 * - multica: team lifecycle + task assignment
 * - orca: worktree 隔离 + 并行开发
 * - LobeHub: Supervisor + Group Chat
 * - Cursor 2.0: Plan Mode + Sub-agents
 */

import type { AgentEvent, SidecarHandle, SidecarStartOptions } from "../agent-sidecar/types.js";
import type {
  AgentTeamConfig,
  AgentTeamHandle,
  AgentTeamMember,
  FanOutInput,
  RelayInput,
  TeamEvent,
  TeamTask,
  DispatchPolicy,
} from "./types.js";
import { selectMember } from "./dispatch.js";
import { broadcastToAll, fanOut, relayChain } from "./relay.js";
import { runAgentPrompt } from "./agent-runner.js";
import { WorktreeManager } from "./worktree-manager.js";
import { TeamMessageBus } from "./message-bus.js";
import { Supervisor, type SupervisorConfig, type SubTaskAssignment } from "./supervisor.js";
import { CostEfficiencyRouter } from "./cost-efficiency-router.js";
import { getGlobalSidecarPool } from "../agent-sidecar/sidecar-pool.js";

export class AgentTeamHandleImpl implements AgentTeamHandle {
  readonly teamId: string;
  readonly members: ReadonlyArray<AgentTeamMember>;
  readonly config: AgentTeamConfig;
  private readonly startOptionsBase: Pick<SidecarStartOptions, "cwd" | "env" | "path">;

  // ===== 新增组件 =====
  private readonly worktreeManager: WorktreeManager;
  private readonly messageBus: TeamMessageBus;
  private readonly costRouter: CostEfficiencyRouter;
  private supervisor: Supervisor | null = null;
  private activeTasks = new Set<string>();

  constructor(config: AgentTeamConfig, baseOptions: Pick<SidecarStartOptions, "cwd" | "env" | "path">) {
    this.teamId = config.teamId;
    this.config = config;
    this.members = [...config.members];
    this.startOptionsBase = baseOptions;

    // 初始化新增组件（默认关闭以保持向后兼容）
    this.worktreeManager = new WorktreeManager({
      enabled: config.worktreeIsolation ?? false,
      baseBranch: config.worktreeBaseBranch ?? "main",
      prefix: config.worktreePrefix ?? `openwork-team-${config.teamId}-`,
    });
    this.messageBus = new TeamMessageBus(config.teamId);
    this.costRouter = new CostEfficiencyRouter();
  }

  // ===== AgentTeamHandle 基础方法 =====

  allAlive(): boolean {
    if (this.members.length === 0) return false;
    return this.members.every((m) => m.handle && m.handle.isAlive());
  }

  getMember(agentId: string): AgentTeamMember | undefined {
    return this.members.find((m) => m.agentId === agentId);
  }

  async ensureMemberStarted(agentId: string): Promise<SidecarHandle> {
    const member = this.getMember(agentId);
    if (!member) {
      throw new Error(`Member '${agentId}' not found in team '${this.teamId}'`);
    }
    if (member.handle && member.handle.isAlive()) {
      return member.handle;
    }

    // 计算 agent 的 cwd（worktree 隔离）
    const baseCwd = this.startOptionsBase.cwd;
    const agentCwd = this.worktreeManager.getWorktreeCwd(this.teamId, agentId, baseCwd);

    const startOptions: SidecarStartOptions = {
      ...this.startOptionsBase,
      cwd: agentCwd,
      timeoutMs: this.config.startupTimeoutMs ?? 30_000,
    };

    // 注入共享变量
    if (this.config.sharedVariables) {
      startOptions.env = {
        ...startOptions.env,
        ...this.config.sharedVariables,
      };
    }

    // 注入角色模型配置
    const roleModel = this.getRoleModel(member);
    if (roleModel) {
      startOptions.env = {
        ...startOptions.env,
        OPENWORK_MODEL: roleModel.modelID,
        OPENWORK_PROVIDER: roleModel.providerID,
      };
    }

    // 使用进程池（可选，默认 false 以保持向后兼容）
    if (this.config.useProcessPool === true) {
      const pool = getGlobalSidecarPool();
      const pooled = await pool.acquire(member.adapter, startOptions, {
        keyFn: () => `${this.teamId}:${agentId}`,
      });
      (member as { handle?: SidecarHandle }).handle = pooled.inner;
      // 保存 pooled handle 用于 release
      (member as { pooledHandle?: unknown }).pooledHandle = pooled;
      return pooled.inner;
    }

    const handle = await member.adapter.start(startOptions);
    (member as { handle?: SidecarHandle }).handle = handle;
    return handle;
  }

  async stop(): Promise<void> {
    // 释放所有 pooled handles
    for (const m of this.members) {
      const pooled = (m as { pooledHandle?: { inner: SidecarHandle } }).pooledHandle;
      if (pooled) {
        try {
          const pool = getGlobalSidecarPool();
          await pool.release(pooled as Parameters<typeof pool.release>[0]);
        } catch {
          // swallow
        }
        (m as { pooledHandle?: unknown }).pooledHandle = undefined;
      }
      if (m.handle) {
        try {
          await m.handle.stop();
        } catch {
          // swallow
        }
        (m as { handle?: SidecarHandle }).handle = undefined;
      }
    }
    // 清理 worktree
    this.worktreeManager.cleanupAll();
    // 清理消息总线
    this.messageBus.clear();
  }

  // ===== Worktree 隔离方法 =====

  getAgentCwd(agentId: string, baseCwd: string): string {
    return this.worktreeManager.getWorktreeCwd(this.teamId, agentId, baseCwd);
  }

  listWorktrees(): Array<{ path: string; agentId: string; isGitWorktree: boolean }> {
    return this.worktreeManager.listWorktrees().map((wt) => ({
      path: wt.path,
      agentId: wt.agentId,
      isGitWorktree: wt.isGitWorktree,
    }));
  }

  getWorktreeDiff(worktreePath: string): import("./worktree-manager.js").WorktreeDiff {
    return this.worktreeManager.getWorktreeDiff(worktreePath);
  }

  mergeWorktrees(options?: import("./worktree-manager.js").MergeOptions): import("./worktree-manager.js").MergeResult {
    return this.worktreeManager.mergeWorktrees(options);
  }

  // ===== 消息总线方法 =====

  async sendMessage(msg: {
    fromAgentId: string;
    toAgentId: string;
    content: string;
    type?: "direct" | "broadcast" | "system";
  }): Promise<{ id: string }> {
    const result = await this.messageBus.send({
      fromAgentId: msg.fromAgentId,
      toAgentId: msg.toAgentId,
      content: msg.content,
      type: msg.type ?? "direct",
    });
    return { id: result.id };
  }

  subscribeMessages(
    agentId: string,
    handler: (msg: { id: string; fromAgentId: string; content: string; type: string }) => void,
  ): () => void {
    return this.messageBus.subscribe(agentId, (msg) => {
      handler({
        id: msg.id,
        fromAgentId: msg.fromAgentId,
        content: msg.content,
        type: msg.type,
      });
    });
  }

  // ===== Supervisor 方法 =====

  setSupervisor(supervisor: Supervisor): void {
    this.supervisor = supervisor;
  }

  async decomposeTask(taskPrompt: string): Promise<SubTaskAssignment[]> {
    if (!this.supervisor) {
      throw new Error("Supervisor not configured for this team");
    }
    return this.supervisor.decompose(taskPrompt, [...this.members]);
  }

  async coordinateTask(taskPrompt: string): Promise<string> {
    if (!this.supervisor) {
      throw new Error("Supervisor not configured for this team");
    }
    return this.supervisor.coordinate(taskPrompt, [...this.members]);
  }

  // ===== Kill-switch 方法 =====

  async killAgent(agentId: string): Promise<void> {
    const member = this.getMember(agentId);
    if (!member) {
      throw new Error(`Member '${agentId}' not found in team '${this.teamId}'`);
    }

    // 释放 pooled handle
    const pooled = (member as { pooledHandle?: unknown }).pooledHandle;
    if (pooled) {
      try {
        const pool = getGlobalSidecarPool();
        await pool.release(pooled as Parameters<typeof pool.release>[0], { evict: true });
      } catch {
        // swallow
      }
      (member as { pooledHandle?: unknown }).pooledHandle = undefined;
    }

    // 强制停止
    if (member.handle) {
      try {
        await member.handle.stop();
      } catch {
        // swallow
      }
      (member as { handle?: SidecarHandle }).handle = undefined;
    }

    // 清理 worktree
    const wt = this.worktreeManager.listWorktrees().find((w) => w.agentId === agentId);
    if (wt) {
      this.worktreeManager.removeWorktree(wt.path);
    }
  }

  // ===== 状态查询 =====

  getStatus(): { teamId: string; alive: boolean; memberCount: number; activeTasks: number } {
    return {
      teamId: this.teamId,
      alive: this.allAlive(),
      memberCount: this.members.length,
      activeTasks: this.activeTasks.size,
    };
  }

  // ===== 内部辅助方法 =====

  private getRoleModel(member: AgentTeamMember): { providerID: string; modelID: string } | null {
    // 优先使用 config 中显式配置的 roleModels
    if (this.config.roleModels) {
      const role = member.role ?? "specialist";
      const explicitModel = this.config.roleModels[role];
      if (explicitModel) return explicitModel;
    }

    // 使用 CostEfficiencyRouter 推荐
    const role = member.role ?? "specialist";
    const recommendation = this.costRouter.recommendForRole(role, {
      maxCostPerMillion: this.config.maxCostPerMillion,
    });
    return {
      providerID: recommendation.primaryModel.providerID,
      modelID: recommendation.primaryModel.modelID,
    };
  }

  getWorktreeManager(): WorktreeManager {
    return this.worktreeManager;
  }

  getMessageBus(): TeamMessageBus {
    return this.messageBus;
  }

  getCostRouter(): CostEfficiencyRouter {
    return this.costRouter;
  }

  setTaskActive(taskId: string): void {
    this.activeTasks.add(taskId);
  }

  setTaskInactive(taskId: string): void {
    this.activeTasks.delete(taskId);
  }
}

// ============================================================
// 工厂函数
// ============================================================

/**
 * 创建并启动一个 agent team（增强版）
 *
 * @param config Team 配置
 * @param baseOptions 所有成员共享的启动选项
 * @param supervisorConfig 可选的 Supervisor 配置（启用 LLM 智能路由）
 * @param llmExecutor 可选的 LLM 执行器（用于 Supervisor）
 */
export async function createAgentTeam(
  config: AgentTeamConfig,
  baseOptions: Pick<SidecarStartOptions, "cwd" | "env" | "path">,
  supervisorConfig?: SupervisorConfig,
  llmExecutor?: (params: {
    providerID: string;
    modelID: string;
    prompt: string;
    systemPrompt: string;
    timeoutMs: number;
  }) => Promise<string>,
): Promise<AgentTeamHandle> {
  if (config.members.length === 0) {
    throw new Error(`Cannot create team '${config.teamId}': no members`);
  }
  const handle = new AgentTeamHandleImpl(config, baseOptions);

  // 初始化 Supervisor（如果提供了配置）
  if (supervisorConfig) {
    if (llmExecutor) {
      const { FunctionalSupervisor } = await import("./supervisor.js");
      handle.setSupervisor(new FunctionalSupervisor(supervisorConfig, llmExecutor));
    } else {
      const { Supervisor: S } = await import("./supervisor.js");
      handle.setSupervisor(new S(supervisorConfig));
    }
  }

  if (config.eagerStart) {
    await Promise.all(
      config.members.map((m) =>
        handle.ensureMemberStarted(m.agentId).catch((err) => {
          throw new Error(`Failed to start member '${m.agentId}': ${err instanceof Error ? err.message : String(err)}`);
        }),
      ),
    );
  }

  return handle;
}

// ============================================================
// 任务执行函数（增强版）
// ============================================================

/**
 * 派发单个任务（支持 Supervisor + worktree + 进程池）
 */
export async function* dispatchTask(
  team: AgentTeamHandle,
  task: TeamTask,
): AsyncGenerator<TeamEvent> {
  const impl = team as AgentTeamHandleImpl;
  impl.setTaskActive(task.taskId);

  try {
    // 如果 dispatch policy 是 llm-supervisor，使用 Supervisor 选择 agent
    let member: AgentTeamMember | null = null;
    const policy = impl.config.dispatchPolicy;

    if (task.explicitAgentId) {
      member = team.getMember(task.explicitAgentId) ?? null;
    } else if (policy.kind === "llm-supervisor" && impl["supervisor"]) {
      try {
        const agentId = await impl.coordinateTask(task.prompt);
        member = team.getMember(agentId) ?? null;
      } catch {
        // Supervisor 失败，降级到静态策略
        member = selectMember(policy, [...team.members], team.teamId);
      }
    } else {
      member = selectMember(policy, [...team.members], team.teamId);
    }

    if (!member) {
      yield {
        kind: "task-failed",
        taskId: task.taskId,
        agentId: task.explicitAgentId ?? "(none)",
        error: "No matching agent available",
      };
      return;
    }

    try {
      await team.ensureMemberStarted(member.agentId);
    } catch (err) {
      if (impl.config.dispatchPolicy.kind === "primary-with-fallback") {
        for (const fallbackId of impl.config.dispatchPolicy.fallbacks) {
          const fallback = team.getMember(fallbackId);
          if (fallback) {
            member = fallback;
            try {
              await team.ensureMemberStarted(member.agentId);
              break;
            } catch {
              // 继续尝试下一个
            }
          }
        }
      }
      if (!member || !(member.handle && member.handle.isAlive())) {
        yield {
          kind: "task-failed",
          taskId: task.taskId,
          agentId: member?.agentId ?? "(none)",
          error: `Failed to start agent: ${err instanceof Error ? err.message : String(err)}`,
        };
        return;
      }
    }

    yield { kind: "task-assigned", taskId: task.taskId, agentId: member.agentId, role: member.role };

    // 使用 worktree 的 cwd（仅当启用 worktree 隔离时）
    const agentCwd = impl.config.worktreeIsolation
      ? impl.getAgentCwd(member.agentId, task.cwd)
      : task.cwd;

    const events: AgentEvent[] = [];
    const timeoutMs = task.timeoutMs ?? 60_000;
    try {
      for await (const event of runAgentPrompt({
        adapter: member.adapter,
        cwd: agentCwd,
        prompt: task.prompt,
        timeoutMs,
      })) {
        events.push(event);
        yield { kind: "task-event", taskId: task.taskId, agentId: member.agentId, event };
        if (event.kind === "stop") break;
        if (event.kind === "error") break;
      }
    } catch (err) {
      yield {
        kind: "task-failed",
        taskId: task.taskId,
        agentId: member.agentId,
        error: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    const lastEvent = events[events.length - 1];
    if (lastEvent && lastEvent.kind === "error") {
      yield {
        kind: "task-failed",
        taskId: task.taskId,
        agentId: member.agentId,
        error: lastEvent.error,
      };
      return;
    }

    const finalText = events
      .filter((e): e is Extract<AgentEvent, { kind: "agent-message-chunk" }> => e.kind === "agent-message-chunk")
      .map((e) => e.text)
      .join("");

    yield { kind: "task-completed", taskId: task.taskId, agentId: member.agentId, finalText };
  } finally {
    impl.setTaskInactive(task.taskId);
  }
}

/**
 * Relay（chain 模式）：串行接力
 */
export async function* relayPipeline(
  team: AgentTeamHandle,
  input: RelayInput,
): AsyncGenerator<import("./types.js").RelayStageEvent> {
  yield* relayChain(team, input);
}

/**
 * Broadcast（broadcast 模式）：并行广播
 */
export async function* broadcastTask(
  team: AgentTeamHandle,
  task: TeamTask,
): AsyncGenerator<TeamEvent> {
  yield* broadcastToAll(team, {
    taskId: task.taskId,
    prompt: task.prompt,
    cwd: task.cwd,
    timeoutMs: task.timeoutMs,
  });
}

/**
 * Fan-out（fan-out 模式）：任务分发
 */
export async function* fanOutTask(
  team: AgentTeamHandle,
  input: FanOutInput,
): AsyncGenerator<import("./types.js").FanOutEvent> {
  yield* fanOut(team, input);
}

/**
 * 取出 team 内部 config（内部使用）
 */
export function getTeamConfig(team: AgentTeamHandle): AgentTeamConfig {
  return (team as AgentTeamHandleImpl).config;
}
