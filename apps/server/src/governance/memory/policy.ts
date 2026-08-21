/**
 * 移植自 QM (MIT License, Copyright (c) 2026 QM contributors)
 * 原文件：qm/src/memory/policy.ts
 * 移植说明：纯函数零改动；WorkspaceLayer 接口在文件内本地定义（QM 中位于 src/types.ts，OpenWork types.ts 未纳入此类型）；import 路径从 ../types.ts 改为 ./types.js 并使用 .js 扩展名。
 */

import type { ScopeId } from "./types.js";

export type MemoryRecallMode = "off" | "writable" | "visible";
export type MemoryCaptureMode = "off" | "writable";

export interface MemoryPolicy {
  recall: MemoryRecallMode;
  capture: MemoryCaptureMode;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = { recall: "visible", capture: "writable" };

export function parseMemoryRecallMode(value: string | undefined): MemoryRecallMode {
  return value === "off" || value === "writable" || value === "visible" ? value : DEFAULT_MEMORY_POLICY.recall;
}

export function parseMemoryCaptureMode(value: string | undefined): MemoryCaptureMode {
  return value === "off" ? "off" : DEFAULT_MEMORY_POLICY.capture;
}

type LayerMode = "ro" | "rw";

export interface WorkspaceLayer {
  scopeId: ScopeId;
  mountPath: string;
  mode: LayerMode;
}

export function writableMemoryScope(layers: WorkspaceLayer[], fallback: ScopeId): ScopeId {
  return layers.find((l) => l.mode === "rw")?.scopeId ?? fallback;
}

export function recallMemoryScopes(
  policy: MemoryPolicy,
  layers: WorkspaceLayer[],
  writableScopeId: ScopeId,
): ScopeId[] {
  if (policy.recall === "off") return [];
  if (policy.recall === "writable") return [writableScopeId];

  const scopes = [writableScopeId, ...layers.map((l) => l.scopeId)];
  return [...new Set(scopes)];
}
