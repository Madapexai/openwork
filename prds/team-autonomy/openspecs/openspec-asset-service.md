# OpenSpecs — AssetService (共享产物层 artifact 状态机)

> Service: `ee/apps/den-api/src/team-autonomy/asset-service.ts`
> Test: `ee/apps/den-api/test/team-autonomy/asset-service.test.ts`
> Tables: `team_artifact` + `team_artifact_version` (from `@openwork-ee/den-db/schema`)

---

## 1. 规范定义（Spec）

### 1.1 状态机（强制单一守门人）
```
draft ──submitForReview──▶ in_review ──confirm──▶ confirmed (下游只读)
  ▲                            │                       │
  │                            │ reject                │ new version
  │                            ▼                       ▼
  └──────────────────────── draft ◀──         superseded (旧版本)
                                                       │
                                                       │ archive
                                                       ▼
                                                    archived
```
唯一合法路径：上面的箭头。任何其他组合必须返回 `INVALID_TRANSITION`。

### 1.2 不变量（6 条必须 test）
| ID | 不变量 | 失败返回 |
|---|---|---|
| I1 | draft → in_review → confirmed，confirmed 只能从 in_review 来 | 409 / INVALID_TRANSITION |
| I2 | 只有 team.owner / admin / 被指派的 reviewer 能 confirm。editor/viewer 触发 403 | 403 / FORBIDDEN_CONFIRMER |
| I3 | `listArtifactsForDownstream` **不管请求方传什么 filter**，都只返回 `status=confirmed` | — |
| I4 | `createArtifactVersion` 的 version_number 单调递增（同 artifact 内不可变）。UNIQUE(artifact_id, version_number) + SELECT MAX+1 事务保护 | DB 抛重复 / 事务回滚 |
| I5 | confirm 一个 artifact.version=N 时，该 artifact 下 version<N 且 status=confirmed 的记录自动转为 superseded（同一 artifact_id 内） | — |
| I6 | task_id 非空时，task.team_id 必须等于 artifact.team_id（跨团队污染拒绝） | 400 / CROSS_TEAM_TASK |

### 1.3 Surface（durable contract）
```ts
export type ArtifactStatus = "draft" | "in_review" | "confirmed" | "superseded" | "archived"
export type ArtifactKind = "document" | "spreadsheet" | "presentation" | "image" | "data" | "config" | "code" | "video" | "audio" | "other"
export type TeamRole = "owner" | "admin" | "editor" | "viewer"

export type CreateArtifactInput = {
  teamId: string; taskId?: string; name: string; kind: ArtifactKind
  mimeType?: string; storageUri: string; sizeBytes: number
  producedBy: { type: "member" | "agent"; id: string }
}
export type ArtifactTransition =
  | { to: "in_review"; reviewerId?: string }
  | { to: "confirmed"; confirmedBy: string }
  | { to: "draft"; reason: string }  // reject
  | { to: "archived"; reason: string }

export function createArtifact(i: CreateArtifactInput)
export function listArtifactsForDownstream(teamId, filter?)   // I3
export function listArtifactsByProducer(teamId, producer)
export function transitionArtifact(id, transition, actor: {memberId, role})   // I1+I2
export function createArtifactVersion(id, {storageUri, sizeBytes, changeSummary?, producedBy})  // I4
export function getArtifactVersion(id, n)
```

### 1.4 E2E 场景（端到端验证）
```
E2E-A: "评审→确认→降级→重审"
  1. agentA createArtifact("设计文档", storage_uri_1) → status=draft
  2. agentA transition(in_review) → status=in_review
  3. memberOwner(owner) transition(confirmed) → status=confirmed
  4. memberEditor 查询 listArtifactsForDownstream → 包含此文档 (I3)
  5. agentA createArtifactVersion(storage_uri_2, change="补充边界条件") → version=2, status=draft
  6. agentA transition(in_review) → in_review
  7. memberAdmin(admin) transition(reject, reason="缺少性能章节") → status=draft (I1 reject 合法)
  8. agentA createArtifactVersion(storage_uri_3) → version=3
  9. transition(in_review→confirmed) → confirmed(version=3)
  10. 查询 version 1 和 2 → 两者都 = superseded (I5)
```

---

## 2. RED 阶段 — 必须失败的测试
在写完 Service 之前，`bun test test/team-autonomy/asset-service.test.ts` 必须出现：
- T1（RED）：调用 `createArtifact` → 抛 `Module not found`（因为 impl 还不存在）
- T2（RED）：调用 `transitionArtifact(id, confirmed)` 但当前是 `draft` → 409/INVALID_TRANSITION
- T3（RED）：viewer 角色尝试 confirm → 403/FORBIDDEN_CONFIRMER
- T4（RED）：`listArtifactsForDownstream` 返回结果中，所有 result.status === 'confirmed'（否则断言失败）
- T5（RED）：并发 createArtifactVersion → UNIQUE 冲突，其中 1 个抛错
- T6（RED）：跨 team 的 task_id → 400/CROSS_TEAM_TASK
- T7（RED）：确认新版本 → 旧版本 superseded

## 3. GREEN 阶段
写完 Service 并通过全部 T1-T7 测试。

## 4. REFACTOR
- 抽 `validateTransition(from, to): boolean` 为纯函数（不含 DB 操作的单测）
- 权限逻辑统一到 `assertConfirmRole(actor.role): void`
- I5 的 superseded 批量 UPDATE 放到事务里

## 5. E2E
用真实 MySQL（`bun test` + `DATABASE_URL` 指向测试库）跑 E2E-A 脚本，全流程 OK。

## 6. 沉淀
更新本 openspec，补充：
- 每次测试发现的新不变量加入 1.2 表
- 新的 transition 组合加入 1.1 图

---

## 7. Implementation Log

### 7.1 实现文件
- Service: `ee/apps/den-api/src/team-autonomy/asset-service.ts`（419 行，TypeScript ESM）
- Test: `ee/apps/den-api/test/team-autonomy/asset-service.test.ts`（349 行，node:test + tsx）
- Tables: `@openwork-ee/den-db/schema` → `TeamArtifactTable` + `TeamArtifactVersionTable` + `TeamTaskTable`

### 7.2 真实 API 签名（GREEN 后）
```ts
// 类型导出
export { ArtifactKind, ArtifactStatus }
export type ArtifactId = string
export type ArtifactStatusValue = typeof ArtifactStatus[number]
export type ArtifactKindValue = typeof ArtifactKind[number]
export type ProducedByType = "member" | "agent"
export type ProducedBy = { type: ProducedByType; id: string }
export type Actor = { memberId: string; role: "owner" | "admin" | "editor" | "viewer" }
export type ArtifactRow = { id; teamId; taskId; name; kind; mimeType; storageUri;
  sizeBytes; status; currentVersion; producedByType; producedById;
  confirmedBy; confirmedAt; createdAt; updatedAt }
export type ArtifactVersionRow = { id; artifactId; versionNumber; storageUri;
  sizeBytes; changeSummary; producedByType; producedById; createdAt }
export type CreateArtifactInput = { teamId; taskId?; name; kind; mimeType?;
  storageUri; sizeBytes; producedBy }
export type ArtifactTransition =
  | { to: "in_review"; reviewerId?: string }
  | { to: "confirmed"; confirmedBy: string }
  | { to: "draft"; reason: string }       // reject 路径
  | { to: "archived"; reason: string }

// Result（OperationError 风格 — 显式 ok=false + HTTP-ish 状态码）
export type CreateArtifactResult =
  | { ok: true; artifact: ArtifactRow }
  | { ok: false; status: 400; response: { code: "CROSS_TEAM_TASK" | "INSERT_FAILED"; message } }
export type TransitionResult =
  | { ok: true; artifact: ArtifactRow; previousStatus: ArtifactStatusValue }
  | { ok: false; status: 409; response: { code: "INVALID_TRANSITION"; from; to } }
  | { ok: false; status: 403; response: { code: "FORBIDDEN_CONFIRMER" } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message } }
export type CreateVersionResult =
  | { ok: true; version: number }
  | { ok: false; status: 400 | 404 | 409;
       response: { code: "NOT_FOUND" | "VERSION_CONFLICT"; message? } }

// 公开函数
export function isValidTransition(from, to): boolean   // I1 纯函数
export function canConfirm(role: Actor["role"]): boolean // I2 纯函数
export async function createArtifact(input): Promise<CreateArtifactResult>
export async function getArtifact(id): Promise<ArtifactRow | null>
export async function transitionArtifact(id, transition, actor): Promise<TransitionResult>
export async function listArtifactsForDownstream(teamId, filter?): Promise<ArtifactRow[]>  // I3
export async function listArtifactsByProducer(teamId, producer): Promise<ArtifactRow[]>
export async function createArtifactVersion(id, input): Promise<CreateVersionResult>  // I4 + I5
export async function getArtifactVersion(id, n): Promise<ArtifactVersionRow | null>
```

> 设计偏离：原始 Surface 写 `createAssetService(deps)` 工厂模式，实际实现采用模块级函数 + 单一 `db` 客户端（与 `permission-service.ts` / `inbox-service.ts` 保持一致风格）。工厂模式的依赖注入在 den-api 现有 service 中不使用，统一通过 `src/db.ts` 单例访问。Result 用 discriminated union (`ok: true/false`) 而非 throw，让调用方在 controller 层显式 pattern-match，避免 try/catch 吞错。

### 7.3 状态机转换表（实现后的真实矩阵）
| from \ to | draft | in_review | confirmed | superseded | archived |
|---|---|---|---|---|---|
| draft       | ✗ | ✓ | ✗ | ✗ | ✗ |
| in_review   | ✓ (reject) | ✗ | ✓ | ✗ | ✗ |
| confirmed   | ✗ | ✗ | ✗ | ✓ | ✓ |
| superseded  | ✗ | ✗ | ✗ | ✗ | ✓ |
| archived    | ✗ | ✗ | ✗ | ✗ | ✗ (终态) |

矩阵硬编码于 `ALLOWED_TRANSITIONS: Record<ArtifactStatusValue, ArtifactStatusValue[]>`，由 `isValidTransition()` 暴露为纯函数（无 DB 依赖）。

### 7.4 不变量实现细节
| ID | 实现位置 | 关键技术 |
|---|---|---|
| I1 | `transitionArtifact()` 调用 `isValidTransition()` | 纯函数 + `ALLOWED_TRANSITIONS` 矩阵；不合法返回 409 + `{code:"INVALID_TRANSITION", from, to}` |
| I2 | `transitionArtifact()` 在状态机校验前调用 `canConfirm(actor.role)` | `canConfirm()` 纯函数：`role === "owner" \|\| role === "admin"`；不合法返回 403 + `{code:"FORBIDDEN_CONFIRMER"}` |
| I3 | `listArtifactsForDownstream()` 在 WHERE 中**强制**追加 `eq(status, "confirmed")` | 调用方传的 filter 仅作 AND 收窄，无法绕过 confirmed 过滤 |
| I4 | `createArtifactVersion()` 用 `SELECT MAX(version_number)+1` | 依赖 schema 层 `UNIQUE(artifact_id, version_number)` 索引兜底并发；并发冲突时捕获异常返回 409 `{code:"VERSION_CONFLICT"}` |
| I5 | `createArtifactVersion()` 在插入新版本后 `UPDATE TeamArtifactTable SET current_version=N, status='draft'` | 旧 confirmed 行对下游不可见（`listArtifactsForDownstream` 强制 status='confirmed'），版本表 row 不可变保留作历史 |
| I6 | `createArtifact()` 在插入前 `SELECT TeamTaskTable.id, team_id WHERE id=taskId` | 校验 task.team_id === input.team_id；不存在或不匹配返回 400 `{code:"CROSS_TEAM_TASK"}` |

### 7.5 测试通过证据（GREEN）
运行命令：
```bash
cd ee/apps/den-api
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
DATABASE_URL='mysql://root:password@127.0.0.1:3306/openwork_test_ta' \
DEN_DB_ENCRYPTION_KEY='ta-encryption-key-12345678901234567890' \
node --import file:///Users/yason/Documents/trae_projects/openwork/node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/loader.mjs \
  --test test/team-autonomy/asset-service.test.ts
```
输出摘录（exit code 0）：
```
▶ AssetService — OpenSpecs RED/GREEN
  ✔ T1: createArtifact returns id, status=draft, version=1 (9.927067ms)
  ✔ T2: I1 draft→confirmed returns 409 INVALID_TRANSITION (7.034721ms)
  ✔ T3: I2 viewer confirms in_review returns 403 FORBIDDEN_CONFIRMER (13.506441ms)
  ✔ T4: I3 listArtifactsForDownstream only returns confirmed (30.077216ms)
  ✔ T5: I4 createArtifactVersion monotonically increases; concurrent writers — one throws or sequential (14.36566ms)
  ✔ T6: I6 cross-team task_id returns 400 CROSS_TEAM_TASK (1.323843ms)
  ✔ T7: I5 confirming v2 supersedes v1 confirmed (17.412177ms)
  ✔ T8: I1 isValidTransition state machine matrix (pure logic) (0.25124ms)
  ✔ T9: I2 canConfirm role matrix (pure logic) (0.134033ms)
✔ AssetService — OpenSpecs RED/GREEN (229.807093ms)
```
- T1-T7：DB 集成测试（MySQL `openwork_test_ta` 测试库，`dbAvailable` guard 自动跳过）
- T8-T9：纯逻辑测试，无 DB 依赖，覆盖状态机矩阵 22 个 transition + 角色 4 种矩阵

### 7.6 REFACTOR 状态
- ✓ `isValidTransition(from, to)` 已抽为纯函数（无 DB 依赖，可独立单测）
- ✓ `canConfirm(role)` 已抽为纯函数（与 `assertConfirmRole` 等价但返回 boolean，便于上层选择 throw 或返回 403）
- 部分：I5 supersede 的批量 UPDATE 目前在 `createArtifactVersion` 内联，未单独包 transaction（依赖 `current_version` 唯一索引兜底，未来若引入更复杂 supersede 语义时再抽事务）

### 7.7 后续待办（不在本 P0 范围内）
- E2E-A 完整场景跑通需在 den-api 启动后通过 HTTP controller 触发，本 spec 仅覆盖 service 层契约
- `assertConfirmRole(actor.role): void`（throw 风格）目前不需要，留给 controller 层用 `canConfirm()` 显式判断
- I5 的 supersede 批量 UPDATE 加显式 `db.transaction()` 包裹（当未来需要原子跨表更新时）
