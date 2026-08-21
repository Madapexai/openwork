/**
 * Team 路由 - Agent Team 管理与执行
 *
 * GET    /teams                            → 列出所有 team
 * POST   /teams                            → 创建新 team
 * GET    /teams/:id                        → 获取 team 详情
 * PUT    /teams/:id                        → 更新 team 配置
 * DELETE /teams/:id                        → 删除 team
 * POST   /teams/:id/members                → 添加成员
 * DELETE /teams/:id/members/:agentId       → 移除成员
 * POST   /teams/:id/run                    → 运行 team 任务（分解 + 执行）
 * POST   /teams/:id/decompose              → 仅分解任务（不执行）
 * GET    /teams/:id/tasks                  → 列出 team 任务历史
 * GET    /team-strategies                  → 列出可用策略
 * GET    /team-harnesses                   → 列出可用 harness 环境
 * POST   /team-harnesses                   → 注册新 harness
 * POST   /team-harnesses/:id/health        → 检查 harness 健康状态
 */

import { addRoute, type Route } from "./registry.js";
import { getGlobalHarnessManager, type HarnessDefinition } from "../agent-team/harness-environment.js";
import {
  getStrategyConfig,
  listStrategies,
  assessTaskComplexity,
  buildTeamConfigFromStrategy,
  type TeamStrategyId,
} from "../agent-team/team-strategies.js";

export interface RegisterTeamRoutesOptions {
  routes: Route[];
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<unknown>;
  createTeamClient?: () => unknown;
}

/** 内存中的 team 存储（简化实现，后续可对接数据库） */
interface StoredTeam {
  id: string;
  name: string;
  strategy: TeamStrategyId;
  memberSpecs: Array<{ agentId: string; role?: string }>;
  harnessId: string;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "running" | "completed" | "failed";
  lastTaskResult?: {
    taskId: string;
    subtasks: Array<{ subtaskId: string; agentId: string; prompt: string; status: string }>;
    completedAt: number;
  };
}

const teamStore = new Map<string, StoredTeam>();

function generateTeamId(): string {
  return `team_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function registerTeamRoutes(options: RegisterTeamRoutesOptions): void {
  const { routes, jsonResponse, readJsonBody } = options;

  // ============ Team CRUD ============

  addRoute(routes, "GET", "/teams", "none", async () => {
    const teams = Array.from(teamStore.values()).map((t) => ({
      id: t.id,
      name: t.name,
      strategy: t.strategy,
      memberCount: t.memberSpecs.length,
      harnessId: t.harnessId,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
    return jsonResponse({ teams });
  });

  addRoute(routes, "POST", "/teams", "none", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "invalid body" }, 400);
    }

    const { name, strategy, members, harnessId } = body as {
      name?: string;
      strategy?: TeamStrategyId;
      members?: Array<{ agentId: string; role?: string }>;
      harnessId?: string;
    };

    if (!name || !name.trim()) {
      return jsonResponse({ error: "team name is required" }, 400);
    }
    if (!members || members.length === 0) {
      return jsonResponse({ error: "at least one team member is required" }, 400);
    }

    const harnessManager = getGlobalHarnessManager();
    const resolvedHarnessId = harnessId ?? "local-default";
    if (!harnessManager.getHarness(resolvedHarnessId)) {
      return jsonResponse({ error: `harness '${resolvedHarnessId}' not found` }, 400);
    }

    const teamId = generateTeamId();
    const strategyId: TeamStrategyId = strategy ?? "balanced";

    const team: StoredTeam = {
      id: teamId,
      name: name.trim(),
      strategy: strategyId,
      memberSpecs: members.map((m) => ({
        agentId: m.agentId,
        role: m.role ?? "specialist",
      })),
      harnessId: resolvedHarnessId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "idle",
    };

    teamStore.set(teamId, team);
    return jsonResponse({ team: serializeTeam(team) }, 201);
  });

  addRoute(routes, "GET", "/teams/:id", "none", async (ctx) => {
    const teamId = ctx.params.id;
    const team = teamStore.get(teamId);
    if (!team) {
      return jsonResponse({ error: "team not found" }, 404);
    }
    return jsonResponse({ team: serializeTeam(team) });
  });

  addRoute(routes, "PUT", "/teams/:id", "none", async (ctx) => {
    const teamId = ctx.params.id;
    const team = teamStore.get(teamId);
    if (!team) {
      return jsonResponse({ error: "team not found" }, 404);
    }

    const body = await readJsonBody(ctx.request);
    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "invalid body" }, 400);
    }

    const updates = body as {
      name?: string;
      strategy?: TeamStrategyId;
      members?: Array<{ agentId: string; role?: string }>;
      harnessId?: string;
    };

    if (updates.name !== undefined) {
      team.name = updates.name.trim();
    }
    if (updates.strategy !== undefined) {
      team.strategy = updates.strategy;
    }
    if (updates.members !== undefined) {
      team.memberSpecs = updates.members.map((m) => ({
        agentId: m.agentId,
        role: m.role ?? "specialist",
      }));
    }
    if (updates.harnessId !== undefined) {
      team.harnessId = updates.harnessId;
    }
    team.updatedAt = Date.now();

    return jsonResponse({ team: serializeTeam(team) });
  });

  addRoute(routes, "DELETE", "/teams/:id", "none", async (ctx) => {
    const teamId = ctx.params.id;
    const removed = teamStore.delete(teamId);
    if (!removed) {
      return jsonResponse({ error: "team not found" }, 404);
    }
    return jsonResponse({ ok: true });
  });

  // ============ Team Member Management ============

  addRoute(routes, "POST", "/teams/:id/members", "none", async (ctx) => {
    const teamId = ctx.params.id;
    const team = teamStore.get(teamId);
    if (!team) {
      return jsonResponse({ error: "team not found" }, 404);
    }

    const body = await readJsonBody(ctx.request);
    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "invalid body" }, 400);
    }

    const { agentId, role } = body as { agentId?: string; role?: string };
    if (!agentId) {
      return jsonResponse({ error: "agentId is required" }, 400);
    }

    if (team.memberSpecs.some((m) => m.agentId === agentId)) {
      return jsonResponse({ error: `agent '${agentId}' is already a member` }, 409);
    }

    team.memberSpecs.push({ agentId, role: role ?? "specialist" });
    team.updatedAt = Date.now();

    return jsonResponse({ team: serializeTeam(team) }, 201);
  });

  addRoute(routes, "DELETE", "/teams/:id/members/:agentId", "none", async (ctx) => {
    const teamId = ctx.params.id;
    const agentId = ctx.params.agentId;
    const team = teamStore.get(teamId);
    if (!team) {
      return jsonResponse({ error: "team not found" }, 404);
    }

    const idx = team.memberSpecs.findIndex((m) => m.agentId === agentId);
    if (idx === -1) {
      return jsonResponse({ error: `agent '${agentId}' is not a member` }, 404);
    }

    team.memberSpecs.splice(idx, 1);
    team.updatedAt = Date.now();

    return jsonResponse({ team: serializeTeam(team) });
  });

  // ============ Team Task Execution ============

  addRoute(routes, "POST", "/teams/:id/decompose", "none", async (ctx) => {
    const teamId = ctx.params.id;
    const team = teamStore.get(teamId);
    if (!team) {
      return jsonResponse({ error: "team not found" }, 404);
    }

    const body = await readJsonBody(ctx.request);
    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "invalid body" }, 400);
    }

    const { taskPrompt, forceStrategy } = body as {
      taskPrompt?: string;
      forceStrategy?: TeamStrategyId;
    };

    if (!taskPrompt || !taskPrompt.trim()) {
      return jsonResponse({ error: "taskPrompt is required" }, 400);
    }

    const strategyId = forceStrategy ?? team.strategy;
    const complexity = assessTaskComplexity(taskPrompt);
    const strategy = getStrategyConfig(strategyId);

    const decomposition = {
      taskId: `task_${Date.now().toString(36)}`,
      complexity,
      strategy: strategyId,
      strategyMeta: strategy.meta,
      suggestedApproach: strategy.relayStrategy?.kind ?? "direct",
      // 基于策略和成员信息生成的预分解结果
      subtasks: generateDecomposition(taskPrompt, team.memberSpecs, strategyId),
      estimatedCost: estimateCost(strategyId, team.memberSpecs.length),
    };

    return jsonResponse({ decomposition });
  });

  addRoute(routes, "POST", "/teams/:id/run", "none", async (ctx) => {
    const teamId = ctx.params.id;
    const team = teamStore.get(teamId);
    if (!team) {
      return jsonResponse({ error: "team not found" }, 404);
    }

    const body = await readJsonBody(ctx.request);
    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "invalid body" }, 400);
    }

    const { taskPrompt, forceStrategy, dryRun } = body as {
      taskPrompt?: string;
      forceStrategy?: TeamStrategyId;
      dryRun?: boolean;
    };

    if (!taskPrompt || !taskPrompt.trim()) {
      return jsonResponse({ error: "taskPrompt is required" }, 400);
    }

    const strategyId = forceStrategy ?? team.strategy;
    const strategy = getStrategyConfig(strategyId);
    const complexity = assessTaskComplexity(taskPrompt);
    const subtasks = generateDecomposition(taskPrompt, team.memberSpecs, strategyId);

    if (dryRun) {
      return jsonResponse({
        taskId: `task_${Date.now().toString(36)}`,
        dryRun: true,
        strategy: strategyId,
        complexity,
        subtasks,
        estimatedCost: estimateCost(strategyId, team.memberSpecs.length),
      });
    }

    // 实际执行（当前版本返回分解计划，实际执行需要 CLI agent 运行时）
    team.status = "running";
    team.updatedAt = Date.now();

    const taskResult = {
      taskId: `task_${Date.now().toString(36)}`,
      strategy: strategyId,
      complexity,
      subtasks,
      status: "planned" as const,
      message: `Task decomposed into ${subtasks.length} subtasks. Ready for execution.`,
      harnessId: team.harnessId,
    };

    team.lastTaskResult = {
      taskId: taskResult.taskId,
      subtasks: subtasks.map((s) => ({
        subtaskId: s.subtaskId,
        agentId: s.agentId,
        prompt: s.prompt,
        status: "pending",
      })),
      completedAt: Date.now(),
    };
    team.status = "idle";
    team.updatedAt = Date.now();

    return jsonResponse({ task: taskResult }, 202);
  });

  addRoute(routes, "GET", "/teams/:id/tasks", "none", async (ctx) => {
    const teamId = ctx.params.id;
    const team = teamStore.get(teamId);
    if (!team) {
      return jsonResponse({ error: "team not found" }, 404);
    }

    return jsonResponse({
      tasks: team.lastTaskResult ? [team.lastTaskResult] : [],
    });
  });

  // ============ Strategy Routes ============

  addRoute(routes, "GET", "/team-strategies", "none", async () => {
    const strategies = listStrategies().map((s) => ({
      id: s.id,
      name: s.meta.name,
      description: s.meta.description,
      complexity: s.meta.complexity,
      costLevel: s.meta.costLevel,
      qualityLevel: s.meta.qualityLevel,
      maxSubtasks: s.maxSubtasks,
      enableReviewLoop: s.enableReviewLoop,
    }));
    return jsonResponse({ strategies });
  });

  addRoute(routes, "GET", "/team-strategies/:id", "none", async (ctx) => {
    try {
      const strategy = getStrategyConfig(ctx.params.id as TeamStrategyId);
      return jsonResponse({
        id: strategy.id,
        name: strategy.meta.name,
        description: strategy.meta.description,
        meta: strategy.meta,
        supervisor: {
          providerID: strategy.supervisor.providerID,
          modelID: strategy.supervisor.modelID,
          maxSubtasks: strategy.supervisor.maxSubtasks,
          enableReviewLoop: strategy.supervisor.enableReviewLoop,
        },
        dispatchPolicy: strategy.dispatchPolicy,
        relayStrategy: strategy.relayStrategy,
        roleModelOverrides: strategy.roleModelOverrides,
      });
    } catch {
      return jsonResponse({ error: "strategy not found" }, 404);
    }
  });

  // ============ Harness Routes ============

  addRoute(routes, "GET", "/team-harnesses", "none", async () => {
    const harnessManager = getGlobalHarnessManager();
    const harnesses = harnessManager.listHarnesses().map(serializeHarness);
    return jsonResponse({ harnesses });
  });

  addRoute(routes, "POST", "/team-harnesses", "none", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "invalid body" }, 400);
    }

    const harnessManager = getGlobalHarnessManager();
    const harness = buildHarnessFromBody(body as Record<string, unknown>);
    harnessManager.registerHarness(harness);

    return jsonResponse({ harness: serializeHarness(harness) }, 201);
  });

  addRoute(routes, "POST", "/team-harnesses/:id/health", "none", async (ctx) => {
    const harnessManager = getGlobalHarnessManager();
    const health = await harnessManager.checkHealth(ctx.params.id);
    return jsonResponse({ harnessId: ctx.params.id, health });
  });
}

// ============ 辅助函数 ============

function serializeTeam(team: StoredTeam) {
  return {
    id: team.id,
    name: team.name,
    strategy: team.strategy,
    memberSpecs: team.memberSpecs,
    harnessId: team.harnessId,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
    status: team.status,
    lastTaskResult: team.lastTaskResult ?? null,
  };
}

function serializeHarness(h: HarnessDefinition) {
  return {
    id: h.id,
    kind: h.kind,
    name: h.name,
    description: h.description,
    capabilities: h.capabilities,
    rootPath: h.rootPath,
    health: h.health ?? null,
    ...(h.sshConfig ? { ssh: { host: h.sshConfig.host, port: h.sshConfig.port, username: h.sshConfig.username } } : {}),
    ...(h.cloudConfig ? { cloud: { endpoint: h.cloudConfig.endpoint, region: h.cloudConfig.region } } : {}),
  };
}

function buildHarnessFromBody(body: Record<string, unknown>): HarnessDefinition {
  const kind = (body.kind as string) ?? "local";
  const id = (body.id as string) ?? `custom-${Date.now().toString(36)}`;
  const name = (body.name as string) ?? "Custom Harness";

  const base: HarnessDefinition = {
    id,
    kind: kind as HarnessDefinition["kind"],
    name,
    description: (body.description as string) ?? "Custom harness",
    capabilities: {
      pty: true,
      acp: true,
      http: true,
      mcp: false,
      gpu: false,
      docker: false,
      maxConcurrentAgents: 4,
    },
  };

  if (kind === "ssh" && body.ssh && typeof body.ssh === "object") {
    const ssh = body.ssh as Record<string, unknown>;
    base.sshConfig = {
      host: (ssh.host as string) ?? "localhost",
      port: (ssh.port as number) ?? 22,
      username: (ssh.username as string) ?? "root",
      privateKeyPath: ssh.privateKeyPath as string | undefined,
      jumpHost: ssh.jumpHost as string | undefined,
    };
    base.capabilities.maxConcurrentAgents = 8;
  }

  if (kind === "cloud" && body.cloud && typeof body.cloud === "object") {
    const cloud = body.cloud as Record<string, unknown>;
    base.cloudConfig = {
      endpoint: (cloud.endpoint as string) ?? "https://api.openworklabs.com",
      authToken: cloud.authToken as string | undefined,
      region: cloud.region as string | undefined,
    };
    base.capabilities.gpu = true;
    base.capabilities.mcp = true;
    base.capabilities.maxConcurrentAgents = 16;
  }

  return base;
}

/** 生成任务分解（简化版，实际应由 LLM Supervisor 执行） */
function generateDecomposition(
  taskPrompt: string,
  members: Array<{ agentId: string; role?: string }>,
  strategyId: TeamStrategyId,
): Array<{ subtaskId: string; agentId: string; prompt: string; dependencies: string[] }> {
  const primary = members.find((m) => m.role === "primary") ?? members[0];
  const specialist = members.find((m) => m.role === "specialist") ?? primary;
  const reviewer = members.find((m) => m.role === "reviewer");
  const fallback = members.find((m) => m.role === "fallback");

  const base = Date.now().toString(36);

  switch (strategyId) {
    case "conservative":
      return [
        {
          subtaskId: `sub_${base}_1`,
          agentId: primary?.agentId ?? "default",
          prompt: taskPrompt,
          dependencies: [],
        },
      ];

    case "balanced": {
      const result: Array<{ subtaskId: string; agentId: string; prompt: string; dependencies: string[] }> = [];
      result.push({
        subtaskId: `sub_${base}_1`,
        agentId: specialist?.agentId ?? primary?.agentId ?? "default",
        prompt: `Implement the following task:\n\n${taskPrompt}`,
        dependencies: [],
      });
      if (reviewer) {
        result.push({
          subtaskId: `sub_${base}_2`,
          agentId: reviewer.agentId,
          prompt: `Review the implementation for:\n\n${taskPrompt}\n\nCheck for correctness, edge cases, and code quality.`,
          dependencies: [`sub_${base}_1`],
        });
      }
      return result;
    }

    case "aggressive": {
      const result: Array<{ subtaskId: string; agentId: string; prompt: string; dependencies: string[] }> = [];
      result.push({
        subtaskId: `sub_${base}_1`,
        agentId: primary?.agentId ?? "default",
        prompt: `Analyze and plan the implementation for:\n\n${taskPrompt}`,
        dependencies: [],
      });
      result.push({
        subtaskId: `sub_${base}_2`,
        agentId: specialist?.agentId ?? "default",
        prompt: `Implement the core logic for:\n\n${taskPrompt}`,
        dependencies: [`sub_${base}_1`],
      });
      if (reviewer) {
        result.push({
          subtaskId: `sub_${base}_3`,
          agentId: reviewer.agentId,
          prompt: `Review implementation of:\n\n${taskPrompt}\n\nVerify correctness, suggest improvements.`,
          dependencies: [`sub_${base}_2`],
        });
      }
      if (fallback) {
        result.push({
          subtaskId: `sub_${base}_4`,
          agentId: fallback.agentId,
          prompt: `Write tests and documentation for:\n\n${taskPrompt}`,
          dependencies: [`sub_${base}_2`],
        });
      }
      return result;
    }

    default:
      return [
        {
          subtaskId: `sub_${base}_1`,
          agentId: primary?.agentId ?? "default",
          prompt: taskPrompt,
          dependencies: [],
        },
      ];
  }
}

/** 估算成本（简化版） */
function estimateCost(strategyId: TeamStrategyId, memberCount: number): { low: number; high: number } {
  const perAgentCost = {
    conservative: 0.5,
    balanced: 2,
    aggressive: 10,
  };
  const base = perAgentCost[strategyId] ?? 1;
  return {
    low: Math.round(base * memberCount * 0.5 * 100) / 100,
    high: Math.round(base * memberCount * 2 * 100) / 100,
  };
}