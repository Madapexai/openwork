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

import type { AgentSidecarConfig, SidecarCapabilities } from "./types.js";

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

/** PTY agent 默认能力（保守） */
const PTY_DEFAULT_CAPS: SidecarCapabilities = {
  streaming: true,
  permissions: false,
  multiSession: false,
  modelSwitch: false,
};

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
    installHint: "curl -fsSL https://kimi.com/code/install.sh | bash",
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
    installHint: "npm install -g openclaw",
  },

  hermes: {
    agentId: "hermes",
    label: "Hermes Agent",
    vendor: "nous-research",
    homepage: "https://hermes-agent.nousresearch.com",
    protocol: "acp",
    binary: "hermes",
    args: ["acp"],
    capabilities: ACP_DEFAULT_CAPS,
    installHint: "pip install hermes-agent",
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
    installHint: "curl -sSL https://tabby.tabbyml.com/install.sh | bash",
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
    installHint: "npm install -g @anthropic-ai/claude-code",
  },

  codex: {
    agentId: "codex",
    label: "Codex",
    vendor: "openai",
    homepage: "https://github.com/openai/codex",
    protocol: "pty",
    binary: "codex",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
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

  continue: {
    agentId: "continue",
    label: "Continue",
    vendor: "continue-dev",
    homepage: "https://continue.dev",
    protocol: "pty",
    binary: "continue",
    args: [],
    capabilities: PTY_DEFAULT_CAPS,
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
  },

  // --- Code Review Agents ---

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
