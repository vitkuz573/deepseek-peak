# deepseek-peak

Track DeepSeek API peak/off-peak pricing hours, and stop opencode from
burning money during peak.

**Schedule** ([source](https://api-docs.deepseek.com/quick_start/pricing)):
peak is **01:00–04:00 and 06:00–10:00 UTC, Monday–Friday**.
Everything else is off-peak, billed at **half** the peak rates.

Two parts, one schedule core (`lib/schedule.mjs`, zero dependencies):

1. **CLI** (`cli.mjs`) — status, live countdown, and scripting helpers.
2. **opencode plugin** (`index.ts` + `tui.ts`) — blocks DeepSeek requests
   during peak hours and interrupts already-running DeepSeek sessions the
   moment peak begins.

## CLI

No install needed, just Node >= 22.18:

```sh
node cli.mjs status
# DeepSeek pricing windows: peak Mon–Fri 01:00–04:00; Mon–Fri 06:00–10:00 UTC; ...
# Now:    2026-09-14 09:13:21 UTC  (2026-09-14 14:13:21 (UTC+05:00))
# Status: PEAK — standard rates (2x off-peak)
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
| `sync [options]` | Re-fetch peak hours from the pricing docs and cache them. `--check` exits 1 when the docs differ from built-in defaults (cron/CI). |

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

### Schedule sync

There is no official machine-readable feed for the peak windows, so
`deepseek-peak sync` scrapes the pricing docs page and extracts them with
strict, fail-loud parsing — anything ambiguous (unknown timezone, unknown
day scope, implausible times, removed peak hours) aborts with a clear error
instead of guessing:

```sh
deepseek-peak sync [--url URL] [--cache PATH] [--json]
deepseek-peak sync --check || echo "peak hours changed upstream!"
```

`sync` validates before writing the cache (`~/.cache/deepseek-peak/schedule.json`,
honours `XDG_CACHE_HOME`, override with `DEEPSEEK_PEAK_CACHE`, page override
with `DEEPSEEK_PEAK_URL`). The guard and the CLI pick up a valid cache
automatically — precedence is `DEEPSEEK_PEAK_SCHEDULE` env > cache file >
built-in defaults — and `status` always tells you which source is active
(warning when the cache is missing/invalid/stale, i.e. older than 30 days).
`--check` exits `1` when the docs differ from the built-in defaults
(`0` when unchanged, `2` on fetch/parse failure), which makes it a good
weekly cron job:

```sh
# crontab: alert me when DeepSeek changes peak hours
0 9 * * 1 deepseek-peak sync --check || ntfy publish my-alerts "DeepSeek peak hours changed"
```

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

Requires **opencode 2.x** (the plugin uses the V2 plugin API: `Plugin.define`,
`setup(ctx)`, `ctx.session.hook`, `ctx.event.subscribe`, `ctx.rpc`).

Point the global config at this directory. OpenCode resolves the package
entry (`index.ts`) and, because the package also exposes a `./tui`
entrypoint, loads the notification half into the CLI automatically — no
second entry in `cli.json`:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///path/to/deepseek-peak",
      "options": { "mode": "block", "abortOnPeak": true }
    }
  ]
}
```

Then `opencode service restart`. Verify with:

```sh
opencode api get '/api/plugin' | grep deepseek-peak
```

The configured path must be a **directory** (or an npm package) — opencode
rejects a path that points at a single file, so `".../opencode-plugin.ts"`
will not load.

What it does:

- **`model.request` hook** — the single guard point. It runs immediately
  before *every* model call a session issues: the agent loop plus title,
  compaction and generate calls, so nothing bills at peak rates through a
  side channel. If the request is guarded (see below) **and** it is peak:
  - `mode: "block"` (default) — throws, the request never reaches the API.
    The error names the model, the endpoint, and when off-peak starts.
  - `mode: "warn"` — lets the request through and publishes a warning.
- **Endpoint-first matching** — peak pricing applies ONLY to DeepSeek's
  official API, so the plugin checks where the request actually goes, not
  just the model name. The endpoint is the `baseURL` the server resolved for
  that exact request, falling back to the provider catalog's
  `settings.baseURL`:
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
  every request, so laptop sleep cannot leave a stale timer). When peak
  begins it interrupts sessions that used DeepSeek models. Candidates come
  from the server event stream (`session.execution.*`), and whether a
  session was really running is decided by the server's own
  `session.interrupt` verdict, so nothing is polled.
- **Toasts** — the server plugin publishes each decision over the `./rpc`
  contract; the TUI half renders those as toasts. One source of truth, so a
  terminal attached to a remote server still gets notified.
- **Pre-transition warning** — a heads-up alert `warnBeforeMin` minutes
  before each transition (default 10), so you can wrap up in time.
- **Ledger** — every block, warn-mode pass, interrupt, and transition is
  appended to a JSONL ledger for `deepseek-peak report`. It doubles as the
  plugin's diagnostic log, since V2 removed the plugin log API.
- **Notifications** — optional JSON POST to `notifyUrl` on transitions.
- Non-DeepSeek models are never blocked; with `abortAllOnPeak: true` their
  running sessions are interrupted too (default `false`).

Options (the `options` object) and ENV overrides:

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

`toast` is honoured by the TUI half; `log` only controls the diagnostic
notices, never the audit entries.

## Development

```sh
npm install        # dev deps for typecheck (typescript, plugin types)
npm test           # node --test: unit + plugin smoke + CLI tests
npm run coverage   # same suite with a 100% lines/branches/functions gate
npm run typecheck  # tsc --noEmit
```

`test/plugin.smoke.mjs` drives the real plugin through its V2 surface
(`setup(ctx)`, `ctx.session.hook`, `ctx.event.subscribe`, `ctx.rpc`) with a
fake context and a synthetic peak window around "now", so it passes at any
hour: endpoint/name matching, block/pass behavior across request kinds, warn
mode, interrupt selection at the peak transition, ledger writes, alert
publishing, and notification POSTs. `test/tui.smoke.mjs` covers the toast
half, `test/present.test.mjs` the reconnect loop, and
`test/commands-*.test.mjs` every CLI command in-process.

## Files

```
deepseek-peak/
  lib/schedule.mjs      schedule core (UTC, no deps) + sync-cache loading
  lib/sync.mjs          docs scraping with strict parsing + cache writing
  lib/match.mjs         endpoint-first DeepSeek matching (official API vs proxies)
  lib/options.mjs       option + ENV resolution shared by both plugin halves
  lib/alerts.mjs        alert payload contract (kinds, variants, validation)
  lib/present.mjs       alert stream -> toasts, with reconnect and cleanup
  lib/ledger.mjs        JSONL ledger: append/read/summarize/savings estimate
  lib/notify.mjs        best-effort JSON POST alerts (ntfy/webhooks)
  lib/commands.mjs      all CLI logic (import-safe; cli.mjs is a 3-line entry)
  cli.mjs               CLI entry point (status/day/report/watch/wait/next/is-peak/sync)
  index.ts              server plugin: guard hook, transitions, interrupts, alerts
  rpc.ts                RPC definition for the alert channel
  tui.ts                TUI plugin: renders alerts as toasts
  test/schedule.test.mjs
  test/sync.test.mjs
  test/match.test.mjs
  test/options.test.mjs
  test/alerts.test.mjs
  test/present.test.mjs
  test/ledger.test.mjs
  test/notify.test.mjs
  test/commands-parse.test.mjs   pure renders, arg parsing
  test/commands-run.test.mjs     every command end-to-end in-process
  test/plugin.smoke.mjs
  test/tui.smoke.mjs
  test/helpers.mjs               synthetic schedules, env/console helpers
  package.json / tsconfig.json / README.md
```
