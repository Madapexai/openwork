/**
 * 移植自 QM (MIT License, Copyright (c) 2026 QM contributors)
 * 原文件：qm/src/memory/memory-service.ts
 * 移植说明：保留所有纯函数（recallBody/foldCapture/queryBullets/normalizeReplace/isSystemActor/ccTargetFor/ccCaptureToPersonal）与 MEMORY_HEADER/MAX_FACTS 常量；删除文件实现 createMemoryService 及其依赖（MEMORY_FILE 常量、revisionToken 函数、createHash 导入、WorkspaceStore 类型导入）；MemoryService/MemoryRevision/MemoryHead 接口移至 ./types.js 并通过 re-export 保持向后兼容；import 路径从 .ts 改为 .js、从 ../types.ts 改为 ./types.js。
 */

import { type MemoryService, type ScopeId, parseScopeId, scopeId as makeScopeId } from "./types.js";
import { RECALL_MAX_CHARS, bullets, capTail, dateStr, isBullet, normalize } from "./notebook.js";

export type { MemoryService, MemoryRevision, MemoryHead, ScopeId, ScopeKind, Principal } from "./types.js";

const MEMORY_HEADER = "# Memory";
const MAX_FACTS = 300;

export function recallBody(body: string): string {
  const trimmed = body.trim();
  return trimmed ? capTail(trimmed, RECALL_MAX_CHARS) : "";
}

export function foldCapture(
  existing: string,
  facts: string[],
  at: number,
  trustedProvenance = false,
): { body: string; added: number } {
  const clean = facts
    .map((f) => {
      let text = f
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[-*]\s+/, "");
      if (!trustedProvenance) {
        text = text
          .replace(/^\((\d{4}-\d\d-\d\d)\)\s*/, "on $1: ")
          .replace(/\s+\(said in ([^)]+)\)\s*$/i, " [claimed source: $1]");
      }
      return text;
    })
    .filter(Boolean);
  if (!clean.length) return { body: existing, added: 0 };

  const seen = new Set(existing.split("\n").filter(isBullet).map(normalize));
  const date = dateStr(at);
  const added: string[] = [];
  for (const f of clean) {
    const key = normalize(f);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(`- (${date}) ${f}`);
  }
  if (!added.length) return { body: existing, added: 0 };

  let body = existing.trim()
    ? `${existing.replace(/\s+$/, "")}\n${added.join("\n")}`
    : `${MEMORY_HEADER}\n\n${added.join("\n")}`;

  const lines = body.split("\n");
  const bulletIdx = lines.flatMap((l, i) => (isBullet(l) ? [i] : []));
  const overflow = bulletIdx.length - MAX_FACTS;
  if (overflow > 0) {
    const drop = new Set(bulletIdx.slice(0, overflow));
    body = lines.filter((_, i) => !drop.has(i)).join("\n");
  }
  return { body, added: added.length };
}

export function queryBullets(body: string, q: string, limit: number): string[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return bullets(body)
    .filter((l) => terms.every((t) => l.toLowerCase().includes(t)))
    .slice(0, limit);
}

export function normalizeReplace(content: string): string {
  const trimmed = content.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n` : "";
}

export function isSystemActor(actorId: string | undefined): boolean {
  return !!actorId?.startsWith("system:");
}

export function ccTargetFor(origin: ScopeId, actorId: string | undefined): ScopeId | null {
  if (!actorId || isSystemActor(actorId)) return null;
  const { kind } = parseScopeId(origin);
  if (kind !== "channel" && kind !== "group") return null;
  const target = makeScopeId("personal", actorId);
  return target === origin ? null : target;
}

export async function ccCaptureToPersonal(
  memory: MemoryService,
  origin: ScopeId,
  actorId: string | undefined,
  facts: string[],
  at: number,
  sourceLabel?: string,
): Promise<number> {
  const target = ccTargetFor(origin, actorId);
  if (!target || !facts.length) return 0;
  const { kind } = parseScopeId(origin);
  const clean = sourceLabel
    ?.replace(/[()\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const source = clean || (kind === "channel" ? "a channel" : "a group conversation");
  const tagged = facts.map((f) => `${f} (said in ${source})`);
  return memory.capture(target, tagged, at, `cc:${origin}`);
}
