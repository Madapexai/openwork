/**
 * Relay Pipeline 实现
 *
 * 三种编排策略（参考 multica 的 task assignment + paperclip 的 orchestrator）：
 *
 * 1. chain (串行接力): A → B → C
 *    - 每个阶段的输出（agent-message-chunk 的累计）作为下一阶段的输入 prompt
 *    - 类似 paperclip 的 "reviewer" 流水线：实现 → 审查 → 优化
 *
 * 2. broadcast (并行广播): 所有 agent 同时执行同一输入
 *    - 所有成员的事件汇总到一个流，按 agentId 标记来源
 *    - 类似 orca 的多 worktree 并行开发
 *
 * 3. fan-out (任务分发): 每个 agent 处理不同的子任务
 *    - 由调用方提供 assignment 映射：agentId → prompt
 *    - 借鉴 multica 的 task assignment：A 写代码、B 写测试、C 写文档
 *
 * 通过 runAgentPrompt 统一屏蔽 PTY/ACP/Generic 协议差异，
 * 不直接调 LLM，只通过 AgentSidecarAdapter 接入。
 */

import type {
  AgentEvent,
  AgentTeamHandle,
  FanOutEvent,
  FanOutInput,
  RelayInput,
  RelayStageEvent,
  TeamEvent,
} from "./types.js";
import { runAgentPrompt } from "./agent-runner.js";

/** 提取 agent 最终输出文本（agent-message-chunk 累计） */
function extractFinalText(events: AgentEvent[]): string {
  return events
    .filter((e): e is Extract<AgentEvent, { kind: "agent-message-chunk" }> => e.kind === "agent-message-chunk")
    .map((e) => e.text)
    .join("");
}

/**
 * Chain Relay: 串行接力
 *
 * A → B → C
 * - 给 A 发 prompt（通过 runAgentPrompt，自动路由 PTY/ACP）
 * - 收集 A 的事件流直到 stop
 * - 把 A 的 finalText 作为 B 的 prompt
 * - 重复直到最后一个 stage
 */
export async function* relayChain(
  team: AgentTeamHandle,
  input: RelayInput,
): AsyncGenerator<RelayStageEvent> {
  let currentPrompt = input.prompt;
  const stageTimeout = input.stageTimeoutMs ?? 60_000;

  for (let i = 0; i < input.stages.length; i++) {
    const agentId = input.stages[i]!;
    const member = team.getMember(agentId);
    if (!member) {
      yield {
        kind: "stage-failed",
        pipelineId: input.pipelineId,
        stageIndex: i,
        agentId,
        error: `Member '${agentId}' not found in team '${team.teamId}'`,
      };
      return;
    }

    try {
      await team.ensureMemberStarted(agentId);
    } catch (err) {
      yield {
        kind: "stage-failed",
        pipelineId: input.pipelineId,
        stageIndex: i,
        agentId,
        error: `Failed to start '${agentId}': ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    yield {
      kind: "stage-started",
      pipelineId: input.pipelineId,
      stageIndex: i,
      agentId,
      input: currentPrompt,
    };

    let stageOutput = "";
    let stageFailed = false;
    const stageEvents: AgentEvent[] = [];
    for await (const event of runAgentPrompt({
      adapter: member.adapter,
      cwd: input.cwd,
      prompt: currentPrompt,
      timeoutMs: stageTimeout,
    })) {
      stageEvents.push(event);
      yield { kind: "stage-event", pipelineId: input.pipelineId, stageIndex: i, agentId, event };
      if (event.kind === "stop") break;
      if (event.kind === "error") {
        yield {
          kind: "stage-failed",
          pipelineId: input.pipelineId,
          stageIndex: i,
          agentId,
          error: event.error,
        };
        stageFailed = true;
        break;
      }
    }

    if (stageFailed) return;

    stageOutput = extractFinalText(stageEvents);
    yield {
      kind: "stage-completed",
      pipelineId: input.pipelineId,
      stageIndex: i,
      agentId,
      output: stageOutput,
    };

    currentPrompt = stageOutput;
  }

  yield {
    kind: "pipeline-completed",
    pipelineId: input.pipelineId,
    finalOutput: currentPrompt,
  };
}

/**
 * Broadcast: 并行广播
 *
 * 所有 agent 同时执行同一 prompt，收集所有事件流。
 * 借鉴 orca 的多 worktree 并行开发机制。
 */
export async function* broadcastToAll(
  team: AgentTeamHandle,
  task: { taskId: string; prompt: string; cwd: string; timeoutMs?: number },
): AsyncGenerator<TeamEvent> {
  const timeoutMs = task.timeoutMs ?? 60_000;
  const members = team.members;

  // 并发启动所有成员
  await Promise.all(
    members.map(async (m) => {
      try {
        await team.ensureMemberStarted(m.agentId);
      } catch (err) {
        // 启动失败的事件单独发出
        void err;
      }
    }),
  );

  // 并发执行
  yield* raceAll(
    members.map((m) =>
      runSingleAgent(m.agentId, m.adapter, task.taskId, task.prompt, task.cwd, timeoutMs),
    ),
  );
}

/**
 * Fan-out: 任务分发
 *
 * 每个 agent 处理不同的子任务（assignment: agentId → prompt）。
 * 借鉴 multica 的 task assignment：A 写代码、B 写测试、C 写文档。
 *
 * 并发执行所有 assignment，每个 subtask 独立追踪。
 */
export async function* fanOut(
  team: AgentTeamHandle,
  input: FanOutInput,
): AsyncGenerator<FanOutEvent> {
  const defaultTimeout = input.defaultTimeoutMs ?? 60_000;

  // 校验 assignment 都指向 team 成员
  const validAssignments = input.assignments.filter((a) => {
    if (!team.getMember(a.agentId)) {
      // 不直接发出 subtask-failed，先收集起来在 fanout-completed 时报告
      return false;
    }
    return true;
  });

  // 并发启动涉及的成员
  const involvedAgentIds = Array.from(new Set(validAssignments.map((a) => a.agentId)));
  await Promise.all(
    involvedAgentIds.map(async (agentId) => {
      try {
        await team.ensureMemberStarted(agentId);
      } catch (err) {
        void err;
      }
    }),
  );

  // 并发执行每个 assignment
  const results: Array<{ subtaskId: string; agentId: string; finalText: string | null; error?: string }> = [];

  yield* raceAll(
    input.assignments.map((a) =>
      runFanOutAssignment(team, input.fanOutId, a, input.cwd, defaultTimeout, results),
    ),
  );

  // 对未找到成员的 assignment 补发 subtask-failed
  for (const a of input.assignments) {
    if (!team.getMember(a.agentId)) {
      results.push({
        subtaskId: a.subtaskId,
        agentId: a.agentId,
        finalText: null,
        error: `Member '${a.agentId}' not found in team '${team.teamId}'`,
      });
    }
  }

  yield {
    kind: "fanout-completed",
    fanOutId: input.fanOutId,
    results,
  };
}

/** 单 agent 在 fan-out 中的执行 helper */
async function* runFanOutAssignment(
  team: AgentTeamHandle,
  fanOutId: string,
  assignment: { subtaskId: string; agentId: string; prompt: string; timeoutMs?: number },
  cwd: string,
  defaultTimeoutMs: number,
  results: Array<{ subtaskId: string; agentId: string; finalText: string | null; error?: string }>,
): AsyncGenerator<FanOutEvent> {
  const member = team.getMember(assignment.agentId);
  if (!member) {
    // 不会进入这里（已在外层过滤），但保留防御性
    return;
  }

  yield { kind: "subtask-assigned", fanOutId, subtaskId: assignment.subtaskId, agentId: assignment.agentId };

  const timeoutMs = assignment.timeoutMs ?? defaultTimeoutMs;
  const events: AgentEvent[] = [];

  for await (const event of runAgentPrompt({
    adapter: member.adapter,
    cwd,
    prompt: assignment.prompt,
    timeoutMs,
  })) {
    events.push(event);
    yield { kind: "subtask-event", fanOutId, subtaskId: assignment.subtaskId, agentId: assignment.agentId, event };
    if (event.kind === "stop") break;
    if (event.kind === "error") break;
  }

  // 检查最后一个事件
  const lastEvent = events[events.length - 1];
  if (lastEvent && lastEvent.kind === "error") {
    results.push({
      subtaskId: assignment.subtaskId,
      agentId: assignment.agentId,
      finalText: null,
      error: lastEvent.error,
    });
    yield {
      kind: "subtask-failed",
      fanOutId,
      subtaskId: assignment.subtaskId,
      agentId: assignment.agentId,
      error: lastEvent.error,
    };
    return;
  }

  const finalText = extractFinalText(events);
  results.push({
    subtaskId: assignment.subtaskId,
    agentId: assignment.agentId,
    finalText,
  });
  yield {
    kind: "subtask-completed",
    fanOutId,
    subtaskId: assignment.subtaskId,
    agentId: assignment.agentId,
    finalText,
  };
}

/** 单 agent 执行 helper（broadcast 用） */
async function* runSingleAgent(
  agentId: string,
  adapter: import("../agent-sidecar/types.js").AgentSidecarAdapter,
  taskId: string,
  prompt: string,
  cwd: string,
  timeoutMs: number,
): AsyncGenerator<TeamEvent> {
  yield { kind: "task-assigned", taskId, agentId };

  const events: AgentEvent[] = [];

  for await (const event of runAgentPrompt({ adapter, cwd, prompt, timeoutMs })) {
    events.push(event);
    yield { kind: "task-event", taskId, agentId, event };
    if (event.kind === "stop") break;
    if (event.kind === "error") break;
  }

  const lastEvent = events[events.length - 1];
  if (lastEvent && lastEvent.kind === "error") {
    yield {
      kind: "task-failed",
      taskId,
      agentId,
      error: lastEvent.error,
    };
    return;
  }

  yield {
    kind: "task-completed",
    taskId,
    agentId,
    finalText: extractFinalText(events),
  };
}

/** 将多个 AsyncGenerator 的事件交错合并（fan-in） */
async function* raceAll<T>(generators: AsyncGenerator<T>[]): AsyncGenerator<T> {
  if (generators.length === 0) return;

  type QueueItem = { idx: number; value: T };
  const queue: QueueItem[] = [];
  const dones: boolean[] = generators.map(() => false);
  let doneCount = 0;

  // 用 callback 通知有新事件
  let notify: (() => void) | null = null;
  const signal = () => {
    const cb = notify;
    notify = null;
    cb?.();
  };

  // 每个 generator 跑一个 consumer，把事件塞进 queue，并通过 signal() 通知
  const consumers = generators.map(async (gen, idx) => {
    try {
      for await (const ev of gen) {
        queue.push({ idx, value: ev });
        signal();
      }
    } finally {
      dones[idx] = true;
      doneCount++;
      signal();
    }
  });

  try {
    while (true) {
      // 把 queue 里所有事件 yield 出去
      while (queue.length > 0) {
        yield queue.shift()!.value;
      }
      // 全部完成？
      if (doneCount === generators.length) break;
      // 等待新事件通知
      await new Promise<void>((resolve) => {
        notify = resolve;
        // 兜底：每 50ms 检查一次，避免错过信号
        setTimeout(resolve, 50);
      });
    }
  } finally {
    // 确保所有 consumer 完成（处理异常）
    await Promise.allSettled(consumers);
  }
}
