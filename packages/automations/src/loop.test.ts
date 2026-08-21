import { describe, expect, test } from "bun:test"
import { runLoop, checkGoal } from "./loop.js"
import { automationEngineResultSchema } from "./engine.js"

describe("checkGoal", () => {
  test("returns true when result contains done", () => {
    expect(checkGoal("fix the login bug", "done")).toBe(true)
  })

  test("returns true when result contains complete", () => {
    expect(checkGoal("add dark mode", "complete")).toBe(true)
  })

  test("returns true when result contains enough goal words", () => {
    expect(checkGoal("fix the login bug", "I fixed the login issue")).toBe(true)
  })

  test("returns false when result is empty", () => {
    expect(checkGoal("fix the bug", "")).toBe(false)
  })

  test("returns false when result does not match goal", () => {
    expect(checkGoal("add dark mode", "nothing relevant")).toBe(false)
  })
})

describe("runLoop", () => {
  test("terminates when goal is met", async () => {
    const adapter = {
      capabilities: async () => ({
        adapterId: "test",
        protocolVersion: 1,
        admission: "idempotent",
        reattachment: "receipt",
        eventDelivery: "ordered_at_least_once",
        resultPersistence: "durable",
        cancellation: "unsupported",
        goalCheck: "supported",
        isolation: {
          location: "cloud",
          filesystem: "none",
          shell: false,
          browser: false,
          computer: false,
          connect: "run-scoped",
          network: "provider-and-connect-only",
        },
      }),
      admit: async () => ({
        receiptVersion: 1,
        adapterId: "test",
        executionId: "exec-1",
        admissionKey: "key-1",
        runId: "run-1",
        admittedAt: Date.now(),
        attachment: {},
      }),
      observe: async function* () {
        yield {
          id: "evt-1",
          idempotencyKey: "ik-1",
          executionId: "exec-1",
          runId: "run-1",
          sequence: 1,
          type: "terminal",
          payload: {},
          createdAt: Date.now(),
        }
      },
      read: async () =>
        automationEngineResultSchema.parse({
          executionId: "exec-1",
          runId: "run-1",
          status: "succeeded",
          threadId: null,
          resultSummary: "done",
          usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
          error: null,
          finalSequence: 1,
          finishedAt: Date.now(),
        }),
      cancel: async () => ({
        executionId: "exec-1",
        runId: "run-1",
        outcome: "unsupported",
        requestedAt: Date.now(),
      }),
    }

    const receipt = {
      receiptVersion: 1,
      adapterId: "test",
      executionId: "exec-1",
      admissionKey: "key-1",
      runId: "run-1",
      admittedAt: Date.now(),
      attachment: {},
    }

    const result = await runLoop(adapter, { maxIterations: 5, goal: "fix bug", goalCheckIntervalMs: 1000 }, receipt)
    expect(result.status).toBe("succeeded")
    expect(result.resultSummary).toBe("done")
  })

  test("terminates at max iterations when goal is not met", async () => {
    const adapter = {
      capabilities: async () => ({
        adapterId: "test",
        protocolVersion: 1,
        admission: "idempotent",
        reattachment: "receipt",
        eventDelivery: "ordered_at_least_once",
        resultPersistence: "durable",
        cancellation: "unsupported",
        goalCheck: "supported",
        isolation: {
          location: "cloud",
          filesystem: "none",
          shell: false,
          browser: false,
          computer: false,
          connect: "run-scoped",
          network: "provider-and-connect-only",
        },
      }),
      admit: async () => ({
        receiptVersion: 1,
        adapterId: "test",
        executionId: "exec-1",
        admissionKey: "key-1",
        runId: "run-1",
        admittedAt: Date.now(),
        attachment: {},
      }),
      observe: async function* () {
        yield {
          id: "evt-1",
          idempotencyKey: "ik-1",
          executionId: "exec-1",
          runId: "run-1",
          sequence: 1,
          type: "terminal",
          payload: {},
          createdAt: Date.now(),
        }
      },
      read: async () =>
        automationEngineResultSchema.parse({
          executionId: "exec-1",
          runId: "run-1",
          status: "succeeded",
          threadId: null,
          resultSummary: "partial progress",
          usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
          error: null,
          finalSequence: 1,
          finishedAt: Date.now(),
        }),
      cancel: async () => ({
        executionId: "exec-1",
        runId: "run-1",
        outcome: "unsupported",
        requestedAt: Date.now(),
      }),
    }

    const receipt = {
      receiptVersion: 1,
      adapterId: "test",
      executionId: "exec-1",
      admissionKey: "key-1",
      runId: "run-1",
      admittedAt: Date.now(),
      attachment: {},
    }

    const result = await runLoop(adapter, { maxIterations: 2, goal: "fix the login bug", goalCheckIntervalMs: 1000 }, receipt)
    expect(result.status).toBe("succeeded")
    expect(result.resultSummary).toContain("max iterations")
  })
})