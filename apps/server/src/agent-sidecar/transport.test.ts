import { describe, expect, test } from "bun:test";
import { buildTransportEnv, isSecretEnv } from "./transport.js";

describe("buildTransportEnv", () => {
  test("returns entries sorted by name", () => {
    const env = {
      ZEBRA: "1",
      APPLE: "2",
      MANGO: "3",
    };
    const entries = buildTransportEnv(env);
    expect(entries.map((e) => e.name)).toEqual(["APPLE", "MANGO", "ZEBRA"]);
  });

  test("redacts secret env vars (TOKEN/PASSWORD/USERNAME/AUTH/SECRET/KEY/CREDENTIAL)", () => {
    const env = {
      API_TOKEN: "abc123",
      DB_PASSWORD: "secret",
      ADMIN_USERNAME: "admin",
      OAUTH_AUTH: "bearer xyz",
      API_SECRET: "shh",
      SIGNING_KEY: "key1",
      AWS_CREDENTIAL: "AKIA...",
      PUBLIC_VAR: "ok",
    };
    const entries = buildTransportEnv(env);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName.API_TOKEN.redacted).toBe(true);
    expect(byName.API_TOKEN.value).toBe("<redacted>");
    expect(byName.DB_PASSWORD.redacted).toBe(true);
    expect(byName.ADMIN_USERNAME.redacted).toBe(true);
    expect(byName.OAUTH_AUTH.redacted).toBe(true);
    expect(byName.API_SECRET.redacted).toBe(true);
    expect(byName.SIGNING_KEY.redacted).toBe(true);
    expect(byName.AWS_CREDENTIAL.redacted).toBe(true);
    expect(byName.PUBLIC_VAR.redacted).toBe(false);
    expect(byName.PUBLIC_VAR.value).toBe("ok");
  });

  test("filters out undefined values", () => {
    const env: Record<string, string | undefined> = {
      FOO: "bar",
      BAZ: undefined,
    };
    const entries = buildTransportEnv(env);
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("FOO");
  });

  test("treats extraSecrets as additional secret names", () => {
    const env = {
      CUSTOM_SENSITIVE: "shh",
      CUSTOM_OK: "ok",
    };
    const entries = buildTransportEnv(env, ["CUSTOM_SENSITIVE"]);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName.CUSTOM_SENSITIVE.redacted).toBe(true);
    expect(byName.CUSTOM_OK.redacted).toBe(false);
  });
});

describe("isSecretEnv", () => {
  test("matches all 7 secret patterns", () => {
    expect(isSecretEnv("API_TOKEN")).toBe(true);
    expect(isSecretEnv("DB_PASSWORD")).toBe(true);
    expect(isSecretEnv("ADMIN_USERNAME")).toBe(true);
    expect(isSecretEnv("OAUTH_AUTH")).toBe(true);
    expect(isSecretEnv("API_SECRET")).toBe(true);
    expect(isSecretEnv("SIGNING_KEY")).toBe(true);
    expect(isSecretEnv("AWS_CREDENTIAL")).toBe(true);
  });

  test("is case insensitive", () => {
    expect(isSecretEnv("api_token")).toBe(true);
    expect(isSecretEnv("Api_Token")).toBe(true);
  });

  test("returns false for non-secret names", () => {
    expect(isSecretEnv("PATH")).toBe(false);
    expect(isSecretEnv("HOME")).toBe(false);
    expect(isSecretEnv("NODE_ENV")).toBe(false);
  });
});
