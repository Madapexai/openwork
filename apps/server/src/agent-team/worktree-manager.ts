/**
 * WorktreeManager - Git worktree 隔离管理
 *
 * 借鉴 orca 的多 worktree 隔离机制，为每个 team member 创建独立的 git worktree，
 * 确保多个 agent 并行执行时文件操作互不干扰。
 *
 * 核心能力：
 * - createWorktree(teamId, agentId, baseBranch, worktreePrefix): 创建独立 worktree
 * - removeWorktree(worktreePath): 清理 worktree
 * - listWorktrees(repoPath): 列出所有 worktree
 * - getWorktreeCwd(baseCwd, teamId, agentId): 获取 agent 的 worktree 路径
 *
 * 当仓库不是 git 仓库时，自动降级为使用独立临时目录（无 worktree 模式）。
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface WorktreeConfig {
  /** 是否启用 worktree 隔离（默认 true） */
  enabled: boolean;
  /** 基准分支（从该分支创建 worktree） */
  baseBranch: string;
  /** worktree 目录前缀（如 "openwork-team-{teamId}-"） */
  prefix: string;
  /** worktree 根目录（可选，默认在项目所在磁盘创建） */
  rootDir?: string;
  /** worktree 生命周期（毫秒），默认 30 分钟后自动清理 */
  maxLifetimeMs?: number;
}

export const DEFAULT_WORKTREE_CONFIG: WorktreeConfig = {
  enabled: false,
  baseBranch: "main",
  prefix: "openwork-team-",
  maxLifetimeMs: 30 * 60 * 1000,
};

export interface WorktreeInfo {
  /** worktree 路径（agent 的 cwd） */
  path: string;
  /** worktree 分支名 */
  branch: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 是否为 git worktree（false 表示临时目录降级） */
  isGitWorktree: boolean;
  /** 关联的 teamId */
  teamId: string;
  /** 关联的 agentId */
  agentId: string;
}

export type MergeStrategy = "auto-merge" | "cherry-pick" | "sequential";

export interface MergeOptions {
  /** 目标分支（默认使用 config.baseBranch） */
  targetBranch?: string;
  /** 合并策略 */
  strategy?: MergeStrategy;
  /** 是否在合并后清理 worktree */
  cleanupAfterMerge?: boolean;
  /** commit 消息前缀 */
  commitMessagePrefix?: string;
  /** 冲突时是否自动中止并报告 */
  abortOnConflict?: boolean;
}

export interface MergeResult {
  /** 是否成功 */
  success: boolean;
  /** 合并的 worktree 列表 */
  mergedWorktrees: string[];
  /** 冲突的 worktree 列表 */
  conflicts: Array<{
    worktreePath: string;
    conflictFiles: string[];
    message: string;
  }>;
  /** 合并产生的 commit hashes */
  commitHashes: string[];
  /** 错误信息 */
  error?: string;
}

export interface WorktreeDiff {
  /** worktree 路径 */
  worktreePath: string;
  /** 新增文件 */
  added: string[];
  /** 修改文件 */
  modified: string[];
  /** 删除文件 */
  deleted: string[];
  /** 未追踪文件 */
  untracked: string[];
  /** 变更文件总数 */
  changeCount: number;
}

export class WorktreeManager {
  private config: WorktreeConfig;
  private readonly worktrees = new Map<string, WorktreeInfo>();
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: Partial<WorktreeConfig> = {}) {
    this.config = { ...DEFAULT_WORKTREE_CONFIG, ...config };
  }

  /**
   * 为指定 team member 创建独立 worktree
   *
   * @param teamId 团队 ID
   * @param agentId Agent ID
   * @param baseCwd 基准工作目录（git 仓库根目录）
   * @returns worktree 信息（包含 agent 应使用的 cwd）
   */
  createWorktree(teamId: string, agentId: string, baseCwd: string): WorktreeInfo {
    const key = `${teamId}:${agentId}`;

    // 复用已存在的 worktree（未过期）
    const existing = this.worktrees.get(key);
    if (existing && Date.now() - existing.createdAt < (this.config.maxLifetimeMs ?? 30 * 60 * 1000)) {
      return existing;
    }

    // 如果已存在旧的，先清理
    if (existing) {
      this.removeWorktree(existing.path);
    }

    const branchName = `${this.config.prefix}${teamId}-${agentId}`.replace(/[^a-zA-Z0-9_-]/g, "_");

    // 尝试创建 git worktree
    const worktreeInfo = this.tryCreateGitWorktree(baseCwd, branchName, teamId, agentId);

    this.worktrees.set(key, worktreeInfo);

    // 注册自动清理定时器
    if (this.config.maxLifetimeMs && this.config.maxLifetimeMs > 0) {
      const timer = setTimeout(() => {
        this.removeWorktree(worktreeInfo.path);
        this.worktrees.delete(key);
        this.cleanupTimers.delete(key);
      }, this.config.maxLifetimeMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      this.cleanupTimers.set(key, timer);
    }

    return worktreeInfo;
  }

  /**
   * 清理指定路径的 worktree
   */
  removeWorktree(worktreePath: string): void {
    try {
      // 尝试 git worktree remove
      try {
        execSync(`git worktree remove --force "${worktreePath}"`, {
          cwd: this.findRepoRoot(worktreePath),
          stdio: "pipe",
        });
      } catch {
        // 如果不是 git worktree，直接删除目录
        rmSync(worktreePath, { recursive: true, force: true });
      }
    } catch {
      // 兜底：直接删除
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // swallow
      }
    }
  }

  /**
   * 获取指定 team member 的 worktree 路径（cwd）
   * 如果 worktree 不存在，自动创建
   */
  getWorktreeCwd(teamId: string, agentId: string, baseCwd: string): string {
    const key = `${teamId}:${agentId}`;
    const existing = this.worktrees.get(key);
    if (existing) {
      return existing.path;
    }
    return this.createWorktree(teamId, agentId, baseCwd).path;
  }

  /**
   * 列出当前所有管理中的 worktree
   */
  listWorktrees(): WorktreeInfo[] {
    return [...this.worktrees.values()];
  }

  /**
   * 获取指定 worktree 的变更差异
   */
  getWorktreeDiff(worktreePath: string): WorktreeDiff {
    const diff: WorktreeDiff = {
      worktreePath,
      added: [],
      modified: [],
      deleted: [],
      untracked: [],
      changeCount: 0,
    };

    try {
      const repoRoot = this.findRepoRoot(worktreePath);

      // 检查是否为 git worktree
      if (!this.isGitWorktree(worktreePath)) {
        // 临时目录：扫描所有文件
        try {
          const results: string[] = [];
          const scan = (dir: string) => {
            for (const entry of readdirSync(dir)) {
              const fullPath = join(dir, entry);
              if (entry.startsWith(".") && dir === worktreePath) continue;
              if (statSync(fullPath).isDirectory()) scan(fullPath);
              else results.push(fullPath.replace(worktreePath + "/", ""));
            }
          };
          scan(worktreePath);
          diff.untracked = results;
          diff.changeCount = results.length;
        } catch {
          // swallow
        }
        return diff;
      }

      // Git worktree：获取差异
      const baseBranch = this.config.baseBranch;

      // staged changes
      try {
        const staged = execSync("git diff --cached --name-status", {
          cwd: worktreePath,
          stdio: "pipe",
        }).toString().trim();
        this.parseDiffOutput(staged, diff);
      } catch { /* ignore */ }

      // unstaged changes
      try {
        const unstaged = execSync("git diff --name-status", {
          cwd: worktreePath,
          stdio: "pipe",
        }).toString().trim();
        this.parseDiffOutput(unstaged, diff);
      } catch { /* ignore */ }

      // changes vs base branch
      try {
        const vsBase = execSync(`git diff --name-status ${baseBranch}...HEAD`, {
          cwd: worktreePath,
          stdio: "pipe",
        }).toString().trim();
        this.parseDiffOutput(vsBase, diff);
      } catch { /* ignore */ }

      // untracked files
      try {
        const untracked = execSync("git ls-files --others --exclude-standard", {
          cwd: worktreePath,
          stdio: "pipe",
        }).toString().trim();
        if (untracked) {
          diff.untracked = untracked.split("\n").filter(Boolean);
        }
      } catch { /* ignore */ }

      diff.changeCount = diff.added.length + diff.modified.length + diff.deleted.length + diff.untracked.length;
    } catch {
      // swallow errors
    }

    return diff;
  }

  /**
   * 合并所有 worktree 的变更回目标分支
   * 
   * @param options 合并选项
   * @returns 合并结果
   */
  mergeWorktrees(options: MergeOptions = {}): MergeResult {
    const result: MergeResult = {
      success: true,
      mergedWorktrees: [],
      conflicts: [],
      commitHashes: [],
    };

    const targetBranch = options.targetBranch ?? this.config.baseBranch;
    const strategy = options.strategy ?? "auto-merge";
    const commitPrefix = options.commitMessagePrefix ?? "openwork-team";
    const cleanupAfterMerge = options.cleanupAfterMerge ?? false;
    const abortOnConflict = options.abortOnConflict ?? true;

    const worktrees = this.listWorktrees().filter(wt => wt.isGitWorktree);
    
    if (worktrees.length === 0) {
      result.success = true;
      return result;
    }

    try {
      const repoRoot = this.findRepoRoot(worktrees[0].path);

      // 确保目标分支存在
      try {
        execSync(`git rev-parse --verify "${targetBranch}"`, { cwd: repoRoot, stdio: "pipe" });
      } catch {
        // 从当前分支创建目标分支
        const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, stdio: "pipe" }).toString().trim();
        execSync(`git branch "${targetBranch}" "${currentBranch}"`, { cwd: repoRoot, stdio: "pipe" });
      }

      // 保存当前分支
      let originalBranch = "HEAD";
      try {
        originalBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, stdio: "pipe" }).toString().trim();
      } catch { /* ignore */ }

      // 切换到目标分支
      execSync(`git checkout "${targetBranch}"`, { cwd: repoRoot, stdio: "pipe" });

      // 按策略合并
      for (const wt of worktrees) {
        try {
          // 检查 worktree 是否有变更
          const diff = this.getWorktreeDiff(wt.path);
          if (diff.changeCount === 0) {
            continue; // 无变更，跳过
          }

          let commitHash: string;

          switch (strategy) {
            case "cherry-pick":
              commitHash = this.mergeByCherryPick(wt, targetBranch, commitPrefix);
              break;
            case "sequential":
              commitHash = this.mergeBySequential(wt, targetBranch, commitPrefix);
              break;
            case "auto-merge":
            default:
              commitHash = this.mergeByAutoMerge(wt, targetBranch, commitPrefix);
              break;
          }

          result.mergedWorktrees.push(wt.path);
          result.commitHashes.push(commitHash);

          // 清理 worktree
          if (cleanupAfterMerge) {
            this.removeWorktree(wt.path);
            this.worktrees.delete(`${wt.teamId}:${wt.agentId}`);
          }
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          
          // 检查是否为冲突
          if (errorMsg.includes("conflict") || errorMsg.includes("CONFLICT")) {
            const conflictFiles = this.detectConflicts(repoRoot);
            result.conflicts.push({
              worktreePath: wt.path,
              conflictFiles,
              message: errorMsg,
            });

            if (abortOnConflict) {
              // 中止当前合并操作
              try {
                execSync("git merge --abort 2>/dev/null || true", { cwd: repoRoot, stdio: "pipe" });
                execSync("git cherry-pick --abort 2>/dev/null || true", { cwd: repoRoot, stdio: "pipe" });
              } catch { /* ignore */ }
              
              result.success = false;
              result.error = `合并在 worktree ${wt.path} 处发生冲突`;
              break;
            }
          } else {
            result.success = false;
            result.error = errorMsg;
            break;
          }
        }
      }

      // 切回原分支
      if (originalBranch !== "HEAD") {
        try {
          execSync(`git checkout "${originalBranch}"`, { cwd: repoRoot, stdio: "pipe" });
        } catch { /* ignore */ }
      }
    } catch (err: unknown) {
      result.success = false;
      result.error = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  /**
   * 检测当前仓库的冲突文件
   */
  private detectConflicts(repoRoot: string): string[] {
    const conflictFiles: string[] = [];
    try {
      const output = execSync("git diff --name-only --diff-filter=U", {
        cwd: repoRoot,
        stdio: "pipe",
      }).toString().trim();
      if (output) {
        conflictFiles.push(...output.split("\n").filter(Boolean));
      }
    } catch { /* ignore */ }
    return conflictFiles;
  }

  /**
   * 自动合并：直接 merge worktree 分支
   */
  private mergeByAutoMerge(wt: WorktreeInfo, targetBranch: string, commitPrefix: string): string {
    const repoRoot = this.findRepoRoot(wt.path);

    // 获取 worktree 的最新 commit
    const lastCommit = execSync("git rev-parse HEAD", {
      cwd: wt.path,
      stdio: "pipe",
    }).toString().trim();

    // 创建合并 commit 信息
    const commitMsg = `${commitPrefix}: merge changes from ${wt.agentId} (${wt.branch})`;

    // 尝试 merge worktree 的分支
    execSync(`git merge --no-ff "${wt.branch}" -m "${commitMsg}"`, {
      cwd: repoRoot,
      stdio: "pipe",
    });

    return execSync("git rev-parse HEAD", { cwd: repoRoot, stdio: "pipe" }).toString().trim();
  }

  /**
   * Cherry-pick 合并：将 worktree 的每个 commit 单独 cherry-pick
   */
  private mergeByCherryPick(wt: WorktreeInfo, targetBranch: string, commitPrefix: string): string {
    const repoRoot = this.findRepoRoot(wt.path);

    // 获取 worktree 相对于 baseBranch 的所有新 commit
    const commits = execSync(`git log ${this.config.baseBranch}..${wt.branch} --format="%H"`, {
      cwd: wt.path,
      stdio: "pipe",
    }).toString().trim().split("\n").filter(Boolean);

    let lastHash = "";
    for (const commit of commits) {
      execSync(`git cherry-pick "${commit}"`, {
        cwd: repoRoot,
        stdio: "pipe",
      });
      lastHash = commit;
    }

    // 如果没有新 commit，创建一个空的合并记录
    if (!lastHash) {
      const commitMsg = `${commitPrefix}: sync changes from ${wt.agentId} (no new commits)`;
      execSync(`git commit --allow-empty -m "${commitMsg}"`, {
        cwd: repoRoot,
        stdio: "pipe",
      });
      lastHash = execSync("git rev-parse HEAD", { cwd: repoRoot, stdio: "pipe" }).toString().trim();
    }

    return lastHash;
  }

  /**
   * 顺序合并：在 worktree 中创建 squash commit，然后 merge 到目标分支
   */
  private mergeBySequential(wt: WorktreeInfo, targetBranch: string, commitPrefix: string): string {
    const repoRoot = this.findRepoRoot(wt.path);

    // 在 worktree 中创建一个 squash commit（包含所有变更）
    const squashBranch = `${wt.branch}-squash-${Date.now()}`;
    const commitMsg = `${commitPrefix}: ${wt.agentId} changes (squash)`;

    // 创建临时分支并 squash
    execSync(`git checkout -b "${squashBranch}" "${wt.branch}"`, {
      cwd: repoRoot,
      stdio: "pipe",
    });

    // 获取相对于 baseBranch 的变更并 commit
    const diffOutput = execSync(`git diff ${this.config.baseBranch}..HEAD`, {
      cwd: repoRoot,
      stdio: "pipe",
    }).toString();

    if (diffOutput.trim()) {
      execSync(`git checkout "${targetBranch}"`, { cwd: repoRoot, stdio: "pipe" });
      execSync(`git merge --no-ff "${squashBranch}" -m "${commitMsg}"`, {
        cwd: repoRoot,
        stdio: "pipe",
      });
    } else {
      // 无实际变更，直接删除临时分支
      execSync(`git checkout "${targetBranch}"`, { cwd: repoRoot, stdio: "pipe" });
      execSync(`git branch -D "${squashBranch}"`, { cwd: repoRoot, stdio: "pipe" });
      
      // 创建空 commit 记录
      execSync(`git commit --allow-empty -m "${commitMsg}"`, {
        cwd: repoRoot,
        stdio: "pipe",
      });
    }

    return execSync("git rev-parse HEAD", { cwd: repoRoot, stdio: "pipe" }).toString().trim();
  }

  /**
   * 解析 git diff 输出
   */
  private parseDiffOutput(output: string, diff: WorktreeDiff): void {
    const lines = output.split("\n").filter(Boolean);
    for (const line of lines) {
      const status = line.charAt(0);
      const filePath = line.substring(3).trim();
      
      switch (status) {
        case "A":
        case "R":
        case "C":
          if (!diff.added.includes(filePath)) diff.added.push(filePath);
          break;
        case "M":
        case "D":
        case "T":
          if (!diff.modified.includes(filePath)) diff.modified.push(filePath);
          break;
        case "X":
          if (!diff.deleted.includes(filePath)) diff.deleted.push(filePath);
          break;
      }
    }
  }

  /**
   * 检查指定路径是否为 git worktree
   */
  private isGitWorktree(path: string): boolean {
    try {
      execSync("git rev-parse --git-dir", { cwd: path, stdio: "pipe" });
      // 检查是否为 worktree（而非主仓库）
      const gitDir = execSync("git rev-parse --git-dir", { cwd: path, stdio: "pipe" }).toString().trim();
      return gitDir.includes("worktrees");
    } catch {
      return false;
    }
  }

  /**
   * 清理所有 worktree（team 销毁时调用）
   */
  cleanupAll(): void {
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();

    for (const wt of this.worktrees.values()) {
      this.removeWorktree(wt.path);
    }
    this.worktrees.clear();
  }

  /**
   * 检查指定目录是否为 git 仓库
   */
  isGitRepo(dir: string): boolean {
    try {
      execSync("git rev-parse --git-dir", { cwd: dir, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  // ---------- 内部实现 ----------

  private tryCreateGitWorktree(
    baseCwd: string,
    branchName: string,
    teamId: string,
    agentId: string,
  ): WorktreeInfo {
    // 如果没有启用 worktree 隔离，降级为临时目录
    if (!this.config.enabled) {
      const tmpPath = mkdtempSync(join(tmpdir(), "openwork-team-"));
      return {
        path: tmpPath,
        branch: "temp",
        createdAt: Date.now(),
        isGitWorktree: false,
        teamId,
        agentId,
      };
    }

    // 检查是否为 git 仓库
    if (!this.isGitRepo(baseCwd)) {
      const tmpPath = mkdtempSync(join(tmpdir(), "openwork-team-"));
      return {
        path: tmpPath,
        branch: "temp",
        createdAt: Date.now(),
        isGitWorktree: false,
        teamId,
        agentId,
      };
    }

    try {
      const repoRoot = this.findRepoRoot(baseCwd);

      // 确保基准分支存在
      const baseBranch = this.config.baseBranch;
      try {
        execSync(`git rev-parse --verify "${baseBranch}"`, { cwd: repoRoot, stdio: "pipe" });
      } catch {
        // 基准分支不存在，使用当前分支
        const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, stdio: "pipe" }).toString().trim();
        this.config = { ...this.config, baseBranch: currentBranch || "HEAD" };
      }

      // worktree 路径
      const worktreeDir = this.config.rootDir
        ? join(this.config.rootDir, branchName)
        : join(repoRoot, ".openwork", "worktrees", branchName);

      // 创建 worktree 目录
      try {
        // 清理已存在的同名 worktree
        execSync(`git worktree remove --force "${worktreeDir}" 2>/dev/null || true`, {
          cwd: repoRoot,
          stdio: "pipe",
        });
      } catch {
        // swallow
      }

      // 从基准分支创建 worktree
      execSync(
        `git worktree add -b "${branchName}" "${worktreeDir}" "${this.config.baseBranch}"`,
        { cwd: repoRoot, stdio: "pipe" },
      );

      return {
        path: worktreeDir,
        branch: branchName,
        createdAt: Date.now(),
        isGitWorktree: true,
        teamId,
        agentId,
      };
    } catch {
      // git worktree 创建失败，降级为临时目录
      const tmpPath = mkdtempSync(join(tmpdir(), "openwork-team-"));
      return {
        path: tmpPath,
        branch: "temp",
        createdAt: Date.now(),
        isGitWorktree: false,
        teamId,
        agentId,
      };
    }
  }

  private findRepoRoot(dir: string): string {
    try {
      const result = execSync("git rev-parse --show-toplevel", { cwd: dir, stdio: "pipe" });
      return result.toString().trim();
    } catch {
      return dir;
    }
  }
}
