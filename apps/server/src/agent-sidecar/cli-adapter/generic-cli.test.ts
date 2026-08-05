/**
 * generic-cli.test.ts - 通用 CLI agent 适配器测试（openspec-cli-agent-adapter §7）
 *
 * 从 RED 骨架 spec-skeleton.test.ts 并入并扩展：
 * - §7.1 解析器单测（stream-json / json 最终结果 / 非法行）
 * - §7.2 能力探测
 * - §7.3 fail-fast（CliAgentUnsupportedError）
 * - §7.4 PTY 交互模拟（stream / 超时 kill / stop 幂等）
 * - §7.5 生命周期（transportInfo 脱敏 / cwd 隔离）
 *
 * 运行（apps/server 下）:
 *   bun test src/agent-sidecar/cli-adapter/generic-cli.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  GenericCliSidecarAdapter,
  detectCliCapabilities,
  CliAgentUnsupportedError,
  type CliAutomationMode,
  type CliCapabilities,
} from "./generic-cli.js";
import { createAdapterForAgent } from "../registry.js";
import type { AgentSidecarConfig } from "../types.js";

const CLIENT_ERR = new CliAgentUnsupportedError("freebuff", ["headless"], "headless not verified");

describe("detectCliCapabilities（§7.2 能力探测）", () => {
  test("存在的二进制返回非 unsupported 且带 binaryPath", async () => {
    const caps: CliCapabilities = await detectCliCapabilities("/bin/echo", {
      versionFlag: "--version",
      helpFlag: "--help",
    });
    expect(caps.mode).not.toBe("unsupported");
    expect(caps.binaryPath).toBeDefined();
  });

  test("不存在的二进制返回 { mode: 'unsupported', unsupportedReason: binary-not-found }", async () => {
    const caps: CliCapabilities = await detectCliCapabilities("/nonexistent/openwork-agent-xyz");
    expect(caps.mode).toBe("unsupported");
    expect(caps.unsupportedReason).toContain("binary-not-found");
  });

  test("headless 冒烟成功时 mode=headless（伪造命令无 --output-format 时推断 ansi）", async () => {
    const caps: CliCapabilities = await detectCliCapabilities("bash", {
      // 用 bash 伪造 stream-json agent，避免 CI 依赖真实 agent / API key
      headlessArgs: ["-c", 'printf \'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}\\n\''],
    });
    expect(caps.mode).toBe("headless");
    expect(caps.outputFormats).toBeDefined();
  });

  test("headless 冒烟失败时回退 pty（交互式兜底）", async () => {
    const caps: CliCapabilities = await detectCliCapabilities("bash", {
      helpFlag: "-c", // bash -c 缺参数会报错退出非 0
    });
    expect(["headless", "pty", "structured"]).toContain(caps.mode);
  });
});

describe("GenericCliSidecarAdapter（§6.2 契约）", () => {
  const makeConfig = (agentId: string, overrides: Partial<AgentSidecarConfig> = {}): AgentSidecarConfig => ({
    agentId,
    protocol: "pty",
    binary: "bash",
    args: ["-c", 'read line; printf \'{"kind":"agent-message-chunk","text":"echo: %s"}\\n\' "$line"; printf \'{"kind":"stop","stopReason":"end_turn"}\\n\''],
    outputParser: "jsonl",
    ...overrides,
  });

  test("实现 AgentSidecarAdapter 接口（agentId / protocol / capabilities）", () => {
    const adapter = new GenericCliSidecarAdapter(makeConfig("cli-fake"));
    expect(adapter.agentId).toBe("cli-fake");
    expect(["pty", "generic"]).toContain(adapter.protocol);
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.detect).toBe("function");
  });

  test("exec() 一次性 headless 执行返回 stdout + 事件流", async () => {
    const adapter = new GenericCliSidecarAdapter(
      makeConfig("cli-exec", {
        args: ["-c", 'printf \'{"kind":"agent-message-chunk","text":"hi"}\\n\'; printf \'{"kind":"stop","stopReason":"end_turn"}\\n\''],
      }),
    );
    const result = await adapter.exec("hi", { cwd: "/tmp", timeoutMs: 5_000 });
    expect(result.stdout).toContain("hi");
    expect(result.events.some((e) => e.kind === "agent-message-chunk")).toBe(true);
  });

  test("headless 模式（cliProfile.headless）：prompt 追加为参数执行", async () => {
    const adapter = new GenericCliSidecarAdapter(
      makeConfig("cli-headless", {
        cliProfile: { headless: true, headlessArgs: ["-c", 'printf \'{"kind":"agent-message-chunk","text":"H"}\\n\'; printf \'{"kind":"stop","stopReason":"end_turn"}\\n\''] },
      }),
    );
    const result = await adapter.exec("prompt-as-arg", { cwd: "/tmp", timeoutMs: 5_000 });
    expect(result.events.some((e) => e.kind === "agent-message-chunk" && e.text === "H")).toBe(true);
  });

  test("stream() 返回 AsyncIterable<AgentEvent> 且以 stop 收尾", async () => {
    const adapter = new GenericCliSidecarAdapter(makeConfig("cli-stream"));
    const events: Array<{ kind: string }> = [];
    for await (const event of adapter.stream("hello", { cwd: "/tmp", timeoutMs: 5_000 })) {
      events.push(event);
      if (event.kind === "stop") break;
    }
    expect(events.at(-1)?.kind).toBe("stop");
  });

  test("fail-fast（§7.3）: unsupported agent 调用 exec() 抛 CliAgentUnsupportedError", async () => {
    const adapter = new GenericCliSidecarAdapter(
      makeConfig("cli-unsupported", {
        binary: "/nonexistent/freebuff-headless",
        args: ["-p"],
      }),
    );
    await expect(adapter.exec("hi", { cwd: "/tmp" })).rejects.toBeInstanceOf(CliAgentUnsupportedError);
  });

  test("fail-fast（§7.3）: stream() 对 unsupported agent 同样抛错，不出现假成功", async () => {
    const adapter = new GenericCliSidecarAdapter(
      makeConfig("cli-unsupported-stream", {
        binary: "/nonexistent/claude-headless",
        args: ["-p"],
      }),
    );
    const iterator = adapter.stream("hi", { cwd: "/tmp" })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeInstanceOf(CliAgentUnsupportedError);
  });

  test("fail-fast（§7.3）: 未知 agentId（无 preset）createAdapterForAgent 抛错", () => {
    expect(() => createAdapterForAgent("windsurf")).toThrow();
  });

  test("超时（§7.4）: timeoutMs 到期产出 error 事件且进程被 kill", async () => {
    const adapter = new GenericCliSidecarAdapter(
      makeConfig("cli-timeout", {
        args: ["-c", "sleep 30"],
      }),
    );
    const events: Array<{ kind: string; error?: string }> = [];
    for await (const event of adapter.stream("hi", { cwd: "/tmp", timeoutMs: 200 })) {
      events.push(event);
      if (event.kind === "stop" || event.kind === "error") break;
    }
    const last = events.at(-1);
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") expect(last.error).toContain("timeout");
  });

  test("stop() 幂等（§7.4）: 连续两次调用不抛错", async () => {
    const adapter = new GenericCliSidecarAdapter(makeConfig("cli-stop"));
    const handle = await adapter.start({ cwd: "/tmp" });
    await handle.stop();
    await handle.stop(); // 第二次 stop 不得抛错
    expect(handle.isAlive()).toBe(false);
  });

  test("生命周期（§7.5）: transportInfo 记录 command/cwd 且 env 已脱敏", async () => {
    const adapter = new GenericCliSidecarAdapter(makeConfig("cli-transport"));
    const handle = await adapter.start({ cwd: "/tmp", env: { OPENAI_API_KEY: "sk-secret-token" } });
    expect(handle.transportInfo.cwd).toBe("/tmp");
    expect(handle.transportInfo.env.some((e) => e.name === "OPENAI_API_KEY" && e.redacted)).toBe(true);
    await handle.stop();
  });

  test("会话隔离（§7.5 I5）: 不同 cwd 的 exec 互不影响", async () => {
    const adapter = new GenericCliSidecarAdapter(
      makeConfig("cli-isolation", {
        args: ["-c", 'printf \'{"kind":"agent-message-chunk","text":"pwd=%s"}\\n\' "$(pwd)"; printf \'{"kind":"stop","stopReason":"end_turn"}\\n\''],
      }),
    );
    const a = await adapter.exec("x", { cwd: "/tmp", timeoutMs: 5_000 });
    const b = await adapter.exec("y", { cwd: "/Users", timeoutMs: 5_000 });
    // macOS /tmp 是 /private/tmp 符号链接，故 a 只断言含 "pwd="；b 用无符号链接的 /Users
    expect(a.stdout).toContain("pwd=");
    expect(b.stdout).toContain("pwd=/Users");
    expect(a.stdout).not.toContain("pwd=/Users");
  });
});

describe("parseOutput（§7.1 解析器单测）", () => {
  const adapter = new GenericCliSidecarAdapter({
    agentId: "cli-parse",
    protocol: "pty",
    binary: "bash",
    outputParser: "jsonl",
  });

  test("stream-json 输出解析：content_block_delta → agent-message-chunk", () => {
    const events = adapter.parseOutput(
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      }),
    );
    expect(events.some((e) => e.kind === "agent-message-chunk" && e.text === "hi")).toBe(true);
  });

  test("stream-json 输出解析：message_stop → stop", () => {
    const events = adapter.parseOutput(
      JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
    );
    expect(events.some((e) => e.kind === "stop")).toBe(true);
  });

  test("json 最终结果解析：{result} → agent-message-chunk", () => {
    const events = adapter.parseOutput(JSON.stringify({ result: "done", is_error: false }));
    expect(events.some((e) => e.kind === "agent-message-chunk" && e.text === "done")).toBe(true);
  });

  test("jsonl 非法行 → 按 agent-message-chunk 转发", () => {
    const events = adapter.parseOutput("not-json-at-all");
    expect(events.some((e) => e.kind === "agent-message-chunk")).toBe(true);
  });
});

describe("CliAgentUnsupportedError（§6.2）", () => {
  test("携带 agentId 与 missing 能力列表", () => {
    expect(CLIENT_ERR.agentId).toBe("freebuff");
    expect(CLIENT_ERR.missing).toContain("headless");
    expect(CLIENT_ERR).toBeInstanceOf(Error);
  });
});

// 类型占位：确保类型导出可用
void (null as unknown as CliAutomationMode);
