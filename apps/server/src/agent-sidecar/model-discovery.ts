/**
 * Model Discovery — 运行时 CLI agent 模型发现
 *
 * 各 CLI agent 列出可用模型的方式不同：
 *   kimi:    `kimi models --json` → [{model: "kimi-code/k3", ...}]
 *   claude:  `claude --list-models` → ["claude-sonnet-4-5", ...]
 *   codex:   `codex models list --json` → [{id: "gpt-5-codex", ...}]
 *
 * 设计原则：
 *   1. 懒发现：首次请求时才 spawn，不影响启动速度
 *   2. 短进程：headless-oneshot 模式，用完即释放，不留孤儿
 *   3. 超时保护：默认 10s 超时，超时后 SIGTERM → SIGKILL 兜底
 *   4. 缓存：按 (agentId, binaryPath) 缓存，TTL 内不重复 spawn
 *   5. 并发上限：全局模型发现并发限制，避免同时 spawn 太多子进程
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolveCleanPath, findBinaryInPath } from "./detect.js";
import { restoreRealHomeEnv } from "./home-env.js";
import type { CliModelInfo } from "./cli-adapter/generic-cli.js";
import type { AgentPreset } from "./presets.js";

// ---------- 缓存 ----------

interface ModelCacheEntry {
  models: CliModelInfo[];
  cachedAt: number;
}

const modelCache = new Map<string, ModelCacheEntry>();

const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

// ---------- 并发控制 ----------

let activeDiscoveries = 0;
const MAX_CONCURRENT_DISCOVERIES = 3;
const discoveryQueue: Array<() => void> = [];

async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (activeDiscoveries < MAX_CONCURRENT_DISCOVERIES) {
    activeDiscoveries++;
    try {
      return await fn();
    } finally {
      activeDiscoveries--;
    }
  }
  return new Promise<T>((resolve) => {
    discoveryQueue.push(() => {
      resolve(withConcurrencyLimit(fn));
    });
  });
}

// ---------- 配置文件读取 ----------

async function readConfigModels(
  configPaths: string[],
  home: string,
): Promise<CliModelInfo[] | null> {
  for (const template of configPaths) {
    const configPath = template.replace("${HOME}", home);
    try {
      const content = await readFile(configPath, "utf-8");
      const models = parseConfigContent(content, configPath);
      if (models && models.length > 0) return models;
    } catch {
      continue;
    }
  }
  return null;
}

function parseConfigContent(content: string, _sourcePath: string): CliModelInfo[] | null {
  // TOML: [[models]] table or default_model = "xxx"
  const tomlModels: CliModelInfo[] = [];
  const modelRegex = /(?:default_model|model)\s*=\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = modelRegex.exec(content)) !== null) {
    const modelStr = match[1]!;
    const { providerID, modelID } = parseModelString(modelStr);
    tomlModels.push({ providerID, modelID, isDefault: match[0].includes("default_model") });
  }
  if (tomlModels.length > 0) return tomlModels;

  // JSON: {"models": [...]} or {"model": "xxx"}
  try {
    const json = JSON.parse(content);
    if (Array.isArray(json.models)) {
      return json.models.map((m: string | { id: string; model: string }) => {
        const modelStr = typeof m === "string" ? m : (m.id ?? m.model ?? "unknown");
        const { providerID, modelID } = parseModelString(modelStr);
        return { providerID, modelID };
      });
    }
    if (typeof json.model === "string") {
      const { providerID, modelID } = parseModelString(json.model);
      return [{ providerID, modelID }];
    }
  } catch {
    // not JSON, ignore
  }

  return null;
}

// ---------- CLI 命令执行 ----------

function executeModelCommand(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    let child: ChildProcess | null = null;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const finish = (stdout: string, stderr: string, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ stdout, stderr, exitCode });
    };

    try {
      child = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      finish("", String(err), null);
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish("", "", null));
    child.on("exit", (code) => finish(stdout, stderr, code));

    timeoutId = setTimeout(() => {
      if (child && !settled) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child && !settled) child.kill("SIGKILL");
          finish(stdout, stderr, null);
        }, 3000);
      }
    }, timeoutMs);
  });
}

// ---------- 输出解析 ----------

function parseModelOutput(stdout: string, stderr: string): CliModelInfo[] | null {
  const combined = stdout.trim() || stderr.trim();
  if (!combined) return null;

  // Try JSON first
  try {
    const parsed = JSON.parse(combined);
    return parseJsonModels(parsed);
  } catch {
    // not JSON, try line-by-line
  }

  // Line-by-line: each line is a model string
  const lines = combined.split("\n").map((l) => l.trim()).filter(Boolean);
  const models: CliModelInfo[] = [];
  for (const line of lines) {
    // Skip non-model lines
    if (line.startsWith("{") || line.startsWith("[") || line.startsWith("#") || line.startsWith("Available")) {
      continue;
    }
    const { providerID, modelID } = parseModelString(line);
    if (providerID && modelID) {
      models.push({ providerID, modelID });
    }
  }
  return models.length > 0 ? models : null;
}

function parseJsonModels(data: unknown): CliModelInfo[] | null {
  if (Array.isArray(data)) {
    return data
      .map((item) => {
        if (typeof item === "string") {
          const { providerID, modelID } = parseModelString(item);
          return { providerID, modelID };
        }
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const modelStr = String(obj.id ?? obj.model ?? obj.name ?? "");
          if (!modelStr) return null;
          const { providerID, modelID } = parseModelString(modelStr);
          const isDefault = Boolean(obj.default ?? obj.is_default);
          return { providerID, modelID, name: String(obj.name ?? modelStr), isDefault };
        }
        return null;
      })
      .filter((m): m is NonNullable<typeof m> => m !== null) as CliModelInfo[];
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.models)) return parseJsonModels(obj.models);
    if (typeof obj.model === "string") {
      const { providerID, modelID } = parseModelString(obj.model);
      return [{ providerID, modelID }];
    }
  }
  return null;
}

function parseModelString(modelStr: string): { providerID: string; modelID: string } {
  // Formats: "kimi-code/k3", "claude-sonnet-4-5", "gpt-4o"
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx >= 0) {
    return {
      providerID: modelStr.substring(0, slashIdx),
      modelID: modelStr.substring(slashIdx + 1),
    };
  }
  // Simple model name: infer provider from prefix
  const providerID = inferProvider(modelStr);
  return { providerID, modelID: modelStr };
}

function inferProvider(modelID: string): string {
  const lower = modelID.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt") || lower.startsWith("o3") || lower.startsWith("o4")) return "openai";
  if (lower.startsWith("gemini") || lower.startsWith("grok")) return "google";
  if (lower.startsWith("deepseek")) return "deepseek";
  if (lower.startsWith("kimi")) return "kimi";
  if (lower.startsWith("qwen")) return "qwen";
  if (lower.startsWith("minimax")) return "minimax";
  if (lower.startsWith("doubao")) return "doubao";
  if (lower.startsWith("glm")) return "zhipu";
  if (lower.startsWith("hunyuan")) return "tencent";
  return "unknown";
}

// ---------- 主入口 ----------

export interface DiscoverModelsOptions {
  forceRefresh?: boolean;
  timeoutMs?: number;
}

export async function discoverModelsForAgent(
  preset: AgentPreset,
  binaryPath: string,
  options: DiscoverModelsOptions = {},
): Promise<{ models: CliModelInfo[]; source: "cli-command" | "config-file" | "default"; durationMs: number }> {
  const cacheKey = `${preset.agentId}:${binaryPath}`;
  const now = Date.now();

  if (!options.forceRefresh) {
    const cached = modelCache.get(cacheKey);
    if (cached && now - cached.cachedAt < DEFAULT_CACHE_TTL_MS) {
      return { models: cached.models, source: "cli-command", durationMs: 0 };
    }
  }

  const start = now;
  const md = preset.modelDiscovery;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

  return withConcurrencyLimit(async () => {
    // Strategy 1: Try CLI command
    if (md?.command && binaryPath) {
      const timeoutMs = md.timeoutMs ?? 10_000;
      const env: Record<string, string> = { ...(process.env as Record<string, string>), ...restoreRealHomeEnv() };
      const { stdout, stderr } = await executeModelCommand(binaryPath, md.command, timeoutMs, env);

      const parsed = parseModelOutput(stdout, stderr);
      if (parsed && parsed.length > 0) {
        // Apply provider mapping
        const mapped = md.providerMap
          ? parsed.map((m) => ({
              ...m,
              providerID: md.providerMap![m.providerID] ?? m.providerID,
            }))
          : parsed;

        modelCache.set(cacheKey, { models: mapped, cachedAt: Date.now() });
        return {
          models: mapped,
          source: "cli-command" as const,
          durationMs: Date.now() - start,
        };
      }
    }

    // Strategy 2: Read config files
    if (md?.configPaths && home) {
      const configModels = await readConfigModels(md.configPaths, home);
      if (configModels && configModels.length > 0) {
        modelCache.set(cacheKey, { models: configModels, cachedAt: Date.now() });
        return {
          models: configModels,
          source: "config-file" as const,
          durationMs: Date.now() - start,
        };
      }
    }

    // Strategy 3: Fall back to defaultModel from preset
    if (preset.defaultModel) {
      const defaults: CliModelInfo[] = [
        { ...preset.defaultModel, isDefault: true },
      ];
      modelCache.set(cacheKey, { models: defaults, cachedAt: Date.now() });
      return {
        models: defaults,
        source: "default" as const,
        durationMs: Date.now() - start,
      };
    }

    return { models: [], source: "default" as const, durationMs: Date.now() - start };
  });
}

/** 清除指定 agent 的模型缓存 */
export function invalidateModelCache(agentId?: string): void {
  if (!agentId) {
    modelCache.clear();
    return;
  }
  const keys = Array.from(modelCache.keys());
  for (const key of keys) {
    if (key.startsWith(`${agentId}:`)) {
      modelCache.delete(key);
    }
  }
}

/** 获取当前缓存状态（debug / health 用） */
export function getModelCacheStatus(): Record<string, { modelCount: number; cachedAt: number; ageMs: number }> {
  const now = Date.now();
  const result: Record<string, { modelCount: number; cachedAt: number; ageMs: number }> = {};
  const entries = Array.from(modelCache.entries());
  for (const [key, entry] of entries) {
    result[key] = {
      modelCount: entry.models.length,
      cachedAt: entry.cachedAt,
      ageMs: now - entry.cachedAt,
    };
  }
  return result;
}
