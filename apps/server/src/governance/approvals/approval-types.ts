/**
 * 移植自 QM (MIT License, Copyright (c) 2026 QM contributors)
 * 原文件：qm/src/slack/approval-cards.ts + qm/src/slack/approvals.ts
 * 移植说明：剥离 Slack 依赖，仅保留平台无关的类型定义
 */

export type ApprovalScope = "once" | "session" | "always";

export interface PendingApproval {
  requestId: string;
  command: string;
  reason: string;
  purpose?: string;
  summary?: string;
  grantModes?: { session: boolean; always: boolean };
}

export interface StoredApproval {
  requestId: string;
  command: string;
  reason?: string;
  purpose?: string;
  summary?: string;
  request?: Record<string, unknown>;
}

export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
  scope?: ApprovalScope;
  decidedBy: string;
  decidedAt: number;
}

export type ApprovalAction = "allow_once" | "allow_session" | "allow_always" | "deny";

export function approvalScopeFromAction(action: ApprovalAction): ApprovalScope | "deny" {
  if (action === "allow_once") return "once";
  if (action === "allow_session") return "session";
  if (action === "allow_always") return "always";
  return "deny";
}

// 持久化后端接口（OpenWork 自己实现）
export interface ApprovalStore {
  save(a: StoredApproval): Promise<void>;
  get(requestId: string): Promise<StoredApproval | null>;
  delete(requestId: string): Promise<void>;
}
