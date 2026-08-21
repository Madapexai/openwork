/**
 * 移植自 QM (MIT License, Copyright (c) 2026 QM contributors)
 * 原文件：qm/src/audit/audit-log.ts (createAuditLog 部分)
 * 移植说明：将 createAuditLog 拆分到独立文件；内联原 createScopedEventSink 的环形缓冲逻辑（record/all/list），避免引入 admin/scoped-event-sink 依赖；保留 recordOnce 的 Set 幂等与 tail 的过滤+切片语义；保留 MAX=50000 上限。
 */

import type { ScopeId } from "../memory/types.js";
import type { AuditEvent, AuditLog } from "./audit-log.js";

const MAX = 50000;

export function createAuditLog(): AuditLog {
  const events: AuditEvent[] = [];
  const once = new Set<string>();

  function record(e: AuditEvent): void {
    events.push(e);
    if (events.length > MAX) events.splice(0, events.length - MAX);
  }

  function list(opts: { limit?: number; scopeId?: ScopeId }): AuditEvent[] {
    const limit = opts.limit ?? MAX;
    return events
      .filter((e) => (opts.scopeId ? e.scopeLabel === opts.scopeId : true))
      .slice(-limit)
      .reverse();
  }

  return {
    record,
    async recordOnce(key, e) {
      if (once.has(key)) return;
      record(e);
      once.add(key);
    },
    events: async () => events,
    tail: async ({ limit, scopeLabel, action, since }) =>
      list({ limit: MAX, ...(scopeLabel ? { scopeId: scopeLabel } : {}) })
        .filter((e) => (action === undefined || e.action === action) && (since === undefined || e.at >= since))
        .slice(0, limit),
  };
}
