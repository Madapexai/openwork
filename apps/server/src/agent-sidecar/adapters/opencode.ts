/**
 * OpenCodeSidecarAdapter - HTTP 协议 adapter
 *
 * 复用现有 managed-opencode.ts 的实现，包装为 AgentSidecarAdapter。
 *
 * 这是 OpenWork 内置的默认 agent，通过 `opencode serve --hostname --port` 启动 HTTP server，
 * OpenWork 通过 REST API + SSE 与之通信。
 */

import { createManagedOpencodeServer, type ManagedOpencodeServer } from "../../managed-opencode.js";
import { buildTransportEnv } from "../transport.js";
import { BaseSidecarAdapter } from "./base.js";
import type { SidecarHandle, SidecarStartOptions, TransportInfo } from "../types.js";

export class OpenCodeSidecarAdapter extends BaseSidecarAdapter {
  readonly protocol = "http" as const;

  override async start(options: SidecarStartOptions): Promise<SidecarHandle> {
    const binary = this.config.binaryPath ?? this.config.binary ?? "opencode";
    const args = this.config.args ?? ["serve", "--cors", "*"];

    // 复用 managed-opencode.ts 的实现，它已经处理了端口分配、超时、信号
    const managed: ManagedOpencodeServer = await createManagedOpencodeServer({
      bin: binary,
      cwd: options.cwd,
      hostname: options.hostname,
      port: options.port,
      excludedPorts: options.excludedPorts,
      timeoutMs: options.timeoutMs,
      env: options.env,
    });

    // 透传 managed 的 execution snapshot（已包含脱敏的 env 列表）
    const transportInfo: TransportInfo = {
      command: managed.execution.command,
      args: [...managed.execution.args, ...args.slice(managed.execution.args.length)],
      cwd: managed.execution.cwd,
      env: managed.execution.env,
    };

    return {
      protocol: "http",
      agentId: this.config.agentId,
      baseUrl: managed.url,
      processId: managed.pid ?? undefined,
      transportInfo,
      isAlive: managed.isAlive,
      stop: () => managed.close(),
    };
  }
}

// 兼容未使用的 import（避免 tsc 报错）
void buildTransportEnv;
