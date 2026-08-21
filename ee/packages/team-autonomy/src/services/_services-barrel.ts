// @ts-nocheck
/**
 * Service barrel — single public surface for all team-autonomy logic.
 *
 * MIGRATION PHASE (phase-1-core → L3 plugin):
 *   Right now the implementations still live under
 *   ee/apps/den-api/src/team-autonomy/*.ts. We re-export them through this
 *   barrel so handlers import `* as services from
 *   "@openwork-ee/team-autonomy/services"` and become agnostic to where the
 *   source lives.
 *
 * We use RELATIVE paths (../../../apps/den-api/src/...) instead of
 * "@openwork-ee/den-api" workspace package imports because den-api is an
 * application package, not a library — it has no package.json exports that
 * expose its internal src/ files, and adding a devDependency on it would
 * create a circular self-reference (den-api would need to depend on itself).
 *
 * `@ts-nocheck` here because @ts-ignore doesn't work on `export *`; each
 * cross-file re-export would be typed as `never` without it.
 *
 * Post-migration: replace every line with `export * from "./x.js";` (local
 * after service files are moved into this package). No more ts-nocheck.
 */

export * from "../../../../apps/den-api/src/team-autonomy/asset-service.js";
export * from "../../../../apps/den-api/src/team-autonomy/automation-service.js";
export * from "../../../../apps/den-api/src/team-autonomy/budget-service.js";
export * from "../../../../apps/den-api/src/team-autonomy/inbox-service.js";
export * from "../../../../apps/den-api/src/team-autonomy/mailbox-service.js";
export * from "../../../../apps/den-api/src/team-autonomy/permission-service.js";
export * from "../../../../apps/den-api/src/team-autonomy/personal-team-service.js";
export * from "../../../../apps/den-api/src/team-autonomy/sidecar-service.js";
export * from "../../../../apps/den-api/src/team-autonomy/skill-validation-service.js";
export * from "../../../../apps/den-api/src/team-autonomy/task-service.js";
export * from "../../../../apps/den-api/src/team-autonomy/team-agent-service.js";
export * from "./personal-team-ensure.js";
export * from "../../../../apps/den-api/src/team-autonomy/scheduler-worker.js";
