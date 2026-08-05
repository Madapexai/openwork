/**
 * Runtime 上报路由（openspec-runtime-reporting.md）
 *
 * GET  /agent-runtimes            → 可用 CLI agents 能力列表（TTL 缓存）
 * GET  /agent-runtimes/:agentId   → 单个 agent 深度能力探测
 * POST /agent-runtimes/reload     → 强制重扫（失效缓存）
 *
 * 消费方：控制平面（den-api）/ UI 的 agent 创建与任务路由入口。
 */

import { addRoute, type Route } from "./registry.js";
import type { RuntimeRegistry } from "../runtime-registry.js";

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
    const capabilities = await registry.list();
    return jsonResponse({ capabilities });
  });
}
