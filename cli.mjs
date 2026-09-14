#!/usr/bin/env node
// deepseek-peak CLI — inspect DeepSeek API peak/off-peak pricing hours.
//
//   deepseek-peak status              one-shot status (default command)
//   deepseek-peak is-peak             exit 1 during peak, 0 off-peak (scripting)
//   deepseek-peak next [--unix]       print the next schedule transition
//   deepseek-peak wait [options]      block until peak/off-peak starts
//   deepseek-peak watch               live countdown (Ctrl+C to exit)
//
// Override the schedule with DEEPSEEK_PEAK_SCHEDULE (JSON, see lib/schedule.mjs).

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
} from "./lib/schedule.mjs";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 2_147_483_647))));
}

/** Find the next transition that *starts* peak, looking a few steps ahead. */
function nextPeakStart(now, windows) {
  let cursor = new Date(now.getTime());
  for (let i = 0; i < 6; i++) {
    const t = nextTransition(new Date(cursor.getTime() + 1000), windows);
    if (t.to === "peak") return t;
    cursor = t.at;
  }
  throw new Error("Could not find the next peak start (schedule has no peak?)");
}

function statusPayload(s) {
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

function printStatus(s) {
  console.log(`DeepSeek pricing windows: peak ${describeWindows(s.windows)}; everything else is off-peak (half price)`);
  console.log(`Now:    ${formatTimeUTC(s.now)}  (${formatTimeLocal(s.now)})`);
  if (s.peak) {
    console.log(`Status: ${bold(red("PEAK"))} — standard (2x) rates`);
    console.log(`Peak ends at ${formatClockUTC(s.transition.at)}, in ${bold(formatDuration(s.transition.inMs))}`);
  } else {
    console.log(`Status: ${bold(green("OFF-PEAK"))} — discounted (0.5x) rates`);
    if (s.transition.to === "peak") {
      console.log(`Peak starts at ${formatClockUTC(s.transition.at)}, in ${bold(formatDuration(s.transition.inMs))}`);
    } else {
      console.log(`Off-peak until ${formatClockUTC(s.transition.at)} (${formatDuration(s.transition.inMs)} left)`);
    }
  }
  const np = nextPeakStart(s.now, s.windows);
  console.log(`Next peak: ${formatTimeUTC(np.at)} (in ${formatDuration(np.inMs)})`);
}

function cmdStatus(opts) {
  const s = status(new Date(), loadSchedule());
  if (opts.json) console.log(JSON.stringify(statusPayload(s), null, 2));
  else printStatus(s);
  return 0;
}

function cmdIsPeak(opts) {
  const s = status(new Date(), loadSchedule());
  if (opts.json) {
    const p = statusPayload(s);
    console.log(JSON.stringify({ peak: p.peak, transition: p.transition }));
  } else if (!opts.quiet) console.log(s.peak ? "peak" : "off-peak");
  return s.peak ? 1 : 0;
}

function cmdNext(opts) {
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

async function cmdWait(opts) {
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

function renderWatch(s) {
  const lines = [];
  lines.push(bold("DeepSeek peak-hours monitor") + dim(`  (peak: ${describeWindows(s.windows)})`));
  lines.push(`Now (UTC):   ${formatTimeUTC(s.now)}`);
  lines.push(`Now (local): ${formatTimeLocal(s.now)}`);
  lines.push(
    s.peak
      ? `Status: ${bold(red("PEAK"))} — standard (2x) rates`
      : `Status: ${bold(green("OFF-PEAK"))} — discounted (0.5x) rates`,
  );
  lines.push(
    `${s.transition.to === "peak" ? "Peak starts" : "Peak ends"} in ${bold(formatDuration(s.transition.inMs))} ` +
      `(at ${formatTimeUTC(s.transition.at)})`,
  );
  const np = nextPeakStart(s.now, s.windows);
  lines.push(`Next peak: ${formatTimeUTC(np.at)} (in ${formatDuration(np.inMs)})`);
  lines.push(dim("Ctrl+C to exit"));
  return lines.join("\n");
}

async function cmdWatch() {
  if (!process.stdout.isTTY) {
    console.error("deepseek-peak: watch needs a TTY; use `status` for one-shot output.");
    return 2;
  }
  for (;;) {
    process.stdout.write("\x1bc");
    process.stdout.write(renderWatch(status(new Date(), loadSchedule())) + "\n");
    await sleep(1000);
  }
}

function printHelp() {
  console.log(`deepseek-peak — track DeepSeek API peak/off-peak pricing hours.

Usage: deepseek-peak [command] [options]

Commands:
  status                 one-shot status with countdowns (default)
  is-peak [--json]       exit 1 during peak, 0 off-peak (for scripts/CI)
  next [--unix] [--json] print the next schedule transition
  wait [options]         block until peak/off-peak hours start
  watch                  live countdown, refreshed every second

Wait options:
  --for peak|offpeak     what to wait for (default: offpeak)
  --timeout SEC          give up after SEC seconds (exit 2)
  --poll SEC             re-check every SEC seconds (default: 5)
  --exec "CMD"           run CMD via shell once the condition is met
  --quiet, -q            print nothing, only set the exit code

General options:
  --json                 machine-readable output (status, is-peak, next)
  -h, --help             this help

Environment:
  DEEPSEEK_PEAK_SCHEDULE JSON array of windows, e.g.
                         '[{"days":[1,2,3,4,5],"start":"01:00","end":"04:00"}]'

Examples:
  deepseek-peak status
  deepseek-peak is-peak || echo "cheap now, run the batch job"
  deepseek-peak wait --timeout 7200 --exec "opencode run 'nightly refactor'"`);
}

function parseArgs(argv) {
  const args = [...argv];
  const opts = { json: false, unix: false, quiet: false, for: "offpeak", timeout: 0, poll: 5, exec: null };
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
    else if (a === "-h" || a === "--help") return { command: "help", opts };
    else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
    else positionals.push(a);
  }
  if (positionals.length > 0) command = positionals[0];
  if (!["status", "is-peak", "next", "wait", "watch", "help"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  if (!["peak", "offpeak"].includes(opts.for)) throw new Error(`--for must be "peak" or "offpeak"`);
  return { command, opts };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`deepseek-peak: ${err.message}`);
    printHelp();
    process.exitCode = 2;
    return;
  }
  try {
    switch (parsed.command) {
      case "help":
        printHelp();
        return;
      case "status":
        process.exitCode = cmdStatus(parsed.opts);
        return;
      case "is-peak":
        process.exitCode = cmdIsPeak(parsed.opts);
        return;
      case "next":
        process.exitCode = cmdNext(parsed.opts);
        return;
      case "wait":
        process.exitCode = await cmdWait(parsed.opts);
        return;
      case "watch":
        process.exitCode = await cmdWatch();
        return;
    }
  } catch (err) {
    console.error(`deepseek-peak: ${err.message}`);
    process.exitCode = 2;
  }
}

await main();
