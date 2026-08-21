/**
 * 移植自 QM (MIT License, Copyright (c) 2026 QM contributors)
 * 原文件：qm/src/audit/audit-log.ts
 * 移植说明：仅保留 AuditEvent 类型与 AuditLog 接口；内存实现 createAuditLog 拆分到 memory-audit-log.ts；ScopeId 改从 ../memory/types.ts 导入。
 */

import type { ScopeId } from "../memory/types.js";

export interface AuditEvent {
  at: number;
  principalId: string;
  action: string;
  resource: string;
  scopeLabel: ScopeId;
  status?: string;
  detail?: string;
}

export interface AuditLog {
  record(e: AuditEvent): void;
  recordOnce?(key: string, e: AuditEvent): Promise<void>;
  events(): Promise<readonly AuditEvent[]>;
  tail(opts: { limit: number; scopeLabel?: ScopeId; action?: string; since?: number }): Promise<readonly AuditEvent[]>;
}
