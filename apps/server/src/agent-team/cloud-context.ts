/**
 * Cloud Context — session snapshot store for cross-machine relay.
 *
 * Persists team relay context as append-only JSONL (Claude Code format)
 * so a relay pipeline can be resumed on a different machine.
 *
 * Reference:
 *   - Claude Code JSONL transcript layout
 *   - OpenHands ACP on Cloud #1018 — snapshot session state to object storage
 *   - OpenWork research memo on context_snapshot serialization
 *
 * Layout (local + object storage identical):
 *   session-root/<team-id>/<session-id>/
 *     transcript.jsonl   (append-only trajectory)
 *     state.json         (current session summary — rev 1..N)
 *     plan.json          (latest plan artifact produced by plan/act mode)
 *     meta.json          (created_at, member_ids, agent versions)
 *
 * The store is compact: we keep trajectory entries as one-line JSON
 * (no envelope), and the state.json is rewritten only on snapshot().
 * Secrets (API keys, tokens) MUST be filtered out before any write — the
 * helper `redactSecrets` in this module exposes the allowlist.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface CloudContextEntry {
  /** Entry id (UUIDv7-like). */
  id: string;
  /** Timestamp (ms since epoch). */
  ts: number;
  /** Entry kind. */
  kind:
    | "init"
    | "plan"
    | "plan-step"
    | "act"
    | "message"
    | "relay-handoff"
    | "artifact"
    | "error"
    | "checkpoint";
  /** Agent id that produced this entry. */
  agentId: string;
  /** Body payload — kept small; summaries live in state.json. */
  body: unknown;
  /** Parent entry id for threaded structures. */
  parentId?: string;
  /** Labels for fast filtering. */
  labels?: string[];
}

export interface CloudSessionState {
  sessionId: string;
  teamId: string;
  createdAt: number;
  updatedAt: number;
  memberIds: string[];
  lastPlanId?: string;
  lastActSummary?: string;
  relayCursor: number;
}

export interface CloudContextHandle {
  sessionId: string;
  teamId: string;
  append(entry: Omit<CloudContextEntry, "id" | "ts">): CloudContextEntry;
  snapshot(patch: Partial<CloudSessionState>): CloudSessionState;
  readState(): CloudSessionState | null;
  readTranscript(): CloudContextEntry[];
  readPlan(): { planId: string; text: string } | null;
  writePlan(planId: string, text: string): void;
  seal(): void;
}

export interface CloudContextStoreOptions {
  /** Local root directory for the JSONL files. */
  rootDir: string;
  /** Optional object-storage uploader — called on every snapshot. */
  uploader?: (payload: { path: string; data: Buffer; contentType: string }) => Promise<void>;
  /** Optional object-storage downloader — called on read() when local miss. */
  downloader?: (path: string) => Promise<Buffer | null>;
  /** Secret keys to redact (case-insensitive match on JSON keys). */
  secretKeys?: string[];
}

const DEFAULT_SECRET_KEYS = [
  "apiKey", "api_key", "authorization", "token", "password",
  "secret", "clientSecret", "client_secret", "access_token",
];

/** Open (or create) a cloud-context session for the given team/session. */
export function openCloudContext(
  teamId: string,
  sessionId: string,
  memberIds: string[],
  options: CloudContextStoreOptions,
): CloudContextHandle {
  const sessionRoot = join(options.rootDir, teamId, sessionId);
  mkdirSync(sessionRoot, { recursive: true });

  const transcriptPath = join(sessionRoot, "transcript.jsonl");
  const statePath = join(sessionRoot, "state.json");
  const planPath = join(sessionRoot, "plan.json");
  const metaPath = join(sessionRoot, "meta.json");

  if (!existsSync(metaPath)) {
    const meta = {
      teamId,
      sessionId,
      createdAt: Date.now(),
      memberIds,
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  }

  if (!existsSync(statePath)) {
    const initState: CloudSessionState = {
      sessionId,
      teamId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      memberIds,
      relayCursor: 0,
    };
    writeFileSync(statePath, JSON.stringify(initState, null, 2), "utf-8");
  }

  // Append an init entry if the transcript is empty.
  if (!existsSync(transcriptPath) || statSync(transcriptPath).size === 0) {
    const init: CloudContextEntry = {
      id: randomUUID(),
      ts: Date.now(),
      kind: "init",
      agentId: "system",
      body: { teamId, sessionId, memberIds },
    };
    appendFileSync(transcriptPath, JSON.stringify(init) + "\n", "utf-8");
  }

  const handle: CloudContextHandle = {
    sessionId,
    teamId,
    append(entry) {
      const full: CloudContextEntry = {
        id: randomUUID(),
        ts: Date.now(),
        ...redactSecrets(entry, options.secretKeys ?? DEFAULT_SECRET_KEYS),
      };
      appendFileSync(transcriptPath, JSON.stringify(full) + "\n", "utf-8");
      return full;
    },
    snapshot(patch) {
      const state = handle.readState() ?? {
        sessionId,
        teamId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        memberIds,
        relayCursor: 0,
      };
      const next: CloudSessionState = { ...state, ...patch, updatedAt: Date.now() };
      writeFileSync(statePath, JSON.stringify(next, null, 2), "utf-8");
      // Kick off object-storage upload if configured.
      void options.uploader?.({
        path: `${teamId}/${sessionId}/state.json`,
        data: Buffer.from(JSON.stringify(next)),
        contentType: "application/json",
      }).catch(() => {});
      return next;
    },
    readState() {
      if (!existsSync(statePath)) return null;
      try {
        const raw = readFileSync(statePath, "utf-8");
        return JSON.parse(raw) as CloudSessionState;
      } catch {
        return null;
      }
    },
    readTranscript() {
      if (!existsSync(transcriptPath)) return [];
      const raw = readFileSync(transcriptPath, "utf-8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try { return JSON.parse(line) as CloudContextEntry; } catch { return null; }
        })
        .filter((e): e is CloudContextEntry => e !== null);
    },
    readPlan() {
      if (!existsSync(planPath)) return null;
      try {
        const raw = readFileSync(planPath, "utf-8");
        const parsed = JSON.parse(raw) as { planId: string; text: string };
        return parsed;
      } catch {
        return null;
      }
    },
    writePlan(planId: string, text: string) {
      const payload = { planId, text, writtenAt: Date.now() };
      writeFileSync(planPath, JSON.stringify(payload, null, 2), "utf-8");
      void options.uploader?.({
        path: `${teamId}/${sessionId}/plan.json`,
        data: Buffer.from(JSON.stringify(payload)),
        contentType: "application/json",
      }).catch(() => {});
    },
    seal() {
      const entry: CloudContextEntry = {
        id: randomUUID(),
        ts: Date.now(),
        kind: "checkpoint",
        agentId: "system",
        body: { sealed: true, transcriptChecksum: hashFile(transcriptPath) },
      };
      appendFileSync(transcriptPath, JSON.stringify(entry) + "\n", "utf-8");
    },
  };

  return handle;
}

/** Filter secret keys out of arbitrary body payloads (recursive). */
function redactSecrets<T>(body: T, secretKeys: string[]): T {
  if (body === null || body === undefined) return body;
  if (typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map((item) => redactSecrets(item, secretKeys)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const isSecret = secretKeys.some((s) => k.toLowerCase().includes(s.toLowerCase()));
    out[k] = isSecret ? "<redacted>" : redactSecrets(v, secretKeys);
  }
  return out as T;
}

function hashFile(path: string): string {
  if (!existsSync(path)) return "";
  try {
    const content = readFileSync(path, "utf-8");
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  } catch {
    return "";
  }
}

export function computeSessionFingerprint(state: CloudSessionState, transcriptSize: number): string {
  const h = createHash("sha256");
  h.update(state.sessionId);
  h.update(String(state.updatedAt));
  h.update(String(transcriptSize));
  return h.digest("hex").slice(0, 12);
}

// Helper exports for tests / consumers
export const _internal = { openSync, closeSync, dirname };
