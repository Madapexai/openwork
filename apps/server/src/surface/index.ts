/**
 * Surface 抽象层公开 API（openspec-surface-abstraction.md）
 *
 * 使用方式：
 * ```ts
 * import { createSurfaceRegistry, OpenWorkChatSurface } from "./surface/index.js";
 *
 * const registry = createSurfaceRegistry();
 * const surface = new OpenWorkChatSurface({
 *   surfaceId: "openwork-chat-default",
 *   deps: { channel, defaultScopeId, defaultSender: "agent" },
 * });
 * registry.register(surface);
 * await surface.start();
 * for await (const inbound of surface.inbound()) {
 *   // ...
 * }
 * ```
 */

export type {
  Surface,
  SurfaceKind,
  SurfaceCapabilities,
  RichTextCapability,
  SurfaceMessage,
  SurfaceMention,
  SurfaceAttachment,
  SurfaceDestination,
  SurfaceMessageRef,
  DestinationQuery,
  DestinationResolution,
  ApprovalRequest,
  ApprovalHandle,
  ApprovalDecision,
  ApprovalScope,
  ApprovalPresentOpts,
  HandoffRequest,
  HandoffHandle,
  HandoffStatus,
  HandoffResult,
  SurfaceContextQuery,
  SurfaceContextResult,
  SurfaceInbound,
  InboundOpts,
  SurfaceSendResult,
} from "./types.js";

export {
  createSurfaceRegistry,
  type SurfaceRegistry,
} from "./registry.js";

export {
  SurfaceCapabilityError,
  NotImplementedError,
} from "./capability-errors.js";

export {
  OpenWorkChatSurface,
  OPENWORK_CHAT_CAPABILITIES,
  type OpenWorkChatSurfaceOptions,
} from "./openwork-chat/openwork-chat-surface.js";

export {
  createChatSurfaceAdapter,
  chatMessageToInbound,
  surfaceMessageToChatMessage,
  type ChatSurfaceAdapter,
  type ChatSurfaceAdapterDeps,
} from "./openwork-chat/chat-adapter.js";