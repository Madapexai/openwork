/**
 * WorktreeService — git worktree 生命周期服务（openspec-worktree-service.md）
 *
 * 借鉴 orca 的隔离模型：每个任务自动开一个独立分支 + 独立目录（git worktree），
 * agent 物理隔离，任务完成/失败后自动回收，多 agent 并行永不互相踩代码。
 *
 * 安全不变量：
 * I1: repoPath 必须是 git 仓库（git rev-parse --git-dir 验证），非仓库报 WorktreeError
 * I2: 所有路径使用绝对路径，拒绝相对路径穿越与空路径
 * I3: worktree path 创建前必须校验父目录存在；回收时只允许删除 WorktreeService 创建的目录
 * I4: create 后记录注册表条目（path/branch/createdAt/owner），remove/cleanupStale 只回收注册条目
 * I5: cleanupStale 只回收超过 maxIdleMs 的孤儿 worktree，绝不误删活跃 worktree
 *
 * 实现使用 git CLI（node:child_process execFile），无第三方依赖。
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 统一的 worktree 错误 */
export class WorktreeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
  }
}

/** worktree 注册条目 */
export interface WorktreeEntry {
  /** worktree 目录绝对路径 */
  path: string;
  /** 关联分支 */
  branch: string;
  /** 创建时间 */
  createdAt: number;
  /** 归属方（taskId / agentId，用于溯源） */
  owner?: string;
}

export interface CreateWorktreeOptions {
  /** 目标仓库绝对路径 */
  repoPath: string;
  /** 新分支名（默认基于时间戳生成） */
  branch?: string;
  /** 归属方（taskId 等） */
  owner?: string;
  /** 父目录（默认系统临时目录下） */
  parentDir?: string;
}

export interface ListWorktreeItem {
  path: string;
  branch: string;
  head: string;
}

/** 默认回收闲置时长：6 小时 */
export const DEFAULT_STALE_IDLE_MS = 6 * 60 * 60 * 1000;

function runGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** I1: 校验是 git 仓库，返回解析后的绝对路径 */
export async function assertGitRepo(repoPath: string): Promise<string> {
  if (!isAbsolute(repoPath)) {
    throw new WorktreeError("INVALID_PATH", `repoPath must be absolute: ${repoPath}`);
  }
  const abs = resolve(repoPath);
  try {
    await runGit(["rev-parse", "--git-dir"], abs);
  } catch {
    throw new WorktreeError("NOT_A_GIT_REPO", `'${abs}' is not a git repository`);
  }
  return abs;
}

function validateAbsoluteDir(label: string, value: string | undefined): void {
  if (!value) return;
  if (!isAbsolute(value)) {
    throw new WorktreeError("INVALID_PATH", `${label} must be an absolute path: ${value}`);
  }
}

/** 校验 worktree 名安全（仅用于 owner 溯源字段，非路径） */
function safeOwner(owner?: string): string | undefined {
  if (!owner) return undefined;
  // 只允许 [\w.-]（避免把 owner 拼进路径造成穿越）
  return /^[\w.\-:]+$/.test(owner) ? owner : undefined;
}

export class WorktreeService {
  /** 进程内注册表：path → entry（I4） */
  private readonly registry = new Map<string, WorktreeEntry>();

  /**
   * I1/I2/I3: 创建 worktree
   * - repo 校验 + 父目录校验
   * - git worktree add <path> -b <branch>（要求 repo 已有 HEAD，即至少一个 commit）
   * - 注册条目
   */
  async create(options: CreateWorktreeOptions): Promise<WorktreeEntry> {
    const repo = await assertGitRepo(options.repoPath);
    validateAbsoluteDir("parentDir", options.parentDir);

    const parentDir = options.parentDir
      ? resolve(options.parentDir)
      : await mkdtemp(join(tmpdir(), "ow-worktree-"));
    const branch = options.branch ?? `ow-task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const worktreePath = join(parentDir, branch);

    try {
      await mkdir(parentDir, { recursive: true });
    } catch (error) {
      throw new WorktreeError("MKDIR_FAILED", `Failed to create parent dir ${parentDir}: ${String(error)}`);
    }

    try {
      await runGit(["worktree", "add", worktreePath, "-b", branch], repo);
    } catch (error) {
      // 常见原因：repo 无 commit（git worktree add 需要 HEAD）
      const message = error instanceof Error ? error.message : String(error);
      if (/reference not found|not a valid object name/i.test(message)) {
        throw new WorktreeError(
          "REPO_NO_COMMITS",
          `Repository '${repo}' has no commits yet; commit at least once before creating worktrees`,
        );
      }
      throw new WorktreeError("WORKTREE_ADD_FAILED", `git worktree add failed: ${message}`);
    }

    const entry: WorktreeEntry = {
      // 用 realpath 规范化（macOS /var → /private/var），保证与 git worktree list 输出一致
      path: await realpath(worktreePath),
      branch,
      createdAt: Date.now(),
      owner: safeOwner(options.owner),
    };
    this.registry.set(entry.path, entry);
    return entry;
  }

  /** I1/I2: 列出仓库所有 worktree（git worktree list --porcelain） */
  async list(repoPath: string): Promise<ListWorktreeItem[]> {
    const repo = await assertGitRepo(repoPath);
    const { stdout } = await runGit(["worktree", "list", "--porcelain"], repo);
    const items: ListWorktreeItem[] = [];
    let current: Partial<ListWorktreeItem> = {};
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        current.path = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch refs/heads/".length);
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice("HEAD ".length);
      } else if (line.trim() === "") {
        if (current.path) items.push(current as ListWorktreeItem);
        current = {};
      }
    }
    if (current.path) items.push(current as ListWorktreeItem);
    return items;
  }

  /**
   * I3/I4: 回收 worktree
   * - 只允许删除注册表内的条目（或强制 force 时校验路径在注册表或已被移除）
   * - git worktree remove --force + 清理注册条目
   */
  async remove(repoPath: string, worktreePath: string, options: { force?: boolean } = {}): Promise<boolean> {
    const repo = await assertGitRepo(repoPath);
    const abs = resolve(worktreePath);

    const registered = this.registry.get(abs);
    if (!registered && !options.force) {
      throw new WorktreeError("UNMANAGED_WORKTREE", `Worktree '${abs}' is not managed by this service`);
    }

    try {
      await runGit(["worktree", "remove", "--force", abs], repo);
    } catch {
      // 已不存在视为成功
      if (await this.pathExists(abs)) {
        throw new WorktreeError("WORKTREE_REMOVE_FAILED", `Failed to remove worktree '${abs}'`);
      }
    }
    this.registry.delete(abs);
    return true;
  }

  /** I1: prune 失效 worktree 元数据 */
  async prune(repoPath: string): Promise<void> {
    const repo = await assertGitRepo(repoPath);
    await runGit(["worktree", "prune"], repo);
  }

  /**
   * I5: 回收闲置孤儿 worktree
   * - 遍历注册表条目，超过 maxIdleMs 且目录存在 → remove
   * - 返回回收数量
   */
  async cleanupStale(repoPath: string, maxIdleMs: number = DEFAULT_STALE_IDLE_MS): Promise<number> {
    const repo = await assertGitRepo(repoPath);
    const now = Date.now();
    let removed = 0;
    for (const entry of [...this.registry.values()]) {
      if (now - entry.createdAt >= maxIdleMs) {
        try {
          await this.remove(repo, entry.path, { force: true });
          removed++;
        } catch {
          // 单个失败不影响整体回收
        }
      }
    }
    await this.prune(repo);
    return removed;
  }

  /** 注册表快照（测试/诊断用） */
  snapshot(): WorktreeEntry[] {
    return [...this.registry.values()];
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
}

/** 清理临时父目录（创建 worktree 后自行管理） */
export async function removeWorktreeDir(path: string): Promise<void> {
  const abs = resolve(path);
  // 只允许删除明确传入的绝对路径（I2）
  if (!isAbsolute(abs)) throw new WorktreeError("INVALID_PATH", `path must be absolute: ${path}`);
  if (abs === sep || abs === resolve(sep)) {
    throw new WorktreeError("REFUSE_ROOT", "Refusing to remove filesystem root");
  }
  await rm(abs, { recursive: true, force: true });
}
