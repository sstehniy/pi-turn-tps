# pi-turn-tps

See how fast your Pi model is responding, in tokens per second:

```text
⚡ TPS: 12.3 tok/s
```

![pi-turn-tps full display mode](assets/preview.png)

The reading uses completed model calls rather than streamed chunks, so buffered responses do not create misleading spikes. It includes network wait time but not time spent running tools. The last reading stays visible until a new one is ready; `—` means no reliable reading is available.

## Install

```bash
pi install git:github.com/sstehniy/pi-turn-tps
```

If Pi is already open, run `/reload`.

## Display

| Command | Effect |
| --- | --- |
| `/tps` | Show the current reading and display mode |
| `/tps full` | Show `⚡ TPS: 12.3 tok/s` (default) |
| `/tps compact` | Show `12.3 tok/s` |

The number changes color with the reading: red below 15, orange from 15 to 29.9, green from 30 to 44.9, and cyan at 45 or above. The `tok/s` unit stays uncolored so it does not color other footer items. Your display mode is saved between sessions.

## Powerline footer

To place TPS in a [powerline-footer](https://github.com/nicobailon/pi-powerline-footer) layout, add this custom item to your Pi settings and include it in the layout:

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

`selfColorize: true` keeps the TPS color instead of using the powerline item color.

## License

MIT
