# Information Integration: OpenWork vs OpenCode & DeepSeek Harness Analysis

## 1. OpenWork vs OpenCode — Key Differences

### 1.1 Core Positioning

| Aspect | OpenCode | OpenWork |
|--------|----------|----------|
| **Nature** | AI coding engine (CLI/editor plugin) | Full desktop application platform built on OpenCode |
| **Scope** | Code generation, editing, session management | Everything OpenCode does + desktop UI, server layer, org management, MCP gateway |
| **Target user** | Individual developers, CLI/editor users | Individuals, teams, enterprises, non-technical users |
| **Distribution** | npm package (`opencode`) | Electron desktop app + self-hosted server |

### 1.2 Architecture

**OpenCode** is a single-process CLI tool:
- Agent core (message loop, tool calls)
- Provider adapter (50+ model providers)
- Plugin/MCP/Skill/Command system
- SQLite storage (`opencode.db`)
- Built-in HTTP server for client connections
- Reads `opencode.json` and `.opencode/` directory for config

**OpenWork** wraps OpenCode in a three-layer architecture:

```
┌─────────────────────────────────────────────────────────┐
│  Desktop App (Electron)                                  │
│  React + shadcn/ui + Tailwind | Chat UI, File browser  │
│  Browser automation, Desktop automation                  │
├─────────────────────────────────────────────────────────┤
│  OpenWork Server (apps/server/)                         │
│  REST API | Engine Pool (blue-green) | Managed OpenCode │
│  Workspace mgmt | Skills CRUD | MCP dynamic mgmt       │
│  Auth (Better-Auth) | Audit logs | Cloud sync           │
├─────────────────────────────────────────────────────────┤
│  MCP Gateway (ee/apps/den-api)                          │
│  Single URL: api.openworklabs.com/mcp/agent             │
│  search_capabilities / execute_capability               │
├─────────────────────────────────────────────────────────┤
│  Den Control Plane (ee/apps/den-*)                      │
│  Team management | Access control | Policies | Inference │
└─────────────────────────────────────────────────────────┘
```

### 1.3 What OpenWork Adds on Top of OpenCode

- **Desktop shell**: Electron app providing native macOS/Windows/Linux experience
- **Web UI**: React + shadcn/ui workspace with chat, file browser, skills/MCP management
- **Server layer**: Unified REST API exposing all OpenCode capabilities
- **Engine Pool**: Blue-green rolling upgrades for OpenCode subprocesses (zero-downtime config changes)
- **Runtime MCP/Plugin management**: Dynamic add/remove MCP connections and plugins via API
- **Skills/Commands CRUD**: Server-side management APIs for skills and commands
- **Workspace management**: Multi-workspace creation and switching (local + remote)
- **MCP Gateway**: Single URL for any MCP client (Codex, Claude Code, Cursor) to share org-level skills/plugins/connections
- **Den Control Plane**: Organization-level team management, access control, inference resource allocation
- **Browser/Desktop automation**: Built-in browser panel and automation runner
- **Chat relay**: IM platform message bridging (Feishu, WeChat, DingTalk)
- **Headless mode**: `pnpm dev:headless-web` for pure server mode without Electron
- **Validation体系**: Testkit-driven verification (`evals/specs/**/*.test.ts`)
- **Voiceover-driven dev**: `/voiceover <feature>` for demo-driven development

### 1.4 Key Design Philosophy Differences

| Dimension | OpenCode | OpenWork |
|-----------|----------|----------|
| **Philosophy** | Minimalist, CLI-first | Local-first + cloud-optional, application platform |
| **Config** | Static `opencode.json` | Dynamic runtime config via `runtime-opencode-config-store` |
| **Process model** | Single process | Subprocess management with Engine Pool |
| **Extensibility** | Plugins, MCP, Skills | All of above + MCP Gateway + Den marketplace |
| **Auth** | None | Better-Auth + organization-level auth |
| **Testing** | No explicit framework | `@openwork/testkit` with spec-driven verification |

---

## 2. DeepSeek Harness + OpenWork Analysis

### 2.1 Clarification: Two Different "DeepSeek Harness" Concepts

There are two distinct things that share the name "DeepSeek Harness":

**A. DeepSeek Harness (Agent Framework)** — `deepseek.com/harness`
- DeepSeek's open-source (MIT) agent harness framework, v0.1 developer preview (August 2026)
- Built on Cordis plugin system: "Everything is a plugin"
- Competitor to OpenWork/OpenCode — it is an alternative agent harness
- Provides: models, tools, skills, sessions, sandboxes, storage, loops, scheduling, UI as plugins
- Four runtime modes: Standard, Code (PTC), Minimal, Creator
- Features: Trajectory view (append-only session log), resume/fork/search/replay
- Directly targets Claude Cowork and Codex

**B. DeepSeek Harness (Evaluation Framework)** — `lm-evaluation-harness`
- Standardized benchmark tool for evaluating LLMs
- Used to assess DeepSeek models on MMLU, GSM8K, HumanEval, etc.
- Not related to the agent framework

This analysis focuses on **A** — the agent framework — in the context of OpenWork.

### 2.2 DeepSeek as a Provider in OpenWork

OpenWork already integrates DeepSeek as a standard LLM provider:

- **Model**: `deepseek/deepseek-v4-flash` in `openwork-models.json`
- **Type mapping**: `OpenWork: DeepSeek V4 Flash` in `packages/types/src/den/inference.ts`
- **UI**: ProviderIcon monogram `"DS"`, domain `deepseek.com`
- **Testing**: `automation-proposal-model-resolution.slow.test.ts` uses `providerId: "deepseek"` and `modelId: "deepseek-v4-flash"`
- **Custom provider docs**: `custom-llm-provider.mdx` shows DeepSeek V3.2 via Infron gateway example

### 2.3 Pros of DeepSeek Integration in OpenWork

| Advantage | Detail |
|-----------|--------|
| **Ultra-low inference cost** | $0.14/M input tokens for V4 Flash; $0.0028/M for cache hits |
| **1M token context window** | 2^20 tokens, the largest among major providers |
| **OpenAI-compatible API** | Works out of the box with OpenWork existing provider infrastructure |
| **Full capability support** | reasoning, tool_call, structured_output all supported |
| **Open weights** | MIT license; can be self-hosted on own infrastructure |
| **MoE architecture** | 1.6T total params, 49B active per token — efficient inference |
| **V4 Pro performance** | Terminal Bench 2.1: 87.9 (vs preview 72.1); DeepSWE: 62.7 (vs 12.8) |
| **No vendor lock-in** | Can switch between API and self-hosted deployment |

### 2.4 Cons of DeepSeek Integration in OpenWork

| Disadvantage | Detail |
|-------------|--------|
| **Limited model catalog** | Only V4 Flash in built-in directory; V4 Pro, R1, V3 require manual custom provider config |
| **No DeepSeek Harness integration** | OpenWork does not integrate DeepSeek Cordis plugin system or DSH CLI |
| **Knowledge cutoff** | Training data knowledge截至 2025-05 |
| **External API dependency** | Relies on DeepSeek API availability; self-hosting requires significant GPU resources |
| **No evaluation harness** | OpenWork has no built-in lm-evaluation-harness or benchmark integration for DeepSeek models |
| **Protocol quirks** | V4 has 16 documented protocol quirks (reasoning_content lifecycle 400s, prefix cache edge cases) |
| **Regional access** | DeepSeek API may have access restrictions in some regions |
| **No MCP server integration** | Unlike OpenWork MCP gateway, DeepSeek Harness has its own MCP server (`@deepseek-harness/mcp`) that does not integrate with OpenWork MCP ecosystem |

### 2.5 DeepSeek Harness (Agent Framework) vs OpenWork — Comparison

| Dimension | DeepSeek Harness | OpenWork |
|-----------|-----------------|----------|
| **Architecture** | Cordis plugin system — everything is a plugin | OpenCode subprocess + HTTP API layer |
| **Plugin model** | Runtime plugin composition via config | Static plugin/MCP config + dynamic runtime mgmt |
| **Traceability** | Append-only session log with trajectory view | No built-in trajectory replay |
| **Runtime modes** | Standard, Code (PTC), Minimal, Creator | Single mode (full toolset) |
| **Model support** | Model-agnostic (DeepSeek, Anthropic, OpenAI, custom) | 50+ providers via OpenCode SDK |
| **UI** | Web UI via `dsh web` | Electron desktop app + Web UI |
| **MCP** | Built-in MCP server (`@deepseek-harness/mcp`) | Unified MCP gateway + org-level MCP management |
| **Enterprise** | No built-in org/team management | Den control plane with teams, policies, access control |
| **Self-hosting** | Possible (self-host API) | Designed for self-hosting (local-first) |
| **Maturity** | v0.1 developer preview (Aug 2026) | Production-ready (current release) |
| **Ecosystem** | New, growing plugin ecosystem | Established plugin/MCP/skill marketplace |
| **Evaluation** | No built-in benchmark harness | Testkit-driven verification |

### 2.6 Strategic Considerations

**Synergies** (if OpenWork were to integrate DeepSeek Harness):
- Cordis plugin system could complement OpenWork plugin architecture
- DeepSeek trajectory/traceability features could enhance OpenWork session management
- DSH Creator mode could inspire OpenWork plugin development workflow

**Conflicts** (why they remain separate):
- OpenWork already has its own plugin/MCP ecosystem
- DeepSeek Harness is a direct competitor (both target Claude Cowork/Codex users)
- Different technical foundations (Cordis vs OpenCode)
- DeepSeek Harness is too new (v0.1) to integrate into a production platform

**Recommendation**: Use DeepSeek as a model provider within OpenWork (already supported), but treat DeepSeek Harness as a separate competitive product to monitor. No immediate integration needed.

---

## 3. Sources

- OpenWork repo: `/Users/yason/Documents/trae_projects/openwork`
- OpenWork AGENTS.md: workspace rules and architecture documentation
- DeepSeek Harness: https://deepseek.com/harness/
- DeepSeek Harness GitHub: https://github.com/deepseek-ai/deepseek-harness
- Cordis kernel: https://github.com/cordiverse/cordis
- web-harness/openwork (unrelated fork): https://github.com/web-harness/openwork
- OpenWork models config: `ee/apps/inference/src/models/openwork-models.json`
- OpenWork inference types: `packages/types/src/den/inference.ts`
