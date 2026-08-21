/**
 * OpenWorkChatSurface - 把 InMemoryChatChannel 包装成 Surface（openspec-surface-abstraction.md）
 *
 * 这是 Surface 抽象层的第一个实现，对应 kind="openwork-chat"。
 * 能力极简：只支持 inbound / send / pullContext，
 * approvalCard / handoff / thread / reaction / messageUpdate / fileUpload / groupDm 全部 false。
 *
 * 不变量：
 * I1: 不支持的方法一律抛 SurfaceCapabilityError（fail-fast，绝不静默吞掉）
 * I2: pullContext 从 ChatSurfaceAdapter 的历史缓存拉取
 * I3: start/stop 委托给适配器（管理后台消费者生命周期）
 */

import { SurfaceCapabilityError } from "../capability-errors.js";
import type { ScopeId } from "../../governance/memory/types.js";
import type {
  ApprovalHandle,
  ApprovalRequest,
  DestinationQuery,
  DestinationResolution,
  HandoffHandle,
  HandoffRequest,
  InboundOpts,
  Surface,
  SurfaceCapabilities,
  SurfaceContextQuery,
  SurfaceContextResult,
  SurfaceDestination,
  SurfaceInbound,
  SurfaceKind,
  SurfaceMessage,
  SurfaceMessageRef,
  SurfaceSendResult,
} from "../types.js";
import {
  type ChatSurfaceAdapter,
  type ChatSurfaceAdapterDeps,
  createChatSurfaceAdapter,
} from "./chat-adapter.js";

export interface OpenWorkChatSurfaceOptions {
  surfaceId: string;
  deps: ChatSurfaceAdapterDeps;
}

/** openwork-chat 的能力声明（极简） */
export const OPENWORK_CHAT_CAPABILITIES: SurfaceCapabilities = {
  approvalCard: false,
  handoff: false,
  thread: false,
  reaction: false,
  messageUpdate: false,
  fileUpload: false,
  groupDm: false,
  richText: "none",
};

export class OpenWorkChatSurface implements Surface {
  readonly surfaceId: string;
  readonly kind: SurfaceKind = "openwork-chat";
  readonly capabilities: SurfaceCapabilities = OPENWORK_CHAT_CAPABILITIES;
  private readonly adapter: ChatSurfaceAdapter;
  private readonly defaultScopeId: ScopeId;

  constructor(options: OpenWorkChatSurfaceOptions) {
    this.surfaceId = options.surfaceId;
    this.adapter = createChatSurfaceAdapter(options.deps);
    this.defaultScopeId = options.deps.defaultScopeId;
  }

  async start(): Promise<void> {
    await this.adapter.start();
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }

  inbound(opts?: InboundOpts): AsyncIterable<SurfaceInbound> {
    const iterable = this.adapter.inbound();
    if (!opts) return iterable;
    // 应用 opts 过滤（lookbackMs / destination）
    return this.filterInbound(iterable, opts);
  }

  async send(
    message: SurfaceMessage,
    destination: SurfaceDestination,
  ): Promise<SurfaceSendResult> {
    return this.adapter.send(message, destination);
  }

  async update(_ref: SurfaceMessageRef, _message: SurfaceMessage): Promise<void> {
    throw new SurfaceCapabilityError(this.surfaceId, "messageUpdate");
  }

  async delete(_ref: SurfaceMessageRef): Promise<void> {
    throw new SurfaceCapabilityError(this.surfaceId, "messageUpdate");
  }

  async react(_ref: SurfaceMessageRef, _emoji: string): Promise<void> {
    throw new SurfaceCapabilityError(this.surfaceId, "reaction");
  }

  async presentApproval(
    _request: ApprovalRequest,
  ): Promise<ApprovalHandle> {
    throw new SurfaceCapabilityError(this.surfaceId, "approvalCard");
  }

  async requestAgentHandoff(_request: HandoffRequest): Promise<HandoffHandle> {
    throw new SurfaceCapabilityError(this.surfaceId, "handoff");
  }

  async pullContext(query: SurfaceContextQuery): Promise<SurfaceContextResult> {
    const messages = this.adapter.history({
      destination: query.destination,
      lookbackMs: query.lookbackMs,
      limit: query.limit,
      containsText: query.containsText,
    });
    const truncated = query.limit !== undefined && messages.length >= query.limit;
    return { messages, truncated };
  }

  async resolveDestination(
    query: DestinationQuery,
    _authorityId: string,
  ): Promise<DestinationResolution> {
    // openwork-chat 只有一种目标：channel（conversationId）
    // 把所有 query kind 都映射到 channel + raw target
    let target: string;
    switch (query.kind) {
      case "raw":
        target = query.target;
        break;
      case "principal":
        target = query.principalId;
        break;
      case "channel":
        target = query.channelName;
        break;
      case "group":
        target = query.groupId;
        break;
      case "thread":
        target = query.threadRef;
        break;
    }
    const destination: SurfaceDestination = {
      type: "channel",
      target,
      audienceScopeId: this.defaultScopeId,
    };
    return {
      destination,
      description: `openwork-chat channel: ${target}`,
    };
  }

  async openGroup(
    _participants: readonly string[],
  ): Promise<{ groupId: string } | { error: string }> {
    throw new SurfaceCapabilityError(this.surfaceId, "groupDm");
  }

  private async *filterInbound(
    iterable: AsyncIterable<SurfaceInbound>,
    opts: InboundOpts,
  ): AsyncIterable<SurfaceInbound> {
    const cutoff = opts.lookbackMs ? Date.now() - opts.lookbackMs : 0;
    for await (const msg of iterable) {
      if (opts.destination) {
        if (
          msg.destination.target !== opts.destination.target ||
          msg.destination.type !== opts.destination.type
        ) {
          continue;
        }
      }
      if (opts.lookbackMs && msg.receivedAt < cutoff) {
        continue;
      }
      yield msg;
    }
  }
}