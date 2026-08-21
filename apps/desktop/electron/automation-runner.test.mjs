import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyAutomationExecutionError,
  createDesktopAutomationRunner,
  executeDesktopAutomation,
  normalizeRunnerBaseUrl,
  runnerTokenAudience,
} from "./automation-runner.mjs"

function runnerTokenFor(audience) {
  const payload = Buffer.from(JSON.stringify({ v: 2, a: audience })).toString("base64url")
  return `${payload}.test-signature`
}

function legacyRunnerToken() {
  const payload = Buffer.from(JSON.stringify({ v: 1, o: "org", m: "member", r: "runner" })).toString("base64url")
  return `${payload}.test-signature`
}

test("model-not-found failures become a repairable Automation error", () => {
  assert.deepEqual(classifyAutomationExecutionError({
    name: "ProviderModelNotFoundError",
    message: "Model not found: opencode/big-pickle",
  }), {
    code: "model_access_lost",
    message: "The selected model opencode/big-pickle is no longer available. Choose a supported model to resume this Automation.",
  })
})

test("runner base URLs require a protected transport", () => {
  assert.equal(normalizeRunnerBaseUrl("https://den.example.com"), "https://den.example.com")
  assert.equal(normalizeRunnerBaseUrl("https://den.example.com/api/"), "https://den.example.com/api")
  assert.equal(normalizeRunnerBaseUrl("http://127.0.0.1:8788"), "http://127.0.0.1:8788")
  assert.equal(normalizeRunnerBaseUrl("http://localhost:8788"), "http://localhost:8788")
  assert.equal(normalizeRunnerBaseUrl("http://den.localhost:8788"), "http://den.localhost:8788")
  assert.equal(normalizeRunnerBaseUrl("http://attacker.example.com"), null)
  assert.equal(normalizeRunnerBaseUrl("ftp://den.example.com"), null)
  assert.equal(normalizeRunnerBaseUrl("https://user:pass@den.example.com"), null)
  assert.equal(normalizeRunnerBaseUrl("not a url"), null)
  assert.equal(normalizeRunnerBaseUrl(undefined), null)
})

test("runner credentials retain their signed Den audience", () => {
  assert.equal(runnerTokenAudience(runnerTokenFor("https://den.example.com/api/den")), "https://den.example.com/api/den")
  assert.equal(runnerTokenAudience("not-a-runner-token"), null)
  assert.equal(runnerTokenAudience(runnerTokenFor("http://attacker.example.com")), null)
})

test("a renderer-supplied non-https base URL never receives the runner token", async () => {
  const attempted = []
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      attempted.push(String(url))
      throw new Error("no network in test")
    },
  })
  runner.configure({
    baseUrl: "http://attacker.example.com",
    token: runnerTokenFor("http://attacker.example.com"),
    runnerId: "runner-1",
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  runner.stop()
  assert.deepEqual(attempted, [])
})

test("a renderer cannot redirect a Den runner credential to another HTTPS origin", async () => {
  const attempted = []
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      attempted.push(String(url))
      throw new Error("no network in test")
    },
  })
  runner.configure({
    baseUrl: "https://attacker.example.com",
    token: runnerTokenFor("https://den.example.com/api/den"),
    runnerId: "runner-1",
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  runner.stop()
  assert.deepEqual(attempted, [])
})

test("a v1 runner credential works only with a main-process trusted Den endpoint", async () => {
  const attempted = []
  const runner = createDesktopAutomationRunner({
    legacyBaseUrls: ["https://den.example.com/api/den"],
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      attempted.push(String(url))
      throw new Error("no network in test")
    },
  })
  runner.configure({
    baseUrl: "https://den.example.com/api/den",
    token: legacyRunnerToken(),
    runnerId: "runner-1",
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  runner.stop()
  assert.ok(attempted.length > 0)
  assert.ok(attempted.every((url) => url.startsWith("https://den.example.com/api/den/")))
})

test("a v1 runner credential cannot use an untrusted HTTPS endpoint", async () => {
  const attempted = []
  const runner = createDesktopAutomationRunner({
    legacyBaseUrls: ["https://den.example.com/api/den"],
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      attempted.push(String(url))
      throw new Error("no network in test")
    },
  })
  runner.configure({
    baseUrl: "https://attacker.example.com",
    token: legacyRunnerToken(),
    runnerId: "runner-1",
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  runner.stop()
  assert.deepEqual(attempted, [])
})

test("a runner credential bound elsewhere reports why this desktop stays disconnected", async () => {
  const logged = []
  const attempted = []
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local" }),
    fetchImpl: async (url) => {
      attempted.push(String(url))
      throw new Error("no network in test")
    },
    log: (state) => logged.push(state),
  })
  runner.configure({
    baseUrl: "https://den.example.com/api/den",
    token: runnerTokenFor("https://api.example.com"),
    runnerId: "runner-1",
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  runner.stop()
  assert.deepEqual(attempted, [])
  assert.deepEqual(logged, [
    "rejected runner credential for https://den.example.com/api/den"
      + ": token audience https://api.example.com",
  ])
})

test("desktop Automation execution creates a normal visible local OpenWork thread", async () => {
  const requests = []
  let snapshots = 0
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ path: parsed.pathname, method: options.method ?? "GET", body })
    if (parsed.pathname === "/workspaces") {
      return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
    }
    if (parsed.pathname === "/workspace/workspace-1/sessions" && options.method === "POST") {
      return Response.json({ item: { id: "session-1" }, started: true }, { status: 201 })
    }
    if (parsed.pathname === "/workspace/workspace-1/sessions/session-1/snapshot") {
      snapshots += 1
      return Response.json({ item: {
        status: { type: snapshots === 1 ? "busy" : "idle" },
        messages: snapshots === 1 ? [] : [{
          info: { role: "assistant", tokens: { input: 12, output: 7 } },
          parts: [{ type: "text", text: "Desktop runner result" }],
        }],
      } })
    }
    throw new Error(`Unexpected request ${parsed.pathname}`)
  }

  const result = await executeDesktopAutomation({
    executionTarget: "desktop",
    runId: "run-1",
    automationId: "automation-1",
    automationName: "Daily brief",
    instructions: "Prepare the brief",
    model: { providerId: "opencode", modelId: "big-pickle" },
    timeoutMs: 30_000,
    leaseExpiresAt: Date.now() + 60_000,
    attempt: 1,
  }, {
    getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
    fetchImpl,
    signal: new AbortController().signal,
  })

  assert.equal(result.sessionId, "session-1")
  assert.equal(result.workspaceId, "workspace-1")
  assert.equal(result.resultSummary, "Desktop runner result")
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7, costMicros: null })
  const create = requests.find((request) => request.path === "/workspace/workspace-1/sessions")
  assert.deepEqual(create?.body, {
    title: "Automation: Daily brief",
    prompt: "Prepare the brief",
    providerId: "opencode",
    modelId: "big-pickle",
  })
})

test("desktop Automation execution surfaces a missing pinned model", async () => {
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === "/workspaces") {
      return Response.json({ items: [{ id: "workspace-1" }], activeId: "workspace-1" })
    }
    if (parsed.pathname === "/workspace/workspace-1/sessions" && options.method === "POST") {
      return Response.json({ item: { id: "session-1" }, started: true }, { status: 201 })
    }
    if (parsed.pathname === "/workspace/workspace-1/sessions/session-1/snapshot") {
      return Response.json({ item: {
        status: { type: "idle" },
        messages: [{
          info: {
            role: "assistant",
            error: {
              name: "ProviderModelNotFoundError",
              message: "Model not found: opencode/big-pickle",
            },
          },
          parts: [],
        }],
      } })
    }
    throw new Error(`Unexpected request ${parsed.pathname}`)
  }

  await assert.rejects(
    executeDesktopAutomation({
      executionTarget: "desktop",
      runId: "run-1",
      automationId: "automation-1",
      automationName: "Daily brief",
      instructions: "Prepare the brief",
      model: { providerId: "opencode", modelId: "big-pickle" },
      timeoutMs: 30_000,
      leaseExpiresAt: Date.now() + 60_000,
      attempt: 1,
    }, {
      getLocalRuntime: async () => ({ baseUrl: "http://127.0.0.1:3000", token: "local-client-token" }),
      fetchImpl,
      signal: new AbortController().signal,
    }),
    (error) => error instanceof Error
      && Reflect.get(error, "code") === "model_access_lost"
      && /Choose a supported model/.test(error.message),
  )
})
