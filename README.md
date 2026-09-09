# pi-turn-tps

Turn throughput (tokens per second) for the [Pi coding agent](https://pi.dev), measured from **completed model calls** instead of streamed chunks.

```text
⚡ TPS: 12.3 tok/s
```

Most TPS extensions count streaming deltas. When a provider buffers output and flushes it in a burst, chunk counting reports absurd values like `740.0 tok/s` that describe delivery, not generation. This extension has no delta path at all: it divides provider-reported output tokens by the time the model call actually took.

> Reference appearance (cropped screenshot of the full display mode):
>
> ![pi-turn-tps full display mode](assets/preview.png)

## Measurement

For the current agent run:

```text
TPS = sum(provider-reported output tokens)
      ────────────────────────────────────
      sum(model call elapsed seconds)
```

A model call spans Pi's `turn_start` event to the assistant `message_end` event. That window includes request preparation, network latency, time to first token, and generation. It excludes tool execution and the gaps between model calls in a turn, because Pi executes tools after `message_end` and emits the next `turn_start` afterwards.

Consequences:

- Buffered, batched, or chunked delivery cannot change the reading.
- Tool-call responses are included: they are real model calls with their own usage and timing.
- Long tool runs and queued work between calls are excluded.
- The number is **observed output throughput for the turn**, not a pure inference benchmark. Provider queueing and network latency are inside the window.

### Token source

The extension uses Pi's normalized `usage.output` from the completed assistant message. Per the Pi SDK, `usage.reasoning` is a subset of `usage.output` when a provider reports it, so reasoning tokens are already included and are never added twice. Input, cache, and tool-result usage are never counted, and streamed deltas are ignored.

### Reset, invalidation, and retention

| Situation | Behavior |
| --- | --- |
| `agent_start` (new run, including an automatic retry) | Totals reset; display shows `—` until the first completed call. |
| New user prompt delivered during a run (for example a steering message) | Totals reset; the turn anchor is kept, so the next call is timed from its own `turn_start`. |
| Responding model changes mid-run | Aggregation restarts at that boundary so two models are never averaged together. |
| Completed call | Tokens and elapsed time are added; the average updates. |
| Missing timing, invalid/negative usage, non-positive elapsed time, error, or abort | The run reading becomes unavailable (`—`) rather than showing a partial average. |
| Tools or queued work between calls | Reading is retained; time is not added. |
| Run ends | The final average stays visible until the next prompt. |
| Session switch, reload, tree navigation, or model change while idle | State is cleared; display shows `—`. |

Zero output is valid and still contributes its elapsed time. No reading is persisted across sessions.

## Display modes

| Mode | Output |
| --- | --- |
| `full` (default) | `⚡ TPS: 12.3 tok/s` — lightning, dim `TPS:` label, colored value |
| `compact` | `12.3 tok/s` — colored value only, no icon or label |

When no trustworthy reading exists, the value is `—` (`⚡ TPS: —` in full mode).

The value is colored by tier, matching the familiar palette:

| TPS | Color |
| --- | --- |
| below 15 | red `#ff4444` |
| 15 – <30 | orange `#ffaa00` |
| 30 – <45 | green `#00ff88` |
| 45 and above | cyan `#44ddff` |

Colors are presentation only and make no claim about provider performance.

## Commands

| Command | Effect |
| --- | --- |
| `/tps` | Report the current mode and reading, plus usage |
| `/tps full` | Lightning + label + colored value |
| `/tps compact` | Colored value only |

The choice is stored in `~/.pi/agent/pi-turn-tps.json`:

```json
{
  "display": "compact"
}
```

Writes are atomic. If the file is malformed or unreadable, the extension warns once at session start and falls back to `full`; if a write fails, the mode still changes for the current session and the failure is reported.

## Installation

```bash
pi install git:github.com/sstehniy/pi-turn-tps
```

or with the raw URL:

```bash
pi install https://github.com/sstehniy/pi-turn-tps
```

Then run `/reload` if Pi was already open. No runtime dependencies are required.

### Powerline footer

The extension publishes its status under the key `turnTps`. To place it in a [powerline-footer](https://github.com/nicobailon/pi-powerline-footer) layout, add a custom item and reference it from the layout:

```json
{
  "powerline": {
    "customItems": [
      {
        "id": "tps",
        "statusKey": "turnTps",
        "position": "right",
        "selfColorize": true
      }
    ],
    "layout": {
      "right": ["context_pct", "cache_read", "custom:tps"]
    }
  }
}
```

`selfColorize: true` keeps the extension's own tier color instead of the item color.

## Development

```bash
bun install
bun run check   # typecheck + tests
```

The extension entry point is `extensions/pi-turn-tps/index.ts`. Measurement and display formatting live in `extensions/pi-turn-tps/tps.ts` as a pure state machine with injected timestamps, so the tests run deterministically without a real model.

## License

MIT
