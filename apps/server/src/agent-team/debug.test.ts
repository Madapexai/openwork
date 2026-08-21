import { describe, expect, test } from "bun:test";
import { PtySidecarAdapter } from "../agent-sidecar/adapters/pty.js";
import type { AgentSidecarConfig } from "../agent-sidecar/types.js";
import { appendFileSync } from "node:fs";

const log = (msg: string) => {
  appendFileSync("/tmp/openwork-debug.log", `${new Date().toISOString()} ${msg}\n`);
};

describe("DEBUG: 2 PTY agents in parallel", () => {
  test("both emit events", async () => {
    log("=== test start ===");
    const makeAdapter = (agentId: string) => {
      const script = `read line; printf '{"type":"agent-message-chunk","text":"${agentId}: %s"}\\n' "$line"; printf '{"type":"stop","stopReason":"end"}\\n'; sleep 0.3`;
      const config: AgentSidecarConfig = {
        agentId,
        protocol: "pty",
        binary: "bash",
        args: ["-c", script],
        outputParser: "jsonl",
      };
      return new PtySidecarAdapter(config);
    };

    const a = makeAdapter("a");
    const b = makeAdapter("b");
    log("[1] starting a");
    const ha = await a.start({ cwd: "/tmp" });
    log("[2] starting b");
    const hb = await b.start({ cwd: "/tmp" });
    log("[3] both started");

    // Write to both stdins
    a.stdin!.write("hello\n");
    b.stdin!.write("world\n");
    log("[4] both wrote to stdin");

    // Collect events from both
    const collectFrom = async (name: string, iter: AsyncIterable<unknown>) => {
      const events: unknown[] = [];
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
      await Promise.race([
        (async () => {
          for await (const ev of iter) {
            events.push(ev);
            log(`[${name}] event: ${JSON.stringify(ev)}`);
            if (events.length >= 5) break;
          }
        })(),
        timeout,
      ]);
      return events;
    };

    log("[5] collecting from a");
    const collectA = collectFrom("a", a.events());
    log("[6] collecting from b");
    const collectB = collectFrom("b", b.events());
    log("[7] awaiting both");

    const [eventsA, eventsB] = await Promise.all([collectA, collectB]);
    log(`[8] a events: ${eventsA.length}, b events: ${eventsB.length}`);

    await ha.stop();
    await hb.stop();
    log("=== test end ===");
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);
  }, 15000);
});
