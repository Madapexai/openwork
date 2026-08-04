# OpenSpecs — TeamAgentEngine 扩展 "cli" + engine_config（通用 CLI Agent 引擎）

> Service: `ee/apps/den-api/src/team-autonomy/team-agent-service.ts`
> Schema: `ee/packages/den-db/src/schema/team-autonomy.ts`（`TeamAgentTable`）
> Migration: `ee/packages/den-db/drizzle/0051_team_agent_cli_engine.sql`
> Test: `ee/apps/den-api/test/team-autonomy/team-agent-engine-cli.test.ts`
> Table: `team_agent`

---

## 1. 规范定义（Spec）

### 1.1 目标
为 team agent 接入**通用 CLI agent 引擎**铺路：Kimi AtomCode / Freebuff / Claude Code / 任意本机可执行 agent CLI 都能以 `engine='cli'` 注册进团队 Agent 池。`engine_config` JSON 列保存启动/协议信息，由 sidecar runtime 消费（本 spec 只负责 schema + 校验契约，不实现 runtime 启动）。

### 1.2 不变量（必须 test）
| ID | 不变量 | 失败返回 |
|---|---|---|
| I1 | `engine='cli'` 时 `engine_config.binary` 必填（非空字符串）；非 cli engine 允许 `engine_config` 为空 | 400 / INVALID_ENGINE_CONFIG |
| I2 | `engine_config.protocol` 有值时必须 ∈ `{pty, headless, jsonrpc}`；`engine='cli'` 时 protocol 必填 | 400 / INVALID_ENGINE_CONFIG |
| I3 | 迁移可回滚（`DROP COLUMN engine_config` + `MODIFY engine` 去掉 `'cli'`） | — |
| I4 | 新增枚举不破坏现有 `openworker` / `opencode` 数据（`MODIFY enum` 完整列出旧值+新值；存量行 `engine` 不变、`engine_config` 为 NULL） | — |

### 1.3 `engine_config` 结构（CLI Agent 引擎配置）
```ts
export type EngineConfigProtocol = "pty" | "headless" | "jsonrpc"

export type AgentEngineConfig = {
  binary: string              // 二进制名（必填，I1）
  args?: string[]             // 启动参数
  protocol?: EngineConfigProtocol // 协议类型：pty/headless/jsonrpc（cli 必填，I2）
  cwd?: string                // 工作目录
  env?: Record<string, string> // 环境变量
  supported?: string[]        // 能力标记（如 ["task","tool","file"]）
}
```
DB 列：`team_agent.engine_config json NULL`（可空；非 cli engine 与存量行恒为 NULL）。

### 1.4 API 契约

#### 纯函数 `validateEngineConfig`（无 DB 依赖，可单测）
```ts
export function validateEngineConfig(engine: AgentEngine, config: unknown): boolean
```
规则：
- `config` 为 `null` / `undefined` → 仅 `engine !== "cli"` 时合法（I1）
- `config` 非对象或为数组 → `false`
- `engine === "cli"` → `binary` 必须是 trim 后非空字符串（I1），`protocol` 必须存在且 ∈ 集合（I2）
- 任意 engine：`protocol` 有值（非 null/undefined）时必须 ∈ 集合（I2）
- 可选字段类型约束（宽松防御）：`args` / `supported` 若提供必须是数组；`cwd` 若是字符串；`env` 若是对象

#### `createAgent` / `updateAgent` 校验（I1/I2 执行点）
- `CreateAgentInput` 新增 `engineConfig?: AgentEngineConfig`
- `UpdateAgentInput = Partial<Omit<CreateAgentInput, "teamId">>` 自动继承
- 校验失败 → `{ ok: false, status: 400, response: { code: "INVALID_ENGINE_CONFIG", message } }`
- `AgentRow` 新增 `engineConfig: AgentEngineConfig | null`（读写经 `rowToAgent` camelCase 映射）

#### HTTP 路由（`routes/team-autonomy/agents.ts`）
- `createAgentSchema` / `updateAgentSchema` 新增 `engineConfig` zod schema（protocol enum + binary 等字段）
- `agentResponseSchema` 新增 `engineConfig: z.object(...).nullable()`

### 1.5 E2E 场景
```
E2E-CLI: "CLI agent 创建 + 校验"
  1. createAgent(engine="cli", engineConfig={binary:"claude", protocol:"jsonrpc", args:["-p"], cwd:"/tmp"}) → ok, engineConfig 回读一致
  2. createAgent(engine="cli") → 400 INVALID_ENGINE_CONFIG（I1 缺 binary）
  3. createAgent(engine="cli", engineConfig={binary:"claude"}) → 400 INVALID_ENGINE_CONFIG（I2 缺 protocol）
  4. createAgent(engine="cli", engineConfig={binary:"claude", protocol:"serial"}) → 400 INVALID_ENGINE_CONFIG（I2 非法 protocol）
  5. createAgent(engine="opencode") → ok, engineConfig=null（非 cli 可空，I1）
  6. createAgent(engine="openworker")（存量 engine 不受影响，I4）
```

---

## 2. RED 阶段 — 必须失败的测试
在实现之前（Module not found / 无 validateEngineConfig 导出 / engine 无 'cli'）：
- T1（RED）：`validateEngineConfig("cli", undefined)` → false（I1：cli 必须 binary）
- T2（RED）：`validateEngineConfig("cli", {})` → false（I1）
- T3（RED）：`validateEngineConfig("cli", { binary: "claude" })` → false（I2：cli 缺 protocol）
- T4（RED）：`validateEngineConfig("cli", { binary: "claude", protocol: "serial" })` → false（I2：非法 protocol）
- T5（RED）：`validateEngineConfig("cli", { binary: "claude", protocol: "jsonrpc" })` → true（合法）
- T6（RED）：`validateEngineConfig("cli", { binary: "", protocol: "pty" })` → false（I1：空 binary）
- T7（RED）：`validateEngineConfig("opencode", undefined)` → true（非 cli 可空，I1）
- T8（RED）：`validateEngineConfig("opencode", null)` → true（I1）
- T9（RED）：`validateEngineConfig("openworker", { protocol: "pty" })` → true（非 cli 带合法 protocol）
- T10（RED）：`validateEngineConfig("openworker", { protocol: "nope" })` → false（I2 对任意 engine 生效）
- T11（RED）：`validateEngineConfig("cli", { binary: "claude", protocol: "pty", args: "not-array" })` → false（可选字段类型约束）
- T12（RED，DB）：`createAgent(engine="cli", engineConfig={binary, protocol:"jsonrpc"})` → ok 且回读一致
- T13（RED，DB）：`createAgent(engine="cli")` → 400 INVALID_ENGINE_CONFIG
- T14（RED，DB）：`createAgent(engine="cli", engineConfig={binary:"x", protocol:"serial"})` → 400 INVALID_ENGINE_CONFIG
- T15（RED，DB）：`createAgent(engine="opencode")` → ok，engineConfig=null
- T16（RED，DB）：`createAgent(engine="openworker")` → ok（存量 engine 正常，I4）
- T17（RED，DB）：`updateAgent` 改 engineConfig → ok 回读一致；改非法 engineConfig → 400

## 3. GREEN 阶段
实现 Schema + Service + 迁移后通过全部 T1-T17。

## 4. REFACTOR
- `validateEngineConfig(engine, config)` 抽为纯函数（无 DB 依赖）
- `EngineConfigProtocols` 常量导出（`["pty", "headless", "jsonrpc"]`），供 zod / schema / service 复用

## 5. E2E
真实 MySQL 跑 E2E-CLI 全流程；纯逻辑测试（T1-T11）无需 DB。

## 6. 沉淀
- 新不变量加入 1.2 表
- API 签名 / 迁移 SQL / 验证证据追加到第 7 节 Implementation Log

---

## 7. Implementation Log

### 7.1 实现文件
- Schema: `ee/packages/den-db/src/schema/team-autonomy.ts`（`TeamAgentEngine` 加 `"cli"`；`TeamAgentTable.engine_config` JSON 可空列；新增 `EngineConfigProtocol` / `TeamAgentEngineConfig` 类型导出）
- Service: `ee/apps/den-api/src/team-autonomy/team-agent-service.ts`（`validateEngineConfig` 纯函数 + `createAgent`/`updateAgent` 校验）
- Routes: `ee/apps/den-api/src/routes/team-autonomy/agents.ts`（`engineConfigSchema` zod + response schema）
- Migration: `ee/packages/den-db/drizzle/0051_team_agent_cli_engine.sql` + `meta/_journal.json`（idx=51）
- Test: `ee/apps/den-api/test/team-autonomy/team-agent-engine-cli.test.ts`（17 个测试）

### 7.2 真实 API 签名（GREEN 后冻结）

```ts
// Schema 导出（@openwork-ee/den-db/schema）
export const TeamAgentEngine = ["openworker", "opencode", "mcp", "generic", "cli"] as const
export const EngineConfigProtocol = ["pty", "headless", "jsonrpc"] as const
export type EngineConfigProtocol = (typeof EngineConfigProtocol)[number]
export type TeamAgentEngineConfig = {
  binary: string
  args?: string[]
  protocol?: EngineConfigProtocol
  cwd?: string
  env?: Record<string, string>
  supported?: string[]
}
// TeamAgentTable.engine_config: compatJsonColumn<TeamAgentEngineConfig | null>（可空）

// Service 导出（team-agent-service.ts）
export type AgentEngineConfig = TeamAgentEngineConfig
export type AgentRow = { ...; engineConfig: AgentEngineConfig | null; ... }
export type CreateAgentInput = { ...; engineConfig?: AgentEngineConfig; ... }
export type UpdateAgentInput = Partial<Omit<CreateAgentInput, "teamId">>

// 纯函数（无 DB 依赖）
export function validateEngineConfig(engine: AgentEngine, config: unknown): boolean
//   - config null/undefined → 仅 engine !== "cli" 合法（I1）
//   - engine="cli" → binary trim 非空 + protocol ∈ {pty,headless,jsonrpc}（I1/I2）
//   - 任意 engine：protocol 有值时必须 ∈ 集合（I2）
//   - args/supported 数组、cwd 字符串、env 对象（可选字段类型约束）
// 校验失败响应：{ ok:false, status:400, response:{ code:"INVALID_ENGINE_CONFIG", message } }
```

> 设计偏离：原始 Surface 中 `engineConfig` 为独立契约；实现中类型定义放 den-db schema（`TeamAgentEngineConfig`），service 复用为 `AgentEngineConfig`（`record env` 的 value 固定为 string，与 zod `z.record(z.string(), z.string())` 对齐）。`createAgent` 在 `refsCheck` 之后校验；`updateAgent` 对**合并后**的 `(engine, engine_config)` 校验（engine 改为 cli 但无 config → 400）。

### 7.3 迁移 SQL（0051_team_agent_cli_engine.sql）
```sql
ALTER TABLE `team_agent` ADD `engine_config` json;--> statement-breakpoint
ALTER TABLE `team_agent` MODIFY COLUMN `engine` enum('openworker','opencode','mcp','generic','cli') NOT NULL DEFAULT 'openworker';
```
- I4：enum MODIFY 完整列出旧值 + `'cli'`（末尾追加），存量 `openworker`/`opencode` 行不受影响
- I3：回滚 = `ALTER TABLE team_agent DROP COLUMN engine_config;` + MODIFY enum 去掉 `'cli'`
- `_journal.json` 新增 `{ idx: 51, version: "5", when: 1785859690000, tag: "0051_team_agent_cli_engine", breakpoints: true }`

### 7.4 不变量实现细节
| ID | 实现位置 | 关键技术 |
|---|---|---|
| I1 | `validateEngineConfig()` + `createAgent`/`updateAgent` 调用点 | cli 无 binary / 空 binary → 400 INVALID_ENGINE_CONFIG；非 cli 允许 config 为 null/undefined |
| I2 | `validateEngineConfig()` 的 protocol 检查 | `EngineConfigProtocol.includes(...)` 硬校验；cli 缺 protocol → 400 |
| I3 | 迁移 SQL 可逆 | 见 7.3 回滚语句 |
| I4 | 迁移 SQL enum MODIFY | 完整枚举 `('openworker','opencode','mcp','generic','cli')`；DB 实测存量行不受影响 |

### 7.5 E2E 验证结果

#### RED 阶段（实现前，2026-08-04）
```
$ DATABASE_URL=...openwork_test_ta ... tsx --test --test-force-exit test/team-autonomy/team-agent-engine-cli.test.ts
✖ T12-T17 fail: "Data truncated for column 'engine' at row 1"（DB enum 无 'cli'）
✖ T15: engineConfig undefined ≠ null（service 无 engine_config 字段）
（validateEngineConfig 未实现 → 纯逻辑测试无法断言）
```

#### GREEN 阶段
```
$ cd ee/packages/den-db && ... /usr/local/bin/pnpm build
CLI ⚡️ Build success（tsup ESM + DTS 类型检查通过）
[den-db] copied migrations to dist/drizzle
[den-db] wrote dist/current-schema.sql

$ mysql ... openwork_den  -e "ALTER TABLE team_agent ADD engine_config json; ALTER TABLE team_agent MODIFY COLUMN engine enum('openworker','opencode','mcp','generic','cli') NOT NULL DEFAULT 'openworker';"
Field         Type          Null  Key  Default
engine_config json          YES        NULL
engine        enum('openworker','opencode','mcp','generic','cli') NO    openworker
（openwork_test_ta 应用相同 SQL，结果一致）

$ cd ee/apps/den-api && DATABASE_URL=...openwork_test_ta ... tsx --test --test-force-exit test/team-autonomy/team-agent-engine-cli.test.ts
▶ TeamAgentEngine cli + engine_config — OpenSpecs RED/GREEN
  ✔ T1-T11: validateEngineConfig 纯逻辑（I1/I2 全矩阵）
  ✔ T12: createAgent engine='cli' + engineConfig → ok 回读一致
  ✔ T13: createAgent engine='cli' 无 config → 400 INVALID_ENGINE_CONFIG
  ✔ T14: 非法 protocol → 400 INVALID_ENGINE_CONFIG
  ✔ T15: engine='opencode' → ok, engineConfig=null
  ✔ T16: engine='openworker' → ok（I4 存量不受影响）
  ✔ T17: updateAgent 合法 config ok / 非法 config → 400
ℹ tests 17  ℹ pass 17  ℹ fail 0  ℹ skipped 0

$ tsx --test test/team-autonomy/team-agent-service.test.ts（回归）
ℹ tests 19  ℹ pass 19  ℹ fail 0（存量功能无破坏）

$ pnpm exec tsc --noEmit -p tsconfig.json
（exit 0，无类型错误）
```

### 7.6 后续待办（不在本 P1 范围内）
- sidecar runtime 消费 `engine_config` 启动 CLI agent（pty/headless/jsonrpc 三种协议适配器）
- Kimi AtomCode / Freebuff / Claude Code 的具体 `binary` / `args` 模板与 `supported` 能力注册

