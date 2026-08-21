// Per-CLI-agent optional model allowlist.
//
// A CLI agent (e.g. kimi, claude-code) can run models beyond its baked-in
// default. When a user picks a model the agent doesn't currently list as
// supported, we ask whether to register it as an *optional model* for that
// agent. Once registered, the model becomes switchable within that CLI agent.
//
// The allowlist is stored per agentId in localStorage. The agent's built-in
// default model is always considered supported (it is not stored here).

import type { ModelRef } from "../../../../app/types";

const STORAGE_KEY = "openwork.cliAgentOptionalModels.v1";

function readAll(): Record<string, ModelRef[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ModelRef[]> = {};
    for (const [agentId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      out[agentId] = value.filter(
        (m): m is ModelRef =>
          !!m &&
          typeof (m as { providerID?: unknown }).providerID === "string" &&
          typeof (m as { modelID?: unknown }).modelID === "string",
      );
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(state: Record<string, ModelRef[]>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures.
  }
}

/** ModelRef equality helper (providerID + modelID). */
export function cliModelMatches(a: ModelRef, b: ModelRef): boolean {
  return a.providerID === b.providerID && a.modelID === b.modelID;
}

/** Optional models the user explicitly registered for a CLI agent. */
export function getCliAgentOptionalModels(agentId: string): ModelRef[] {
  return readAll()[agentId] ?? [];
}

/** Register an optional model for a CLI agent (idempotent). */
export function addCliAgentOptionalModel(agentId: string, model: ModelRef): ModelRef[] {
  const all = readAll();
  const list = all[agentId] ?? [];
  if (list.some((m) => cliModelMatches(m, model))) return list;
  const next = [...list, model];
  all[agentId] = next;
  writeAll(all);
  return next;
}

/** All models a CLI agent can currently switch to: default + optional list. */
export function getCliAgentSupportedModels(agentId: string, defaultModel?: ModelRef): ModelRef[] {
  const list = [...getCliAgentOptionalModels(agentId)];
  if (
    defaultModel &&
    !list.some((m) => cliModelMatches(m, defaultModel))
  ) {
    list.unshift(defaultModel);
  }
  return list;
}

/** Whether a model is in the supported set of a CLI agent. */
export function isCliModelSupported(model: ModelRef, supported: ModelRef[]): boolean {
  return supported.some((m) => cliModelMatches(m, model));
}

/** Remove an optional model from a CLI agent's allowlist. */
export function deleteCliAgentOptionalModel(agentId: string, model: ModelRef): ModelRef[] {
  const all = readAll();
  const list = all[agentId] ?? [];
  const next = list.filter((m) => !cliModelMatches(m, model));
  if (next.length === 0) {
    delete all[agentId];
  } else {
    all[agentId] = next;
  }
  writeAll(all);
  return next;
}

/** Whether a model is a user-registered optional (vs. baked-in default). */
export function isCliModelOptional(agentId: string, model: ModelRef): boolean {
  return getCliAgentOptionalModels(agentId).some((m) => cliModelMatches(m, model));
}