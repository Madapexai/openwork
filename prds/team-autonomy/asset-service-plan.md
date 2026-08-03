# AssetService — 共享产物层服务设计

> Status: Draft for scoping · Owner: team-autonomy · Schema: `team-autonomy.ts` (已落地)

## Goal

实现 WorkBuddy Bluebook Ch24 的"共享产物层"——**角色之间不通过对话传递关键内容细节，下游只读取上游已确认的产物**。AssetService 是 artifact 状态机的唯一守门人，所有 draft / in_review / confirmed / superseded / archived 流转必须经过本服务。

## Short Answer

- **不引入 class**：遵循 openwork-ee 的 functional-module 风格，导出纯函数。
- **状态机是唯一事实源**：直接读写 `team_artifact` + `team_artifact_version`，禁止业务代码绕过本服务直接 UPDATE status。
- **下游可读性约束**：`listArtifactsForDownstream(teamId, taskId?)` 只返回 `status='confirmed'` 的记录。
- **版本不可变**：每次内容变更必须新增 `team_artifact_version` 行，`current_version` 单调递增。
- **确认者约束**：`confirmArtifact()` 必须校验调用者是 team owner / admin / 主理人，且 artifact 当前在 `in_review`。
- **supersede 链**：当新版本确认时，旧版本自动转为 `superseded`（同 artifact_id 内）。

## Recommendation

放路径：`ee/apps/den-api/src/team-autonomy/asset-service.ts`，HTTP 路由放 `ee/apps/den-api/src/routes/team/Artifacts.ts`。

## Data Model

参见 [team-autonomy.ts](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts) 中的：

- `TeamArtifactTable`（状态机本体，[team-autonomy.ts#L209-L241](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts#L209-L241)）
- `TeamArtifactVersionTable`（不可变版本表，[team-autonomy.ts#L243-L260](file:///Users/yason/Documents/trae_projects/openwork/ee/packages/den-db/src/schema/team-autonomy.ts#L243-L260)）

状态机：

```
draft ──submitForReview──▶ in_review ──confirm──▶ confirmed
  ▲                            │                       │
  │                            │ reject                │ new version
  │                            ▼                       ▼
  └──────────────────────── draft ◀──         superseded
                                                       │
                                                       │ archive
                                                       ▼
                                                    archived
```

## Surface（durable contract）

```ts
// ee/apps/den-api/src/team-autonomy/asset-service.ts

export type ArtifactId = typeof TeamArtifactTable.$inferSelect.id
export type ArtifactStatus = typeof TeamArtifactTable.$inferSelect.status
export type ArtifactKind = typeof TeamArtifactTable.$inferSelect.kind

export type CreateArtifactInput = {
  teamId: string
  taskId?: string
  name: string
  kind: ArtifactKind
  mimeType?: string
  storageUri: string
  sizeBytes: number
  producedBy: { type: "member" | "agent"; id: string }
}

export type ArtifactTransition =
  | { to: "in_review"; reviewerId?: string }
  | { to: "confirmed"; confirmedBy: string }
  | { to: "draft"; reason: string }       // reject back to draft
  | { to: "archived"; reason: string }

// 创建 artifact（初始 status=draft，自动写入 version 1）
export async function createArtifact(
  input: CreateArtifactInput,
): Promise<{ ok: true; artifact: ArtifactRow } | { ok: false; status: 4xx; response: ... }>

// 列出下游可见的 artifact（只返回 confirmed）
export async function listArtifactsForDownstream(
  teamId: string,
  filter?: { taskId?: string; kind?: ArtifactKind; producedBy?: { type; id } },
): Promise<ArtifactRow[]>

// 列出某个任务产出方的所有 artifact（含 draft/in_review，供产出自检）
export async function listArtifactsByProducer(
  teamId: string,
  producer: { type: "member" | "agent"; id: string },
): Promise<ArtifactRow[]>

// 状态机迁移（核心守门人）
export async function transitionArtifact(
  artifactId: string,
  transition: ArtifactTransition,
  actor: { memberId: string; role: "owner" | "admin" | "editor" | "viewer" },
): Promise<
  | { ok: true; artifact: ArtifactRow; previousStatus: ArtifactStatus }
  | { ok: false; status: 409; response: { code: "INVALID_TRANSITION"; from: ArtifactStatus; to: ArtifactStatus } }
  | { ok: false; status: 403; response: { code: "FORBIDDEN_CONFIRMER" } }
>

// 新增版本（写入 team_artifact_version，current_version+1，status 重置为 draft）
export async function createArtifactVersion(
  artifactId: string,
  input: { storageUri: string; sizeBytes: number; changeSummary?: string; producedBy: { type; id } },
): Promise<{ ok: true; version: number } | { ok: false; status: 4xx; response: ... }>

// 读取指定版本（用于回溯）
export async function getArtifactVersion(
  artifactId: string,
  version: number,
): Promise<ArtifactVersionRow | null>
```

## 关键不变量（必须有测试覆盖）

1. **状态机校验**：`draft → in_review`、`in_review → confirmed`、`in_review → draft`、`confirmed → superseded`（自动）、`confirmed → archived`、`superseded → archived`。其他转换返回 409。
2. **确认者权限**：只有 `owner` / `admin` 角色可执行 `confirm`。viewer 触发 403。
3. **下游只读 confirmed**：`listArtifactsForDownstream` 必须强制 `status='confirmed'`，即使调用方传入了恶意 filter。
4. **版本单调递增**：`createArtifactVersion` 在事务中 `SELECT MAX(version_number) + 1`，配合 `UNIQUE(artifact_id, version_number)` 防并发。
5. **supersede 自动化**：`confirm` 一个 `current_version=3` 的 artifact 时，version 1/2（若曾 confirmed）自动转 `superseded`。
6. **任务关联**：若 `task_id` 非空，必须校验 task 属于同一 `team_id`（防跨团队污染）。

## HTTP 路由（OpenAPI 节选）

| Method | Path | operationId | 说明 |
|---|---|---|---|
| POST | `/v1/teams/{teamId}/artifacts` | `createArtifact` | 创建 artifact |
| GET | `/v1/teams/{teamId}/artifacts` | `listArtifacts` | 支持 `?status=confirmed&taskId=&kind=` 过滤 |
| GET | `/v1/teams/{teamId}/artifacts/{artifactId}` | `getArtifact` | 单个详情 |
| POST | `/v1/teams/{teamId}/artifacts/{artifactId}/transitions` | `transitionArtifact` | body 含 `to` 字段 |
| POST | `/v1/teams/{teamId}/artifacts/{artifactId}/versions` | `createArtifactVersion` | 新增版本 |
| GET | `/v1/teams/{teamId}/artifacts/{artifactId}/versions/{n}` | `getArtifactVersion` | 回溯版本 |

## 实现要点

- **存储抽象**：`storage_uri` 是字符串（如 `s3://bucket/key` 或 `file:///path`），实际写入由 capability-sources 层处理，本服务只管 URI + 元数据。
- **加密**：artifact 元数据不加密；payload 由存储层加密（与 `compatJsonColumn` 无关）。
- **审计**：所有 transition 写入 `team_mailbox` 一条 `kind=notification` 给产出具者，便于追踪。
- **与 TaskService 的耦合**：task 完成时，TaskService 调用 `listArtifactsByProducer(task.assignee)` 校验是否所有 expected artifacts 都已 confirmed；这是 task 完成的前置条件。

## Test Plan

- `test/asset-service.test.ts`：覆盖 6 个不变量，每个至少 1 个正例 + 1 个反例。
- 并发测试：模拟 2 个 agent 同时 `createArtifactVersion`，验证 UNIQUE 约束生效。
- 权限矩阵测试：4 种角色 × 4 种 transition，建立 16 格矩阵。
- E2E：通过 `routes/team/Artifacts.ts` 走完整 HTTP 流程。
