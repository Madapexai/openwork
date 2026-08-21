/**
 * Feature-flag guard. Everything in this plugin gates behind this flag so that
 * OpenWork core can ship without the plugin and/or upstream/dev can merge the
 * adapter seams without pulling in any team-autonomy runtime cost.
 */
export const TEAM_AUTONOMY_ENV_FLAG = "TEAM_AUTONOMY_ENABLED";

export function isTeamAutonomyEnabled(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  const raw = (env ?? process.env)?.[TEAM_AUTONOMY_ENV_FLAG];
  if (raw === undefined || raw === null || raw === "") return false;
  const s = String(raw).trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

export function requireTeamAutonomyEnabled(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  if (!isTeamAutonomyEnabled(env)) {
    throw new Error(
      `[team-autonomy] disabled: set ${TEAM_AUTONOMY_ENV_FLAG}=1 to enable the plugin.`,
    );
  }
}
