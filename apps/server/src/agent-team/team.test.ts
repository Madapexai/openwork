import { describe, expect, test } from "bun:test";
import { PtySidecarAdapter } from "../agent-sidecar/adapters/pty.js";
import type { AgentSidecarConfig } from "../agent-sidecar/types.js";
import {
  createAgentTeam,
  dispatchTask,
  relayPipeline,
  broadcastTask,
  fanOutTask,
} from "./team.js";
import type { AgentTeamConfig, AgentTeamMember, TeamEvent, RelayStageEvent, FanOutEvent } from "./types.js";

async function collect<T>(iter: AsyncIterable<T>, max: number, timeoutMs = 800): Promise<T[]> {
  const events: T[] = [];
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([
    (async () => {
      for await (const ev of iter) {
        events.push(ev);
        if (events.length >= max) break;
      }
    })(),
    timeout,
  ]);
  return events;
}

// Helper: create a "echo + sleep" PTY agent that echoes prompt back as agent-message-chunk
function makeEchoAdapter(agentId: string): PtySidecarAdapter {
  // Bash script: read line from stdin, echo as JSONL agent-message-chunk, then stop, then sleep
  // \u001b[?25l hides cursor; we just want plain output
  const script = `read line; printf '{"type":"agent-message-chunk","text":"${agentId}: %s"}\\n' "$line"; printf '{"type":"stop","stopReason":"end"}\\n'; sleep 0.3`;
  const config: AgentSidecarConfig = {
    agentId,
    protocol: "pty",
    binary: "bash",
    args: ["-c", script],
    outputParser: "jsonl",
  };
  return new PtySidecarAdapter(config);
}

function makeMember(agentId: string, role?: AgentTeamMember["role"]): AgentTeamMember {
  return {
    agentId,
    adapter: makeEchoAdapter(agentId),
    role,
  };
}

describe("createAgentTeam", () => {
  test("creates team with multiple members (lazy start)", async () => {
    const config: AgentTeamConfig = {
      teamId: "t1",
      members: [makeMember("a"), makeMember("b")],
      dispatchPolicy: { kind: "round-robin" },
      eagerStart: false,
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      expect(team.teamId).toBe("t1");
      expect(team.members.length).toBe(2);
      expect(team.allAlive()).toBe(false); // lazy start
    } finally {
      await team.stop();
    }
  });

  test("eager start: starts all members on creation", async () => {
    const config: AgentTeamConfig = {
      teamId: "t2",
      members: [makeMember("a"), makeMember("b")],
      dispatchPolicy: { kind: "round-robin" },
      eagerStart: true,
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      // Members should have handles now (echo bash scripts sleep 0.3s after printing)
      expect(team.members[0]!.handle).toBeDefined();
      expect(team.members[1]!.handle).toBeDefined();
    } finally {
      await team.stop();
    }
  });

  test("throws on empty members", async () => {
    const config: AgentTeamConfig = {
      teamId: "t-empty",
      members: [],
      dispatchPolicy: { kind: "round-robin" },
    };
    await expect(createAgentTeam(config, { cwd: "/tmp" })).rejects.toThrow(/no members/);
  });

  test("getMember returns matching member", async () => {
    const config: AgentTeamConfig = {
      teamId: "t3",
      members: [makeMember("a"), makeMember("b")],
      dispatchPolicy: { kind: "round-robin" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      expect(team.getMember("a")?.agentId).toBe("a");
      expect(team.getMember("b")?.agentId).toBe("b");
      expect(team.getMember("missing")).toBeUndefined();
    } finally {
      await team.stop();
    }
  });

  test("stop() is idempotent", async () => {
    const config: AgentTeamConfig = {
      teamId: "t-stop",
      members: [makeMember("a")],
      dispatchPolicy: { kind: "round-robin" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    await team.stop();
    await team.stop(); // should not throw
  });
});

describe("dispatchTask", () => {
  test("dispatches task to single agent and collects events", async () => {
    const config: AgentTeamConfig = {
      teamId: "dispatch-1",
      members: [makeMember("echo-a")],
      dispatchPolicy: { kind: "first-available" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      const events = await collect(
        dispatchTask(team, { taskId: "task-1", prompt: "hello", cwd: "/tmp" }),
        20,
        800,
      );
      const assigned = events.find((e) => e.kind === "task-assigned") as Extract<TeamEvent, { kind: "task-assigned" }> | undefined;
      const completed = events.find((e) => e.kind === "task-completed") as Extract<TeamEvent, { kind: "task-completed" }> | undefined;
      expect(assigned?.agentId).toBe("echo-a");
      expect(completed).toBeDefined();
      expect(completed?.finalText).toContain("echo-a");
      expect(completed?.finalText).toContain("hello");
    } finally {
      await team.stop();
    }
  });

  test("explicit agentId overrides dispatch policy", async () => {
    const config: AgentTeamConfig = {
      teamId: "dispatch-2",
      members: [makeMember("alpha"), makeMember("beta")],
      dispatchPolicy: { kind: "first-available" }, // would pick alpha
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      const events = await collect(
        dispatchTask(team, {
          taskId: "task-2",
          prompt: "world",
          cwd: "/tmp",
          explicitAgentId: "beta",
        }),
        20,
        800,
      );
      const assigned = events.find((e) => e.kind === "task-assigned") as Extract<TeamEvent, { kind: "task-assigned" }> | undefined;
      const completed = events.find((e) => e.kind === "task-completed") as Extract<TeamEvent, { kind: "task-completed" }> | undefined;
      expect(assigned?.agentId).toBe("beta");
      expect(completed?.finalText).toContain("beta: world");
    } finally {
      await team.stop();
    }
  });

  test("task-failed event when explicit agentId not found", async () => {
    const config: AgentTeamConfig = {
      teamId: "dispatch-3",
      members: [makeMember("a")],
      dispatchPolicy: { kind: "round-robin" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      const events = await collect(
        dispatchTask(team, {
          taskId: "task-3",
          prompt: "x",
          cwd: "/tmp",
          explicitAgentId: "nonexistent",
        }),
        10,
        300,
      );
      const failed = events.find((e) => e.kind === "task-failed") as Extract<TeamEvent, { kind: "task-failed" }> | undefined;
      expect(failed).toBeDefined();
      expect(failed?.agentId).toBe("nonexistent");
    } finally {
      await team.stop();
    }
  });

  test("round-robin: dispatches to different members in sequence", async () => {
    const config: AgentTeamConfig = {
      teamId: "dispatch-rr",
      members: [makeMember("rr-a"), makeMember("rr-b")],
      dispatchPolicy: { kind: "round-robin" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      const events1 = await collect(
        dispatchTask(team, { taskId: "t-a", prompt: "ping", cwd: "/tmp" }),
        20,
        800,
      );
      const events2 = await collect(
        dispatchTask(team, { taskId: "t-b", prompt: "pong", cwd: "/tmp" }),
        20,
        800,
      );
      const assigned1 = events1.find((e) => e.kind === "task-assigned") as Extract<TeamEvent, { kind: "task-assigned" }> | undefined;
      const assigned2 = events2.find((e) => e.kind === "task-assigned") as Extract<TeamEvent, { kind: "task-assigned" }> | undefined;
      // Should be different agents
      expect(assigned1?.agentId).not.toBe(assigned2?.agentId);
    } finally {
      await team.stop();
    }
  });
});

describe("relayPipeline (chain)", () => {
  test("chain: A's output becomes B's input", async () => {
    // A echoes "A: <input>", B echoes "B: <input from A>"
    const config: AgentTeamConfig = {
      teamId: "relay-chain",
      members: [makeMember("A"), makeMember("B")],
      dispatchPolicy: { kind: "round-robin" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      const events = await collect(
        relayPipeline(team, {
          pipelineId: "p1",
          prompt: "seed",
          cwd: "/tmp",
          stages: ["A", "B"],
          stageTimeoutMs: 2000,
        }),
        30,
        1500,
      );

      const stage1Started = events.find((e) => e.kind === "stage-started" && e.stageIndex === 0) as Extract<RelayStageEvent, { kind: "stage-started" }> | undefined;
      const stage1Completed = events.find((e) => e.kind === "stage-completed" && e.stageIndex === 0) as Extract<RelayStageEvent, { kind: "stage-completed" }> | undefined;
      const stage2Started = events.find((e) => e.kind === "stage-started" && e.stageIndex === 1) as Extract<RelayStageEvent, { kind: "stage-started" }> | undefined;
      const pipelineCompleted = events.find((e) => e.kind === "pipeline-completed") as Extract<RelayStageEvent, { kind: "pipeline-completed" }> | undefined;

      expect(stage1Started?.input).toBe("seed");
      expect(stage1Completed?.output).toContain("A: seed");
      expect(stage2Started?.input).toContain("A: seed");
      expect(pipelineCompleted?.finalOutput).toContain("B:");
    } finally {
      await team.stop();
    }
  });

  test("chain: reports stage-failed when stage agent missing", async () => {
    const config: AgentTeamConfig = {
      teamId: "relay-fail",
      members: [makeMember("A")],
      dispatchPolicy: { kind: "round-robin" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      const events = await collect(
        relayPipeline(team, {
          pipelineId: "p2",
          prompt: "seed",
          cwd: "/tmp",
          stages: ["A", "missing"],
          stageTimeoutMs: 1000,
        }),
        30,
        1500,
      );
      const failed = events.find((e) => e.kind === "stage-failed") as Extract<RelayStageEvent, { kind: "stage-failed" }> | undefined;
      expect(failed).toBeDefined();
      expect(failed?.agentId).toBe("missing");
      expect(failed?.error).toContain("not found");
    } finally {
      await team.stop();
    }
  });
});

describe("broadcastTask", () => {
  test("broadcast: all agents receive same prompt", async () => {
    const config: AgentTeamConfig = {
      teamId: "broadcast-1",
      members: [makeMember("bc-a"), makeMember("bc-b")],
      dispatchPolicy: { kind: "round-robin" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      const events = await collect(
        broadcastTask(team, { taskId: "b1", prompt: "ping", cwd: "/tmp", timeoutMs: 2000 }),
        30,
        1500,
      );

      const completed = events.filter(
        (e): e is Extract<TeamEvent, { kind: "task-completed" }> => e.kind === "task-completed",
      );
      expect(completed.length).toBe(2);

      const finalTexts = completed.map((e) => e.finalText).sort();
      expect(finalTexts[0]).toContain("bc-a");
      expect(finalTexts[1]).toContain("bc-b");
    } finally {
      await team.stop();
    }
  });
});

describe("fanOutTask", () => {
  test("fan-out: each agent receives its own prompt", async () => {
    const config: AgentTeamConfig = {
      teamId: "fanout-1",
      members: [makeMember("fo-a"), makeMember("fo-b")],
      dispatchPolicy: { kind: "round-robin" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      const events = await collect(
        fanOutTask(team, {
          fanOutId: "f1",
          cwd: "/tmp",
          defaultTimeoutMs: 2000,
          assignments: [
            { subtaskId: "code", agentId: "fo-a", prompt: "write main.ts" },
            { subtaskId: "test", agentId: "fo-b", prompt: "write test" },
          ],
        }),
        50,
        2000,
      );

      const completed = events.filter(
        (e): e is Extract<FanOutEvent, { kind: "subtask-completed" }> => e.kind === "subtask-completed",
      );
      expect(completed.length).toBe(2);

      const codeResult = completed.find((e) => e.subtaskId === "code");
      const testResult = completed.find((e) => e.subtaskId === "test");
      expect(codeResult?.agentId).toBe("fo-a");
      expect(codeResult?.finalText).toContain("fo-a: write main.ts");
      expect(testResult?.agentId).toBe("fo-b");
      expect(testResult?.finalText).toContain("fo-b: write test");

      // fanout-completed event
      const fanoutCompleted = events.find(
        (e): e is Extract<FanOutEvent, { kind: "fanout-completed" }> => e.kind === "fanout-completed",
      );
      expect(fanoutCompleted).toBeDefined();
      expect(fanoutCompleted?.results.length).toBe(2);
    } finally {
      await team.stop();
    }
  });

  test("fan-out: reports subtask-failed for missing agent", async () => {
    const config: AgentTeamConfig = {
      teamId: "fanout-2",
      members: [makeMember("fo-c")],
      dispatchPolicy: { kind: "round-robin" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      const events = await collect(
        fanOutTask(team, {
          fanOutId: "f2",
          cwd: "/tmp",
          defaultTimeoutMs: 1000,
          assignments: [
            { subtaskId: "ok", agentId: "fo-c", prompt: "hello" },
            { subtaskId: "missing", agentId: "nonexistent", prompt: "fail" },
          ],
        }),
        30,
        1500,
      );

      // missing agent 应在 fanout-completed.results 中标记为 error
      const fanoutCompleted = events.find(
        (e): e is Extract<FanOutEvent, { kind: "fanout-completed" }> => e.kind === "fanout-completed",
      );
      expect(fanoutCompleted).toBeDefined();
      const missingResult = fanoutCompleted?.results.find((r) => r.subtaskId === "missing");
      expect(missingResult?.error).toContain("not found");
    } finally {
      await team.stop();
    }
  });

  test("fan-out: 3 agents in parallel each get different prompt", async () => {
    const config: AgentTeamConfig = {
      teamId: "fanout-3",
      members: [makeMember("a1"), makeMember("a2"), makeMember("a3")],
      dispatchPolicy: { kind: "round-robin" },
    };
    const team = await createAgentTeam(config, { cwd: "/tmp" });
    try {
      const events = await collect(
        fanOutTask(team, {
          fanOutId: "f3",
          cwd: "/tmp",
          defaultTimeoutMs: 2000,
          assignments: [
            { subtaskId: "t1", agentId: "a1", prompt: "task-1" },
            { subtaskId: "t2", agentId: "a2", prompt: "task-2" },
            { subtaskId: "t3", agentId: "a3", prompt: "task-3" },
          ],
        }),
        80,
        2500,
      );

      const completed = events.filter(
        (e): e is Extract<FanOutEvent, { kind: "subtask-completed" }> => e.kind === "subtask-completed",
      );
      expect(completed.length).toBe(3);

      const bySubtask = new Map(completed.map((e) => [e.subtaskId, e]));
      expect(bySubtask.get("t1")?.finalText).toContain("a1: task-1");
      expect(bySubtask.get("t2")?.finalText).toContain("a2: task-2");
      expect(bySubtask.get("t3")?.finalText).toContain("a3: task-3");
    } finally {
      await team.stop();
    }
  });
});
