// All deepseek-peak CLI logic (import-safe: no top-level side effects).
//
// cli.mjs is a 3-line entry point that calls main(). Everything else lives
// here so tests can import and drive it in-process: pure render functions
// return strings, command functions return exit codes and write through
// the global console (stubbed in tests).

import { spawnSync } from "node:child_process";
import {
  loadSchedule,
  status,
  nextTransition,
  isPeak,
  formatDuration,
  formatTimeUTC,
  formatTimeLocal,
  formatClockUTC,
  describeWindows,
  dayCells,
} from "./schedule.mjs";
import { defaultLedgerPath, readEvents, summarize, estimateSavings } from "./ledger.mjs";
import { notify } from "./notify.mjs";
import { PRICING_URL, STALE_AFTER_DAYS, syncSchedule } from "./sync.mjs";
import {
  DEFAULT_WINDOWS,
  normalizeWindows,
  loadScheduleWithMeta,
  resolveCachePath,
  cacheAgeDays,
} from "./schedule.mjs";

export function shouldColor(stdout, env) {
  return stdout.isTTY === true && !env.NO_COLOR;
}

export function createColors(enabled) {
  const wrap =
    (code) =>
    (s) =>
      enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
  return {
    red: wrap(31),
    green: wrap(32),
    bold: wrap(1),
    dim: wrap(2),
  };
}

let colors = createColors(shouldColor(process.stdout, process.env));

/** Override the color set (tests pin plain output for stable assertions). */
export function setColors(c) {
  colors = c;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 2_147_483_647))));
}

/**
 * Find the next transition that *starts* peak. Always terminates: window
 * starts recur (every window lists at least one weekday), and every start
 * boundary lands inside peak (overlapping or own window), so the first
 * start boundary encountered has to === "peak".
 */
export function nextPeakStart(now, windows) {
  let cursor = new Date(now.getTime());
  for (;;) {
    const t = nextTransition(new Date(cursor.getTime() + 1000), windows);
    if (t.to === "peak") return t;
    cursor = t.at;
  }
}

export function statusPayload(s) {
  return {
    peak: s.peak,
    now: s.now.toISOString(),
    nowLocal: formatTimeLocal(s.now),
    windows: describeWindows(s.windows),
    transition: {
      at: s.transition.at.toISOString(),
      to: s.transition.to,
      inMs: s.transition.inMs,
      in: formatDuration(s.transition.inMs),
    },
  };
}

export function renderStatus(s, src) {
  const lines = [];
  lines.push(
    `DeepSeek pricing windows: peak ${describeWindows(s.windows)}; everything else is off-peak (half price)`,
  );
  lines.push(`Now:    ${formatTimeUTC(s.now)}  (${formatTimeLocal(s.now)})`);
  if (s.peak) {
    lines.push(`Status: ${colors.bold(colors.red("PEAK"))} — standard (2x) rates`);
    lines.push(`Peak ends at ${formatClockUTC(s.transition.at)}, in ${colors.bold(formatDuration(s.transition.inMs))}`);
  } else {
    lines.push(`Status: ${colors.bold(colors.green("OFF-PEAK"))} — discounted (0.5x) rates`);
    // When off-peak, the next transition is always a peak start: a boundary
    // ending peak can only occur while inside peak (see nextTransition).
    lines.push(`Peak starts at ${formatClockUTC(s.transition.at)}, in ${colors.bold(formatDuration(s.transition.inMs))}`);
  }
  const np = nextPeakStart(s.now, s.windows);
  lines.push(`Next peak: ${formatTimeUTC(np.at)} (in ${formatDuration(np.inMs)})`);
  lines.push(renderSourceLine(src));
  return lines.join("\n");
}

/** One line describing where the active schedule came from. Pure. */
export function renderSourceLine(src, now = new Date()) {
  if (src.source === "env") return "Schedule source: DEEPSEEK_PEAK_SCHEDULE override";
  if (src.source === "cache") {
    const age = cacheAgeDays(src.meta, now);
    const when = src.meta && src.meta.fetchedAt ? `fetched ${src.meta.fetchedAt}` : "unknown fetch date";
    const stale = age > STALE_AFTER_DAYS ? ` — STALE (${Math.floor(age)}d old, run \`deepseek-peak sync\`)` : "";
    return `Schedule source: cache (${when})${stale}`;
  }
  if (src.cacheIssue) {
    return `Schedule source: built-in defaults (schedule cache invalid: ${src.cacheIssue} — run \`deepseek-peak sync\`)`;
  }
  return `Schedule source: built-in defaults (${PRICING_URL})`;
}

export function cmdStatus(opts) {
  const loaded = loadScheduleWithMeta();
  const s = status(new Date(), loaded.windows);
  if (opts.json) {
    console.log(
      JSON.stringify({
        ...statusPayload(s),
        schedule:
          loaded.source === "cache"
            ? { source: loaded.source, meta: loaded.meta }
            : loaded.cacheIssue
              ? { source: loaded.source, cacheIssue: loaded.cacheIssue }
              : { source: loaded.source },
      }),
    );
  } else console.log(renderStatus(s, loaded));
  return 0;
}

export function cmdIsPeak(opts) {
  const s = status(new Date(), loadSchedule());
  if (opts.json) {
    const p = statusPayload(s);
    console.log(JSON.stringify({ peak: p.peak, transition: p.transition }));
  } else if (!opts.quiet) console.log(s.peak ? "peak" : "off-peak");
  return s.peak ? 1 : 0;
}

export function cmdNext(opts) {
  const t = nextTransition(new Date(), loadSchedule());
  if (opts.json) {
    console.log(JSON.stringify({ at: t.at.toISOString(), to: t.to, inMs: t.inMs, in: formatDuration(t.inMs) }, null, 2));
  } else if (opts.unix) {
    console.log(Math.floor(t.at.getTime() / 1000));
  } else {
    console.log(`${t.to === "peak" ? "Peak starts" : "Peak ends"}: ${formatTimeUTC(t.at)} (in ${formatDuration(t.inMs)})`);
  }
  return 0;
}

export async function cmdWait(opts) {
  const target = opts.for === "peak" ? "peak" : "offpeak";
  const pollMs = Math.max(1, Number(opts.poll ?? 5)) * 1000;
  const deadline = opts.timeout ? Date.now() + Number(opts.timeout) * 1000 : Infinity;
  const windows = loadSchedule();
  for (;;) {
    const now = new Date();
    const peak = isPeak(now, windows);
    const met = target === "peak" ? peak : !peak;
    if (met) {
      if (!opts.quiet) console.log(target === "peak" ? "Peak hours are on." : "Off-peak hours are on. DeepSeek calls are half price.");
      if (opts.notify) {
        const event = target === "peak" ? "peak-start" : "offpeak-start";
        const ok = await notify(opts.notify, {
          service: "deepseek-peak",
          event,
          message:
            target === "peak"
              ? "DeepSeek peak hours started — standard (2x) rates."
              : "DeepSeek off-peak hours started — discounted (0.5x) rates.",
          at: new Date().toISOString(),
        });
        if (!opts.quiet) console.log(ok ? `Notified ${opts.notify}.` : `Notify to ${opts.notify} failed (continuing anyway).`);
      }
      if (opts.exec) {
        const r = spawnSync(opts.exec, { shell: true, stdio: "inherit" });
        return r.status ?? 0;
      }
      return 0;
    }
    if (Date.now() >= deadline) {
      console.error(`deepseek-peak: timed out waiting for ${target} hours.`);
      return 2;
    }
    const t = nextTransition(now, windows);
    if (!opts.quiet) {
      console.log(
        `[${formatTimeUTC(now)}] ${target === "peak" ? "waiting for peak" : "waiting for off-peak"} — ` +
          `${t.to === "peak" ? "peak starts" : "peak ends"} at ${formatClockUTC(t.at)} (in ${formatDuration(t.inMs)})`,
      );
    }
    await sleep(Math.min(pollMs, t.inMs, Math.max(0, deadline - Date.now())));
  }
}

export function renderWatchFrame(s) {
  const lines = [];
  lines.push(colors.bold("DeepSeek peak-hours monitor") + colors.dim(`  (peak: ${describeWindows(s.windows)})`));
  lines.push(`Now (UTC):   ${formatTimeUTC(s.now)}`);
  lines.push(`Now (local): ${formatTimeLocal(s.now)}`);
  lines.push(
    s.peak
      ? `Status: ${colors.bold(colors.red("PEAK"))} — standard (2x) rates`
      : `Status: ${colors.bold(colors.green("OFF-PEAK"))} — discounted (0.5x) rates`,
  );
  lines.push(
    `${s.transition.to === "peak" ? "Peak starts" : "Peak ends"} in ${colors.bold(formatDuration(s.transition.inMs))} ` +
      `(at ${formatTimeUTC(s.transition.at)})`,
  );
  const np = nextPeakStart(s.now, s.windows);
  lines.push(`Next peak: ${formatTimeUTC(np.at)} (in ${formatDuration(np.inMs)})`);
  lines.push(colors.dim("Ctrl+C to exit"));
  return lines.join("\n");
}

export async function cmdWatch(opts) {
  const maxFrames = opts.frames ?? Infinity;
  if (!process.stdout.isTTY) {
    console.error("deepseek-peak: watch needs a TTY; use `status` for one-shot output.");
    return 2;
  }
  for (let frame = 0; frame < maxFrames; frame++) {
    process.stdout.write("\x1bc");
    process.stdout.write(renderWatchFrame(status(new Date(), loadSchedule())) + "\n");
    if (frame + 1 >= maxFrames) break;
    await sleep(1000);
  }
  return 0;
}

export function parseDay(value) {
  if (value == null || value === "") {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error(`Bad --date: ${value}, expected YYYY-MM-DD`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`Bad --date: ${value}`);
  return new Date(Date.UTC(year, month - 1, day));
}

export function renderDay(day, windows, now) {
  const cells = dayCells(day, windows, 2); // 48 half-hour slots
  const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day.getUTCDay()];
  const ymd = day.toISOString().slice(0, 10);
  let ruler = "";
  let ticks = "";
  for (let h = 0; h < 24; h += 3) {
    ruler += String(h).padStart(2, "0") + "    ";
    ticks += "|" + "     ";
  }
  const lines = [];
  lines.push(colors.bold(`DeepSeek · ${dayName} ${ymd} (UTC)`));
  lines.push(colors.dim(ruler));
  lines.push(colors.dim(ticks));
  lines.push(cells.map((c) => (c.peak ? colors.red("█") : colors.green("░"))).join(""));
  const dayStartMs = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  if (now.getTime() >= dayStartMs && now.getTime() < dayStartMs + 86400000) {
    const idx = Math.min(47, Math.floor((now.getTime() - dayStartMs) / 1800000));
    const pad2 = (n) => String(n).padStart(2, "0");
    lines.push(
      " ".repeat(idx) +
        "^" +
        ` now ${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())} UTC — ${isPeak(now, windows) ? "PEAK" : "OFF-PEAK"}`,
    );
  }
  lines.push(colors.dim(`Peak ${describeWindows(windows)} · off-peak half price`));
  return lines.join("\n");
}

export function cmdDay(opts, now = new Date()) {
  const day = parseDay(opts.date);
  const windows = loadSchedule();
  if (opts.json) {
    console.log(JSON.stringify(dayCells(day, windows, 2).map((c) => ({ start: c.start.toISOString(), peak: c.peak }))));
    return 0;
  }
  console.log(renderDay(day, windows, now));
  return 0;
}

export async function cmdReport(opts) {
  const path = opts.ledger ?? defaultLedgerPath();
  const events = await readEvents(path, { since: opts.since ?? undefined });
  const s = summarize(events);
  const est = opts.estimate
    ? estimateSavings(s.blocked, {
        avgIn: opts.avgIn,
        avgOut: opts.avgOut,
        inputPrice: opts.inputPrice,
        outputPrice: opts.outputPrice,
      })
    : null;
  if (opts.json) {
    console.log(JSON.stringify({ ledger: path, ...s, estimate: est }, null, 2));
    return 0;
  }
  console.log(`DeepSeek peak-guard report · ledger ${path}`);
  if (events.length === 0) {
    console.log("No events recorded yet. The opencode plugin writes here on every block/abort/transition.");
    return 0;
  }
  console.log(`Events: ${s.total} (${(s.firstTs ?? "?").slice(0, 10)} → ${(s.lastTs ?? "?").slice(0, 10)})`);
  console.log(`Blocked requests: ${colors.bold(String(s.blocked))} · warn-mode passes: ${s.warned} · aborted sessions: ${s.aborted}`);
  console.log(`Transitions seen: ${s.peakStarts} peak starts, ${s.offpeakStarts} off-peak starts`);
  for (const day of Object.keys(s.byDay).sort()) {
    const d = s.byDay[day];
    console.log(`  ${day}: blocked ${d.blocked} · warned ${d.warned} · aborted ${d.aborted}`);
  }
  if (est) {
    console.log(
      `Rough savings: $${est.totalUsd.toFixed(2)} across ${s.blocked} blocked request(s) ` +
        `(~$${est.perRequestUsd.toFixed(4)} each; assumes ${est.assumptions.avgIn} in / ${est.assumptions.avgOut} out ` +
        `tokens at $${est.assumptions.inputPrice}/$${est.assumptions.outputPrice} per 1M peak input/output tokens).`,
    );
  }
  return 0;
}

export function resolveSyncUrl(opts, env = process.env) {
  return opts.url ?? env.DEEPSEEK_PEAK_URL ?? PRICING_URL;
}

export async function cmdSync(opts) {
  const url = resolveSyncUrl(opts);
  const cachePath = opts.cache ?? resolveCachePath();
  try {
    const result = await syncSchedule({ url, cachePath });
    if (opts.json) {
      console.log(
        JSON.stringify(
          { url, cachePath, changed: result.changed, meta: result.meta, windows: result.windows },
          null,
          2,
        ),
      );
    } else if (opts.check) {
      if (result.changed) {
        console.log(`DeepSeek peak hours CHANGED vs built-in defaults (source: ${url}):`);
        console.log(`  scraped:  ${describeWindows(result.windows)}`);
        console.log(`  built-in: ${describeWindows(normalizeWindows(DEFAULT_WINDOWS))}`);
        console.log(`Cache updated at ${cachePath}. If this looks right, update DEFAULT_WINDOWS in lib/schedule.mjs.`);
      } else {
        console.log(`DeepSeek peak hours unchanged (source: ${url}). Cache refreshed at ${cachePath}.`);
      }
    } else {
      console.log(`Schedule synced from ${url} → ${cachePath}:`);
      console.log(`  ${describeWindows(result.windows)} (fetched ${result.meta.fetchedAt})`);
      if (result.changed) {
        console.log("NOTE: this differs from the built-in defaults — the cache takes effect immediately.");
      }
    }
    return opts.check ? (result.changed ? 1 : 0) : 0;
  } catch (err) {
    console.error(`deepseek-peak: sync failed: ${err.message} (cache untouched)`);
    return 2;
  }
}

export function printHelp() {
  console.log(`deepseek-peak — track DeepSeek API peak/off-peak pricing hours.

Usage: deepseek-peak [command] [options]

Commands:
  status                 one-shot status with countdowns (default)
  day [--date YYYY-MM-DD] 24h peak/off-peak timeline (default: today, UTC)
  report [options]       totals from the plugin event ledger (+ --estimate $)
  is-peak [--json]       exit 1 during peak, 0 off-peak (for scripts/CI)
  next [--unix] [--json] print the next schedule transition
  wait [options]         block until peak/off-peak hours start
  watch [--frames N]     live countdown (Ctrl+C to exit; --frames N exits
                         after N frames — handy for snapshots)
  sync [options]         re-fetch peak hours from the pricing docs and cache
                         them (strict parsing — fails loud instead of guessing)

Wait options:
  --for peak|offpeak     what to wait for (default: offpeak)
  --timeout SEC          give up after SEC seconds (exit 2)
  --poll SEC             re-check every SEC seconds (default: 5)
  --exec "CMD"           run CMD via shell once the condition is met
  --notify URL           POST a JSON alert to URL once the condition is met
                         (e.g. https://ntfy.sh/your-topic)
  --quiet, -q            print nothing, only set the exit code

Report options:
  --ledger PATH          ledger file (default: XDG data dir events.jsonl)
  --since YYYY-MM-DD     only events from this date on
  --estimate             add a rough $ savings estimate for blocked requests
  --avg-in N             assumed input tokens per request (default: 4000)
  --avg-out N            assumed output tokens per request (default: 1000)
  --input-price X        peak input $ per 1M tokens (default: 0.3)
  --output-price Y       peak output $ per 1M tokens (default: 1.2)

Sync options:
  --url URL              pricing page to scrape (default: DeepSeek docs)
  --cache PATH           cache file (default: XDG cache dir schedule.json)
  --check                exit 1 when the docs differ from built-in defaults
                         (for cron/CI alerting), 0 when unchanged

General options:
  --json                 machine-readable output (status, is-peak, next)
  -h, --help             this help

Environment:
  DEEPSEEK_PEAK_SCHEDULE JSON array of windows, e.g.
                         '[{"days":[1,2,3,4,5],"start":"01:00","end":"04:00"}]'
  DEEPSEEK_PEAK_CACHE    schedule cache file (default: XDG cache dir)
  DEEPSEEK_PEAK_URL      pricing page URL override (for sync)
  DEEPSEEK_PEAK_LEDGER   event ledger file, or 0 to disable

Examples:
  deepseek-peak status
  deepseek-peak day
  deepseek-peak report --estimate
  deepseek-peak sync --check || echo "peak hours changed upstream!"
  deepseek-peak is-peak || echo "cheap now, run the batch job"
  deepseek-peak wait --timeout 7200 --exec "opencode run 'nightly refactor'"`);
}

export function parseArgs(argv) {
  const args = [...argv];
  const opts = {
    json: false,
    unix: false,
    quiet: false,
    for: "offpeak",
    timeout: 0,
    poll: 5,
    exec: null,
    notify: null,
    url: null,
    cache: null,
    check: false,
    date: null,
    since: null,
    ledger: null,
    frames: null,
    estimate: false,
    avgIn: 4000,
    avgOut: 1000,
    inputPrice: 0.3,
    outputPrice: 1.2,
  };
  let command = "status";
  const positionals = [];
  while (args.length > 0) {
    const a = args.shift();
    if (a === "--json") opts.json = true;
    else if (a === "--unix") opts.unix = true;
    else if (a === "--quiet" || a === "-q") opts.quiet = true;
    else if (a === "--for") opts.for = args.shift() ?? "offpeak";
    else if (a.startsWith("--for=")) opts.for = a.slice("--for=".length);
    else if (a === "--timeout") opts.timeout = Number(args.shift() ?? 0);
    else if (a.startsWith("--timeout=")) opts.timeout = Number(a.slice("--timeout=".length));
    else if (a === "--poll") opts.poll = Number(args.shift() ?? 5);
    else if (a.startsWith("--poll=")) opts.poll = Number(a.slice("--poll=".length));
    else if (a === "--exec") opts.exec = args.shift() ?? null;
    else if (a.startsWith("--exec=")) opts.exec = a.slice("--exec=".length);
    else if (a === "--notify") opts.notify = args.shift() ?? null;
    else if (a.startsWith("--notify=")) opts.notify = a.slice("--notify=".length);
    else if (a === "--url") opts.url = args.shift() ?? null;
    else if (a.startsWith("--url=")) opts.url = a.slice("--url=".length);
    else if (a === "--cache") opts.cache = args.shift() ?? null;
    else if (a.startsWith("--cache=")) opts.cache = a.slice("--cache=".length);
    else if (a === "--check") opts.check = true;
    else if (a === "--date") opts.date = args.shift() ?? null;
    else if (a.startsWith("--date=")) opts.date = a.slice("--date=".length);
    else if (a === "--since") opts.since = args.shift() ?? null;
    else if (a.startsWith("--since=")) opts.since = a.slice("--since=".length);
    else if (a === "--ledger") opts.ledger = args.shift() ?? null;
    else if (a.startsWith("--ledger=")) opts.ledger = a.slice("--ledger=".length);
    else if (a === "--frames") opts.frames = Number(args.shift() ?? 1);
    else if (a.startsWith("--frames=")) opts.frames = Number(a.slice("--frames=".length));
    else if (a === "--estimate") opts.estimate = true;
    else if (a === "--avg-in") opts.avgIn = Number(args.shift() ?? 4000);
    else if (a.startsWith("--avg-in=")) opts.avgIn = Number(a.slice("--avg-in=".length));
    else if (a === "--avg-out") opts.avgOut = Number(args.shift() ?? 1000);
    else if (a.startsWith("--avg-out=")) opts.avgOut = Number(a.slice("--avg-out=".length));
    else if (a === "--input-price") opts.inputPrice = Number(args.shift() ?? 0.3);
    else if (a.startsWith("--input-price=")) opts.inputPrice = Number(a.slice("--input-price=".length));
    else if (a === "--output-price") opts.outputPrice = Number(args.shift() ?? 1.2);
    else if (a.startsWith("--output-price=")) opts.outputPrice = Number(a.slice("--output-price=".length));
    else if (a === "-h" || a === "--help") return { command: "help", opts };
    else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
    else positionals.push(a);
  }
  if (positionals.length > 0) command = positionals[0];
  if (!["status", "is-peak", "next", "wait", "watch", "day", "report", "sync", "help"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  if (!["peak", "offpeak"].includes(opts.for)) throw new Error(`--for must be "peak" or "offpeak"`);
  return { command, opts };
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`deepseek-peak: ${err.message}`);
    printHelp();
    return 2;
  }
  try {
    switch (parsed.command) {
      case "help":
        printHelp();
        return 0;
      case "status":
        return cmdStatus(parsed.opts);
      case "is-peak":
        return cmdIsPeak(parsed.opts);
      case "next":
        return cmdNext(parsed.opts);
      case "wait":
        return await cmdWait(parsed.opts);
      case "day":
        return cmdDay(parsed.opts);
      case "report":
        return await cmdReport(parsed.opts);
      case "sync":
        return await cmdSync(parsed.opts);
      case "watch":
        return await cmdWatch(parsed.opts);
    }
  } catch (err) {
    console.error(`deepseek-peak: ${err.message}`);
    return 2;
  }
  // Unreachable: parseArgs only returns validated commands, all handled above.
}
