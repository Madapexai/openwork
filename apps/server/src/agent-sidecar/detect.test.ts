import { describe, expect, test } from "bun:test";
import { resolveCleanPath, findBinaryInPath, getBinaryDir } from "./detect.js";
import { AGENT_PRESETS } from "./presets.js";

describe("resolveCleanPath", () => {
  test("returns provided path when given", () => {
    const custom = "/custom/path:/another/path";
    expect(resolveCleanPath(custom)).toBe(custom);
  });

  test("without custom path, returns a sensible default containing system dirs", () => {
    const path = resolveCleanPath();
    expect(path).toContain("/usr/bin");
    expect(path).toContain("/bin");
    expect(path).toContain("/usr/local/bin");
  });

  test("preserves known tool install dirs from PATH", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/Users/test/.nvm/versions/node/v20/bin:/Users/test/.local/bin:/random/dir";
    try {
      const path = resolveCleanPath();
      expect(path).toContain("/Users/test/.nvm/versions/node/v20/bin");
      expect(path).toContain("/Users/test/.local/bin");
      // /random/dir should not be preserved
      expect(path).not.toContain("/random/dir");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("findBinaryInPath", () => {
  test("returns absolute path when binary exists", async () => {
    // /bin/ls is universally available on macOS/Linux
    const result = await findBinaryInPath("ls", "/bin:/usr/bin");
    expect(result).toBe("/bin/ls");
  });

  test("returns null when binary not in path", async () => {
    const result = await findBinaryInPath("nonexistent-binary-xyz", "/usr/bin:/bin");
    expect(result).toBeNull();
  });

  test("handles absolute binary path", async () => {
    const result = await findBinaryInPath("/bin/ls", "/some/other/path");
    expect(result).toBe("/bin/ls");
  });

  test("returns null for non-existent absolute path", async () => {
    const result = await findBinaryInPath("/nonexistent/absolute/path", "/usr/bin");
    expect(result).toBeNull();
  });
});

describe("getBinaryDir", () => {
  test("returns dirname of binary path", () => {
    expect(getBinaryDir("/usr/local/bin/node")).toBe("/usr/local/bin");
    expect(getBinaryDir("/opt/homebrew/bin/bun")).toBe("/opt/homebrew/bin");
  });
});

describe("AGENT_PRESETS binary names", () => {
  test("no duplicate agentIds", () => {
    const ids = Object.keys(AGENT_PRESETS);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test("all ACP presets have 'acp' in args", () => {
    for (const preset of Object.values(AGENT_PRESETS)) {
      if (preset.protocol === "acp") {
        expect(preset.args).toContain("acp");
      }
    }
  });

  test("all presets have a displayName (label)", () => {
    for (const preset of Object.values(AGENT_PRESETS)) {
      expect(typeof preset.label).toBe("string");
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });
});
