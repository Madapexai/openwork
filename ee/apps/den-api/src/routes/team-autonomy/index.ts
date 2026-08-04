// team-autonomy/index.ts — 路由聚合 + 挂载入口
// OpenSpecs: prds/team-autonomy/openspecs/openspec-http-routes.md
// 由 app.ts 调用 registerTeamAutonomyRoutes(app)，统一前缀 /api/teams/:teamId/...

import type { Hono } from "hono"
import { registerTeamAgentRoutes } from "./agents.js"
import { registerTeamArtifactRoutes } from "./artifacts.js"
import { registerTeamAutomationRoutes } from "./automation.js"
import { registerTeamBoardRoutes } from "./boards.js"
import { registerTeamInboxRoutes } from "./inbox.js"
import { registerTeamPermissionRoutes } from "./permissions.js"
import { registerTeamTaskRoutes } from "./tasks.js"
import type { TeamAutonomyRouteVariables } from "./shared.js"

export function registerTeamAutonomyRoutes<T extends { Variables: TeamAutonomyRouteVariables }>(app: Hono<T>) {
  registerTeamAgentRoutes(app)
  registerTeamTaskRoutes(app)
  registerTeamBoardRoutes(app)
  registerTeamArtifactRoutes(app)
  registerTeamAutomationRoutes(app)
  registerTeamInboxRoutes(app)
  registerTeamPermissionRoutes(app)
}

export * from "./shared.js"
