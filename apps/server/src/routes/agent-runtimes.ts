/**
 * Runtime 上报路由（openspec-runtime-reporting.md）
 *
 * GET  /agent-runtimes            → 可用 CLI agents 能力列表（TTL 缓存）
 * GET  /agent-runtimes/:agentId   → 单个 agent 深度能力探测
 * POST /agent-runtimes/reload     → 强制重扫（失效缓存）
 * GET  /agent-runtimes/:agentId/models → 懒发现指定 agent 的可用模型
 * POST /agent-runtimes/models/reload-all → 强制重扫所有 agent 的模型
 *
 * 消费方：控制平面（den-api）/ UI 的 agent 创建与任务路由入口。
 */

import { addRoute, type Route } from "./registry.js";
import type { RuntimeRegistry } from "../runtime-registry.js";
import { getGlobalAgentScanner } from "../agent-scanner.js";

export interface RegisterAgentRuntimeRoutesOptions {
  routes: Route[];
  registry: RuntimeRegistry;
  jsonResponse: (data: unknown, status?: number) => Response;
}

export function registerAgentRuntimeRoutes(options: RegisterAgentRuntimeRoutesOptions): void {
  const { routes, registry, jsonResponse } = options;

  addRoute(routes, "GET", "/agent-runtimes", "none", async () => {
    const capabilities = await registry.list();
    return jsonResponse({ capabilities });
  });

  addRoute(routes, "GET", "/agent-runtimes/:agentId", "none", async (ctx) => {
    const capability = await registry.get(ctx.params.agentId);
    if (!capability) {
      return jsonResponse({ error: `unknown agent '${ctx.params.agentId}'` }, 404);
    }
    return jsonResponse({ capability });
  });

  addRoute(routes, "POST", "/agent-runtimes/reload", "none", async () => {
    registry.invalidate();
    const scanner = getGlobalAgentScanner();
    scanner.invalidate();
    const capabilities = await registry.list();
    return jsonResponse({ capabilities });
  });

  addRoute(routes, "GET", "/agent-runtimes/:agentId/models", "none", async (ctx) => {
    const agentId = ctx.params.agentId;
    const forceRefresh = ctx.url.searchParams.get("refresh") === "1";
    try {
      const models = await registry.discoverAgentModels(agentId, forceRefresh);
      return jsonResponse({ agentId, models, count: models.length });
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });

  addRoute(routes, "POST", "/agent-runtimes/models/reload-all", "none", async () => {
    const scanner = getGlobalAgentScanner();
    try {
      const results = await scanner.discoverAllModels(true);
      const summary = Object.fromEntries(
        Object.entries(results).map(([agentId, models]) => [agentId, { count: models.length }]),
      );
      return jsonResponse({ summary, timestamp: Date.now() });
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });
}