/**
 * CostEfficiencyRouter - 成本-效率模型路由
 *
 * 借鉴 Orca 的 Coding Index 研究与 Cursor 的模型特化策略，
 * 为不同角色的 agent 推荐最合适的模型，实现成本与效率的平衡。
 *
 * 核心原则：
 * - 贵模型做推理（Coordinator/Supervisor）
 * - 中等模型做编码（Builder/Specialist）
 * - 便宜模型做执行（Runner/Formatter）
 *
 * 参考数据（基于 Artificial Analysis Coding Index）：
 * | 角色 | 推荐定位 | 成本/1M tokens | 理由 |
 * |------|----------|----------------|------|
 * | Coordinator | Opus 4.6 | ~$10 | 最强推理，用量少 |
 * | Builder | MiMo-V2-Pro | ~$1-3 | 便宜 80%，编码强 |
 * | Reviewer | GLM-5.1 | ~$1-3 | SWE-Bench Pro 58.4% |
 * | Runner | MiniMax M2.5 | $0 | 重命名/格式化等杂活 |
 */

import type { MemberRole, AgentTeamMember } from "./types.js";

/** 模型成本配置 */
export interface ModelCostConfig {
  /** 模型 ID */
  modelID: string;
  /** Provider ID */
  providerID: string;
  /** 每 1M tokens 成本（美元） */
  costPerMillionTokens: number;
  /** 适合的角色 */
  suitableRoles: MemberRole[];
  /** 能力标签 */
  tags: Array<"coding" | "reasoning" | "review" | "format" | "testing" | "docs">;
  /** SWE-Bench 得分（如果有） */
  sweBenchScore?: number;
}

/** 角色-模型推荐映射 */
export interface RoleModelRecommendation {
  role: MemberRole;
  primaryModel: ModelCostConfig;
  fallbackModels: ModelCostConfig[];
  reason: string;
}

/** 预定义的模型注册表（可根据实际情况调整） */
export const DEFAULT_MODEL_REGISTRY: ModelCostConfig[] = [
  {
    modelID: "claude-opus-4.6",
    providerID: "anthropic",
    costPerMillionTokens: 10,
    suitableRoles: ["primary", "specialist"],
    tags: ["reasoning", "coding", "review"],
    sweBenchScore: 85,
  },
  {
    modelID: "qwen-max",
    providerID: "dashscope",
    costPerMillionTokens: 5,
    suitableRoles: ["primary", "reviewer"],
    tags: ["reasoning", "coding", "review"],
    sweBenchScore: 72,
  },
  {
    modelID: "glm-5.1",
    providerID: "zhipu",
    costPerMillionTokens: 3,
    suitableRoles: ["reviewer", "specialist"],
    tags: ["review", "coding", "reasoning"],
    sweBenchScore: 58.4,
  },
  {
    modelID: "mimo-v2-pro",
    providerID: "mimo",
    costPerMillionTokens: 2,
    suitableRoles: ["specialist", "primary"],
    tags: ["coding", "testing", "docs"],
    sweBenchScore: 55,
  },
  {
    modelID: "minimax-m2.5",
    providerID: "minimax",
    costPerMillionTokens: 0.5,
    suitableRoles: ["fallback", "observer"],
    tags: ["format", "docs", "testing"],
    sweBenchScore: 30,
  },
  {
    modelID: "deepseek-coder",
    providerID: "deepseek",
    costPerMillionTokens: 1,
    suitableRoles: ["specialist", "fallback"],
    tags: ["coding", "testing"],
    sweBenchScore: 45,
  },
];

export class CostEfficiencyRouter {
  private readonly registry: ModelCostConfig[];

  constructor(registry: ModelCostConfig[] = DEFAULT_MODEL_REGISTRY) {
    this.registry = registry;
  }

  /**
   * 为指定角色推荐最优模型
   */
  recommendForRole(role: MemberRole, budget?: { maxCostPerMillion?: number }): RoleModelRecommendation {
    const candidates = this.registry.filter((m) =>
      m.suitableRoles.includes(role)
    );

    let filtered = candidates;
    if (budget?.maxCostPerMillion !== undefined) {
      filtered = filtered.filter((m) => m.costPerMillionTokens <= budget.maxCostPerMillion!);
    }

    if (filtered.length === 0) {
      // 降级：不过滤预算
      filtered = candidates;
    }

    if (filtered.length === 0) {
      // 兜底：返回最便宜的
      const cheapest = [...this.registry].sort((a, b) => a.costPerMillionTokens - b.costPerMillionTokens);
      return {
        role,
        primaryModel: cheapest[0]!,
        fallbackModels: cheapest.slice(1, 3),
        reason: "No matching model found, using cheapest as fallback",
      };
    }

    // 按 SWE-Bench 得分 + 成本效益比排序
    const ranked = filtered.sort((a, b) => {
      const scoreA = a.sweBenchScore ?? 0;
      const scoreB = b.sweBenchScore ?? 0;
      const costA = Math.max(a.costPerMillionTokens, 0.01);
      const costB = Math.max(b.costPerMillionTokens, 0.01);
      // 效益比 = SWE-Bench 得分 / 成本
      const ratioA = scoreA / costA;
      const ratioB = scoreB / costB;
      return ratioB - ratioA;
    });

    return {
      role,
      primaryModel: ranked[0]!,
      fallbackModels: ranked.slice(1, 3),
      reason: `Best cost-efficiency ratio for role '${role}'`,
    };
  }

  /**
   * 为 team 成员分配模型（根据角色自动选择）
   */
  assignModelsToTeam(members: AgentTeamMember[], budget?: { maxCostPerMillion?: number }): Map<string, ModelCostConfig> {
    const assignments = new Map<string, ModelCostConfig>();

    for (const member of members) {
      const role = member.role ?? "specialist";
      const recommendation = this.recommendForRole(role, budget);
      assignments.set(member.agentId, recommendation.primaryModel);
    }

    return assignments;
  }

  /**
   * 估算 team 运行成本
   */
  estimateTeamCost(
    members: AgentTeamMember[],
    estimatedTokensPerAgent: number,
  ): { totalCost: number; breakdown: Array<{ agentId: string; role: MemberRole; model: string; cost: number }> } {
    const breakdown: Array<{ agentId: string; role: MemberRole; model: string; cost: number }> = [];
    let totalCost = 0;

    for (const member of members) {
      const role = member.role ?? "specialist";
      const recommendation = this.recommendForRole(role);
      const model = recommendation.primaryModel;
      const cost = (model.costPerMillionTokens * estimatedTokensPerAgent) / 1_000_000;
      totalCost += cost;
      breakdown.push({
        agentId: member.agentId,
        role,
        model: model.modelID,
        cost,
      });
    }

    return { totalCost, breakdown };
  }

  /**
   * 注册或更新模型配置
   */
  registerModel(config: ModelCostConfig): void {
    const idx = this.registry.findIndex((m) => m.modelID === config.modelID);
    if (idx >= 0) {
      this.registry[idx] = config;
    } else {
      this.registry.push(config);
    }
  }

  /**
   * 获取所有注册的模型
   */
  listModels(): ModelCostConfig[] {
    return [...this.registry];
  }

  /**
   * 按标签筛选模型
   */
  filterByTag(tag: ModelCostConfig["tags"][number]): ModelCostConfig[] {
    return this.registry.filter((m) => m.tags.includes(tag));
  }

  /**
   * 获取最便宜的模型
   */
  getCheapestModel(role?: MemberRole): ModelCostConfig | null {
    const candidates = role
      ? this.registry.filter((m) => m.suitableRoles.includes(role))
      : this.registry;
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) =>
      a.costPerMillionTokens <= b.costPerMillionTokens ? a : b
    );
  }

  /**
   * 获取最贵（最强）的模型
   */
  getMostCapableModel(role?: MemberRole): ModelCostConfig | null {
    const candidates = role
      ? this.registry.filter((m) => m.suitableRoles.includes(role))
      : this.registry;
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) =>
      (a.sweBenchScore ?? 0) >= (b.sweBenchScore ?? 0) ? a : b
    );
  }
}

/** 便捷函数：快速创建带默认配置的路由 */
export function createDefaultRouter(): CostEfficiencyRouter {
  return new CostEfficiencyRouter();
}
