import { describe, expect, test } from "bun:test";
import {
  selectMember,
  filterMembersByCapabilities,
  resetRoundRobinCounter,
} from "./dispatch.js";
import type { AgentTeamMember, MemberRole } from "./types.js";
import type { AgentSidecarAdapter, AgentSidecarConfig, SidecarCapabilities } from "../agent-sidecar/types.js";

// Fake adapter for testing - just a stub that satisfies the interface
function makeFakeAdapter(agentId: string, caps?: SidecarCapabilities): AgentSidecarAdapter & { config: AgentSidecarConfig } {
  const config: AgentSidecarConfig = {
    agentId,
    protocol: "pty",
    binary: "fake",
    capabilities: caps,
  };
  return {
    protocol: "pty",
    agentId,
    displayName: `Fake-${agentId}`,
    capabilities: caps,
    config,
    async start() {
      return {
        protocol: "pty",
        agentId,
        transportInfo: { command: "fake", args: [], cwd: "", env: [] },
        isAlive: () => false,
        stop: async () => {},
      };
    },
    async detect() { return { agentId, available: true }; },
    async doctor() { return { agentId, healthy: true, binaryName: "fake", checks: [] }; },
  };
}

function makeMember(
  agentId: string,
  role: MemberRole | undefined,
  caps?: SidecarCapabilities,
): AgentTeamMember {
  return {
    agentId,
    adapter: makeFakeAdapter(agentId, caps),
    role,
    capabilities: caps,
  };
}

describe("selectMember", () => {
  test("round-robin: rotates through members", () => {
    const members = [
      makeMember("a", undefined),
      makeMember("b", undefined),
      makeMember("c", undefined),
    ];
    resetRoundRobinCounter("team-rr");
    expect(selectMember({ kind: "round-robin" }, members, "team-rr")?.agentId).toBe("a");
    expect(selectMember({ kind: "round-robin" }, members, "team-rr")?.agentId).toBe("b");
    expect(selectMember({ kind: "round-robin" }, members, "team-rr")?.agentId).toBe("c");
    // wraps around
    expect(selectMember({ kind: "round-robin" }, members, "team-rr")?.agentId).toBe("a");
  });

  test("first-available: picks first member", () => {
    const members = [
      makeMember("a", undefined),
      makeMember("b", undefined),
    ];
    expect(selectMember({ kind: "first-available" }, members, "team-fa")?.agentId).toBe("a");
  });

  test("first-available: skips to first member when no handle is alive", () => {
    const members = [
      makeMember("a", undefined),
      makeMember("b", undefined),
    ];
    expect(selectMember({ kind: "first-available" }, members, "team-fa2")?.agentId).toBe("a");
  });

  test("capability-match: returns first member matching required caps", () => {
    const members = [
      makeMember("a", undefined, { streaming: false, permissions: false }),
      makeMember("b", undefined, { streaming: true, permissions: true }),
      makeMember("c", undefined, { streaming: true, permissions: false }),
    ];
    const selected = selectMember(
      { kind: "capability-match", required: { streaming: true, permissions: true } },
      members,
      "team-cap",
    );
    expect(selected?.agentId).toBe("b");
  });

  test("capability-match: returns null when no member matches", () => {
    const members = [
      makeMember("a", undefined, { streaming: false, permissions: false }),
    ];
    const selected = selectMember(
      { kind: "capability-match", required: { streaming: true } },
      members,
      "team-cap-fail",
    );
    expect(selected).toBeNull();
  });

  test("primary-with-fallback: returns primary when available", () => {
    const members = [
      makeMember("a", undefined),
      makeMember("b", undefined),
      makeMember("c", undefined),
    ];
    const selected = selectMember(
      { kind: "primary-with-fallback", primary: "b", fallbacks: ["c"] },
      members,
      "team-pf",
    );
    expect(selected?.agentId).toBe("b");
  });

  test("primary-with-fallback: falls back when primary missing", () => {
    const members = [
      makeMember("a", undefined),
      makeMember("c", undefined),
    ];
    const selected = selectMember(
      { kind: "primary-with-fallback", primary: "b", fallbacks: ["c", "a"] },
      members,
      "team-pf2",
    );
    expect(selected?.agentId).toBe("c");
  });

  test("primary-with-fallback: returns null when all missing", () => {
    const members = [
      makeMember("a", undefined),
    ];
    const selected = selectMember(
      { kind: "primary-with-fallback", primary: "b", fallbacks: ["c"] },
      members,
      "team-pf3",
    );
    expect(selected).toBeNull();
  });

  test("role-based: returns first member with matching role", () => {
    const members = [
      makeMember("a", "primary"),
      makeMember("b", "reviewer"),
      makeMember("c", "primary"),
    ];
    expect(selectMember({ kind: "role-based", role: "reviewer" }, members, "team-role")?.agentId).toBe("b");
    expect(selectMember({ kind: "role-based", role: "primary" }, members, "team-role")?.agentId).toBe("a");
  });

  test("role-based: returns null when no member has role", () => {
    const members = [
      makeMember("a", "primary"),
    ];
    expect(selectMember({ kind: "role-based", role: "fallback" }, members, "team-role2")).toBeNull();
  });

  test("returns null for empty members", () => {
    expect(selectMember({ kind: "round-robin" }, [], "team-empty")).toBeNull();
  });
});

describe("filterMembersByCapabilities", () => {
  test("returns only members matching all required caps", () => {
    const members = [
      makeMember("a", undefined, { streaming: true, permissions: true }),
      makeMember("b", undefined, { streaming: true, permissions: false }),
      makeMember("c", undefined, { streaming: true, permissions: true, mcpClient: true }),
    ];
    const filtered = filterMembersByCapabilities(members, { streaming: true, permissions: true });
    expect(filtered.map((m) => m.agentId)).toEqual(["a", "c"]);
  });

  test("returns empty array when none match", () => {
    const members = [
      makeMember("a", undefined, { streaming: false }),
    ];
    const filtered = filterMembersByCapabilities(members, { streaming: true });
    expect(filtered).toHaveLength(0);
  });
});
