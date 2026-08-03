import { describe, expect, test, beforeEach } from "bun:test";
// 导入 index.js 以触发 registerBuiltinAdapters()
import { registerBuiltinAdapters } from "./index.js";
import {
  registerAdapter,
  unregisterAdapter,
  listRegisteredProtocols,
  createAdapter,
  createAdapterForAgent,
} from "./registry.js";
import { GenericSidecarAdapter } from "./adapters/generic.js";
import { AcpSidecarAdapter } from "./adapters/acp.js";
import type { AgentSidecarAdapter, AgentSidecarConfig, SidecarHandle, SidecarStartOptions } from "./types.js";

class FakeAdapter implements AgentSidecarAdapter {
  readonly protocol = "generic" as const;
  constructor(private readonly config: AgentSidecarConfig) {}
  get agentId() { return this.config.agentId; }
  get displayName() { return `Fake-${this.config.agentId}`; }
  async start(_options: SidecarStartOptions): Promise<SidecarHandle> {
    return {
      protocol: this.protocol,
      agentId: this.config.agentId,
      transportInfo: { command: "fake", args: [], cwd: "", env: [] },
      isAlive: () => false,
      stop: async () => {},
    };
  }
  async detect() {
    return { agentId: this.config.agentId, available: true };
  }
  async doctor() {
    return { agentId: this.config.agentId, healthy: true, binaryName: "fake", checks: [] };
  }
}

describe("registry", () => {
  // 每个测试前重置为内置状态，避免相互污染
  beforeEach(() => {
    registerBuiltinAdapters();
  });

  test("builtin protocols are registered on import", () => {
    const protocols = listRegisteredProtocols();
    expect(protocols).toContain("acp");
    expect(protocols).toContain("http");
    expect(protocols).toContain("pty");
    expect(protocols).toContain("mcp");
    expect(protocols).toContain("generic");
  });

  test("registerAdapter replaces existing protocol factory", () => {
    registerAdapter("generic", (config) => new FakeAdapter(config));
    const fakeConfig: AgentSidecarConfig = {
      agentId: "test-fake",
      protocol: "generic",
    };
    const adapter = createAdapter(fakeConfig);
    expect(adapter).toBeInstanceOf(FakeAdapter);
  });

  test("unregisterAdapter removes protocol from list", () => {
    unregisterAdapter("generic");
    expect(listRegisteredProtocols()).not.toContain("generic");
  });

  test("createAdapter throws on unknown protocol with helpful message", () => {
    unregisterAdapter("acp");
    const unknownConfig: AgentSidecarConfig = {
      agentId: "test-unknown",
      protocol: "acp",
    };
    expect(() => createAdapter(unknownConfig)).toThrow(/No adapter registered for protocol 'acp'/);
  });

  test("createAdapterForAgent loads from preset and overrides", () => {
    const adapter = createAdapterForAgent("kimi", {
      binaryPath: "/custom/path/to/kimi",
    });
    expect(adapter.agentId).toBe("kimi");
    expect(adapter.protocol).toBe("acp");
    expect(adapter.displayName).toBe("Kimi Code");
  });

  test("createAdapterForAgent throws on unknown agentId", () => {
    expect(() => createAdapterForAgent("does-not-exist")).toThrow(/Unknown agentId/);
  });

  test("GenericSidecarAdapter is the default factory for 'generic' protocol", () => {
    const config: AgentSidecarConfig = {
      agentId: "test-default-generic",
      protocol: "generic",
      binary: "cat",
    };
    const adapter = createAdapter(config);
    expect(adapter).toBeInstanceOf(GenericSidecarAdapter);
  });

  test("AcpSidecarAdapter is the default factory for 'acp' protocol", () => {
    const config: AgentSidecarConfig = {
      agentId: "test-default-acp",
      protocol: "acp",
      binary: "kimi",
      args: ["acp"],
    };
    const adapter = createAdapter(config);
    expect(adapter).toBeInstanceOf(AcpSidecarAdapter);
  });
});
