/**
 * 移植自 QM (MIT License, Copyright (c) 2026 QM contributors)
 * 原文件：qm/src/slack/approval-cards.ts
 * 移植说明：剥离 Slack 依赖，泛型 T 改为平台无关的 ApprovalContext
 */

export type ApprovalBegin<T> =
  | { state: "missing" }
  | { state: "busy" }
  | { state: "ready"; ctx: T };

export interface ApprovalRegistry<T> {
  remember(id: string, ctx: T): void;
  get(id: string): T | undefined;
  begin(id: string): ApprovalBegin<T>;
  settle(id: string): void;
  release(id: string): void;
}

export function createApprovalRegistry<T>(): ApprovalRegistry<T> {
  const pending = new Map<string, { ctx: T; inFlight: boolean }>();
  return {
    remember(id, ctx) { pending.set(id, { ctx, inFlight: false }); },
    get(id) { return pending.get(id)?.ctx; },
    begin(id) {
      const entry = pending.get(id);
      if (!entry) return { state: "missing" };
      if (entry.inFlight) return { state: "busy" };
      entry.inFlight = true;
      return { state: "ready", ctx: entry.ctx };
    },
    settle(id) { pending.delete(id); },
    release(id) {
      const entry = pending.get(id);
      if (entry) entry.inFlight = false;
    },
  };
}
