import { describe, expect, test } from "bun:test";
import { PtySidecarAdapter } from "./pty.js";
import { GenericSidecarAdapter } from "./generic.js";
import { McpSidecarAdapter } from "./mcp.js";
import { AcpSidecarAdapter } from "./acp.js";
import { OpenCodeSidecarAdapter } from "./opencode.js";
import type { AgentSidecarConfig } from "../types.js";

describe("PtySidecarAdapter", () => {
  test("spawns long-running process (cat) and exposes transport info", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-cat",
      protocol: "pty",
      binary: "cat",
      args: [],
    };
    const adapter = new PtySidecarAdapter(config);
    const handle = await adapter.start({ cwd: "/tmp" });

    try {
      expect(handle.protocol).toBe("pty");
      expect(handle.agentId).toBe("test-cat");
      expect(handle.transportInfo.command).toBe("cat");
      expect(handle.isAlive()).toBe(true);
      expect(handle.processId).toBeDefined();
    } finally {
      await handle.stop();
    }
  });

  test("detects binary via preset (uses 'cat' binary)", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-cat",
      protocol: "pty",
      binary: "cat",
    };
    const adapter = new PtySidecarAdapter(config);
    const result = await adapter.detect();
    expect(result.agentId).toBe("test-cat");
    expect(result.available).toBe(true);
    expect(result.binaryPath).toBe("/bin/cat");
  });

  test("detect returns false for missing binary", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-missing",
      protocol: "pty",
      binary: "nonexistent-binary-xyz-123",
    };
    const adapter = new PtySidecarAdapter(config);
    const result = await adapter.detect();
    expect(result.available).toBe(false);
    expect(result.error).toContain("not found in PATH");
  });

  test("throws when no binary specified", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-nobin",
      protocol: "pty",
    };
    const adapter = new PtySidecarAdapter(config);
    await expect(adapter.start({ cwd: "/tmp" })).rejects.toThrow(/requires 'binary' or 'binaryPath'/);
  });

  test("stop() is idempotent", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-cat",
      protocol: "pty",
      binary: "cat",
    };
    const adapter = new PtySidecarAdapter(config);
    const handle = await adapter.start({ cwd: "/tmp" });
    await handle.stop();
    await handle.stop(); // should not throw
  });
});

describe("GenericSidecarAdapter", () => {
  test("spawns long-running process via template", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-generic-cat",
      protocol: "generic",
      binary: "cat",
      args: [],
      commandTemplate: "{binary}",
      outputParser: "none",
    };
    const adapter = new GenericSidecarAdapter(config);
    const handle = await adapter.start({ cwd: "/tmp" });
    try {
      expect(handle.protocol).toBe("generic");
      expect(handle.isAlive()).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  test("throws when neither binary nor commandTemplate specified", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-empty-generic",
      protocol: "generic",
    };
    const adapter = new GenericSidecarAdapter(config);
    await expect(adapter.start({ cwd: "/tmp" })).rejects.toThrow(/requires 'binary' or 'commandTemplate'/);
  });

  test("exposes outputParser property", () => {
    const config: AgentSidecarConfig = {
      agentId: "test-parser",
      protocol: "generic",
      binary: "cat",
      outputParser: "jsonl",
    };
    const adapter = new GenericSidecarAdapter(config);
    expect(adapter.outputParser).toBe("jsonl");
  });
});

describe("McpSidecarAdapter", () => {
  test("spawns a long-running process as MCP stdio server (cat as stand-in)", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-mcp-cat",
      protocol: "mcp",
      binary: "cat",
    };
    const adapter = new McpSidecarAdapter(config);
    const handle = await adapter.start({ cwd: "/tmp" });
    try {
      expect(handle.protocol).toBe("mcp");
      expect(handle.isAlive()).toBe(true);
      expect(handle.transportInfo.command).toBe("cat");
      // MCP_TRANSPORT env should be set to "stdio"
      const mcpTransport = handle.transportInfo.env.find((e) => e.name === "MCP_TRANSPORT");
      expect(mcpTransport?.value).toBe("stdio");
    } finally {
      await handle.stop();
    }
  });

  test("throws when no binary specified", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-mcp-nobin",
      protocol: "mcp",
    };
    const adapter = new McpSidecarAdapter(config);
    await expect(adapter.start({ cwd: "/tmp" })).rejects.toThrow(/requires 'binary' or 'binaryPath'/);
  });
});

describe("AcpSidecarAdapter", () => {
  test("detect returns false for missing binary", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-acp-missing",
      protocol: "acp",
      binary: "nonexistent-acp-agent-xyz",
      args: ["acp"],
    };
    const adapter = new AcpSidecarAdapter(config);
    const result = await adapter.detect();
    expect(result.available).toBe(false);
  });

  test("doctor returns unhealthy when binary not found", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-acp-missing",
      protocol: "acp",
      binary: "nonexistent-acp-agent-xyz",
      args: ["acp"],
    };
    const adapter = new AcpSidecarAdapter(config);
    const doctor = await adapter.doctor();
    expect(doctor.healthy).toBe(false);
    expect(doctor.checks.find((c) => c.name === "binary-exists")?.ok).toBe(false);
  });

  test("throws when no binary specified", async () => {
    const config: AgentSidecarConfig = {
      agentId: "test-acp-nobin",
      protocol: "acp",
    };
    const adapter = new AcpSidecarAdapter(config);
    await expect(adapter.start({ cwd: "/tmp" })).rejects.toThrow(/requires 'binary' or 'binaryPath'/);
  });
});

describe("OpenCodeSidecarAdapter", () => {
  test("protocol is http", () => {
    const config: AgentSidecarConfig = {
      agentId: "opencode-serve",
      protocol: "http",
      binary: "opencode",
    };
    const adapter = new OpenCodeSidecarAdapter(config);
    expect(adapter.protocol).toBe("http");
  });

  test("detect returns false when opencode binary is missing", async () => {
    const config: AgentSidecarConfig = {
      agentId: "opencode-serve-test",
      protocol: "http",
      binary: "nonexistent-opencode-xyz",
    };
    const adapter = new OpenCodeSidecarAdapter(config);
    const result = await adapter.detect();
    expect(result.available).toBe(false);
  });
});
