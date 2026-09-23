import { describe, expect, test } from "bun:test";

import {
  assistantModelKey,
  assistantOutputTokens,
  buildDisplay,
  renderDisplay,
  TPS_COLOR_BLAZING,
  TPS_COLOR_FAST,
  TPS_COLOR_MEDIUM,
  TPS_COLOR_SLOW,
  TurnTpsTracker,
  tpsColor,
  type AssistantLike,
} from "./tps";

const MODEL = "openai/gpt-test";

function complete(
  tracker: TurnTpsTracker,
  now: number,
  tokens: number | null,
  options: { modelKey?: string; stopReason?: string } = {},
): void {
  tracker.assistantEnd({
    now,
    tokens,
    modelKey: options.modelKey ?? MODEL,
    stopReason: options.stopReason ?? "stop",
  });
}

/** Strips ANSI escapes so assertions can match visible text exactly. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("measurement", () => {
  test("matches the OpenCode 2 example and ignores tool delays", () => {
    const tracker = new TurnTpsTracker();
    tracker.agentStart();

    tracker.turnStart(0);
    complete(tracker, 2_000, 20);

    // Tool execution and the next turn preparation take 58 seconds.
    tracker.turnStart(60_000);
    complete(tracker, 63_000, 30);

    expect(tracker.tps).toBe(10);
    expect(tracker.tokens).toBe(50);
    expect(tracker.elapsedMs).toBe(5_000);
  });

  test("is independent of chunked delivery", () => {
    const results = [1, 74, 500].map((chunks) => {
      const tracker = new TurnTpsTracker();
      tracker.agentStart();
      tracker.turnStart(1_000);
      // Streamed deltas are not part of the API: only the completion matters.
      for (let index = 0; index < chunks; index += 1) {
        void index;
      }
      complete(tracker, 4_000, 45);
      return tracker.tps;
    });

    expect(results).toEqual([15, 15, 15]);
  });

  test("includes request latency and time to first token", () => {
    const tracker = new TurnTpsTracker();
    tracker.agentStart();
    tracker.turnStart(0);
    complete(tracker, 5_000, 50);

    expect(tracker.tps).toBe(10);
  });

  test("counts Pi output usage once, including provider-counted reasoning", () => {
    const message: AssistantLike = {
      role: "assistant",
      usage: { output: 100, reasoning: 40 } as AssistantLike["usage"],
      stopReason: "stop",
    };

    expect(assistantOutputTokens(message)).toBe(100);

    const tracker = new TurnTpsTracker();
    tracker.agentStart();
    tracker.turnStart(0);
    complete(tracker, 10_000, assistantOutputTokens(message));

    expect(tracker.tps).toBe(10);
  });

  test("ignores tool result usage", () => {
    const toolResult: AssistantLike = {
      role: "toolResult",
      usage: { output: 9_999 },
    };

    expect(assistantOutputTokens(toolResult)).toBeNull();
  });

  test("includes responses that end in tool calls", () => {
    const tracker = new TurnTpsTracker();
    tracker.agentStart();
    tracker.turnStart(0);
    complete(tracker, 2_000, 20, { stopReason: "toolUse" });

    expect(tracker.tps).toBe(10);
  });

  test("accepts zero output and still accumulates its elapsed time", () => {
    const tracker = new TurnTpsTracker();
    tracker.agentStart();

    tracker.turnStart(0);
    complete(tracker, 1_000, 0);

    tracker.turnStart(1_000);
    complete(tracker, 2_000, 10);

    expect(tracker.tps).toBe(5);
  });

  test("invalidates the run when the turn anchor is missing", () => {
    const tracker = new TurnTpsTracker();
    tracker.agentStart();
    complete(tracker, 1_000, 10);

    expect(tracker.tps).toBeNull();
  });

  test("invalidates the run on invalid usage", () => {
    for (const tokens of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const tracker = new TurnTpsTracker();
      tracker.agentStart();
      tracker.turnStart(0);
      complete(tracker, 1_000, tokens);
      expect(tracker.tps).toBeNull();
    }
  });

  test("invalidates the run on non-positive elapsed time", () => {
    for (const end of [0, -1]) {
      const tracker = new TurnTpsTracker();
      tracker.agentStart();
      tracker.turnStart(0);
      complete(tracker, end, 10);
      expect(tracker.tps).toBeNull();
    }
  });

  test("invalidates the run on aborted and errored responses", () => {
    for (const stopReason of ["aborted", "error"]) {
      const tracker = new TurnTpsTracker();
      tracker.agentStart();
      tracker.turnStart(0);
      complete(tracker, 1_000, 10, { stopReason });
      expect(tracker.tps).toBeNull();
    }
  });

  test("ignores assistant events outside a run", () => {
    const tracker = new TurnTpsTracker();
    complete(tracker, 1_000, 10);
    expect(tracker.tps).toBeNull();
  });

  test("keeps the reading after the run ends", () => {
    const tracker = new TurnTpsTracker();
    tracker.agentStart();
    tracker.turnStart(0);
    complete(tracker, 2_000, 20);
    tracker.agentEnd();

    expect(tracker.tps).toBe(10);
  });

  test("starts fresh on a new run", () => {
    const tracker = new TurnTpsTracker();
    tracker.agentStart();
    tracker.turnStart(0);
    complete(tracker, 2_000, 20);
    expect(tracker.tps).toBe(10);

    tracker.agentStart();
    expect(tracker.tps).toBeNull();

    tracker.turnStart(0);
    complete(tracker, 1_000, 10);
    expect(tracker.tps).toBe(10);
    expect(tracker.tokens).toBe(10);
  });

  test("resets on a delivered steering message but keeps the turn anchor", () => {
    const tracker = new TurnTpsTracker();
    tracker.agentStart();

    tracker.turnStart(0);
    complete(tracker, 1_000, 10);
    expect(tracker.tps).toBe(10);

    // Pi emits turn_start before injecting a queued steering message.
    tracker.turnStart(60_000);
    tracker.userMessageDelivered();
    expect(tracker.tps).toBeNull();

    complete(tracker, 62_000, 30);
    expect(tracker.tps).toBe(15);
    expect(tracker.tokens).toBe(30);
  });

  test("resets aggregation when the responding model changes mid-run", () => {
    const tracker = new TurnTpsTracker();
    tracker.agentStart();

    tracker.turnStart(0);
    complete(tracker, 1_000, 10, { modelKey: "provider/model-a" });

    tracker.turnStart(2_000);
    complete(tracker, 3_000, 30, { modelKey: "provider/model-b" });

    expect(tracker.tps).toBe(30);
    expect(tracker.tokens).toBe(30);
  });

  test("clears state on session and idle model changes", () => {
    const tracker = new TurnTpsTracker();
    tracker.agentStart();
    tracker.turnStart(0);
    complete(tracker, 1_000, 10);
    tracker.agentEnd();

    tracker.modelSelected();
    expect(tracker.tps).toBeNull();

    tracker.agentStart();
    tracker.turnStart(0);
    complete(tracker, 1_000, 10);
    tracker.clear();
    expect(tracker.tps).toBeNull();
  });

  test("keeps state on a model change while a run is active", () => {
    const tracker = new TurnTpsTracker();
    tracker.agentStart();
    tracker.turnStart(0);
    complete(tracker, 1_000, 10);

    tracker.modelSelected();
    expect(tracker.tps).toBe(10);
  });

  test("builds the model identity from provider and response model", () => {
    expect(assistantModelKey({ role: "assistant", provider: "openai", model: "a" })).toBe("openai/a");
    expect(
      assistantModelKey({ role: "assistant", provider: "openai", model: "a", responseModel: "b" }),
    ).toBe("openai/b");
  });
});

describe("display", () => {
  const rgbAnsi = (hex: string, text: string): string => {
    const red = Number.parseInt(hex.slice(1, 3), 16);
    const green = Number.parseInt(hex.slice(3, 5), 16);
    const blue = Number.parseInt(hex.slice(5, 7), 16);
    return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[0m`;
  };

  function plain(tps: number | null, mode: "full" | "compact"): string {
    return stripAnsi(renderDisplay(buildDisplay(tps, mode), (label) => label, rgbAnsi));
  }

  test("renders the full and compact modes with one decimal", () => {
    expect(plain(12.34, "full")).toBe("\u26a1 TPS: 12.3 tok/s");
    expect(plain(12.34, "compact")).toBe("12.3 tok/s");
    expect(plain(100, "full")).toBe("\u26a1 TPS: 100.0 tok/s");
  });

  test("renders unavailable without NaN or Infinity", () => {
    expect(plain(null, "full")).toBe("\u26a1 TPS: \u2014");
    expect(plain(null, "compact")).toBe("\u2014");
    expect(plain(Number.NaN, "full")).toBe("\u26a1 TPS: \u2014");
    expect(plain(Number.POSITIVE_INFINITY, "compact")).toBe("\u2014");
  });

  test("colors the number without coloring following powerline statuses", () => {
    const rendered = renderDisplay(buildDisplay(12.3, "full"), (label) => `\x1b[2m${label}\x1b[0m`, rgbAnsi);
    expect(rendered).toContain(`\x1b[2m\u26a1 TPS:\x1b[0m`);
    expect(rendered).toContain(`${rgbAnsi(TPS_COLOR_SLOW, "12.3")} tok/s`);

    const compact = renderDisplay(buildDisplay(12.3, "compact"), (label) => label, rgbAnsi);
    expect(compact).not.toContain("TPS");
    expect(compact).toBe(`${rgbAnsi(TPS_COLOR_SLOW, "12.3")} tok/s`);
    // Powerline trims terminal ANSI codes from statuses before joining them.
    expect(compact.replace(/(\x1b\[[0-9;]*m|\s|·|[|])+$/, "")).toBe(compact);
  });

  test("maps color tiers at their boundaries", () => {
    expect(tpsColor(0)).toBe(TPS_COLOR_SLOW);
    expect(tpsColor(14.999)).toBe(TPS_COLOR_SLOW);
    expect(tpsColor(15)).toBe(TPS_COLOR_MEDIUM);
    expect(tpsColor(29.999)).toBe(TPS_COLOR_MEDIUM);
    expect(tpsColor(30)).toBe(TPS_COLOR_FAST);
    expect(tpsColor(44.999)).toBe(TPS_COLOR_FAST);
    expect(tpsColor(45)).toBe(TPS_COLOR_BLAZING);
    expect(tpsColor(1_000)).toBe(TPS_COLOR_BLAZING);
  });
});
