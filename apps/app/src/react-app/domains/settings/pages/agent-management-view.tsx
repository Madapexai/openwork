/** @jsxImportSource react */
import { useState, useEffect, useCallback } from "react";
import {
  Bot,
  Plus,
  Trash2,
  Edit3,
  Search,
  Tag,
  Cpu,
  Play,
  X,
  Check,
  Loader2,
  Sparkles,
  Users,
  User,
} from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Textarea } from "../../../components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../../components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Badge } from "../../../components/ui/badge";
import { ScrollArea, ScrollAreaViewport } from "../../../components/ui/scroll-area";
import { SettingsGroupHeader } from "../settings-section";
import { cn } from "../../../lib/utils";

interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  metadata: {
    version: string;
    tags: string[];
    modelRecommendation?: { providerID: string; modelID: string };
    capabilities: string[];
    createdAt: string;
    updatedAt: string;
  };
  source: "local" | "marketplace" | "builtin";
  path?: string;
}

interface AgentFormData {
  name: string;
  description: string;
  systemPrompt: string;
  tags: string[];
  tagInput: string;
  providerID: string;
  modelID: string;
  capabilities: string[];
}

const emptyForm: AgentFormData = {
  name: "",
  description: "",
  systemPrompt: "",
  tags: [],
  tagInput: "",
  providerID: "",
  modelID: "",
  capabilities: [],
};

export function AgentManagementView() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentDefinition | null>(null);
  const [form, setForm] = useState<AgentFormData>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"all" | "team" | "solo">("all");

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/agents");
      if (!resp.ok) throw new Error("Failed to fetch agents");
      const data = await resp.json();
      setAgents(data.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  const filteredAgents = agents.filter(
    (a) =>
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.description.toLowerCase().includes(search.toLowerCase()) ||
      a.id.toLowerCase().includes(search.toLowerCase())
  );

  const openCreate = () => {
    setEditingAgent(null);
    setForm(emptyForm);
    setShowCreate(true);
  };

  const openEdit = (agent: AgentDefinition) => {
    setEditingAgent(agent);
    setForm({
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      tags: agent.metadata.tags,
      tagInput: "",
      providerID: agent.metadata.modelRecommendation?.providerID ?? "",
      modelID: agent.metadata.modelRecommendation?.modelID ?? "",
      capabilities: agent.metadata.capabilities,
    });
    setShowCreate(true);
  };

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.systemPrompt.trim()) {
      setError("Name and system prompt are required");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim(),
        systemPrompt: form.systemPrompt,
        tags: form.tags,
        modelRecommendation: form.providerID && form.modelID
          ? { providerID: form.providerID, modelID: form.modelID }
          : undefined,
        capabilities: form.capabilities,
      };

      const url = editingAgent
        ? `/api/agents/${editingAgent.id}`
        : "/api/agents";
      const method = editingAgent ? "PUT" : "POST";

      const resp = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) throw new Error("Failed to save agent");

      setShowCreate(false);
      setEditingAgent(null);
      setForm(emptyForm);
      await fetchAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save agent");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this agent? This action cannot be undone.")) return;

    setLoading(true);
    try {
      const resp = await fetch(`/api/agents/${id}`, { method: "DELETE" });
      if (!resp.ok) throw new Error("Failed to delete agent");
      await fetchAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete agent");
    } finally {
      setLoading(false);
    }
  };

  const addTag = () => {
    const tag = form.tagInput.trim();
    if (tag && !form.tags.includes(tag)) {
      setForm({ ...form, tags: [...form.tags, tag], tagInput: "" });
    }
  };

  const removeTag = (tag: string) => {
    setForm({ ...form, tags: form.tags.filter((t) => t !== tag) });
  };

  const toggleCapability = (cap: string) => {
    setForm({
      ...form,
      capabilities: form.capabilities.includes(cap)
        ? form.capabilities.filter((c) => c !== cap)
        : [...form.capabilities, cap],
    });
  };

  return (
    <div className="space-y-6">
      <SettingsGroupHeader
        title="智能体管理"
        description="创建、编辑和管理智能体。智能体可作为团队模式和单人模式的可调用对象。"
        icon={<Bot size={18} />}
      />

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索智能体..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="mr-1 h-4 w-4" />
          新建智能体
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList>
          <TabsTrigger value="all">
            <User className="mr-1 h-3.5 w-3.5" />
            全部 ({agents.length})
          </TabsTrigger>
          <TabsTrigger value="team">
            <Users className="mr-1 h-3.5 w-3.5" />
            团队模式可用
          </TabsTrigger>
          <TabsTrigger value="solo">
            <Sparkles className="mr-1 h-3.5 w-3.5" />
            单人模式可用
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="mt-4">
          <AgentGrid
            agents={filteredAgents}
            loading={loading}
            onEdit={openEdit}
            onDelete={handleDelete}
          />
        </TabsContent>

        <TabsContent value="team" className="mt-4">
          <AgentGrid
            agents={filteredAgents.filter((a) =>
              a.metadata.capabilities.includes("team-compatible") ||
              a.metadata.capabilities.length === 0
            )}
            loading={loading}
            onEdit={openEdit}
            onDelete={handleDelete}
          />
        </TabsContent>

        <TabsContent value="solo" className="mt-4">
          <AgentGrid
            agents={filteredAgents.filter((a) =>
              a.metadata.capabilities.includes("solo-compatible") ||
              a.metadata.capabilities.length === 0
            )}
            loading={loading}
            onEdit={openEdit}
            onDelete={handleDelete}
          />
        </TabsContent>
      </Tabs>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>
              {editingAgent ? "编辑智能体" : "创建智能体"}
            </DialogTitle>
            <DialogDescription>
              智能体以 .md 文件存储，包含 YAML frontmatter 元数据和 system prompt 正文。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="agent-name">名称 *</Label>
              <Input
                id="agent-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：代码审查专家"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="agent-desc">描述</Label>
              <Input
                id="agent-desc"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="智能体的功能简介"
              />
            </div>

            <div className="space-y-2">
              <Label>标签</Label>
              <div className="flex gap-2">
                <Input
                  value={form.tagInput}
                  onChange={(e) => setForm({ ...form, tagInput: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                  placeholder="输入标签后按 Enter"
                />
                <Button type="button" variant="outline" size="icon" onClick={addTag}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {form.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {form.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                      <Tag className="h-3 w-3" />
                      {tag}
                      <button
                        type="button"
                        onClick={() => removeTag(tag)}
                        className="ml-1 rounded-full hover:bg-muted"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>推荐 Provider</Label>
                <Select
                  value={form.providerID}
                  onValueChange={(v) => setForm({ ...form, providerID: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择 Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">不指定</SelectItem>
                    <SelectItem value="deepseek">DeepSeek</SelectItem>
                    <SelectItem value="dashscope">DashScope (阿里云)</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="google">Google</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>推荐 Model</Label>
                <Input
                  value={form.modelID}
                  onChange={(e) => setForm({ ...form, modelID: e.target.value })}
                  placeholder="例如：deepseek-coder"
                  disabled={!form.providerID}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>能力标记</Label>
              <div className="flex flex-wrap gap-2">
                {[
                  { id: "team-compatible", label: "团队模式" },
                  { id: "solo-compatible", label: "单人模式" },
                  { id: "code-review", label: "代码审查" },
                  { id: "testing", label: "测试" },
                  { id: "documentation", label: "文档" },
                  { id: "planning", label: "规划" },
                ].map((cap) => (
                  <button
                    key={cap.id}
                    type="button"
                    onClick={() => toggleCapability(cap.id)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs transition-colors",
                      form.capabilities.includes(cap.id)
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-input hover:border-muted-foreground"
                    )}
                  >
                    {form.capabilities.includes(cap.id) && (
                      <Check className="h-3 w-3" />
                    )}
                    {cap.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="agent-prompt">System Prompt *</Label>
              <Textarea
                id="agent-prompt"
                value={form.systemPrompt}
                onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                placeholder="定义智能体的 system prompt..."
                className="min-h-[150px] font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                这段 prompt 将作为智能体的系统指令，在 team/solo 模式下被调用。
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowCreate(false);
                setError(null);
              }}
            >
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1 h-4 w-4" />
              )}
              {editingAgent ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AgentGrid({
  agents,
  loading,
  onEdit,
  onDelete,
}: {
  agents: AgentDefinition[];
  loading: boolean;
  onEdit: (agent: AgentDefinition) => void;
  onDelete: (id: string) => void;
}) {
  if (loading && agents.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中...
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Bot className="mb-3 h-10 w-10 opacity-30" />
        <p className="text-sm">暂无智能体</p>
        <p className="text-xs mt-1">点击"新建智能体"创建第一个智能体</p>
      </div>
    );
  }

  return (
    <ScrollArea>
      <ScrollAreaViewport>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <Card key={agent.id} className="group transition-all hover:shadow-md">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
                      <Bot className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">{agent.name}</CardTitle>
                      <p className="text-xs text-muted-foreground">{agent.id}</p>
                    </div>
                  </div>
                  <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button variant="ghost" size="icon-sm" onClick={() => onEdit(agent)}>
                      <Edit3 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onDelete(agent.id)}
                      className="hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {agent.description && (
                  <CardDescription className="line-clamp-2 text-xs">
                    {agent.description}
                  </CardDescription>
                )}

                {agent.metadata.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {agent.metadata.tags.slice(0, 3).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px]">
                        {tag}
                      </Badge>
                    ))}
                    {agent.metadata.tags.length > 3 && (
                      <Badge variant="outline" className="text-[10px]">
                        +{agent.metadata.tags.length - 3}
                      </Badge>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Cpu className="h-3 w-3" />
                    {agent.metadata.modelRecommendation
                      ? `${agent.metadata.modelRecommendation.providerID}/${agent.metadata.modelRecommendation.modelID}`
                      : "使用默认模型"}
                  </div>
                  <div className="flex items-center gap-1">
                    <Play className="h-3 w-3" />
                    {agent.source === "local" ? "本地" : agent.source === "marketplace" ? "市场" : "内置"}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollAreaViewport>
    </ScrollArea>
  );
}