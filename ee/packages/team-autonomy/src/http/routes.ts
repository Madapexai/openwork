/**
 * HTTP route registration entrypoint.
 *
 * This is the L1 Adapter A — den-api/src/app.ts imports exactly one symbol
 * from here: `registerTeamAutonomyRoutes`. When the flag is off, this call is
 * a no-op (no routes, no startup cost). When on, it delegates to the actual
 * route modules via static local imports.
 *
 * Routing contract:
 *   All routes hang off /api/teams/:teamId/. The host app is responsible for
 *   prefix normalization and middleware ordering; we mount straight into the
 *   Hono app exactly like the other den-api route modules do.
 */
import type { Hono } from "hono"
import { isTeamAutonomyEnabled } from "../shared/feature-flag.js"
import type { TeamAutonomyRouteVariables } from "../shared/types.js"
import { registerTeamAgentRoutes } from "./handlers/agents.js"
import { registerTeamArtifactRoutes } from "./handlers/artifacts.js"
import { registerTeamAutomationRoutes } from "./handlers/automation.js"
import { registerTeamBoardRoutes } from "./handlers/boards.js"
import { registerTeamInboxRoutes } from "./handlers/inbox.js"
import { registerTeamPermissionRoutes } from "./handlers/permissions.js"
import { registerTeamTaskRoutes } from "./handlers/tasks.js"
import { registerTeamListRoutes } from "./handlers/teams.js"

export type { TeamAutonomyRouteVariables }

type AnyHono = Hono
type AnyRouteRegistrar = (app: Hono) => void

export function registerTeamAutonomyRoutes<T extends { Variables: TeamAutonomyRouteVariables["Variables"] }>(
  app: Hono<T>,
): boolean {
  if (!isTeamAutonomyEnabled()) {
    return false
  }

  const appAny = app as unknown as AnyHono
  const registrars: AnyRouteRegistrar[] = [
    registerTeamAgentRoutes as AnyRouteRegistrar,
    registerTeamTaskRoutes as AnyRouteRegistrar,
    registerTeamBoardRoutes as AnyRouteRegistrar,
    registerTeamArtifactRoutes as AnyRouteRegistrar,
    registerTeamAutomationRoutes as AnyRouteRegistrar,
    registerTeamInboxRoutes as AnyRouteRegistrar,
    registerTeamPermissionRoutes as AnyRouteRegistrar,
    registerTeamListRoutes as AnyRouteRegistrar,
  ]
  for (const register of registrars) {
    try {
      register(appAny)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[team-autonomy] route registrar failed:", { err, registrarName: register.name })
    }
  }

  return true
}

export function registerTeamAutonomyRoutesSync<T extends { Variables: TeamAutonomyRouteVariables["Variables"] }>(
  app: Hono<T>,
  modules: {
    registerRoutes: (app: AnyHono) => void
  },
): boolean {
  if (!isTeamAutonomyEnabled()) return false
  modules.registerRoutes(app as unknown as AnyHono)
  return true
}
