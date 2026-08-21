/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Kanban, Loader2, RefreshCw, Users, X } from "lucide-react";

import { readDenSettings } from "@/app/lib/den";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type TeamBoardPanelProps = {
  onClose: () => void;
};

type TeamSummary = {
  id: string;
  name: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
};

type Board = {
  id: string;
  teamId: string;
  name: string;
  columns: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type TeamTask = {
  id: string;
  title?: string;
  summary?: string;
  status?: string;
  assigneeId?: string | null;
};

const EMPTY_COLUMNS = ["todo", "in_progress", "review", "done"];

function settings() {
  return readDenSettings();
}

async function requestTeam<T>(path: string): Promise<T> {
  const { baseUrl, authToken, activeOrgId } = settings();
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (activeOrgId) headers["x-openwork-legacy-org-id"] = activeOrgId;
  const response = await fetch(url, { method: "GET", headers, credentials: "include" });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const message = json && typeof json === "object" && "error" in json
      ? String((json as { error: unknown }).error)
      : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return json as T;
}

export function TeamBoardPanel(props: TeamBoardPanelProps) {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTeam = useMemo(
    () => teams.find((team) => team.id === selectedTeamId) ?? null,
    [selectedTeamId, teams],
  );
  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === selectedBoardId) ?? null,
    [boards, selectedBoardId],
  );

  const loadTeams = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const payload = await requestTeam<{ teams: TeamSummary[] }>("/api/teams");
      const nextTeams = Array.isArray(payload?.teams) ? payload.teams : [];
      setTeams(nextTeams);
      setSelectedTeamId((current) => current ?? nextTeams[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBoards = useCallback(async (teamId: string) => {
    setError(null);
    setLoading(true);
    try {
      const payload = await requestTeam<{ boards: Board[] }>(
        `/api/teams/${encodeURIComponent(teamId)}/boards`,
      );
      const nextBoards = Array.isArray(payload?.boards) ? payload.boards : [];
      setBoards(nextBoards);
      setSelectedBoardId((current) =>
        current && nextBoards.some((board) => board.id === current) ? current : nextBoards[0]?.id ?? null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTasks = useCallback(async (teamId: string, boardId: string) => {
    setError(null);
    setLoading(true);
    try {
      const payload = await requestTeam<{ tasks: TeamTask[] }>(
        `/api/teams/${encodeURIComponent(teamId)}/boards/${encodeURIComponent(boardId)}/tasks`,
      );
      setTasks(Array.isArray(payload?.tasks) ? payload.tasks : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  useEffect(() => {
    if (!selectedTeamId) {
      setBoards([]);
      setTasks([]);
      return;
    }
    void loadBoards(selectedTeamId);
  }, [loadBoards, selectedTeamId]);

  useEffect(() => {
    if (!selectedTeamId || !selectedBoardId) {
      setTasks([]);
      return;
    }
    void loadTasks(selectedTeamId, selectedBoardId);
  }, [loadBoards, loadTasks, selectedBoardId, selectedTeamId]);

  const statusColor = (status?: string) => {
    const value = (status ?? "").toLowerCase();
    if (value.includes("done") || value.includes("complete")) return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    if (value.includes("review")) return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    if (value.includes("progress") || value.includes("doing")) return "bg-sky-500/15 text-sky-600 dark:text-sky-400";
    if (value.includes("todo") || value.includes("pending")) return "bg-muted text-muted-foreground";
    return "bg-muted text-muted-foreground";
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Kanban size={16} className="text-foreground" />
          <h2 className="text-sm font-semibold">Team Board</h2>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void (selectedTeamId
              ? loadBoards(selectedTeamId)
              : loadTeams())}
            title="Refresh"
            aria-label="Refresh"
            disabled={loading}
          >
            <RefreshCw size={14} className={cn(loading && "animate-spin")} />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={props.onClose} title="Close" aria-label="Close">
            <X size={14} />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="px-4 py-3">
          <Alert variant="destructive">
            <AlertTitle>Team service unavailable</AlertTitle>
            <AlertDescription>
              {error}. Set <code>TEAM_AUTONOMY_ENABLED=1</code> on the Den host and make sure you are signed in.
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <ScrollAreaViewport>
          <div className="space-y-3 p-4">
            <Card variant="outline" size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Users size={14} />
                  Teams
                </CardTitle>
                <CardDescription>Teams you belong to in this organization.</CardDescription>
              </CardHeader>
              <div className="flex flex-wrap gap-2 px-4 pb-4">
                {teams.length === 0 && !loading ? (
                  <span className="text-sm text-muted-foreground">No teams found.</span>
                ) : null}
                {teams.map((team) => (
                  <Button
                    key={team.id}
                    variant={team.id === selectedTeamId ? "default" : "outline"}
                    size="sm"
                    onClick={() => {
                      setSelectedTeamId(team.id);
                      setSelectedBoardId(null);
                    }}
                  >
                    {team.name}
                  </Button>
                ))}
              </div>
            </Card>

            {selectedTeam ? (
              <Card variant="outline" size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Kanban size={14} />
                    {selectedTeam.name}
                  </CardTitle>
                  <CardDescription>Boards on this team.</CardDescription>
                </CardHeader>
                <div className="space-y-2 px-4 pb-4">
                  {boards.length === 0 && !loading ? (
                    <span className="text-sm text-muted-foreground">No boards yet.</span>
                  ) : null}
                  {boards.map((board) => (
                    <button
                      key={board.id}
                      type="button"
                      onClick={() => setSelectedBoardId(board.id)}
                      className={cn(
                        "w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                        board.id === selectedBoardId
                          ? "border-primary/40 bg-primary/5"
                          : "border-border hover:bg-muted/50",
                      )}
                    >
                      <div className="font-medium">{board.name}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {board.columns.join(" · ")}
                      </div>
                    </button>
                  ))}
                </div>
              </Card>
            ) : null}

            {selectedTeam && selectedBoard ? (
              <Card variant="outline" size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <CheckCircle2 size={14} />
                    {selectedBoard.name}
                  </CardTitle>
                  <CardDescription>Tasks on this board.</CardDescription>
                </CardHeader>
                <ScrollArea className="max-h-72">
                  <ScrollAreaViewport>
                    <div className="space-y-2 px-4 pb-4">
                      {tasks.length === 0 && !loading ? (
                        <span className="text-sm text-muted-foreground">No tasks yet.</span>
                      ) : null}
                      {tasks.map((task) => (
                        <div
                          key={task.id}
                          className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                        >
                          <span className="text-sm">{task.title ?? task.summary ?? task.id}</span>
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                              statusColor(task.status),
                            )}
                          >
                            {task.status ?? "unspecified"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </ScrollAreaViewport>
                </ScrollArea>
              </Card>
            ) : null}

            {loading ? (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <Loader2 className="animate-spin" size={16} />
              </div>
            ) : null}
          </div>
        </ScrollAreaViewport>
      </ScrollArea>
    </div>
  );
}