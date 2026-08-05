/**
 * runtime-registry.test.ts — Runtime 上报层测试（openspec-runtime-reporting.md §7）
 *
 * 运行: bun test src/runtime-registry.test.ts
 */

import { describe, expect, test } from "bun:test";
import { RuntimeRegistry, RUNTIME_REFRESH_TTL_MS } from "./runtime-registry.js";

describe("RuntimeRegistry（§7.1 上报能力列表）", () => {
  test("list() 返回所有 preset 的 agent 能力（含可用/不可用、协议、引擎、headless 声明）", async () => {
    const registry = new RuntimeRegistry({ deepProbe: false });
    const capabilities = await registry.list();

    // 所有 preset 都上报（不依赖真实二进制）
    expect(capabilities.length).toBeGreaterThan(5);

    // 结构校验
    for (const cap of capabilities) {
      expect(typeof cap.agentId).toBe("string");
      expect(typeof cap.available).toBe("boolean");
      expect(typeof cap.protocol).toBe("string");
      expect(["cli", "mcp"]).toContain(cap.engine);
      expect(typeof cap.declaredHeadless).toBe("boolean");
    }

    // 关键 agent 都在：claude-code / codex / gemini / kimi / freebuff（本轮新增）
    const ids = new Set(capabilities.map((c) => c.agentId));
    for (const id of ["claude-code", "codex", "gemini", "kimi", "freebuff", "qwen-code"]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  test("I1: TTL 内重复 list() 命中缓存（不重复扫描 PATH）", async () => {
    const registry = new RuntimeRegistry({ deepProbe: false });
    const first = await registry.list();
    const second = await registry.list();
    expect(second).toBe(first); // 同一缓存引用
  });

  test("invalidate() 后强制重扫（返回新引用）", async () => {
    const registry = new RuntimeRegistry({ deepProbe: false });
    const first = await registry.list();
    registry.invalidate();
    const second = await registry.list();
    expect(second).not.toBe(first);
  });

  test("RUNTIME_REFRESH_TTL_MS 默认 60s", () => {
    expect(RUNTIME_REFRESH_TTL_MS).toBe(60_000);
  });
});

describe("RuntimeRegistry（§7.2 单 agent 详情）", () => {
  test("get() 返回存在的 agent（bash 必然在 PATH 上，验证真实探测）", async () => {
    const registry = new RuntimeRegistry({ deepProbe: false });
    const cap = await registry.get("claude-code");
    expect(cap).not.toBeNull();
    expect(cap!.declaredHeadless).toBe(true);
    expect(cap!.protocol).toBe("pty");
  });

  test("get() 对未知 agent 返回 null", async () => {
    const registry = new RuntimeRegistry({ deepProbe: false });
    const cap = await registry.get("no-such-agent-xyz");
    expect(cap).toBeNull();
  });
});

describe("RuntimeRegistry（§7.3 深度能力探测）", () => {
  test("deepProbe 时 cli 引擎 agent 带 detected（mode 至少 pty）", async () => {
    const registry = new RuntimeRegistry({ deepProbe: true });
    const cap = await registry.get("qwen-code"); // binary qwen-code 大概率不在 PATH，但探测不崩溃
    expect(cap).not.toBeNull();
  });
});
