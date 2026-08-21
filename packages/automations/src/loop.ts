import { z } from "zod"
import {
  AutomationEngineAdmissionReceipt,
  AutomationEngineResult,
  AutomationEngineAdapter,
  automationEngineResultSchema,
  automationEnginePendingResultSchema,
  automationEngineExecutionStateSchema,
} from "./engine.js"

export interface LoopConfig {
  maxIterations: number
  goal: string
  goalCheckIntervalMs: number
}

const loopConfigSchema = z.object({
  maxIterations: z.number().int().min(1).max(100),
  goal: z.string().trim().min(1).max(500),
  goalCheckIntervalMs: z.number().int().min(1_000).max(60_000),
})
export type LoopConfigInput = z.infer<typeof loopConfigSchema>

export function checkGoal(goal: string, resultSummary: string | null): boolean {
  if (!resultSummary) return false
  const summaryLower = resultSummary.toLowerCase()
  const goalLower = goal.toLowerCase()
  if (summaryLower.includes("done") || summaryLower.includes("complete")) return true
  const goalWords = goalLower.split(/\s+/).filter((w) => w.length > 3)
  const matched = goalWords.filter((w) => summaryLower.includes(w))
  return matched.length >= Math.ceil(goalWords.length / 2)
}

export async function runLoop(
  adapter: AutomationEngineAdapter,
  config: LoopConfig,
  receipt: AutomationEngineAdmissionReceipt,
): Promise<AutomationEngineResult> {
  const maxIterations = Math.min(config.maxIterations, 100)
  let iteration = 0

  while (iteration < maxIterations) {
    iteration += 1
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []

    for await (const event of adapter.observe(receipt)) {
      if (event.type === "terminal") {
        const result = await adapter.read(receipt)
        if (result && automationEngineResultSchema.safeParse(result).success) {
          const engineResult = result as AutomationEngineResult
          if (engineResult.status === "succeeded") {
            const goalMet = checkGoal(config.goal, engineResult.resultSummary)
            if (goalMet) {
              return engineResult
            }
          }
        }
        break
      }
    }

    if (iteration >= maxIterations) {
      return automationEngineResultSchema.parse({
        executionId: receipt.executionId,
        runId: receipt.runId,
        status: "succeeded",
        threadId: null,
        resultSummary: `Loop reached max iterations (${maxIterations}). Goal "${config.goal}" may not be fully met.`,
        usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
        error: null,
        finalSequence: 0,
        finishedAt: Date.now(),
      })
    }
  }

  return automationEngineResultSchema.parse({
    executionId: receipt.executionId,
    runId: receipt.runId,
    status: "failed",
    threadId: null,
    resultSummary: null,
    usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    error: {
      code: "internal_error",
      message: "Loop exhausted without reaching a terminal state",
      retryable: false,
    },
    finalSequence: 0,
    finishedAt: Date.now(),
  })
}