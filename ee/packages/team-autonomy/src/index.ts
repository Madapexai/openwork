/**
 * @openwork-ee/team-autonomy — public barrel export.
 *
 * Exports only the non-bridge pieces of the plugin: auth hook, UI manifest,
 * shared types, feature flag. Routes and handler shims are excluded from the
 * barrel to avoid exposing the migration-phase bridge code as part of the
 * plugin's stable surface — they're meant to be imported by den-api's app
 * boot directly, not by downstream consumers.
 */

export {
  ensurePersonalTeamForUser,
  ensurePersonalTeamForUserSafe,
} from "./auth/hook.js";

export { teamAutonomyExtensionManifest } from "./ui/manifest.js";

export type {
  TeamAutonomyEnv,
  TeamAutonomyRouteVariables,
} from "./shared/types.js";

export {
  isTeamAutonomyEnabled,
  requireTeamAutonomyEnabled,
} from "./shared/feature-flag.js";
