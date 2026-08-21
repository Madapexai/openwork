/**
 * 移植自 QM (MIT License, Copyright (c) 2026 QM contributors)
 * 原文件：qm/src/types.ts (Grant/GrantedHandle/Permission 部分)
 * 移植说明：将 ACL 相关类型抽取到独立文件；ScopeId 改从 ../memory/types.ts 导入。
 */

import type { ScopeId } from "../memory/types.js";

export type Permission = "read" | "write";

export interface Grant {
  ownerScopeId: ScopeId;
  ref: string;
  granteeScopeId: ScopeId;
  permission: Permission;
  grantedBy: string;
}

export interface GrantedHandle {
  handlePath: string;
  ownerScopeId: ScopeId;
  ownerPath: string;
  permission: Permission;
}
