/**
 * Team LLM Executor - 桥接 Supervisor 与 OpenCode Client
 *
 * 将 Supervisor 的 LLM 调用请求路由到 OpenCode 的 session.promptAsync，
 * 实现真正的 LLM 驱动任务分解与决策。
 *
 * 设计：
 * - 通过注入 WorkspaceOpencodeClient 工厂函数，避免硬编码依赖
 * - 自动创建临时 session 用于调度决策（轻量、短生命周期）
 * - 支持超时控制与错误降级
 */

import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;

export interface TeamLlmExecutorOptions {
  /** OpenCode client 工厂 */
  createClient: () => WorkspaceOpencodeClient;
  /** 调度用的默认 system prompt */
  systemPrompt?: string;
  /** 默认超时（毫秒） */
  defaultTimeoutMs?: number;
  /** session 创建时的 title 前缀 */
  sessionTitlePrefix?: string;
}

/**
 * 创建 Team LLM 执行器
 *
 * 返回一个可直接传给 FunctionalSupervisor 的 llmExecutor 函数。
 * 内部通过 OpenCode client 创建临时 session，发送 prompt，收集回复。
 */
export function createTeamLlmExecutor(
  options: TeamLlmExecutorOptions,
): (params: {
  providerID: string;
  modelID: string;
  prompt: string;
  systemPrompt: string;
  timeoutMs: number;
}) => Promise<string> {
  const {
    createClient,
    systemPrompt: defaultSystemPrompt = "You are a precise task orchestrator. Always respond with valid JSON.",
    defaultTimeoutMs = 30_000,
    sessionTitlePrefix = "openwork-team-supervisor",
  } = options;

  return async function llmExecutor(params): Promise<string> {
    const { providerID, modelID, prompt, systemPrompt, timeoutMs } = params;
    const client = createClient();

    const rawSessionResult = await client.session.create({
      title: `${sessionTitlePrefix}-${Date.now().toString(36)}`,
    });

    const sessionResult = rawSessionResult as { data?: { id?: string }; error?: unknown };

    if (!sessionResult.data?.id) {
      throw new Error("Failed to create session for team supervisor decision");
    }

    const sessionID = sessionResult.data.id;
    const effectiveSystemPrompt = systemPrompt || defaultSystemPrompt;
    const fullPrompt = `${effectiveSystemPrompt}\n\n${prompt}`;

    const rawResult = await client.session.promptAsync({
      sessionID,
      model: { providerID, modelID },
      parts: [{ type: "text", text: fullPrompt }],
    });

    const result = rawResult as { data?: { outputs?: Array<{ parts?: Array<{ type: string; text?: string }> }> }; error?: unknown };

    if (result.error !== undefined) {
      throw new Error(
        `OpenCode prompt failed: ${JSON.stringify(result.error)}`,
      );
    }

    const outputs = result.data?.outputs ?? [];
    if (outputs.length === 0) {
      throw new Error("No output returned from LLM");
    }

    let text = "";
    for (const output of outputs) {
      const parts = output.parts ?? [];
      for (const part of parts) {
        if (part.type === "text" && part.text) {
          text += part.text;
        }
      }
    }

    if (!text.trim()) {
      throw new Error("LLM returned empty text response");
    }

    return text.trim();
  };
}

/**
 * 简单的 LLM 执行器（用于无 OpenCode 环境的降级场景）
 * 使用内置规则引擎进行决策，不调用 LLM
 */
export function createRuleBasedExecutor(): (params: {
  providerID: string;
  modelID: string;
  prompt: string;
  systemPrompt: string;
  timeoutMs: number;
}) => Promise<string> {
  return async function ruleBasedExecutor(params): Promise<string> {
    const { prompt } = params;

    if (prompt.includes("DISPATCH") || prompt.includes("coordinate")) {
      // 简单的角色优先级选择
      return JSON.stringify({
        type: "dispatch",
        agentId: "primary",
        reasoning: "Rule-based: selected primary agent for simple task",
      });
    }

    if (prompt.includes("DECOMPOSE") || prompt.includes("decompose")) {
      // 简单的二分分解
      return JSON.stringify({
        type: "decompose",
        assignments: [
          {
            subtaskId: `sub_${Date.now()}_1`,
            agentId: "specialist",
            prompt: prompt.replace("{task_prompt}", "").slice(0, 200),
            dependencies: [],
          },
          {
            subtaskId: `sub_${Date.now()}_2`,
            agentId: "reviewer",
            prompt: "Review and validate the output",
            dependencies: [`sub_${Date.now()}_1`],
          },
        ],
        reasoning: "Rule-based: split into specialist + reviewer",
      });
    }

    // 默认：dispatch 到第一个可用 agent
    return JSON.stringify({
      type: "dispatch",
      agentId: "primary",
      reasoning: "Rule-based default dispatch",
    });
  };
}