import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import turnTpsExtension from "./index";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Notification {
  message: string;
  type?: string;
}

interface CommandOptions {
  description?: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function createHarness(settingsFile: string) {
  const handlers = new Map<string, Handler[]>();
  const statuses = new Map<string, string | undefined>();
  const notifications: Notification[] = [];
  const commands = new Map<string, CommandOptions>();

  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, options: CommandOptions) {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (key: string, text: string | undefined) => {
        statuses.set(key, text);
      },
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;

  turnTpsExtension(pi, { settingsFile });

  const emit = async (event: string, payload: unknown = {}): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  };

  const status = (): string => stripAnsi(statuses.get("turnTps") ?? "");

  return { emit, status, statuses, notifications, commands, ctx };
}

function assistantMessage(output: number): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 10,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10 + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-turn-tps-ext-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("extension wiring", () => {
  test("registers the /tps command and the lifecycle handlers", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness(join(dir, "pi-turn-tps.json"));

      expect(harness.commands.has("tps")).toBe(true);
      expect(harness.commands.get("tps")?.description).toContain("compact");

      await harness.emit("session_start", { reason: "startup" });
      expect(harness.status()).toBe("\u26a1 TPS: \u2014");
    });
  });

  test("shows a completed-call average and keeps it until the next value", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness(join(dir, "pi-turn-tps.json"));
      await harness.emit("session_start", { reason: "startup" });

      await harness.emit("agent_start", { type: "agent_start" });
      await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
      await harness.emit("message_end", { type: "message_end", message: assistantMessage(20) });

      const first = harness.status();
      expect(first).toMatch(/^\u26a1 TPS: \d+\.\d tok\/s$/);

      // A new prompt is delivered: the previous reading stays on screen.
      await harness.emit("message_start", { type: "message_start", message: { role: "user" } });
      expect(harness.status()).toBe(first);

      // It is replaced only once the next call completes.
      await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 });
      await harness.emit("message_end", { type: "message_end", message: assistantMessage(40) });
      expect(harness.status()).toMatch(/^\u26a1 TPS: \d+\.\d tok\/s$/);
    });
  });

  test("switches to compact mode, persists it, and restores it", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "pi-turn-tps.json");
      const harness = createHarness(file);
      await harness.emit("session_start", { reason: "startup" });

      await harness.commands.get("tps")?.handler("compact", harness.ctx);

      expect(harness.status()).toBe("\u2014");
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ display: "compact" });

      await harness.emit("agent_start", {});
      await harness.emit("turn_start", {});
      await harness.emit("message_end", { message: assistantMessage(20) });
      expect(harness.status()).toMatch(/^\d+\.\d tok\/s$/);
      expect(harness.status()).not.toContain("TPS");

      const restored = createHarness(file);
      await restored.emit("session_start", { reason: "startup" });
      expect(restored.status()).toBe("\u2014");
    });
  });

  test("reports the current mode and usage without arguments", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness(join(dir, "pi-turn-tps.json"));
      await harness.emit("session_start", { reason: "startup" });

      await harness.commands.get("tps")?.handler("", harness.ctx);

      const last = harness.notifications.at(-1);
      expect(last?.type).toBe("info");
      expect(last?.message).toContain("display: full");
      expect(last?.message).toContain("/tps full | /tps compact");
    });
  });

  test("warns on an unknown argument", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness(join(dir, "pi-turn-tps.json"));
      await harness.emit("session_start", { reason: "startup" });

      await harness.commands.get("tps")?.handler("verbose", harness.ctx);

      expect(harness.notifications.at(-1)?.type).toBe("warning");
    });
  });

  test("warns when the persisted mode cannot be read", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "pi-turn-tps.json");
      await mkdir(file);
      const harness = createHarness(file);

      await harness.emit("session_start", { reason: "startup" });

      expect(harness.status()).toBe("\u26a1 TPS: \u2014");
      expect(harness.notifications.at(-1)?.type).toBe("warning");
    });
  });

  test("reports a failed persistence without losing the in-memory mode", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "pi-turn-tps.json");
      await mkdir(file);
      const harness = createHarness(file);
      await harness.emit("session_start", { reason: "startup" });

      await harness.commands.get("tps")?.handler("compact", harness.ctx);

      expect(harness.status()).toBe("\u2014");
      const last = harness.notifications.at(-1);
      expect(last?.type).toBe("error");
      expect(last?.message).toContain("not saved");
    });
  });

  test("clears the status on session shutdown", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness(join(dir, "pi-turn-tps.json"));
      await harness.emit("session_start", { reason: "startup" });

      await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

      expect(harness.statuses.get("turnTps")).toBeUndefined();
    });
  });
});
