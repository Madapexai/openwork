import { beforeAll, describe, expect, test } from "bun:test"
import { AUTOMATION_MODEL_ATTENTION_CAPABILITY } from "@openwork/types/automations"
import { createHmac } from "node:crypto"

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
}

let AutomationRunnerAuth: typeof import("../src/automations/runner-auth.js")["AutomationRunnerAuth"]
let automationRunnerAudienceFromRequest: typeof import("../src/automations/runner-auth.js")["automationRunnerAudienceFromRequest"]
let automationRunnerAudienceFromRequestUrl: typeof import("../src/automations/runner-auth.js")["automationRunnerAudienceFromRequestUrl"]

beforeAll(async () => {
  seedRequiredEnv()
  ;({ AutomationRunnerAuth, automationRunnerAudienceFromRequest, automationRunnerAudienceFromRequestUrl } = await import("../src/automations/runner-auth.js"))
})

describe("Automation runner credentials", () => {
  test("survive process-local auth instances while remaining scoped and tamper-evident", () => {
    const secret = "runner-auth-test-secret".repeat(3)
    const issuer = new AutomationRunnerAuth(secret)
    const verifier = new AutomationRunnerAuth(secret)
    const issued = issuer.issue({
      organizationId: "org_test",
      ownerMemberId: "member_test",
      runnerId: "desktop-test",
      capabilities: [AUTOMATION_MODEL_ATTENTION_CAPABILITY],
    }, "https://den.example.com/api/den")

    expect(verifier.authenticate(`Bearer ${issued.token}`)).toEqual({
      organizationId: "org_test",
      ownerMemberId: "member_test",
      runnerId: "desktop-test",
      capabilities: [AUTOMATION_MODEL_ATTENTION_CAPABILITY],
      audience: "https://den.example.com/api/den",
      expiresAt: issued.expiresAt,
    })
    expect(new AutomationRunnerAuth(`${secret}x`).authenticate(`Bearer ${issued.token}`)).toBeNull()
    expect(verifier.authenticate(`Bearer ${issued.token}x`)).toBeNull()
  })

  test("binds a runner credential to the API base that minted it", () => {
    expect(automationRunnerAudienceFromRequestUrl(
      "https://den.example.com/api/den/v1/automation-runners/token?ignored=true",
    )).toBe("https://den.example.com/api/den")
    expect(() => automationRunnerAudienceFromRequestUrl("https://den.example.com/not-the-token-route"))
      .toThrow("automation_runner_audience_invalid")
  })

  test("binds a Den Web proxied credential to its trusted public route", () => {
    const request = new Request("http://api.openworklabs.com/v1/automation-runners/token", {
      headers: {
        "x-forwarded-host": "app.openworklabs.com",
        "x-forwarded-proto": "https",
        "x-forwarded-prefix": "/api/den",
      },
    })

    expect(automationRunnerAudienceFromRequest(request, {
      trustedOrigins: ["https://app.openworklabs.com"],
    })).toBe("https://app.openworklabs.com/api/den")
  })

  test("trusts the Den Web proxy origin this API is actually served from", async () => {
    const { env } = await import("../src/env.js")
    const denWeb = new URL(env.betterAuthUrl)
    const request = new Request("http://api.internal/v1/automation-runners/token", {
      headers: {
        "x-forwarded-host": denWeb.host,
        "x-forwarded-proto": denWeb.protocol.replace(/:$/, ""),
        "x-forwarded-prefix": "/api/den",
      },
    })

    expect(automationRunnerAudienceFromRequest(request, {
      trustedOrigins: env.publicProxyTrustedOrigins,
    })).toBe(`${denWeb.origin}/api/den`)
    // Hosted deployments proxy every call server-side, so the Den Web origin
    // has no reason to appear in CORS_ORIGINS. Binding off that list alone
    // sends desktops to the internal API, where their credential is refused
    // and every desktop occurrence is recorded as missed.
    expect(automationRunnerAudienceFromRequest(request, { trustedOrigins: [] }))
      .toBe(`${denWeb.protocol}//api.internal`)
  })

  test("keeps a directly reached runner destination on its public scheme", () => {
    const request = new Request("http://api.den.test/v1/automation-runners/token", {
      headers: { "x-forwarded-proto": "https" },
    })

    expect(automationRunnerAudienceFromRequest(request, { trustedOrigins: [] }))
      .toBe("https://api.den.test")
  })

  test("ignores an untrusted forwarded runner destination", () => {
    const request = new Request("https://api.openworklabs.com/v1/automation-runners/token", {
      headers: {
        "x-forwarded-host": "attacker.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-prefix": "/api/den",
      },
    })

    expect(automationRunnerAudienceFromRequest(request, {
      trustedOrigins: ["https://app.openworklabs.com"],
    })).toBe("https://api.openworklabs.com")
  })

  test("keeps legacy v1 credentials capability-free", () => {
    const secret = "runner-auth-test-secret".repeat(3)
    const expiresAt = Date.now() + 60_000
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      o: "org_test",
      m: "member_test",
      r: "desktop-test",
      e: expiresAt,
    })).toString("base64url")
    const signature = createHmac("sha256", secret)
      .update(`openwork-automation-runner-v1.${payload}`)
      .digest("base64url")

    expect(new AutomationRunnerAuth(secret).authenticate(`Bearer ${payload}.${signature}`)).toEqual({
      organizationId: "org_test",
      ownerMemberId: "member_test",
      runnerId: "desktop-test",
      capabilities: [],
      audience: null,
      expiresAt,
    })
  })
})
