# OpenSpec: Worktree 生命周期服务规范（openspec-worktree-service）

- **状态**: **GREEN**（实现 + 测试 + 路由接入完成）
- **分支**: feat/team-autonomy
- **日期**: 2026-08-05
- **负责人**: OpenWork 架构师（team-autonomy）
- **目标**: 借鉴 orca 的 worktree 工作流，让每个 team agent 任务在**独立分支 + 独立目录（git worktree）**中运行，实现 agent 物理隔离、多 agent 并行互不干扰；任务完成/失败后自动回收 worktree。
- **前置**: 无（纯 git 操作，独立模块）

---

## 0. GREEN 验证记录（2026-08-05）

| 验收项（§8） | 结果 | 证据 |
|---|---|---|
| 1. 真实 git 仓库 create → list → remove → prune 全链路 | ✅ | `bun test src/worktree/worktree-service.test.ts` → 7/7 pass |
| 2. 空 repo（无 commit）create 抛 REPO_NO_COMMITS | ✅ | pass |
| 3. remove 未管理的 worktree 抛 UNMANAGED_WORKTREE（I4） | ✅ | pass |
| 4. cleanupStale 回收超过 maxIdleMs 的条目 / 不回收未过期 | ✅ | pass |
| 5. 路径规范化（macOS /var → /private/var） | ✅ | realpath 规范化注册表路径 |
| 6. 相对路径 / 非 git 目录 fail-fast | ✅ | INVALID_PATH / NOT_A_GIT_REPO pass |
| 7. 三个新模块 + 全量类型检查 | ✅ | `npx tsc -p tsconfig.json --noEmit` → 0 错误 |

回归：`bun test src/runtime-registry.test.ts src/chat/chat-relay.test.ts src/worktree/worktree-service.test.ts` → 24/24 pass。

---

## 1. 背景

上一轮调研发现：orca 的核心机制是「每个任务独立分支 + 独立目录（git worktree）+ 任务完成/失败后自动回收」，而 OpenWork 当前只做了 **cwd 隔离**（agent 在同一目录里换工作目录），缺 worktree 生命周期管理。多 agent 并行时，A 的改动会污染 B 的工作区，且没有自动回收机制。

**本规范的目标**：提供 `WorktreeService`——基于 `git worktree add` 创建隔离工作区，注册表追踪 owner/创建时间，闲置超时自动回收（cleanupStale），并提供 CRUD + prune + cleanup 五个 HTTP 端点。

### 1.1 与业界对齐

| 项目 | 机制 | 我们的对应 |
|---|---|---|
| orca | 任务级 worktree：独立分支 + 独立目录 + 完成后回收 | `WorktreeService.create/remove/cleanupStale` |

---

## 2. 不变量（Invariants）

**I1 — fail-fast 输入校验**：
- 相对路径（非绝对路径）→ `WorktreeError("INVALID_PATH")`。
- 非 git 仓库（无 `.git`）→ `WorktreeError("NOT_A_GIT_REPO")`。
- 空仓库（无 commit）→ `WorktreeError("REPO_NO_COMMITS")`（`git worktree add -b` 需要 HEAD）。

**I2 — 路径规范化**：注册表与 `git worktree list` 输出必须一致——`create` 返回 `realpath(worktreePath)`（macOS 下 `/var` → `/private/var` 符号链接），`list` 解析 `--porcelain` 输出并做同样规范化，保证匹配。

**I3 — owner 白名单**：`owner` 仅接受 `[\w.\-:]+`（agentId / 任务 id 命名），非法值忽略（undefined），防止注册表被任意字符串污染。

**I4 — 只回收受管 worktree**：`remove` 只允许删除注册表内的条目；`git worktree list` 中存在的未管理 worktree 一律拒绝（`UNMANAGED_WORKTREE`），避免误删用户手动创建的 worktree。

**I5 — 闲置回收**：`cleanupStale` 只回收注册表内 `now - createdAt > maxIdleMs`（默认 6h）的条目，且目录真实存在；回收失败不中断后续条目。

---

## 3. API 契约

### 3.1 WorktreeService（`apps/server/src/worktree/worktree-service.ts`）

```ts
export class WorktreeError extends Error { readonly code: string; }

export interface WorktreeEntry {
  path: string;         // realpath 规范化的 worktree 目录
  branch: string;
  createdAt: number;
  owner?: string;
}

export class WorktreeService {
  create(options: { repoPath: string; branch?: string; owner?: string; parentDir?: string }): Promise<WorktreeEntry>;
  list(repoPath: string): Promise<Array<{ path: string; branch: string; locked?: boolean }>>;
  remove(repoPath: string, worktreePath: string, options?: { force?: boolean }): Promise<boolean>;
  prune(repoPath: string): Promise<void>;
  cleanupStale(repoPath: string, maxIdleMs?: number): Promise<number>;  // 返回回收数量
  snapshot(): WorktreeEntry[];  // 注册表快照（诊断用）
}
```

错误码：`INVALID_PATH` / `NOT_A_GIT_REPO` / `REPO_NO_COMMITS` / `UNMANAGED_WORKTREE` / `WORKTREE_NOT_FOUND`。

### 3.2 HTTP 路由（`apps/server/src/routes/worktrees.ts`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/worktrees?repoPath=…` | 列出仓库 worktree |
| POST | `/worktrees` | 创建 `{repoPath, branch?, owner?, parentDir?}` → 201 |
| DELETE | `/worktrees` | 回收 `{repoPath, worktreePath, force?}` |
| POST | `/worktrees/prune` | prune 失效元数据 `{repoPath}` |
| POST | `/worktrees/cleanup` | 回收闲置 `{repoPath, maxIdleMs?}` |

---

## 4. 测试清单（`src/worktree/worktree-service.test.ts`，7 用例）

- [x] 非 git 目录抛 NOT_A_GIT_REPO（I1）
- [x] 相对路径抛 INVALID_PATH（I1）
- [x] create → list 含新条目 → remove → prune 全链路（真实 git repo）
- [x] 空 repo（无 commit）create 抛 REPO_NO_COMMITS（I1）
- [x] I4: remove 未管理的 worktree 抛 UNMANAGED_WORKTREE
- [x] cleanupStale 回收超过 maxIdleMs 的条目（I5）
- [x] cleanupStale 不回收未过期条目（I5）

---

## 5. GREEN 验收标准

1. `bun test src/worktree/worktree-service.test.ts` 全绿（7/7，真实 git 仓库操作）。
2. create 返回的 path 与 `git worktree list` 输出一致（realpath 规范化）。
3. remove 只删受管 worktree；cleanupStale 只回收过期条目。
4. `npx tsc -p tsconfig.json --noEmit` → 0 错误。

---

## 6. 交付物

| 文件 | 类型 | 说明 |
|---|---|---|
| `apps/server/src/worktree/worktree-service.ts` | 实现 | `WorktreeService`（create/list/remove/prune/cleanupStale/snapshot）+ `WorktreeError` + `assertGitRepo` |
| `apps/server/src/routes/worktrees.ts` | 路由 | 5 个 HTTP 端点 |
| `apps/server/src/worktree/worktree-service.test.ts` | 测试 | 7 用例（真实 git repo，I1-I5 全覆盖） |
| `apps/server/src/server.ts` | 修改 | 注册 worktrees 路由 |

**遗留**：与 agent-runner / dispatch 的任务生命周期接线（任务开始 create worktree、完成/失败 remove）；控制平面展示 worktree 状态。
