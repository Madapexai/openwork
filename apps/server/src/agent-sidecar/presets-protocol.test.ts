import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  selectPresetForAgent,
  resolveExecutionMode,
  DEFAULT_PROTOCOL_PREFERENCE,
  DEFAULT_AGENT_ID,
} from "./presets.js";

describe("presets.protocol-preference", () => {
  test("DEFAULT_PROTOCOL_PREFERENCE follows acp > http > headless-oneshot > pty", () => {
    expect(DEFAULT_PROTOCOL_PREFERENCE).toEqual(["acp", "http", "headless-oneshot", "pty"]);
  });

  test("DEFAULT_AGENT_ID is opencode", () => {
    expect(DEFAULT_AGENT_ID).toBe("opencode");
  });

  test("selectPresetForAgent(opencode) picks http altPreset over acp main (preferProtocolOrder: http > acp)", () => {
    const preset = selectPresetForAgent("opencode");
    expect(preset.protocol).toBe("http");
    expect(preset.args).toEqual(["serve", "--cors", "*", "--hostname", "127.0.0.1"]);
  });

  test("selectPresetForAgent(kimi) picks acp by default (preferProtocolOrder: acp > headless-oneshot > pty)", () => {
    const preset = selectPresetForAgent("kimi");
    expect(preset.protocol).toBe("acp");
  });

  test("selectPresetForAgent(kimi) with explicit protocol=pty picks headless-oneshot altPreset", () => {
    const preset = selectPresetForAgent("kimi", {
      protocol: "pty",
    });
    expect(preset.protocol).toBe("pty");
  });

  test("selectPresetForAgent(freebuff) protocol remains pty (base has preferProtocolOrder headless-oneshot > pty, but executionMode=persistent-pty)", () => {
    const preset = selectPresetForAgent("freebuff");
    expect(preset.protocol).toBe("pty");
    const mode = resolveExecutionMode(preset);
    expect(mode).toBe("persistent-pty");
  });

  test("selectPresetForAgent(claude-code) picks pty with headless-oneshot executionMode", () => {
    const preset = selectPresetForAgent("claude-code");
    expect(preset.protocol).toBe("pty");
    const mode = resolveExecutionMode(preset);
    expect(mode).toBe("headless-oneshot");
  });

  test("selectPresetForAgent(gemini) picks pty with headless-oneshot executionMode", () => {
    const preset = selectPresetForAgent("gemini");
    expect(preset.protocol).toBe("pty");
    const mode = resolveExecutionMode(preset);
    expect(mode).toBe("headless-oneshot");
  });

  test("selectPresetForAgent(claude-code) forced headless-oneshot picks headless altPreset", () => {
    const preset = selectPresetForAgent("claude-code", {
      executionMode: "headless-oneshot",
    });
    const mode = resolveExecutionMode(preset);
    expect(mode).toBe("headless-oneshot");
  });

  test("selectPresetForAgent(pr-agent) picks headless-oneshot (code review one-shot)", () => {
    const preset = selectPresetForAgent("pr-agent");
    expect(preset.protocol).toBe("pty");
    const mode = resolveExecutionMode(preset);
    expect(mode).toBe("headless-oneshot");
  });

  test("selectPresetForAgent(tongyi-lingma) picks persistent-pty (interactive chinese assistant)", () => {
    const preset = selectPresetForAgent("tongyi-lingma");
    expect(preset.protocol).toBe("pty");
    const mode = resolveExecutionMode(preset);
    expect(mode).toBe("persistent-pty");
  });

  test("selectPresetForAgent(cursor-agent) picks persistent-pty", () => {
    const preset = selectPresetForAgent("cursor-agent");
    expect(preset.protocol).toBe("pty");
    const mode = resolveExecutionMode(preset);
    expect(mode).toBe("persistent-pty");
  });

  test("selectPresetForAgent(opencode) with forced protocol=acp picks main acp preset", () => {
    const preset = selectPresetForAgent("opencode", {
      protocol: "acp",
    });
    expect(preset.protocol).toBe("acp");
  });

  test("selectPresetForAgent(opencode) with preferProtocolOrder forcing pty falls through to acp (no pty altPreset on opencode)", () => {
    const preset = selectPresetForAgent("opencode", {
      preferProtocolOrder: ["pty", "acp", "http"],
    });
    expect(preset.protocol).toBe("acp");
  });

  test("throws on unknown agentId", () => {
    expect(() => selectPresetForAgent("does-not-exist")).toThrow(/Unknown agentId/);
  });
});
