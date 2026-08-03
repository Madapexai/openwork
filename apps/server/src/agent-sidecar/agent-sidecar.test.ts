import { describe, expect, test } from "bun:test";
import {
  AGENT_PRESETS,
  DEFAULT_AGENT_ID,
  getPreset,
  listPresets,
} from "./presets.js";
import type { AgentPreset } from "./presets.js";

describe("AGENT_PRESETS", () => {
  test("covers at least 60 agents across all 5 protocol clusters", () => {
    const ids = Object.keys(AGENT_PRESETS);
    expect(ids.length).toBeGreaterThanOrEqual(60);

    const protocols = new Set(Object.values(AGENT_PRESETS).map((p) => p.protocol));
    expect(protocols.has("acp")).toBe(true);
    expect(protocols.has("http")).toBe(true);
    expect(protocols.has("pty")).toBe(true);
    expect(protocols.has("mcp")).toBe(true);
    expect(protocols.has("generic")).toBe(true);
  });

  test("ACP cluster includes key agents: opencode, kimi, traecli, goose, openhands-acp", () => {
    expect(AGENT_PRESETS.opencode.protocol).toBe("acp");
    expect(AGENT_PRESETS.kimi.protocol).toBe("acp");
    expect(AGENT_PRESETS.traecli.protocol).toBe("acp");
    expect(AGENT_PRESETS.goose.protocol).toBe("acp");
    expect(AGENT_PRESETS["openhands-acp"].protocol).toBe("acp");
  });

  test("PTY cluster includes claude-code, codex, gemini, copilot + new agents", () => {
    expect(AGENT_PRESETS["claude-code"].protocol).toBe("pty");
    expect(AGENT_PRESETS.codex.protocol).toBe("pty");
    expect(AGENT_PRESETS.gemini.protocol).toBe("pty");
    expect(AGENT_PRESETS.copilot.protocol).toBe("pty");
    // 扩展覆盖：pair programming + SWE
    expect(AGENT_PRESETS.aider.protocol).toBe("pty");
    expect(AGENT_PRESETS.openhands.protocol).toBe("pty");
    expect(AGENT_PRESETS["swe-agent"].protocol).toBe("pty");
    expect(AGENT_PRESETS["gpt-engineer"].protocol).toBe("pty");
    expect(AGENT_PRESETS["amazon-q"].protocol).toBe("pty");
    expect(AGENT_PRESETS["github-copilot-cli"].protocol).toBe("pty");
    expect(AGENT_PRESETS.cody.protocol).toBe("pty");
    // 扩展覆盖：Chinese
    expect(AGENT_PRESETS["tongyi-lingma"].protocol).toBe("pty");
    expect(AGENT_PRESETS["baidu-comate"].protocol).toBe("pty");
    expect(AGENT_PRESETS["tencent-codebuddy"].protocol).toBe("pty");
    expect(AGENT_PRESETS.codegeex.protocol).toBe("pty");
    // 扩展覆盖：code review
    expect(AGENT_PRESETS["pr-agent"].protocol).toBe("pty");
    expect(AGENT_PRESETS["open-code-review"].protocol).toBe("pty");
    expect(AGENT_PRESETS.autodev.protocol).toBe("pty");
  });

  test("HTTP cluster has opencode-serve + tabby + letta + devika", () => {
    expect(AGENT_PRESETS["opencode-serve"].protocol).toBe("http");
    expect(AGENT_PRESETS["opencode-serve"].args).toContain("serve");
    expect(AGENT_PRESETS.tabby.protocol).toBe("http");
    expect(AGENT_PRESETS.letta.protocol).toBe("http");
    expect(AGENT_PRESETS.devika.protocol).toBe("http");
    expect(AGENT_PRESETS["continue-server"].protocol).toBe("http");
  });

  test("MCP cluster includes code-review-graph", () => {
    expect(AGENT_PRESETS["code-review-graph"].protocol).toBe("mcp");
    expect(AGENT_PRESETS["code-review-graph"].binary).toBe("crg");
  });

  test("every preset has agentId matching its key", () => {
    for (const [id, preset] of Object.entries(AGENT_PRESETS)) {
      expect(preset.agentId).toBe(id);
    }
  });

  test("every preset has a binary or commandTemplate", () => {
    for (const [id, preset] of Object.entries(AGENT_PRESETS)) {
      const hasBinary = typeof preset.binary === "string" && preset.binary.length > 0;
      const hasTemplate = typeof preset.commandTemplate === "string" && preset.commandTemplate.length > 0;
      expect(hasBinary || hasTemplate).toBe(true);
    }
  });

  test("every preset has a label", () => {
    for (const [id, preset] of Object.entries(AGENT_PRESETS)) {
      expect(preset.label).toBeTruthy();
      expect(typeof preset.label).toBe("string");
    }
  });

  test("traecli preset uses 'acp serve' subcommand (PoC-verified)", () => {
    expect(AGENT_PRESETS.traecli.args).toEqual(["acp", "serve"]);
  });

  test("claude-code preset uses -p flag for headless mode", () => {
    expect(AGENT_PRESETS["claude-code"].args).toContain("-p");
  });

  test("aider preset has installHint pointing to pip", () => {
    expect(AGENT_PRESETS.aider.installHint).toContain("pip");
  });

  test("no duplicate agentIds across clusters", () => {
    const ids = Object.keys(AGENT_PRESETS);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });
});

describe("getPreset", () => {
  test("returns preset for known agentId", () => {
    const preset = getPreset("kimi");
    expect(preset.agentId).toBe("kimi");
    expect(preset.protocol).toBe("acp");
  });

  test("throws on unknown agentId with helpful list", () => {
    expect(() => getPreset("nonexistent-agent")).toThrow(/Unknown agentId/);
    expect(() => getPreset("nonexistent-agent")).toThrow(/opencode/);
  });
});

describe("listPresets", () => {
  test("returns array with id field for UI consumption", () => {
    const list = listPresets();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(60);
    expect(list[0]).toHaveProperty("id");
    expect(list[0]).toHaveProperty("label");
    expect(list[0]).toHaveProperty("protocol");
  });
});

describe("DEFAULT_AGENT_ID", () => {
  test("defaults to opencode for backward compat", () => {
    expect(DEFAULT_AGENT_ID).toBe("opencode");
  });
});
