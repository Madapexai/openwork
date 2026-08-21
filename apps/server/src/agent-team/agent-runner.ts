/**
 * Unified Agent Runner
 *
 * 屏蔽 PTY/ACP/Generic 协议差异，提供统一的「向 agent 发 prompt + 收事件流」接口。
 *
 * 上层 agent-team 的 dispatch/relay/broadcast/fan-out 只需调用 runAgentPrompt()，
 * 不必在每个调用点写 if (adapter instanceof PtySidecarAdapter) 之类的 type-switch。
 *
 * 设计参考：
 * - cc-connect 的 capability-based adapter：通过协议路由
 * - paperclip 的 unified runner：抽象层屏蔽 adapter 差异
 *
 * 三种协议的执行路径：
 * - pty/generic: 通过 stdin 写 prompt，从 adapter.events() 收 AgentEvent 流
 * - acp: 调用 runAcpPrompt()（agent-sidecar/sessions.ts），从 ClientConnection 收事件流
 *
 * 不直接调 LLM，只通过 AgentSidecarAdapter 接入。
 */

import type { AgentEvent, AgentSidecarAdapter } from "../agent-sidecar/types.js";
import type { AcpSidecarAdapter } from "../agent-sidecar/adapters/acp.js";
import type { PtySidecarAdapter } from "../agent-sidecar/adapters/pty.js";
import type { GenericSidecarAdapter } from "../agent-sidecar/adapters/generic.js";
import type { GenericCliSidecarAdapter } from "../agent-sidecar/cli-adapter/generic-cli.js";
import { runAcpPrompt } from "../agent-sidecar/sessions.js";

/** 单 agent 执行参数 */
export interface RunAgentPromptParams {
  /** 已启动的 adapter（必须已通过 start()） */
  adapter: AgentSidecarAdapter;
  /** 工作目录（绝对路径，ACP session 需要） */
  cwd: string;
  /** prompt 文本 */
  prompt: string;
  /** 超时（毫秒），0 表示不超时 */
  timeoutMs: number;
}

/**
 * 向已启动的 adapter 发送 prompt，返回事件流。
 *
 * 自动路由到对应协议的执行路径。
 */
export async function* runAgentPrompt(
  params: RunAgentPromptParams,
): AsyncGenerator<AgentEvent> {
  const { adapter, cwd, prompt, timeoutMs } = params;

  switch (adapter.protocol) {
    case "pty":
    case "generic": {
      // 新式 CLI 适配器（GenericCliSidecarAdapter）：走 exec/stream 语义（L2 headless / L1 pty）
      const cliAdapter = adapter as PtySidecarAdapter | GenericSidecarAdapter | GenericCliSidecarAdapter;
      if (typeof (cliAdapter as GenericCliSidecarAdapter).stream === "function") {
        yield* (cliAdapter as GenericCliSidecarAdapter).stream(prompt, { cwd, timeoutMs });
        return;
      }
      yield* runPtyPrompt(cliAdapter as PtySidecarAdapter | GenericSidecarAdapter, prompt, timeoutMs);
      return;
    }
    case "acp": {
      const acpAdapter = adapter as AcpSidecarAdapter;
      const conn = acpAdapter.getClientConnection();
      if (!conn) {
        yield {
          kind: "error",
          error: `ACP adapter '${adapter.agentId}' has no active ClientConnection (not started?)`,
        };
        return;
      }
      yield* runAcpPrompt(conn, cwd, prompt, timeoutMs);
      return;
    }
    case "mcp": {
      // MCP 是工具协议，不是会话主体，prompt 流不适用
      yield {
        kind: "error",
        error: `MCP adapter '${adapter.agentId}' does not support prompt-based execution (use as tool server)`,
      };
      return;
    }
    case "http": {
      // HTTP agent（如 opencode serve）通过 REST API 处理，本 runner 不覆盖
      // 调用方应通过 OpenCode HTTP client 而非 agent-team 模块
      yield {
        kind: "error",
        error: `HTTP adapter '${adapter.agentId}' must be invoked via REST API, not agent-team runner`,
      };
      return;
    }
    default: {
      // 穷尽性检查
      const _exhaustive: never = adapter.protocol;
      void _exhaustive;
      yield {
        kind: "error",
        error: `Unknown protocol: ${String(adapter.protocol)}`,
      };
      return;
    }
  }
}

/**
 * PTY/Generic 协议执行：写 stdin + 收 events() 流
 */
async function* runPtyPrompt(
  adapter: PtySidecarAdapter | GenericSidecarAdapter,
  prompt: string,
  timeoutMs: number,
): AsyncGenerator<AgentEvent> {
  // 写 prompt 到 stdin
  const stdin = (adapter as PtySidecarAdapter).stdin;
  if (stdin && typeof stdin.write === "function") {
    try {
      stdin.write(prompt + "\n");
    } catch (err) {
      yield {
        kind: "error",
        error: `Failed to write to stdin: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }
  }

  const eventsFn = (adapter as PtySidecarAdapter).events;
  if (typeof eventsFn !== "function") {
    yield {
      kind: "error",
      error: `Adapter '${adapter.agentId}' does not expose events()`,
    };
    return;
  }

  const deadline = Date.now() + timeoutMs;
  try {
    for await (const event of eventsFn.call(adapter)) {
      yield event;
      if (event.kind === "stop") break;
      if (event.kind === "error") break;
      if (timeoutMs > 0 && Date.now() > deadline) {
        yield { kind: "error", error: "prompt timeout" };
        return;
      }
    }
  } catch (err) {
    yield {
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
