# OpenSpec: 通用 CLI agent 适配器规范（openspec-cli-agent-adapter）

- **状态**: **GREEN**（实现 + 测试 + 路由接入完成；真实 headless 冒烟留待有 key 环境）
- **分支**: feat/team-autonomy
- **日期**: 2026-08-04（RED 骨架）→ 2026-08-04（GREEN 实现）
- **负责人**: OpenWork 架构师（team-autonomy）
- **目标**: 让 OpenWork team agent 能驱动市面上主流 CLI agent（Claude Code / Codex / Gemini CLI / Qwen Code / Kimi / Freebuff / Cursor CLI / Windsurf / OpenCode 等），统一接入现有 `AgentSidecarAdapter` 接口，并保证「不支持的 agent 显式失败，而不是假成功」。

---

## 0. GREEN 验证记录（2026-08-04）

| 验收项（§8） | 结果 | 证据 |
|---|---|---|
| 1. 骨架测试并入 generic-cli.test.ts 全绿 | ✅ | `bun test src/agent-sidecar/cli-adapter/generic-cli.test.ts` → 20/20 pass |
| 2. bash 伪造 headless 跑通 stream()/exec() | ✅ | headless 模式用例（cliProfile.headless + prompt 追加为参数）pass |
| 3. 被 runAgentPrompt() 驱动 | ✅ | agent-runner duck-typing 接入 stream()；agent-team 全量 159/159 pass |
| 4. 真实 headless 冒烟命令记录 | ⏳ 留待有 key 环境 | claude -p / gemini -p 模板已写入 presets cliProfile，CI 跳过 |
| 5. fail-fast 用例全部通过 | ✅ | unsupported（binary-not-found / 声明冲突）一律抛 CliAgentUnsupportedError |
| 6. presets cliProfile 字段补齐 | ✅ | claude-code/codex/gemini/qwen-code/kimi/freebuff/cursor-agent 均已声明 |

类型检查：`npx tsc -p tsconfig.json --noEmit` → 0 错误。
回归：`bun test src/agent-sidecar/ src/agent-team/` → 159/159 pass（含 detect/registry/adapters/agent-sidecar/agent-team 全部既有用例，无破坏）。

---

## 1. 背景

OpenWork 桌面客户端使用 opencode sidecar 作为默认 agent 引擎（`TeamAgentEngine` 枚举 `["openworker","opencode","mcp","generic"]`，见 `ee/packages/den-db/src/schema/team-autonomy.ts:75`）。

现有 sidecar 适配层（`apps/server/src/agent-sidecar/`）：

- `types.ts:100-116` — `AgentSidecarAdapter` 接口（`protocol` / `agentId` / `displayName` / `capabilities` / `start()` / `detect()` / `doctor()`），以及 `SidecarHandle`（`isAlive()` / `stop()`）。
- `adapters/opencode.ts` — HTTP 协议 adapter（`opencode serve --hostname --port`，复用 `managed-opencode.ts`）。
- `adapters/pty.ts` — PTY 协议 adapter：spawn 任意进程 + `output-parser.ts` 四种解析模式（jsonl / ansi / regex / none）。
- `adapters/generic.ts` — generic 兜底（`commandTemplate` + `outputParser`）。
- `adapters/acp.ts` — ACP 协议（JSON-RPC over stdio）。
- `agent-team/` — dispatch / relay / broadcast / fan-out 通过 `runAgentPrompt()`（`agent-runner.ts`）统一驱动 adapter，只消费 `AgentEvent` 事件流。

**痛点**: 当前每个 agent 的能力靠手写的 `AGENT_PRESETS`（`presets.ts`，60+ 条目）声明，但 `presets.ts` 中把 `claude-code`、`codex`、`gemini` 等全部标为 `protocol: "pty"` 且 `args: []` —— 这忽略了它们各自的 **headless / print mode / 结构化输出** 能力，导致 team agent 无法可靠获取结构化结果、无法做工具调用上报、遇到真正只支持交互式的 agent 时也只是「盲写 stdin」。

**本规范的目标**: 设计一个通用 CLI agent 适配层，按 agent 的真实能力（headless / PTY / JSON-RPC / HTTP+SSE）分层驱动，抽象为统一的 `GenericCliSidecarAdapter`，并保证 fail-fast。

### 1.1 与已有 spec 的关系（分工）

同目录已有 `openspec-team-agent-engine-cli.md`，负责 **DB schema + 校验契约**：
- `TeamAgentEngine` 扩展 `"cli"` 枚举 + `engine_config` JSON 列（migration `0051_team_agent_cli_engine.sql`）。
- `AgentEngineConfig = { binary: string; args?: string[]; protocol?: "pty" | "headless" | "jsonrpc"; cwd?: string; env?: Record<string,string>; supported?: string[] }`。
- 纯函数 `validateEngineConfig(engine, config)`（`ee/apps/den-api/src/team-autonomy/`）。

**本 spec（openspec-cli-agent-adapter）只负责 sidecar runtime 适配层**：消费 `AgentEngineConfig`，把 `engine='cli'` 的 team agent 驱动起来。两者映射：

| 已有 spec（DB / 校验） | 本 spec（runtime 适配） |
|---|---|
| `engine_config.protocol = "pty"` | L1 PTY 路径（复用 `PtySidecarAdapter`） |
| `engine_config.protocol = "headless"` | L2 headless 输出解析路径（新） |
| `engine_config.protocol = "jsonrpc"` | L3 结构化路径（复用 `AcpSidecarAdapter`，ACP=JSON-RPC over stdio） |
| `engine_config.binary / args / cwd / env` | 直接透传给 `GenericCliSidecarAdapter` 构造与 `start()` |
| `engine_config.supported` | 映射为 `SidecarCapabilities` 子集（I1） |

---

## 2. 调研发现：主流 CLI agent 的 headless / 自动化能力（2026-08 证据）

> 结论先行：**所有主流 CLI agent 均提供 headless 或结构化协议中的至少一种**，真正"只支持交互式终端"的反而是少数（Freebuff、Windsurf）。通用适配层必须按「headless 输出解析优先、PTY 交互兜底」的策略设计。

### 2.1 Claude Code — headless ✅ / 结构化输出 ✅（最完善）

官方 CLI reference（https://docs.anthropic.com/en/docs/claude-code/cli-reference ）：

- **Print/headless 模式**: `claude -p "query"`（`--print`，经 SDK 查询后退出）；`cat file | claude -p "explain"`（管道输入）。
- **结构化输出**: `--output-format text|json|stream-json`；`--json-schema '<schema>'`（print mode 下按 JSON Schema 强制校验输出）；`--input-format text|stream-json`；`--include-partial-messages`（stream-json 流式事件）。
- **权限控制（非交互自动化关键）**: `--permission-mode plan|acceptEdits|bypassPermissions|dontAsk`；`--dangerously-skip-permissions`；`--allow-dangerously-skip-permissions`；`--permission-prompt-tool <mcp>`。
- **资源上限（print mode only）**: `--max-turns N`、`--max-budget-usd N`。
- **快速启动**: `--bare`（跳过 hooks/skills/plugins/MCP/CLAUDE.md 发现，脚本调用更快）。
- **会话管理**: `--resume/-r <id>`、`--continue/-c`、`--session-id <uuid>`、`--fork-session`、`--no-session-persistence`。
- **诊断命令（JSON 输出）**: `claude auth status`（JSON）、`claude agents`、`claude auto-mode defaults`（JSON）。
- **Server 模式**: `claude remote-control`（无本地交互 session 的 server，供 Claude.ai/App 遥控）。
- 其他: `--add-dir`、`--mcp-config`、`--system-prompt`、`--tools "Bash,Edit,Read"`、`--allowedTools`、`--model`、`--worktree/-w`。

### 2.2 OpenAI Codex CLI — headless ✅（exec）/ 结构化输出 ✅

GitHub README（https://github.com/openai/codex ）+ 使用教程（腾讯云开发者社区 https://cloud.tencent.com/developer/article/2630702 ）：

- 安装: `curl -fsSL https://chatgpt.com/codex/install.sh | sh` 或 `npm install -g @openai/codex` 或 `brew install --cask codex`。
- **Headless（exec）**: `codex exec "prompt"`；`codex exec --json "..."`（输出最后消息为 JSON）；`codex exec --output-last-message result.txt "..."`；`codex exec --ephemeral "..."`（不保存会话的一次性任务）。
- **会话**: `codex resume`、`codex resume --list`。
- **桌面**: `codex app`。
- **IDE**: VS Code / Cursor / Windsurf 官方集成。
- **ACP**: 社区/官方有 `codex acp` 入口（OpenWork preset 中 `codex-acp` 已声明 `args: ["acp"]`，需在实现轮验证 Rust 版 `codex acp` 子命令的可用性）。

### 2.3 Gemini CLI — headless ✅ / 结构化输出 ✅（stream-json）

GitHub README（https://github.com/google-gemini/gemini-cli ）：

- 安装: `npm install -g @google/gemini-cli` / `brew install gemini-cli` / `npx @google/gemini-cli`。
- **Headless（非交互）**: `gemini -p "prompt"`；文档页 https://www.geminicli.com/docs/cli/headless。
- **结构化输出**: `gemini -p "..." --output-format json`（解析 JSON）；`--output-format stream-json`（NDJSON 实时事件流，适合监控长任务）。
- 其他: `gemini -m <model>`、`--include-directories ../lib,../docs`、GitHub Action `google-github-actions/run-gemini-cli`、MCP server 支持。

### 2.4 Qwen Code — headless ✅ / serve(HTTP+SSE/ACP) ✅ / SDK ✅

GitHub README（https://github.com/QwenLM/Qwen-Code ）：

- 安装: `npm install -g @qwen-code/qwen-code@latest` / `brew install qwen-code` / curl 脚本。
- **Headless**: `qwen -p "..."`（脚本 / CI/CD / 批处理，无 UI）。
- **Daemon**: `qwen serve` — 共享 agent session over HTTP+SSE（ACP），多客户端一个 agent。
- **SDK**: TypeScript / Python / Java。
- 特性对齐 Claude Code：SubAgents、Agent Teams、MCP、Plan Mode、LSP、Headless、Session Management。
- 历史：基于 Gemini CLI v0.8.2 衍生（README 致谢）。

### 2.5 Kimi CLI（Kimi AtomCode）— 交互式 ✅ / ACP ✅ / headless 待验证 ❓

- GitHub: `MoonshotAI/kimi-code`（约 1.8k stars，MIT）。
- 安装: `curl -fsSL https://kimi.com/code/install.sh | bash`（OpenWork preset 已收录）。
- **ACP**: `kimi --acp`（Zed `agent_servers` 配置证据：`{"command": "kimi", "args": ["--acp"]}`，见 CSDN 教程 https://blog.csdn.net/twelveai/article/details/153958071 ）。
- 交互式终端 agent（能直接授权执行文件操作）。
- **headless `-p` print mode：未检索到官方文档证据，标注「待验证」** → 默认走 ACP 协议（`kimi --acp`），这与 OpenWork preset `kimi: { protocol: "acp", args: ["acp"] }` 一致（注：preset 写的是 `args: ["acp"]`，Zed 示例是 `--acp`，实现时需以 `--acp` 探测为准）。

### 2.6 Freebuff — 免费 Claude Code 替代，交互式为主 ❓

- npm: `freebuff`（v0.0.137，2026-08-04 发布，周下载 ~19k，MIT，https://www.npmjs.com/package/freebuff ）。
- 安装/用法: `npm install -g freebuff`；`cd ~/my-project && freebuff`（交互式终端 agent）。
- 基于 Codebuff 平台（GitHub: `CodebuffAI/codebuff`）；免费（广告支持）；模型为开源模型（DeepSeek V4 Pro/Flash、MiMo、MiniMax）。
- **headless / 结构化输出：官方 npm 描述未提及，标注「待验证」** → 若实现轮验证无 headless，则 fail-fast 拒绝 `exec()`，仅允许 PTY 交互路径或明确报「unsupported」。

### 2.7 Cursor CLI — CLI 网关，headless 细节待验证 ❓

- 命令: `agent` 为当前主要 CLI 入口，`cursor-agent` 为向后兼容别名；`agent models`、`-list-models`、`/models`（3DM 软件站 https://m.3dmgame.com/soft/368937.html ）。
- 2026 年 Cursor 持续加强终端 AI 能力（对标 Claude Code，掘金 https://juejin.cn/post/7596845113282002953 ）。
- **headless `-p` / 结构化输出：未检索到官方稳定文档，标注「待验证」**。

### 2.8 Windsurf — IDE 定位为主，CLI 能力有限 ⚠️

- 定位: Codeium 出品的 AI 原生 IDE（Cascade），2026 年被 Devin 收购；CLI 自动化能力弱于其他 agent。
- 结论: 适配矩阵中标为「不推荐接入 team agent；若强制接入则 fail-fast」。

### 2.9 OpenCode — 默认引擎，headless(serve) ✅ / ACP ✅

- OpenWork 已有实现证据（非本轮调研）：`opencode serve --hostname --port`（`managed-opencode.ts`）、`opencode acp`（preset `opencode: { protocol: "acp", args: ["acp"] }`）。
- 不在本轮 RED 范围内（已有 adapter）。

### 2.10 DeepSeek CLI — 无稳定官方 CLI agent ⚠️

- 2026-08 检索未发现 DeepSeek 官方稳定 CLI agent 形态；DeepSeek 模型通常作为其他 agent 的后端（如 Freebuff、Qwen Code 多协议支持、Claude Code/Codex 的 API 网关后端）。
- 结论: 不新增 preset；若用户指定，走 `generic` 兜底或 fail-fast。

### 2.11 能力矩阵汇总

| Agent | 二进制 | Headless | 结构化输出 | 协议/模式 | 工具调用上报 | 证据 |
|---|---|---|---|---|---|---|
| Claude Code | `claude` | ✅ `-p` | ✅ json / stream-json / json-schema | print + remote-control server | ✅ stream-json 事件 | [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference) |
| Codex CLI | `codex` | ✅ `codex exec` | ✅ `--json` | exec / resume / app | ⚠️ 有限 | [GitHub](https://github.com/openai/codex) / [教程](https://cloud.tencent.com/developer/article/2630702) |
| Gemini CLI | `gemini` | ✅ `-p` | ✅ json / stream-json | 交互 + headless | ✅ stream-json | [GitHub](https://github.com/google-gemini/gemini-cli) |
| Qwen Code | `qwen` | ✅ `-p` | ✅（继承 Gemini） | 交互 + headless + `qwen serve`(HTTP+SSE/ACP) + SDK | ✅ | [GitHub](https://github.com/QwenLM/Qwen-Code) |
| Kimi CLI | `kimi` | ❓待验证 | ✅ ACP(JSON-RPC over stdio) | 交互 + `--acp` | ✅（经 ACP） | [CSDN/Zed](https://blog.csdn.net/twelveai/article/details/153958071) |
| Freebuff | `freebuff` | ❓待验证 | ❓ | 交互式终端 agent | ❓ | [npm](https://www.npmjs.com/package/freebuff) |
| Cursor CLI | `agent`/`cursor-agent` | ❓待验证 | ❓ | CLI 网关 | ❓ | [3DM](https://m.3dmgame.com/soft/368937.html) |
| Windsurf | `windsurf` | ⚠️ 无 | ⚠️ 无 | IDE Cascade | ❌ | 检索结论 |
| OpenCode | `opencode` | ✅ `serve` | ✅ HTTP+SSE / ACP | serve / acp | ✅ | 仓库已有实现 |
| DeepSeek CLI | — | ⚠️ 无稳定 CLI | ⚠️ | 模型后端 | ❌ | 检索结论 |

---

## 3. 不变量（Invariants）

**I1 — 每个 CLI agent 通过 engine_config 声明**
所有接入的 CLI agent 必须通过 `AgentEngineConfig`（`openspec-team-agent-engine-cli.md` 定义，落库到 `team_agent.engine_config`）显式声明：`binary`（二进制名）、`args`（启动参数）、`protocol`（`pty` | `headless` | `jsonrpc`）、`cwd`/`env`、`supported`（能力标记）。runtime 侧映射为 `AgentSidecarConfig` 并补充探测元数据（`headlessArgs`，如 `["-p"]` / `["exec"]`；`outputFormats`，如 `["stream-json"]`）。禁止在 adapter 代码里硬编码某个具体 agent 的行为。

**I2 — 适配器统一暴露 AgentSidecarAdapter 接口**
`GenericCliSidecarAdapter`（以及任何新 agent 专属 adapter）必须实现 `AgentSidecarAdapter`（`types.ts`），使 `agent-team/` 的 `runAgentPrompt()`、dispatch / relay / broadcast / fan-out 无需改动即可驱动新 agent。上层只消费 `AgentEvent` 事件流，不感知底层是 headless 还是 PTY。

**I3 — 不支持的 agent 明确 fail-fast，而不是假成功**
- 若 `engine_config` 声明的 `cliProfile` 与实际探测结果不符（例如声明 headless 但二进制不支持 `-p`），`detectCapabilities()` 必须返回 `unsupported: true` + 原因，`start()` 必须 throw。
- 若 agent 只支持交互式（如未验证 headless 的 Freebuff），调用 `exec()`/`stream()` 必须 throw `CliAgentUnsupportedError`（带 agentId + 缺失能力），**不允许**出现「进程起来了但永远收不到 `stop` 事件」的假成功。
- 未知 `agentId` 抛错逻辑沿用 `createAdapterForAgent`（`registry.test.ts:85-87` 已有断言）。

**I4 — 进程生命周期管理（spawn/kill/超时/输出流解析）**
- `start()` 负责 spawn（沿用 `PtySidecarAdapter` / `GenericSidecarAdapter` 的 `resolveCleanPath` + `buildTransportEnv` 模式，保证 PATH 清洗与 env 脱敏）。
- `stop()` 必须幂等：SIGTERM → 1s 宽限 → SIGKILL（沿用 `pty.ts:84-101` 模式），并结束输出解析器。
- 每个 `exec()`/`stream()` 必须支持 `timeoutMs`：超时后 kill 进程并产出 `{ kind: "error", error: "prompt timeout" }`（沿用 `agent-runner.ts:134-137`）。
- 输出流（stdout/stderr）必须绑定解析器（`output-parser.ts` 的 jsonl / ansi / regex / none），stderr 一律走 ansi 诊断流。

**I5 — 会话隔离（每个 agent 任务独立 cwd/env）**
- 每次 `start(options)` 必须使用调用方传入的 `cwd` 与 `env`（含显式 PATH），禁止复用上一个任务的 cwd/env 或全局共享状态。
- `SidecarHandle.transportInfo` 必须记录实际 command / args / cwd / env（已脱敏），用于日志与诊断（`types.ts:88-97`）。

---

## 4. 协议分层设计

通用 CLI agent 适配层按「能力金字塔」分三层，`GenericCliSidecarAdapter` 按 `cliProfile` 选择执行路径，上层无感知：

```
            ┌─────────────────────────────────────────────┐
            │   L3 结构化协议层 (JSON-RPC / HTTP+SSE)        │
            │   ACP (kimi --acp, codex acp, qwen serve)    │
            │   HTTP+SSE (opencode serve, qwen serve)      │
            │   → 会话、权限请求、工具调用上报最完整          │
            ├─────────────────────────────────────────────┤
            │   L2 headless 输出解析层                      │
            │   claude -p --output-format stream-json      │
            │   gemini -p --output-format stream-json      │
            │   codex exec --json                          │
            │   qwen -p                                    │
            │   → spawn 一次性进程，stdout 按 jsonl/ansi 解析│
            ├─────────────────────────────────────────────┤
            │   L1 交互式终端驱动层 (PTY)                   │
            │   任意 CLI：spawn + 写 stdin + ANSI 解析       │
            │   → 兜底，无结构化输出、无权限上报             │
            └─────────────────────────────────────────────┘
```

- **L1（PTY）**: 已有 `PtySidecarAdapter`（`adapters/pty.ts`）+ `output-parser.ts`。适配矩阵中「交互式」agent 的最低保障。
- **L2（headless 输出解析）**: 新层。核心抽象是「headless 参数模板 + 输出解析器」：`headlessArgs: ["-p"]`（或 `["exec", "--json"]`），stdout 按 `outputParser`（`stream-json` → jsonl 解析；`json` → 最终结果 JSON；`ansi` → 行 chunk）映射到 `AgentEvent`。Claude Code / Gemini CLI / Qwen Code / Codex 走此层。
- **L3（结构化协议）**: 已有 `AcpSidecarAdapter`（`adapters/acp.ts`）与 `OpenCodeSidecarAdapter`（HTTP）。Kimi（`--acp`）、Qwen（`qwen serve`）走此层。工具调用上报、权限请求、计划等结构化事件由协议自带。

**选择策略**（`detectCapabilities()` 之后）：`structured → headless → pty`。`GenericCliSidecarAdapter` 内部组合现有 adapter（acp/http/pty/generic）而非重写协议栈——本规范不要求新写 ACP/HTTP 客户端，只要求新增「headless 执行器」与「能力探测」两个组件。

---

## 5. 适配矩阵（agent × 能力）

| Agent | Headless | PTY | 结构化(ACP/HTTP) | 结构化输出 | 工具调用上报 | 推荐接入路径 |
|---|---|---|---|---|---|---|
| Claude Code | ✅ `-p` | ✅ 兜底 | ⚠️ remote-control(研究预览) | ✅ stream-json/json | ✅ | L2 headless stream-json |
| Codex CLI | ✅ `exec` | ✅ 兜底 | ⚠️ `acp` 待验证 | ✅ `--json` | ⚠️ | L2 headless |
| Gemini CLI | ✅ `-p` | ✅ 兜底 | — | ✅ json/stream-json | ✅ | L2 headless stream-json |
| Qwen Code | ✅ `-p` | ✅ 兜底 | ✅ `serve`(HTTP+SSE) | ✅ | ✅ | L3 serve / L2 headless |
| Kimi CLI | ❓待验证 | ✅ | ✅ `--acp` | ✅ | ✅ | L3 ACP |
| Freebuff | ❓待验证 | ✅ | — | ❓ | ❓ | L1 PTY（未验证 headless 前） |
| Cursor CLI | ❓待验证 | ✅ | — | ❓ | ❓ | L1 PTY（待验证后升级） |
| Windsurf | ❌ | ⚠️ | — | ❌ | ❌ | 不推荐 / fail-fast |
| OpenCode | ✅ serve | ✅ | ✅ acp | ✅ | ✅ | 已有 adapter（不动） |
| DeepSeek CLI | ❌ 无稳定 CLI | ⚠️ | — | ❌ | ❌ | 不新增 / fail-fast |

---

## 6. API 契约：GenericCliSidecarAdapter

新增文件（GREEN 轮实现，本轮只有测试骨架）：

```
apps/server/src/agent-sidecar/cli-adapter/
  generic-cli.ts          # GenericCliSidecarAdapter + detectCliCapabilities + CliAgentUnsupportedError
  generic-cli.test.ts     # 实现后测试（RED 骨架在 spec-skeleton.test.ts）
```

### 6.1 能力探测

```ts
export type CliAutomationMode = "headless" | "pty" | "structured" | "unsupported";

export interface CliCapabilities {
  mode: CliAutomationMode;
  /** 探测到的二进制绝对路径 */
  binaryPath?: string;
  /** 版本 */
  version?: string;
  /** headless 参数模板，如 ["-p"] / ["exec"] / ["-p", "--output-format", "stream-json"] */
  headlessArgs?: string[];
  /** 支持的结构化输出格式：json | stream-json | ansi */
  outputFormats?: Array<"json" | "stream-json" | "ansi">;
  /** 是否支持权限请求上报（仅 structured 层） */
  permissions?: boolean;
  /** 不支持原因（mode === "unsupported" 时必有） */
  unsupportedReason?: string;
}

export function detectCliCapabilities(
  binary: string,
  options?: { versionFlag?: string; helpFlag?: string; env?: Record<string, string> },
): Promise<CliCapabilities>;
```

探测规则（I1 + I3）：
1. 二进制不存在 → `{ mode: "unsupported", unsupportedReason: "binary-not-found" }`。
2. 跑 `--version`/`--help` 判定 agent 家族（或由 `engine_config.cliProfile` 直接指定，探测仅做确认）。
3. 尝试 headless 冒烟（如 `claude -p "hi" --output-format stream-json --max-turns 1`）→ 成功则 `mode: "headless"`；失败回退按配置声明的协议定 `pty`/`structured`。
4. 声明与实测冲突 → `mode: "unsupported"` + 原因（I3）。

### 6.2 适配器类

```ts
export class GenericCliSidecarAdapter implements AgentSidecarAdapter {
  readonly protocol: "pty" | "generic";   // 对外统一，内部按 cliProfile 分流
  readonly agentId: string;
  readonly displayName: string;
  readonly capabilities?: SidecarCapabilities;

  constructor(config: AgentSidecarConfig);

  /** I4: spawn 进程（headless 模式 spawn 一次性进程；pty 模式复用 PtySidecarAdapter） */
  start(options: SidecarStartOptions): Promise<SidecarHandle>;

  /** I4: 幂等 stop（SIGTERM → 1s → SIGKILL）+ 结束解析器 */
  stop(): Promise<void>;

  /** L2: 一次性 headless 执行（如 claude -p、codex exec），返回最终文本 */
  exec(prompt: string, opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; events: AgentEvent[] }>;

  /** L2: 流式执行（stream-json / jsonl 解析为 AgentEvent 流） */
  stream(prompt: string, opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): AsyncIterable<AgentEvent>;

  /** 输出解析（单块 → 事件），复用/扩展 output-parser.ts */
  parseOutput(chunk: Buffer | string): AgentEvent[];

  /** 能力探测（I1 声明的 cliProfile 与实际探测交叉验证） */
  detectCapabilities(): Promise<CliCapabilities>;

  /** I3: unsupported 时 throw CliAgentUnsupportedError */
  // detect(): Promise<AgentDetectResult>;   // 继承 BaseSidecarAdapter
  // doctor(): Promise<AgentDoctorInfo>;     // 继承 BaseSidecarAdapter
}

export class CliAgentUnsupportedError extends Error {
  readonly agentId: string;
  readonly missing: string[];        // 缺失能力列表
  constructor(agentId: string, missing: string[], reason?: string);
}
```

约束：
- `exec()` / `stream()` 在 `mode === "unsupported"` 或「headless 探测失败且未声明 pty 兜底」时必须 throw `CliAgentUnsupportedError`（I3）。
- `exec()` 与 `stream()` 必须支持 `timeoutMs`（默认 60_000，与 `agent-runner.ts` 一致）并保证 kill（I4）。
- 每次调用独立 cwd/env（I5）。
- `AgentEvent` 复用现有 union（`types.ts:195-205`）；stream-json 的 tool-call 事件映射到 `tool-call`/`tool-call-update`。

### 6.3 与现有模块的关系

- 注册：`index.ts` 导出 `GenericCliSidecarAdapter` / `detectCliCapabilities` / `CliAgentUnsupportedError`（GREEN 已实现）。
- 路由：`agent-runner.ts` 的 `pty/generic` 分支 duck-typing 检测 `stream` 方法，命中则调用 `stream(prompt, { cwd, timeoutMs })`（GREEN 已实现），上层 dispatch/relay 零改动（I2）。
- `presets.ts` 的 `claude-code` / `codex` / `gemini` / `qwen-code` / `kimi` / `freebuff`（新增）/ `cursor-agent` 条目已补充 `cliProfile` + `headlessArgs` + `outputFormats` 字段（GREEN 已实现）。

---

## 7. RED 测试清单（骨架见 §9）

### 7.1 解析器单测（L2 输出解析）
- [ ] `stream-json` 输出解析：`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}` → `agent-message-chunk`
- [ ] `json` 最终结果解析：`{"result":"done","is_error":false}` → `agent-message-chunk` + `stop`
- [ ] jsonl 非法行 → 按 `agent-message-chunk` 转发（沿用 `output-parser.ts:77-80` 语义）
- [ ] stderr 诊断流独立于 stdout 事件流

### 7.2 能力探测
- [ ] `detectCliCapabilities` 对存在的二进制（`/bin/echo`）返回非 unsupported
- [ ] 对不存在的二进制返回 `{ mode: "unsupported", unsupportedReason: "binary-not-found" }`
- [ ] `claude -p --output-format stream-json` 冒烟成功 → `mode: "headless"`、`outputFormats` 含 `stream-json`

### 7.3 fail-fast（I3）
- [ ] `GenericCliSidecarAdapter` 构造后 `detectCapabilities()` 为 unsupported 时，`exec()` throw `CliAgentUnsupportedError`（带 `agentId` + `missing`）
- [ ] 声明 headless 但探测失败 → `start()` throw，不产生「假成功」handle
- [ ] `createAdapterForAgent("windsurf")` 类 agent（无 preset / 不支持）→ 抛错

### 7.4 PTY 交互模拟（L1，复用 e2e.test.ts 模式）
- [ ] `stream()` 对 `bash -c 'read line; echo "echo: $line"'` 返回事件流 + `stop`
- [ ] 超时：`timeoutMs: 200` 的 agent 超过 200ms 未结束 → `{ kind: "error", error: "prompt timeout" }` 且进程被 kill（`isAlive() === false`）
- [ ] `stop()` 幂等：连续两次调用不抛错

### 7.5 生命周期（I4 / I5）
- [ ] `transportInfo` 含脱敏 env（关键 token 值被 `redacted: true`）
- [ ] 两次 `exec()` 使用不同 cwd 互不影响（I5）

---

## 8. GREEN 验收标准

1. `bun test src/agent-sidecar/cli-adapter/spec-skeleton.test.ts` 全绿（骨架测试改名/合并进 `generic-cli.test.ts`）。
2. 用 `bash` 伪造 headless agent（如 `bash -c 'cat > /dev/null; printf "{\"type\":\"stop\"}\n"'`）跑通 `stream()` 事件流（不依赖真实网络/API key）。
3. `GenericCliSidecarAdapter` 通过 `AgentSidecarAdapter` 接口被 `agent-team/` 的 `runAgentPrompt()` 驱动（一个 dispatch 或 relay 用例）。
4. 至少两个真实 headless 冒烟命令记录在案（`claude -p ...`、`gemini -p ...`），验证 `headlessArgs` 模板正确——**CI 不强制跑真实 agent**（无 key 环境跳过）。
5. fail-fast 用例全部通过：unsupported agent 一律抛 `CliAgentUnsupportedError`，不出现假成功。
6. `presets.ts` 中 `claude-code`/`codex`/`gemini`/`qwen-code`/`kimi`/`freebuff`/`cursor-agent` 条目补齐 `cliProfile` 字段（schema 校验通过）。

---

## 9. 测试位置与命令（RED 骨架 → GREEN 实现）

- **实现/测试文件**（GREEN）：`apps/server/src/agent-sidecar/cli-adapter/generic-cli.ts`（实现）+ `generic-cli.test.ts`（20 用例，原 spec-skeleton.test.ts 已并入删除）。
- **位置说明**: 仓库现有测试惯例是 `src/**/*.test.ts` 与源码同目录（如 `src/agent-sidecar/registry.test.ts`、`src/agent-team/dispatch.test.ts`），故不建 `apps/server/test/` 目录。
- **运行命令**（仓库根或 `apps/server/` 下）:

```bash
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd apps/server
bun test src/agent-sidecar/cli-adapter/generic-cli.test.ts
```

---

## 10. 本轮交付物

| 文件 | 类型 | 说明 |
|---|---|---|
| `prds/team-autonomy/openspecs/openspec-cli-agent-adapter.md` | 规范 | 本文档（调研 + 不变量 + 分层 + 矩阵 + 契约 + RED/GREEN + 验证记录） |
| `apps/server/src/agent-sidecar/cli-adapter/generic-cli.ts` | 实现 | `GenericCliSidecarAdapter` + `detectCliCapabilities` + `CliAgentUnsupportedError`（L2 headless exec/stream + L1 pty 委托） |
| `apps/server/src/agent-sidecar/cli-adapter/generic-cli.test.ts` | 测试 | 20 用例（§7.1-7.5 全覆盖），原 spec-skeleton.test.ts 已并入删除 |
| `apps/server/src/agent-sidecar/types.ts` | 修改 | `AgentSidecarConfig` 增加 `cliProfile` 字段（headlessArgs/outputFormats） |
| `apps/server/src/agent-sidecar/output-parser.ts` | 修改 | 导出 `mapJsonlToEvent` 供 CLI 输出映射复用 |
| `apps/server/src/agent-sidecar/presets.ts` | 修改 | claude-code/codex/gemini/qwen-code/kimi/cursor-agent 补 cliProfile；新增 freebuff preset |
| `apps/server/src/agent-sidecar/index.ts` | 修改 | 导出 cli-adapter 模块符号 |
| `apps/server/src/agent-team/agent-runner.ts` | 修改 | pty/generic 分支 duck-typing 接入 `stream()` |

**遗留**（非本轮）：真实 agent headless 冒烟（需 API key）；`engine='cli'` team-agent 运行时接线到 `GenericCliSidecarAdapter` 的完整链路；team-agent 创建 UI 的引擎选择器。

---

## 11. 参考链接

- Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference
- Codex CLI (GitHub): https://github.com/openai/codex ；Codex exec 用法: https://cloud.tencent.com/developer/article/2630702
- Gemini CLI (GitHub): https://github.com/google-gemini/gemini-cli ；headless docs: https://www.geminicli.com/docs/cli/headless
- Qwen Code (GitHub): https://github.com/QwenLM/Qwen-Code
- Kimi CLI: https://github.com/MoonshotAI/kimi-code ；ACP 配置示例: https://blog.csdn.net/twelveai/article/details/153958071
- Freebuff (npm): https://www.npmjs.com/package/freebuff ；Codebuff: https://github.com/CodebuffAI/codebuff
- Cursor CLI: https://m.3dmgame.com/soft/368937.html ；https://juejin.cn/post/7596845113282002953
- 现有代码: `apps/server/src/agent-sidecar/types.ts` / `adapters/pty.ts` / `adapters/generic.ts` / `presets.ts` / `output-parser.ts` / `agent-team/agent-runner.ts` / `ee/packages/den-db/src/schema/team-autonomy.ts:75`
