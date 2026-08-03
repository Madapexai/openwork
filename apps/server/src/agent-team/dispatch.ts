/**
 * Dispatch Policy 实现
 *
 * 借鉴 multica 的 task-router 与 cc-connect 的 capability-based selection：
 * - round-robin: 按成员顺序轮流分派（负载均衡）
 * - first-available: 第一个 detect 通过的成员
 * - capability-match: 按能力筛选（如需要 streaming + permissions）
 * - primary-with-fallback: 主力 → 备选（接力失败时启用）
 * - role-based: 按角色筛选
 */

import type { AgentTeamMember, DispatchPolicy, MemberRole } from "./types.js";
import type { SidecarCapabilities } from "../agent-sidecar/types.js";

/** 内部轮询计数器（round-robin 用） */
const roundRobinCounters = new Map<string, number>();

/**
 * 根据 dispatch policy 选择一个成员
 *
 * @returns 选中的成员，或 null 表示无可用成员
 */
export function selectMember(
  policy: DispatchPolicy,
  members: AgentTeamMember[],
  teamId: string,
): AgentTeamMember | null {
  if (members.length === 0) return null;

  switch (policy.kind) {
    case "round-robin": {
      const next = roundRobinCounters.get(teamId) ?? 0;
      const idx = next % members.length;
      roundRobinCounters.set(teamId, next + 1);
      return members[idx] ?? null;
    }

    case "first-available": {
      // 第一个有 handle 且存活的；否则第一个
      for (const m of members) {
        if (m.handle && m.handle.isAlive()) return m;
      }
      return members[0] ?? null;
    }

    case "capability-match": {
      const matched = members.filter((m) => matchesCapabilities(m, policy.required));
      if (matched.length === 0) return null;
      // 多个匹配时取第一个（可扩展为按 capability 评分）
      return matched[0]!;
    }

    case "primary-with-fallback": {
      const primary = members.find((m) => m.agentId === policy.primary);
      if (primary) return primary;
      for (const fallbackId of policy.fallbacks) {
        const fallback = members.find((m) => m.agentId === fallbackId);
        if (fallback) return fallback;
      }
      return null;
    }

    case "role-based": {
      const role: MemberRole = policy.role;
      const matched = members.filter((m) => m.role === role);
      return matched[0] ?? null;
    }

    default: {
      // 穷尽性检查
      return null;
    }
  }
}

/**
 * 检查成员是否满足所需能力
 *
 * - undefined 表示不约束
 * - true 必须满足
 * - false 必须不满足
 */
function matchesCapabilities(
  member: AgentTeamMember,
  required: Partial<SidecarCapabilities>,
): boolean {
  const caps = member.capabilities ?? member.adapter.capabilities;
  if (!caps) return false;
  for (const [key, value] of Object.entries(required)) {
    const actual = caps[key as keyof SidecarCapabilities];
    if (actual !== value) return false;
  }
  return true;
}

/**
 * 重置 round-robin 计数器（测试用）
 */
export function resetRoundRobinCounter(teamId: string): void {
  roundRobinCounters.delete(teamId);
}

/**
 * 列出所有满足能力要求的成员（用于 broadcast 模式筛选参与者）
 */
export function filterMembersByCapabilities(
  members: AgentTeamMember[],
  required: Partial<SidecarCapabilities>,
): AgentTeamMember[] {
  return members.filter((m) => matchesCapabilities(m, required));
}
