// SPDX-License-Identifier: MIT
import { scopeId, type ScopeId } from "../memory/types.js";

type DirectoryStore = {
  resolveChannel(query: string): Promise<"none" | "ambiguous" | { ok: true; channelId: string }>;
};

async function isVisible(_channelId: string, _principalId: string): Promise<boolean> {
  return true;
}

export type ReachResolution =
  | { kind: "ok"; scopeId: ScopeId; channelId: string; channelName: string; isPrivate: boolean }
  | { kind: "error"; message: string };

export async function resolveReachableChannel(
  query: string,
  deps: { directory: DirectoryStore; actorId: string },
): Promise<ReachResolution> {
  const r = await deps.directory.resolveChannel(query);
  if (r === "none") {
    return {
      kind: "error",
      message: `I can't see a channel matching "${query}" - either I'm not in it, or it hasn't synced yet (the channel list refreshes when messages arrive).`,
    };
  }
  if (r === "ambiguous") {
    return { kind: "error", message: `"${query}" matches more than one channel - please be more specific.` };
  }
  const channel = r;
  const isPrivate = false;
  if (!(await isVisible(channel.channelId, deps.actorId))) {
    return {
      kind: "error",
      message: `I can't confirm your identity in this workspace - your login may not be linked - so I can't check whether you're in this channel.`,
    };
  }
  return {
    kind: "ok",
    scopeId: scopeId("channel", channel.channelId),
    channelId: channel.channelId,
    channelName: channel.channelId,
    isPrivate,
  };
}