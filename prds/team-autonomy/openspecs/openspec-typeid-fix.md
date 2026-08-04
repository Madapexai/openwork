# OpenSpec: typeid 模板字面量类型修复

> 目标：team-autonomy 9 个 service 的 `tsc --noEmit` 从 200+ 错误 → 0 错误，行为零变化。

## 1. 问题根因

`denTypeIdColumn(name, columnName)` 生成的列 data 类型是模板字面量：

```ts
customType<{ data: DenTypeId<TName>; driverData: string }>(...)
// DenTypeId<"teamTask"> = `ttsk_${string}`
```

而 service 内部从外部输入（zod body / path param / 其他 service 返回值）拿到的是普通 `string`，直接传给 `eq()/insert()/update()` 触发 TS2769/TS2322/TS2551。

## 2. 修复模式（与 openwork 现有约定一致）

参考 `ee/apps/den-api/src/routes/org/teams.ts:70` 与 `auth.ts:243`：

```ts
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"

// 边界处把 string 收窄为模板字面量类型：
const taskId = normalizeDenTypeId("teamTask", rawTaskId) // → ttsk_${string}
// 或安全版（非法 id 返回 null，保持 404/400 原语义）：
const tid = normalizeIdOrNull("teamTask", rawTaskId) // → ttsk_${string} | null
```

**关键**：`normalizeDenTypeId` 运行时对非法 id 抛异常，会破坏"非法 id → 404/400"的原语义。因此部分 service 使用包装的 `normalizeIdOrNull`（内部 `try/catch`，非法 → null → 按查询未命中处理），行为零变化。

## 3. 修改文件清单（9 个 service，692+/221-）

| 文件 | 错误数 | 主要修复点 |
|---|---|---|
| `automation-service.ts` | 41 | run/task/agent 边界 normalize |
| `task-service.ts` | 35 | task/member/agent 边界 |
| `skill-validation-service.ts` | 24 | configObject/member/team 边界 |
| `budget-service.ts` | 24 | budget/team/member 边界 |
| `team-agent-service.ts` | 23 | agent/task/role 边界 |
| `mailbox-service.ts` | 17 | mailbox/team/member 边界 |
| `asset-service.ts` | 16 | artifact/task/team/member 边界 |
| `permission-service.ts` | 13 | profile/team/member 边界 |
| `inbox-service.ts` | 7 | inbox/team/agent/task 边界 |

约束：不用 `as any / as never`（0 处）；不改 schema/SQL/返回结构；不改行为。

## 4. 验证证据

### tsc 全绿

```
$ pnpm exec tsc --noEmit
（0 输出，exit 0）
```

### 回归测试（串行全量 239/239 通过）

```
$ pnpm exec tsx --test --test-force-exit --test-concurrency=1 test/team-autonomy/*.test.ts
ℹ tests 239
ℹ pass 239
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

> 注意：**并发跑**（默认）11 个测试文件会因共享 `openwork_test_ta` 数据库互相污染数据（如 `sidecar-personal-budget` 的 getSidecarSession 返回 null、`task-service` 的 assignee id 漂移），**串行跑全绿**。这是测试基础设施问题（共享 DB + node:test 并发），非代码 bug。后续 CI 建议 `--test-concurrency=1` 或每文件独立 DB。

## 5. 遗留（不在本次范围）

- 并发共享 DB 污染：建议 CI 串行执行
- `personal-team.ts / personal-team-service.ts / sidecar-service.ts` 的类型与 slug 修复：由并行任务 `fix(team-autonomy): unique personal-team slug` 处理
- auth hook 接线：由并行任务 `feat(team-autonomy): wire personal-team auto-create into auth` 处理
