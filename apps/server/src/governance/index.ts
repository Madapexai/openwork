/**
 * Governance Layer - 从 QM 移植的公司级治理能力
 *
 * 模块清单：
 * - scope: ScopeId 解析 + 成员判定（personal/channel/team/org/group）
 * - memory: Postgres 持久化记忆 + 跨 scope cc capture
 * - security: 三姿态（strict/auto/dangerous）+ 筛查 + secret masking
 * - audit: 审计日志（内存/Postgres 双实现）+ 幂等
 * - approvals: 审批状态机（once/session/always）+ 故障恢复
 * - acl: 资源授权 + 乐观锁 + advisory lock
 * - policy: 命令策略（denylist/allowlist）Tier 1 简化版
 *
 * License: MIT (移植自 QM)
 */

// Scope 模型
export type { ScopeId, ScopeKind, Principal } from "./memory/types.js";
export {
  SCOPE_KINDS,
  scopeId,
  personalScope,
  parseScopeId,
  isScopeKind,
} from "./memory/types.js";
export type { ScopeMembershipDeps, ManagedGroupDirectory } from "./scope/membership-deps.js";
export {
  createCanReadScope,
  createCanWriteScope,
  createCanManageScope,
  createIsCurrentSharedScopeMember,
  createCurrentScopeMembers,
  createMembershipControlsScope,
  createManagesArtifactHome,
} from "./scope/membership.js";
export type { ScopeModel } from "./scope/index.js";
export { createScopeModel } from "./scope/index.js";

// Memory Service
export type {
  MemoryService,
  MemoryRevision,
  MemoryHead,
} from "./memory/types.js";
export {
  recallBody,
  foldCapture,
  queryBullets,
  normalizeReplace,
  isSystemActor,
  ccTargetFor,
  ccCaptureToPersonal,
} from "./memory/memory-service.js";
export { createPostgresMemoryService } from "./memory/postgres-memory-service.js";
export type { MemoryPolicy, WorkspaceLayer } from "./memory/policy.js";

// Security Posture
export {
  SECURITY_POSTURES,
  resolveSecurityPolicy,
  composeSecurityPosture,
  parseSecurityPosture,
} from "./security/security-posture.js";
export type {
  SecurityPosture,
  ResolvedSecurityPolicy,
} from "./security/security-posture.js";
export { createSecurityScreenProxy } from "./security/security-screener.js";
export { maskSecrets, maskString } from "./security/secret-masking.js";

// Audit Log
export type { AuditEvent, AuditLog } from "./audit/audit-log.js";
export { createAuditLog } from "./audit/memory-audit-log.js";
export { createPostgresAuditLog } from "./audit/postgres-audit-log.js";

// Approvals 状态机
export type {
  ApprovalScope,
  PendingApproval,
  StoredApproval,
  ApprovalDecision,
  ApprovalAction,
  ApprovalStore,
} from "./approvals/approval-types.js";
export {
  approvalScopeFromAction,
} from "./approvals/approval-types.js";
export type { ApprovalBegin, ApprovalRegistry } from "./approvals/approval-registry.js";
export { createApprovalRegistry } from "./approvals/approval-registry.js";

// ACL Grants
export type { Permission, Grant, GrantedHandle } from "./acl/types.js";
export type {
  AclStore,
  AclStoreOptions,
  GrantPersistence,
} from "./acl/acl-store.js";
export {
  createAclStore,
  createMemoryGrantPersistence,
} from "./acl/acl-store.js";
export { createPostgresGrantStore } from "./acl/postgres-grant-store.js";
export { parseRef, refToString } from "./acl/resource-ref.js";

// Command Policy (Tier 1 简化版)
export type {
  CommandDecision,
  CommandRule,
  CommandPolicy,
  CommandEvaluation,
} from "./policy/command-policy.js";
export {
  defaultOrgPolicy,
  composePolicy,
  parseCommandPolicy,
  evaluateCommand,
} from "./policy/command-policy.js";
