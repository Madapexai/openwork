/**
 * End-to-end orchestration smoke test
 *
 * 在真实 PTY 子进程上验证四种编排模式：
 *   - dispatch（round-robin）
 *   - relay（chain：A → B → C）
 *   - broadcast（并行广播）
 *   - fan-out（异构子任务分发）
 *
 * 所有 PTY agent 都通过 bash + jsonl 输出模拟，
 * 验证 runAgentPrompt → PtySidecarAdapter.events() 的统一事件流。
 */

import { describe, expect, test } from "bun:test";
import { PtySidecarAdapter } from "../agent-sidecar/adapters/pty.js";
import type { AgentSidecarConfig, SidecarCapabilities } from "../agent-sidecar/types.js";
import type {
  AgentSidecarAdapter,
  AgentTeamConfig,
  AgentTeamMember,
  MemberRole,
} from "./types.js";
import type { AgentTeamHandle, FanOutInput, RelayInput, TeamTask } from "./types.js";
import { createAgentTeam, dispatchTask, relayPipeline, broadcastTask, fanOutTask } from "./team.js";

const PTY_CAPS: SidecarCapabilities = {
  streaming: true,
  permissions: false,
  multiSession: false,
};

function makeEchoAdapter(agentId: string, suffix = ""): AgentSidecarAdapter {
  const script = `read line; printf '{"kind":"agent-message-chunk","text":"${agentId}${suffix}: %s"}\\n' "$line"; printf '{"kind":"stop","stopReason":"end_turn"}\\n'`;
  const config: AgentSidecarConfig = {
    agentId,
    protocol: "pty",
    binary: "bash",
    args: ["-c", script],
    outputParser: "jsonl",
    capabilities: PTY_CAPS,
  };
  const adapter = new PtySidecarAdapter(config);
  // Attach config for team internal access
  (adapter as unknown as { config: AgentSidecarConfig }).config = config;
  return adapter as unknown as AgentSidecarAdapter;
}

function makeMember(agentId: string, role?: MemberRole): AgentTeamMember {
  return {
    agentId,
    adapter: makeEchoAdapter(agentId),
    role,
    capabilities: PTY_CAPS,
  };
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("E2E: orchestration modes on PTY agents", () => {
  test("dispatch: round-robin routes to a, b, c", async () => {
    const config: AgentTeamConfig = {
      teamId: "e2e-dispatch",
      members: [makeMember("a"), makeMember("b"), makeMember("c")],
      dispatchPolicy: { kind: "round-robin" },
    };
    const team: AgentTeamHandle = await createAgentTeam(config, { cwd: "/tmp" });

    try {
      const t1: TeamTask = { taskId: "t1", prompt: "hello", cwd: "/tmp" };
      const t2: TeamTask = { taskId: "t2", prompt: "hello", cwd: "/tmp" };
      const t3: TeamTask = { taskId: "t3", prompt: "hello", cwd: "/tmp" };

      const e1 = await collect(dispatchTask(team, t1));
      const e2 = await collect(dispatchTask(team, t2));
      const e3 = await collect(dispatchTask(team, t3));

      const agentOf = (events: { kind: string; agentId?: string }[]) =>
        events.find((e) => e.kind === "task-assigned")?.agentId;

      expect(agentOf(e1 as never)).toBe("a");
      expect(agentOf(e2 as never)).toBe("b");
      expect(agentOf(e3 as never)).toBe("c");

      // Each task should complete with final text from the agent
      const final1 = e1.find((e) => e.kind === "task-completed") as { finalText?: string } | undefined;
      const final2 = e2.find((e) => e.kind === "task-completed") as { finalText?: string } | undefined;
      const final3 = e3.find((e) => e.kind === "task-completed") as { finalText?: string } | undefined;
      expect(final1?.finalText).toContain("a: hello");
      expect(final2?.finalText).toContain("b: hello");
      expect(final3?.finalText).toContain("c: hello");
    } finally {
      await team.stop();
    }
  }, 20_000);

  test("relay: chain a → b → c (output of one becomes input of next)", async () => {
    const config: AgentTeamConfig = {
      teamId: "e2e-relay",
      members: [makeMember("a"), makeMember("b"), makeMember("c")],
      dispatchPolicy: { kind: "first-available" },
      relayStrategy: { kind: "chain" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });

    try {
      const input: RelayInput = {
        pipelineId: "p1",
        prompt: "seed",
        cwd: "/tmp",
        stages: ["a", "b", "c"],
        stageTimeoutMs: 5_000,
      };
      const events = await collect(relayPipeline(team, input));
      const stageStarted = events.filter((e) => e.kind === "stage-started");
      expect(stageStarted).toHaveLength(3);
      const pipelineDone = events.find((e) => e.kind === "pipeline-completed") as { finalOutput?: string } | undefined;
      expect(pipelineDone).toBeDefined();
      // Final output should be from agent c, containing the seed prompt propagated through
      expect(pipelineDone?.finalOutput).toContain("c:");
    } finally {
      await team.stop();
    }
  }, 30_000);

  test("broadcast: same prompt reaches all 3 agents in parallel", async () => {
    const config: AgentTeamConfig = {
      teamId: "e2e-broadcast",
      members: [makeMember("a"), makeMember("b"), makeMember("c")],
      dispatchPolicy: { kind: "first-available" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });

    try {
      const task: TeamTask = { taskId: "bcast-1", prompt: "ping", cwd: "/tmp", timeoutMs: 5_000 };
      const events = await collect(broadcastTask(team, task));
      const assigned = events.filter((e) => e.kind === "task-assigned");
      const completed = events.filter((e) => e.kind === "task-completed");
      expect(assigned).toHaveLength(3);
      expect(completed).toHaveLength(3);

      const finalTexts = (completed as { finalText?: string }[]).map((e) => e.finalText ?? "");
      expect(finalTexts.some((t) => t.includes("a: ping"))).toBe(true);
      expect(finalTexts.some((t) => t.includes("b: ping"))).toBe(true);
      expect(finalTexts.some((t) => t.includes("c: ping"))).toBe(true);
    } finally {
      await team.stop();
    }
  }, 20_000);

  test("fan-out: 3 agents get different subtasks in parallel", async () => {
    const config: AgentTeamConfig = {
      teamId: "e2e-fanout",
      members: [makeMember("a"), makeMember("b"), makeMember("c")],
      dispatchPolicy: { kind: "first-available" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });

    try {
      const input: FanOutInput = {
        fanOutId: "fo-1",
        cwd: "/tmp",
        defaultTimeoutMs: 5_000,
        assignments: [
          { subtaskId: "s1", agentId: "a", prompt: "write-code" },
          { subtaskId: "s2", agentId: "b", prompt: "write-tests" },
          { subtaskId: "s3", agentId: "c", prompt: "write-docs" },
        ],
      };
      const events = await collect(fanOutTask(team, input));
      const subtaskAssigned = events.filter((e) => e.kind === "subtask-assigned");
      const subtaskCompleted = events.filter((e) => e.kind === "subtask-completed");
      const fanoutDone = events.find((e) => e.kind === "fanout-completed") as { results?: Array<{ subtaskId: string; finalText: string | null }> } | undefined;
      expect(subtaskAssigned).toHaveLength(3);
      expect(subtaskCompleted).toHaveLength(3);
      expect(fanoutDone).toBeDefined();
      expect(fanoutDone?.results).toHaveLength(3);

      const bySubtask = new Map(fanoutDone?.results?.map((r) => [r.subtaskId, r.finalText ?? ""]));
      expect(bySubtask.get("s1")).toContain("a: write-code");
      expect(bySubtask.get("s2")).toContain("b: write-tests");
      expect(bySubtask.get("s3")).toContain("c: write-docs");
    } finally {
      await team.stop();
    }
  }, 20_000);
});
