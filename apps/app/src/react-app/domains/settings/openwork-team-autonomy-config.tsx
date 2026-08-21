/** @jsxImportSource react */
import { Kanban } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { registerExtensionConfig } from "./extension-registry";

const openWorkTeamAutonomyConfigFactory = () => (
  <Card variant="outline" size="sm">
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <Kanban size={16} />
        Team Autonomy
      </CardTitle>
      <CardDescription>
        Multi-agent team governance: decompose tasks into boards, auto-create personal
        teams per user, gate permissions with standing rules, and validate skills before
        agents run them.
      </CardDescription>
    </CardHeader>
    <div className="space-y-3 px-4 pb-4">
      <Alert>
        <AlertTitle>Server license flag</AlertTitle>
        <AlertDescription>
          Team Autonomy is part of the Enterprise server build. Set{" "}
          <code>TEAM_AUTONOMY_ENABLED=1</code> on the Den host, then open Team → Board
          from the session sidebar to see tasks and agents.
        </AlertDescription>
      </Alert>
    </div>
  </Card>
);

registerExtensionConfig("openwork.teamAutonomy.settings", openWorkTeamAutonomyConfigFactory);
registerExtensionConfig("openwork-team-autonomy", openWorkTeamAutonomyConfigFactory);