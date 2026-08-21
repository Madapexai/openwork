/**
 * 轨迹分析路由（trajectory analysis）
 *
 * CLI agent 执行轨迹 = cli-agent-session 的 messages/snapshot 数据。
 * 本路由将其暴露为可查询 / 可记录的轨迹模型：
 *
 * - GET  /workspace/:id/trajectories             列出该 workspace 的 CLI 轨迹（会话）
 * - GET  /workspace/:id/trajectories/:sessionId   单条轨迹详情（含消息流 + 聚合指标）
 * - GET  /workspace/:id/trajectories/runs         按 agent 聚合的运行记录
 * - POST /workspace/:id/trajectories/:sessionId/messages/:messageId/annotations  追加人工/监督注解
 *
 * 数据源：内存中的 CliSessionRecord（与 opencode session 生命周期解耦），
 * 进程重启即清空，与 cli-agent-session 的语义保持一致。注解与消息存于同一记录，
 * 通过 buildCliSessionMessages 的 parts 附加（type="annotation"）。
 */

import { ApiError } from "../errors.js";
import {
  buildCliSessionMessages,
  buildCliSessionSnapshot,
  getCliSessionRecord,
  isCliSession,
  listCliAgentRuns,
  listCliSessions,
  type CliStoredMessage,
  type CliSessionRecord,
} from "../cli-agent-session.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

interface RegisterTrajectoryRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

function textOf(message: { parts?: Array<{ type?: string; text?: string }> }): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

/** 单条轨迹的指标聚合 */
function buildTrajectory(record: CliSessionRecord, messagesLimit?: number) {
  const messages = buildCliSessionMessages(record, messagesLimit);
  const agents = [...new Set(record.messages.map((m) => m.info.agent).filter(Boolean))];
  const turnCount = record.messages.filter((m) => m.info.role === "assistant").length;
  const userTurnCount = record.messages.filter((m) => m.info.role === "user").length;
  const steps = messages.map((message) => ({
    id: message.info.id,
    role: message.info.role,
    agent: message.info.agent,
    parentID: message.info.parentID,
    createdAt: message.info.time.created,
    completedAt: message.info.time.completed,
    text: textOf(message),
    annotations: (message.parts ?? [])
      .filter((part) => part.type === "annotation")
      .map((part) => ({ text: part.text, by: part.by, at: part.at })),
  }));
  const firstCreated = record.messages[0]?.info.time.created ?? record.createdAt;
  const lastUpdated = record.updatedAt;
  return {
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    title: record.title,
    agentId: record.agentId,
    createdAt: record.createdAt,
    updatedAt: lastUpdated,
    durationMs: Math.max(0, lastUpdated - firstCreated),
    agents,
    runningAgents: [...record.runningAgents],
    agentErrors: record.agentErrors,
    stats: {
      turns: turnCount,
      userInputs: userTurnCount,
      steps: steps.length,
    },
    steps,
  };
}

/** 给 record 的某条消息追加注解 part（记录层） */
function appendAnnotation(
  record: CliSessionRecord,
  messageId: string,
  annotation: { text: string; by: string },
): CliStoredMessage | undefined {
  const message = record.messages.find((m) => m.info.id === messageId);
  if (!message) return undefined;
  record.updatedAt = Date.now();
  message.parts.push({
    id: `ann_${Date.now()}`,
    messageID: messageId,
    sessionID: record.sessionId,
    type: "annotation",
    text: annotation.text,
    by: annotation.by,
    at: Date.now(),
  });
  return message;
}

export function registerTrajectoryRoutes(options: RegisterTrajectoryRoutesOptions): void {
  const { routes, config, jsonResponse, readJsonBody, resolveWorkspace } = options;

  // 列出 workspace 的 CLI 轨迹
  addRoute(routes, "GET", "/workspace/:id/trajectories", "client", async (ctx: RequestContext) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const limit = Number.parseInt(ctx.url.searchParams.get("limit") ?? "50", 10) || 50;
    const records = listCliSessions(workspace.id);
    records.sort((a, b) => b.updatedAt - a.updatedAt);
    const items = records.slice(0, limit).map((record) => buildTrajectory(record, 100));
    return jsonResponse({ items, total: records.length });
  });

  // 按 agent 聚合的运行记录（先于 :sessionId 注册，避免 runs 被吞）
  addRoute(routes, "GET", "/workspace/:id/trajectories/runs", "client", async (ctx: RequestContext) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const agentId = ctx.url.searchParams.get("agent")?.trim() || undefined;
    const records = listCliAgentRuns(agentId).filter((r) => r.workspaceId === workspace.id);
    records.sort((a, b) => b.updatedAt - a.updatedAt);
    const byAgent = new Map<string, { runs: number; assistants: number; lastRunAt: number; sessions: string[] }>();
    for (const record of records) {
      for (const agent of new Set(record.messages.map((m) => m.info.agent).filter(Boolean))) {
        const existing = byAgent.get(agent);
        const agg = existing ?? { runs: 0, assistants: 0, lastRunAt: 0, sessions: [] as string[] };
        agg.runs += 1;
        agg.assistants += record.messages.filter((m) => m.info.role === "assistant" && m.info.agent === agent).length;
        if (record.updatedAt > agg.lastRunAt) agg.lastRunAt = record.updatedAt;
        agg.sessions.push(record.sessionId);
        byAgent.set(agent, agg);
      }
    }
    const items = [...byAgent.entries()].map(([name, agg]) => ({ agent: name, ...agg }));
    return jsonResponse({ items, total: records.length });
  });

  // 单条轨迹详情
  addRoute(routes, "GET", "/workspace/:id/trajectories/:sessionId", "client", async (ctx: RequestContext) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) throw new ApiError(400, "invalid_payload", "sessionId is required");
    if (!isCliSession(workspace.id, sessionId)) {
      throw new ApiError(404, "trajectory_not_found", `No CLI trajectory for session '${sessionId}'`);
    }
    const record = getCliSessionRecord(workspace.id, sessionId)!;
    const snapshot = buildCliSessionSnapshot(record);
    const trajectory = buildTrajectory(record);
    return jsonResponse({ trajectory, snapshot });
  });

  // 记录层：给某条消息追加人工/监督注解
  addRoute(
    routes,
    "POST",
    "/workspace/:id/trajectories/:sessionId/messages/:messageId/annotations",
    "client",
    async (ctx: RequestContext) => {
      const workspace = await resolveWorkspace(config, ctx.params.id);
      const sessionId = (ctx.params.sessionId ?? "").trim();
      const messageId = (ctx.params.messageId ?? "").trim();
      if (!sessionId || !messageId) throw new ApiError(400, "invalid_payload", "sessionId and messageId are required");
      if (!isCliSession(workspace.id, sessionId)) {
        throw new ApiError(404, "trajectory_not_found", `No CLI trajectory for session '${sessionId}'`);
      }
      const body = await readJsonBody(ctx.request);
      const text = typeof body.text === "string" && body.text.trim() ? body.text.trim() : "";
      const by = typeof body.by === "string" && body.by.trim() ? body.by.trim() : "supervisor";
      if (!text) throw new ApiError(400, "invalid_payload", "annotation text is required");
      const record = getCliSessionRecord(workspace.id, sessionId)!;
      const updated = appendAnnotation(record, messageId, { text, by });
      if (!updated) throw new ApiError(404, "message_not_found", `No message '${messageId}' in session '${sessionId}'`);
      return jsonResponse({ ok: true, messageId, annotation: { text, by } });
    },
  );
}