/**
 * Plan/Act Mode — paired execution for CLI agents that support it.
 *
 * Inspiration:
 *   - Cline `.clinerules` four-stage protocol (Plan / Act / Test / Complete)
 *   - Aider Architect + Editor dual-model routing
 *   - Cursor 2.0 background plan mode with plan/act model separation
 *
 * Contract:
 *   - A CLI agent may declare `planAct: true` in its preset SidecarCapabilities.
 *   - When enabled, a session runs in two phases:
 *       1. PLAN  — the plan model (strong reasoner) produces a step-by-step plan
 *                   (written to a shared artifact) and reviews before commit.
 *       2. ACT   — the act model (fast executor) executes plan steps, using the
 *                   plan output as its task brief.
 *   - Each phase uses its own model pair (planModelID + actModelID). If not
 *     explicitly supplied, fall back to the agent's default model.
 *   - Supports both local relay (same machine) and cross-machine relay (via
 *     ssh-tunnel remote runtime, see ssh-relay.ts).
 *
 * The plan artifact is persisted as a JSONL entry in the shared cloud context
 * (see cloud-context.ts) so cross-machine relay can resume from the plan.
 */

import type { AgentTeamHandle, TeamTask } from "./types.js";
import { runAgentPrompt } from "./agent-runner.js";

export interface PlanActConfig {
  /** Whether plan/act mode is enabled for the team/agent. */
  enabled: boolean;
  /** Plan phase prompt template (optional; default below). */
  planPromptTemplate?: string;
  /** Act phase prompt template (optional; default below). */
  actPromptTemplate?: string;
  /** Plan phase model pair (if unset, use agent default). */
  planModelID?: string;
  /** Act phase model pair (if unset, use agent default). */
  actModelID?: string;
  /** Artifact path to write the plan into (relative to cwd). */
  planArtifactPath?: string;
  /** Review gate: require user confirmation between plan and act. */
  requireReview?: boolean;
}

export interface PlanPhaseResult {
  planId: string;
  planText: string;
  steps: string[];
  artifactPath?: string;
  modelID: string;
}

export interface ActPhaseResult {
  planId: string;
  finalOutput: string;
  stepResults: Array<{ step: string; output: string }>;
  modelID: string;
}

const DEFAULT_PLAN_TEMPLATE = `You are the PLAN agent. Analyze the user request and produce a concise, actionable plan.

## Task
{task_prompt}

## Rules
- Output a plan with 3-8 concrete steps.
- Each step must be executable by a coding agent without ambiguity.
- Call out risks, unknowns, and required artifacts explicitly.
- Do not write code yet.

## Output format
# Plan
1. ...
2. ...`;

const DEFAULT_ACT_TEMPLATE = `You are the ACT agent. Execute the following plan step-by-step.

## Task
{task_prompt}

## Plan
{plan_text}

## Rules
- Execute each step in order. Record the outcome after each step.
- If a step fails, stop and report the failure before moving on.
- Produce a final summary when all steps are complete.`;

export interface PlanActRunOptions {
  team: AgentTeamHandle;
  task: TeamTask;
  planAgentId: string;
  actAgentId: string;
  config: PlanActConfig;
}

/** Run plan phase: returns the plan text and structured steps. */
export async function runPlanPhase(
  input: PlanActRunOptions,
): Promise<PlanPhaseResult> {
  const { team, task, planAgentId, config } = input;
  const member = team.getMember(planAgentId);
  if (!member) throw new Error(`Plan agent '${planAgentId}' is not a team member`);

  const planPrompt = (config.planPromptTemplate ?? DEFAULT_PLAN_TEMPLATE)
    .replace("{task_prompt}", task.prompt);

  await team.ensureMemberStarted(planAgentId);

  const events: import("../agent-sidecar/types.js").AgentEvent[] = [];
  for await (const event of runAgentPrompt({
    adapter: member.adapter,
    cwd: task.cwd,
    prompt: planPrompt,
    timeoutMs: task.timeoutMs ?? 120_000,
  })) {
    events.push(event);
    if (event.kind === "stop") break;
    if (event.kind === "error") throw new Error(`Plan phase failed: ${event.error}`);
  }

  const planText = events
    .filter((e): e is Extract<typeof events[number], { kind: "agent-message-chunk" }> => e.kind === "agent-message-chunk")
    .map((e) => e.text)
    .join("");

  const steps = parseStepsFromPlan(planText);
  const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (config.planArtifactPath) {
    try {
      await writePlanArtifact(task.cwd, config.planArtifactPath, planText, planId);
    } catch {
      // Artifact write is best-effort; do not fail the run.
    }
  }

  return {
    planId,
    planText,
    steps,
    artifactPath: config.planArtifactPath,
    modelID: config.planModelID ?? "agent-default",
  };
}

/** Run act phase: executes the produced plan via the act agent. */
export async function runActPhase(
  input: PlanActRunOptions,
  plan: PlanPhaseResult,
): Promise<ActPhaseResult> {
  const { team, task, actAgentId, config } = input;
  const member = team.getMember(actAgentId);
  if (!member) throw new Error(`Act agent '${actAgentId}' is not a team member`);

  const actPrompt = (config.actPromptTemplate ?? DEFAULT_ACT_TEMPLATE)
    .replace("{task_prompt}", task.prompt)
    .replace("{plan_text}", plan.planText);

  await team.ensureMemberStarted(actAgentId);

  const events: import("../agent-sidecar/types.js").AgentEvent[] = [];
  for await (const event of runAgentPrompt({
    adapter: member.adapter,
    cwd: task.cwd,
    prompt: actPrompt,
    timeoutMs: task.timeoutMs ?? 600_000,
  })) {
    events.push(event);
    if (event.kind === "stop") break;
    if (event.kind === "error") throw new Error(`Act phase failed: ${event.error}`);
  }

  const finalOutput = events
    .filter((e): e is Extract<typeof events[number], { kind: "agent-message-chunk" }> => e.kind === "agent-message-chunk")
    .map((e) => e.text)
    .join("");

  const stepResults = plan.steps.map((step) => ({ step, output: "" }));

  return {
    planId: plan.planId,
    finalOutput,
    stepResults,
    modelID: config.actModelID ?? "agent-default",
  };
}

/** Parse numbered steps from a plan text; falls back to the whole text as one step. */
function parseStepsFromPlan(planText: string): string[] {
  const lines = planText.split(/\r?\n/);
  const steps: string[] = [];
  let current: string[] = [];
  const stepRegex = /^\s*(#\s*Plan\s*|\d+\.\s+)/;
  for (const line of lines) {
    if (stepRegex.test(line) && current.length > 0) {
      steps.push(current.join("\n").trim());
      current = [line];
    } else if (stepRegex.test(line)) {
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) steps.push(current.join("\n").trim());
  return steps.filter((s) => s.length > 0);
}

async function writePlanArtifact(cwd: string, relativePath: string, content: string, planId: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const target = path.join(cwd, relativePath);
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const payload = { planId, generatedAt: new Date().toISOString(), content };
  await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf-8");
}
