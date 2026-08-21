import { runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { shortId } from "./utils.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

export type SpacePlanStatus = "backlog" | "active" | "done";

export type SpaceTaskStatus = "todo" | "doing" | "done";

export type SpaceTaskPriority = "low" | "medium" | "high";

export type SpacePlan = {
  id: string;
  title: string;
  detail: string;
  status: SpacePlanStatus;
  updatedAt: number;
};

export type SpaceTask = {
  id: string;
  title: string;
  status: SpaceTaskStatus;
  priority: SpaceTaskPriority;
  updatedAt: number;
};

export type SpaceSettings = {
  name: string;
  description: string;
  skills: string[];
  env: Record<string, string>;
};

export type SpaceData = {
  settings: SpaceSettings;
  plans: SpacePlan[];
  tasks: SpaceTask[];
};

export const EMPTY_SPACE_DATA: SpaceData = {
  settings: { name: "", description: "", skills: [], env: {} },
  plans: [],
  tasks: [],
};

export function createSpacePlanId(): string {
  return `plan_${Date.now().toString(36)}_${shortId()}`;
}

export function createSpaceTaskId(): string {
  return `task_${Date.now().toString(36)}_${shortId()}`;
}

function normalizeId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 256) : "";
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 500);
}

function normalizeDetail(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 20_000);
}

function normalizePlanStatus(value: unknown): SpacePlanStatus {
  return value === "active" || value === "done" ? value : "backlog";
}

function normalizeTaskStatus(value: unknown): SpaceTaskStatus {
  return value === "doing" || value === "done" ? value : "todo";
}

function normalizeTaskPriority(value: unknown): SpaceTaskPriority {
  return value === "medium" || value === "high" ? value : "low";
}

function normalizeEnv(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const trimmedKey = key.trim().slice(0, 200);
    if (!trimmedKey) continue;
    out[trimmedKey] = typeof raw === "string" ? raw.slice(0, 8_000) : String(raw ?? "");
  }
  return out;
}

function normalizeSkills(value: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  const seen = new Set<string>();
  for (const raw of value) {
    const skill = typeof raw === "string" ? raw.trim().slice(0, 200) : "";
    if (!skill || seen.has(skill)) continue;
    out.push(skill);
    seen.add(skill);
  }
  return out.slice(0, 200);
}

function normalizePlans(value: unknown): SpacePlan[] {
  const out: SpacePlan[] = [];
  if (!Array.isArray(value)) return out;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = normalizeId(item.id);
    const title = normalizeTitle(item.title);
    if (!id || !title || seen.has(id)) continue;
    out.push({
      id,
      title,
      detail: normalizeDetail(item.detail),
      status: normalizePlanStatus(item.status),
      updatedAt: typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
    });
    seen.add(id);
  }
  return out;
}

function normalizeTasks(value: unknown): SpaceTask[] {
  const out: SpaceTask[] = [];
  if (!Array.isArray(value)) return out;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = normalizeId(item.id);
    const title = normalizeTitle(item.title);
    if (!id || !title || seen.has(id)) continue;
    out.push({
      id,
      title,
      status: normalizeTaskStatus(item.status),
      priority: normalizeTaskPriority(item.priority),
      updatedAt: typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
    });
    seen.add(id);
  }
  return out;
}

export function normalizeSpaceData(value: unknown): SpaceData {
  if (!isRecord(value)) return EMPTY_SPACE_DATA;
  const settings = isRecord(value.settings)
    ? {
        name: typeof value.settings.name === "string" ? value.settings.name.slice(0, 200) : "",
        description: typeof value.settings.description === "string" ? value.settings.description.slice(0, 2_000) : "",
        skills: normalizeSkills(value.settings.skills),
        env: normalizeEnv(value.settings.env),
      }
    : EMPTY_SPACE_DATA.settings;
  return {
    settings,
    plans: normalizePlans(value.plans),
    tasks: normalizeTasks(value.tasks),
  };
}

function parseSpaceData(stateJson: string): SpaceData {
  try {
    return normalizeSpaceData(JSON.parse(stateJson));
  } catch {
    return EMPTY_SPACE_DATA;
  }
}

const spaceDataStore = createWorkspaceKvStore<SpaceData>({
  tableName: "space_data",
  valueColumn: "space_json",
  extraColumns: { schemaVersion: { name: "schema_version", definition: "INTEGER NOT NULL DEFAULT 1", value: 1 } },
  parse: parseSpaceData,
  serialize: (value) => JSON.stringify(value),
});

const updateQueueByWorkspace = new Map<string, Promise<void>>();

export async function readSpaceData(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ data: SpaceData; updatedAt: number | null }> {
  const row = await spaceDataStore.getRow(config, workspaceId);
  if (!row || row.updatedAt === null) return { data: EMPTY_SPACE_DATA, updatedAt: null };
  return { data: row.value, updatedAt: row.updatedAt };
}

export async function writeSpaceData(
  config: ServerConfig,
  workspaceId: string,
  data: SpaceData,
): Promise<{ data: SpaceData; updatedAt: number }> {
  const next = normalizeSpaceData(data);
  const updatedAt = Date.now();
  await spaceDataStore.set(config, workspaceId, next, updatedAt);
  return { data: next, updatedAt };
}

export async function updateSpaceData(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: SpaceData) => SpaceData,
): Promise<{ data: SpaceData; updatedAt: number }> {
  const key = `${runtimeDbPath(config)}:${workspaceId}`;
  const previous = updateQueueByWorkspace.get(key) ?? Promise.resolve();
  let release = () => {};
  const queued = new Promise<void>((resolve) => {
    release = resolve;
  });
  const currentQueue = previous.then(() => queued, () => queued);
  updateQueueByWorkspace.set(key, currentQueue);

  await previous.catch(() => undefined);
  try {
    const current = await readSpaceData(config, workspaceId);
    return await writeSpaceData(config, workspaceId, updater(current.data));
  } finally {
    release();
    if (updateQueueByWorkspace.get(key) === currentQueue) {
      updateQueueByWorkspace.delete(key);
    }
  }
}