/**
 * Agent Routes - 智能体管理 API
 *
 * 提供 agent 定义的 CRUD 接口，支持：
 * - 列出所有 agent
 * - 获取单个 agent
 * - 创建/更新/删除 agent
 * - 将 agent 作为 team/solo 调用对象
 */

import { addRoute, type Route } from "./registry.js";
import { AgentStore, type AgentCreateInput, type AgentUpdateInput } from "../agent-store.js";

export interface RegisterAgentRoutesOptions {
  routes: Route[];
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<unknown>;
}

export function registerAgentRoutes(options: RegisterAgentRoutesOptions): void {
  const { routes, jsonResponse, readJsonBody } = options;

  // Agent store singleton (lazily initialized)
  let store: AgentStore | null = null;
  function getStore(): AgentStore {
    if (!store) {
      const agentsDir = process.env.OPENWORK_AGENTS_DIR || "./agents";
      store = new AgentStore(agentsDir);
    }
    return store;
  }

  // GET /api/agents - 列出所有 agent
  addRoute(routes, "GET", "/agents", "none", async () => {
    const agentStore = getStore();
    const agents = await agentStore.list();
    return jsonResponse({ items: agents.map(a => agentStore.toCallable(a)) });
  });

  // GET /api/agents/:id - 获取单个 agent
  addRoute(routes, "GET", "/agents/:id", "none", async (ctx) => {
    const agentStore = getStore();
    const agent = await agentStore.get(ctx.params.id);
    if (!agent) {
      return jsonResponse({ error: "not_found", message: "Agent not found" }, 404);
    }
    return jsonResponse(agent);
  });

  // POST /api/agents - 创建 agent
  addRoute(routes, "POST", "/agents", "none", async (ctx) => {
    const agentStore = getStore();
    const body = (await readJsonBody(ctx.request)) as AgentCreateInput;

    if (!body?.name || !body?.systemPrompt) {
      return jsonResponse(
        { error: "invalid_input", message: "name and systemPrompt are required" },
        400,
      );
    }

    const agent = await agentStore.create(body);
    return jsonResponse(agent, 201);
  });

  // PUT /api/agents/:id - 更新 agent
  addRoute(routes, "PUT", "/agents/:id", "none", async (ctx) => {
    const agentStore = getStore();
    const body = (await readJsonBody(ctx.request)) as AgentUpdateInput;
    const agent = await agentStore.update(ctx.params.id, body);
    if (!agent) {
      return jsonResponse({ error: "not_found", message: "Agent not found" }, 404);
    }
    return jsonResponse(agent);
  });

  // DELETE /api/agents/:id - 删除 agent
  addRoute(routes, "DELETE", "/agents/:id", "none", async (ctx) => {
    const agentStore = getStore();
    const deleted = await agentStore.delete(ctx.params.id);
    if (!deleted) {
      return jsonResponse({ error: "not_found", message: "Agent not found" }, 404);
    }
    return jsonResponse({ success: true });
  });

  // GET /api/agents/:id/callable - 获取 agent 作为可调用对象
  addRoute(routes, "GET", "/agents/:id/callable", "none", async (ctx) => {
    const agentStore = getStore();
    const agent = await agentStore.get(ctx.params.id);
    if (!agent) {
      return jsonResponse({ error: "not_found", message: "Agent not found" }, 404);
    }
    return jsonResponse(agentStore.toCallable(agent));
  });
}