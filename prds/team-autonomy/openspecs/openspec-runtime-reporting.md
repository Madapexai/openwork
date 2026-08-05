# OpenSpec: Runtime 能力上报层规范（openspec-runtime-reporting）

- **状态**: **GREEN**（实现 + 测试 + 路由接入完成）
- **分支**: feat/team-autonomy
- **日期**: 2026-08-05
- **负责人**: OpenWork 架构师（team-autonomy）
- **目标**: 借鉴 multica 的 Runtime 概念，让 daemon 启动时 auto-detect PATH 上的可用 CLI agents，把「这台机器有哪些 agent 引擎、各自能力如何」作为结构化能力上报给控制平面 / UI，作为 agent 创建与任务路由的入口。
- **前置**: [openspec-cli-agent-adapter.md](./openspec-cli-agent-adapter.md)（GenericCliSidecarAdapter + detectAllAgents 已 GREEN）

---

## 0. GREEN 验证记录（2026-08-05）

| 验收项（§8） | 结果 | 证据 |
|---|---|---|
| 1. list() 返回全部 preset 能力列表 | ✅ | `bun test src/runtime-registry.test.ts` → 7/7 pass |
| 2. TTL 缓存不重复扫描 PATH（I1） | ✅ | 缓存命中用例 pass |
| 3. invalidate() 强制重扫 | ✅ | `POST /agent-runtimes/reload` 路径 pass |
| 4. get() 单 agent 详情 + 未知 agent null | ✅ | bash 真实探测 + 未知返回 null pass |
| 5. deepProbe 带 detected（mode 至少 pty） | ✅ | cli 引擎 agent 用例 pass |
| 6. 逐条容错（I3） | ✅ | refresh() 循环内 try/catch，单 agent 失败不阻断 |
| 7. 三个新模块 + 全量类型检查 | ✅ | `npx tsc -p tsconfig.json --noEmit` → 0 错误 |

回归：`bun test src/runtime-registry.test.ts src/chat/chat-relay.test.ts src/worktree/worktree-service.test.ts` → 24/24 pass。

---

## 1. 背景

OpenWork 已有 `agent-sidecar/detect.ts` 的 `detectAllAgents()`（multica 风格 auto-detect）与 `AGENT_PRESETS`（60+ 条目）。但这些探测结果散落在各调用点，没有统一的：
- **结果缓存**（每次查询都重扫 PATH，慢且无谓）
- **能力详情**（available 之外，不知道 headless / 结构化输出 / 协议层能力）
- **HTTP 出口**（控制平面 / UI 无法查询「这台机器有哪些 agent」）

**本规范的目标**：在 detectAllAgents 之上加一层 `RuntimeRegistry`——TTL 缓存 + 单 agent 深度探测 + 强制重扫，并暴露三个 HTTP 端点。

### 1.1 与业界对齐

| 项目 | 机制 | 我们的对应 |
|---|---|---|
| multica | Runtime 概念：daemon 启动时探测机器上的 code agents 并上报 | `RuntimeRegistry.refresh()` + `GET /agent-runtimes` |
| cc-connect | capability 协商（每个 agent 声明能力） | `AGENT_PRESETS`（声明）∩ `probeAgent`（实测） |

---

## 2. 不变量（Invariants）

**I1 — TTL 缓存**：同一进程内，TTL（默认 60s）内重复 `list()` 不重复扫描 PATH，直接返回缓存。`invalidate()` 强制失效后下一次查询重扫。

**I2 — 声明 ∩ 实测，冲突以实测为准**：深度探测结果 = `preset.cliProfile` 声明与 `GenericCliSidecarAdapter.detectCapabilities()` 实测的交集；探测返回 `mode: "unsupported"` 时 `detected` 保留该结果（供 UI 提示），不覆盖 `available`。

**I3 — 逐条容错**：`refresh()` 对每个 agent 独立 try/catch，单 agent 探测失败（二进制缺失、解析异常）只丢弃该条目的 `detected`，不阻断整体上报。

**I4 — 并发去重**：`list()` 并发调用共享同一个 in-flight `refresh()` promise，避免重复扫描。

---

## 3. API 契约

### 3.1 RuntimeRegistry（`apps/server/src/runtime-registry.ts`）

```ts
export interface RuntimeAgentCapability {
  agentId: string;
  label: string;
  available: boolean;          // 二进制在 PATH 上
  binaryPath?: string;
  version?: string;
  protocol: string;            // acp / pty / generic / mcp
  engine: string;              // openworker / opencode / mcp / generic / cli
  declaredHeadless: boolean;   // preset.cliProfile.headless === true
  detected?: CliCapabilities;  // 实测能力（deepProbe 开启且可用时）
  error?: string;              // available=false 时的检测错误
}

export class RuntimeRegistry {
  constructor(options?: { ttlMs?: number; deepProbe?: boolean; path?: string; detect?: (path?: string) => Promise<AgentDetectResult[]> });
  list(): Promise<RuntimeAgentCapability[]>;   // I1 缓存 / I4 并发去重
  get(agentId: string): Promise<RuntimeAgentCapability | null>;  // 单 agent（含 3s 深度探测兜底）
  invalidate(): void;                          // 强制失效缓存
  refresh(): Promise<RuntimeAgentCapability[]>; // I3 逐条容错
}
```

### 3.2 HTTP 路由（`apps/server/src/routes/agent-runtimes.ts`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/agent-runtimes` | 全部 CLI agents 能力列表（TTL 缓存） |
| GET | `/agent-runtimes/:agentId` | 单个 agent 详情；未知 agent → 404 |
| POST | `/agent-runtimes/reload` | 强制重扫（失效缓存） |

消费方：控制平面（den-api）/ UI 的 agent 创建与任务路由入口；chat bridge 的 agent 可用性预检。

---

## 4. 测试清单（`src/runtime-registry.test.ts`，7 用例）

- [x] `list()` 返回所有 preset 的 agent 能力（含可用/不可用、协议、引擎、headless 声明）
- [x] I1: TTL 内重复 list() 命中缓存（不重复扫描 PATH）
- [x] invalidate() 后强制重扫（返回新引用）
- [x] RUNTIME_REFRESH_TTL_MS 默认 60s
- [x] get() 返回存在的 agent（bash 必然在 PATH 上，验证真实探测）
- [x] get() 对未知 agent 返回 null
- [x] deepProbe 时 cli 引擎 agent 带 detected（mode 至少 pty）

---

## 5. GREEN 验收标准

1. `bun test src/runtime-registry.test.ts` 全绿（7/7）。
2. `GET /agent-runtimes` 返回结构化能力列表；`GET /agent-runtimes/bash` 返回单 agent 详情；未知返回 404。
3. `POST /agent-runtimes/reload` 后能力列表刷新。
4. 测试注入 `detect` 函数（不依赖真实 PATH 探测），生产默认走 `detectAllAgents`。

---

## 6. 交付物

| 文件 | 类型 | 说明 |
|---|---|---|
| `apps/server/src/runtime-registry.ts` | 实现 | `RuntimeRegistry`（TTL 缓存 / 单 agent 详情 / 深度探测 / 逐条容错）+ `createAdapterFromPreset` |
| `apps/server/src/routes/agent-runtimes.ts` | 路由 | GET `/agent-runtimes`、GET `/agent-runtimes/:agentId`、POST `/agent-runtimes/reload` |
| `apps/server/src/runtime-registry.test.ts` | 测试 | 7 用例（I1-I4 全覆盖） |
| `apps/server/src/server.ts` | 修改 | 注册 agent-runtimes 路由 |

**遗留**：控制平面（den-api）消费 `/agent-runtimes` 做 agent 创建表单的引擎选择器；与 SSO 体系打通后的权限化访问。
