// SPDX-License-Identifier: MIT
import type { ScopeId } from "../memory/types.js";

export interface ManagedGroupDirectory {
  recognizes(groupId: string): boolean;
  membership(groupId: string, principalId: string): Promise<boolean | undefined>;
  members(groupId: string): Promise<string[] | undefined>;
  version(groupId: string): Promise<string | undefined>;
  withVersion<T>(groupId: string, version: string | undefined, fn: () => Promise<T>): Promise<T | undefined>;
}

export interface ScopeMembershipDeps {
  managedGroups?: Pick<ManagedGroupDirectory, "recognizes" | "membership" | "members">;
  directory?: {
    channelMember(channelId: string, principalId: string): Promise<boolean>;
    groupMember(groupId: string, principalId: string): Promise<boolean>;
    channelMembership?(channelId: string, principalId: string): Promise<boolean | undefined>;
    groupMembership?(groupId: string, principalId: string): Promise<boolean | undefined>;
    channelPrivacy?(channelId: string): Promise<boolean | undefined>;
    list?(): Promise<Array<{ principalId: string; displayName?: string }>>;
  };
  identity?: {
    classify(externalId: string, isExternalGuest?: boolean): { type?: string; teamIds?: readonly string[] };
  };
  sessions?: {
    listByParticipant(principalId: string): Promise<readonly { scopeId: ScopeId }[]>;
  };
}
