/**
 * 移植自 QM (MIT License, Copyright (c) 2026 QM contributors)
 * 原文件：qm/src/types.ts（ScopeId/ScopeKind/SCOPE_KINDS/scopeId/personalScope/parseScopeId/isScopeKind）+ qm/src/memory/memory-service.ts（MemoryService/MemoryRevision/MemoryHead 接口）
 * 移植说明：从 QM 两个源文件合并提取内存相关类型；Principal 简化为仅 id+displayName（QM 原始还含 type/teamIds）；isScopeKind 保留为模块内部辅助函数。
 */

export type ScopeId = string;

export const SCOPE_KINDS = ["personal", "channel", "team", "org", "group"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export function isScopeKind(s: string): s is ScopeKind {
  return (SCOPE_KINDS as readonly string[]).includes(s);
}

export function scopeId(kind: ScopeKind, ref: string): ScopeId {
  return `${kind}:${ref}`;
}

export function personalScope(principalId: string): ScopeId {
  return scopeId("personal", principalId);
}

export function parseScopeId(id: ScopeId): { kind: ScopeKind | null; ref: string } {
  const sep = id.indexOf(":");
  if (sep < 0) return { kind: null, ref: "" };
  const raw = id.slice(0, sep);
  return { kind: isScopeKind(raw) ? raw : null, ref: id.slice(sep + 1) };
}

export type EntryType = string;

export interface Principal {
  id: string;
  displayName?: string;
  type?: string;
  teamIds?: readonly string[];
}

export interface MemoryRevision {
  revision: string;
  content: string;
  operation: string;
  author?: string;
  at: number;
}

export interface MemoryHead {
  content: string;
  revision: string;
  updatedAt?: number;
}

export interface MemoryService {
  recall(scopeId: ScopeId): Promise<string>;
  capture(scopeId: ScopeId, facts: string[], at: number, author?: string): Promise<number>;
  query(scopeId: ScopeId, q: string, limit?: number): Promise<string[]>;
  read(scopeId: ScopeId): Promise<string>;
  replace(scopeId: ScopeId, content: string, author?: string): Promise<void>;
  readHead?(scopeId: ScopeId): Promise<MemoryHead>;
  replaceIfRevision?(scopeId: ScopeId, content: string, revision: string, author?: string): Promise<boolean>;
  history?(scopeId: ScopeId, limit?: number): Promise<MemoryRevision[]>;
  restore?(scopeId: ScopeId, revision: string, expectedRevision: string, author?: string): Promise<boolean>;
  updatedAt?(scopeId: ScopeId): Promise<number | undefined>;
  metadata?(): Promise<Map<ScopeId, { bytes: number; updatedAt?: number }>>;
}
