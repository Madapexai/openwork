import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ApiError } from "../errors.js";
import {
  EMPTY_SPACE_DATA,
  readSpaceData,
  updateSpaceData,
  writeSpaceData,
  type SpaceData,
} from "../space-store.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

interface RegisterSpaceRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

const ASSET_LIST_MAX_ENTRIES = 500;
const ASSET_LIST_MAX_DEPTH = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listSpaceAssets(workspaceRoot: string): Promise<Array<Record<string, unknown>>> {
  const rootResolved = resolve(workspaceRoot);
  const items: Array<Record<string, unknown>> = [];

  const walk = async (dirPath: string, depth: number) => {
    if (items.length >= ASSET_LIST_MAX_ENTRIES) return;
    const entries = await readdir(dirPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (items.length >= ASSET_LIST_MAX_ENTRIES) return;
      const absPath = join(dirPath, entry.name);
      const rel = relative(rootResolved, absPath).replace(/\\/g, "/");
      if (rel.startsWith("..") || rel.startsWith(".opencode")) continue;
      let size = 0;
      let mtimeMs = 0;
      try {
        const info = await stat(absPath);
        size = info.size;
        mtimeMs = info.mtimeMs;
      } catch {
        continue;
      }
      items.push({
        path: rel,
        kind: entry.isDirectory() ? "dir" : "file",
        size: entry.isDirectory() ? 0 : size,
        mtimeMs,
        depth,
      });
      if (entry.isDirectory() && depth < ASSET_LIST_MAX_DEPTH) {
        await walk(absPath, depth + 1);
      }
    }
  };

  try {
    await walk(rootResolved, 0);
  } catch {
    // Workspace root missing — return what we found (possibly nothing).
  }
  return items;
}

export function registerSpaceRoutes(options: RegisterSpaceRoutesOptions): void {
  const { routes, config, jsonResponse, readJsonBody, resolveWorkspace } = options;

  addRoute(routes, "GET", "/workspace/:id/space", "client", async (ctx: RequestContext) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const { data, updatedAt } = await readSpaceData(config, workspace.id);
    return jsonResponse({ data, updatedAt });
  });

  addRoute(routes, "PUT", "/workspace/:id/space", "client", async (ctx: RequestContext) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const next: SpaceData = {
      settings: isRecord(body.settings) ? (body.settings as SpaceData["settings"]) : EMPTY_SPACE_DATA.settings,
      plans: Array.isArray(body.plans) ? (body.plans as SpaceData["plans"]) : [],
      tasks: Array.isArray(body.tasks) ? (body.tasks as SpaceData["tasks"]) : [],
    };
    const { data, updatedAt } = await writeSpaceData(config, workspace.id, next);
    return jsonResponse({ data, updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/space", "client", async (ctx: RequestContext) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const { data, updatedAt } = await updateSpaceData(config, workspace.id, (current) => {
      const next = { ...current };
      if (isRecord(body.settings)) {
        next.settings = { ...current.settings, ...(body.settings as Partial<SpaceData["settings"]>) };
      }
      if (Array.isArray(body.plans)) next.plans = body.plans as SpaceData["plans"];
      if (Array.isArray(body.tasks)) next.tasks = body.tasks as SpaceData["tasks"];
      return next;
    });
    return jsonResponse({ data, updatedAt });
  });

  addRoute(routes, "GET", "/workspace/:id/space/assets", "client", async (ctx: RequestContext) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (workspace.workspaceType === "remote") {
      throw new ApiError(400, "space_assets_remote_unsupported", "Assets are only available for local workspaces");
    }
    const items = await listSpaceAssets(workspace.path);
    return jsonResponse({ items });
  });
}