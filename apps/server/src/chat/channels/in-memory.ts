/**
 * InMemoryChatChannel — 进程内聊天通道（openspec-chat-bridge.md）
 *
 * 队列 + AsyncIterable 拉取，用于测试、本地 demo 与后续 Http 通道的中间层。
 * 不变量：
 * I1: 每条消息 id 唯一（递增）
 * I2: receive() 迭代器每条消息只消费一次（游标去重）
 */

import { ChatMessage, ChatSendOptions, ChatChannelAdapter } from "../types.js";

let seq = 0;

export class InMemoryChatChannel implements ChatChannelAdapter {
  readonly channelId: string;
  private readonly queue: ChatMessage[] = [];
  private readonly listeners = new Set<(msg: ChatMessage) => void>();

  constructor(channelId = "in-memory") {
    this.channelId = channelId;
  }

  /** 推送入站消息（模拟 IM 收到消息） */
  push(input: Omit<ChatMessage, "id" | "timestamp">): ChatMessage {
    const message: ChatMessage = {
      ...input,
      id: `msg-${++seq}`,
      timestamp: Date.now(),
    };
    this.queue.push(message);
    for (const listener of this.listeners) listener(message);
    return message;
  }

  async send(message: ChatMessage, _options?: ChatSendOptions): Promise<void> {
    this.push({ ...message });
  }

  async *receive(conversationId?: string): AsyncIterable<ChatMessage> {
    // 游标语义：每个迭代器独立消费队列，新消息通过 listener 唤醒
    let cursor = 0;
    const wakeups: Array<() => void> = [];
    const listener = () => {
      for (const wake of [...wakeups]) wake();
    };
    this.listeners.add(listener);
    try {
      while (true) {
        if (cursor < this.queue.length) {
          const msg = this.queue[cursor++]!;
          if (!conversationId || msg.conversationId === conversationId) yield msg;
          continue;
        }
        await new Promise<void>((resolve) => {
          wakeups.push(resolve);
          // 兜底轮询：50ms（防止 listener 时序竞争）
          setTimeout(() => {
            const index = wakeups.indexOf(resolve);
            if (index >= 0) wakeups.splice(index, 1);
            resolve();
          }, 50);
        });
      }
    } finally {
      this.listeners.delete(listener);
    }
  }
}
