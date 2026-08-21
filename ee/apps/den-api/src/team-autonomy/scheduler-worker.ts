// SchedulerWorker — 自动化调度器 loop（独立 worker）
// OpenSpecs: prds/team-autonomy/openspecs/openspec-automation-service.md §7.9
//
// 职责：周期调用 listDueAutomations → 对每个 due 生成幂等 batch_id →
//       startRun → 执行注入的 runHandler（fetching → ... → completed）→ scheduleNextRun
//
// 设计要点：
// - batch_id 幂等：同一 automation 在同一 cron 周期内重复 tick 不会重复 startRun（I1）
// - runHandler 由调用方注入（真实抓取/聚合/投递业务），worker 只负责调度骨架
// - start()/stop() 管理定时器；tick() 可手动触发（测试/运维用）

import {
  listDueAutomations,
  scheduleNextRun,
  startRun,
  type AutomationRow,
  type RunRow,
} from "./automation-service.js"

export type SchedulerRunHandler = (ctx: {
  automation: AutomationRow
  run: RunRow
}) => Promise<void>

export type SchedulerOptions = {
  // 轮询间隔（毫秒），默认 60_000
  intervalMs?: number
  // 自定义 batch_id 生成器；默认基于 cron 周期时间（每周期唯一）
  batchIdFactory?: (automation: AutomationRow, now: Date) => string
  // 实际执行 run 的处理函数（fetching → ... → completed）
  runHandler?: SchedulerRunHandler
  // 单次 tick 内的错误处理（默认吞掉并打日志）
  onError?: (error: unknown, automation: AutomationRow) => void
}

export type SchedulerTickResult = {
  started: string[]
  skipped: string[]
  failed: Array<{ automationId: string; error: string }>
}

// 默认 batch_id：auto-{automationId 后缀}-{YYYYMMDD-HHmm}（本地时区，每周期唯一）
export function defaultBatchIdFactory(automation: AutomationRow, now: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  const idSuffix = automation.id.includes("_") ? automation.id.split("_").pop() : automation.id.slice(-8)
  return `auto-${idSuffix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

export function createSchedulerWorker(options: SchedulerOptions = {}) {
  const intervalMs = options.intervalMs ?? 60_000
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function tick(now: Date = new Date()): Promise<SchedulerTickResult> {
    const result: SchedulerTickResult = { started: [], skipped: [], failed: [] }
    if (running) return result // 防止重入（上次 tick 未完成）
    running = true
    try {
      const { due, skipped } = await listDueAutomations(now)
      for (const s of skipped) result.skipped.push(s.automation.id)

      for (const automation of due) {
        try {
          const batchId = options.batchIdFactory
            ? options.batchIdFactory(automation, now)
            : defaultBatchIdFactory(automation, now)
          const started = await startRun({ automationId: automation.id, batchId })
          if (!started.ok) {
            result.failed.push({ automationId: automation.id, error: started.response.code })
            continue
          }
          if (started.created) {
            result.started.push(started.run.id)
            if (options.runHandler) {
              await options.runHandler({ automation, run: started.run })
            }
          } else {
            result.skipped.push(automation.id) // 同周期重复 tick → batch_id 已存在（I1 幂等）
          }
          await scheduleNextRun(automation.id, now)
        } catch (error) {
          result.failed.push({
            automationId: automation.id,
            error: error instanceof Error ? error.message : String(error),
          })
          if (options.onError) options.onError(error, automation)
        }
      }
      return result
    } finally {
      running = false
    }
  }

  function start(): void {
    if (timer) return
    timer = setInterval(() => {
      tick().catch((error) => {
        if (options.onError) options.onError(error, null as unknown as AutomationRow)
      })
    }, intervalMs)
    // 防止定时器阻止进程退出
    if (typeof timer.unref === "function") timer.unref()
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { start, stop, tick }
}
