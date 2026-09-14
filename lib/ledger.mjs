// JSONL ledger of deepseek-peak decisions.
//
// The opencode plugin appends one line per notable event
// (blocked request, warn-mode pass, aborted session, schedule transition).
// The CLI `report` command aggregates the file. Used by both, so it lives here.
//
// Default location honours XDG: $XDG_DATA_HOME/deepseek-peak/events.jsonl,
// otherwise ~/.local/share/deepseek-peak/events.jsonl.
// Override with the DEEPSEEK_PEAK_LEDGER env var (path, or 0 to disable).

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function defaultLedgerPath(env = process.env) {
  const xdg = env?.XDG_DATA_HOME;
  if (xdg != null && String(xdg).trim() !== "") return join(String(xdg).trim(), "deepseek-peak", "events.jsonl");
  return join(homedir(), ".local", "share", "deepseek-peak", "events.jsonl");
}

/**
 * Resolve the ledger path from a setting (true | false | path | undefined).
 * The DEEPSEEK_PEAK_LEDGER env var wins: "0"/"false"/"no"/"off" disables,
 * "1"/"true"/"yes"/"on" (or empty... no — empty means unset) forces default,
 * anything else is treated as a path.
 * @returns {string | null} path, or null when disabled.
 */
export function resolveLedgerPath(setting, env = process.env) {
  const fromEnv = env?.DEEPSEEK_PEAK_LEDGER;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    const s = String(fromEnv).trim().toLowerCase();
    if (["0", "false", "no", "off", "disabled"].includes(s)) return null;
    if (["1", "true", "yes", "on"].includes(s)) return defaultLedgerPath(env);
    return String(fromEnv).trim();
  }
  if (setting === false) return null;
  if (typeof setting === "string" && setting.trim() !== "") return setting.trim();
  return defaultLedgerPath(env); // true or undefined → enabled at the default path
}

/** Append one event. Never throws — returns false on any failure. */
export async function appendEvent(ledgerPath, event) {
  if (!ledgerPath) return false;
  try {
    await mkdir(dirname(ledgerPath), { recursive: true });
    await appendFile(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Read events, oldest first. Corrupt lines are skipped. Missing file → []. */
export async function readEvents(ledgerPath, { since } = {}) {
  let text;
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const sinceMs = since ? Date.parse(`${since}T00:00:00Z`) : NaN;
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (!e || typeof e !== "object" || typeof e.type !== "string") continue;
      // With --since, only dated events on/after the cutoff qualify.
      if (!Number.isNaN(sinceMs) && (Number.isNaN(Date.parse(e.ts)) || Date.parse(e.ts) < sinceMs)) continue;
      events.push(e);
    } catch {
      // skip corrupt lines
    }
  }
  return events;
}

export function summarize(events) {
  const summary = {
    total: events.length,
    blocked: 0,
    warned: 0,
    aborted: 0,
    peakStarts: 0,
    offpeakStarts: 0,
    byDay: {},
    firstTs: null,
    lastTs: null,
  };
  for (const e of events) {
    if (typeof e.ts === "string") {
      if (!summary.firstTs || e.ts < summary.firstTs) summary.firstTs = e.ts;
      if (!summary.lastTs || e.ts > summary.lastTs) summary.lastTs = e.ts;
    }
    if (e.type === "blocked") summary.blocked++;
    else if (e.type === "allowed-warn") summary.warned++;
    else if (e.type === "aborted") summary.aborted++;
    else if (e.type === "peak-start") summary.peakStarts++;
    else if (e.type === "offpeak-start") summary.offpeakStarts++;
    const day = typeof e.ts === "string" ? e.ts.slice(0, 10) : "unknown";
    const d = (summary.byDay[day] ??= { blocked: 0, warned: 0, aborted: 0 });
    if (e.type === "blocked") d.blocked++;
    else if (e.type === "allowed-warn") d.warned++;
    else if (e.type === "aborted") d.aborted++;
  }
  return summary;
}

/**
 * Rough savings estimate: what `blockedCount` requests would have cost EXTRA
 * had they run at peak rates instead of off-peak (half price).
 * Prices are per 1M tokens (peak rates); pass your own via options.
 */
export function estimateSavings(
  blockedCount,
  { avgIn = 4000, avgOut = 1000, inputPrice = 0.3, outputPrice = 1.2 } = {},
) {
  const perRequestUsd = (avgIn / 1e6) * (inputPrice / 2) + (avgOut / 1e6) * (outputPrice / 2);
  return {
    perRequestUsd,
    totalUsd: perRequestUsd * blockedCount,
    assumptions: { avgIn, avgOut, inputPrice, outputPrice },
  };
}
