/**
 * pi-turn-tps - OpenCode-style turn throughput for the Pi coding agent.
 *
 * Shows one footer item with the average throughput of completed model calls in
 * the current run. It never counts streamed chunks, so buffered delivery cannot
 * produce absurd readings like `740.0 tok/s`.
 *
 * Commands:
 *   /tps            report the current display mode and reading
 *   /tps full       lightning + label + colored value
 *   /tps compact    colored value only
 */

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { readDisplaySetting, settingsPath, writeDisplaySetting } from "./settings";
import {
  assistantModelKey,
  assistantOutputTokens,
  buildDisplay,
  renderDisplay,
  TurnTpsTracker,
  type DisplayMode,
} from "./tps";

const STATUS_KEY = "turnTps";

/** Applies a 24-bit ANSI foreground color. */
function hexColor(hex: string, text: string): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[0m`;
}

export interface TurnTpsOptions {
  /** Overrides the settings file location; used by tests. */
  settingsFile?: string;
}

export default function turnTpsExtension(pi: ExtensionAPI, options?: TurnTpsOptions): void {
  const tracker = new TurnTpsTracker();
  const filePath = options?.settingsFile ?? settingsPath(getAgentDir());
  let display: DisplayMode = "full";

  const render = (ctx: ExtensionContext): void => {
    const parts = buildDisplay(tracker.tps, display);
    const text = renderDisplay(
      parts,
      (label) => ctx.ui.theme.fg("dim", label),
      hexColor,
    );
    ctx.ui.setStatus(STATUS_KEY, text);
  };

  pi.on("session_start", async (_event, ctx) => {
    const setting = await readDisplaySetting(filePath);
    display = setting.display;
    if (setting.error) {
      ctx.ui.notify(`[pi-turn-tps] ${setting.error}; using "${display}"`, "warning");
    }
    tracker.clear();
    render(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    tracker.clear();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("session_before_switch", () => {
    tracker.clear();
  });

  pi.on("session_tree", (_event, ctx) => {
    tracker.clear();
    render(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    tracker.modelSelected();
    render(ctx);
  });

  pi.on("agent_start", () => {
    tracker.agentStart();
  });

  pi.on("turn_start", () => {
    tracker.turnStart(performance.now());
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "user") return;
    // No re-render: the previous reading stays until a new one exists.
    tracker.userMessageDelivered();
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;

    tracker.assistantEnd({
      now: performance.now(),
      tokens: assistantOutputTokens(message),
      modelKey: assistantModelKey(message),
      stopReason: message.stopReason,
    });
    render(ctx);
  });

  pi.on("agent_end", () => {
    tracker.agentEnd();
  });

  pi.registerCommand("tps", {
    description: "Turn throughput display: /tps full | /tps compact",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg !== "full" && arg !== "compact") {
        const tps = tracker.tps;
        const reading =
          tps === null
            ? "no completed model calls yet"
            : `${tps.toFixed(1)} tok/s over ${(tracker.elapsedMs / 1000).toFixed(1)}s of model time`;
        ctx.ui.notify(
          `[pi-turn-tps] display: ${display} · ${reading} · usage: /tps full | /tps compact`,
          arg ? "warning" : "info",
        );
        return;
      }

      display = arg;
      render(ctx);
      const error = await writeDisplaySetting(filePath, display);
      if (error) {
        ctx.ui.notify(`[pi-turn-tps] display: ${display} (not saved: ${error})`, "error");
        return;
      }
      ctx.ui.notify(`[pi-turn-tps] display: ${display}`, "info");
    },
  });
}
