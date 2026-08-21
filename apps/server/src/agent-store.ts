/**
 * Agent Store - 智能体定义存储
 *
 * Agent 以 .md 文件格式存储（类似 OpenCode 的 agent.md），
 * 包含 YAML frontmatter 元数据和 system prompt 正文。
 * 支持：CRUD、版本管理、作为 team/solo 调用对象。
 */

import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  metadata: {
    version: string;
    author?: string;
    tags: string[];
    modelRecommendation?: { providerID: string; modelID: string };
    capabilities: string[];
    createdAt: string;
    updatedAt: string;
  };
  source: "local" | "marketplace" | "builtin";
  path?: string;
}

export interface AgentCreateInput {
  name: string;
  description?: string;
  systemPrompt: string;
  tags?: string[];
  modelRecommendation?: { providerID: string; modelID: string };
  capabilities?: string[];
}

export interface AgentUpdateInput {
  name?: string;
  description?: string;
  systemPrompt?: string;
  tags?: string[];
  modelRecommendation?: { providerID: string; modelID: string };
  capabilities?: string[];
}

export class AgentStore {
  private agentsDir: string;

  constructor(agentsDir: string) {
    this.agentsDir = agentsDir;
  }

  async init(): Promise<void> {
    try {
      await mkdir(this.agentsDir, { recursive: true });
    } catch {
      // already exists
    }
  }

  async list(): Promise<AgentDefinition[]> {
    await this.init();
    const entries = await readdir(this.agentsDir, { withFileTypes: true });
    const agents: AgentDefinition[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const indexPath = join(this.agentsDir, entry.name, "agent.md");
        try {
          const content = await readFile(indexPath, "utf-8");
          const agent = this.parseAgent(content, entry.name);
          agents.push({ ...agent, path: indexPath });
        } catch {
          // skip directories without agent.md
        }
      } else if (entry.isFile() && entry.name.endsWith(".agent.md")) {
        const id = entry.name.replace(".agent.md", "");
        try {
          const content = await readFile(join(this.agentsDir, entry.name), "utf-8");
          const agent = this.parseAgent(content, id);
          agents.push({ ...agent, path: join(this.agentsDir, entry.name) });
        } catch {
          // skip invalid files
        }
      }
    }

    return agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<AgentDefinition | null> {
    await this.init();

    // Try directory-based layout first
    const dirPath = join(this.agentsDir, id, "agent.md");
    try {
      const content = await readFile(dirPath, "utf-8");
      return { ...this.parseAgent(content, id), path: dirPath };
    } catch {
      // try flat file layout
    }

    // Try flat file layout
    const filePath = join(this.agentsDir, `${id}.agent.md`);
    try {
      const content = await readFile(filePath, "utf-8");
      return { ...this.parseAgent(content, id), path: filePath };
    } catch {
      return null;
    }
  }

  async create(input: AgentCreateInput): Promise<AgentDefinition> {
    await this.init();
    const id = this.slugify(input.name);
    const now = new Date().toISOString();

    const agent: AgentDefinition = {
      id,
      name: input.name,
      description: input.description ?? "",
      systemPrompt: input.systemPrompt,
      metadata: {
        version: "1.0.0",
        tags: input.tags ?? [],
        modelRecommendation: input.modelRecommendation,
        capabilities: input.capabilities ?? [],
        createdAt: now,
        updatedAt: now,
      },
      source: "local",
    };

    const content = this.serializeAgent(agent);
    const agentDir = join(this.agentsDir, id);
    await mkdir(agentDir, { recursive: true });
    const filePath = join(agentDir, "agent.md");
    await writeFile(filePath, content, "utf-8");

    return { ...agent, path: filePath };
  }

  async update(id: string, input: AgentUpdateInput): Promise<AgentDefinition | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const updated: AgentDefinition = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      systemPrompt: input.systemPrompt ?? existing.systemPrompt,
      metadata: {
        ...existing.metadata,
        tags: input.tags ?? existing.metadata.tags,
        modelRecommendation: input.modelRecommendation ?? existing.metadata.modelRecommendation,
        capabilities: input.capabilities ?? existing.metadata.capabilities,
        updatedAt: new Date().toISOString(),
      },
    };

    const content = this.serializeAgent(updated);
    const dirPath = join(this.agentsDir, id, "agent.md");
    await writeFile(dirPath, content, "utf-8");

    return { ...updated, path: dirPath };
  }

  async delete(id: string): Promise<boolean> {
    const agent = await this.get(id);
    if (!agent) return false;

    const agentDir = join(this.agentsDir, id);
    try {
      await rm(agentDir, { recursive: true });
      return true;
    } catch {
      // try flat file layout
      const filePath = join(this.agentsDir, `${id}.agent.md`);
      try {
        await rm(filePath);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * 将 agent 转为 team/solo 可调用对象
   */
  toCallable(agent: AgentDefinition): {
    agentId: string;
    systemPrompt: string;
    recommendedModel?: { providerID: string; modelID: string };
    capabilities: string[];
  } {
    return {
      agentId: agent.id,
      systemPrompt: agent.systemPrompt,
      recommendedModel: agent.metadata.modelRecommendation,
      capabilities: agent.metadata.capabilities,
    };
  }

  private parseAgent(content: string, id: string): AgentDefinition {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    let metadata: Record<string, unknown> = {};
    let frontmatterName: string | undefined;
    let frontmatterDesc: string | undefined;

    let body = content;

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      body = content.slice(frontmatterMatch[0].length);

      const parsed = this.parseFrontmatter(frontmatter);
      metadata = parsed;
      frontmatterName = parsed.name;
      frontmatterDesc = parsed.description;
    }

    const systemPrompt = body.trim();
    const name = frontmatterName ?? id;
    const description = frontmatterDesc ?? "";

    const tags = this.asStringArray(metadata.tags);
    const capabilities = this.asStringArray(metadata.capabilities);
    const version = this.asString(metadata.version) ?? "1.0.0";
    const author = this.asString(metadata.author);
    const createdAt = this.asString(metadata.created_at) ?? new Date().toISOString();
    const updatedAt = this.asString(metadata.updated_at) ?? new Date().toISOString();

    let modelRecommendation: AgentDefinition["metadata"]["modelRecommendation"];
    const modelStr = this.asString(metadata.model);
    if (modelStr) {
      const [providerID, modelID] = modelStr.split("/");
      if (providerID && modelID) {
        modelRecommendation = { providerID, modelID };
      }
    }

    return {
      id,
      name,
      description,
      systemPrompt,
      metadata: {
        version,
        author,
        tags,
        modelRecommendation,
        capabilities,
        createdAt,
        updatedAt,
      },
      source: "local",
    };
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  private asStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    if (typeof value === "string" && value) return [value];
    return [];
  }

  private parseFrontmatter(frontmatter: string): Partial<AgentDefinition["metadata"]> & { name?: string; description?: string } {
    const result: Record<string, unknown> = {};
    const lines = frontmatter.split("\n");
    let currentKey: string | null = null;
    let currentValue = "";
    let isMultilineArray = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Multi-line array item
      if (isMultilineArray && trimmed.startsWith("- ")) {
        const list = result[currentKey!] as string[] | undefined;
        if (Array.isArray(list)) {
          list.push(trimmed.slice(2));
        }
        continue;
      }

      // List item
      if (trimmed.startsWith("- ") && currentKey && !isMultilineArray) {
        const list = result[currentKey] as string[] | undefined;
        if (Array.isArray(list)) {
          list.push(trimmed.slice(2));
        }
        continue;
      }

      // Key: value
      const kvMatch = trimmed.match(/^([\w-]+):\s*(.*)$/);
      if (kvMatch) {
        // Flush previous key-value
        if (currentKey && currentValue) {
          const existing = result[currentKey];
          if (Array.isArray(existing)) {
            existing.push(currentValue);
          } else {
            result[currentKey] = currentValue;
          }
        }

        currentKey = kvMatch[1];
        currentValue = kvMatch[2] || "";

        if (!kvMatch[2] || kvMatch[2] === "[]") {
          result[currentKey] = [];
          isMultilineArray = true;
        } else {
          // Handle inline arrays: [item1, item2]
          const arrayMatch = kvMatch[2].match(/^\[(.*)\]$/);
          if (arrayMatch) {
            result[currentKey] = arrayMatch[1]
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            isMultilineArray = false;
          } else {
            result[currentKey] = kvMatch[2];
            isMultilineArray = false;
          }
        }
        continue;
      }

      // Multi-line string continuation
      if (currentKey && trimmed && !kvMatch) {
        currentValue += (currentValue ? " " : "") + trimmed;
      }
    }

    // Flush last key-value
    if (currentKey && currentValue) {
      const existing = result[currentKey];
      if (Array.isArray(existing)) {
        existing.push(currentValue);
      } else {
        result[currentKey] = currentValue;
      }
    }

    return result as Partial<AgentDefinition["metadata"]> & { name?: string; description?: string };
  }

  private serializeAgent(agent: AgentDefinition): string {
    const lines: string[] = ["---"];
    lines.push(`name: ${agent.name}`);
    if (agent.description) {
      lines.push(`description: ${agent.description}`);
    }
    lines.push(`version: ${agent.metadata.version}`);
    if (agent.metadata.author) {
      lines.push(`author: ${agent.metadata.author}`);
    }
    if (agent.metadata.tags.length > 0) {
      lines.push("tags:");
      for (const tag of agent.metadata.tags) {
        lines.push(`  - ${tag}`);
      }
    }
    if (agent.metadata.modelRecommendation) {
      lines.push(`model: ${agent.metadata.modelRecommendation.providerID}/${agent.metadata.modelRecommendation.modelID}`);
    }
    if (agent.metadata.capabilities.length > 0) {
      lines.push("capabilities:");
      for (const cap of agent.metadata.capabilities) {
        lines.push(`  - ${cap}`);
      }
    }
    lines.push(`created_at: ${agent.metadata.createdAt}`);
    lines.push(`updated_at: ${agent.metadata.updatedAt}`);
    lines.push("---");
    lines.push("");
    lines.push(agent.systemPrompt);
    lines.push("");

    return lines.join("\n");
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "agent";
  }
}