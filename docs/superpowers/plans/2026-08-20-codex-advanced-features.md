# Codex Advanced Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade OpenWork to support Codex's advanced features — goal (agent goal declaration), loop (goal-driven automation loop), dynamic (dynamic artifact surfacing for codex), and site (multi-tenant site isolation).

**Architecture:** Each feature extends an existing surface — `agent-sidecar` presets for goal/loop, `packages/automations` for loop execution, `ee/apps/den-api/src/mcp` for dynamic artifact codex exposure, and `ee/apps/den-api` orgs + Den DB schema for site. All changes follow the existing capability-declaration pattern in `SidecarCapabilities` and the automation contract in `packages/automations/src/ports.ts`.

**Tech Stack:** TypeScript, Zod, pnpm, the existing agent-sidecar preset system, the existing automations domain, the existing MCP gateway (`ee/apps/den-api`).

---

## Feature 1: goal — Agent Goal Capability

### Files
- Modify: `apps/server/src/agent-sidecar/types.ts` — add `goal` to `SidecarCapabilities`
- Modify: `apps/server/src/agent-sidecar/presets.ts` — add `goal` capability to the `codex` preset and create a `codex-goal` variant
- Create: `apps/server/src/agent-sidecar/goal.ts` — goal execution helper (goal parsing + result validation)
- Create: `apps/server/src/agent-sidecar/goal.test.ts` — unit tests

### Tasks

- [ ] **Step 1: Add `goal` field to `SidecarCapabilities` in types.ts**
  Add `goal?: boolean` to the `SidecarCapabilities` interface (line ~155). This follows the existing capability pattern (e.g. `worktree`, `mcpClient`).

- [ ] **Step 2: Add `goal` capability to the `codex` preset in presets.ts**
  In the `codex` preset (line ~450), add `goal: true` to `PTY_DEFAULT_CAPS` or create a new `CODex_GOAL_CAPS` constant that extends `PTY_DEFAULT_CAPS` with `goal: true`. Also add a `codex-goal` variant preset with `executionMode: "headless-oneshot"` and `goal: true`.

- [ ] **Step 3: Create goal execution helper**
  Create `apps/server/src/agent-sidecar/goal.ts` exporting:
  - `parseGoal(instructions: string): { goal: string; successCriteria: string[] } | null` — extracts goal from agent instructions using a simple regex heuristic
  - `validateGoalResult(goal: string, result: string): boolean` — checks if result satisfies the goal

- [ ] **Step 4: Write tests for goal helper**
  Create `apps/server/src/agent-sidecar/goal.test.ts` with tests for `parseGoal` and `validateGoalResult`.

- [ ] **Step 5: Run tests and verify**
  Run: `npx vitest run apps/server/src/agent-sidecar/goal.test.ts`
  Expected: all tests pass.

---

## Feature 2: loop — Goal-Driven Automation Loop

### Files
- Modify: `packages/types/src/automations.ts` — add `goal` field to `AutomationRevision`
- Modify: `packages/automations/src/engine.ts` — add goal-check loop termination logic
- Modify: `packages/automations/src/ports.ts` — add `goal` to `CreateAutomationDefinition`
- Create: `packages/automations/src/loop.ts` — loop execution engine (run automation until goal met or max iterations)
- Create: `packages/automations/src/loop.test.ts` — unit tests

### Tasks

- [ ] **Step 1: Add `goal` field to `AutomationRevision` in types/automations.ts**
  Add `goal?: string` to `automationRevisionSchema` (around line 120). This is an optional string describing the goal the automation runs toward.

- [ ] **Step 2: Add `goal` to `CreateAutomationDefinition` in types/automations.ts**
  Add `goal?: string` to `actionCreateAutomationSchema` (around line 315).

- [ ] **Step 3: Add loop termination logic to engine.ts**
  In `packages/automations/src/engine.ts`, add `goalCheck` to `AutomationEngineCapabilityDeclaration` (add `goal: z.enum(["supported", "best_effort", "unsupported"])` to the `isolation` object or as a top-level field). Add a `checkGoal(goal: string, resultSummary: string | null): boolean` function that determines if the automation's goal is satisfied.

- [ ] **Step 4: Create loop execution engine**
  Create `packages/automations/src/loop.ts` exporting:
  - `LoopConfig` interface: `{ maxIterations: number; goal: string; goalCheckIntervalMs: number }`
  - `runLoop(adapter: AutomationEngineAdapter, config: LoopConfig, receipt: AutomationEngineAdmissionReceipt): Promise<AutomationEngineResult>` — runs the adapter repeatedly until goal is met or max iterations reached

- [ ] **Step 5: Write tests for loop engine**
  Create `packages/automations/src/loop.test.ts` with tests for:
  - loop terminates when goal is met
  - loop terminates at max iterations
  - loop passes correct context between iterations

- [ ] **Step 6: Run tests and verify**
  Run: `npx vitest run packages/automations/src/loop.test.ts`
  Expected: all tests pass.

---

## Feature 3: dynamic — Surface Dynamic Artifact for Codex

### Files
- Modify: `ee/apps/den-api/src/mcp/agent.ts` — ensure `dynamicArtifactAppServerCapabilities` is advertised in the codex MCP server context
- No new files needed — dynamic-artifact-app is already implemented.

### Tasks

- [ ] **Step 1: Verify dynamic-artifact is reachable via the agent MCP endpoint**
  The `createAgentMcpServer()` function at line 234 already includes `dynamicArtifactAppServerCapabilities`. Verify the `registerAgentDynamicArtifactApp` call at line 579 is reached for codex-sourced requests by checking the `loadDynamicArtifact` function path.

- [ ] **Step 2: Add codex-specific capability hint for dynamic artifacts**
  In `ee/apps/den-api/src/mcp/dynamic-artifact-app.ts`, add a `codex` field to `DynamicArtifactAppPayload` schema (optional, for codex-specific rendering hints).

- [ ] **Step 3: Write a spec test for dynamic artifact codex exposure**
  Create or update `ee/apps/den-api/test/mcp-dynamic-artifact-app.test.ts` to verify the `render_dynamic_artifact` tool is listed when the agent MCP server is queried via `search_capabilities` with `type: "mcp"`.

- [ ] **Step 4: Run tests and verify**
  Run: `npx vitest run ee/apps/den-api/test/mcp-dynamic-artifact-app.test.ts`
  Expected: all tests pass.

---

## Feature 4: site — Multi-Tenant Site Isolation

### Files
- Modify: `ee/apps/den-api/src/orgs.ts` — add `siteId` to organization context
- Modify: `ee/packages/den-db/src/schema.ts` — add `siteId` column to relevant tables
- Create: `ee/apps/den-api/src/site.ts` — site management service (create/list/get sites)
- Create: `ee/apps/den-api/src/site.test.ts` — unit tests

### Tasks

- [ ] **Step 1: Add `siteId` to organization schema in den-db**
  In `ee/packages/den-db/src/schema.ts`, add `siteId: idSchema.nullable().optional()` to the Organization table schema. Add a new `SiteTable` with columns: `id`, `organizationId`, `name`, `domain`, `createdAt`, `updatedAt`.

- [ ] **Step 2: Create site management service**
  Create `ee/apps/den-api/src/site.ts` exporting:
  - `createSite(input: { organizationId: string; name: string; domain: string })` — creates a new site for an org
  - `listSites(organizationId: string)` — lists sites for an org
  - `getSite(siteId: string)` — gets a site by ID
  - `deleteSite(siteId: string)` — soft-deletes a site

- [ ] **Step 3: Wire siteId into org context in orgs.ts**
  In `ee/apps/den-api/src/orgs.ts`, add `siteId?: string` to the organization context returned by `getOrganizationContextForUser`. When a site is active, scope all operations to that site.

- [ ] **Step 4: Write tests for site service**
  Create `ee/apps/den-api/src/site.test.ts` with tests for create, list, get, delete.

- [ ] **Step 5: Run tests and verify**
  Run: `npx vitest run ee/apps/den-api/src/site.test.ts`
  Expected: all tests pass.

---

## Verification (every change)

- The only proof path is `evals/specs/**/*.test.ts` with `test` from `@openwork/testkit`.
- Run `npx vitest run` in the worktree after all tasks complete.
- Prose, screenshots, and recordings never decide pass/fail — the testkit tape does.
- Verdicts: `Passed` only when every claim has an observable assertion in the tape.

## Self-Review Checklist

1. **Spec coverage:** Each of the four features (goal, loop, dynamic, site) has at least one task.
2. **Placeholder scan:** No TBD, TODO, or "implement later" patterns in any task step.
3. **Type consistency:** All new Zod schemas use the same `idSchema`, `timestampSchema` patterns as existing code. All new interfaces follow the existing naming convention.