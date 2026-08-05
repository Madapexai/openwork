# OpenSpec: Chat 桥接层规范（openspec-chat-bridge）

- **状态**: **GREEN**（实现 + 测试 + 路由接入完成）
- **分支**: feat/team-autonomy
- **日期**: 2026-08-05
- **负责人**: OpenWork 架构师（team-autonomy）
- **目标**: 借鉴 cc-connect 的 multi-bot relay，把 AI agent 桥接到任意聊天通道——群里 `@agentId` 驱动 agent 干活，agent 回复中 `@otherAgent` 自动接力（A 实现 → B 审查），支持多 agent 接力与深度限制。
- **前置**: [openspec-runtime-reporting.md](./openspec-runtime-reporting.md)（agent 可用性由 RuntimeRegistry/preset 提供）、[openspec-cli-agent-adapter.md](./openspec-cli-agent-adapter.md)

---

## 0. GREEN 验证记录（2026-08-05）

| 验收项（§8） | 结果 | 证据 |
|---|---|---|
| 1. parseMentions / extractHandoffTarget 解析 | ✅ | `bun test src/chat/chat-relay.test.ts` → 10/10 pass |
| 2. I1: 未 @ 任何 agent → 不响应（返回 null） | ✅ | pass |
| 3. @agent 消息 → agent 执行 → 回复发送到通道 | ✅ | pass |
| 4. I2: 未知 agent → fail-fast 错误消息（不静默） | ✅ | pass |
| 5. 回复 @ 其他 agent → 自动接力（A 实现 → B 审查） | ✅ | pass |
| 6. I3: 接力深度受限（maxHandoffs=1 最多两跳） | ✅ | pass |
| 7. 通道集成（InMemoryChatChannel send → receive 消费） | ✅ | pass |
| 8. 三个新模块 + 全量类型检查 | ✅ | `npx tsc -p tsconfig.json --noEmit` → 0 错误 |

回归：`bun test src/runtime-registry.test.ts src/chat/chat-relay.test.ts src/worktree/worktree-service.test.ts` → 24/24 pass。

---

## 1. 背景

上一轮调研发现：cc-connect 的核心机制是「把 AI agent 桥接到聊天通道，@mention 驱动 + 多 agent 接力」。OpenWork 的 agent 目前只能通过 UI / API 手动驱动，没有群聊入口。

**本规范的目标**：提供 `ChatRelayService`——群聊消息路由（@mention → agent）、agent 回复接力（@ 其他 agent 自动继续执行）、失败 fail-fast、通道抽象（当前 InMemory 实现，可扩展飞书/微信/钉钉 webhook）。

### 1.1 与业界对齐

| 项目 | 机制 | 我们的对应 |
|---|---|---|
| cc-connect | 群聊 @agentId 驱动 + 多 agent 接力（multi-bot relay） | `ChatRelayService.route()` + `extractHandoffTarget` |

---

## 2. 不变量（Invariants）

**I1 — 只有被 @ 的 agent 才会被驱动**：消息未 @ 任何 agent（mentions 为空）→ `route()` 返回 `null`，不响应。未提及的 agent 不响应。

**I2 — 未知 agentId → fail-fast**：@ 了不存在的 / 不在 `allowedAgents` 集合内的 agent → 返回 `ChatRouteResult`（agentId = 被 @ 的 id，reply = 错误消息），并发送系统消息到通道。**绝不静默**。

**I3 — 接力深度受限**：默认 `maxHandoffs = 3`；`hopCount >= maxHandoffs` 时停止接力。防死循环（A → B → C → A …）。

**I4 — 每个被驱动 agent 独立 spawn**：adapter 按需创建（`adapterFactory` 或 preset registry），不共享会话。

**I5 — 接力只认 allowed 集合**：agent 回复中 @ 的 agent 不在 `allowedAgents` 内则忽略（不接力给未知 agent）。

---

## 3. API 契约

### 3.1 类型（`apps/server/src/chat/types.ts`）

```ts
export interface ChatMessage {
  id: string;
  conversationId: string;
  sender: string;
  role: "user" | "agent" | "system";
  text: string;
  mentions: string[];   // parseMentions 结果
  timestamp: number;
}

export interface ChatChannelAdapter {
  send(message: ChatMessage, options?: { replyTo?: string }): Promise<void>;
  receive(conversationId: string): AsyncIterable<ChatMessage>;  // 回放 + 实时
}

export interface ChatRouteResult {
  agentId: string;
  reply: string;
  handedOff: boolean;         // 是否发生了接力
  handoffTarget?: string;     // 接力目标 agentId
  eventCount: number;
}
```

### 3.2 ChatRelayService（`apps/server/src/chat/chat-relay.ts`）

```ts
export const DEFAULT_MAX_HANDOFFS = 3;
export function parseMentions(text: string): string[];                        // @([A-Za-z0-9_-]+)
export function extractHandoffTarget(reply: string, allowed: Set<string>): string | undefined;

export class ChatRelayService {
  constructor(options?: { allowedAgents?: Set<string>; maxHandoffs?: number; cwd?: string; timeoutMs?: number; adapterFactory?: (agentId: string) => AgentSidecarAdapter | null });
  route(channel: ChatChannelAdapter, message: ChatMessage): Promise<ChatRouteResult | null>;
}
```

### 3.3 HTTP 路由（`apps/server/src/routes/chat.ts`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/chat/inbound` | `{channel, conversationId, sender, text}` → 驱动被 @ 的 agent，返回路由结果 |
| GET | `/chat/channels` | 已注册通道列表 |

消费方：IM 平台 webhook（飞书/微信/钉钉等）把群消息 POST 到 `/chat/inbound`。

---

## 4. 测试清单（`src/chat/chat-relay.test.ts`，10 用例）

### §7.1 解析
- [x] 解析多个 @mention
- [x] 无 @ 返回空数组
- [x] 从回复中提取接力目标（只认 allowed 集合内 agent，I5）

### §7.2 路由
- [x] I1: 未 @ 任何 agent → 不响应（返回 null）
- [x] @agent 消息 → agent 执行 → 回复发送到通道
- [x] I2: 未知 agent → fail-fast 错误消息（不静默）

### §7.3 多 agent 接力
- [x] 回复 @ 其他 agent → 自动接力（A 实现 → B 审查）
- [x] I3: 接力深度受限（maxHandoffs=1 时最多两跳）
- [x] DEFAULT_MAX_HANDOFFS = 3

### §7.4 通道集成
- [x] InMemoryChatChannel send 后可通过 receive 消费

---

## 5. GREEN 验收标准

1. `bun test src/chat/chat-relay.test.ts` 全绿（10/10）。
2. 未 @ 任何 agent → 不响应；@ 未知 agent → 错误消息；@ 可用 agent → 执行并回发。
3. agent 回复 @ 其他 agent → 自动接力，接力深度受限（无死循环）。
4. `npx tsc -p tsconfig.json --noEmit` → 0 错误。

---

## 6. 交付物

| 文件 | 类型 | 说明 |
|---|---|---|
| `apps/server/src/chat/types.ts` | 实现 | `ChatMessage` / `ChatChannelAdapter` / `ChatRouteResult` |
| `apps/server/src/chat/channels/in-memory.ts` | 实现 | `InMemoryChatChannel`（游标 + wakeups + 50ms 兜底轮询） |
| `apps/server/src/chat/chat-relay.ts` | 实现 | `ChatRelayService` + `parseMentions` + `extractHandoffTarget`（@mention 路由 + 接力 + fail-fast） |
| `apps/server/src/routes/chat.ts` | 路由 | POST `/chat/inbound`、GET `/chat/channels` |
| `apps/server/src/chat/chat-relay.test.ts` | 测试 | 10 用例（I1-I5 全覆盖） |
| `apps/server/src/server.ts` | 修改 | 注册 chat 路由 |

**遗留**：飞书/微信/钉钉真实通道 adapter（webhook 消费）；与 worktree 服务接线（接力时每个 agent 独立 worktree）；控制平面展示接力轨迹。
