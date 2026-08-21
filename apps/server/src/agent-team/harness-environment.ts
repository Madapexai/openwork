/**
 * Harness Environment - 执行环境定义与管理
 *
 * 借鉴 OpenHands 的 Runtime Env、WorkBuddy 的 Sandbox Target、
 * Devin 的 Cloud Environment，定义 team mode 可用的执行环境：
 *
 * 1. Local（本地）: 当前机器，所有 agent 在本地进程运行
 * 2. SSH Remote（SSH 远程）: 通过 SSH 连接到远程服务器，agent 在远程运行
 * 3. Cloud（云端）: OpenWork 托管的云端环境，开箱即用
 * 4. Container（容器）: Docker/OCI 容器环境，隔离执行
 *
 * 每个 harness 提供：
 * - 环境信息（OS、路径、可用工具）
 * - 连接参数（SSH、API endpoint）
 * - 能力标签（支持的协议、资源限制）
 * - 健康检查
 */

export type HarnessKind = "local" | "ssh" | "cloud" | "container";

export interface HarnessCapabilities {
  /** 是否支持 PTY 协议 */
  pty: boolean;
  /** 是否支持 ACP 协议 */
  acp: boolean;
  /** 是否支持 HTTP 协议 */
  http: boolean;
  /** 是否支持 MCP 协议 */
  mcp: boolean;
  /** 是否支持 GPU */
  gpu: boolean;
  /** 是否支持 Docker */
  docker: boolean;
  /** 最大并发 agent 数 */
  maxConcurrentAgents: number;
}

export interface HarnessHealth {
  status: "healthy" | "degraded" | "unreachable";
  latencyMs: number;
  lastCheckedAt: number;
  message?: string;
}

export interface HarnessDefinition {
  id: string;
  kind: HarnessKind;
  name: string;
  description: string;
  capabilities: HarnessCapabilities;
  /** 工作目录根路径 */
  rootPath?: string;
  /** SSH 配置（kind=ssh 时） */
  sshConfig?: {
    host: string;
    port: number;
    username: string;
    privateKeyPath?: string;
    knownHostsPath?: string;
    jumpHost?: string;
  };
  /** Cloud 配置（kind=cloud 时） */
  cloudConfig?: {
    endpoint: string;
    authToken?: string;
    region?: string;
  };
  /** Container 配置（kind=container 时） */
  containerConfig?: {
    image: string;
    dockerSocket?: string;
    memoryLimit?: string;
    cpuLimit?: string;
  };
  health?: HarnessHealth;
}

/**
 * 本地 harness 预设
 */
export function createLocalHarness(options?: { rootPath?: string }): HarnessDefinition {
  return {
    id: "local-default",
    kind: "local",
    name: "本地环境",
    description: "当前机器的本地执行环境，所有 agent 在本地进程中运行。",
    capabilities: {
      pty: true,
      acp: true,
      http: true,
      mcp: true,
      gpu: false,
      docker: false,
      maxConcurrentAgents: 4,
    },
    rootPath: options?.rootPath ?? process.cwd(),
    health: {
      status: "healthy",
      latencyMs: 0,
      lastCheckedAt: Date.now(),
      message: "Local harness is always available",
    },
  };
}

/**
 * SSH 远程 harness 工厂
 */
export function createSshHarness(config: {
  id?: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  rootPath?: string;
  jumpHost?: string;
}): HarnessDefinition {
  return {
    id: config.id ?? `ssh-${config.host}-${Date.now().toString(36)}`,
    kind: "ssh",
    name: config.name,
    description: `通过 SSH 连接到远程服务器 ${config.host}，agent 在远程环境中运行。`,
    capabilities: {
      pty: true,
      acp: true,
      http: true,
      mcp: false,
      gpu: false,
      docker: false,
      maxConcurrentAgents: 8,
    },
    rootPath: config.rootPath ?? "/tmp/openwork",
    sshConfig: {
      host: config.host,
      port: config.port ?? 22,
      username: config.username,
      privateKeyPath: config.privateKeyPath,
      jumpHost: config.jumpHost,
    },
  };
}

/**
 * Cloud harness 工厂
 */
export function createCloudHarness(config: {
  id?: string;
  name?: string;
  endpoint?: string;
  authToken?: string;
  region?: string;
}): HarnessDefinition {
  return {
    id: config.id ?? "cloud-default",
    kind: "cloud",
    name: config.name ?? "OpenWork Cloud",
    description: "OpenWork 托管的云端执行环境，开箱即用，自动扩展。",
    capabilities: {
      pty: true,
      acp: true,
      http: true,
      mcp: true,
      gpu: true,
      docker: true,
      maxConcurrentAgents: 16,
    },
    cloudConfig: {
      endpoint: config.endpoint ?? "https://api.openworklabs.com",
      authToken: config.authToken,
      region: config.region ?? "auto",
    },
  };
}

/**
 * Container harness 工厂
 */
export function createContainerHarness(config: {
  id?: string;
  name: string;
  image?: string;
  dockerSocket?: string;
  memoryLimit?: string;
  cpuLimit?: string;
}): HarnessDefinition {
  return {
    id: config.id ?? `container-${Date.now().toString(36)}`,
    kind: "container",
    name: config.name,
    description: `Docker 容器环境，使用 ${config.image ?? "openwork/agent:latest"} 镜像隔离执行。`,
    capabilities: {
      pty: true,
      acp: true,
      http: true,
      mcp: false,
      gpu: false,
      docker: true,
      maxConcurrentAgents: 4,
    },
    containerConfig: {
      image: config.image ?? "openwork/agent:latest",
      dockerSocket: config.dockerSocket,
      memoryLimit: config.memoryLimit,
      cpuLimit: config.cpuLimit,
    },
  };
}

/**
 * Harness 管理器
 *
 * 负责注册、存储和查询可用的执行环境。
 * 支持持久化到 JSON 文件，支持健康检查。
 */
export class HarnessManager {
  private readonly harnesses = new Map<string, HarnessDefinition>();
  private readonly storagePath?: string;

  constructor(options?: { storagePath?: string }) {
    this.storagePath = options?.storagePath;
    this.registerHarness(createLocalHarness());
  }

  /** 注册一个 harness */
  registerHarness(harness: HarnessDefinition): void {
    this.harnesses.set(harness.id, harness);
  }

  /** 移除一个 harness */
  removeHarness(id: string): boolean {
    return this.harnesses.delete(id);
  }

  /** 获取指定 harness */
  getHarness(id: string): HarnessDefinition | undefined {
    return this.harnesses.get(id);
  }

  /** 列出所有 harness */
  listHarnesses(): HarnessDefinition[] {
    return Array.from(this.harnesses.values());
  }

  /** 按类型筛选 harness */
  listByKind(kind: HarnessKind): HarnessDefinition[] {
    return Array.from(this.harnesses.values()).filter((h) => h.kind === kind);
  }

  /** 检查 harness 健康状态 */
  async checkHealth(id: string): Promise<HarnessHealth> {
    const harness = this.harnesses.get(id);
    if (!harness) {
      return {
        status: "unreachable",
        latencyMs: -1,
        lastCheckedAt: Date.now(),
        message: "Harness not found",
      };
    }

    const start = Date.now();

    switch (harness.kind) {
      case "local":
        return {
          status: "healthy",
          latencyMs: Date.now() - start,
          lastCheckedAt: Date.now(),
          message: "Local harness",
        };

      case "ssh":
        return this.checkSshHealth(harness, start);

      case "cloud":
        return this.checkCloudHealth(harness, start);

      case "container":
        return this.checkContainerHealth(harness, start);

      default:
        return {
          status: "unreachable",
          latencyMs: Date.now() - start,
          lastCheckedAt: Date.now(),
          message: `Unknown harness kind: ${harness.kind}`,
        };
    }
  }

  /** 检查所有 harness 健康状态 */
  async checkAllHealth(): Promise<Map<string, HarnessHealth>> {
    const results = new Map<string, HarnessHealth>();
    await Promise.all(
      Array.from(this.harnesses.keys()).map(async (id) => {
        results.set(id, await this.checkHealth(id));
      }),
    );
    return results;
  }

  private async checkSshHealth(harness: HarnessDefinition, start: number): Promise<HarnessHealth> {
    if (!harness.sshConfig) {
      return {
        status: "unreachable",
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
        message: "SSH config missing",
      };
    }

    try {
      const { spawn } = await import("node:child_process");
      const args = [
        "-o", "ConnectTimeout=5",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no",
        "-p", String(harness.sshConfig.port),
      ];
      if (harness.sshConfig.jumpHost) {
        args.push("-J", harness.sshConfig.jumpHost);
      }
      args.push(`${harness.sshConfig.username}@${harness.sshConfig.host}`, "echo ok");

      return new Promise<HarnessHealth>((resolve) => {
        const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let errored = false;

        child.stdout?.on("data", (d) => (output += d.toString()));
        child.stderr?.on("data", () => (errored = true));

        child.on("close", (code) => {
          resolve({
            status: code === 0 && output.includes("ok") ? "healthy" : "unreachable",
            latencyMs: Date.now() - start,
            lastCheckedAt: Date.now(),
            message: errored ? "SSH connection failed" : undefined,
          });
        });

        setTimeout(() => {
          child.kill();
          resolve({
            status: "unreachable",
            latencyMs: Date.now() - start,
            lastCheckedAt: Date.now(),
            message: "SSH connection timeout",
          });
        }, 6000);
      });
    } catch (err) {
      return {
        status: "unreachable",
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async checkCloudHealth(harness: HarnessDefinition, start: number): Promise<HarnessHealth> {
    if (!harness.cloudConfig) {
      return {
        status: "unreachable",
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
        message: "Cloud config missing",
      };
    }

    try {
      const response = await fetch(`${harness.cloudConfig.endpoint}/health`, {
        method: "GET",
        headers: harness.cloudConfig.authToken
          ? { Authorization: `Bearer ${harness.cloudConfig.authToken}` }
          : {},
        signal: AbortSignal.timeout(8_000),
      });

      return {
        status: response.ok ? "healthy" : "degraded",
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
        message: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err) {
      return {
        status: "unreachable",
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async checkContainerHealth(harness: HarnessDefinition, start: number): Promise<HarnessHealth> {
    try {
      const { spawn } = await import("node:child_process");
      return new Promise<HarnessHealth>((resolve) => {
        const child = spawn("docker", ["info"], { stdio: ["ignore", "pipe", "pipe"] });
        let errored = false;
        child.stderr?.on("data", () => (errored = true));
        child.on("close", (code) => {
          resolve({
            status: code === 0 && !errored ? "healthy" : "unreachable",
            latencyMs: Date.now() - start,
            lastCheckedAt: Date.now(),
            message: errored ? "Docker not available" : undefined,
          });
        });
        setTimeout(() => {
          child.kill();
          resolve({
            status: "unreachable",
            latencyMs: Date.now() - start,
            lastCheckedAt: Date.now(),
            message: "Docker check timeout",
          });
        }, 5000);
      });
    } catch (err) {
      return {
        status: "unreachable",
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** 全局 HarnessManager 实例 */
let globalHarnessManager: HarnessManager | null = null;

export function getGlobalHarnessManager(): HarnessManager {
  if (!globalHarnessManager) {
    globalHarnessManager = new HarnessManager();
  }
  return globalHarnessManager;
}

/** 重置全局 harness manager（测试用） */
export function resetGlobalHarnessManager(): void {
  globalHarnessManager = null;
}