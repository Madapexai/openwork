# OpenSpecs — HTTP Routes Layer (team-autonomy 路由层)

> Routes: `ee/apps/den-api/src/routes/team-autonomy/`
> Test: `ee/apps/den-api/test/team-autonomy/http-routes.test.ts`
> Services: `ee/apps/den-api/src/team-autonomy/*-service.ts`
> Framework: Hono + hono-openapi + zod
> Mount: `app.ts` → `registerTeamAutonomyRoutes(app)`，统一前缀 `/api/teams/:teamId/...`

---

## 1. 规范定义（Spec）

### 1.1 路由文件清单（7 个子路由 + 1 个聚合）

| 文件 | 前缀 | 对应 Service | 职责 |
|---|---|---|---|
| `agents.ts` | `/api/teams/:teamId/agents` | `team-agent-service.ts` | Agent 池 + 状态机 + 任务分配 |
| `tasks.ts` | `/api/teams/:teamId/tasks` | `task-service.ts` | 任务依赖图 + 移交 + 计划审批 |
| `boards.ts` | `/api/teams/:teamId/boards` | 直接 DB (`TeamBoardTable`) + `task-service.listByBoard` | 看板 CRUD + 看板任务视图 |
| `artifacts.ts` | `/api/teams/:teamId/artifacts` | `asset-service.ts` | 共享产物状态机 + 版本 |
| `automation.ts` | `/api/teams/:teamId/automations` | `automation-service.ts` | 自动化状态机 + 降级 + 告警 |
| `inbox.ts` | `/api/teams/:teamId/inbox` | `inbox-service.ts` | Inbox 幂等 + resolve |
| `permissions.ts` | `/api/teams/:teamId/permissions` | `permission-service.ts` | 双轨权限 + Standing Rule |
| `index.ts` | — | — | 聚合 + 挂载 `registerTeamAutonomyRoutes` |

### 1.2 中间件链（每条路由必须）

```
sessionMiddleware (全局, app.ts)
  → authenticatedRoute()          # M1: 401 if no user（route-access-policy marker）
  → resolveTeamContext            # M2: 解析 organizationContext + memberTeams（test 短路）
  → teamRoleCheck(["member"|"admin"]) # M3: 403 if org role insufficient
  → paramValidator(schema)        # M4: 400 if invalid :teamId / 资源 id
  → jsonValidator(schema)         # M4: 400 if invalid body（写操作）
  → handler                       # 200/201/204/4xx
```

不变量：
- **M1**: 每条 `app.<method>(...)` 调用必须包含显式 access marker（`authenticatedRoute`）— 满足 `route-access-policy.test.ts`
- **M2**: `resolveTeamContext` 在 `organizationContext` 已注入时短路（test 模式），否则委托 `resolveOrganizationContextMiddleware` + `resolveMemberTeamsMiddleware`
- **M3**: `teamRoleCheck` 复用 `verifyOrgRole`，isOwner 可绕过角色限制
- **M4**: 所有 `:teamId` / `:agentId` 等路径参数用 `denTypeIdSchema` 校验（`paramValidator` → 400 `invalid_request`）
- **M5**: 每条路由注册 `describeRoute` + `jsonResponse`（hono-openapi），tag = `"Team Autonomy"`
- **M6**: 团队上下文来自 `c.req.param("teamId")`（路径参数）；资源归属校验（resource.team_id === :teamId）在 handler 内完成

### 1.3 Endpoint 矩阵

#### agents.ts（prefix `/api/teams/:teamId/agents`）
| Method | Path | 说明 | 权限 | 出参 |
|---|---|---|---|---|
| GET | `/` | 列出 agent | member | `{ agents: AgentRow[] }` |
| POST | `/` | 创建 agent | admin | `201 { agent }` |
| GET | `/:agentId` | 获取 agent（校验 team 归属） | member | `{ agent }` |
| PATCH | `/:agentId` | 更新 agent | admin | `{ agent }` |
| DELETE | `/:agentId` | 删除 agent | admin | `204` |
| POST | `/:agentId/assign/:taskId` | 分配任务 | admin | `{ agent }` |
| POST | `/:agentId/unassign` | 取消分配 | admin | `{ agent }` |
| POST | `/:agentId/pause` | 暂停 | admin | `{ agent }` |
| POST | `/:agentId/resume` | 恢复 | admin | `{ agent }` |

#### tasks.ts（prefix `/api/teams/:teamId/tasks`）
| Method | Path | 说明 | 权限 | 出参 |
|---|---|---|---|---|
| GET | `/` | 列出任务（query: boardId/assigneeType/assigneeId/status） | member | `{ tasks }` |
| POST | `/` | 创建任务 | admin | `201 { task }` |
| GET | `/:taskId` | 获取任务（校验 team 归属） | member | `{ task }` |
| PATCH | `/:taskId/status` | 状态转换 | member | `{ task, previousStatus }` |
| PUT | `/:taskId/plan` | 设置计划 | member | `{ task }` |
| POST | `/:taskId/plan/approve` | 批准计划 | admin | `{ task }` |
| POST | `/:taskId/plan/reject` | 拒绝计划 | admin | `{ task }` |
| POST | `/:taskId/handoff` | 移交（contextSnapshot 必填） | member | `{ task, handoff }` |
| POST | `/:taskId/dependencies` | 添加依赖 | member | `{ task, dependsOnTask }` |
| DELETE | `/:taskId/dependencies/:dependsOnId` | 移除依赖 | member | `{ task }` |

#### boards.ts（prefix `/api/teams/:teamId/boards`）
| Method | Path | 说明 | 权限 | 出参 |
|---|---|---|---|---|
| GET | `/` | 列出看板 | member | `{ boards }` |
| POST | `/` | 创建看板 | admin | `201 { board }` |
| GET | `/:boardId` | 获取看板（校验 team 归属） | member | `{ board }` |
| GET | `/:boardId/tasks` | 看板任务视图（复用 task-service.listByBoard） | member | `{ tasks }` |

#### artifacts.ts（prefix `/api/teams/:teamId/artifacts`）
| Method | Path | 说明 | 权限 | 出参 |
|---|---|---|---|---|
| GET | `/` | 列出（query: taskId/kind/downstream/producerType/producerId） | member | `{ artifacts }` |
| POST | `/` | 创建（taskId 跨团队校验 I6） | member | `201 { artifact }` |
| GET | `/:artifactId` | 获取（校验 team 归属） | member | `{ artifact }` |
| POST | `/:artifactId/transition` | 状态转换（I1/I2） | member | `{ artifact, previousStatus }` |
| POST | `/:artifactId/versions` | 创建新版本（I4/I5） | member | `{ version }` |
| GET | `/:artifactId/versions/:version` | 获取指定版本 | member | `{ version }` |

#### automation.ts（prefix `/api/teams/:teamId/automations`）
| Method | Path | 说明 | 权限 | 出参 |
|---|---|---|---|---|
| GET | `/` | 列出 automation（DB by team_id） | member | `{ automations }` |
| POST | `/` | 创建 automation | member | `201 { automation }` |
| GET | `/runs/:runId` | 获取 run（校验 team 归属） | member | `{ run }` |
| POST | `/runs/:runId/advance` | 推进 run（I3/I6） | member | `{ run, previousStatus, degradationLevel? }` |
| POST | `/runs/:runId/fail` | 标记失败（I5 retry） | member | `{ run, retried, nextAttemptAt? }` |
| GET | `/alerts` | 列出告警（teamId 过滤） | member | `{ alerts }` |
| POST | `/alerts` | 创建告警（I4 7 字段） | member | `201 { alert }` |
| POST | `/alerts/:alertId/acknowledge` | 确认告警 | member | `{ alert }` |
| GET | `/:automationId` | 获取 automation（校验 team 归属） | member | `{ automation }` |
| PATCH | `/:automationId` | 更新 automation | member | `{ automation }` |
| PATCH | `/:automationId/schedule` | 启用/禁用调度（I2） | member | `{ automation, enabled }` |
| POST | `/:automationId/manual-run` | 手动试跑（I2 计数） | member | `{ run, manualRunCount, readyForSchedule }` |
| POST | `/:automationId/runs` | 启动 run（I1 幂等） | member | `{ run, created }` |

> 注意：`/automations/runs/:runId`、`/automations/alerts` 等静态段必须先于 `/:automationId` 注册，避免被动态段吞掉。

#### inbox.ts（prefix `/api/teams/:teamId/inbox`）
| Method | Path | 说明 | 权限 | 出参 |
|---|---|---|---|---|
| GET | `/` | 列出 pending（query: assigneeType/assigneeId 必填） | member | `{ entries }` |
| POST | `/` | 创建 inbox 条目（P5 幂等） | member | `201 { entry, created }` |
| GET | `/:inboxId` | 获取（校验 team 归属） | member | `{ entry }` |
| POST | `/:inboxId/resolve` | resolve（P4 first-responder-wins） | member | `{ entry }` |

#### permissions.ts（prefix `/api/teams/:teamId/permissions`）
| Method | Path | 说明 | 权限 | 出参 |
|---|---|---|---|---|
| GET | `/profile` | 获取权限 profile | member | `{ profile }`（可能 null） |
| PUT | `/profile` | 设置 profile（P1 一致性） | admin | `{ profile }` |
| GET | `/rules` | 列出 standing rules | member | `{ rules }` |
| POST | `/rules` | 创建 standing rule | admin | `201 { rule }` |
| POST | `/rules/:ruleId/revoke` | 撤销 standing rule | admin | `{ rule }` |
| POST | `/check` | 检查工具调用权限（P3 决策顺序） | member | `{ decision, ... }` |

### 1.4 错误映射（service Result → HTTP status code）

service 层返回 `{ ok: false, status, response: { code, message } }`，route 层统一映射：

```ts
// shared.ts::jsonServiceError
c.json({ error: result.response }, result.status)
```

| service status | HTTP | 典型 code |
|---|---|---|
| 400 | 400 Bad Request | `INVALID_TITLE` / `CROSS_TEAM_TASK` / `CROSS_TEAM_DEPENDENCY` / `MISSING_CONTEXT_SNAPSHOT` / `INVALID_MODE_FOR_PROFILE` / `SCOPE_ID_REQUIRED` / `MISSING_ALERT_FIELDS` / `INSERT_FAILED` |
| 403 | 403 Forbidden | `FORBIDDEN` / `FORBIDDEN_CONFIRMER` / `FORBIDDEN_APPROVER` / `FORBIDDEN_ACTION_SELF_MODIFY` / `NOT_READY_FOR_SCHEDULE` |
| 404 | 404 Not Found | `NOT_FOUND` / `TASK_NOT_FOUND` |
| 409 | 409 Conflict | `INVALID_TRANSITION` / `PLAN_NOT_APPROVED` / `PLAN_ALREADY_APPROVED` / `PLAN_NOT_PENDING` / `DEPENDENCY_CYCLE` / `DUPLICATE_DEPENDENCY` / `ALREADY_RESOLVED` / `AGENT_BUSY` / `AGENT_HAS_TASK` / `AGENT_NOT_BUSY` / `VERSION_CONFLICT` / `CROSS_TEAM_TASK` |

非 service 错误（中间件层）：
- 401 `{ error: "unauthorized" }` — 无 user（authenticatedRoute）
- 400 `{ error: "invalid_request", details }` — zod 校验失败（paramValidator/jsonValidator/queryValidator）
- 403 `{ error: "forbidden", message }` — role 不足（teamRoleCheck）或非团队成员
- 404 `{ error: "not_found" }` — 路由不存在（app.notFound）/ 资源不属于该 team
- 409 `{ error: "role_exists" }` / `{ error: "board_exists" }` — DB 唯一约束（roles/boards 直查 DB 路由）

### 1.5 OpenAPI 注册要求
- 每条路由用 `describeRoute({ tags: ["Team Autonomy"], summary, responses })`
- 响应 schema 用 `jsonResponse(description, schema)` + `resolver(zodSchema)`
- 错误 schema 复用 `invalidRequestSchema` / `unauthorizedSchema` / `forbiddenSchema` / `notFoundSchema`
- 在 `app.ts` 的 `openAPIRouteHandler` documentation.tags 中新增 `{ name: "Team Autonomy", description: "..." }`
- 所有 schema 用 `.meta({ ref: "..." })` 注册命名引用

---

## 2. RED 阶段 — 必须失败的测试

在写完路由之前，`tsx --test test/team-autonomy/http-routes.test.ts` 必须出现：
- T1（RED）：`import { registerTeamAutonomyRoutes }` → Module not found / 无导出
- T2（RED）：GET `/api/teams/:teamId/agents` → 404（路由未注册）
- T3（RED）：POST 不带 user → 401
- T4（RED）：viewer 调 admin-only → 403

## 3. GREEN 阶段 — 验收标准

- T1（GREEN）：`registerTeamAutonomyRoutes` 可导入，挂载后路由可达
- T2（GREEN）：未知路由 → 404 `{ error: "not_found" }`
- T3（GREEN）：无 user → 401 `{ error: "unauthorized" }`
- T4（GREEN）：viewer 调 admin-only → 403 `{ error: "forbidden" }`
- T5（GREEN）：invalid body → 400 `{ error: "invalid_request", details: [...] }`
- T6（GREEN）：invalid typeID path param → 400
- T7（GREEN，DB 可用时）：7 组 route 各至少 1 个 happy path 200（agents/tasks/boards/artifacts/automation/inbox/permissions）
- T8（GREEN，DB 可用时）：不存在的资源 → 404
- T9（GREEN，纯逻辑）：错误映射 jsonServiceError / serviceErrorToResponse 输出 `{ error: { code, message } }` + 正确 status

---

## 4. Implementation Log

### 4.1 实施范围（2026-08-04，P2 ① 端到端）

| 阶段 | 状态 | 证据 |
|---|---|---|
| openspec | ✅ | 本文件（7 文件映射 / 中间件链 / Endpoint 矩阵 / 错误映射 / RED-GREEN 清单） |
| RED | ✅ | `index.ts` 不存在时 `ERR_MODULE_NOT_FOUND`（T1 首跑失败）；T2 路由未注册 404 |
| GREEN | ✅ | 7 个 route 文件 + `index.ts` 聚合 + `shared.ts` 扩展（`boardIdParamSchema` 等） |
| e2e | ✅ | 26/26 pass（12 纯逻辑 + 14 集成），0 fail / 0 cancelled / 0 skipped |
| 沉淀 | ✅ | 本小节 |

### 4.2 落地文件与挂载路径

统一挂载：`app.ts` → `registerTeamAutonomyRoutes(app)`，前缀 `/api/teams/:teamId/...`
OpenAPI：`documentation.tags` 新增 `{ name: "Team Autonomy", description: "Team agent/task/board/artifact/automation/inbox/permission routes scoped to /api/teams/:teamId." }`

| 文件 | 挂载前缀 | 说明 |
|---|---|---|
| `src/routes/team-autonomy/index.ts` | — | 聚合 `registerTeamAutonomyRoutes` + `export * from "./shared.js"` |
| `src/routes/team-autonomy/shared.ts` | — | 中间件链（`resolveTeamContext` test 短路 / `teamRoleCheck` / `requireTeamMember`）+ param schemas + `serviceErrorToResponse` / `jsonServiceError`；新增 `boardIdParamSchema` |
| `src/routes/team-autonomy/agents.ts` | `/api/teams/:teamId/agents` | 9 条路由：GET/POST list-create、GET/PATCH/DELETE、assign/unassign/pause/resume |
| `src/routes/team-autonomy/tasks.ts` | `/api/teams/:teamId/tasks` | 10 条路由：list/create/get/status/plan(+approve/reject)/handoff/dependencies |
| `src/routes/team-autonomy/boards.ts` | `/api/teams/:teamId/boards` | 4 条路由：list/create/get/get tasks（`taskService.listByBoard`）；无独立 service，直查 `TeamBoardTable`，唯一约束冲突 → 409 `BOARD_EXISTS` |
| `src/routes/team-autonomy/artifacts.ts` | `/api/teams/:teamId/artifacts` | 7 条路由：list（producer 视图 / downstream 视图）/create/get/transition/versions |
| `src/routes/team-autonomy/automation.ts` | `/api/teams/:teamId/automations` | 13 条路由：list/create/runs(get/advance/fail)/alerts(list/create/ack)/get/update/schedule/manual-run/start-run；`/runs/:runId`、`/alerts` 静态段先于 `/:automationId` 注册；`retryPolicy` 用结构化 schema（`AutomationRetryPolicy`） |
| `src/routes/team-autonomy/inbox.ts` | `/api/teams/:teamId/inbox` | 4 条路由：list（query assigneeType+assigneeId 必填）/create（201 `{entry,created}`）/get/resolve（discriminatedUnion） |
| `src/routes/team-autonomy/permissions.ts` | `/api/teams/:teamId/permissions` | 6 条路由：profile GET/PUT（admin）、rules list/create（admin）、revoke（admin）、check |
| `test/team-autonomy/http-routes.test.ts` | — | node:test + tsx + Hono `app.request()`；mock user/orgContext 短路 `resolveTeamContext`；`maybeDb(t)` 运行时 guard（静态 `skip` 选项在注册时求值不可用）；`after()` 按 typeID 前缀清理 |
| `src/app.ts` | — | import + 挂载 + OpenAPI tag |

### 4.3 关键实现决策

1. **错误映射**：service `{ ok: false, status, response }` → `c.json({ error: response }, status)`（`jsonServiceError`）；中间件层 401/400/403/404 独立映射，见 §1.4。
2. **团队上下文**：`c.req.param("teamId")` 获取；资源归属（`resource.team_id === :teamId`）在 handler 内校验，404 `not_found`。
3. **zod v4**：`z.record` 必须双参 `z.record(z.string(), V)`（v3 单参简写在 v4 类型不兼容）；typeid 列 `eq` 需模板字面量类型（helper 参数声明为 `` `taur_${string}` `` 等）。
4. **类型修正**：agents PATCH 过滤 `null`（service `UpdateAgentInput` 不接受 null）；automation `retryPolicy` 结构化 schema 而非 `Record<string, unknown>`。
5. **测试根因修复**：此前 12 个测试全部 `cancelled` 的根因是 `maybeDb` 未定义 → `describe` 体在 T7a 处抛 `ReferenceError`，套件中止、已注册的 T1–T9b 被取消；补上 `maybeDb` 定义后 26/26 通过。

### 4.4 测试通过证据

命令（仓库根 `openwork/`）：

```bash
cd ee/apps/den-api && pnpm exec tsx --test --test-force-exit test/team-autonomy/http-routes.test.ts
```

结果：`tests 26 · suites 1 · pass 26 · fail 0 · cancelled 0 · skipped 0 · duration_ms ~1770`
（DB 可用，T7a–T7g / T8a–T8g 共 14 个集成测试全部执行，未 skip）

- 纯逻辑 12：T1 模块导入 / T2 未知路由 404 / T3·T3b·T3c 无 user 401 / T4·T4b·T4c viewer 403 / T5 body 400 / T6 非法 typeID 400 / T9·T9b 错误映射
- 集成 14：T7a–T7g 7 组 happy path 200（agents/tasks/boards/artifacts/automations/inbox/permissions）；T8a–T8g 7 组不存在资源 404

类型检查：`pnpm exec tsc --noEmit` 对 `src/app.ts` + `src/routes/team-autonomy/*` 零错误（仓库其余 `src/team-autonomy/*-service.ts` 存在并行任务遗留的类型错误，与本任务无关）。
