/**
 * Team Strategy Presets - 团队任务拆解策略预设
 *
 * 借鉴 Claude Code 的 Agent Loop、WorkBuddy 的 Team Strategy、
 * Cursor 的 Sub-agent Decomposition，定义三种核心策略：
 *
 * 1. Conservative（保守）: 单 agent 执行，适合简单任务
 *    - 不分解，不分发
 *    - 直接指派给最匹配的 agent
 *    - 成本最低，速度最快
 *
 * 2. Balanced（平衡）: 2-3 agent 协作，适合中等复杂任务
 *    - 分解为 2-3 个子任务
 *    - 支持 chain / fan-out 混合
 *    - 兼顾质量与效率
 *
 * 3. Aggressive（激进）: 4+ agent 协作，适合大型复杂任务
 *    - 深度分解为多个子任务
 *    - 支持 review 循环迭代
 *    - 成本高，质量上限也高
 *
 * 每种策略包含：
 * - Supervisor 配置（模型、prompt 模板、最大子任务数）
 * - Dispatch Policy（对应静态策略）
 * - Relay Strategy（编排模式）
 * - 角色模型分配（CostEfficiencyRouter 配置）
 */

import type { SupervisorConfig } from "./supervisor.js";
import type { DispatchPolicy, RelayStrategy, MemberRole } from "./types.js";
import type { ModelCostConfig } from "./cost-efficiency-router.js";

/** 策略标识符 */
export type TeamStrategyId = "conservative" | "balanced" | "aggressive";

/** 策略元数据 */
export interface TeamStrategyMeta {
  id: TeamStrategyId;
  name: string;
  description: string;
  complexity: "low" | "medium" | "high";
  costLevel: "low" | "medium" | "high";
  qualityLevel: "low" | "medium" | "high";
  recommendedFor: string;
}

/** 完整策略配置 */
export interface TeamStrategyConfig {
  id: TeamStrategyId;
  meta: TeamStrategyMeta;
  supervisor: SupervisorConfig;
  dispatchPolicy: DispatchPolicy;
  relayStrategy?: RelayStrategy;
  roleModelOverrides?: Partial<Record<MemberRole, { providerID: string; modelID: string }>>;
  maxSubtasks: number;
  enableReviewLoop: boolean;
  maxReviewRounds: number;
  parallelExecution: boolean;
}

/** 策略元数据表 */
export const STRATEGY_META: Record<TeamStrategyId, TeamStrategyMeta> = {
  conservative: {
    id: "conservative",
    name: "保守模式",
    description: "单 agent 执行，不分解任务，适合简单明确的任务。",
    complexity: "low",
    costLevel: "low",
    qualityLevel: "low",
    recommendedFor: "单文件修改、简单查询、小型配置变更",
  },
  balanced: {
    id: "balanced",
    name: "平衡模式",
    description: "2-3 agent 协作，分解为核心子任务，平衡效率与质量。",
    complexity: "medium",
    costLevel: "medium",
    qualityLevel: "medium",
    recommendedFor: "功能开发、Bug 修复、中等复杂度的重构",
  },
  aggressive: {
    id: "aggressive",
    name: "激进模式",
    description: "4+ agent 深度协作，支持 review 循环迭代，追求最高质量。",
    complexity: "high",
    costLevel: "high",
    qualityLevel: "high",
    recommendedFor: "大型重构、系统设计、多模块联动开发",
  },
};

/** 默认 Supervisor Prompt 模板（平衡/激进模式用） */
const BALANCED_SUPERVISOR_PROMPT = `You are a task orchestrator managing a team of AI agents. Analyze the task and decide how to execute it optimally.

## Available Team Members
{members_desc}

## Task
{task_prompt}

## Decision Framework
Choose one:
1. **DISPATCH**: Simple, focused task → assign to the most suitable single agent
2. **DECOMPOSE**: Complex task → break into 2-3 subtasks, assign each to best agent, specify dependencies
3. **REVIEW**: Quality check → assign to reviewer agent for verification

Guidelines:
- Prefer DECOMPOSE when task involves multiple distinct concerns (e.g., implementation + testing + documentation)
- Keep subtasks focused and atomic
- Specify clear dependencies between subtasks
- Assign each subtask to the agent best suited for that specific work

Output valid JSON only:
{{
  "type": "dispatch|decompose|review",
  "agentId": "agent_id_for_dispatch",
  "assignments": [
    {{"subtaskId": "sub_1", "agentId": "agent_id", "prompt": "specific sub-prompt", "dependencies": []}}
  ],
  "reasoning": "why this decision"
}}`;

const AGGRESSIVE_SUPERVISOR_PROMPT = `You are an advanced task orchestrator managing a team of AI agents for complex software development tasks. Analyze the task deeply and create an optimal execution plan.

## Available Team Members
{members_desc}

## Task
{task_prompt}

## Decision Framework
Choose one:
1. **DISPATCH**: Very simple task → assign to a single agent
2. **DECOMPOSE**: Complex task → break into 3-6 focused subtasks with clear dependencies
3. **REVIEW**: Quality gate → assign to reviewer for verification and potential iteration

Guidelines for DECOMPOSE:
- Break the task into logical phases: analysis → implementation → testing → review
- Each subtask should be independently verifiable
- Specify dependencies as a DAG (not just linear)
- Assign the most capable agent to the critical path
- Include a review/validation subtask as the final step
- Consider creating parallel subtasks where possible to maximize throughput

Output valid JSON only:
{{
  "type": "dispatch|decompose|review",
  "agentId": "agent_id_for_dispatch",
  "assignments": [
    {{"subtaskId": "sub_1", "agentId": "agent_id", "prompt": "detailed sub-prompt", "dependencies": ["sub_2"]}}
  ],
  "reasoning": "detailed explanation of decomposition strategy"
}}`;

/** 预设模型配置（基于 CostEfficiencyRouter 数据） */
const STRATEGY_MODELS: Record<TeamStrategyId, { providerID: string; modelID: string }> = {
  conservative: { providerID: "deepseek", modelID: "deepseek-coder" },
  balanced: { providerID: "dashscope", modelID: "qwen-max" },
  aggressive: { providerID: "anthropic", modelID: "claude-opus-4.6" },
};

/**
 * 获取指定策略的完整配置
 */
export function getStrategyConfig(strategyId: TeamStrategyId): TeamStrategyConfig {
  const meta = STRATEGY_META[strategyId];

  switch (strategyId) {
    case "conservative":
      return {
        id: "conservative",
        meta,
        supervisor: {
          providerID: STRATEGY_MODELS.conservative.providerID,
          modelID: STRATEGY_MODELS.conservative.modelID,
          maxSubtasks: 1,
          enableReviewLoop: false,
          timeoutMs: 15_000,
        },
        dispatchPolicy: { kind: "first-available" },
        maxSubtasks: 1,
        enableReviewLoop: false,
        maxReviewRounds: 0,
        parallelExecution: false,
      };

    case "balanced":
      return {
        id: "balanced",
        meta,
        supervisor: {
          providerID: STRATEGY_MODELS.balanced.providerID,
          modelID: STRATEGY_MODELS.balanced.modelID,
          promptTemplate: BALANCED_SUPERVISOR_PROMPT,
          maxSubtasks: 3,
          enableReviewLoop: true,
          maxReviewRounds: 1,
          timeoutMs: 30_000,
        },
        dispatchPolicy: { kind: "llm-supervisor", model: STRATEGY_MODELS.balanced.modelID, providerID: STRATEGY_MODELS.balanced.providerID },
        relayStrategy: { kind: "fan-out" },
        roleModelOverrides: {
          primary: STRATEGY_MODELS.balanced,
          specialist: STRATEGY_MODELS.balanced,
          reviewer: { providerID: "zhipu", modelID: "glm-5.1" },
        },
        maxSubtasks: 3,
        enableReviewLoop: true,
        maxReviewRounds: 1,
        parallelExecution: true,
      };

    case "aggressive":
      return {
        id: "aggressive",
        meta,
        supervisor: {
          providerID: STRATEGY_MODELS.aggressive.providerID,
          modelID: STRATEGY_MODELS.aggressive.modelID,
          promptTemplate: AGGRESSIVE_SUPERVISOR_PROMPT,
          maxSubtasks: 6,
          enableReviewLoop: true,
          maxReviewRounds: 3,
          timeoutMs: 60_000,
        },
        dispatchPolicy: { kind: "llm-supervisor", model: STRATEGY_MODELS.aggressive.modelID, providerID: STRATEGY_MODELS.aggressive.providerID },
        relayStrategy: { kind: "fan-out" },
        roleModelOverrides: {
          primary: STRATEGY_MODELS.aggressive,
          specialist: { providerID: "mimo", modelID: "mimo-v2-pro" },
          reviewer: { providerID: "zhipu", modelID: "glm-5.1" },
          fallback: { providerID: "minimax", modelID: "minimax-m2.5" },
        },
        maxSubtasks: 6,
        enableReviewLoop: true,
        maxReviewRounds: 3,
        parallelExecution: true,
      };

    default: {
      const _exhaustive: never = strategyId;
      void _exhaustive;
      throw new Error(`Unknown strategy: ${strategyId}`);
    }
  }
}

/**
 * 列出所有可用策略
 */
export function listStrategies(): TeamStrategyConfig[] {
  return (Object.keys(STRATEGY_META) as TeamStrategyId[]).map(getStrategyConfig);
}

/**
 * 根据任务复杂度推荐策略
 */
export function recommendStrategy(
  taskComplexity: "low" | "medium" | "high",
): TeamStrategyId {
  switch (taskComplexity) {
    case "low":
      return "conservative";
    case "medium":
      return "balanced";
    case "high":
      return "aggressive";
    default:
      return "balanced";
  }
}

/**
 * 基于 prompt 特征的自动复杂度评估
 */
export function assessTaskComplexity(prompt: string): "low" | "medium" | "high" {
  const lower = prompt.toLowerCase();

  // 高复杂度特征
  const highPattern = new RegExp(
    "架构|architecture|system design|redesign|重构|refactor.*large|multi.*module|" +
    "跨模块|全栈|full.?stack|enterprise|production.?ready|scalable|" +
    "多系统|distributed|microservice|复杂|大型|系统级",
    "i",
  );

  // 中复杂度特征
  const mediumPattern = new RegExp(
    "实现|implement|开发|develop|修复|fix|bug|feature|功能|" +
    "添加.*支持|add.*support|集成|integrate|配置|config|setup|" +
    "优化|optimize|改进|improve|扩展|extend",
    "i",
  );

  if (highPattern.test(lower)) return "high";
  if (mediumPattern.test(lower)) return "medium";
  return "low";
}

/**
 * 从策略创建 Team 配置的辅助函数
 */
export function buildTeamConfigFromStrategy(
  strategyId: TeamStrategyId,
  teamId: string,
  memberSpecs: Array<{ agentId: string; role?: MemberRole }>,
): {
  teamConfig: import("./types.js").AgentTeamConfig;
  supervisorConfig: SupervisorConfig;
} {
  const strategy = getStrategyConfig(strategyId);

  return {
    teamConfig: {
      teamId,
      dispatchPolicy: strategy.dispatchPolicy,
      relayStrategy: strategy.relayStrategy,
      members: memberSpecs.map((spec) => ({
        agentId: spec.agentId,
        role: spec.role ?? "specialist",
        adapter: undefined as unknown as import("./types.js").AgentTeamMember["adapter"], // adapter 由外部注入
      })),
      worktreeIsolation: strategy.parallelExecution,
      roleModels: strategy.roleModelOverrides,
      useProcessPool: true,
      eagerStart: false,
    },
    supervisorConfig: strategy.supervisor,
  };
}

// 确保 ModelCostConfig 类型被引用
export type _StrategyModelCostRef = ModelCostConfig;