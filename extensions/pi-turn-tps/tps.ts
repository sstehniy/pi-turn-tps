/**
 * Pure turn-throughput measurement and display formatting.
 *
 * Measurement model (inspired by OpenCode 2's turn throughput readout):
 *   TPS = sum(provider-reported output tokens) / sum(model call elapsed seconds)
 *
 * A model call spans `turn_start` -> assistant `message_end`, so the elapsed
 * time includes request preparation, network latency, and generation, while
 * excluding tool execution and the gaps between model calls in a turn.
 *
 * Only completed calls contribute. Streamed deltas are never counted, so
 * buffered or chunked delivery cannot inflate or deflate the reading.
 */

export type DisplayMode = "full" | "compact";

export const DEFAULT_DISPLAY: DisplayMode = "full";

export const TPS_THRESHOLD_MEDIUM = 15;
export const TPS_THRESHOLD_FAST = 30;
export const TPS_THRESHOLD_BLAZING = 45;

export const TPS_COLOR_SLOW = "#ff4444";
export const TPS_COLOR_MEDIUM = "#ffaa00";
export const TPS_COLOR_FAST = "#00ff88";
export const TPS_COLOR_BLAZING = "#44ddff";

/** Placeholder shown when no trustworthy reading exists for the current run. */
export const UNAVAILABLE = "\u2014";

/**
 * Maps a throughput value to its presentation color.
 * Presentation only: the tiers do not make provider performance claims.
 */
export function tpsColor(tps: number): string {
  if (tps >= TPS_THRESHOLD_BLAZING) return TPS_COLOR_BLAZING;
  if (tps >= TPS_THRESHOLD_FAST) return TPS_COLOR_FAST;
  if (tps >= TPS_THRESHOLD_MEDIUM) return TPS_COLOR_MEDIUM;
  return TPS_COLOR_SLOW;
}

export interface TpsDisplay {
  /** Dim label before the value, empty in compact mode. */
  prefix: string;
  /** Value text, always one decimal for a real reading. */
  value: string;
  /** Value color, or null when unavailable. */
  color: string | null;
}

/** Builds the display parts for a reading. Never emits NaN or Infinity. */
export function buildDisplay(tps: number | null, mode: DisplayMode): TpsDisplay {
  const available = tps !== null && Number.isFinite(tps);
  return {
    prefix: mode === "full" ? "\u26a1 TPS:" : "",
    value: available ? `${(tps as number).toFixed(1)} tok/s` : UNAVAILABLE,
    color: available ? tpsColor(tps as number) : null,
  };
}

/**
 * Renders a display with injected styling so tests can assert exact text.
 *
 * @param display Result of `buildDisplay`.
 * @param dim Styles the label.
 * @param color Styles the value with a hex color.
 */
export function renderDisplay(
  display: TpsDisplay,
  dim: (text: string) => string,
  color: (hex: string, text: string) => string,
): string {
  const value = display.color ? color(display.color, display.value) : display.value;
  return display.prefix ? `${dim(display.prefix)} ${value}` : value;
}

/** Minimal shape of an assistant message needed for measurement. */
export interface AssistantLike {
  role: string;
  usage?: { output?: number } | null;
  stopReason?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
}

export interface AssistantCompletion {
  /** Monotonic timestamp in milliseconds (for example `performance.now()`). */
  now: number;
  /** Provider-reported output tokens, or null when unavailable. */
  tokens: number | null;
  /** `provider/model` identity used to detect mid-run model switches. */
  modelKey: string;
  /** Pi stop reason for the response. */
  stopReason: string;
}

/**
 * Returns the provider-reported output token count for an assistant message.
 *
 * Pi's `usage.output` already includes reasoning tokens when a provider reports
 * them (`usage.reasoning` is a subset), so reasoning is never added twice.
 * Non-assistant messages, including tool results, return null.
 */
export function assistantOutputTokens(message: AssistantLike): number | null {
  if (message.role !== "assistant") return null;
  const output = message.usage?.output;
  return typeof output === "number" ? output : null;
}

/** Identity used to avoid averaging across different models in one run. */
export function assistantModelKey(message: AssistantLike): string {
  const provider = message.provider ?? "unknown";
  const model = message.responseModel ?? message.model ?? "unknown";
  return `${provider}/${model}`;
}

/**
 * Accumulates completed model calls for the current agent run.
 *
 * Reset points:
 * - `agentStart`: a new run (including an automatic retry) starts fresh.
 * - `userMessageDelivered`: a new prompt (for example a steering message)
 *   starts a new measurement inside the run.
 * - A mid-run model switch resets the aggregation at that boundary.
 *
 * Any call with missing timing, invalid usage, non-positive elapsed time, or an
 * error/aborted stop reason invalidates the run reading, which then renders as
 * unavailable until the next reset.
 */
export class TurnTpsTracker {
  private inRun = false;
  private valid = true;
  private totalTokens = 0;
  private totalMs = 0;
  private modelKey: string | null = null;
  private turnStartMs: number | null = null;

  /** A new agent run begins. */
  agentStart(): void {
    this.inRun = true;
    this.resetAggregation();
    this.turnStartMs = null;
  }

  /** The agent run ended; keep the latest reading for display. */
  agentEnd(): void {
    this.inRun = false;
    this.turnStartMs = null;
  }

  /** Records the anchor for the model call that is about to start. */
  turnStart(now: number): void {
    this.turnStartMs = now;
  }

  /** A new user prompt was delivered; start a fresh measurement. */
  userMessageDelivered(): void {
    this.resetAggregation();
  }

  /** A model selection happened; clear stale state only while idle. */
  modelSelected(): void {
    if (!this.inRun) this.clear();
  }

  /** Records a completed assistant response. */
  assistantEnd(completion: AssistantCompletion): void {
    if (!this.inRun) return;

    const startedAt = this.turnStartMs;
    this.turnStartMs = null;

    if (startedAt === null) {
      this.valid = false;
      return;
    }

    if (this.modelKey !== null && completion.modelKey !== this.modelKey) {
      this.resetAggregation();
    }

    if (completion.stopReason === "error" || completion.stopReason === "aborted") {
      this.valid = false;
      return;
    }

    const { tokens, now } = completion;
    const elapsedMs = now - startedAt;
    if (tokens === null || !Number.isFinite(tokens) || tokens < 0) {
      this.valid = false;
      return;
    }
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      this.valid = false;
      return;
    }

    this.totalTokens += tokens;
    this.totalMs += elapsedMs;
    if (this.modelKey === null) this.modelKey = completion.modelKey;
  }

  /** Current reading, or null when unavailable. */
  get tps(): number | null {
    if (!this.valid || this.totalMs <= 0) return null;
    return this.totalTokens / (this.totalMs / 1000);
  }

  /** Tokens accumulated for the current measurement. */
  get tokens(): number {
    return this.totalTokens;
  }

  /** Elapsed model-call time accumulated for the current measurement. */
  get elapsedMs(): number {
    return this.totalMs;
  }

  /** Drops all state, for example on session switch or reload. */
  clear(): void {
    this.inRun = false;
    this.turnStartMs = null;
    this.resetAggregation();
  }

  private resetAggregation(): void {
    this.valid = true;
    this.totalTokens = 0;
    this.totalMs = 0;
    this.modelKey = null;
  }
}
