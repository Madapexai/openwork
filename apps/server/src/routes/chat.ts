/**
 * Chat 桥接路由（openspec-chat-bridge.md）
 *
 * POST /chat/inbound    {channel, conversationId, sender, text} → 驱动被 @ 的 agent，返回路由结果
 * GET  /chat/channels   → 已注册通道
 *
 * 消费方：IM 平台 webhook（飞书/微信/钉钉等）把群消息 POST 到这里。
 */

import { addRoute, type Route } from "./registry.js";
import { ChatRelayService, parseMentions } from "../chat/chat-relay.js";
import type { ChatChannelAdapter, ChatMessage } from "../chat/types.js";

export interface RegisterChatRoutesOptions {
  routes: Route[];
  channels: Record<string, ChatChannelAdapter>;
  relay: ChatRelayService;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<unknown>;
}

interface InboundPayload {
  channel?: string;
  conversationId?: string;
  sender?: string;
  text?: string;
}

function isInboundPayload(value: unknown): value is InboundPayload {
  return typeof value === "object" && value !== null;
}

export function registerChatRoutes(options: RegisterChatRoutesOptions): void {
  const { routes, channels, relay, jsonResponse, readJsonBody } = options;

  addRoute(routes, "GET", "/chat/channels", "none", async () => {
    return jsonResponse({ channels: Object.keys(channels) });
  });

  addRoute(routes, "POST", "/chat/inbound", "none", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    if (!isInboundPayload(body) || !body.channel || !body.conversationId || typeof body.text !== "string") {
      return jsonResponse(
        {
          error: "missing channel / conversationId / text in body",
        },
        400,
      );
    }

    const channel = channels[body.channel];
    if (!channel) {
      return jsonResponse({ error: `unknown channel '${body.channel}'` }, 404);
    }

    const message: ChatMessage = {
      id: `inbound-${Date.now()}`,
      conversationId: body.conversationId,
      sender: body.sender ?? "user",
      role: "user",
      text: body.text,
      mentions: parseMentions(body.text),
      timestamp: Date.now(),
    };

    const result = await relay.route(channel, message);
    return jsonResponse({ result });
  });
}
