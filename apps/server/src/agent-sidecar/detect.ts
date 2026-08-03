/**
 * Agent 检测工具
 *
 * 借鉴 multica 的 runtime auto-detect 机制：
 * - 启动时扫描 PATH，发现所有可用的 CLI agent
 * - 解析 --version 输出获取版本号
 * - 支持显式 PATH 注入（避免父进程污染，PoC 测试发现的痛点）
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { dirname as pathDirname, join } from "node:path";
import { AGENT_PRESETS, type AgentPreset } from "./presets.js";
import type { AgentDetectResult } from "./types.js";

/** 系统默认 PATH（避免父进程污染） */
const DEFAULT_SYSTEM_PATH = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
].join(":");

/**
 * 解析一个干净的 PATH 字符串，避免父进程 PATH 污染
 */
export function resolveCleanPath(customPath?: string): string {
  if (customPath) return customPath;
  const userPath = process.env.PATH ?? "";
  // 保留用户 PATH 中明显是工具安装路径的部分
  const userExtras = userPath
    .split(":")
    .filter((p) =>
      p.includes("/.nvm/") ||
      p.includes("/.local/bin") ||
      p.includes("/.kimi-code/") ||
      p.includes("/.cargo/bin") ||
      p.includes("/.bun/bin") ||
      p.includes("/go/bin") ||
      p.includes("/Library/Python/") ||
      p.includes("/npm-global/bin")
    );
  return [...userExtras, DEFAULT_SYSTEM_PATH].join(":");
}

/**
 * 在 PATH 中查找可执行文件
 */
export async function findBinaryInPath(binary: string, path: string): Promise<string | null> {
  if (!binary) return null;
  // 绝对路径直接验证
  if (binary.startsWith("/")) {
    try {
      await access(binary, constants.X_OK);
      return binary;
    } catch {
      return null;
    }
  }
  const dirs = path.split(":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, binary);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 获取 agent 版本号
 */
export async function getAgentVersion(
  binaryPath: string,
  args: string[] = ["--version"],
  env?: Record<string, string>,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      timeout: 5000,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", () => resolve(undefined));
    child.on("exit", () => {
      const match = output.match(/(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)/);
      resolve(match?.[1]);
    });
  });
}

/**
 * 检测单个 agent 的可用性
 *
 * 接受 AgentPreset 或最小子集（agentId + binary + binaryPath）
 */
export async function detectAgent(
  preset: { agentId: string; binary?: string; binaryPath?: string },
  customPath?: string,
): Promise<AgentDetectResult> {
  const cleanPath = resolveCleanPath(customPath);
  const binary = preset.binaryPath ?? preset.binary;
  if (!binary) {
    return {
      agentId: preset.agentId,
      available: false,
      error: "No binary specified in preset",
    };
  }
  try {
    const binaryPath = await findBinaryInPath(binary, cleanPath);
    if (!binaryPath) {
      return {
        agentId: preset.agentId,
        available: false,
        error: `Binary '${binary}' not found in PATH`,
      };
    }
    const version = await getAgentVersion(binaryPath).catch(() => undefined);
    return {
      agentId: preset.agentId,
      available: true,
      binaryPath,
      version,
    };
  } catch (error) {
    return {
      agentId: preset.agentId,
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 扫描所有 preset 的可用性
 *
 * 借鉴 multica daemon 的 auto-detect 逻辑：
 * - 启动时扫描所有 preset
 * - 返回可用 agent 列表
 * - UI 层展示给用户选择
 */
export async function detectAllAgents(customPath?: string): Promise<AgentDetectResult[]> {
  const presets = Object.values(AGENT_PRESETS).filter((p) => !p.disabled);
  // 限制并发数，避免 PATH 扫描压爆文件系统
  const concurrency = 8;
  const results: AgentDetectResult[] = [];
  for (let i = 0; i < presets.length; i += concurrency) {
    const batch = presets.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((p) => detectAgent(p, customPath)));
    results.push(...batchResults);
  }
  return results;
}

/**
 * 列出所有可用 agent（available === true）
 */
export async function listAvailableAgents(customPath?: string): Promise<AgentDetectResult[]> {
  const all = await detectAllAgents(customPath);
  return all.filter((r) => r.available);
}

/** 获取二进制所在目录（用于 PATH 列表展示） */
export function getBinaryDir(binaryPath: string): string {
  return pathDirname(binaryPath);
}
