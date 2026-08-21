/**
 * UI extension manifest for team-autonomy — consumed by the desktop app's
 * extension registry (see apps/app/src/app/extensions.ts).
 *
 * SHAPE NOTE:
 *   This manifest deliberately uses a MINIMAL structural type (not a full
 *   import of @openwork/app's OpenWorkExtensionManifest) because the plugin
 *   package lives under ee/packages/ and importing types from apps/app/ would
 *   create a cross-layer type dependency that breaks TypeScript type
 *   resolution when @openwork/app's package.json doesn't declare its internal
 *   src/app/extensions path as an export.
 *
 *   The app shell (apps/app/src/app/extensions.ts) imports this object and
 *   spreads it straight into BUILT_IN_OPENWORK_EXTENSION_MANIFESTS. TypeScript
 *   will type-check *at that import site* against the real
 *   OpenWorkExtensionManifest type. Any shape error surfaces at the app layer
 *   — never in the plugin package. This keeps the plugin zero-dependent on
 *   app internals and free to be re-versioned independently.
 */

export type TeamAutonomyExtensionManifestShape = {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  preview?: boolean;
  source: { format: "openwork-builtin"; origin: "builtin"; trusted: true };
  composer?: { prompt: string };
  setup?: { instructions: string; requiredEnv: string[] };
  resources?: Array<{ type: string; id: string; label: string; description: string; required?: boolean }>;
  contributions?: Array<Record<string, unknown>>;
  enablement?: Array<{ type: string; ref: string; label?: string }>;
  lifecycle?: { reload: string[]; detection: string[] };
  defaultEnabled?: boolean;
  defaultHidden?: boolean;
  platform?: Array<"darwin" | "linux" | "windows" | "web">;
};

export const teamAutonomyExtensionManifest: TeamAutonomyExtensionManifestShape = {
  schemaVersion: 1,
  id: "openwork-team-autonomy",
  name: "Team Autonomy",
  description:
    "Multi-agent team governance: decompose tasks into boards, auto-create personal team per user, gate permissions with standing rules, and validate skills before agents run them.",
  preview: true,
  source: {
    format: "openwork-builtin",
    origin: "builtin",
    trusted: true,
  },
  composer: {
    prompt: "Use Team Autonomy to delegate to a team, break a plan into tasks, or check team inbox for approvals. ",
  },
  setup: {
    instructions:
      "Team Autonomy is part of the Enterprise server build. Save an enterprise license key with TEAM_AUTONOMY_ENABLED=1 on the Den host, then open Team → Board from the sidebar to see tasks and agents.",
    requiredEnv: ["TEAM_AUTONOMY_ENABLED"],
  },
  resources: [
    {
      type: "local-service",
      id: "team-autonomy-api",
      label: "Team Autonomy HTTP routes",
      description: "Hosted on Den under /api/teams/:teamId/*",
      required: true,
    },
  ],
  contributions: [
    {
      type: "settings-panel",
      ref: "openwork.teamAutonomy.settings",
      location: "settings-detail",
      label: "Team Autonomy",
      description: "Org admins: default permission profile, standing rules, agent engine defaults.",
    },
    {
      type: "session-side-panel",
      ref: "openwork.teamAutonomy.boardPanel",
      location: "session-right-pane",
      label: "Team Board",
      description: "Inspect and claim tasks from your active personal team's board inside a chat session.",
    },
    {
      type: "session-rail-item",
      ref: "openwork.teamAutonomy.rail",
      label: "Team Board",
      location: "session-rail",
    },
    {
      type: "composer-prompt",
      prompt: "Use Team Autonomy to delegate to a team, break a plan into tasks, or check team inbox for approvals. ",
      location: "composer",
    },
    {
      type: "control-actions",
      ref: "openwork.teamAutonomy.controlActions",
    },
  ],
  enablement: [
    { type: "toggle-enabled", ref: "openwork-team-autonomy", label: "Enabled" },
    { type: "env-set", ref: "TEAM_AUTONOMY_ENABLED", label: "Server license flag" },
  ],
  lifecycle: {
    reload: ["config", "agents"],
    detection: ["env:TEAM_AUTONOMY_ENABLED"],
  },
  defaultEnabled: false,
  defaultHidden: false,
  platform: ["darwin", "linux", "windows", "web"],
};

export default teamAutonomyExtensionManifest;
