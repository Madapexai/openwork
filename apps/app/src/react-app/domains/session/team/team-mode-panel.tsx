/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Cpu,
  Gauge,
  GitBranch,
  Network,
  Plus,
  Play,
  Rocket,
  Server,
  Settings,
  Shield,
  Sparkles,
  Trash2,
  Users,
  X,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type TeamStrategyId = "conservative" | "balanced" | "aggressive";
type HarnessKind = "local" | "ssh" | "cloud" | "container";
type MemberRole = "primary" | "specialist" | "reviewer" | "fallback" | "observer";

type TeamSummary = {
  id: string;
  name: string;
  strategy: TeamStrategyId;
  memberCount: number;
  harnessId: string;
  status: "idle" | "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
};

type TeamDetail = TeamSummary & {
  memberSpecs: Array<{ agentId: string; role?: string }>;
  lastTaskResult?: {
    taskId: string;
    subtasks: Array<{ subtaskId: string; agentId: string; prompt: string; status: string }>;
    completedAt: number;
  };
};

type StrategyInfo = {
  id: TeamStrategyId;
  name: string;
  description: string;
  complexity: "low" | "medium" | "high";
  costLevel: "low" | "medium" | "high";
  qualityLevel: "low" | "medium" | "high";
  maxSubtasks: number;
  enableReviewLoop: boolean;
};

type HarnessInfo = {
  id: string;
  kind: HarnessKind;
  name: string;
  description: string;
  capabilities: {
    pty: boolean;
    acp: boolean;
    http: boolean;
    mcp: boolean;
    gpu: boolean;
    docker: boolean;
    maxConcurrentAgents: number;
  };
  rootPath?: string;
  health?: {
    status: "healthy" | "degraded" | "unreachable";
    latencyMs: number;
    lastCheckedAt: number;
    message?: string;
  };
};

type DecompositionResult = {
  taskId: string;
  complexity: "low" | "medium" | "high";
  strategy: TeamStrategyId;
  strategyMeta: StrategyInfo;
  suggestedApproach: string;
  subtasks: Array<{
    subtaskId: string;
    agentId: string;
    prompt: string;
    dependencies: string[];
  }>;
  estimatedCost: { low: number; high: number };
};

type TeamRunResult = {
  taskId: string;
  strategy: TeamStrategyId;
  complexity: "low" | "medium" | "high";
  subtasks: Array<{
    subtaskId: string;
    agentId: string;
    prompt: string;
    dependencies: string[];
  }>;
  status: "planned" | "running" | "completed" | "failed";
  message: string;
  harnessId: string;
};

type TeamPanelProps = {
  onClose: () => void;
};

type CreateTeamState = {
  name: string;
  strategy: TeamStrategyId;
  harnessId: string;
  members: Array<{ agentId: string; role: MemberRole }>;
};

const ROLE_OPTIONS: MemberRole[] = ["primary", "specialist", "reviewer", "fallback", "observer"];

const ROLE_LABELS: Record<MemberRole, string> = {
  primary: "Primary",
  specialist: "Specialist",
  reviewer: "Reviewer",
  fallback: "Fallback",
  observer: "Observer",
};

const STRATEGY_META: Record<TeamStrategyId, { color: string; icon: typeof Gauge; badge: string }> = {
  conservative: { color: "text-emerald-500", icon: Gauge, badge: "bg-emerald-500/10 text-emerald-600" },
  balanced: { color: "text-amber-500", icon: Gauge, badge: "bg-amber-500/10 text-amber-600" },
  aggressive: { color: "text-violet-500", icon: Rocket, badge: "bg-violet-500/10 text-violet-600" },
};

const HARNESS_ICONS: Record<HarnessKind, typeof Server> = {
  local: Server,
  ssh: Network,
  cloud: Cloud,
  container: Cpu,
};

// ---------- API helpers ----------

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function getStatusColor(status: string) {
  switch (status) {
    case "idle":
      return "bg-gray-500/10 text-gray-500";
    case "running":
      return "bg-sky-500/10 text-sky-500 animate-pulse";
    case "completed":
      return "bg-emerald-500/10 text-emerald-600";
    case "failed":
      return "bg-red-500/10 text-red-600";
    default:
      return "bg-gray-500/10 text-gray-500";
  }
}

// ---------- Main Panel ----------

export function TeamPanel(props: TeamPanelProps) {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [teamDetail, setTeamDetail] = useState<TeamDetail | null>(null);
  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [decomposing, setDecomposing] = useState(false);
  const [decompositionResult, setDecompositionResult] = useState<DecompositionResult | null>(null);
  const [taskPrompt, setTaskPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<TeamRunResult | null>(null);

  const selectedTeam = useMemo(
    () => teams.find((t) => t.id === selectedTeamId) ?? null,
    [selectedTeamId, teams],
  );

  const loadData = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [teamsData, strategiesData, harnessesData] = await Promise.all([
        apiRequest<{ teams: TeamSummary[] }>("/teams"),
        apiRequest<{ strategies: StrategyInfo[] }>("/team-strategies"),
        apiRequest<{ harnesses: HarnessInfo[] }>("/team-harnesses"),
      ]);
      setTeams(teamsData.teams);
      setStrategies(strategiesData.strategies);
      setHarnesses(harnessesData.harnesses);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTeamDetail = useCallback(async (teamId: string) => {
    try {
      const data = await apiRequest<{ team: TeamDetail }>(`/teams/${teamId}`);
      setTeamDetail(data.team);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (selectedTeamId) {
      void loadTeamDetail(selectedTeamId);
    } else {
      setTeamDetail(null);
    }
  }, [selectedTeamId, loadTeamDetail]);

  const handleCreateTeam = useCallback(async (state: CreateTeamState) => {
    try {
      const data = await apiRequest<{ team: TeamDetail }>("/teams", {
        method: "POST",
        body: JSON.stringify({
          name: state.name,
          strategy: state.strategy,
          harnessId: state.harnessId,
          members: state.members,
        }),
      });
      setTeams((prev) => [...prev, {
        id: data.team.id,
        name: data.team.name,
        strategy: data.team.strategy,
        memberCount: data.team.memberSpecs.length,
        harnessId: data.team.harnessId,
        status: data.team.status,
        createdAt: data.team.createdAt,
        updatedAt: data.team.updatedAt,
      }]);
      setSelectedTeamId(data.team.id);
      setShowCreateDialog(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleDecompose = useCallback(async () => {
    if (!selectedTeamId || !taskPrompt.trim()) return;
    setDecomposing(true);
    setDecompositionResult(null);
    setError(null);
    try {
      const data = await apiRequest<{ decomposition: DecompositionResult }>(
        `/teams/${selectedTeamId}/decompose`,
        {
          method: "POST",
          body: JSON.stringify({ taskPrompt }),
        },
      );
      setDecompositionResult(data.decomposition);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDecomposing(false);
    }
  }, [selectedTeamId, taskPrompt]);

  const handleRunTask = useCallback(async () => {
    if (!selectedTeamId || !taskPrompt.trim()) return;
    setRunning(true);
    setRunResult(null);
    setError(null);
    try {
      const data = await apiRequest<{ task: TeamRunResult }>(
        `/teams/${selectedTeamId}/run`,
        {
          method: "POST",
          body: JSON.stringify({ taskPrompt }),
        },
      );
      setRunResult(data.task);
      setSelectedTeamId((current) => {
        if (current) void loadTeamDetail(current);
        return current;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [selectedTeamId, taskPrompt, loadTeamDetail]);

  const handleDeleteTeam = useCallback(async (teamId: string) => {
    try {
      await apiRequest(`/teams/${teamId}`, { method: "DELETE" });
      setTeams((prev) => prev.filter((t) => t.id !== teamId));
      if (selectedTeamId === teamId) {
        setSelectedTeamId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedTeamId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-foreground" />
          <h2 className="text-sm font-semibold">Team Mode</h2>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={loadData} title="Refresh" disabled={loading}>
            <RefreshCw size={14} className={cn(loading && "animate-spin")} />
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onClose} title="Close">
            <X size={14} />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="px-4 py-3">
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <ScrollAreaViewport>
          <div className="space-y-4 p-4">
            {/* Strategy Cards */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles size={14} />
                  <span className="text-sm font-medium">Strategy Presets</span>
                </div>
                <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline">
                      <Plus size={14} className="mr-1" />
                      Create Team
                    </Button>
                  </DialogTrigger>
                  <CreateTeamDialog
                    strategies={strategies}
                    harnesses={harnesses}
                    onSubmit={handleCreateTeam}
                    onCancel={() => setShowCreateDialog(false)}
                  />
                </Dialog>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {strategies.map((s) => {
                  const meta = STRATEGY_META[s.id];
                  const Icon = meta.icon;
                  return (
                    <Card key={s.id} variant="outline" size="sm" className="cursor-pointer transition-all hover:border-primary/40">
                      <CardContent className="p-3">
                        <div className="flex items-center gap-2">
                          <Icon size={14} className={meta.color} />
                          <span className="text-sm font-medium">{s.name}</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
                        <div className="mt-2 flex items-center gap-1">
                          <Badge variant="outline" className="text-[10px]">
                            {s.complexity}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            max {s.maxSubtasks} subtasks
                          </Badge>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>

            {/* Team List */}
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Bot size={14} />
                <span className="text-sm font-medium">Teams</span>
                <span className="text-xs text-muted-foreground">({teams.length})</span>
              </div>
              {teams.length === 0 && !loading ? (
                <Card variant="outline" size="sm">
                  <CardContent className="p-6 text-center">
                    <Users size={32} className="mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">No teams yet. Create one to get started.</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {teams.map((team) => (
                    <Card
                      key={team.id}
                      variant="outline"
                      size="sm"
                      className={cn(
                        "cursor-pointer transition-all",
                        selectedTeamId === team.id ? "border-primary/40 bg-primary/5" : "hover:bg-muted/50",
                      )}
                      onClick={() => setSelectedTeamId(team.id)}
                    >
                      <CardContent className="flex items-center justify-between p-3">
                        <div className="flex items-center gap-3">
                          <div className={cn("rounded-md p-2", STRATEGY_META[team.strategy].badge)}>
                            <Users size={14} />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{team.name}</span>
                              <Badge variant="outline" className="text-[10px]">
                                {team.strategy}
                              </Badge>
                            </div>
                            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{team.memberCount} members</span>
                              <span>&middot;</span>
                              <span>{team.harnessId}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className={cn("text-[10px]", getStatusColor(team.status))}>
                            {team.status}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteTeam(team.id);
                            }}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>

            {/* Team Detail & Task Runner */}
            {selectedTeam && teamDetail ? (
              <div className="space-y-3">
                <Card variant="outline" size="sm">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <GitBranch size={14} />
                        {selectedTeam.name}
                      </CardTitle>
                      <Badge variant="outline" className={getStatusColor(teamDetail.status)}>
                        {teamDetail.status}
                      </Badge>
                    </div>
                    <CardDescription>
                      Strategy: {teamDetail.strategy} &middot; Harness: {teamDetail.harnessId}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <Label className="text-xs">Members ({teamDetail.memberSpecs.length})</Label>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {teamDetail.memberSpecs.map((m, i) => (
                          <Badge key={i} variant="secondary" className="text-xs">
                            <Bot size={10} className="mr-1" />
                            {m.agentId}
                            {m.role ? ` (${m.role})` : ""}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs">Task Prompt</Label>
                      <Textarea
                        placeholder="Describe the task you want the team to execute..."
                        value={taskPrompt}
                        onChange={(e) => setTaskPrompt(e.target.value)}
                        className="min-h-[80px]"
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleDecompose()}
                          disabled={!taskPrompt.trim() || decomposing}
                        >
                          <Sparkles size={14} className="mr-1" />
                          {decomposing ? "Decomposing..." : "Analyze & Decompose"}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => void handleRunTask()}
                          disabled={!taskPrompt.trim() || running}
                        >
                          <Play size={14} className="mr-1" />
                          {running ? "Running..." : "Run Team Task"}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Decomposition Result */}
                {decompositionResult ? (
                  <Card variant="outline" size="sm" className="border-primary/20">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Zap size={14} className="text-primary" />
                        Task Decomposition
                      </CardTitle>
                      <CardDescription>
                        Complexity: {decompositionResult.complexity} &middot; Strategy: {decompositionResult.strategy}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Estimated cost: ${decompositionResult.estimatedCost.low} - ${decompositionResult.estimatedCost.high}</span>
                        <span>&middot;</span>
                        <span>Approach: {decompositionResult.suggestedApproach}</span>
                      </div>
                      <div className="space-y-1">
                        {decompositionResult.subtasks.map((st, i) => (
                          <div
                            key={st.subtaskId}
                            className="rounded-md border border-border bg-muted/50 px-3 py-2"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium">Step {i + 1}</span>
                              <Badge variant="outline" className="text-[10px]">
                                {st.agentId}
                              </Badge>
                              {st.dependencies.length > 0 ? (
                                <span className="text-[10px] text-muted-foreground">
                                  depends on: {st.dependencies.join(", ")}
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{st.prompt}</p>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ) : null}

                {/* Run Result */}
                {runResult ? (
                  <Card variant="outline" size="sm" className="border-emerald-200">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Rocket size={14} className="text-emerald-500" />
                        Task Execution Plan
                      </CardTitle>
                      <CardDescription>{runResult.message}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-1">
                        {runResult.subtasks.map((st, i) => (
                          <div
                            key={st.subtaskId}
                            className="flex items-start gap-2 rounded-md border border-border px-3 py-2"
                          >
                            <span className="mt-0.5 text-xs font-medium">{i + 1}.</span>
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <Badge variant="secondary" className="text-[10px]">
                                  <Bot size={10} className="mr-1" />
                                  {st.agentId}
                                </Badge>
                                {st.dependencies.length > 0 ? (
                                  <span className="text-[10px] text-muted-foreground">
                                    needs: {st.dependencies.join(", ")}
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">{st.prompt}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ) : null}
              </div>
            ) : null}

            {/* Harness List */}
            {harnesses.length > 0 ? (
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <Server size={14} />
                  <span className="text-sm font-medium">Harness Environments</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {harnesses.map((h) => {
                    const Icon = HARNESS_ICONS[h.kind];
                    return (
                      <Card key={h.id} variant="outline" size="sm">
                        <CardContent className="p-3">
                          <div className="flex items-center gap-2">
                            <Icon size={14} className="text-muted-foreground" />
                            <span className="text-sm font-medium">{h.name}</span>
                            {h.health ? (
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-[10px]",
                                  h.health.status === "healthy"
                                    ? "text-emerald-600"
                                    : h.health.status === "degraded"
                                    ? "text-amber-600"
                                    : "text-red-600",
                                )}
                              >
                                {h.health.status}
                              </Badge>
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{h.description}</p>
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            {h.capabilities.maxConcurrentAgents} concurrent agents &middot; {h.kind}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </ScrollAreaViewport>
      </ScrollArea>
    </div>
  );
}

// ---------- Create Team Dialog ----------

type CreateTeamDialogProps = {
  strategies: StrategyInfo[];
  harnesses: HarnessInfo[];
  onSubmit: (state: CreateTeamState) => Promise<void>;
  onCancel: () => void;
};

function CreateTeamDialog(props: CreateTeamDialogProps) {
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState<TeamStrategyId>("balanced");
  const [harnessId, setHarnessId] = useState("local-default");
  const [members, setMembers] = useState<Array<{ agentId: string; role: MemberRole }>>([
    { agentId: "", role: "primary" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addMember = useCallback(() => {
    setMembers((prev) => [...prev, { agentId: "", role: "specialist" }]);
  }, []);

  const removeMember = useCallback((index: number) => {
    setMembers((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateMember = useCallback((index: number, field: "agentId" | "role", value: string) => {
    setMembers((prev) =>
      prev.map((m, i) => (i === index ? { ...m, [field]: value } : m)),
    );
  }, []);

  const handleSubmit = useCallback(async () => {
    setError(null);
    if (!name.trim()) {
      setError("Team name is required");
      return;
    }
    const validMembers = members.filter((m) => m.agentId.trim());
    if (validMembers.length === 0) {
      setError("At least one team member is required");
      return;
    }
    setSubmitting(true);
    try {
      await props.onSubmit({
        name: name.trim(),
        strategy,
        harnessId,
        members: validMembers,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [name, members, strategy, harnessId, props]);

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Create Team</DialogTitle>
        <DialogDescription>
          Configure a team of AI agents to work together on complex tasks.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="space-y-2">
          <Label>Team Name</Label>
          <Input
            placeholder="e.g., Backend Feature Team"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <Tabs value={strategy} onValueChange={(v) => setStrategy(v as TeamStrategyId)}>
          <TabsList className="grid w-full grid-cols-3">
            {props.strategies.map((s) => (
              <TabsTrigger key={s.id} value={s.id}>
                {s.name}
              </TabsTrigger>
            ))}
          </TabsList>
          {props.strategies.map((s) => (
            <TabsContent key={s.id} value={s.id} className="mt-2">
              <Card variant="outline" size="sm">
                <CardContent className="p-3">
                  <p className="text-sm">{s.description}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      Complexity: {s.complexity}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      Max {s.maxSubtasks} subtasks
                    </Badge>
                    {s.enableReviewLoop ? (
                      <Badge variant="outline" className="text-[10px]">
                        Review loop
                      </Badge>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          ))}
        </Tabs>

        <div className="space-y-2">
          <Label>Harness Environment</Label>
          <Select value={harnessId} onValueChange={setHarnessId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {props.harnesses.map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.name} ({h.kind})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Team Members</Label>
            <Button variant="outline" size="sm" onClick={addMember}>
              <Plus size={12} className="mr-1" />
              Add Member
            </Button>
          </div>
          <div className="space-y-2">
            {members.map((member, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder="Agent ID (e.g., opencode, kimi, deepscode)"
                  value={member.agentId}
                  onChange={(e) => updateMember(i, "agentId", e.target.value)}
                  className="flex-1"
                />
                <Select value={member.role} onValueChange={(v) => updateMember(i, "role", v)}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeMember(i)}
                  disabled={members.length <= 1}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button onClick={() => void handleSubmit()} disabled={submitting}>
          {submitting ? "Creating..." : "Create Team"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// RefreshCw component (not in UI library, inline it)
function RefreshCw(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

// Cloud icon (inline)
function Cloud(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M17.5 19a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 15.9" />
    </svg>
  );
}