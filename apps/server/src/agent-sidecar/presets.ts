/**
 * AGENT_PRESETS - 全量 CLI agent 预设配置
 *
 * 覆盖来源（基于 OpenWork + Multica + Orca + cc-connect + LobeHub + Web 调研综合）：
 *
 * ACP 集群 (14):   opencode, kimi, traecli, goose, openclaw, hermes, pi,
 *                  qodercli, kiro-cli, antigravity, openclaude, codex-acp,
 *                  continue-acp, openhands-acp
 * HTTP 集群 (5):    opencode-serve, devika, tabby, letta, continue-server
 * PTY 集群 (40+):   claude-code, codex, cursor-agent, gemini, copilot, amp, cline,
 *                  codebuff, continue, droid, kilocode, mistral-vibe, qwen-code,
 *                  rovo-dev, auggie, command-code, autohand, crush, mimo, devin,
 *                  goose-pty, aider, plandex, gptme, gpt-pilot, mentat,
 *                  gpt-engineer, smol-developer, openhands, chatdev, swe-agent,
 *                  auto-code-rover, amazon-q, github-copilot-cli, cody,
 *                  tongyi-lingma, baidu-comate, tencent-codebuddy, codegeex,
 *                  pr-agent, open-code-review, cr-gpt, autodev, repomix, bloop,
 *                  dify-cli, shell-genie
 * MCP 集群 (1):     code-review-graph
 * Generic 集群:    bash, http-webhook
 *
 * 总计：60+ agent preset，覆盖主流 CLI code agent。
 *
 * 每个 preset 都包含：
 * - binary: PATH 上的可执行名
 * - protocol: acp | http | pty | mcp | generic
 * - args: 启动参数（特别是 acp 子命令）
 * - capabilities: 能力声明
 *
 * 添加新 agent 只需在此文件加一行 preset。
 */

import type { AgentSidecarConfig, SidecarCapabilities, SidecarProtocol } from "./types.js";

/** ACP agent 默认能力 */
const ACP_DEFAULT_CAPS: SidecarCapabilities = {
  streaming: true,
  permissions: true,
  multiSession: true,
  modelSwitch: true,
  imageInput: true,
  embeddedContext: true,
  mcpClient: true,
  documentSync: true,
};

/** PTY agent 默认能力 */
const PTY_DEFAULT_CAPS: SidecarCapabilities = {
  streaming: true,
  permissions: false,
  multiSession: false,
  modelSwitch: true,
};

/**
 * 协议优先级：用户未指定 protocol 时，按此顺序尝试匹配 preset。
 *   acp (L3 长连接 + 多会话 + 单进程复用)
 *   > http (L2 服务端长连接)
 *   > headless-oneshot (PTY headless 一次性短进程，用完自动 exit，无泄漏)
 *   > pty (L1 伪终端兜底，必须走 process pool)
 */
export const DEFAULT_PROTOCOL_PREFERENCE: Array<SidecarProtocol | "headless-oneshot"> = [
  "acp",
  "http",
  "headless-oneshot",
  "pty",
];

/** 执行模式：PTY 层如何 spawn 进程 */
export type PtyExecutionMode =
  /** 一次性短进程：带 prompt/args spawn，输出结束进程自动 exit，无泄漏。对 headless 友好 */
  | "headless-oneshot"
  /** 常驻伪终端：进程一直挂着，通过 stdin 反复写 prompt。需要 process pool 防泄漏 */
  | "persistent-pty";

/** Agent preset 定义 */
export interface AgentPreset extends AgentSidecarConfig {
  /** 显示名 */
  label: string;
  /** Agent 厂商/来源 */
  vendor?: string;
  /** Agent 官网 */
  homepage?: string;
  /** 安装说明 */
  installHint?: string;
  /**
   * 协议优先级覆盖（用户 override）。
   * 为空时使用 DEFAULT_PROTOCOL_PREFERENCE。
   */
  preferProtocolOrder?: Array<SidecarProtocol | "headless-oneshot">;
  /**
   * 备选协议候选：同一个 binary 支持多种启动方式时，把降级路径都列出来。
   * 例如 claude-code：[acp(如未来支持), headless-oneshot（-p --stream-json）, pty]
   * registry.selectPresetForAgent() 按 preferProtocolOrder 从主 preset + altPresets 里挑第一个可匹配的。
   */
  altPresets?: Array<Partial<AgentPreset> & Pick<AgentPreset, "protocol">>;
  /**
   * PTY 执行模式：
   *   - 对 cliProfile.headless === true 的，默认 "headless-oneshot"（最安全，用完释放）
   *   - 其他交互式 PTY 走 "persistent-pty"（必须 process pool 限制并发）
   */
  executionMode?: PtyExecutionMode;
  /**
   * CLI 内置默认模型（与 opencode 的模型选择无关）。
   * 例如 kimi 的 config.toml default_model = "kimi-code/k3"。
   * 注入 agent 列表时透传给 UI：选中该 CLI agent 后，模型选择器应显示此模型而非 opencode 的全局模型。
   */
  defaultModel?: { providerID: string; modelID: string };
  /**
   * 运行时模型发现配置
   *
   * 各 CLI agent 列出可用模型的方式不同：
   * - kimi: `kimi models --json` 或读取 ~/.kimi-code/config.toml
   * - claude: `claude --list-models` 或读取 ~/.claude/settings.json
   * - codex: `codex models list --json` 或读取 config
   *
   * 通过此配置让 runtime discovery 按需 spawn 短进程获取模型列表。
   */
  modelDiscovery?: {
    /** CLI 子命令：如 ["models", "--json"]、["--list-models"] */
    command?: string[];
    /** 解析后每个模型的 providerID 映射（用于统一命名） */
    providerMap?: Record<string, string>;
    /** 配置文件路径模板（用 ${HOME} 占位），用于 fallback 读取 */
    configPaths?: string[];
    /** 超时毫秒数（默认 10_000） */
    timeoutMs?: number;
  };
  /** Whether this CLI agent has plan/act paired execution built-in. */
  planAct?: boolean;
  /** Whether this CLI agent supports relay/pipeline mode. */
  relay?: boolean;
  /** Agent-level goal capability (if absent, inherit from capabilities). */
  goal?: boolean;
}

/**
 * 全量 agent preset 注册表
 *
 * Key = agentId（用户在 OPENWORK_AGENT_ID 环境变量或配置中指定）
 */
export const AGENT_PRESETS: Record<string, AgentPreset> = {
  // ============================================================
  // 集群 A: ACP 协议 (Agent Client Protocol)
  // ============================================================

  opencode: {
    agentId: "opencode",
    label: "OpenCode",
    vendor: "different-ai",
    homepage: "https://opencode.ai",
    protocol: "acp",
    binary: "opencode",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
    installHint: "npm install -g opencode-ai",
    // OpenCode 支持 HTTP server / ACP stdio，优先 HTTP (server 单例 + 多会话)，次选 ACP stdio
    preferProtocolOrder: ["http", "acp", "headless-oneshot", "pty"],
    altPresets: [
      {
        protocol: "http",
        binary: "opencode",
        args: ["serve", "--cors", "*", "--hostname", "127.0.0.1"],
        capabilities: {
          ...ACP_DEFAULT_CAPS,
          costTracking: true,
          worktree: true,
        },
      },
    ],
  },

  kimi: {
    agentId: "kimi",
    label: "Kimi Code",
    vendor: "moonshot",
    homepage: "https://kimi.com/code",
    protocol: "acp",
    binary: "kimi",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
    cliProfile: {
      // L3 ACP（kimi acp）优先；headless -p 模式实测可用（2026-08-12）
      headless: true,
      headlessArgs: ["-p"],
    },
    installHint: "curl -fsSL https://kimi.com/code/install.sh | bash",
    // kimi CLI 内置默认模型（config.toml default_model），与 opencode 模型选择无关
    defaultModel: { providerID: "kimi", modelID: "kimi-code/k3" },
    modelDiscovery: {
      command: ["models", "--json"],
      configPaths: ["${HOME}/.kimi-code/config.toml"],
      timeoutMs: 10_000,
    },
    // 优先 ACP；ACP 因认证/启动失败时自动降级 headless-oneshot（kimi -p）→ PTY
    preferProtocolOrder: ["acp", "headless-oneshot", "pty"],
    altPresets: [
      {
        protocol: "pty",
        executionMode: "headless-oneshot",
        cliProfile: { headless: true, headlessArgs: ["-p"] },
      },
      {
        protocol: "pty",
        executionMode: "persistent-pty",
      },
    ],
  },

  traecli: {
    agentId: "traecli",
    label: "Trae CLI",
    vendor: "bytedance",
    homepage: "https://docs.trae.cn/cli",
    protocol: "acp",
    binary: "traecli",
    args: ["acp", "serve"],
    capabilities: ACP_DEFAULT_CAPS,
    installHint: "下载 Trae CLI: https://docs.trae.cn/cli",
    preferProtocolOrder: ["acp", "headless-oneshot", "pty"],
  },

  goose: {
    agentId: "goose",
    label: "Goose",
    vendor: "block",
    homepage: "https://block.github.io/goose/",
    protocol: "acp",
    binary: "goose",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
    installHint: "curl -fsSL https://github.com/block/goose/releases/latest/download/goose-installer.sh | bash",
    preferProtocolOrder: ["acp", "headless-oneshot", "pty"],
    altPresets: [
      {
        protocol: "pty",
        executionMode: "persistent-pty",
        args: [],
      },
    ],
  },

  openclaw: {
    agentId: "openclaw",
    label: "OpenClaw",
    vendor: "openclaw-community",
    homepage: "https://github.com/openclaw/openclaw",
    protocol: "acp",
    binary: "openclaw",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
    installHint: "openclaw 是 pnpm workspace 项目，npm install -g 会缺 dist/entry.mjs。请用: git clone https://github.com/openclaw/openclaw && pnpm install && pnpm build && pnpm start",
    disabled: true,
  },

  hermes: {
    agentId: "hermes",
    label: "Hermes Agent",
    vendor: "nous-research",
    homepage: "https://hermes-agent.nousresearch.com",
    protocol: "acp",
    binary: "hermes",
    args: ["acp", "--accept-hooks", "--yes"],
    capabilities: ACP_DEFAULT_CAPS,
    env: { TERM: "dumb" },
    startupTimeoutMs: 15000,
    installHint: "pip install hermes-agent",
    preferProtocolOrder: ["acp", "headless-oneshot", "pty"],
    executionMode: "persistent-pty",
    cliProfile: { headless: false },
  },

  pi: {
    agentId: "pi",
    label: "Pi",
    vendor: "pi.dev",
    homepage: "https://pi.dev",
    protocol: "acp",
    binary: "pi",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
    installHint: "下载 Pi: https://pi.dev",
  },

  qodercli: {
    agentId: "qodercli",
    label: "Qoder CLI",
    vendor: "alibaba",
    homepage: "https://qoder.com",
    protocol: "acp",
    binary: "qodercli",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
  },

  "kiro-cli": {
    agentId: "kiro-cli",
    label: "Kiro CLI",
    vendor: "aws",
    homepage: "https://kiro.dev",
    protocol: "acp",
    binary: "kiro-cli",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
  },

  antigravity: {
    agentId: "antigravity",
    label: "Antigravity",
    vendor: "google",
    homepage: "https://antigravity.google",
    protocol: "acp",
    binary: "antigravity",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
  },

  openclaude: {
    agentId: "openclaude",
    label: "OpenClaude",
    vendor: "openclaude-community",
    homepage: "https://openclaude.gitlawb.com",
    protocol: "acp",
    binary: "openclaude",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
  },

  "codex-acp": {
    agentId: "codex-acp",
    label: "Codex (ACP)",
    vendor: "openai",
    homepage: "https://github.com/openai/codex",
    protocol: "acp",
    binary: "codex",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
    installHint: "codex acp 要求 TTY（拒绝 pipe stdio）。请改用 agentId=codex，会自动切到 codex exec-server HTTP 长连接或 codex exec headless 模式。",
    disabled: true,
  },

  "continue-acp": {
    agentId: "continue-acp",
    label: "Continue (ACP)",
    vendor: "continue-dev",
    homepage: "https://continue.dev",
    protocol: "acp",
    binary: "continue",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
  },

  "openhands-acp": {
    agentId: "openhands-acp",
    label: "OpenHands (ACP)",
    vendor: "all-hands-ai",
    homepage: "https://github.com/All-Hands-AI/OpenHands",
    protocol: "acp",
    binary: "openhands",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
    installHint: "pip install openhands-ai",
  },

  // ============================================================
  // 集群 B: HTTP 协议（复用现有 managed-opencode.ts）
  // ============================================================

  "opencode-serve": {
    agentId: "opencode-serve",
    label: "OpenCode (HTTP serve)",
    vendor: "different-ai",
    homepage: "https://opencode.ai",
    protocol: "http",
    binary: "opencode",
    args: ["serve", "--cors", "*"],
    capabilities: {
      streaming: true,
      multiSession: true,
      modelSwitch: true,
      permissions: true,
      mcpClient: true,
      embeddedContext: true,
      imageInput: true,
      costTracking: true,
    },
    installHint: "npm install -g opencode-ai",
  },

  devika: {
    agentId: "devika",
    label: "Devika",
    vendor: "stition-ai",
    homepage: "https://github.com/stitionai/devika",
    protocol: "http",
    binary: "python",
    args: ["devika.py"],
    capabilities: {
      streaming: false,
      multiSession: false,
      modelSwitch: true,
    },
    installHint: "git clone https://github.com/stitionai/devika && pip install -r requirements.txt",
  },

  tabby: {
    agentId: "tabby",
    label: "Tabby",
    vendor: "tabbyml",
    homepage: "https://github.com/TabbyML/tabby",
    protocol: "http",
    binary: "tabby",
    args: ["serve"],
    capabilities: {
      streaming: false,
      multiSession: true,
      modelSwitch: true,
    },
    installHint: "Tabby 的 CLI 是 shell 包装脚本，需通过 Docker 启动: docker run --gpus all -p 8080:8080 tabbyml/tabby serve --device metal",
    disabled: true,
  },

  letta: {
    agentId: "letta",
    label: "Letta (MemGPT)",
    vendor: "letta-ai",
    homepage: "https://github.com/letta-ai/letta",
    protocol: "http",
    binary: "letta",
    args: ["run"],
    capabilities: {
      streaming: true,
      multiSession: true,
      permissions: false,
    },
    installHint: "pip install letta",
  },

  "continue-server": {
    agentId: "continue-server",
    label: "Continue (HTTP server)",
    vendor: "continue-dev",
    homepage: "https://continue.dev",
    protocol: "http",
    binary: "continue",
    args: ["server"],
    capabilities: {
      streaming: true,
      multiSession: true,
      modelSwitch: true,
      mcpClient: true,
    },
    installHint: "npm install -g @continue-dev/cli",
  },

  // ============================================================
  // 集群 C: PTY 协议（直接 spawn，解析 ANSI 输出）
  // ============================================================

  "claude-code": {
    agentId: "claude-code",
    label: "Claude Code",
    vendor: "anthropic",
    homepage: "https://docs.anthropic.com/claude/docs/claude-code",
    protocol: "pty",
    binary: "claude",
    args: ["-p"],
    capabilities: { ...PTY_DEFAULT_CAPS, permissions: true },
    cliProfile: {
      headless: true,
      headlessArgs: ["-p", "--output-format", "stream-json"],
      outputFormats: ["stream-json", "json"],
    },
    installHint: "npm install -g @anthropic-ai/claude-code",
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
    // Claude Code 默认模型（官方默认 Claude Sonnet 4）
    defaultModel: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    modelDiscovery: {
      command: ["--list-models"],
      configPaths: ["${HOME}/.claude/settings.json"],
      timeoutMs: 15_000,
    },
  },

  codex: {
    agentId: "codex",
    label: "Codex",
    vendor: "openai",
    homepage: "https://github.com/openai/codex",
    protocol: "pty",
    binary: "codex",
    args: [],
    capabilities: { ...PTY_DEFAULT_CAPS, goal: true },
    env: { TERM: "xterm-256color" },
    cliProfile: {
      headless: true,
      headlessArgs: ["exec", "--json"],
      outputFormats: ["json"],
    },
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
    // Codex CLI 默认模型
    defaultModel: { providerID: "openai", modelID: "gpt-5-codex" },
    modelDiscovery: {
      command: ["models", "list", "--json"],
      configPaths: ["${HOME}/.codex/config.yaml"],
      timeoutMs: 10_000,
    },
  },

  "codex-goal": {
    agentId: "codex-goal",
    label: "Codex (Goal-Driven)",
    vendor: "openai",
    homepage: "https://github.com/openai/codex",
    protocol: "pty",
    binary: "codex",
    args: [],
    capabilities: { ...PTY_DEFAULT_CAPS, goal: true },
    env: { TERM: "xterm-256color" },
    cliProfile: {
      headless: true,
      headlessArgs: ["exec", "--json"],
      outputFormats: ["json"],
    },
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
    goal: true,
    // Codex CLI 默认模型
    defaultModel: { providerID: "openai", modelID: "gpt-5-codex" },
    modelDiscovery: {
      command: ["models", "list", "--json"],
      configPaths: ["${HOME}/.codex/config.yaml"],
      timeoutMs: 10_000,
    },
  },

  "cursor-agent": {
    agentId: "cursor-agent",
    label: "Cursor Agent",
    vendor: "cursor",
    homepage: "https://cursor.com/cli",
    protocol: "pty",
    binary: "cursor-agent",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    cliProfile: {
      // headless -p 官方文档未稳定验证，暂按交互式兜底（L1 PTY）
      headless: false,
    },
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "persistent-pty",
  },

  gemini: {
    agentId: "gemini",
    label: "Gemini CLI",
    vendor: "google",
    homepage: "https://github.com/google-gemini/gemini-cli",
    protocol: "pty",
    binary: "gemini",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    cliProfile: {
      headless: true,
      headlessArgs: ["-p", "--output-format", "stream-json"],
      outputFormats: ["stream-json", "json"],
    },
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
  },

  copilot: {
    agentId: "copilot",
    label: "GitHub Copilot CLI",
    vendor: "github",
    homepage: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
    protocol: "pty",
    binary: "copilot",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
  },

  amp: {
    agentId: "amp",
    label: "Amp",
    vendor: "sourcegraph",
    homepage: "https://ampcode.com",
    protocol: "pty",
    binary: "amp",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
  },

  cline: {
    agentId: "cline",
    label: "Cline",
    vendor: "cline",
    homepage: "https://cline.bot",
    protocol: "pty",
    binary: "cline",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "npm install -g cline（需 darwin-arm64 二进制，Rosetta x86_64 环境会缺 @cline/cli-darwin-x64）",
    cliProfile: { headless: false },
    executionMode: "persistent-pty",
    preferProtocolOrder: ["pty"],
    disabled: true,
  },

  codebuff: {
    agentId: "codebuff",
    label: "Codebuff",
    vendor: "codebuff",
    homepage: "https://codebuff.com",
    protocol: "pty",
    binary: "codebuff",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
  },

  freebuff: {
    agentId: "freebuff",
    label: "Freebuff",
    vendor: "freebuff",
    homepage: "https://www.npmjs.com/package/freebuff",
    protocol: "pty",
    binary: "freebuff",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    cliProfile: {
      // 免费 Claude Code 替代，交互式终端为主；headless 未验证 → fail-fast（L1 PTY 兜底）
      headless: false,
    },
    installHint: "npm install -g freebuff",
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "persistent-pty", // 必须进 process pool，防爆进程
  },

  continue: {
    agentId: "continue",
    label: "Continue",
    vendor: "continue-dev",
    homepage: "https://continue.dev",
    protocol: "pty",
    binary: "continue",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    // Continue 同时有 HTTP server 版和 ACP 版，优先用 server（单例长连接，无进程反复创建）
    preferProtocolOrder: ["http", "acp", "pty"],
    executionMode: "persistent-pty",
    altPresets: [
      {
        protocol: "http",
        binary: "continue",
        args: ["server"],
        capabilities: {
          streaming: true,
          multiSession: true,
          modelSwitch: true,
          mcpClient: true,
        },
      },
      {
        protocol: "acp",
        binary: "continue",
        args: ["acp"],
        capabilities: ACP_DEFAULT_CAPS,
      },
    ],
  },

  droid: {
    agentId: "droid",
    label: "Droid",
    vendor: "factory",
    homepage: "https://factory.ai",
    protocol: "pty",
    binary: "droid",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
  },

  kilocode: {
    agentId: "kilocode",
    label: "Kilocode",
    vendor: "kilo",
    homepage: "https://kilo.ai",
    protocol: "pty",
    binary: "kilocode",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
  },

  "mistral-vibe": {
    agentId: "mistral-vibe",
    label: "Mistral Vibe",
    vendor: "mistral",
    homepage: "https://github.com/mistralai/mistral-vibe",
    protocol: "pty",
    binary: "mistral-vibe",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
  },

  "qwen-code": {
    agentId: "qwen-code",
    label: "Qwen Code",
    vendor: "alibaba",
    homepage: "https://github.com/QwenLM/qwen-code",
    protocol: "pty",
    binary: "qwen-code",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    cliProfile: {
      headless: true,
      headlessArgs: ["-p"],
      outputFormats: ["ansi"],
    },
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
  },

  "rovo-dev": {
    agentId: "rovo-dev",
    label: "Rovo Dev",
    vendor: "atlassian",
    homepage: "https://atlassian.com/rovo",
    protocol: "pty",
    binary: "rovo-dev",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    executionMode: "persistent-pty",
  },

  auggie: {
    agentId: "auggie",
    label: "Auggie",
    vendor: "augmentcode",
    homepage: "https://augmentcode.com",
    protocol: "pty",
    binary: "auggie",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    executionMode: "persistent-pty",
  },

  "command-code": {
    agentId: "command-code",
    label: "Command Code",
    vendor: "commandcode",
    homepage: "https://commandcode.ai",
    protocol: "pty",
    binary: "command-code",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    executionMode: "persistent-pty",
  },

  autohand: {
    agentId: "autohand",
    label: "Autohand Code",
    vendor: "autohand",
    homepage: "https://autohand.ai",
    protocol: "pty",
    binary: "autohand",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    executionMode: "persistent-pty",
  },

  crush: {
    agentId: "crush",
    label: "Charm Crush",
    vendor: "charmbracelet",
    homepage: "https://github.com/charmbracelet/crush",
    protocol: "pty",
    binary: "crush",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    executionMode: "persistent-pty",
  },

  mimo: {
    agentId: "mimo",
    label: "MiMo Code",
    vendor: "xiaomi",
    homepage: "https://mimo.xiaomi.com/coder",
    protocol: "pty",
    binary: "mimo",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    preferProtocolOrder: ["acp", "headless-oneshot", "pty"],
    executionMode: "persistent-pty",
    altPresets: [
      {
        protocol: "acp",
        binary: "mimo",
        args: ["acp"],
        capabilities: ACP_DEFAULT_CAPS,
      },
    ],
  },

  devin: {
    agentId: "devin",
    label: "Devin",
    vendor: "cognition",
    homepage: "https://devin.ai",
    protocol: "pty",
    binary: "devin",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    executionMode: "persistent-pty",
  },

  // --- AI Pair Programming CLIs (PTY) ---

  aider: {
    agentId: "aider",
    label: "Aider",
    vendor: "aider-ai",
    homepage: "https://github.com/Aider-AI/aider",
    protocol: "pty",
    binary: "aider",
    args: [],
    capabilities: { ...PTY_DEFAULT_CAPS, permissions: true, multiSession: false },
    installHint: "pip install aider-chat",
    // Aider 支持 --architect --yes 等批处理参数，优先 headless 一次性
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
    cliProfile: {
      headless: true,
      headlessArgs: ["--yes", "--no-suggest-shell-commands"],
      outputFormats: ["ansi"],
    },
  },

  plandex: {
    agentId: "plandex",
    label: "Plandex",
    vendor: "plandex-ai",
    homepage: "https://github.com/plandex-ai/plandex",
    protocol: "pty",
    binary: "plandex",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "curl -sL https://plandex.ai/install.sh | bash",
  },

  gptme: {
    agentId: "gptme",
    label: "gptme",
    vendor: "erik-bjareholt",
    homepage: "https://github.com/gptme/gptme",
    protocol: "pty",
    binary: "gptme",
    args: [],
    capabilities: { ...PTY_DEFAULT_CAPS, mcpClient: true },
    installHint: "pip install gptme",
  },

  "gpt-pilot": {
    agentId: "gpt-pilot",
    label: "GPT Pilot",
    vendor: "pythagora",
    homepage: "https://github.com/Pythagora-io/gpt-pilot",
    protocol: "pty",
    binary: "gpt-pilot",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "pip install gpt-pilot",
  },

  mentat: {
    agentId: "mentat",
    label: "Mentat",
    vendor: "abantecai",
    homepage: "https://github.com/AbanteAI/mentat",
    protocol: "pty",
    binary: "mentat",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "pip install mentat",
  },

  "gpt-engineer": {
    agentId: "gpt-engineer",
    label: "GPT Engineer",
    vendor: "anton-osika",
    homepage: "https://github.com/AntonOsika/gpt-engineer",
    protocol: "pty",
    binary: "gpt-engineer",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "pip install gpt-engineer",
  },

  "smol-developer": {
    agentId: "smol-developer",
    label: "smol developer",
    vendor: "smol-ai",
    homepage: "https://github.com/smol-ai/developer",
    protocol: "pty",
    binary: "python",
    args: ["main.py"],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "git clone https://github.com/smol-ai/developer",
  },

  openhands: {
    agentId: "openhands",
    label: "OpenHands",
    vendor: "all-hands-ai",
    homepage: "https://github.com/All-Hands-AI/OpenHands",
    protocol: "pty",
    binary: "openhands",
    args: [],
    capabilities: { ...PTY_DEFAULT_CAPS, permissions: true, multiSession: true },
    installHint: "pip install openhands-ai",
    // 优先 ACP（SWE 代理的多会话复用）；其次 HTTP server；最后 PTY
    preferProtocolOrder: ["acp", "http", "pty"],
    executionMode: "persistent-pty",
    altPresets: [
      {
        protocol: "acp",
        binary: "openhands",
        args: ["acp"],
        capabilities: { ...ACP_DEFAULT_CAPS, permissions: true, multiSession: true },
      },
      {
        protocol: "http",
        binary: "openhands",
        args: ["serve", "--host", "127.0.0.1"],
        capabilities: {
          streaming: true,
          multiSession: true,
          permissions: true,
          modelSwitch: true,
        },
      },
    ],
  },

  chatdev: {
    agentId: "chatdev",
    label: "ChatDev",
    vendor: "openbmb",
    homepage: "https://github.com/OpenBMB/ChatDev",
    protocol: "pty",
    binary: "chatdev",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "pip install chatdev",
    // ChatDev 单次任务型，headless 一次性跑完就退出
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
  },

  "swe-agent": {
    agentId: "swe-agent",
    label: "SWE-agent",
    vendor: "princeton-nlp",
    homepage: "https://github.com/princeton-nlp/SWE-agent",
    protocol: "pty",
    binary: "sweagent",
    args: ["run"],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "pip install sweagent",
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
  },

  "auto-code-rover": {
    agentId: "auto-code-rover",
    label: "AutoCodeRover",
    vendor: "autocoderoversg",
    homepage: "https://github.com/AutoCodeRoverSG/auto-code-rover",
    protocol: "pty",
    binary: "acr",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "pip install auto-code-rover",
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
  },

  // --- LLM 官方 CLI 工具 ---

  "amazon-q": {
    agentId: "amazon-q",
    label: "Amazon Q Developer CLI",
    vendor: "aws",
    homepage: "https://github.com/aws/amazon-q-developer-cli",
    protocol: "pty",
    binary: "q",
    args: ["chat"],
    capabilities: { ...PTY_DEFAULT_CAPS, permissions: true },
    installHint: "brew install --cask amazon-q",
  },

  "github-copilot-cli": {
    agentId: "github-copilot-cli",
    label: "GitHub Copilot CLI (GA)",
    vendor: "github",
    homepage: "https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line",
    protocol: "pty",
    binary: "copilot",
    args: [],
    capabilities: { ...PTY_DEFAULT_CAPS, permissions: true, mcpClient: true },
    installHint: "npm install -g @github/copilot",
  },

  cody: {
    agentId: "cody",
    label: "Sourcegraph Cody",
    vendor: "sourcegraph",
    homepage: "https://github.com/sourcegraph/cody",
    protocol: "pty",
    binary: "cody",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "npm install -g @sourcegraph/cody",
  },

  // --- Chinese 代码助手 CLI ---

  "tongyi-lingma": {
    agentId: "tongyi-lingma",
    label: "Tongyi Lingma (通义灵码)",
    vendor: "alibaba-cloud",
    homepage: "https://tongyi.aliyun.com/lingma",
    protocol: "pty",
    binary: "lingma",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "Download from https://tongyi.aliyun.com/lingma",
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "persistent-pty", // 交互式为主，强制进池
  },

  "baidu-comate": {
    agentId: "baidu-comate",
    label: "Baidu Comate (文心快码)",
    vendor: "baidu",
    homepage: "https://comate.baidu.com",
    protocol: "pty",
    binary: "comate",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "Download from https://comate.baidu.com",
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "persistent-pty",
  },

  "tencent-codebuddy": {
    agentId: "tencent-codebuddy",
    label: "Tencent CodeBuddy (腾讯云代码助手)",
    vendor: "tencent-cloud",
    homepage: "https://copilot.tencent.com",
    protocol: "pty",
    binary: "codebuddy",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "Download from https://copilot.tencent.com",
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "persistent-pty",
  },

  codegeex: {
    agentId: "codegeex",
    label: "CodeGeeX",
    vendor: "thudm",
    homepage: "https://github.com/THUDM/CodeGeeX2",
    protocol: "pty",
    binary: "codegeex",
    args: ["chat"],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "pip install codegeex",
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "persistent-pty",
  },

  // --- Code Review Agents（一般单命令式输出，headless 一次性） ---

  "pr-agent": {
    agentId: "pr-agent",
    label: "Qodo PR-Agent",
    vendor: "qodo",
    homepage: "https://github.com/qodo-ai/pr-agent",
    protocol: "pty",
    binary: "pr-agent",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "pip install pr-agent",
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
  },

  "open-code-review": {
    agentId: "open-code-review",
    label: "Open Code Review (OCR)",
    vendor: "alibaba",
    homepage: "https://github.com/alibaba/open-code-review",
    protocol: "pty",
    binary: "ocr",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "npm install -g @alibaba-group/open-code-review",
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
  },

  "cr-gpt": {
    agentId: "cr-gpt",
    label: "ChatGPT CodeReview (cr-gpt)",
    vendor: "anc95",
    homepage: "https://github.com/anc95/ChatGPT-CodeReview",
    protocol: "pty",
    binary: "cr",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "npm install -g cr-gpt",
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
  },

  autodev: {
    agentId: "autodev",
    label: "AutoDev",
    vendor: "unitmesh",
    homepage: "https://github.com/unit-mesh/auto-dev",
    protocol: "pty",
    binary: "autodev",
    args: ["review"],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "npm install -g @autodev/cli",
    preferProtocolOrder: ["headless-oneshot", "pty"],
    executionMode: "headless-oneshot",
  },

  // --- 仓库 / 代码搜索 ---

  repomix: {
    agentId: "repomix",
    label: "Repomix",
    vendor: "yamadashy",
    homepage: "https://github.com/yamadashy/repomix",
    protocol: "pty",
    binary: "repomix",
    args: [],
    capabilities: { streaming: false, permissions: false },
    installHint: "npm install -g repomix",
  },

  bloop: {
    agentId: "bloop",
    label: "bloop",
    vendor: "bloop-ai",
    homepage: "https://github.com/BloopAI/bloop",
    protocol: "pty",
    binary: "bloop",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
    installHint: "Download from https://github.com/BloopAI/bloop/releases",
  },

  "dify-cli": {
    agentId: "dify-cli",
    label: "Dify CLI",
    vendor: "langgenius",
    homepage: "https://github.com/langgenius/dify",
    protocol: "pty",
    binary: "dify",
    args: [],
    capabilities: { streaming: false, permissions: false },
    installHint: "brew tap langgenius/dify && brew install dify",
  },

  "shell-genie": {
    agentId: "shell-genie",
    label: "Shell Genie",
    vendor: "dylan-profiler",
    homepage: "https://github.com/dylan-profiler/shell-genie",
    protocol: "pty",
    binary: "shell-genie",
    args: ["ask"],
    capabilities: { streaming: false, permissions: false },
    installHint: "pip install shell-genie",
  },

  // ============================================================
  // 集群 E: MCP 协议（agent 作为 MCP server，stdio transport）
  // ============================================================

  "code-review-graph": {
    agentId: "code-review-graph",
    label: "Code Review Graph (CRG)",
    vendor: "tirth8205",
    homepage: "https://github.com/tirth8205/code-review-graph",
    protocol: "mcp",
    binary: "crg",
    args: ["mcp"],
    capabilities: { streaming: false, permissions: false },
    installHint: "npx crg install",
  },

  // ============================================================
  // 集群 F: Generic / Bash / HTTP wrapper (兜底)
  // ============================================================

  bash: {
    agentId: "bash",
    label: "Bash Generic Wrapper",
    protocol: "generic",
    binary: "bash",
    args: ["-c"],
    commandTemplate: "{binary} -c {command}",
    outputParser: "none",
    capabilities: { streaming: false, permissions: false },
  },

  "http-webhook": {
    agentId: "http-webhook",
    label: "HTTP Webhook",
    protocol: "generic",
    binary: "curl",
    args: ["-X", "POST"],
    commandTemplate: "curl -X POST {url} -d {payload}",
    outputParser: "jsonl",
    capabilities: { streaming: false, permissions: false, heartbeat: true },
  },
};

/** 默认 agent ID（向后兼容，未配置时使用 OpenCode ACP） */
export const DEFAULT_AGENT_ID = "opencode";

/**
 * 获取 preset，找不到时抛错
 */
export function getPreset(agentId: string): AgentPreset {
  const preset = AGENT_PRESETS[agentId];
  if (!preset) {
    throw new Error(`Unknown agentId: ${agentId}. Available: ${Object.keys(AGENT_PRESETS).join(", ")}`);
  }
  return preset;
}

/**
 * 列出所有 preset 的元信息（UI 用）
 */
export function listPresets(): Array<AgentPreset & { id: string }> {
  return Object.entries(AGENT_PRESETS).map(([id, preset]) => ({ id, ...preset }));
}

/** 给定候选（主 preset + altPresets），找到 protocol 匹配的候选并 merge 成完整 preset */
function findCandidateByProtocol(
  base: AgentPreset,
  wantProtocol: SidecarProtocol,
  wantExecutionMode: PtyExecutionMode | undefined,
): AgentPreset | null {
  // 主 preset 命中
  if (base.protocol === wantProtocol && executionModeMatches(base, wantExecutionMode)) {
    return base;
  }
  // altPresets 中顺序匹配
  if (base.altPresets) {
    for (const alt of base.altPresets) {
      if (alt.protocol === wantProtocol) {
        const merged: AgentPreset = {
          ...base,
          ...alt,
          // capabilities 浅 merge 避免丢失 preset 里声明的能力
          capabilities: { ...(base.capabilities ?? {}), ...(alt.capabilities ?? {}) },
          // protocol 必须用 alt 覆盖
          protocol: alt.protocol,
        };
        if (executionModeMatches(merged, wantExecutionMode)) return merged;
      }
    }
  }
  return null;
}

function executionModeMatches(preset: AgentPreset, want: PtyExecutionMode | undefined): boolean {
  if (preset.protocol !== "pty") return true; // 非 PTY 不区分
  if (!want) return true;
  const resolved = resolveExecutionMode(preset);
  return resolved === want;
}

/**
 * 根据 preferProtocolOrder（或默认）选择"最高优先级且能解析"的 preset。
 * 本函数只做配置优选，不做 detect（detect 在 adapter 层按需执行）。
 *
 * 当 protocol/executionMode 用户强制指定时（非 undefined），以此为准；否则
 * 按 preferProtocolOrder 顺序尝试：acp → http → headless-oneshot → pty。
 */
export function selectPresetForAgent(
  agentId: string,
  overrides?: {
    protocol?: SidecarProtocol;
    executionMode?: PtyExecutionMode;
    preferProtocolOrder?: Array<SidecarProtocol | "headless-oneshot">;
  },
): AgentPreset {
  const base = getPreset(agentId);

  // 用户显式指定了 protocol → 直接匹配，找不到就抛错
  if (overrides?.protocol) {
    const hit = findCandidateByProtocol(base, overrides.protocol, overrides.executionMode);
    if (hit) return hit;
    // 找不到就 fallback 到 base（保证 createAdapterForAgent 不报错；detect 会按实际 binary 校验）
    return base;
  }

  const order = overrides?.preferProtocolOrder ?? base.preferProtocolOrder ?? DEFAULT_PROTOCOL_PREFERENCE;
  for (const choice of order) {
    if (choice === "headless-oneshot") {
      const hit = findCandidateByProtocol(base, "pty", "headless-oneshot");
      if (hit) return hit;
      continue;
    }
    const hit = findCandidateByProtocol(base, choice, overrides?.executionMode);
    if (hit) return hit;
  }
  return base;
}

/**
 * 解析 PTY 执行模式：
 *   - 优先 preset.executionMode 显式声明
 *   - 否则看 cliProfile.headless：true → headless-oneshot；false/undefined → persistent-pty
 */
export function resolveExecutionMode(preset: AgentPreset): PtyExecutionMode {
  if (preset.protocol !== "pty") {
    // 非 PTY 不关心；返回 persistent-pty 作为占位（不应被消费方使用）
    return "persistent-pty";
  }
  if (preset.executionMode) return preset.executionMode;
  if (preset.cliProfile?.headless) return "headless-oneshot";
  return "persistent-pty";
}

