// Sync the peak-hours schedule from DeepSeek's pricing docs.
//
// There is no official machine-readable feed for the peak windows, so this
// scrapes the pricing page and extracts them with strict, fail-loud parsing:
// anything ambiguous (unknown timezone, unknown day scope, implausible
// times, removed peak hours) aborts with a clear error instead of guessing.
// `deepseek-peak sync` validates before writing the cache; the guard
// auto-uses a valid cache (the DEEPSEEK_PEAK_SCHEDULE env override wins).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeWindows, DEFAULT_WINDOWS, SCHEDULE_CACHE_VERSION } from "./schedule.mjs";

export const PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing";
export const STALE_AFTER_DAYS = 30;

export async function fetchPricingPage(url, { timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": "deepseek-peak/sync", accept: "text/html,*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`pricing page responded HTTP ${res.status}`);
  return await res.text();
}

export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TIME_PAIR = /(\d{1,2}):(\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}):(\d{2})/g;

/** The sentence enclosing offset `at` (sentence ends are ". "/! /? ). */
function sentenceAround(text, at) {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const startCut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "));
  const endCuts = [after.indexOf(". "), after.indexOf("! "), after.indexOf("? ")].filter((i) => i >= 0);
  const endCut = endCuts.length === 0 ? -1 : Math.min(...endCuts);
  const start = startCut < 0 ? 0 : startCut + 2;
  const end = endCut < 0 ? text.length : at + endCut + 1;
  return text.slice(start, end).trim();
}

function extractDays(sentence) {
  const s = sentence.toLowerCase();
  if (/monday\s+(through|thru|to)\s+friday|mon\s*[-–—]\s*fri/.test(s)) return [1, 2, 3, 4, 5];
  if (/monday\s+(through|thru|to)\s+sunday/.test(s)) return [0, 1, 2, 3, 4, 5, 6];
  if (/\bweekdays?\b/.test(s)) return [1, 2, 3, 4, 5];
  if (/\bweekends?\b/.test(s)) return [0, 6];
  if (/\bdaily\b|\bevery\s+day\b/.test(s)) return [0, 1, 2, 3, 4, 5, 6];
  throw new Error("could not determine which days peak hours apply to — refusing to guess");
}

/**
 * Extract peak windows from pricing-page text (HTML accepted).
 * Every sentence mentioning peak hours is tried in order; the first one
 * carrying time ranges wins (footnotes like "(3) Off-peak rates are half
 * of the peak rates." mention them without times and are skipped).
 * @returns {{ windows: Array<{days, start, end}>, excerpt: string }}
 * @throws on anything ambiguous — never guesses.
 */
export function extractSchedule(pageText) {
  const text = htmlToText(pageText);
  const lowered = text.toLowerCase();
  let from = 0;
  let at = lowered.indexOf("peak hour", from);
  let lastError;
  while (at >= 0) {
    const sentence = sentenceAround(text, at);
    try {
      return parsePeakSentence(sentence);
    } catch (err) {
      lastError = err;
    }
    from = at + 1;
    at = lowered.indexOf("peak hour", from);
  }
  throw lastError ?? new Error('no "peak hours" statement found on the pricing page');
}

/** Parse one candidate sentence. Throws when anything is ambiguous. */
function parsePeakSentence(sentence) {
  if (/(no longer|removed|discontinued|cancelled|no peak hours)/i.test(sentence)) {
    throw new Error("pricing page suggests peak hours were removed — refusing to guess, update manually");
  }
  if (/UTC\s*[+-]\s*\d/i.test(sentence)) {
    throw new Error("peak hours use a non-UTC offset — refusing to guess");
  }
  if (!/\bUTC\b/i.test(sentence)) {
    throw new Error("peak hours have no UTC timezone marker — refusing to guess");
  }
  const pairs = [...sentence.matchAll(TIME_PAIR)].map((m) => ({
    start: `${m[1].padStart(2, "0")}:${m[2]}`,
    end: `${m[3].padStart(2, "0")}:${m[4]}`,
  }));
  if (pairs.length === 0) throw new Error("no HH:MM time ranges found in the peak-hours statement");
  for (const p of pairs) {
    const sh = Number(p.start.slice(0, 2));
    const sm = Number(p.start.slice(3));
    const eh = Number(p.end.slice(0, 2));
    const em = Number(p.end.slice(3));
    if (sh > 23 || sm > 59 || eh > 23 || em > 59) {
      throw new Error(`implausible time in peak-hours statement: ${p.start}-${p.end}`);
    }
    if (p.start === p.end) throw new Error(`zero-length window in peak-hours statement: ${p.start}`);
  }
  const days = extractDays(sentence);
  return { windows: pairs.map((p) => ({ days, start: p.start, end: p.end })), excerpt: sentence };
}

/** Order-insensitive equality on normalized windows. */
export function schedulesEqual(a, b) {
  const key = (w) => JSON.stringify({ days: [...w.days].sort((x, y) => x - y), startMin: w.startMin, endMin: w.endMin });
  const ka = a.map(key).sort();
  const kb = b.map(key).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

export async function writeCacheFile(cachePath, { windows, meta }) {
  await mkdir(dirname(cachePath), { recursive: true });
  const data = {
    version: SCHEDULE_CACHE_VERSION,
    sourceUrl: meta.sourceUrl,
    fetchedAt: meta.fetchedAt,
    excerpt: meta.excerpt,
    schedule: windows,
  };
  await writeFile(cachePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * Fetch → strict-parse → validate → write cache. Throws on any failure
 * (the previous cache file is left untouched).
 * @returns {{ windows (normalized), meta, cachePath, changed }}
 * `changed` compares against the built-in defaults.
 */
export async function syncSchedule({ url, cachePath, fetchPage = fetchPricingPage, now = new Date() }) {
  const page = await fetchPage(url);
  const { windows: raw, excerpt } = extractSchedule(page);
  const windows = normalizeWindows(raw);
  const changed = !schedulesEqual(windows, normalizeWindows(DEFAULT_WINDOWS));
  const meta = { fetchedAt: now.toISOString(), sourceUrl: url, excerpt };
  await writeCacheFile(cachePath, { windows: raw, meta });
  return { windows, meta, cachePath, changed };
}
