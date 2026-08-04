// TaskService — 任务依赖图 + 移交 + 计划审批
// OpenSpecs: prds/team-autonomy/openspecs/openspec-task-service.md
//
// 不变量：
// I1: 依赖图无环 — addDependency 时 DFS 三色标记检测环，返回 409/DEPENDENCY_CYCLE
// I2: blocks 自动反向维护 — addDependency(A,B) 同时写 A.depends_on+=B 和 B.blocks+=A；
//     removeDependency 双向移除
// I3: plan_status=pending 时任务不能 start（todo→in_progress）；
//     若 team 启用 plan 模式（default_mode='plan'），start 要求 plan_status=approved
// I4: handoff 必须保留 context_snapshot（非空对象）；写 team_task_handoff 行 + 更新 task.assignee
// I5: approved plan 不可篡改 — setPlan 在 plan_status=approved 时拒绝（409/PLAN_ALREADY_APPROVED）
//
// 注：team-autonomy 表的 JS 属性名为 snake_case（与 org.ts 不同），
// 所有 DB 列引用使用 snake_case，对外 API 使用 camelCase（通过 rowTo* 映射）。

import { db } from "../db.js"
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  PlanStatus,
  TaskAssigneeType,
  TaskPriority,
  TeamTaskHandoffTable,
  TeamTaskTable,
  TeamPermissionProfileTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId, type DenTypeIdName } from "@openwork-ee/utils/typeid"

// 内部：非法 typeid 返回 null（保持"查不到 → 404/空结果"语义，避免 normalizeDenTypeId 抛异常）
function parseDenTypeId<TName extends DenTypeIdName>(name: TName, value: string): DenTypeId<TName> | null {
  try {
    return normalizeDenTypeId(name, value)
  } catch {
    return null
  }
}

// ============================================================
// 类型导出
// ============================================================

export { PlanStatus, TaskAssigneeType, TaskPriority }

export type TaskAssigneeTypeValue = typeof TaskAssigneeType[number]
export type PlanStatusValue = typeof PlanStatus[number]
export type TaskPriorityValue = typeof TaskPriority[number]
export type TaskStatus = "todo" | "in_progress" | "review" | "done"
export type TeamRole = "owner" | "admin" | "editor" | "viewer"

export type Assignee = { type: TaskAssigneeTypeValue; id: string }
export type Actor = { memberId: string; role: TeamRole }

export type TaskRow = {
  id: string
  teamId: string
  boardId: string | null
  title: string
  description: string | null
  status: TaskStatus
  columnId: string
  assigneeType: TaskAssigneeTypeValue
  assigneeId: string
  createdBy: string
  priority: TaskPriorityValue
  dependsOn: string[]
  blocks: string[]
  plan: string | null
  planStatus: PlanStatusValue
  planApprovedBy: string | null
  planApprovedAt: Date | null
  artifacts: string[]
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type HandoffRow = {
  id: string
  taskId: string
  fromAssigneeType: TaskAssigneeTypeValue
  fromAssigneeId: string
  toAssigneeType: TaskAssigneeTypeValue
  toAssigneeId: string
  reason: string | null
  contextSnapshot: Record<string, unknown>
  handedAt: Date
}

export type CreateTaskInput = {
  teamId: string
  boardId?: string
  columnId?: string
  title: string
  description?: string
  assignee: Assignee
  createdBy: string
  priority?: TaskPriorityValue
}

export type CreateTaskResult =
  | { ok: true; task: TaskRow }
  | { ok: false; status: 400; response: { code: string; message: string } }

export type UpdateStatusResult =
  | { ok: true; task: TaskRow; previousStatus: TaskStatus }
  | { ok: false; status: 409; response: { code: "INVALID_TRANSITION" | "PLAN_NOT_APPROVED"; from: TaskStatus; to: TaskStatus } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type SetPlanResult =
  | { ok: true; task: TaskRow }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }
  | { ok: false; status: 409; response: { code: "PLAN_ALREADY_APPROVED"; currentStatus: PlanStatusValue } }

export type ApprovePlanResult =
  | { ok: true; task: TaskRow }
  | { ok: false; status: 403; response: { code: "FORBIDDEN_APPROVER" } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }
  | { ok: false; status: 409; response: { code: "PLAN_NOT_PENDING"; currentStatus: PlanStatusValue } }

export type HandoffResult =
  | { ok: true; task: TaskRow; handoff: HandoffRow }
  | { ok: false; status: 400; response: { code: "MISSING_CONTEXT_SNAPSHOT" | "SAME_ASSIGNEE"; message: string } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

export type AddDependencyResult =
  | { ok: true; task: TaskRow; dependsOnTask: TaskRow }
  | { ok: false; status: 400; response: { code: "CROSS_TEAM_DEPENDENCY"; message: string } }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }
  | { ok: false; status: 409; response: { code: "DEPENDENCY_CYCLE" | "DUPLICATE_DEPENDENCY"; cycle?: string[] } }

export type RemoveDependencyResult =
  | { ok: true; task: TaskRow }
  | { ok: false; status: 404; response: { code: "NOT_FOUND"; message: string } }

// ============================================================
// 纯函数：状态机校验（I1）— 无需 DB，可单测
// ============================================================

const ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress"],
  in_progress: ["review"],
  review: ["in_progress", "done"],
  done: [],
}

export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TASK_TRANSITIONS[from]?.includes(to) ?? false
}

export function canApprovePlan(role: TeamRole): boolean {
  return role === "owner" || role === "admin"
}

// ============================================================
// 纯函数：DFS 三色标记法环检测（I1）
// ============================================================
//
// 三色标记：
//   WHITE (0) — 未访问
//   GRAY  (1) — 在当前 DFS 栈中
//   BLACK (2) — 子树已处理，确认无环
//
// 检测逻辑：DFS 过程中遇到 GRAY 节点 = 后向边 = 环
//
// 参数：
//   edges  — 邻接表（节点 → 后继列表），表示 depends_on 关系
//            A → B 表示 A depends on B
//   startId — DFS 起点
//
// 返回：从 startId 可达的子图中是否存在环
export function hasCycle(edges: Map<string, string[]>, startId: string): boolean {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()

  for (const key of edges.keys()) {
    color.set(key, WHITE)
  }

  function dfs(node: string): boolean {
    color.set(node, GRAY)
    const neighbors = edges.get(node) ?? []
    for (const next of neighbors) {
      const c = color.get(next)
      if (c === GRAY) return true // 后向边 → 环
      if (c === WHITE) {
        if (dfs(next)) return true
      }
      // c === BLACK 或 c === undefined（未知节点，跳过）
    }
    color.set(node, BLACK)
    return false
  }

  // 从 startId 开始 DFS（即使 startId 不在 edges 中，dfs 也能处理）
  return dfs(startId)
}

// ============================================================
// 行映射：snake_case schema → camelCase API
// ============================================================

function rowToTask(row: typeof TeamTaskTable.$inferSelect): TaskRow {
  return {
    id: row.id,
    teamId: row.team_id,
    boardId: row.board_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    columnId: row.column_id,
    assigneeType: row.assignee_type,
    assigneeId: row.assignee_id,
    createdBy: row.created_by,
    priority: row.priority,
    dependsOn: row.depends_on ?? [],
    blocks: row.blocks ?? [],
    plan: row.plan,
    planStatus: row.plan_status,
    planApprovedBy: row.plan_approved_by,
    planApprovedAt: row.plan_approved_at,
    artifacts: row.artifacts ?? [],
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToHandoff(row: typeof TeamTaskHandoffTable.$inferSelect): HandoffRow {
  return {
    id: row.id,
    taskId: row.task_id,
    fromAssigneeType: row.from_assignee_type,
    fromAssigneeId: row.from_assignee_id,
    toAssigneeType: row.to_assignee_type,
    toAssigneeId: row.to_assignee_id,
    reason: row.reason,
    contextSnapshot: row.context_snapshot ?? {},
    handedAt: row.handed_at,
  }
}

// ============================================================
// 内部：查询 team 是否启用 plan 模式
// ============================================================

async function teamRequiresPlanApproval(teamId: string): Promise<boolean> {
  const rows = await db
    .select({ default_mode: TeamPermissionProfileTable.default_mode })
    .from(TeamPermissionProfileTable)
    .where(eq(TeamPermissionProfileTable.team_id, normalizeDenTypeId("team", teamId)))
    .limit(1)
  return rows[0]?.default_mode === "plan"
}

// ============================================================
// 内部：加载整个 team 的依赖图（用于环检测）
// ============================================================

async function loadDependencyGraph(teamId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ id: TeamTaskTable.id, depends_on: TeamTaskTable.depends_on })
    .from(TeamTaskTable)
    .where(eq(TeamTaskTable.team_id, normalizeDenTypeId("team", teamId)))
  const edges = new Map<string, string[]>()
  for (const row of rows) {
    edges.set(row.id, row.depends_on ?? [])
  }
  return edges
}

// ============================================================
// createTask
// ============================================================

export async function createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
  if (!input.title || input.title.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      response: { code: "INVALID_TITLE", message: "title must be non-empty" },
    }
  }

  const id = createDenTypeId("teamTask")
  const columnId = input.columnId ?? "todo"
  await db.insert(TeamTaskTable).values({
    id,
    team_id: normalizeDenTypeId("team", input.teamId),
    board_id: input.boardId ? normalizeDenTypeId("teamBoard", input.boardId) : null,
    title: input.title,
    description: input.description ?? null,
    status: "todo",
    column_id: columnId,
    assignee_type: input.assignee.type,
    assignee_id: input.assignee.id,
    created_by: normalizeDenTypeId("member", input.createdBy),
    priority: input.priority ?? "medium",
    depends_on: [],
    blocks: [],
    plan: null,
    plan_status: "none",
    plan_approved_by: null,
    plan_approved_at: null,
    artifacts: [],
    started_at: null,
    completed_at: null,
  })

  const rows = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, id)).limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 400,
      response: { code: "INSERT_FAILED", message: "task insert did not return a row" },
    }
  }
  return { ok: true, task: rowToTask(rows[0]) }
}

// ============================================================
// getTask
// ============================================================

export async function getTask(taskId: string): Promise<TaskRow | null> {
  const parsedTaskId = parseDenTypeId("teamTask", taskId)
  if (!parsedTaskId) return null
  const rows = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, parsedTaskId)).limit(1)
  return rows[0] ? rowToTask(rows[0]) : null
}

// ============================================================
// updateStatus — I1 状态机 + I3 plan 守门
// ============================================================

export async function updateStatus(
  taskId: string,
  to: TaskStatus,
  _actor: Actor,
): Promise<UpdateStatusResult> {
  const parsedTaskId = parseDenTypeId("teamTask", taskId)
  if (!parsedTaskId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${taskId} not found` },
    }
  }

  const rows = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, parsedTaskId)).limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${taskId} not found` },
    }
  }
  const current = rowToTask(rows[0])
  const previousStatus = current.status

  // I1: 状态机校验
  if (!isValidTaskTransition(previousStatus, to)) {
    return {
      ok: false,
      status: 409,
      response: { code: "INVALID_TRANSITION", from: previousStatus, to },
    }
  }

  // I3: todo → in_progress 时，若 team 启用 plan 模式，要求 plan_status=approved
  if (to === "in_progress" && previousStatus === "todo") {
    const requiresPlan = await teamRequiresPlanApproval(current.teamId)
    if (requiresPlan && current.planStatus !== "approved") {
      return {
        ok: false,
        status: 409,
        response: { code: "PLAN_NOT_APPROVED", from: previousStatus, to },
      }
    }
  }

  const now = new Date()
  const updates: Partial<typeof TeamTaskTable.$inferInsert> = {
    status: to,
    updated_at: now,
  }
  if (to === "in_progress" && !current.startedAt) {
    updates.started_at = now
  }
  if (to === "done") {
    updates.completed_at = now
  }

  await db.update(TeamTaskTable).set(updates).where(eq(TeamTaskTable.id, parsedTaskId))

  const updated = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, parsedTaskId)).limit(1)
  return {
    ok: true,
    task: updated[0] ? rowToTask(updated[0]) : current,
    previousStatus,
  }
}

// ============================================================
// setPlan — I5 approved 不可篡改
// ============================================================

export async function setPlan(
  taskId: string,
  plan: string,
  _actor: Actor,
): Promise<SetPlanResult> {
  const parsedTaskId = parseDenTypeId("teamTask", taskId)
  if (!parsedTaskId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${taskId} not found` },
    }
  }

  const rows = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, parsedTaskId)).limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${taskId} not found` },
    }
  }
  const current = rowToTask(rows[0])

  // I5: approved plan 不可篡改
  if (current.planStatus === "approved") {
    return {
      ok: false,
      status: 409,
      response: { code: "PLAN_ALREADY_APPROVED", currentStatus: current.planStatus },
    }
  }

  await db
    .update(TeamTaskTable)
    .set({
      plan,
      plan_status: "pending",
      plan_approved_by: null,
      plan_approved_at: null,
      updated_at: new Date(),
    })
    .where(eq(TeamTaskTable.id, parsedTaskId))

  const updated = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, parsedTaskId)).limit(1)
  return { ok: true, task: updated[0] ? rowToTask(updated[0]) : current }
}

// ============================================================
// approvePlan — 权限校验 + pending 守门
// ============================================================

export async function approvePlan(taskId: string, actor: Actor): Promise<ApprovePlanResult> {
  const parsedTaskId = parseDenTypeId("teamTask", taskId)
  if (!parsedTaskId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${taskId} not found` },
    }
  }

  const rows = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, parsedTaskId)).limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${taskId} not found` },
    }
  }
  const current = rowToTask(rows[0])

  // 权限校验：owner/admin
  if (!canApprovePlan(actor.role)) {
    return { ok: false, status: 403, response: { code: "FORBIDDEN_APPROVER" } }
  }

  // 必须是 pending 状态
  if (current.planStatus !== "pending") {
    return {
      ok: false,
      status: 409,
      response: { code: "PLAN_NOT_PENDING", currentStatus: current.planStatus },
    }
  }

  const now = new Date()
  await db
    .update(TeamTaskTable)
    .set({
      plan_status: "approved",
      plan_approved_by: normalizeDenTypeId("member", actor.memberId),
      plan_approved_at: now,
      updated_at: now,
    })
    .where(eq(TeamTaskTable.id, parsedTaskId))

  const updated = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, parsedTaskId)).limit(1)
  return { ok: true, task: updated[0] ? rowToTask(updated[0]) : current }
}

// ============================================================
// rejectPlan — pending → rejected
// ============================================================

export async function rejectPlan(
  taskId: string,
  actor: Actor,
  _reason?: string,
): Promise<ApprovePlanResult> {
  const parsedTaskId = parseDenTypeId("teamTask", taskId)
  if (!parsedTaskId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${taskId} not found` },
    }
  }

  const rows = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, parsedTaskId)).limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${taskId} not found` },
    }
  }
  const current = rowToTask(rows[0])

  if (!canApprovePlan(actor.role)) {
    return { ok: false, status: 403, response: { code: "FORBIDDEN_APPROVER" } }
  }

  if (current.planStatus !== "pending") {
    return {
      ok: false,
      status: 409,
      response: { code: "PLAN_NOT_PENDING", currentStatus: current.planStatus },
    }
  }

  await db
    .update(TeamTaskTable)
    .set({ plan_status: "rejected", updated_at: new Date() })
    .where(eq(TeamTaskTable.id, parsedTaskId))

  const updated = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, parsedTaskId)).limit(1)
  return { ok: true, task: updated[0] ? rowToTask(updated[0]) : current }
}

// ============================================================
// requestRevision — approved/pending → revision_requested
// ============================================================

export async function requestRevision(
  taskId: string,
  actor: Actor,
  _reason?: string,
): Promise<ApprovePlanResult> {
  const parsedTaskId = parseDenTypeId("teamTask", taskId)
  if (!parsedTaskId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${taskId} not found` },
    }
  }

  const rows = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, parsedTaskId)).limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${taskId} not found` },
    }
  }
  const current = rowToTask(rows[0])

  if (!canApprovePlan(actor.role)) {
    return { ok: false, status: 403, response: { code: "FORBIDDEN_APPROVER" } }
  }

  // 只允许从 approved 或 pending 转入 revision_requested
  if (current.planStatus !== "approved" && current.planStatus !== "pending") {
    return {
      ok: false,
      status: 409,
      response: { code: "PLAN_NOT_PENDING", currentStatus: current.planStatus },
    }
  }

  await db
    .update(TeamTaskTable)
    .set({ plan_status: "revision_requested", updated_at: new Date() })
    .where(eq(TeamTaskTable.id, parsedTaskId))

  const updated = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, parsedTaskId)).limit(1)
  return { ok: true, task: updated[0] ? rowToTask(updated[0]) : current }
}

// ============================================================
// handoff — I4 context_snapshot 必填 + 写 handoff 行 + 更新 assignee
// ============================================================

export async function handoff(
  taskId: string,
  from: Assignee,
  to: Assignee,
  reason: string,
  contextSnapshot: Record<string, unknown>,
  _actor: Actor,
): Promise<HandoffResult> {
  // I4: context_snapshot 必须是非空对象
  if (
    !contextSnapshot ||
    typeof contextSnapshot !== "object" ||
    Array.isArray(contextSnapshot) ||
    Object.keys(contextSnapshot).length === 0
  ) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "MISSING_CONTEXT_SNAPSHOT",
        message: "context_snapshot must be a non-empty object",
      },
    }
  }

  // from / to 不能相同
  if (from.type === to.type && from.id === to.id) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "SAME_ASSIGNEE",
        message: "from and to assignee must differ",
      },
    }
  }

  const parsedTaskId = parseDenTypeId("teamTask", taskId)
  if (!parsedTaskId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${taskId} not found` },
    }
  }

  const rows = await db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, parsedTaskId)).limit(1)
  if (!rows[0]) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${taskId} not found` },
    }
  }
  const current = rowToTask(rows[0])

  // 写 handoff 行
  const handoffId = createDenTypeId("teamTaskHandoff")
  await db.insert(TeamTaskHandoffTable).values({
    id: handoffId,
    task_id: parsedTaskId,
    from_assignee_type: from.type,
    from_assignee_id: from.id,
    to_assignee_type: to.type,
    to_assignee_id: to.id,
    reason,
    context_snapshot: contextSnapshot,
  })

  // 更新 task.assignee
  await db
    .update(TeamTaskTable)
    .set({
      assignee_type: to.type,
      assignee_id: to.id,
      updated_at: new Date(),
    })
    .where(eq(TeamTaskTable.id, parsedTaskId))

  // 读取 handoff 行（拿到 handed_at 时间戳）
  const handoffRows = await db
    .select()
    .from(TeamTaskHandoffTable)
    .where(eq(TeamTaskHandoffTable.id, handoffId))
    .limit(1)

  const updatedTaskRows = await db
    .select()
    .from(TeamTaskTable)
    .where(eq(TeamTaskTable.id, parsedTaskId))
    .limit(1)

  return {
    ok: true,
    task: updatedTaskRows[0] ? rowToTask(updatedTaskRows[0]) : current,
    handoff: handoffRows[0] ? rowToHandoff(handoffRows[0]) : {
      id: handoffId,
      taskId,
      fromAssigneeType: from.type,
      fromAssigneeId: from.id,
      toAssigneeType: to.type,
      toAssigneeId: to.id,
      reason,
      contextSnapshot,
      handedAt: new Date(),
    },
  }
}

// ============================================================
// addDependency — I1 环检测 + I2 blocks 双向维护
// ============================================================

export async function addDependency(
  taskId: string,
  dependsOnId: string,
): Promise<AddDependencyResult> {
  if (taskId === dependsOnId) {
    return {
      ok: false,
      status: 409,
      response: { code: "DEPENDENCY_CYCLE", cycle: [taskId] },
    }
  }

  const parsedTaskId = parseDenTypeId("teamTask", taskId)
  const parsedDependsOnId = parseDenTypeId("teamTask", dependsOnId)
  if (!parsedTaskId || !parsedDependsOnId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${!parsedTaskId ? taskId : dependsOnId} not found` },
    }
  }

  const rows = await db
    .select()
    .from(TeamTaskTable)
    .where(inArray(TeamTaskTable.id, [parsedTaskId, parsedDependsOnId]))
    .limit(2)

  const taskRow = rows.find((r) => r.id === parsedTaskId)
  const dependsOnRow = rows.find((r) => r.id === parsedDependsOnId)
  if (!taskRow || !dependsOnRow) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${!taskRow ? taskId : dependsOnId} not found` },
    }
  }

  // 同 team 校验
  if (taskRow.team_id !== dependsOnRow.team_id) {
    return {
      ok: false,
      status: 400,
      response: {
        code: "CROSS_TEAM_DEPENDENCY",
        message: `tasks ${taskId} and ${dependsOnId} belong to different teams`,
      },
    }
  }

  const currentDependsOn = taskRow.depends_on ?? []
  // 重复依赖
  if (currentDependsOn.includes(dependsOnId)) {
    return {
      ok: false,
      status: 409,
      response: { code: "DUPLICATE_DEPENDENCY" },
    }
  }

  // I1: 加边后做环检测 — 加 taskId → dependsOnId（taskId depends on dependsOnId）
  // 环存在 ⟺ 从 taskId 开始 DFS 能回到 taskId
  const graph = await loadDependencyGraph(taskRow.team_id)
  // 加新边
  const existing = graph.get(taskId) ?? []
  graph.set(taskId, [...existing, dependsOnId])

  if (hasCycle(graph, taskId)) {
    return {
      ok: false,
      status: 409,
      response: { code: "DEPENDENCY_CYCLE" },
    }
  }

  // I2: 双向写入
  // task.depends_on += dependsOnId
  const newDependsOn = [...currentDependsOn, dependsOnId]
  await db
    .update(TeamTaskTable)
    .set({ depends_on: newDependsOn, updated_at: new Date() })
    .where(eq(TeamTaskTable.id, parsedTaskId))

  // dependsOnTask.blocks += taskId
  const currentBlocks = dependsOnRow.blocks ?? []
  const newBlocks = currentBlocks.includes(taskId) ? currentBlocks : [...currentBlocks, taskId]
  await db
    .update(TeamTaskTable)
    .set({ blocks: newBlocks, updated_at: new Date() })
    .where(eq(TeamTaskTable.id, parsedDependsOnId))

  const updatedTaskRows = await db
    .select()
    .from(TeamTaskTable)
    .where(eq(TeamTaskTable.id, parsedTaskId))
    .limit(1)
  const updatedDependsOnRows = await db
    .select()
    .from(TeamTaskTable)
    .where(eq(TeamTaskTable.id, parsedDependsOnId))
    .limit(1)

  return {
    ok: true,
    task: updatedTaskRows[0] ? rowToTask(updatedTaskRows[0]) : rowToTask(taskRow),
    dependsOnTask: updatedDependsOnRows[0]
      ? rowToTask(updatedDependsOnRows[0])
      : rowToTask(dependsOnRow),
  }
}

// ============================================================
// removeDependency — I2 双向移除
// ============================================================

export async function removeDependency(
  taskId: string,
  dependsOnId: string,
): Promise<RemoveDependencyResult> {
  const parsedTaskId = parseDenTypeId("teamTask", taskId)
  const parsedDependsOnId = parseDenTypeId("teamTask", dependsOnId)
  if (!parsedTaskId || !parsedDependsOnId) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${!parsedTaskId ? taskId : dependsOnId} not found` },
    }
  }

  const rows = await db
    .select()
    .from(TeamTaskTable)
    .where(inArray(TeamTaskTable.id, [parsedTaskId, parsedDependsOnId]))
    .limit(2)

  const taskRow = rows.find((r) => r.id === parsedTaskId)
  const dependsOnRow = rows.find((r) => r.id === parsedDependsOnId)
  if (!taskRow || !dependsOnRow) {
    return {
      ok: false,
      status: 404,
      response: { code: "NOT_FOUND", message: `task ${!taskRow ? taskId : dependsOnId} not found` },
    }
  }

  // 双向移除
  const newDependsOn = (taskRow.depends_on ?? []).filter((id) => id !== dependsOnId)
  const newBlocks = (dependsOnRow.blocks ?? []).filter((id) => id !== taskId)

  await db
    .update(TeamTaskTable)
    .set({ depends_on: newDependsOn, updated_at: new Date() })
    .where(eq(TeamTaskTable.id, parsedTaskId))
  await db
    .update(TeamTaskTable)
    .set({ blocks: newBlocks, updated_at: new Date() })
    .where(eq(TeamTaskTable.id, parsedDependsOnId))

  const updatedRows = await db
    .select()
    .from(TeamTaskTable)
    .where(eq(TeamTaskTable.id, parsedTaskId))
    .limit(1)

  return {
    ok: true,
    task: updatedRows[0] ? rowToTask(updatedRows[0]) : rowToTask(taskRow),
  }
}

// ============================================================
// listByBoard
// ============================================================

export async function listByBoard(boardId: string): Promise<TaskRow[]> {
  const parsedBoardId = parseDenTypeId("teamBoard", boardId)
  if (!parsedBoardId) return []
  const rows = await db
    .select()
    .from(TeamTaskTable)
    .where(eq(TeamTaskTable.board_id, parsedBoardId))
  return rows.map(rowToTask)
}

// ============================================================
// listByAssignee
// ============================================================

export async function listByAssignee(
  teamId: string,
  assignee: Assignee,
): Promise<TaskRow[]> {
  const parsedTeamId = parseDenTypeId("team", teamId)
  if (!parsedTeamId) return []
  const rows = await db
    .select()
    .from(TeamTaskTable)
    .where(
      and(
        eq(TeamTaskTable.team_id, parsedTeamId),
        eq(TeamTaskTable.assignee_type, assignee.type),
        eq(TeamTaskTable.assignee_id, assignee.id),
      ),
    )
  return rows.map(rowToTask)
}
