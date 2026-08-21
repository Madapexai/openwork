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
import { restoreRealHomeEnv } from "./home-env.js";

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
 * 常见工具安装目录（PATH 之外也枚举，覆盖"装了但不在 PATH"的 agent）
 *
 * 各 CLI agent 的惯例安装位置：
 * - $HOME/.local/bin（curl/npm 脚本安装约定）
 * - npm 全局 bin（.npm-global/bin、npm-global/bin）
 * - $HOME/.bun/bin、$HOME/.cargo/bin（bun/cargo 安装约定）
 * - 各 agent 自带 bin 目录（kimi-code / opencode / trae / goose / codex / claude / gemini）
 */
export function getExtraSearchDirs(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return [];
  const dirs = new Set<string>();
  dirs.add(join(home, ".local", "bin"));
  dirs.add(join(home, ".npm-global", "bin"));
  dirs.add(join(home, "npm-global", "bin"));
  dirs.add(join(home, ".bun", "bin"));
  dirs.add(join(home, ".cargo", "bin"));
  dirs.add(join(home, ".kimi-code", "bin")); // kimi
  dirs.add(join(home, ".opencode", "bin")); // opencode
  dirs.add(join(home, ".trae", "bin")); // trae-cli
  dirs.add(join(home, ".goose", "bin")); // goose
  dirs.add(join(home, ".codex", "bin")); // codex
  dirs.add(join(home, ".claude", "bin")); // claude-code
  dirs.add(join(home, ".gemini", "bin")); // gemini-cli
  dirs.add(join(home, ".local", "share", "aider", "bin")); // aider
  dirs.add(join(home, ".local", "share", "openhands")); // openhands
  return [...dirs];
}

/**
 * 在 PATH 中查找可执行文件
 */
export async function findBinaryInPath(binary: string, path: string): Promise<string | null> {
  return findBinaryInDirs(binary, path.split(":").filter(Boolean));
}

/**
 * 在指定目录列表中查找可执行文件
 */
export async function findBinaryInDirs(binary: string, dirs: string[]): Promise<string | null> {
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
    const homeOverride = restoreRealHomeEnv();
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // 注入真实 HOME：探测命令也会触发 agent 启动初始化（如 trae-cli 的
      // keyring 支持检查会写 test-key-<时间戳>），隔离 HOME 下找不到
      // login.keychain-db 会触发系统弹窗
      env: { ...process.env, ...homeOverride, ...env },
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
    // 深度遍历：先 PATH，再常见安装目录（覆盖"装了但不在 PATH"的 agent，
    // 如 ~/.kimi-code/bin、~/.local/bin、npm 全局 bin 等）
    const pathDirs = cleanPath.split(":").filter(Boolean);
    const binaryPath =
      (await findBinaryInDirs(binary, pathDirs)) ??
      (await findBinaryInDirs(binary, getExtraSearchDirs()));
    if (!binaryPath) {
      return {
        agentId: preset.agentId,
        available: false,
        error: `Binary '${binary}' not found in PATH or common install dirs`,
      };
    }
    // 置信度：preset 显式绝对路径 > PATH 命中 > 常见安装目录命中；
    // --version 成功解析出版本号再 +0.15（上限 1.0）
    let confidence: number;
    if (binary.startsWith("/")) {
      confidence = 0.95;
    } else {
      const inPath = pathDirs.some((dir) => binaryPath.startsWith(dir + "/"));
      confidence = inPath ? 0.85 : 0.7;
    }
    const version = await getAgentVersion(binaryPath).catch(() => undefined);
    if (version) confidence = Math.min(1, confidence + 0.15);
    return {
      agentId: preset.agentId,
      available: true,
      binaryPath,
      version,
      confidence,
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
  // 按置信度排序：available 优先，可用 agent 内 confidence 降序
  results.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
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
