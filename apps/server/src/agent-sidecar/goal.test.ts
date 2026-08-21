import { describe, expect, test } from "bun:test";
import { parseGoal, validateGoalResult } from "./goal.js";

describe("parseGoal", () => {
  test("returns null when no goal is present", () => {
    expect(parseGoal("just some instructions")).toBeNull();
  });

  test("parses a simple goal", () => {
    const result = parseGoal("goal: fix the login bug");
    expect(result).toEqual({ goal: "fix the login bug", successCriteria: [] });
  });

  test("parses goal with success criteria", () => {
    const result = parseGoal("goal: add dark mode\naccepts: theme toggle works, no regressions");
    expect(result?.goal).toBe("add dark mode");
    expect(result?.successCriteria).toEqual(["theme toggle works", "no regressions"]
    );
  });

  test("parses goal with multiple criteria separated by semicolon", () => {
    const result = parseGoal("goal: deploy\ncriteria: builds, passes tests");
    expect(result?.successCriteria).toEqual(["builds", "passes tests"]);
  });
});

describe("validateGoalResult", () => {
  test("returns true when result mentions the goal", () => {
    expect(validateGoalResult("fix the login bug", "I fixed the login bug")).toBe(true);
  });

  test("returns true when result says done", () => {
    expect(validateGoalResult("add dark mode", "done")).toBe(true);
  });

  test("returns true when result says complete", () => {
    expect(validateGoalResult("deploy", "deployment complete")).toBe(true);
  });

  test("returns false when result is empty", () => {
    expect(validateGoalResult("fix the bug", "")).toBe(false);
  });

  test("returns false when result does not mention the goal", () => {
    expect(validateGoalResult("add dark mode", "nothing relevant here")).toBe(false);
  });
});