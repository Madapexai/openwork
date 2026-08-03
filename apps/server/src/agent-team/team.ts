/**
 * AgentTeam - 团队编排实现
 *
 * 借鉴 multica 的 team lifecycle 与 orca 的多 worktree 隔离：
 * - start(): 启动所有成员（eager）或保持 lazy
 * - dispatch(task): 按 dispatchPolicy 选择成员并执行
 * - relay(input): 按 stages 顺序接力
 * - broadcast(task): 所有成员并行执行
 * - fanOut(input): 每个 agent 处理不同子任务
 * - stop(): 停止所有成员
 *
 * 不直接调 LLM，只通过 AgentSidecarAdapter 接入。
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
} from "./types.js";
import { selectMember } from "./dispatch.js";
import { broadcastToAll, fanOut, relayChain } from "./relay.js";
import { runAgentPrompt } from "./agent-runner.js";

class AgentTeamHandleImpl implements AgentTeamHandle {
  readonly teamId: string;
  readonly members: ReadonlyArray<AgentTeamMember>;
  /** Team config (public readonly for internal access via AgentTeamHandleImpl cast) */
  readonly config: AgentTeamConfig;
  private readonly startOptionsBase: Pick<SidecarStartOptions, "cwd" | "env" | "path">;

  constructor(config: AgentTeamConfig, baseOptions: Pick<SidecarStartOptions, "cwd" | "env" | "path">) {
    this.teamId = config.teamId;
    this.config = config;
    this.members = [...config.members];
    this.startOptionsBase = baseOptions;
  }

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
    const startOptions: SidecarStartOptions = {
      ...this.startOptionsBase,
      timeoutMs: this.config.startupTimeoutMs ?? 30_000,
    };
    const handle = await member.adapter.start(startOptions);
    // 直接修改成员对象（成员是可变的）
    (member as { handle?: SidecarHandle }).handle = handle;
    return handle;
  }

  async stop(): Promise<void> {
    const stops = this.members.map(async (m) => {
      if (m.handle) {
        try {
          await m.handle.stop();
        } catch {
          // swallow
        }
        (m as { handle?: SidecarHandle }).handle = undefined;
      }
    });
    await Promise.all(stops);
  }
}

/**
 * 创建并启动一个 agent team
 *
 * @param config Team 配置
 * @param baseOptions 所有成员共享的启动选项（cwd / env / path）
 */
export async function createAgentTeam(
  config: AgentTeamConfig,
  baseOptions: Pick<SidecarStartOptions, "cwd" | "env" | "path">,
): Promise<AgentTeamHandle> {
  if (config.members.length === 0) {
    throw new Error(`Cannot create team '${config.teamId}': no members`);
  }
  const handle = new AgentTeamHandleImpl(config, baseOptions);

  if (config.eagerStart) {
    // 启动所有成员
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

/**
 * 派发单个任务
 *
 * 按 dispatch policy 选择成员，写入 stdin，收集事件流。
 */
export async function* dispatchTask(
  team: AgentTeamHandle,
  task: TeamTask,
): AsyncGenerator<TeamEvent> {
  let member = task.explicitAgentId
    ? team.getMember(task.explicitAgentId)
    : selectMember((team as AgentTeamHandleImpl).config.dispatchPolicy, [...team.members], team.teamId);

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
    // 尝试 fallback
    const cfg = (team as AgentTeamHandleImpl).config;
    if (cfg.dispatchPolicy.kind === "primary-with-fallback") {
      for (const fallbackId of cfg.dispatchPolicy.fallbacks) {
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

  // 通过统一 runner 执行（自动路由 PTY/ACP/Generic）
  const events: AgentEvent[] = [];
  const timeoutMs = task.timeoutMs ?? 60_000;
  try {
    for await (const event of runAgentPrompt({
      adapter: member.adapter,
      cwd: task.cwd,
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
}

/**
 * Relay（chain 模式）：串行接力
 *
 * 包装 relayChain，使用 team 的 dispatch policy 时 stages 由调用方指定。
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
 *
 * 每个 agent 处理不同的子任务（assignment: agentId → prompt）。
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
