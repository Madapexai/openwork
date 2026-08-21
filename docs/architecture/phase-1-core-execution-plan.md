# Phase 1 Core 改动落地执行方案

> 分支：`phase-1-core`（基于 `origin/dev@1628f3e27`，最新上游）
> 来源：`feat/team-autonomy@afef49cb`（33 commits，+44K / -1K 行）
> 目标：把 team-autonomy 的 Phase 1 核心改动迁移到最新上游之上

---

## 一、阻塞项：Migration 编号冲突（致命）

`origin/dev` 最新 drizzle migration 序列到 **0063**，而 `feat/team-autonomy` 的 schema 用 **0050/0051**：

| 编号 | 上游 origin/dev 已占用 | feat/team-autonomy 意图 |
|------|----------------------|----------------------|
| 0050 | `0050_familiar_vindicator.sql`（ALTER plugin ADD source_repository_url） | team autonomy 主 schema（6 张表） |
| 0051 | `0051_petite_shen.sql`（ALTER external_mcp_connection ADD kind + native_provider_key） | engine_config schema |
| 0052–0063 | 12 个新 migration（codemode_scripts、temp_file 等） | 不存在 |

**结论**：0050/0051 编号必须重编到 0064/0065+，并同步更新 `_journal.json`（`when` 时间戳必须严格递增，当前 0063 的 `when` = `1786635052864`）+ 重新生成 snapshot。

---

## 二、分目录冲突概率

| 目录 | 冲突概率 | 理由 |
|------|---------|------|
| `ee/packages/den-db/drizzle/` | **致命** | 编号冲突，见上一节 |
| `ee/packages/den-db/src/schema/teams.ts` | 高 | 上游已含 `TeamTable`/`TeamMemberTable`，需追加新表 |
| `ee/apps/den-api/src/auth.ts` | **高** | 1252 行，Better Auth hook 嵌套深，insert 点复杂 |
| `apps/server/src/agent-sidecar/` | 低（新目录） | origin/dev 上不存在，纯新增 |
| `apps/server/src/agent-team/` | 低（新目录） | origin/dev 上不存在，纯新增 |
| `apps/server/src/cli.ts` / `config.ts` / `server.ts` | 中 | 活跃开发，间接冲突 |
| `ee/apps/den-api/src/app.ts` | 中 | route 注册 + imports 合并 |
| `apps/desktop/electron/main.mjs` | 低-中 | 插入点相对独立 |
| `apps/app/.env.local.example` | 无 | 上游不存在，纯新增 |

---

## 三、cherry-pick vs 手工移植决策

| Commit | 决策 | 理由 |
|--------|------|------|
| `f2b932c7b` (DB schema) | **手工移植** | Migration 编号冲突，必须重编 |
| `18d75c5fc` (Permission+Inbox) | cherry-pick | 纯新增 service 文件，无上下文依赖 |
| `c2e694d67` (AssetService) | cherry-pick | 同上 |
| `9ebd2869c` (TaskService) | cherry-pick | 同上 |
| `c3381228f` (TeamAgentService) | cherry-pick | 同上 |
| `2840b63c3` (AutomationService) | cherry-pick | 同上 |
| `f2b2fb866` (SkillValidationService) | cherry-pick | 同上 |
| `cb40ccb1f` (HTTP routes) | cherry-pick | 纯新增 route 文件，app.ts 注册手工合并 |
| `7ae892f27` (P3 e2e) | cherry-pick | 纯新增 service + test |
| `f46225f93` (auth hook) | **手工移植** | auth.ts 改动量大，上下文冲突高 |
| `8230b73e2` (TeamAgentEngine CLI) | 手工移植 schema + cherry-pick 代码 | schema 0051 编号冲突，CLI 代码可 cp |
| `39fbbf4ea` (sidecar adapters) | cherry-pick 新目录 + 手工移植 `cli.ts` | 新目录无冲突，`cli.ts` 改动手工 |
| `f58f52560` (desktop config) | cherry-pick | 独立改动 |

---

## 四、推荐执行顺序（12 步）

```
第 0 步   手工移植 DB schema（重编 0050→0064，0051→0065）
           └── 更新 _journal.json、生成 snapshot
第 1 步   cherry-pick 18d75c5fc  Permission+Inbox
第 2 步   cherry-pick c2e694d67   AssetService
第 3 步   cherry-pick 9ebd2869c   TaskService
第 4 步   cherry-pick c3381228f   TeamAgentService
第 5 步   cherry-pick 2840b63c3   AutomationService
第 6 步   cherry-pick f2b2fb866   SkillValidationService
第 7 步   cherry-pick cb40ccb1f   HTTP route layer（app.ts 手工合并）
第 8 步   cherry-pick 7ae892f27   P3 e2e
第 9 步   手工移植 f46225f93      auth hook
第 10 步  cherry-pick 39fbbf4ea   sidecar + agent-team（cli.ts 手工）
第 11 步  手工移植 8230b73e2      TeamAgentEngine（schema 已重编）
第 12 步  cherry-pick f58f52560   desktop config
```

每一步完成后立即 `pnpm build` 或 `tsc --noEmit` 验证。

---

## 五、待决：要不要现在就动手

本方案目前是**纸上规划**，未开始实际迁移。Phase 1 迁移是重活（33 commits，+44K 行，多个高冲突点），需要：

1. **用户确认**：是否现在就启动 Phase 1 迁移？还是先把方案和 extension 骨架推上远端、留到明天再做？
2. **环境准备**：`pnpm build` / `tsc --noEmit` 验证命令是否能在本 shell 跑通（目前缺 `bun`、`grep`、`head`、`cat`，`pnpm` 不确定）
3. **冲突解决时间**：预计 2-4 小时，涉及手工迁移 schema + auth + cli.ts 三个高冲突点

---

## 六、当前状态

- `phase-1-core` 分支已创建：`origin/dev@1628f3e27`
- 本方案文档待提交到该分支
- 未开始任何实际 cherry-pick 或代码修改
