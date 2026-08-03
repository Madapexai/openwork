/**
 * Agent Team / Relay 模块入口
 *
 * 四种编排模式：
 * - dispatch: 单任务 → 按 dispatch policy 选 agent
 * - relay: chain 串行接力 → A 的输出作为 B 的输入
 * - broadcast: 同一任务并行交给所有 agent
 * - fan-out: 每个 agent 处理不同的子任务（assignment: agentId → prompt）
 *
 * 使用示例：
 *
 * ```ts
 * import { createAdapterForAgent } from "../agent-sidecar/index.js";
 * import { createAgentTeam, dispatchTask, relayPipeline, broadcastTask, fanOutTask } from "./index.js";
 *
 * const team = await createAgentTeam({
 *   teamId: "demo",
 *   members: [
 *     { agentId: "claude-code", adapter: createAdapterForAgent("claude-code"), role: "primary" },
 *     { agentId: "codex", adapter: createAdapterForAgent("codex"), role: "reviewer" },
 *   ],
 *   dispatchPolicy: { kind: "round-robin" },
 *   relayStrategy: { kind: "chain" },
 *   eagerStart: false,
 * }, { cwd: "/workspace" });
 *
 * // 派发单个任务
 * for await (const ev of dispatchTask(team, { taskId: "t1", prompt: "hello", cwd: "/workspace" })) {
 *   console.log(ev);
 * }
 *
 * // 串行接力：claude-code → codex
 * for await (const ev of relayPipeline(team, {
 *   pipelineId: "p1", prompt: "summarize", cwd: "/workspace", stages: ["claude-code", "codex"],
 * })) {
 *   console.log(ev);
 * }
 *
 * // 并行广播：所有 agent 处理同一 prompt
 * for await (const ev of broadcastTask(team, { taskId: "b1", prompt: "review", cwd: "/workspace" })) {
 *   console.log(ev);
 * }
 *
 * // 任务分发：每个 agent 处理不同子任务
 * for await (const ev of fanOutTask(team, {
 *   fanOutId: "f1", cwd: "/workspace", defaultTimeoutMs: 30_000,
 *   assignments: [
 *     { subtaskId: "code", agentId: "claude-code", prompt: "write main.ts" },
 *     { subtaskId: "test", agentId: "codex", prompt: "write test for main.ts" },
 *   ],
 * })) {
 *   console.log(ev);
 * }
 *
 * await team.stop();
 * ```
 */

export type {
  AgentTeamConfig,
  AgentTeamHandle,
  AgentTeamMember,
  DispatchPolicy,
  FanOutAssignment,
  FanOutEvent,
  FanOutInput,
  MemberRole,
  RelayInput,
  RelayStageEvent,
  RelayStrategy,
  TeamEvent,
  TeamTask,
} from "./types.js";

export {
  selectMember,
  filterMembersByCapabilities,
  resetRoundRobinCounter,
} from "./dispatch.js";

export {
  createAgentTeam,
  dispatchTask,
  relayPipeline,
  broadcastTask,
  fanOutTask,
  getTeamConfig,
} from "./team.js";

export { relayChain, broadcastToAll, fanOut } from "./relay.js";
export { runAgentPrompt, type RunAgentPromptParams } from "./agent-runner.js";
