// SPDX-License-Identifier: MIT
import type { ScopeMembershipDeps } from "./membership-deps.js";
import {
  createCanReadScope,
  createCanWriteScope,
  createCanManageScope,
  createIsCurrentSharedScopeMember,
  createCurrentScopeMembers,
  createMembershipControlsScope,
  createManagesArtifactHome,
  type CanReadScope,
  type CanWriteScope,
  type CanManageScope,
  type IsCurrentSharedScopeMember,
  type CurrentScopeMembers,
  type MembershipControlsScope,
  type ManagesArtifactHome,
} from "./membership.js";

export interface ScopeModel {
  canRead: CanReadScope;
  canWrite: CanWriteScope;
  canManage: CanManageScope;
  isCurrentSharedScopeMember: IsCurrentSharedScopeMember;
  currentScopeMembers: CurrentScopeMembers;
  membershipControlsScope: MembershipControlsScope;
  managesArtifactHome: ManagesArtifactHome;
}

export function createScopeModel(deps: ScopeMembershipDeps): ScopeModel {
  const canManage = createCanManageScope(deps);
  return {
    canRead: createCanReadScope(deps),
    canWrite: createCanWriteScope(deps),
    canManage,
    isCurrentSharedScopeMember: createIsCurrentSharedScopeMember(deps),
    currentScopeMembers: createCurrentScopeMembers(deps),
    membershipControlsScope: createMembershipControlsScope(deps),
    managesArtifactHome: createManagesArtifactHome(deps, canManage),
  };
}
