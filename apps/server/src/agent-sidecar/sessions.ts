/**
 * ACP Session Helper
 *
 * 把 ACP 协议的 session/new + session/prompt + session/update 流
 * 包装成统一的 AsyncIterable<AgentEvent>，与 PtySidecarAdapter.events() 同构。
 *
 * 设计参考：
 * - @agentclientprotocol/sdk 的 SessionBuilder / ActiveSession
 * - PTY 适配器的事件流形态（agent-message-chunk / tool-call / stop / error）
 *
 * 上层 agent-team 的 relay/dispatch/broadcast/fan-out 通过这个 helper
 * 可以把 ACP agent 当成 PTY agent 一样使用，无需在调用点写 type-switch。
 *
 * 不直接调 LLM，只通过 ClientConnection 调 ACP agent。
 */

import * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent } from "./types.js";

/**
 * 把 ACP SessionUpdate 转换为统一 AgentEvent。
 *
 * 映射规则：
 * - agent_message_chunk (text) → { kind: "agent-message-chunk", text }
 * - agent_message_chunk (image) → { kind: "agent-message-chunk-image", mediaType, data }
 * - agent_thought_chunk → { kind: "agent-thought-chunk", text }
 * - user_message_chunk → { kind: "user-message-chunk", text }
 * - tool_call → { kind: "tool-call", toolCallId, title, status }
 * - tool_call_update → { kind: "tool-call-update", toolCallId, status }
 * - plan → { kind: "plan", plan }
 * - 其他（plan_update / available_commands_update / current_mode_update / config_option_update /
 *   session_info_update / usage_update） → 当前不映射，可由上层关注原 update 时另行处理
 */
export function mapSessionUpdateToUpdate(update: acp.SessionUpdate): AgentEvent | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const block = update.content;
      if (block.type === "text") {
        return { kind: "agent-message-chunk", text: block.text };
      }
      if (block.type === "image") {
        return {
          kind: "agent-message-chunk-image",
          mediaType: block.mimeType,
          data: block.data,
        };
      }
      return null;
    }
    case "agent_thought_chunk": {
      const block = update.content;
      if (block.type === "text") {
        return { kind: "agent-thought-chunk", text: block.text };
      }
      return null;
    }
    case "user_message_chunk": {
      const block = update.content;
      if (block.type === "text") {
        return { kind: "user-message-chunk", text: block.text };
      }
      return null;
    }
    case "tool_call": {
      const call = update as Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" }>;
      return {
        kind: "tool-call",
        toolCallId: call.toolCallId ?? "",
        title: call.title ?? call.kind ?? "",
        status: call.status ?? "running",
      };
    }
    case "tool_call_update": {
      const call = update as Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }>;
      return {
        kind: "tool-call-update",
        toolCallId: call.toolCallId ?? "",
        status: call.status ?? "running",
      };
    }
    case "plan": {
      return { kind: "plan", plan: update };
    }
    default:
      // 其他 update 类型暂不映射到统一事件
      return null;
  }
}

/**
 * PromptRequest 的 stop reason → AgentEvent.stop.stopReason
 *
 * ACP SDK 的 StopReason 枚举（截至 v1.3）：
 * - end_turn: 正常结束
 * - max_tokens: 命中 max_tokens 限制
 * - max_turn_requests: 命中 max_turn_requests 限制
 * - refusal: 模型拒绝
 * - cancelled: 被取消
 *
 * 上层若收到未识别的 reason（如未来扩展），直接返回字符串形式。
 */
export function mapStopReason(reason: acp.StopReason | undefined): string {
  if (!reason) return "end";
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "max_turn_requests":
      return "max_turn_requests";
    case "refusal":
      return "refusal";
    case "cancelled":
      return "cancelled";
    default:
      return String(reason);
  }
}

/**
 * Prompt 结算结果：成功拿到 PromptResponse，或失败拿到 Error。
 *
 * 引入这个显式类型是为了绕开 TypeScript 控制流分析对闭包内赋值追踪的限制——
 * `promptResult` 在 Promise 回调中被赋值，TS 在 `await promptPromise` 之后
 * 仍把它推断为初始值 `null`，无法自动收窄到联合类型。
 */
type PromptSettleResult =
  | { ok: true; response: acp.PromptResponse }
  | { ok: false; error: Error };

/**
 * 在 ACP ClientConnection 上创建一个 session，发送 prompt，
 * 然后把 session/update 流转换为 AsyncIterable<AgentEvent>。
 *
 * 完成条件：
 * 1. 收到 stop（PromptResponse） → emit { kind: "stop" }
 * 2. 出错 → emit { kind: "error" }
 * 3. 超时 → emit { kind: "error", error: "timeout" } 并取消 prompt
 *
 * @param conn ACP ClientConnection（已 initialize 握手）
 * @param cwd session 工作目录（必须绝对路径）
 * @param prompt 用户输入文本
 * @param timeoutMs 超时（毫秒），0 表示不超时
 */
export async function* runAcpPrompt(
  conn: acp.ClientConnection,
  cwd: string,
  prompt: string,
  timeoutMs: number = 60_000,
): AsyncGenerator<AgentEvent> {
  // 1. 创建 session
  let session: acp.ActiveSession;
  try {
    session = await conn.agent.buildSession(cwd).start();
  } catch (err) {
    yield {
      kind: "error",
      error: `ACP session/new failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  // 2. 异步发 prompt（不等返回，因为我们要边收 update 边 yield）
  //
  // promptSettled 用于让 nextUpdate 知道 prompt 是否已结束，
  // promptResult 在 await promptPromise 后用类型守卫拿到。
  let promptSettled = false;
  let promptResult: PromptSettleResult | null = null;

  const promptPromise = session
    .prompt(prompt)
    .then((response) => {
      promptSettled = true;
      promptResult = { ok: true, response };
    })
    .catch((err: unknown) => {
      promptSettled = true;
      promptResult = {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    });

  // 3. 轮询 nextUpdate()，转成 AgentEvent yield
  //
  // 每次迭代把 timeout 的剩余时间作为 Promise.race 的一支，
  // 防止 nextUpdate() 永久阻塞导致 timeout 检查无法触发。
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  try {
    while (true) {
      // 计算剩余等待时间
      const remainingMs = deadline > 0 ? Math.max(0, deadline - Date.now()) : 0;
      if (deadline > 0 && remainingMs === 0) {
        // 超时：尝试 cancel 并发 error
        try {
          await conn.agent.notify(acp.methods.agent.session.cancel, {
            sessionId: session.sessionId,
          });
        } catch {
          // ignore
        }
        yield { kind: "error", error: "ACP prompt timeout" };
        return;
      }

      // 等待下一条 update / prompt 完成 / 超时
      const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), remainingMs > 0 ? remainingMs : 1000),
      );

      const updateOrStop = await Promise.race([
        session.nextUpdate().then((msg) => ({ kind: "msg" as const, msg })),
        promptPromise.then(() => ({ kind: "done" as const })),
        timeoutPromise,
      ]);

      if (updateOrStop.kind === "timeout") {
        // 超时：尝试 cancel 并发 error
        try {
          await conn.agent.notify(acp.methods.agent.session.cancel, {
            sessionId: session.sessionId,
          });
        } catch {
          // ignore
        }
        yield { kind: "error", error: "ACP prompt timeout" };
        return;
      }

      if (updateOrStop.kind === "msg") {
        const msg = updateOrStop.msg;
        if (msg.kind === "session_update") {
          const event = mapSessionUpdateToUpdate(msg.update);
          if (event) yield event;
        } else if (msg.kind === "stop") {
          // prompt 已完成，不再有 update
          break;
        }
      } else {
        // promptPromise resolved（可能出错或正常完成）
        break;
      }
    }
  } finally {
    // dispose session（不影响 ACP 协议层 session lifecycle，只释放本地 update 路由）
    try {
      session.dispose();
    } catch {
      // ignore
    }
  }

  // 4. 等待 promptPromise 最终 settle，发 stop 或 error
  //
  // 注意：TypeScript 的控制流分析无法跨闭包追踪 `promptResult` 的赋值，
  // 即使在 `await promptPromise` 之后，`promptResult` 仍被推断为初始类型 `null`。
  // 因此用一个显式类型化的本地副本来收窄。
  await promptPromise;
  const result: PromptSettleResult | null = promptResult as PromptSettleResult | null;
  if (result && result.ok === false) {
    yield { kind: "error", error: result.error.message };
    return;
  }
  if (result && result.ok === true) {
    yield {
      kind: "stop",
      stopReason: mapStopReason(result.response.stopReason),
    };
  } else {
    yield { kind: "stop", stopReason: "end" };
  }
}
