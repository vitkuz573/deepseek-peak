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
| `day [--date YYYY-MM-DD]` | 24h peak/off-peak timeline with a now-marker (default: today, UTC). |
| `report [options]` | Totals from the plugin event ledger; `--estimate` adds rough $ savings. |
| `watch` | Live countdown, refreshed every second (Ctrl+C to exit). `--frames N` renders N frames and exits (snapshots). |
| `is-peak [--json]` | Exit `1` during peak, `0` off-peak. For shell scripts / CI. |
| `next [--unix] [--json]` | Print the next schedule transition. |
| `wait [options]` | Block until peak/off-peak hours start. |

`wait` options: `--for peak|offpeak` (default `offpeak`), `--timeout SEC`
(exit 2 on timeout), `--poll SEC` (default 5), `--exec "CMD"` (run a shell
command once the condition is met), `--notify URL` (POST a JSON alert once
the condition is met, e.g. `https://ntfy.sh/your-topic`), `--quiet`
(exit code only).

Examples:

```sh
# Only run the expensive batch job off-peak:
deepseek-peak is-peak || ./run-batch-job.sh

# Start an opencode run as soon as off-peak begins (max 2h of waiting):
deepseek-peak wait --timeout 7200 --exec "opencode run 'nightly refactor'"

# Get pinged on your phone when off-peak starts:
deepseek-peak wait --timeout 7200 --notify https://ntfy.sh/my-deepseek

# Next transition as epoch seconds (for cron/systemd):
deepseek-peak next --unix

# What did the guard save me?
deepseek-peak report --estimate
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

### Day timeline

```sh
deepseek-peak day [--date 2026-09-19] [--json]
```

Renders a 24h bar (`█` peak, `░` off-peak) with an hour ruler and a
now-marker when viewing today. Handy for planning batch work.

### Savings ledger & report

The plugin appends every blocked request, warn-mode pass, aborted session,
and schedule transition to a JSONL ledger (default
`~/.local/share/deepseek-peak/events.jsonl`, honours `XDG_DATA_HOME`;
override with `DEEPSEEK_PEAK_LEDGER=<path|0>`):

```sh
deepseek-peak report [--ledger PATH] [--since YYYY-MM-DD] [--json]
deepseek-peak report --estimate [--avg-in 4000 --avg-out 1000 \
  --input-price 0.3 --output-price 1.2]
```

`--estimate` multiplies blocked requests by the peak-vs-off-peak price
delta — explicitly rough (it assumes average token counts), but good
enough to see whether the guard earns its keep.

### Transition notifications

POST a JSON alert (`{service, event, message, at}`) to any HTTP endpoint —
works with ntfy.sh, healthcheck-style webhooks, or your own collector:

```sh
deepseek-peak wait --notify https://ntfy.sh/my-deepseek
```

The plugin can do the same on every schedule transition via the
`notifyUrl` option (see below).

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

- **Endpoint-first matching** — peak pricing applies ONLY to DeepSeek's
  official API, so the plugin checks where the request actually goes
  (`provider.options.baseURL`, e.g. `api.deepseek.com` vs a flat-rate
  proxy like `api.neutralbeats.com`), not just the model name:
  - `matchMode: "endpoint"` (default) — guard official-endpoint traffic.
    Known proxies always pass; an unknown endpoint falls back to name
    matching (conservative).
  - `matchMode: "name"` — match by provider/model id and name only.
  - `matchMode: "both"` — guard when either rule hits (most conservative).
- **`chat.params` hook** — before every LLM call, if the request is guarded
  (see above) **and** it is peak:
  - `mode: "block"` (default) — throws, the request never reaches the API.
    The error tells you when off-peak starts and how to relax the guard.
  - `mode: "warn"` — lets the request through, shows a warning toast.
- **Peak-start timer** — armed for the exact next transition (re-armed on
  every request, so laptop sleep can't leave a stale timer). When peak
  begins it aborts busy sessions that used DeepSeek models (tracked via
  `chat.params` + `session.status` events, double-checked with
  `client.session.status()`), shows a TUI toast, and writes to the opencode
  log. When off-peak begins it shows a "0.5x rates" toast.
- **Pre-transition warning** — a heads-up toast `warnBeforeMin` minutes
  before each transition (default 10), so you can wrap up in time.
- **Ledger** — every block, warn-mode pass, abort, and transition is
  appended to a JSONL ledger for `deepseek-peak report`.
- **Notifications** — optional JSON POST to `notifyUrl` on transitions.
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
| `matchMode` | `"endpoint"` | `DEEPSEEK_PEAK_MATCH` (`endpoint`/`name`/`both`) |
| `warnBeforeMin` | `10` | `DEEPSEEK_PEAK_WARN_BEFORE` (0 disables) |
| `ledger: bool \| path` | `true` | `DEEPSEEK_PEAK_LEDGER` (path, or 0 to disable) |
| `notifyUrl` | `""` | `DEEPSEEK_PEAK_NOTIFY_URL` |
| `disabled` | `false` | `DEEPSEEK_PEAK_DISABLE=1` (kill-switch) |

## Development

```sh
npm install        # dev deps for typecheck (typescript, plugin types)
npm test           # node --test: unit + plugin smoke + CLI tests
npm run coverage   # same suite with a 100% lines/branches/functions gate
npm run typecheck  # tsc --noEmit
```

`test/plugin.smoke.mjs` drives the real plugin with a mocked opencode
client and a synthetic peak window around "now", so it passes at any hour:
endpoint/name matching, block/pass behavior, warn mode, abort-selection at
the peak transition, ledger writes, and notification POSTs.
`test/commands-*.test.mjs` drive every CLI command in-process with
synthetic schedules (deterministic at any hour).

## Files

```
deepseek-peak/
  lib/schedule.mjs      schedule core (UTC, no deps)
  lib/match.mjs         endpoint-first DeepSeek matching (official API vs proxies)
  lib/ledger.mjs        JSONL ledger: append/read/summarize/savings estimate
  lib/notify.mjs        best-effort JSON POST alerts (ntfy/webhooks)
  lib/commands.mjs      all CLI logic (import-safe; cli.mjs is a 3-line entry)
  cli.mjs               CLI entry point (status/day/report/watch/wait/next/is-peak)
  opencode-plugin.ts    opencode plugin (type-only external import)
  test/schedule.test.mjs
  test/match.test.mjs
  test/ledger.test.mjs
  test/notify.test.mjs
  test/commands-parse.test.mjs   pure renders, arg parsing
  test/commands-run.test.mjs     every command end-to-end in-process
  test/plugin.smoke.mjs
  test/helpers.mjs               synthetic schedules, env/console helpers
  package.json / tsconfig.json / README.md
```
