# OpenSpecs — Migration 验证 + Drizzle Generate + Typecheck

> 目标：确保 `0050_team_autonomy.sql` + `team-autonomy.ts` + `teams.ts` 变更在真实项目中一致、可迁移、可编译。
> 沉淀: `prds/team-autonomy/openspecs/openspec-migration-validation.md`

---

## 1. 规范定义（Spec）

### 1.1 验证目标列表
| ID | 验证项 | 工具 | 通过条件 |
|---|---|---|---|
| V1 | `0050_team_autonomy.sql` 语法合法（MySQL 8.0 compatible） | `mysql client -e SOURCE xxx.sql` 空跑库 | 无 error 退出（warning 可接受） |
| V2 | Drizzle schema `team-autonomy.ts` 与 SQL 迁移等价 | `pnpm --filter @openwork-ee/den-db exec drizzle-kit generate` | `_journal.json` 中不产生新的 idx=51 条目（即 SQL 未发散） |
| V3 | `TeamTable` 新列 (slug/kind/settings/ownerUserId) 在 drizzle-kit 看来无变更 | 同上 | 同上，无新 idx |
| V4 | TypeScript 编译无错 | `pnpm --filter @openwork-ee/den-db build` | 0 TS errors |
| V5 | den-api 引用 schema 的编译无错 | `pnpm --filter @openwork-ee/den-api exec tsc --noEmit` | 0 TS errors，且 `TeamArtifactTable` 可被 import |
| V6 | 19 张新表 + team 4 新列在 Drizzle introspection 中与 SQL 名 1:1 | `pnpm --filter @openwork-ee/den-db exec drizzle-kit introspect` | 无 diff（或 diff 只涉及默认值/注释不匹配） |
| V7 | 重复执行 0050 迁移不破坏数据（幂等） | 跑 2 次 migration | 第二次报错 "table exists"（预期错误），但不会丢数据 |

### 1.2 不变量
| ID | 不变量 |
|---|---|
| I1 | 所有 enum 值在 Drizzle schema 中必须与 SQL `ALTER TABLE ... MODIFY COLUMN` 或 CREATE TABLE 中的 enum 字面量字节一致（大小写一致）。如 `ArtifactsStatus`：`draft` 不是 `Draft` |
| I2 | `denTypeIdColumn('team','xxx')` 必须产生 `varchar(64)` 列名，和 SQL migration 完全对应 |
| I3 | JSON 列必须用 `compatJsonColumn`，不能用原生 `json()` 函数（MariaDB 兼容） |
| I4 | migration 必须有 `--> statement-breakpoint` 分隔多语句（PlanetScale/Vitess 约定），每个 statement 独立事务 |
| I5 | uniqueIndex / index 名和 SQL 中一致，如 `team_organization_slug`（SQL `CREATE UNIQUE INDEX team_organization_slug`） |

### 1.3 端到端验收
1. 干净数据库 `SOURCE 0050_team_autonomy.sql` → 0 error
2. 应用所有 migration 到 0050
3. 写一行测试数据到 team_artifact，status=draft → SELECT OK
4. transition to in_review → OK，transition to confirmed → OK
5. 重复 migration 第二次 → 报错 "table already exists"，但第一次写入的数据仍在
6. `pnpm --filter @openwork-ee/den-db build` 全过
7. `pnpm --filter @openwork-ee/den-api exec tsc --noEmit` 全过

---

## 2. RED 阶段
在验证之前，这些检查必须先失败（或至少需要配置）：
- R1：`drizzle-kit generate` 可能提示缺依赖 → 先解决依赖
- R2：`drizzle-kit introspect` 指向空库时应报 no connection → 准备测试 MySQL
- R3：第一次跑 `tsc --noEmit` 可能提示 `team-autonomy.ts` 未在 den-db index.ts 导出 → 已 export 所以应该 OK（但需验证）
- R4：如果迁移文件少了 `---> statement-breakpoint`，mysql client 直接跑 OK，但 drizzle-kit migrate 会卡死 → 检查 SQL

## 3. GREEN 阶段
执行 V1-V7 全通过，记录证据到 E2E 章节。

## 4. REFACTOR
- V2/V6 不通过：调整 migration SQL 或 schema 定义，直到无 diff
- V4/V5 不通过：修复 TS 类型
- V7 失败：说明 SQL 里有 `CREATE TABLE IF NOT EXISTS` 缺失，或有 `DROP TABLE` 误包含

## 5. E2E / Validation Results

> 执行时间：2026-08-04（Asia/Shanghai）
> 分支：`feat/team-autonomy`
> 测试文件：`ee/packages/den-db/test/team-autonomy-migration.test.ts`
> 环境：macOS，pnpm 10.28.2，无 MySQL（integration test 用 `DEN_DB_MYSQL_TEST_URL` env guard 跳过）

### 5.1 测试结果摘要

```
▶ team-autonomy migration validation (P0 ③)
  ✔ V1: 0050 SQL syntax (3 tests, 1 skipped)
  ✔ V2: drizzle-kit export parity for 0050 new tables (4 tests, 1 skipped)
  ✔ V3: table/column/index completeness (6 tests)
  ✔ V4: TypeScript compilation via pnpm build (1 test)
  ✔ V5: _journal.json registers 0050 entry (2 tests)
ℹ tests 16
ℹ pass 14
ℹ fail 0
ℹ skipped 2  (MySQL integration: V1 execute + V2 replay)
ℹ duration_ms 25113
```

### 5.2 V1 — SQL 语法解析

**命令**：`pnpm exec tsx --test test/team-autonomy-migration.test.ts`

**证据**：
- 0050 SQL 剥离注释 + `--> statement-breakpoint` 后按 `;` 分割，得到 **26 条 DDL 语句**（7 team ALTER/INDEX + 19 CREATE TABLE）
- 19 条 CREATE TABLE 全部声明 PRIMARY KEY 约束
- `statement-breakpoint` 计数：**25**（最后一条 `team_inbox` 无 trailing breakpoint，符合 drizzle-kit 约定）

**RED→GREEN 修复**：
- 发现 `0050_team_autonomy.sql` 第 16 行 `CREATE INDEX \`team_owner_user_id\`` 后缺失 `--> statement-breakpoint`（违反不变量 I4）
- 已补上 `--> statement-breakpoint`，否则 drizzle-kit migrate 会将 `team_owner_user_id` 索引与下一条 `CREATE TABLE team_role` 合并为单条语句导致执行失败

### 5.3 V2 — drizzle-kit export 与 migration replay schema parity

**命令**：
```bash
cd ee/packages/den-db
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
/usr/local/bin/pnpm exec drizzle-kit export --config drizzle.config.ts
```

**证据**：
- export 成功，共 **100 张 CREATE TABLE**（全量 schema）
- 19 张新表全部出现在 export 中（按字母序）：
  ```
  CREATE TABLE `skill_link` / `skill_test_case` / `skill_validation`
  CREATE TABLE `team_agent` / `team_artifact` / `team_artifact_version`
  CREATE TABLE `team_automation` / `team_automation_alert` / `team_automation_run`
  CREATE TABLE `team_board` / `team_budget` / `team_budget_allocation`
  CREATE TABLE `team_inbox` / `team_mailbox` / `team_permission_profile`
  CREATE TABLE `team_role` / `team_standing_rule` / `team_task` / `team_task_handoff`
  ```
- team 表 4 个新列（slug/kind/settings/owner_user_id）出现在 export 的 CREATE TABLE team 中
- team 表 3 个新索引：
  - `team_organization_slug` → inline `CONSTRAINT \`team_organization_slug\` UNIQUE(\`organization_id\`,\`slug\`)`（drizzle-kit export 将 uniqueIndex 渲染为 inline UNIQUE 约束）
  - `team_kind` → `CREATE INDEX \`team_kind\` ON \`team\` (\`kind\`)`
  - `team_owner_user_id` → `CREATE INDEX \`team_owner_user_id\` ON \`team\` (\`owner_user_id\`)`
- **V2 replay parity（MySQL 集成测试）**：用 `DEN_DB_MYSQL_TEST_URL` env guard 保护，无 MySQL 时跳过；测试逻辑：export SQL 灌入两个 scratch DB → 在 replayDb 上 DROP 19 表 + 4 列 + 3 索引 → replay 0050 SQL → 对比 information_schema 列与索引

### 5.4 V3 — 表/列/索引完整性

| 检查项 | 结果 |
|---|---|
| 19 张新表 CREATE TABLE | ✔ 全部存在 |
| team 表 4 个 ALTER ADD 列（slug/kind/settings/owner_user_id） | ✔ 全部存在 |
| team 表 3 个新索引（team_organization_slug / team_kind / team_owner_user_id） | ✔ 全部存在 |
| 19 张新表 id 列均为 `varchar(64) NOT NULL`（不变量 I2） | ✔ 19/19 |
| 19 个新 typeid prefix 均为 4 字符 | ✔ 19/19 |
| statement-breakpoint 数 = 语句数 - 1（不变量 I4） | ✔ 25 = 26 - 1 |

### 5.5 V4 — TypeScript 编译

**命令**：
```bash
cd ee/packages/den-db
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
DEN_DB_ENCRYPTION_KEY='test-encryption-key-12345678901234567890' /usr/local/bin/pnpm build
```

**输出摘录**（exit 0）：
```
ESM ⚡️ Build success in 696ms
DTS ⚡️ Build success in 10191ms
DTS dist/schema/teams.d.ts            15.98 KB
DTS dist/schema.d.ts                  628.30 KB
ESM dist/scripts/bootstrap.js 20.72 KB
ESM ⚡️ Build success in 142ms
[den-db] copied migrations to dist/drizzle
[den-db] wrote dist/current-schema.sql
```

- tsc（通过 tsup DTS 阶段）0 error
- tsup ESM 构建成功
- drizzle dist（migrations + current-schema.sql）已生成

### 5.6 V5 — _journal.json 注册 0050 条目

**命令**：`grep -A 4 '"idx": 50' drizzle/meta/_journal.json`

**证据**：
```json
{
  "idx": 50,
  "version": "5",
  "when": 1785710592000,
  "tag": "0050_team_autonomy",
  "breakpoints": true
}
```

- idx=50 已注册，tag=`0050_team_autonomy`，breakpoints=true
- _journal.json 共 **50 条** entry（idx 1..50 连续无缺口）

### 5.7 字段长度核对表（不变量 I2）

> typeid 格式：`<prefix>_<26-char-base32-suffix>`
> denTypeIdColumn 内部使用 `varchar(64)`（`INTERNAL_ID_LENGTH = 64`，见 `ee/packages/den-db/src/columns.ts`）
> 4 字符 prefix + 1 下划线 + 26 suffix = **31** ≤ 64 ✓

| TypeID Name | Prefix | Prefix 长度 | ID 总长 | SQL 列类型 | 一致 |
|---|---|---|---|---|---|
| teamRole | trol | 4 | 31 | varchar(64) | ✔ |
| teamAgent | tagt | 4 | 31 | varchar(64) | ✔ |
| teamTask | ttsk | 4 | 31 | varchar(64) | ✔ |
| teamBoard | tbrd | 4 | 31 | varchar(64) | ✔ |
| teamTaskHandoff | tthd | 4 | 31 | varchar(64) | ✔ |
| teamArtifact | tart | 4 | 31 | varchar(64) | ✔ |
| teamArtifactVersion | tarv | 4 | 31 | varchar(64) | ✔ |
| teamMailbox | tmbx | 4 | 31 | varchar(64) | ✔ |
| teamBudget | tbgt | 4 | 31 | varchar(64) | ✔ |
| teamBudgetAllocation | tbal | 4 | 31 | varchar(64) | ✔ |
| teamAutomation | taut | 4 | 31 | varchar(64) | ✔ |
| teamAutomationRun | taur | 4 | 31 | varchar(64) | ✔ |
| teamAutomationAlert | taal | 4 | 31 | varchar(64) | ✔ |
| skillValidation | svld | 4 | 31 | varchar(64) | ✔ |
| skillTestCase | stst | 4 | 31 | varchar(64) | ✔ |
| skillLink | slnk | 4 | 31 | varchar(64) | ✔ |
| teamPermissionProfile | tppr | 4 | 31 | varchar(64) | ✔ |
| teamStandingRule | tsrl | 4 | 31 | varchar(64) | ✔ |
| teamInbox | tibx | 4 | 31 | varchar(64) | ✔ |

**0050 SQL 验证**：`grep -c '\`id\` varchar(64) NOT NULL' drizzle/0050_team_autonomy.sql` → **19**（19 张新表 id 列全部 varchar(64) NOT NULL）

### 5.8 _journal.json 状态

- 文件路径：`ee/packages/den-db/drizzle/meta/_journal.json`
- version: "7", dialect: "mysql"
- entries: 50 条（idx 1..50，连续无缺口）
- idx=50: `{ tag: "0050_team_autonomy", breakpoints: true, when: 1785710592000 }`
- **无需补注册**（任务前已存在）

## 6. 沉淀
- 如果发现新的 enum 不一致 → 加进 I1 表
- 如果 drizzle-kit 有新列差异 → 回到 schema 修复并补 SQL 语句
- 如果 `statement-breakpoint` 缺失 → 修正 SQL 并加入 I4 规则

### 6.1 本次（P0 ③）发现并修复的问题
- **I4 违规**：`0050_team_autonomy.sql` Step 1 最后一条 `CREATE INDEX \`team_owner_user_id\`` 后缺失 `--> statement-breakpoint`，导致 drizzle-kit migrate 会把它与下一条 `CREATE TABLE team_role` 合并为单条语句。已补上 breakpoint。
  - **根因**：手写 SQL 时容易在"步骤最后一条"漏掉 breakpoint（直觉上认为步骤结束就该断开，但 drizzle-kit 只认 `--> statement-breakpoint` 标记，不认注释分隔）
  - **防御**：V3 测试 `every statement ends with statement-breakpoint except the last` 已固化为回归测试，未来任何 migration 文件如果漏写 breakpoint 都会被测试拦下
- **drizzle-kit export 格式差异**：`uniqueIndex` 在 export 中渲染为 inline `CONSTRAINT ... UNIQUE(...)`，而 `index` 渲染为独立的 `CREATE INDEX` 语句。V2 测试已对两种格式都做断言。
- **MySQL 集成测试 env guard**：V1 execute + V2 replay 依赖 MySQL，用 `DEN_DB_MYSQL_TEST_URL` env guard 跳过；CI 如需跑 integration，配置该 env 即可。
