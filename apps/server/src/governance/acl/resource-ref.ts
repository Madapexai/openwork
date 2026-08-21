/**
 * 移植自 QM (MIT License, Copyright (c) 2026 QM contributors)
 * 原文件：qm/src/acl/resource-ref.ts
 * 移植说明：零改动，纯函数模块。
 */

const RESOURCE_KINDS = ["file", "skill", "deploy", "cron", "service-cred"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface ResourceRef {
  kind: ResourceKind;
  id: string;
}

const PREFIX: Record<Exclude<ResourceKind, "file">, string> = {
  skill: "skill:",
  deploy: "deployment:",
  cron: "cron:",
  "service-cred": "service-cred:",
};

export const fileRef = (path: string): ResourceRef => ({ kind: "file", id: path });
export const skillRef = (id: string): ResourceRef => ({ kind: "skill", id });
export const deployRef = (id: string): ResourceRef => ({ kind: "deploy", id });
export const cronRef = (id: string): ResourceRef => ({ kind: "cron", id });
export const serviceCredRef = (slug: string): ResourceRef => ({ kind: "service-cred", id: slug });

export function encodeRef(r: ResourceRef): string {
  return r.kind === "file" ? r.id : PREFIX[r.kind] + r.id;
}

export function parseRef(s: string): ResourceRef {
  for (const kind of RESOURCE_KINDS) {
    if (kind === "file") continue;
    const p = PREFIX[kind];
    if (s.startsWith(p)) return { kind, id: s.slice(p.length) };
  }
  return { kind: "file", id: s };
}

export const refPrefix = (kind: Exclude<ResourceKind, "file">): string => PREFIX[kind];

export const refToString = encodeRef;
