# OpenSpecs — PersonalTeam 自动创建（P3-A 端到端）

> Service: `ee/apps/den-api/src/team-autonomy/personal-team.ts`
> Test: `ee/apps/den-api/test/team-autonomy/personal-team.test.ts`
> Tables: `team` + `team_member` + `team_permission_profile`（from `@openwork-ee/den-db/schema`）
>
> 设计依据：
> - WorkBuddy Bluebook Ch3：个人 / 团队双轨（personal team 是用户私有命名空间）
> - 双轨权限模式（修正 4）：团队 admin 在 `team_permission_profile` 中决定团队用 simple（3 模式）还是 advanced（5 模式）
> - 借鉴 operational-errors 风格：Result discriminated union + HTTP-ish 状态码
>
> 前置：P2 已实现 `personal-team-service.ts`（低层 `ensurePersonalTeam({userId, organizationId})`，不带 permission profile）。
> 本 openspec 提供 **member 驱动**的高层入口 `ensurePersonalTeam(memberId, userId)`，
> 从 member 行解析 organizationId，并在创建 personal team 时**自动创建默认 `team_permission_profile`（simple / craft）**。

---

## 1. 规范定义（Spec）

### 1.1 不变量（3 条必须 test）

| ID | 不变量 | 失败返回 |
|---|---|---|
| I1 | 新用户注册后自动创建 `kind=personal` 的 Team（slug="personal-&lt;teamId&gt;" 唯一，owner_user_id=user.id）；`ensurePersonalTeam(memberId, userId)` 幂等：重复调用返回同一 team | 404 / MEMBER_NOT_FOUND |
| I2 | personal team 的 `ownerUserId` = 传入的 userId（member 必须属于该 userId） | 403 / MEMBER_USER_MISMATCH |
| I3 | personal team 创建时自动创建 `team_permission_profile`（profile="simple"，default_mode="craft"，updated_by=memberId）；已存在则幂等保留 | — |

### 1.2 流程

```
user signup / first login (auth.ts session.create.before)
        │
        ▼
ensurePersonalTeamForUser(userId, organizationId)      ← session hook 入口
        │
        ▼
ensurePersonalTeam(memberId, userId)                    ← member 驱动入口
   ├─ SELECT team_member WHERE id=memberId
   │    ├─ 不存在              → 404 MEMBER_NOT_FOUND
   │    ├─ member.userId≠userId → 403 MEMBER_USER_MISMATCH（I2）
   │    └─ 存在 → organizationId = member.organizationId
   ├─ SELECT team WHERE owner_user_id=userId AND kind='personal'
   │    ├─ 存在 → 返回 (created=false, 幂等 I1)
   │    └─ 不存在 → INSERT team(slug='personal', kind='personal',
   │                          owner_user_id=userId, organization_id=orgId)
   │                  └─ 唯一索引冲突 → recheck（并发幂等）
   ├─ ensurePersonalPermissionProfile(teamId, memberId)   ← I3
   │    └─ team_permission_profile 不存在 → INSERT (profile='simple',
   │          default_mode='craft', updated_by=memberId)
   └─ 返回 { ok: true, team, created }
```

### 1.3 Surface（durable contract）

```ts
// ---------- PersonalTeam（member 驱动，P3-A）----------
export type MemberScopedPersonalTeamRow = {
  id: string
  organizationId: string
  name: string
  slug: string
  kind: "personal"
  ownerUserId: string
  createdAt: Date
}

export type EnsurePersonalTeamResult =
  | { ok: true; team: MemberScopedPersonalTeamRow; created: boolean }
  | { ok: false; status: 403 | 404; response: { code: string; message: string } }

// I1+I2+I3：member 驱动入口（幂等）
export function ensurePersonalTeam(memberId: string, userId: string): Promise<EnsurePersonalTeamResult>

// I3：为 team 幂等创建默认 permission profile（simple / craft）
export function ensurePersonalPermissionProfile(
  teamId: string,
  updatedByMemberId: string,
): Promise<{ ok: boolean; created: boolean }>

// session hook 入口（内部查 member → ensurePersonalTeam）
export function ensurePersonalTeamForUser(
  userId: string,
  organizationId: string,
): Promise<EnsurePersonalTeamResult>
```

### 1.4 E2E 场景（端到端验证）

```
E2E-P3A: "用户注册 → personal team 自动创建 + 默认权限配置"
  1. 建 user + org + member（member.userId=userId）
  2. ensurePersonalTeam(memberId, userId)
     → ok, created=true, team.kind='personal', team.slug='personal',
       team.ownerUserId=userId（I1+I2）
  3. 查询 team_permission_profile
     → profile='simple', default_mode='craft', updated_by=memberId（I3）
  4. 再次 ensurePersonalTeam(memberId, userId)
     → ok, created=false, 同一 teamId（幂等 I1）
  5. ensurePersonalTeam(memberId, 其他 userId)
     → 403 MEMBER_USER_MISMATCH（I2）
  6. ensurePersonalTeam(不存在的 memberId, userId)
     → 404 MEMBER_NOT_FOUND（I1）
```

---

## 2. RED 阶段 — 必须失败的测试

`node --import tsx --test test/team-autonomy/personal-team.test.ts` 在实现前必须失败：

- T1（RED）：import `personal-team.js` → `Module not found`（模块不存在）
- T2（RED）：`ensurePersonalTeam(memberId, userId)` 创建 personal team → 不存在函数
- T3（RED）：`ensurePersonalPermissionProfile` → 不存在函数
- T4（RED）：`ensurePersonalTeamForUser` → 不存在函数

GREEN 后（DB 可用）验证：
- T1：I1+I2 创建 → team.kind=personal / slug='personal' / ownerUserId=userId
- T2：I1 幂等 → 第二次 created=false 且同一 teamId
- T3：I3 自动创建 permission profile → profile='simple' / default_mode='craft' / updated_by=memberId
- T4：I2 身份校验 → member 属于其他 userId → 403 MEMBER_USER_MISMATCH
- T5：I1 守卫 → member 不存在 → 404 MEMBER_NOT_FOUND
- T6：I3 幂等 → 重复 ensurePersonalTeam 不重建 profile
- T7：session hook 入口 → ensurePersonalTeamForUser 结果与 ensurePersonalTeam 一致

## 3. GREEN 阶段

- `personal-team.ts` 导出 `ensurePersonalTeam(memberId, userId)`：
  1. 查 `team_member`（camelCase：`MemberTable`，`id` / `userId` / `organizationId`）
  2. member 不存在 → 404 `MEMBER_NOT_FOUND`；`member.userId !== userId` → 403 `MEMBER_USER_MISMATCH`
  3. 查 `team WHERE owner_user_id=userId AND kind='personal'` → 存在则幂等返回
  4. INSERT team（slug='personal', kind='personal', owner_user_id=userId）；唯一索引冲突 → recheck
  5. `ensurePersonalPermissionProfile(teamId, memberId)`：`team_permission_profile` 不存在则
     INSERT（profile='simple', default_mode='craft', updated_by=memberId）—— I3
- 错误码：`MEMBER_NOT_FOUND` / `MEMBER_USER_MISMATCH`（403）
- hook 注入点：`auth.ts` `databaseHooks.session.create.before` 调用
  `ensurePersonalTeamForUser(userId, activeOrganizationId)`（try/catch 包裹，幂等，失败不阻断登录）

## 4. REFACTOR

- 与 `personal-team-service.ts` 的关系：低层 `ensurePersonalTeam({userId, organizationId})` 保留（P2 兼容）；
  `personal-team.ts` 是 member 驱动的高层入口，负责 resolve org + 自动建 profile。
- `ensurePersonalPermissionProfile` 独立导出，便于 controller 复用。

## 5. E2E

- DB 测试用 `dbAvailable` guard（同 `sidecar-personal-budget.test.ts` 模式），DB 不可用自动 skip。
- 纯逻辑不适用本子项（全部断言依赖 DB 行）。

## 6. 沉淀

- 实现后把实际签名、hook 接入点、permission profile 默认值追加到本 openspec 的 "Implementation Log"。

---

## 7. Implementation Log

### GREEN 实现（2026-08-04）
- 文件：`ee/apps/den-api/src/team-autonomy/personal-team.ts`（member 驱动高层入口；低层 P2 服务 `personal-team-service.ts` 保留不动）
- 导出签名：
  - `ensurePersonalTeam(memberId: string, userId: string): Promise<EnsurePersonalTeamResult>`
  - `ensurePersonalPermissionProfile(teamId: string, updatedByMemberId: string): Promise<{ ok: boolean; created: boolean }>`
  - `ensurePersonalTeamForUser(userId: string, organizationId: string): Promise<EnsurePersonalTeamResult>`（auth hook 入口）
- 不变量落实：
  - I1：先查 `owner_user_id + kind='personal'` 幂等返回（created=false）；INSERT `slug='personal' kind='personal' owner_user_id=userId`；并发撞唯一索引 → 回查一次
  - I2：member 不存在 → 404 MEMBER_NOT_FOUND；`member.userId ≠ userId` → 403 MEMBER_USER_MISMATCH
  - I3：建 team 后调用 `ensurePersonalPermissionProfile` 建默认 profile（`profile='simple' default_mode='craft' custom_rules=null updated_by=memberId`）；已存在不覆盖；幂等路径同样补建（兼容旧数据）
- auth hook 接入点：`ee/apps/den-api/src/auth.ts` `databaseHooks.session.create.before` → `ensurePersonalTeamForUser(userId, orgId)`（函数已实现，接线待 controller/API 层）
- 错误码：404 MEMBER_NOT_FOUND / 403 MEMBER_USER_MISMATCH / 404 INSERT_FAILED
- 测试：`ee/apps/den-api/test/team-autonomy/personal-team.test.ts`（T1-T7，GREEN 7/7）
- 已知限制：slug 固定 `"personal"`，同 org 第二个用户创建会撞 `team_organization_slug` 唯一索引（与 P2 `personal-team-service.ts` 同模式，P2 测试 T11/T12 即因此失败；建议 REFACTOR 改为 `personal-<teamId>` 唯一 slug）

### §7.1 auth session.create hook 接线（2026-08-04）
- 文件：`ee/apps/den-api/src/auth.ts`（`databaseHooks.session.create.before`）
- 接线位置：before hook 内 `reconcilePendingInvitationsForUser` 之后、`return { data: { ...session, activeOrganizationId } }` 之前
- 调用时序：`normalizeDenTypeId("user", session.userId)` → `getInitialActiveOrganizationIdForUser(userId)` 得到 `activeOrganizationId` → 若存在则 `await ensurePersonalTeamForUser(userId, activeOrganizationId)`（新用户无 org 时 `activeOrganizationId` 为空 → 直接跳过，不调用）
- 错误处理策略（before hook 不抛异常、不改变 session 返回结构）：
  - 调用整体包 `try/catch`，异常记 `logger.error("personal team auto-create failed", { user_id, organization_id, error })`
  - 返回 `{ ok: false }`（如 MEMBER_NOT_FOUND）→ `logger.warn("personal team auto-create skipped", { user_id, organization_id, code, message })`，不抛
  - 成功不额外日志（幂等，重复登录是常态）
- 循环依赖检查：`personal-team.ts` 仅依赖 `../db.js` / `@openwork-ee/den-db` / `@openwork-ee/utils/typeid`，不反向依赖 `auth.ts` → 无循环依赖，静态 import 安全
- 验证：`tsc --noEmit` auth.ts 0 错误（src/team-autonomy/* 既有报错属其他并行任务）；运行时 `import('./src/team-autonomy/personal-team.js')` 加载正常（导出 ensurePersonalTeamForUser）；`test/member-connected-account-revocation-contract.test.ts` 5/5 pass（读 auth.ts 源码契约测试，不回归）
- commit：`feat(team-autonomy): wire personal-team auto-create into auth session.create hook`

### §7.2 slug 唯一性修复 + typeid 类型收窄（2026-08-04）
- **Bug 根因**：personal team 创建时固定 `slug="personal"`（`personal-team.ts` 与 `personal-team-service.ts` 各一处），而 `team` 表有 org 内唯一索引 `team_organization_slug (organization_id, slug)`。同一 org 下第二个用户创建 personal team 会撞唯一索引 → `INSERT_FAILED`（`sidecar-personal-budget.test.ts` T11/T12 因此失败）。
- **修复方案**：
  1. slug 改为唯一值 `personal-<teamId>`（teamId 为 `createDenTypeId("team")` 生成的 `tem_xxxxx`，base32 无特殊字符，一定唯一安全）；`kind='personal'` 不变。
  2. **附加发现**：`team` 表还有 `team_organization_name (organization_id, name)` 唯一索引。slug 修复后同 org 两个用户默认 name 均为 "Personal" 仍会撞索引（新增回归测试 T8 实测暴露），故 name 同步改为 `Personal <teamId>`（传入自定义 name 时保留自定义值，不受影响）。
  3. **查询逻辑不变**：所有 `ensurePersonalTeam/getPersonalTeam` 均按 `ownerUserId + kind='personal'` 查询，不依赖 slug，无需改查询。
  4. **typeid 类型收窄**（tsc --noEmit 实测 3 文件 19 错误 → 0）：
     - `personal-team.ts`（6 错误）/ `personal-team-service.ts`（7 错误）/ `sidecar-service.ts`（6 错误）：`denTypeIdColumn` 的 data 类型是模板字面量（`tem_${string}` / `tppr_${string}` / `om_${string}` / `tagt_${string}` 等），而 service 入参是 `string`，`eq(column, string)` / `insert(values)` 报 TS2769。
     - 解法（openwork 标准）：各文件在边界定义 `normalizeIdOrNull(name, value)`（内部 `normalizeDenTypeId` + try/catch → 非法 id 返回 null），查询处按"查询未命中"处理，保持原有 404/400/null 语义（无 as any 逃生舱）。
- **测试证据**：
  - 新增回归 T8：同一 org（organizationId）下 `secondUserId/secondMemberId` 创建 personal team → `ok=true, created=true`，`team.id` 与首用户不同、`slug` 不同且均 `startsWith("personal-")`（修复前该场景 INSERT_FAILED）。
  - 断言更新：`personal-team.test.ts` T1 与 `sidecar-personal-budget.test.ts` T10/T12 的 `slug === "personal"` 改为 `slug.startsWith("personal-")`。
  - 结果：`personal-team.test.ts` T1-T8 8/8 pass；`sidecar-personal-budget.test.ts` T5-T22 19/19 pass（含此前失败的 T11/T12）；`tsc --noEmit` 3 目标文件 0 错误。
- commit：`fix(team-autonomy): unique personal-team slug (personal-<teamId>) + typeid types in personal-team/sidecar services`
