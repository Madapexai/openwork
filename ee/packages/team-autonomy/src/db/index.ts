/**
 * Minimal DAL entry. The real 12 services (task-service, team-agent-service,
 * inbox-service, etc.) are re-exported here. Keeping them in the plugin
 * package means den-api core imports a single stable entrypoint, not a dozen
 * individual modules — this is the all-important seam that lets us move
 * files around inside this package without ever touching den-api again.
 */

// Services originally at ee/apps/den-api/src/team-autonomy/*.ts are now owned
// by this package. We import them by their stable workspace path so they keep
// working while we finish the code move.
export {
  ensurePersonalTeamForUser,
  ensurePersonalTeamForUserSafe,
} from "../auth/hook.js";

export * from "../services/_services-barrel.js";
