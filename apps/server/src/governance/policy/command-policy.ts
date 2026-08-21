/**
 * 移植自 QM (MIT License, Copyright (c) 2026 QM contributors)
 * 原文件：qm/src/policy/command-policy.ts
 * 移植说明：Tier 1 简化版。本地定义 CommandDecision/CommandRule/CommandPolicy/CommandEvaluation 类型与 errMessage 辅助函数；删除 scannableCommand 及其全部 shell 解析辅助函数（约 750 行）；evaluateCommand 替换为对原始 command 字符串直接跑正则匹配的版本；parseCommandPolicy 中的 compileSafeRegex 校验替换为 new RegExp。
 */

export type CommandDecision = "allow" | "deny" | "require_approval";

export interface CommandRule {
  pattern: string;
  decision: CommandDecision;
  reason?: string;
}

type CommandPolicyMode = "denylist" | "allowlist";

export interface CommandPolicy {
  mode: CommandPolicyMode;
  rules: CommandRule[];
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const ORG_FLOOR_RULES: CommandRule[] = [
  {
    pattern: "\\brm\\b[^\\n]*(?:-[a-zA-Z]*r|--recursive)",
    decision: "require_approval",
    reason: "recursive delete",
  },
  {
    pattern: "\\bgit\\s+push\\b.*(?:--force\\b|(?:^|\\s)-[a-zA-Z]*f\\b)",
    decision: "require_approval",
    reason: "force push",
  },
  { pattern: "\\b(drop|truncate)\\s+table\\b", decision: "require_approval", reason: "destructive SQL" },
  { pattern: "\\bmkfs\\b|:\\(\\)\\s*\\{", decision: "deny", reason: "destructive / fork bomb" },
  { pattern: "\\bcurl\\b.*\\|\\s*(sh|bash)\\b", decision: "require_approval", reason: "pipe-to-shell" },
];

export function defaultOrgPolicy(): CommandPolicy {
  return { mode: "denylist", rules: ORG_FLOOR_RULES };
}

export function composePolicy(orgFloor: CommandPolicy, scope?: CommandPolicy): CommandPolicy {
  if (!scope) return orgFloor;
  const mode = orgFloor.mode === "allowlist" ? "allowlist" : scope.mode;
  return {
    mode,
    rules: [...orgFloor.rules, ...scope.rules],
  };
}

export function parseCommandPolicy(input: unknown): { policy: CommandPolicy } | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "command policy must be an object" };
  }
  const b = input as { mode?: unknown; rules?: unknown };
  if (b.mode !== "denylist" && b.mode !== "allowlist") {
    return { error: 'mode must be "denylist" or "allowlist"' };
  }
  if (!Array.isArray(b.rules)) return { error: "rules must be an array" };
  const rules: CommandRule[] = [];
  for (const [i, raw] of b.rules.entries()) {
    if (typeof raw !== "object" || raw === null) return { error: `rules[${i}] must be an object` };
    const r = raw as { pattern?: unknown; decision?: unknown; reason?: unknown };
    if (typeof r.pattern !== "string" || r.pattern.length === 0) {
      return { error: `rules[${i}].pattern must be a non-empty string` };
    }
    try {
      new RegExp(r.pattern, "i");
    } catch (e) {
      return { error: `rules[${i}].pattern is not a valid regex: ${errMessage(e)}` };
    }
    if (r.decision !== "allow" && r.decision !== "deny" && r.decision !== "require_approval") {
      return { error: `rules[${i}].decision must be "allow", "deny", or "require_approval"` };
    }
    if (r.reason !== undefined && typeof r.reason !== "string") {
      return { error: `rules[${i}].reason must be a string` };
    }
    rules.push({ pattern: r.pattern, decision: r.decision, ...(r.reason !== undefined ? { reason: r.reason } : {}) });
  }
  return { policy: { mode: b.mode, rules } };
}

export interface CommandEvaluation {
  decision: CommandDecision;
  reason?: string;
  matched?: string;
  approvalKey?: string;
}

export function evaluateCommand(command: string, policy: CommandPolicy): CommandEvaluation {
  for (const rule of policy.rules) {
    const re = new RegExp(rule.pattern, "i");
    const hit = re.exec(command);
    if (hit) return { decision: rule.decision, reason: rule.reason, matched: hit[0], approvalKey: rule.pattern };
  }
  if (policy.mode === "allowlist") return { decision: "deny", reason: "not in allowlist" };
  return { decision: "allow" };
}
