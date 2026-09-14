# deepseek-peak

Track DeepSeek API peak/off-peak pricing hours, and stop opencode from
burning money during peak.

**Schedule** ([source](https://api-docs.deepseek.com/quick_start/pricing)):
peak is **01:00–04:00 and 06:00–10:00 UTC, Monday–Friday**.
Everything else is off-peak, billed at **half** the peak rates.

Two parts, one schedule core (`lib/schedule.mjs`, zero dependencies):

1. **CLI** (`cli.mjs`) — status, live countdown, and scripting helpers.
2. **opencode plugin** (`opencode-plugin.ts`) — blocks DeepSeek requests
   during peak hours and aborts already-running DeepSeek sessions the
   moment peak begins.

## CLI

No install needed, just Node >= 22.18:

```sh
node cli.mjs status
# DeepSeek pricing windows: peak Mon–Fri 01:00–04:00; Mon–Fri 06:00–10:00 UTC; ...
# Now:    2026-09-14 09:13:21 UTC  (2026-09-14 14:13:21 (UTC+05:00))
# Status: PEAK — standard (2x) rates
# Peak ends at 10:00 UTC, in 00:46:38
# Next peak: 2026-09-15 01:00:00 UTC (in 14:59:59)
```

Commands:

| Command | What it does |
|---|---|
| `status` (default) | One-shot status with countdowns. `--json` for machines. |
| `watch` | Live countdown, refreshed every second (Ctrl+C to exit). |
| `is-peak [--json]` | Exit `1` during peak, `0` off-peak. For shell scripts / CI. |
| `next [--unix] [--json]` | Print the next schedule transition. |
| `wait [options]` | Block until peak/off-peak hours start. |

`wait` options: `--for peak|offpeak` (default `offpeak`), `--timeout SEC`
(exit 2 on timeout), `--poll SEC` (default 5), `--exec "CMD"` (run a shell
command once the condition is met), `--quiet` (exit code only).

Examples:

```sh
# Only run the expensive batch job off-peak:
deepseek-peak is-peak || ./run-batch-job.sh

# Start an opencode run as soon as off-peak begins (max 2h of waiting):
deepseek-peak wait --timeout 7200 --exec "opencode run 'nightly refactor'"

# Next transition as epoch seconds (for cron/systemd):
deepseek-peak next --unix
```

Make it global with `npm link` (exposes the `deepseek-peak` binary), or add
an alias to your shell rc.

### Custom schedule

If DeepSeek changes the hours, override without touching code:

```sh
export DEEPSEEK_PEAK_SCHEDULE='[{"days":[1,2,3,4,5],"start":"01:00","end":"04:00"}]'
```

Format: JSON array of `{"days":[0..6, Sun..Sat],"start":"HH:MM","end":"HH:MM"}`
(UTC; `end <= start` means an overnight window).

## opencode plugin

Clone the repo, then register the plugin globally — either copy
`opencode-plugin.ts` plus the `lib/` directory into
`~/.config/opencode/plugins/` (keeping their relative layout, so the
`./lib/schedule.mjs` import keeps resolving; files directly under
`plugins/` are auto-loaded), or reference it by path in
`~/.config/opencode/opencode.jsonc`:

```jsonc
"plugin": [
  ["file:///path/to/deepseek-peak/opencode-plugin.ts",
   { "mode": "block", "abortOnPeak": true }]
]
```

Restart opencode after changing config or the plugin file (loaded once at startup).

What it does:

- **`chat.params` hook** — before every LLM call, if the model looks like
  DeepSeek (matched case-insensitively against provider/model id and name,
  so `neutralbeats-chat/deepseek-v4.1-flash` is covered) **and** it is peak:
  - `mode: "block"` (default) — throws, the request never reaches the API.
    The error tells you when off-peak starts and how to relax the guard.
  - `mode: "warn"` — lets the request through, shows a warning toast.
- **Peak-start timer** — armed for the exact next transition (re-armed on
  every request, so laptop sleep can't leave a stale timer). When peak
  begins it aborts busy sessions that used DeepSeek models (tracked via
  `chat.params` + `session.status` events, double-checked with
  `client.session.status()`), shows a TUI toast, and writes to the opencode
  log. When off-peak begins it shows a "0.5x rates" toast.
- Non-DeepSeek models are never blocked; with `abortAllOnPeak: true` their
  busy sessions are aborted too (default `false`).

Options (second tuple element) and ENV overrides:

| Option | Default | ENV |
|---|---|---|
| `mode: "block" \| "warn"` | `"block"` | `DEEPSEEK_PEAK_MODE` |
| `abortOnPeak` | `true` | `DEEPSEEK_PEAK_ABORT=0` |
| `abortAllOnPeak` | `false` | `DEEPSEEK_PEAK_ABORT_ALL=1` |
| `toast` | `true` | `DEEPSEEK_PEAK_TOAST=0` |
| `log` | `true` | `DEEPSEEK_PEAK_LOG=0` |
| `match: string[]` | `[]` | — (extra substrings treated as DeepSeek) |
| `disabled` | `false` | `DEEPSEEK_PEAK_DISABLE=1` (kill-switch) |

## Development

```sh
npm install        # dev deps for typecheck (typescript, plugin types)
npm test           # node --test: schedule unit tests + plugin smoke test
npm run typecheck  # tsc --noEmit
```

`test/plugin.smoke.mjs` drives the real plugin with a mocked opencode
client and a synthetic peak window around "now", so it passes at any hour:
block on model/provider match, pass-through for other models, warn mode,
and abort-selection at the peak transition.

## Files

```
deepseek-peak/
  lib/schedule.mjs      schedule core (UTC, no deps)
  cli.mjs               CLI (status/watch/wait/next/is-peak)
  opencode-plugin.ts    opencode plugin (type-only external import)
  test/schedule.test.mjs
  test/plugin.smoke.mjs
  package.json / tsconfig.json / README.md
```
