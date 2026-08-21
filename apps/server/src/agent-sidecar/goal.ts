export interface ParsedGoal {
  goal: string;
  successCriteria: string[];
}

const GOAL_PATTERN = /goal[:：]\s*(.+?)(?:\n|$)/i;
const CRITERIA_PATTERN = /(?:accepts?|criteria|when\s+done|success)[:：]\s*(.+?)(?:\n|$)/i;

export function parseGoal(instructions: string): ParsedGoal | null {
  const goalMatch = instructions.match(GOAL_PATTERN);
  if (!goalMatch) return null;

  const goal = goalMatch[1].trim();
  const criteriaMatch = instructions.match(CRITERIA_PATTERN);
  const criteria = criteriaMatch
    ? criteriaMatch[1].trim().split(/[;,]/).map((s) => s.trim()).filter(Boolean)
    : [];

  return { goal, successCriteria: criteria };
}

export function validateGoalResult(goal: string, result: string): boolean {
  if (!result) return false;
  const resultLower = result.toLowerCase();
  if (resultLower.includes("done") || resultLower.includes("complete")) return true;
  const goalWords = goal.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const matched = goalWords.filter((w) => resultLower.includes(w));
  return matched.length >= Math.ceil(goalWords.length / 2);
}