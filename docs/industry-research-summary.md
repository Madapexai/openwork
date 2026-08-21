# 业界调研报告汇总

调研时间：2026-08-18。覆盖 Claude Code、WorkBuddy Bluebook、Cursor、Devin、Continue、Cline、Aider、OpenHands、SSO/SCIM 业界最佳实践、CLI agent relay/SSH/云端上下文。

## 1. Claude Code 实现机制要点

### Subagent + Task tool
- 定义文件 `.claude/agents/*.md`，frontmatter 字段：`name`/`description`/`tools`/`model`/`permissionMode`/`mcpServers`/`hooks`/`maxTurns`/`skills`/`memory`/`background`/`isolation: worktree`/`effort`/`color`/`initialPrompt`
- 作用域优先级：Managed > CLI flag > Project `.claude/agents/` > User `~/.claude/agents/` > Plugin > built-in
- **硬限制：subagent 不能再 spawn subagent**（避免无限递归）
- `bypassPermissions` 强制继承，子 agent 不可覆盖
- Plugin subagents 不支持 `hooks`/`mcpServers`/`permissionMode`（安全边界）

### Plan/Act 模式
- Plan Mode = prompt 注入 + 状态机 + `Edit` tool 写 `.claude/plans/*.md`
- `opusplan` alias：Plan 阶段 Opus，Act 阶段 Sonnet（cost-aware）
- `Shift+Tab` 循环 default -> acceptEdits -> plan

### 5 种 Permission Mode
`default` / `acceptEdits`（仅文件系统）/ `plan`（只读）/ `dontAsk`（白名单）/ `bypassPermissions`（容器）
- 评估顺序：Hooks -> Rules (deny>allow>ask) -> Mode -> canUseTool callback
- `acceptEdits` 精确边界：放文件系统不放 Bash
- `disableBypassPermissionsMode` managed setting 禁用 bypass

### Plugin/Marketplace
- `.claude-plugin/plugin.json` + 9 种组件（skills/agents/hooks/MCP/LSP/monitors/themes/channels/settings）
- 两层 manifest：`marketplace.json`（catalog，含 version）+ `plugin.json`（identity，不含 version）
- 五种来源：子目录、GitHub owner/repo、Git URL、Git 子目录、npm
- `settings.json` 的 `agent` key 可激活主 agent
- trust 仓库后自动安装 markets & plugins

### MCP 集成
- 三层作用域：Project `.mcp.json` > Local > User > Plugin > Managed（独占）
- 环境变量 `$VAR` 自动展开
- MCP Tool Search 按需加载
- `workspace` 是保留名
- Channels：MCP server 可 push 消息到 session

### 模型选择
- Provider 视角（Anthropic/Bedrock/Vertex/兼容网关）+ Models 视角（alias：sonnet/opus/haiku/fable/best/opusplan）
- `ANTHROPIC_DEFAULT_*_MODEL` env 覆盖 alias 解析
- `CLAUDE_CODE_SUBAGENT_MODEL` subagent 单独模型
- Effort levels：low/medium/high/xhigh/max
- `/fast` 模式不降级仅加速
- Prompt caching 可分模型禁用

## 2. WorkBuddy Bluebook 设计要点

### Ch3 三模式（Ask/Craft/Plan）
- Ask 问一问（只读）、Craft 做一做（每步停）、Plan 想一想（计划书先确认）
- 工作目录隔离 = 安全边界
- 模型自动 vs 显式：长文本看上下文长度、图片看视觉、高频简单看速度成本

### Ch6 专家团
- 专家 = 人设 + 方法论 + 工具链；专家团 = 团长自动拆解 + 并行 + 整合
- 用户只描述任务，不挑团员、不拆任务
- Skill=能力；专家=能力+经验；专家团=多位专家+协作流程

### Ch10/Ch25 自动化
- 5 要素：触发时间 + 可重复输入 + 具体 Prompt + 受控工作目录 + 验收条件
- 上线前 3 门槛：手动跑过 ≥3 次；触发/输入/验收清楚；有 owner/告警/停用方法
- 9 态状态机 + 降级交付 4 级（full/partial/minimal/blocked）
- 质量门禁 4 维：相关性/时效性/重复性/最低数量
- 可行动告警 7 字段：batch_id/status/trigger_time/failure_reason/completed_steps/impact/suggested_actions
- 断点续跑：`completed_steps` + `source_status` + `item_count` + `last_error`
- 重试：超时 1 次；429 按 Retry-After；401/403 转人工

### Ch22 Skill 三重验证
- 六阶段蒸馏：整书理解 -> 五 Agent 并行提取 -> 三重验证 -> 构造 Skill -> 链接 -> 压力测试
- 三重验证：跨域验证（≥2 场景）/ 预测力（推导未讨论问题）/ 独特性（非常识）
- 诱饵测试：不该触发的场景能忍住不激活
- Skill 关系：dependency / contrast / composition

### Ch24 多 Agent 系统
- 6 维差别：上下文/分工/工具/质量/成本/风险
- 拆分 6 条：≥2 子任务独立 / 不同方法资料工具 / 可定义交接格式 / 并行显著 / 有总负责人 / 预算允许
- **角色契约**：输入/输出/禁止动作（forbidden_actions）
- **共享产物层**：角色不通过对话传递关键内容，下游只读上游 confirmed 产物
- 主理人职责：拆解/分发/等待/重试/拍板/合成
- 3 个必须由人确认的点：Brief/分镜/BGM
- 失败传播：降级交付必须说明缺失，不伪装完整

### OpenWork team-autonomy 差距
| Ch | 落地度 | 关键差距 |
|---|---|---|
| Ch3 | ✅ | per-task sandbox 强制；模型自动分配 |
| Ch6 | 🟡 | 专家团模板产品化；Role Override 段 |
| Ch10/25 | ✅ | runHandler 业务逻辑空；delivery handler 未注册 |
| Ch22 | ✅ | 蒸馏 SOP 没产品化；SkillTestExecutor 未绑 sidecar |
| Ch24 | ✅ | 3 阶段确认点没建模；expected_output 侧；下游读 confirmed 校验 |
| 主理人 | 🟡 | member 驱动非 agent 驱动，无 orchestrator-service |
| 角色自动选择/harness 路由/模型自动分配 | ❌ | routeTask/engine hook/model picker 三个函数都缺 |

## 3. Cursor/Devin/Continue/Cline/Aider/OpenHands 要点

### Cursor 2.0
- Composer 统一 Ask/Edit/Agent 三模式
- 单 prompt 起 8 个并行 agent，每个独立 git worktree 或远端 VM
- Rules 四层：Project `.cursor/rules/*.mdc` > User > Team > AGENTS.md
- Skills 动态上下文（按需加载）vs Rules（always-on）
- Background Plan Mode：plan 用模型 A、act 用模型 B
- MCP Marketplace：cursor.com/marketplace
- 沙箱终端：未白名单命令跑沙箱
- Team Commands：dashboard 集中下发

### Devin
- 完全云托管 microVM（shell + IDE + browser）
- Managed Devins：coordinator Devin spawn 最多 10 worker Devin，每个独立 VM/context/focus
- coordinator 职责：scoped 分派/监控/ACU 配额/sleep/terminate/发消息/自提醒
- ACP over stdio + SSH 天然可转发（跨机等价本地）
- Interactive Planning：执行前出 step-by-step 计划供 review
- Knowledge/Playbook/Skills 三层（org 持久/web 维护/repo 版本化）
- `/handoff` CLI -> 云端续跑
- Scheduled Sessions + Devin Review Auto-Fix
- ACU 计费 $2.25/ACU

### Continue
- `config.yaml`：agent = models + rules + tools (MCP)
- Role-based 模型路由：chat/edit/apply/embed/rerank/summarize
- System Message Tools：任意模型都能用工具（不依赖原生 tool-calling）
- Continue Hub：团队级共享
- Apache 2.0 + BYOK

### Cline
- `.clinerules` 强制开发协议四阶段：Plan/Act/Test/Complete
- Plan & Act 双模式 toggle + 双模型分离（Plan=强推理、Act=快执行）
- `/deep-planning` slash
- MCP Marketplace（社区版）：一键 clone+build+config
- Enterprise 四挡：`mcpMarketplaceEnabled`/`allowedMCPServers`/推送 remoteMCPServers/`blockPersonalRemoteMCPServers`
- Memory Bank + Context Management

### Aider
- Architect 模式：`--architect --model opus --editor-model sonnet`，net cost 省 20-40%
- `--yes-always` + `--auto-commits` + `--auto-lint` + `--auto-test` + retry-on-fail 闭环
- Edit formats：diff/whole/udiff
- Repo map（`map-tokens`）自动构建仓库结构
- `.aider.conf.yml` + `.aider.env`
- 无原生 subagent，但可作 MCP server（aider-mcp）或 subprocess adapter（@llm-ports/adapter-aider）

### OpenHands
- SDK 十大组件：Conversation/Agent/LLM/Tool System/Workspace/Events/Condenser/MCP/Skills/Security
- Skills 三类：Knowledge（关键词触发）/Repository（`.agents/skills/repo.md` 自动加载）/Task
- TaskToolSet：parent 调 `task(prompt, subagent_type)`，TaskManager 创建/恢复 sub-agent conversation
- File-Based Agents：`.md` + YAML frontmatter，project + user 目录扫描去重
- DelegationManager：spawn/send/status/close，parent-only 通信纪律
- 双路径持久化：`base_state.json`（覆写）+ `events/event-*.json`（append-only）
- ACP on Cloud：snapshot CLI transcript subtree 到 S3，allowlist 只 `~/.claude/projects/**`/`~/.codex/sessions/**`/`~/.gemini/**`，**绝不** snapshot auth/credentials/history

## 4. SSO/SCIM 自定义 IdP 最佳实践

### SAML SP
- 三方信任通过 metadata 互换
- ACS URL 含 providerId -> 多租户隔离
- SP-initiated 默认；IdP-initiated 加 RelayState 白名单 + tenant binding
- 签名校验：Response + Assertion 双重，SHA-256+，wantAssertionsSigned
- 校验：Issuer/Audience/NotBefore/NotOnOrAfter/InResponseTo/Destination

### OIDC
- Discovery：`{issuer}/.well-known/openid-configuration`，校验 issuer 一致性，不跟随 3xx
- PKCE 强制 S256 + state(CSRF) + nonce(重放)
- Token Exchange RFC 8693：audience 收紧，短 TTL，jti 唯一
- Refresh Token Rotation：每次轮换，重放检测整个 family revoke

### SCIM 2.0
- /Users + /Groups + PATCH + ServiceProviderConfigs
- PATCH 语义：add/remove/replace + path 子选择，ETag 并发
- 分页：startIndex+count 或 cursor
- JML：Joiner POST/Mover PATCH/Suspension active=false/Leaver PATCH active=false 或 DELETE
- Tombstone 防止 SCIM 删除用户被 SSO JIT 复活
- externalId 必须索引

### JIT Provisioning
- 触发：首次 SSO 登录
- 身份匹配：(providerId, issuer, sub) 精确 > 邮箱 > 创建新；绝不降级到邮箱匹配
- Deprovisioned 用户阻断 JIT
- 默认角色最小权限

### 域名验证
- DNS TXT（推荐，QNAME `_<service>._domain.<apex>`）/ HTML meta / 文件上传
- 唯一 token 含服务前缀，TTL 短，验证完可删

### 企业强制 SSO
- Home Realm Discovery：邮箱域名映射 + 专属子域名 + IdP 预选
- 域名验证是强制前提，公共邮箱域名黑名单
- session 与 tenant 强绑定

### Better-Auth sso() 能力边界
- ✅ OIDC/SAML/JIT/Domain verification/SCIM/Org provisioning/签名策略/InResponseTo
- ❌ Self-service SSO（付费企业版，可绕开）
- ❌ `mapProfileToUser`（IdP 不返 email 硬失败，可加占位 email 合成层）
- ❌ `private_key_jwt`（Entra 高合规要求，需 reverse proxy 兜底）

### OpenWork SSO 场景 B 改造优先级
| P | 项 | 工作量 |
|---|---|---|
| P0 | 去 `app.openworklabs.com` 回退 + fail-fast | XS |
| P0 | 桌面端 env 注入 Den base URL | XS |
| P0 | docker-compose 自托管 Den 完整示例 | S |
| P1 | Den Web SSO Connection 自助配置界面 | M |
| P1 | IdP metadata URL 导入向导 | M |
| P1 | 域名验证向导（DNS TXT） | M |
| P2 | trustedOrigins 动态化 | S |
| P2 | `mapProfileToUser` 占位 email 合成 | S |
| P2 | IdP-initiated SAML 收紧 | S |
| P3 | `private_key_jwt` 支持 | M-L |
| P3 | SCIM filter 兼容性测试矩阵 | M |

## 5. CLI agent relay/SSH/云端上下文业界实现

### CLI agent relay 业界模式
- **multica**：Go daemon + PostgreSQL + pgvector，agent 当 teammate，issue 分发，WebSocket 流式
- **cc-connect**：Go daemon + 多 IM 适配器，session 本地持久化（codex projects/claude projects jsonl）
- **Orca**：二分 handoff -- full handoff（所有权转移）vs supervised orchestration（coordinator + DAG + worker_done/escalation + decision gates）
- **Paperclip**：adapter 抽象（claude_local/codex_local/gemini_local/http/process/sandbox），engine: auto(acp 优先)/acp/cli，stateDir 让平台托管 ACP session-state
- **telephone**：markdown scratchpad 共享记忆，`/telephone relay codex,gemini` 多 agent relay
- **ContextRelay**：本地 loopback，append-only JSONL ledger，structured handoffs，`on_busy: queue|steer|reject`，coordinator 独占 git write
- **cc-team**：Claude Code 原生 team 协议，Context Relay 刷新 Team Lead 上下文
- **claude-codex-relay**：Hook 驱动 PostToolUse 桥，Claude 写 brief、Codex 后台 exec、asyncRewake 唤醒 Claude review
- **claude-session-handoff**：12-section prompt + 6-step pipeline + 3 层 context manifest（auto-load/mandatory/on-demand）

### SSH 远程执行
- `authorized_keys` `command="...",restrict,no-pty,no-X11-forwarding,no-agent-forwarding`
- `ForceCommand` 全局 + Match User/Group
- `-L` 本地转发 / `-R` 远程转发 / `-D` SOCKS / `-J` ProxyJump（比 agent forwarding 安全）
- `ForwardAgent no` 默认，`IdentitiesOnly yes` + `IdentityFile` 限定
- `ssh-agent-guard`（tavisrudd）：祖先进程检测 AI coding agent + 策略 allow/deny/confirm + 拦截 `session-bind@openssh.com`
- mosh：UDP-based，IP roaming，但不支持 port forwarding/agent forwarding
- tmux + systemd user service + linger（pTTY 范式）：进程存活，但**不保护**主机重启

### 云端共享上下文
- Claude Code subagent：`task` stateless，子只看传入 prompt，过程归子、结论归父
- Claude-Full-Context-Agent：plugin + hooks 让 fork 继承父全部 context，brief 从 200-2000 token 缩到 50-200
- 三种 state-passing：JSON 文件 handoff / 环境变量+KV store / Context Bundle（>1000 runs 长跑）
- Sourcegraph Cody 三层：local file -> local repo -> remote repo（via Sourcegraph 索引）+ Context Filters
- Cline：不做 RAG/embeddings，认为现代 LLM 能动态探索
- Augment Code Context Engine：400,000+ 文件语义依赖分析
- MCP context server：多模态存储 + UUIDv7 + thread scoping + pgvector
- OpenHands 双路径：`base_state.json`（覆写）+ `events/event-*.json`（append-only）
- OpenHands ACP on Cloud #1018：snapshot CLI transcript subtree 到 S3，allowlist 只 transcript，**绝不** snapshot auth/credentials/history，resume = session id + opaque files + event log
- session-roam：Syncthing P2P 同步 `~/.claude/projects/`，要求 path 一致
- Omnara：本地 session/codebase/uncommitted 自动同步到云，手机端原生 UX

### context_snapshot 序列化
- Claude Code JSONL：路径 `~/.claude/projects/{sanitized-cwd}/{session-id}.jsonl`，parent-UUID 链，entry types 丰富
- 双写：async queue（100ms coalescing）+ sync direct（退出清理）
- Lazy materialization：第一条消息才创建文件
- LangGraph 反例：默认 `dumpd()` 全 Pydantic metadata，4-turn ReAct 状态 21850 vs 3217 bytes（85.3% 冗余）
- 三种策略：append-only JSONL / 全量 snapshot / 混合
- 序列化内容：trajectory + agent 配置 + 执行状态 + workspace context + skills + secrets(加密) + file-history snapshot + compaction summary

### 跨机 relay 网络拓扑
- Star（中心 hub）：部署简单、单点故障
- Mesh（点对点）：自愈、去中心化、节点上限 ≤200
- Relay server（中转）：穿越 NAT、中继延迟、metadata 暴露
- Hybrid：star 控制面 + mesh/P2P 数据面
- Tailscale 三层路由：Direct（UDP）> Peer relay > DERP（ciphertext-only）
- WorkspaceLinker：`shared session code` 做 E2E 加密 key，relay 只见 ciphertext

### 端到端加密
- Tailscale：Control plane（Noise IK + X25519）+ Data plane（WireGuard ChaCha20-Poly1305），私钥永不离开本地，DERP 无法解密
- WireGuard：UDP-only，1-RTT，但不解决 key 分发/peer discovery/NAT traversal/access control
- TLS：中转终止 TLS 看明文，需 E2E + relay 只转发 ciphertext
- At-rest：envelope encryption + KMS-managed key + per-conversation DEK
- Control/data plane 分离：control 被攻破不泄露 data，data 被拦截没有 control policy

### 业界 team agent + 云端协作产品
- Linear AI：issue tracker 作为 agent 入口，PR 作为 review gate，Copilot for Linear 自动开 draft PR
- Sourcegraph Cody：三层 context + Context Filters + self-hosted/BYOC（合规关键）
- Cursor 2.0 Cloud Agent：云端 Ubuntu VM + clone repo + agent/<task-slug> 分支 + Slack/邮件通知 + self-testing + demos over diffs + remote desktop control
- GitHub Copilot CLI `--remote`：`/resume` + `/delegate`（package context + commit + handoff to GitHub infra + 开 PR）+ remote session URL

### OpenWork 跨机 relay + SSH + 云端上下文改造方案
- **整体架构**：Hybrid star + mesh，Den 控制面（鉴权/目录/policy/session id/marketplace），agent 数据面（WireGuard mesh / NaCl box），Den relay（ciphertext-only）
- **P0**：session JSONL 持久化（Claude Code 格式）+ 跨机 snapshot 到 S3；Den relay（ciphertext-only）+ WireGuard data plane；SSH key ForceCommand + restrict + ssh-agent-guard
- **P1**：ACP adapter 抽象（engine: auto/acp/cli）；devcontainer.json workspace 标准 + Daytona provider；MCP context server（pgvector + thread scoping）；Handoff 二分（full vs supervised）skill 路由
- **P2**：tmux + systemd user service 远端持久化；Codex/Claude CLI transcript snapshot allowlist；Handoff-doc skill（ctx% > 20% 触发）
- **P3**：mosh 移动端接续；Omnara-style 移动端原生 UX；session-roam P2P fallback（无 Den 场景）

### 关键风险与规避
- Cline devcontainer 陷阱：容器重建丢 history -> 显式挂载持久 volume 或 snapshot 外部存储
- LangGraph 85% 存储冗余 -> 紧凑序列化（msgpack/自定义）
- SSH agent forwarding 滥用 -> `ForwardAgent no` 默认、ProxyJump 替代、ssh-agent-guard 拦截
- PVC 不持久 CLI session files -> 显式 snapshot `~/.claude/projects/**` 到 S3
- 中转终止 TLS 看明文 -> DERP 模型，relay 只转发 ciphertext
- tmux server 重启丢 AI context -> session state 序列化到 jsonl + snapshot
- 序列化 secrets 泄露 -> secrets 单独 envelope encryption + KMS，不进 jsonl
- 跨机 path 不一致 -> path sanitization + 用 session-id 而非 path 作为跨机 key

## 6. 业界调研对 5 个功能点的借鉴总结

| OpenWork 功能点 | 最佳借鉴源 | 具体可移植机制 |
|---|---|---|
| **1. CLI agent 模型选择/注入** | Claude Code alias + `opusplan` + Provider/Models 双视角 | 删除 store+UI、openclaw 解禁、All models tab 默认显示；借鉴 Claude Code 的 alias 机制和 `ANTHROPIC_DEFAULT_*_MODEL` env 覆盖 |
| **2. plan/act + relay + SSH + 云端上下文** | Cline Plan/Act toggle + Aider Architect/Editor + Devin Managed Devins + OpenHands delegation + Tailscale DERP + Claude Code JSONL | CLI agent plan/act schema、跨机 relay runtime、SSH ForceCommand、cloud-context store（JSONL + snapshot） |
| **3. SSO 自定义** | Better-Auth sso() + Keycloak/Okta/Entra 模式 + WorkOS 域名验证 | 去硬编码 + Den Web SSO 自助配置向导 + 域名验证 + trustedOrigins 动态化 |
| **4. Team 模式任务自动拆解** | WorkBuddy Ch24 主理人 + Anthropic Orchestrator-Workers + Devin Managed Devins + OpenHands routeTask | LLM orchestrator + task-router + 自动选 agent/模型；主理人 agent 化 |
| **5. 连接器/插件/智能体管理** | Claude Code plugin manifest + Cline MCP Marketplace + Continue Hub + OpenHands File-Based Agents | agent md CRUD UI + Team agent CRUD UI + agent marketplace schema；借鉴 Claude Code 两层 manifest + 五种来源 |

## 7. 关键发现

1. **OpenHands 是最贴近 OpenWork 哲学的范本**：stateless Agent + immutable Conversation + EventLog + Skills 三类 + File-Based Agents，几乎与 OpenWork 的 AGENTS.md/testkit/SKILL.md 同构。
2. **Devin Managed Devins 是 multi-agent team 模式产品化最成熟的**：coordinator 责任清单直接可作 OpenWork Den 多 agent 控制面需求清单。
3. **Cline `.clinerules` 四阶段协议与 OpenWork `prove-a-pr -> write-a-spec -> run-tests -> diagnose-a-red-run -> publish-evidence` 几乎同构**。
4. **Cursor Rules/Skills 双层（always-on vs dynamic）+ Team Rules 集中下发**对应 OpenWork Den + 桌面 skill 分层。
5. **Continue Role-based routing + System Message Tools** 对 OpenWork "50+ provider 模型无关"承诺极有参考。
6. **Aider Architect/Editor 双模型 + `--yes-always` 批处理 + Edit-Test-Commit 自动循环**是最轻量的 plan/act + 自动化范本。
7. **Devin ACP over stdio + SSH 强制命令 bridge** 提供低成本远端 runtime 集成范式。
8. **Claude Code JSONL + OpenHands ACP on Cloud #1018** 是跨机 session 持久化的黄金标准。
9. **Tailscale DERP** 是端到端加密中转的黄金标准。
10. **Orca handoff 二分** 应显式进入 OpenWork skill 路由。
11. **Paperclip adapter 抽象 + ACP 优先 + CLI fallback** 是多 CLI agent 管理的成熟范式。
12. **Cody 三层 context + Context Filters** 是企业级跨 repo context 范本。
13. **devcontainer.json 是 workspace 定义事实标准**，OpenWork 应 align 而非另起炉灶。
14. **SSH 隧道解决传输、tmux 解决进程存活，但都不解决 session state 持久化**--后者必须靠序列化到外部存储。
15. **避免 LangGraph 的 85% 序列化冗余**：紧凑序列化是必须。

## 8. Sources

- Claude Code: https://code.claude.com/docs/en/sub-agents, /mcp, /plugins, /permission-modes, /skills, /agent-teams, /worktrees
- WorkBuddy Bluebook: https://www.crazyowen.cn/workbuddy/bluebook.html (Ch3/6/10/22/24/25)
- Anthropic: https://www.anthropic.com/engineering/building-effective-agents, /multi-agent-research-system, /effective-harnesses-for-long-running-agents, /research/trustworthy-agents
- Cursor: https://cursor.com/marketplace
- Devin: https://docs.devin.ai
- Continue: https://www.continue.dev/docs
- Cline: https://docs.cline.bot
- Aider: https://aider.chat/docs
- OpenHands: https://docs.all-hands.dev/usage/sdk-intro
- Better-Auth sso: https://better-auth.com/docs/beta/plugins/sso
- RFC 8693 (Token Exchange), RFC 9700 (OAuth 2.0 Security), RFC 7644 (SCIM)
- Tailscale: https://tailscale.com/security/encryption
- Daytona: https://www.daytona.io
- OpenHands ACP on Cloud #1018: https://github.com/All-ands-AI/OpenHands/issues/1018
