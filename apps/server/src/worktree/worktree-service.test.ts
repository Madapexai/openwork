/**
 * worktree-service.test.ts — git worktree 生命周期测试（openspec-worktree-service.md §7）
 *
 * 使用真实 git repo（mkdtemp 临时目录），验证 create/list/remove/prune/cleanupStale 全链路。
 *
 * 运行: bun test src/worktree/worktree-service.test.ts
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeService, WorktreeError, assertGitRepo } from "./worktree-service.js";

/** 初始化一个带至少一个 commit 的 git repo */
async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ow-wt-test-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@openwork.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "OpenWork Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "test repo\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

describe("assertGitRepo（§7.1 I1）", () => {
  test("非 git 目录抛 NOT_A_GIT_REPO", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ow-wt-notgit-"));
    await expect(assertGitRepo(dir)).rejects.toMatchObject({ code: "NOT_A_GIT_REPO" });
    await rm(dir, { recursive: true, force: true });
  });

  test("相对路径抛 INVALID_PATH", async () => {
    await expect(assertGitRepo("relative/path")).rejects.toMatchObject({ code: "INVALID_PATH" });
  });
});

describe("WorktreeService（§7.2 生命周期）", () => {
  test("create → list 含新条目 → remove → prune 全链路", async () => {
    const repo = await initRepo();
    const service = new WorktreeService();

    const entry = await service.create({ repoPath: repo, owner: "task-123" });
    expect(entry.path).toBeDefined();
    expect(entry.branch).toContain("ow-task-");
    expect(entry.owner).toBe("task-123");

    // 目录真实存在
    await expect(stat(entry.path)).resolves.toBeDefined();

    // list 包含新 worktree
    const listed = await service.list(repo);
    expect(listed.some((w) => w.path === entry.path)).toBe(true);

    // remove 后目录删除
    await service.remove(repo, entry.path);
    await expect(stat(entry.path)).rejects.toThrow();

    // prune 无异常
    await service.prune(repo);

    await rm(repo, { recursive: true, force: true });
  });

  test("空 repo（无 commit）create 抛 REPO_NO_COMMITS", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ow-wt-empty-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const service = new WorktreeService();
    await expect(service.create({ repoPath: repo })).rejects.toMatchObject({
      code: "REPO_NO_COMMITS",
    });
    await rm(repo, { recursive: true, force: true });
  });

  test("I4: remove 未管理的 worktree 抛 UNMANAGED_WORKTREE", async () => {
    const repo = await initRepo();
    const service = new WorktreeService();

    // 直接 git worktree add（绕过 service 注册表）
    const rogue = join(await mkdtemp(join(tmpdir(), "ow-wt-rogue-")), "rogue");
    execFileSync("git", ["worktree", "add", rogue, "-b", "rogue-branch"], { cwd: repo });

    await expect(service.remove(repo, rogue)).rejects.toMatchObject({
      code: "UNMANAGED_WORKTREE",
    });

    // force 可回收
    await expect(service.remove(repo, rogue, { force: true })).resolves.toBe(true);

    await rm(repo, { recursive: true, force: true });
  });
});

describe("WorktreeService（§7.3 自动回收）", () => {
  test("cleanupStale 回收超过 maxIdleMs 的条目", async () => {
    const repo = await initRepo();
    const service = new WorktreeService();

    // 伪造一个过期条目（createdAt 在很久以前）
    const staleDir = join(await mkdtemp(join(tmpdir(), "ow-wt-stale-")), "stale-branch");
    execFileSync("git", ["worktree", "add", staleDir, "-b", "stale-branch"], { cwd: repo });
    const staleEntry = {
      path: staleDir,
      branch: "stale-branch",
      createdAt: Date.now() - 10_000, // 10s 前（> 1s 阈值）
      owner: "stale-task",
    };
    // 直接注入注册表（私有字段，测试用类型断言）
    (service as unknown as { registry: Map<string, { path: string; branch: string; createdAt: number; owner?: string }> }).registry.set(
      staleDir,
      staleEntry,
    );

    const removed = await service.cleanupStale(repo, 1000); // 1s 阈值
    expect(removed).toBe(1);
    await expect(stat(staleDir)).rejects.toThrow();

    await rm(repo, { recursive: true, force: true });
  });

  test("cleanupStale 不回收未过期条目", async () => {
    const repo = await initRepo();
    const service = new WorktreeService();

    const entry = await service.create({ repoPath: repo });
    const removed = await service.cleanupStale(repo, 60_000); // 1min 阈值，新条目不过期
    expect(removed).toBe(0);
    await expect(stat(entry.path)).resolves.toBeDefined();

    await service.remove(repo, entry.path);
    await rm(repo, { recursive: true, force: true });
  });
});
