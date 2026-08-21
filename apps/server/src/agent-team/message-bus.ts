/**
 * TeamMessageBus - Agent 间消息总线
 *
 * 借鉴 Orca 的 SQLite 消息总线与 LobeHub 的 Group Chat @mention 机制，
 * 实现 team member 之间的直接通信能力。
 *
 * 核心能力：
 * - send(msg): 发送消息（direct / broadcast / system）
 * - subscribe(agentId, handler): 订阅发往指定 agent 的消息
 * - getHistory(agentId): 获取消息历史
 * - clear(): 清空消息（team 销毁时）
 *
 * 消息类型：
 * - direct: 点对点（agent → 指定 agent）
 * - broadcast: 广播（agent → 所有其他 agent）
 * - system: 系统消息（调度器/Supervisor 发出）
 */

export type AgentMessageType = "direct" | "broadcast" | "system";

export interface AgentMessage {
  /** 消息唯一 ID */
  id: string;
  /** 发送方 agentId */
  fromAgentId: string;
  /** 接收方 agentId（"*" 表示广播） */
  toAgentId: string;
  /** 消息类型 */
  type: AgentMessageType;
  /** 消息内容 */
  content: string;
  /** 元数据（可携带任务上下文、文件路径等） */
  metadata?: Record<string, unknown>;
  /** 时间戳 */
  timestamp: number;
}

type MessageHandler = (msg: AgentMessage) => void | Promise<void>;

export class TeamMessageBus {
  private readonly teamId: string;
  private readonly subscribers = new Map<string, Set<MessageHandler>>();
  private readonly history: AgentMessage[] = [];
  private readonly maxHistorySize: number;

  constructor(teamId: string, maxHistorySize = 500) {
    this.teamId = teamId;
    this.maxHistorySize = maxHistorySize;
  }

  /**
   * 发送消息
   *
   * @param msg 消息对象（timestamp 自动填充）
   */
  async send(msg: Omit<AgentMessage, "timestamp" | "id">): Promise<AgentMessage> {
    const fullMsg: AgentMessage = {
      ...msg,
      id: this.generateId(),
      timestamp: Date.now(),
    };

    // 写入历史
    this.history.push(fullMsg);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    // 分发消息
    await this.dispatch(fullMsg);

    return fullMsg;
  }

  /**
   * 订阅发往指定 agent 的消息
   *
   * @param agentId 订阅者的 agentId（"*" 表示订阅所有消息）
   * @param handler 消息处理函数
   * @returns 取消订阅函数
   */
  subscribe(agentId: string, handler: MessageHandler): () => void {
    let set = this.subscribers.get(agentId);
    if (!set) {
      set = new Set();
      this.subscribers.set(agentId, set);
    }
    set.add(handler);

    return () => {
      const handlers = this.subscribers.get(agentId);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.subscribers.delete(agentId);
        }
      }
    };
  }

  /**
   * 获取消息历史（可选过滤条件）
   */
  getHistory(filter?: { fromAgentId?: string; toAgentId?: string; type?: AgentMessageType; limit?: number }): AgentMessage[] {
    let result = [...this.history];

    if (filter?.fromAgentId) {
      result = result.filter((m) => m.fromAgentId === filter.fromAgentId);
    }
    if (filter?.toAgentId) {
      result = result.filter((m) => m.toAgentId === filter.toAgentId || m.toAgentId === "*");
    }
    if (filter?.type) {
      result = result.filter((m) => m.type === filter.type);
    }
    if (filter?.limit && filter.limit > 0) {
      result = result.slice(-filter.limit);
    }

    return result;
  }

  /**
   * 清空所有消息历史和订阅
   */
  clear(): void {
    this.history.length = 0;
    this.subscribers.clear();
  }

  /**
   * 获取统计信息
   */
  getStats(): { totalMessages: number; activeSubscribers: number; teamId: string } {
    return {
      totalMessages: this.history.length,
      activeSubscribers: this.subscribers.size,
      teamId: this.teamId,
    };
  }

  // ---------- 内部实现 ----------

  private async dispatch(msg: AgentMessage): Promise<void> {
    const targets = new Set<string>();

    if (msg.toAgentId === "*" || msg.type === "broadcast") {
      // 广播：通知除发送方外的所有订阅者
      for (const agentId of this.subscribers.keys()) {
        if (agentId !== msg.fromAgentId) {
          targets.add(agentId);
        }
      }
      // 同时通知通配符订阅者
      targets.add("*");
    } else {
      // 直接消息
      targets.add(msg.toAgentId);
    }

    const handlerPromises: Promise<void>[] = [];
    for (const target of targets) {
      const handlers = this.subscribers.get(target);
      if (handlers) {
        for (const handler of handlers) {
          try {
            const result = handler(msg);
            if (result instanceof Promise) {
              handlerPromises.push(result.catch(() => {}));
            }
          } catch {
            // swallow handler errors，不影响其他订阅者
          }
        }
      }
    }

    if (handlerPromises.length > 0) {
      await Promise.allSettled(handlerPromises);
    }
  }

  private generateId(): string {
    return `${this.teamId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
