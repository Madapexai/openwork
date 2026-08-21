/**
 * Supervisor - LLM 驱动的智能任务路由
 *
 * 借鉴 LobeHub 的 Supervisor Prompt 与 Orca 的 Coordinator Agent 模式，
 * 使用 LLM 来动态决定如何分解任务、选择哪个 agent、以什么顺序执行。
 *
 * 核心能力：
 * - decompose(task, members): 让 LLM 将复杂任务分解为子任务并分配给 agent
 * - coordinate(task, members): 让 LLM 选择最合适的 agent 执行
 * - review(output, members): 让 LLM 审查产出并决定是否需要迭代
 *
 * 与静态 dispatchPolicy 的区别：
 * - 静态：规则匹配（round-robin / capability-match）
 * - Supervisor：LLM 理解任务语义，动态决策
 */

import type { AgentTeamMember, MemberRole } from "./types.js";
import type { AgentEvent } from "../agent-sidecar/types.js";

export interface SupervisorConfig {
  /** 用于调度的 LLM providerID（如 "ollama", "openrouter"） */
  providerID: string;
  /** 用于调度的模型 ID（如 "qwen2.5:72b", "claude-opus-4"） */
  modelID: string;
  /** 调度 prompt 模板（可选，覆盖默认模板） */
  promptTemplate?: string;
  /** 最大子任务数（防止 LLM 过度分解） */
  maxSubtasks?: number;
  /** 是否启用 review 循环 */
  enableReviewLoop?: boolean;
  /** review 循环最大轮次 */
  maxReviewRounds?: number;
  /** 超时（毫秒） */
  timeoutMs?: number;
}

export interface SupervisorDecision {
  /** 决策类型 */
  type: "dispatch" | "decompose" | "review" | "escalate";
  /** 目标 agentId（dispatch 时） */
  agentId?: string;
  /** 子任务分配（decompose 时） */
  assignments?: Array<{
    subtaskId: string;
    agentId: string;
    prompt: string;
    dependencies?: string[];
  }>;
  /** 审查反馈（review 时） */
  feedback?: string;
  /** 是否需要迭代 */
  needsIteration?: boolean;
}

export interface SubTaskAssignment {
  subtaskId: string;
  agentId: string;
  prompt: string;
  dependencies: string[];
}

/**
 * 默认 Supervisor Prompt 模板
 */
const DEFAULT_SUPERVISOR_PROMPT = `You are a task orchestrator managing a team of AI agents. Analyze the task and decide how to execute it optimally.

## Available Team Members
{members_desc}

## Task
{task_prompt}

## Decision Framework
Choose one:
1. **DISPATCH**: Simple task → assign to the most suitable single agent
2. **DECOMPOSE**: Complex task → break into subtasks, assign each to best agent, specify dependencies
3. **REVIEW**: Quality check → assign to reviewer agent for verification

Output valid JSON only:
{{
  "type": "dispatch|decompose|review",
  "agentId": "agent_id_for_dispatch",
  "assignments": [
    {{"subtaskId": "sub_1", "agentId": "agent_id", "prompt": "sub-prompt", "dependencies": []}}
  ],
  "reasoning": "why this decision"
}}`;

export class Supervisor {
  protected readonly config: SupervisorConfig;

  constructor(config: SupervisorConfig) {
    this.config = config;
  }

  /**
   * 分解任务为子任务并分配给 team members
   *
   * 这是 Supervisor 的核心方法：将复杂任务交给 LLM 分析，
   * 由 LLM 决定如何拆分子任务、分配给哪个 agent、以及依赖关系。
   */
  async decompose(
    taskPrompt: string,
    members: AgentTeamMember[],
  ): Promise<SubTaskAssignment[]> {
    const prompt = this.buildDecomposePrompt(taskPrompt, members);
    const decision = await this.callSupervisor(prompt);

    if (decision.type === "decompose" && decision.assignments && decision.assignments.length > 0) {
      return decision.assignments.map((a) => ({
        subtaskId: a.subtaskId,
        agentId: a.agentId,
        prompt: a.prompt,
        dependencies: a.dependencies ?? [],
      }));
    }

    // 降级：如果 LLM 没有返回合理的分解，返回单 agent 分配
    if (decision.type === "dispatch" && decision.agentId) {
      return [
        {
          subtaskId: `sub_${Date.now()}`,
          agentId: decision.agentId,
          prompt: taskPrompt,
          dependencies: [],
        },
      ];
    }

    // 兜底：分配给第一个成员
    const firstMember = members.find((m) => m.role === "primary") ?? members[0];
    if (!firstMember) {
      throw new Error("No team members available for task decomposition");
    }
    return [
      {
        subtaskId: `sub_${Date.now()}`,
        agentId: firstMember.agentId,
        prompt: taskPrompt,
        dependencies: [],
      },
    ];
  }

  /**
   * 选择最合适的单个 agent 执行任务
   */
  async coordinate(
    taskPrompt: string,
    members: AgentTeamMember[],
  ): Promise<string> {
    const prompt = this.buildCoordinatePrompt(taskPrompt, members);
    const decision = await this.callSupervisor(prompt);

    if (decision.agentId && members.some((m) => m.agentId === decision.agentId)) {
      return decision.agentId;
    }

    // 降级：返回 primary 角色
    const primary = members.find((m) => m.role === "primary");
    if (primary) return primary.agentId;

    // 兜底：第一个成员
    if (members.length > 0) return members[0]!.agentId;
    throw new Error("No team members available");
  }

  /**
   * 审查 agent 产出并决定是否需要迭代
   */
  async review(
    output: string,
    originalPrompt: string,
    members: AgentTeamMember[],
    reviewerId?: string,
  ): Promise<{ approved: boolean; feedback: string; reviserId?: string }> {
    const prompt = this.buildReviewPrompt(output, originalPrompt, members, reviewerId);
    const decision = await this.callSupervisor(prompt);

    if (decision.type === "review") {
      return {
        approved: !decision.needsIteration,
        feedback: decision.feedback ?? "",
        reviserId: decision.agentId,
      };
    }

    // 降级：默认通过
    return { approved: true, feedback: "" };
  }

  /**
   * 获取 Supervisor 配置
   */
  getConfig(): SupervisorConfig {
    return { ...this.config };
  }

  // ---------- Prompt 构建 ----------

  private buildDecomposePrompt(taskPrompt: string, members: AgentTeamMember[]): string {
    const template = this.config.promptTemplate ?? DEFAULT_SUPERVISOR_PROMPT;
    const membersDesc = members
      .map((m) => {
        const roleDesc = m.role ? ` (role: ${m.role})` : "";
        const caps = m.capabilities ?? m.adapter.capabilities;
        const capDesc = caps
          ? Object.entries(caps)
              .filter(([, v]) => v === true)
              .map(([k]) => k)
              .join(", ")
          : "unknown";
        return `- ${m.agentId}${roleDesc}: capabilities=[${capDesc}]`;
      })
      .join("\n");

    return template
      .replace("{members_desc}", membersDesc)
      .replace("{task_prompt}", taskPrompt);
  }

  private buildCoordinatePrompt(taskPrompt: string, members: AgentTeamMember[]): string {
    const membersDesc = members
      .map((m) => {
        const roleDesc = m.role ? ` (role: ${m.role})` : "";
        return `- ${m.agentId}${roleDesc}`;
      })
      .join("\n");

    return `You are a task coordinator. Select the best agent for this task.\n\nAvailable agents:\n${membersDesc}\n\nTask:\n${taskPrompt}\n\nRespond with JSON: {"agentId": "...", "reasoning": "..."}`;
  }

  private buildReviewPrompt(
    output: string,
    originalPrompt: string,
    members: AgentTeamMember[],
    reviewerId?: string,
  ): string {
    const reviewers = reviewerId
      ? members.filter((m) => m.agentId === reviewerId)
      : members.filter((m) => m.role === "reviewer");
    const reviewerList = reviewers.length > 0
      ? reviewers.map((r) => r.agentId).join(", ")
      : members.map((m) => m.agentId).join(", ");

    return `You are a quality reviewer. Review the output against the original task and decide if it's acceptable.\n\nOriginal task:\n${originalPrompt}\n\nOutput to review:\n${output}\n\nAvailable reviewer agents: ${reviewerList}\n\nRespond with JSON: {"approved": true/false, "feedback": "...", "needsIteration": true/false, "agentId": "reviewer_id"}`;
  }

  // ---------- LLM 调用 ----------

  protected async callSupervisor(prompt: string): Promise<SupervisorDecision> {
    // 构造 LLM 调用参数
    const callParams = {
      providerID: this.config.providerID,
      modelID: this.config.modelID,
      prompt,
      systemPrompt: "You are a precise task orchestrator. Always respond with valid JSON.",
      timeoutMs: this.config.timeoutMs ?? 30_000,
    };

    try {
      const result = await this.executeLlmCall(callParams);
      return this.parseDecision(result);
    } catch (err) {
      // LLM 调用失败，返回降级决策
      return {
        type: "dispatch",
        agentId: undefined,
      };
    }
  }

  /**
   * 执行 LLM 调用（抽象层，实际实现由调用方注入）
   *
   * 这里用占位实现，实际使用时需要注入具体的 LLM 调用逻辑。
   * 可以通过 agent-sidecar 的 adapter 来调用，或使用独立的 LLM client。
   */
  private async executeLlmCall(params: {
    providerID: string;
    modelID: string;
    prompt: string;
    systemPrompt: string;
    timeoutMs: number;
  }): Promise<string> {
    // 注：这里是占位实现。实际项目中应该接入已有的 LLM 调用基础设施。
    // 例如通过 RuntimeRegistry 或 agent-sidecar 来执行。
    //
    // 为了保持模块独立性，Supervisor 不直接依赖具体的 LLM client，
    // 而是通过 AgentTeam 的执行上下文来路由调用。

    throw new Error(
      `Supervisor LLM call not implemented. ` +
      `providerID=${params.providerID}, modelID=${params.modelID}. ` +
      `Inject an LLM call executor when creating the Supervisor instance.`,
    );
  }

  protected parseDecision(raw: string): SupervisorDecision {
    try {
      // 尝试提取 JSON（可能被 markdown 包裹）
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : raw;
      const parsed = JSON.parse(jsonStr);

      return {
        type: parsed.type ?? "dispatch",
        agentId: parsed.agentId,
        assignments: parsed.assignments,
        feedback: parsed.feedback,
        needsIteration: parsed.needsIteration,
      };
    } catch {
      return { type: "dispatch" };
    }
  }
}

/**
 * 带 LLM 执行器的 Supervisor（实际使用版本）
 *
 * 需要注入一个 LLM 调用函数来执行调度决策。
 */
export class FunctionalSupervisor extends Supervisor {
  private readonly llmExecutor: (params: {
    providerID: string;
    modelID: string;
    prompt: string;
    systemPrompt: string;
    timeoutMs: number;
  }) => Promise<string>;

  constructor(
    config: SupervisorConfig,
    llmExecutor: (params: {
      providerID: string;
      modelID: string;
      prompt: string;
      systemPrompt: string;
      timeoutMs: number;
    }) => Promise<string>,
  ) {
    super(config);
    this.llmExecutor = llmExecutor;
  }

  // override to inject executor
  protected override async callSupervisor(prompt: string): Promise<SupervisorDecision> {
    const params = {
      providerID: this.config.providerID,
      modelID: this.config.modelID,
      prompt,
      systemPrompt: "You are a precise task orchestrator. Always respond with valid JSON.",
      timeoutMs: this.config.timeoutMs ?? 30_000,
    };

    try {
      const result = await this.llmExecutor(params);
      return this.parseDecision(result);
    } catch (err) {
      return { type: "dispatch", agentId: undefined };
    }
  }
}

/** 便捷类型：Supervisor 相关的成员角色辅助 */
const ROLE_PRIORITY: MemberRole[] = ["primary", "specialist", "reviewer", "fallback", "observer"];

/**
 * 按角色优先级获取最适合的成员
 */
export function getMemberByRolePriority(members: AgentTeamMember[], preferredRole?: MemberRole): AgentTeamMember | null {
  if (preferredRole) {
    const found = members.find((m) => m.role === preferredRole);
    if (found) return found;
  }
  for (const role of ROLE_PRIORITY) {
    const found = members.find((m) => m.role === role);
    if (found) return found;
  }
  return members[0] ?? null;
}

// 重新导出 parseDecision 供外部测试使用
export function parseDecisionRaw(raw: string): SupervisorDecision {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : raw;
    const parsed = JSON.parse(jsonStr);
    return {
      type: parsed.type ?? "dispatch",
      agentId: parsed.agentId,
      assignments: parsed.assignments,
      feedback: parsed.feedback,
      needsIteration: parsed.needsIteration,
    };
  } catch {
    return { type: "dispatch" };
  }
}

// 确保 AgentEvent 被使用（避免 lint 警告）
export type _SupervisorAgentEvent = AgentEvent;
