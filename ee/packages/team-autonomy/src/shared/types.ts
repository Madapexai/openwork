import type { Context, Env } from "hono";

export type TeamAutonomyEnv = {
  TEAM_AUTONOMY_ENABLED?: string;
};

/**
 * Hono context Variables required by team-autonomy routes.
 *
 * Purposefully minimal — the plugin takes only the things it truly needs from
 * the host (db handle, logger, authenticated user + org), and nothing else.
 * This means adapter setup stays 10 lines and stays stable as den-api core
 * evolves upstream.
 */
export type TeamAutonomyRouteVariables = {
  /** authenticated userId (from better-auth session) */
  userId: string;
  /** activeOrganizationId for the calling user */
  activeOrganizationId: string | null;
  /** request logger, compatible shape with den-api's appLogger.child(...) */
  logger: TeamAutonomyLogger;
  Variables: {
    userId: string;
    activeOrganizationId: string | null;
    logger: TeamAutonomyLogger;
  };
};

export interface TeamAutonomyLogger {
  info: (msg: string, extra?: unknown) => void;
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
  debug?: (msg: string, extra?: unknown) => void;
  child?: (bindings: Record<string, unknown>) => TeamAutonomyLogger;
}

export type TeamAutonomyAppEnv = Env & { Variables: TeamAutonomyRouteVariables["Variables"] };

export type TeamAutonomyHonoContext = Context<TeamAutonomyAppEnv>;
