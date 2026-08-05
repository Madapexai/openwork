/**
 * Worktree 路由（openspec-worktree-service.md）
 *
 * GET    /worktrees?repoPath=…            → 列出仓库 worktree
 * POST   /worktrees                       → 创建 worktree {repoPath, branch?, owner?, parentDir?}
 * DELETE /worktrees                       → 回收 {repoPath, worktreePath, force?}
 * POST   /worktrees/prune                 → prune 失效元数据 {repoPath}
 * POST   /worktrees/cleanup               → 回收闲置 worktree {repoPath, maxIdleMs?}
 */

import { addRoute, type Route } from "./registry.js";
import { WorktreeService, WorktreeError } from "../worktree/worktree-service.js";

export interface RegisterWorktreeRoutesOptions {
  routes: Route[];
  service: WorktreeService;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<unknown>;
}

interface WorktreePayload {
  repoPath?: string;
  worktreePath?: string;
  branch?: string;
  owner?: string;
  parentDir?: string;
  force?: boolean;
  maxIdleMs?: number;
}

function isWorktreePayload(value: unknown): value is WorktreePayload {
  return typeof value === "object" && value !== null;
}

export function registerWorktreeRoutes(options: RegisterWorktreeRoutesOptions): void {
  const { routes, service, jsonResponse, readJsonBody } = options;

  addRoute(routes, "GET", "/worktrees", "none", async (ctx) => {
    const repoPath = ctx.url.searchParams.get("repoPath");
    if (!repoPath) {
      return jsonResponse({ error: "missing repoPath query parameter" }, 400);
    }
    try {
      const worktrees = await service.list(repoPath);
      return jsonResponse({ worktrees });
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400);
    }
  });

  addRoute(routes, "POST", "/worktrees", "none", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    if (!isWorktreePayload(body) || !body.repoPath) {
      return jsonResponse({ error: "missing repoPath in body" }, 400);
    }
    try {
      const entry = await service.create({
        repoPath: body.repoPath,
        branch: body.branch,
        owner: body.owner,
        parentDir: body.parentDir,
      });
      return jsonResponse({ worktree: entry }, 201);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400);
    }
  });

  addRoute(routes, "DELETE", "/worktrees", "none", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    if (!isWorktreePayload(body) || !body.repoPath || !body.worktreePath) {
      return jsonResponse({ error: "missing repoPath or worktreePath in body" }, 400);
    }
    try {
      const removed = await service.remove(body.repoPath, body.worktreePath, { force: body.force });
      return jsonResponse({ removed });
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400);
    }
  });

  addRoute(routes, "POST", "/worktrees/prune", "none", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    if (!isWorktreePayload(body) || !body.repoPath) {
      return jsonResponse({ error: "missing repoPath in body" }, 400);
    }
    try {
      await service.prune(body.repoPath);
      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400);
    }
  });

  addRoute(routes, "POST", "/worktrees/cleanup", "none", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    if (!isWorktreePayload(body) || !body.repoPath) {
      return jsonResponse({ error: "missing repoPath in body" }, 400);
    }
    try {
      const removed = await service.cleanupStale(body.repoPath, body.maxIdleMs);
      return jsonResponse({ removed });
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400);
    }
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof WorktreeError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
