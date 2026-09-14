// Core of the DeepSeek API peak-hours schedule.
//
// Source: https://api-docs.deepseek.com/quick_start/pricing
//   Peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday.
//   Everything else is off-peak, billed at half the peak rates.
// The schedule lives in a constant / ENV var so it can be updated
// if DeepSeek changes the hours (see loadSchedule).
//
// All calculations are strictly in UTC and independent of the local timezone.

const MINUTES_IN_DAY = 24 * 60;

/**
 * Default peak windows. Times are UTC, days are getUTCDay() (0=Sun..6=Sat).
 * Intervals are half-open: [start, end). end <= start means an overnight window.
 */
export const DEFAULT_WINDOWS = [
  { days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" },
  { days: [1, 2, 3, 4, 5], start: "06:00", end: "10:00" },
];

export const SCHEDULE_SOURCE_URL = "https://api-docs.deepseek.com/quick_start/pricing";

function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) throw new Error(`Bad clock value: ${JSON.stringify(value)}, expected "HH:MM"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Bad clock value: ${JSON.stringify(value)}`);
  return h * 60 + min;
}

function normalizeWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error("Schedule must be a non-empty array of windows");
  }
  return windows.map((w, i) => {
    if (!w || !Array.isArray(w.days) || w.days.length === 0) {
      throw new Error(`Schedule window #${i}: "days" must be a non-empty array (0=Sun..6=Sat)`);
    }
    const days = [...new Set(w.days.map(Number))].sort();
    for (const d of days) {
      if (!Number.isInteger(d) || d < 0 || d > 6) throw new Error(`Schedule window #${i}: bad day ${d}`);
    }
    return { days, startMin: parseClock(w.start), endMin: parseClock(w.end) };
  });
}

/**
 * Load the schedule: the DEEPSEEK_PEAK_SCHEDULE env var (a JSON array of windows)
 * overrides the default.
 * Window format: {"days":[1,2,3,4,5],"start":"01:00","end":"04:00"}.
 */
export function loadSchedule(env = process.env) {
  const raw = env?.DEEPSEEK_PEAK_SCHEDULE;
  if (raw == null || String(raw).trim() === "") return normalizeWindows(DEFAULT_WINDOWS);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`DEEPSEEK_PEAK_SCHEDULE is not valid JSON: ${err.message}`);
  }
  return normalizeWindows(parsed);
}

/** Minutes since UTC midnight. */
export function minutesOfDayUTC(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60000;
}

function windowMatches(w, day, min) {
  if (w.startMin < w.endMin) return w.days.includes(day) && min >= w.startMin && min < w.endMin;
  // Overnight window: evening of a listed day plus the small hours of the next day.
  if (w.days.includes(day) && min >= w.startMin) return true;
  const prevDay = (day + 6) % 7;
  return w.days.includes(prevDay) && min < w.endMin;
}

/** Is the given moment inside peak hours? */
export function isPeak(date = new Date(), windows = loadSchedule()) {
  const norm = isNormalized(windows) ? windows : normalizeWindows(windows);
  return norm.some((w) => windowMatches(w, date.getUTCDay(), minutesOfDayUTC(date)));
}

/** The peak window containing the moment (or null). */
export function windowAt(date = new Date(), windows = loadSchedule()) {
  const norm = isNormalized(windows) ? windows : normalizeWindows(windows);
  const day = date.getUTCDay();
  const min = minutesOfDayUTC(date);
  return norm.find((w) => windowMatches(w, day, min)) ?? null;
}

function midnightUTC(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isNormalized(windows) {
  return Array.isArray(windows) && windows[0]?.startMin !== undefined;
}

/**
 * The nearest schedule transition strictly after `date`.
 * @returns {{ at: Date, to: "peak" | "offpeak", inMs: number }}
 */
export function nextTransition(date = new Date(), windows = loadSchedule()) {
  const norm = isNormalized(windows) ? windows : normalizeWindows(windows);
  const nowMs = date.getTime();
  const base = midnightUTC(date);
  const candidates = [];
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const dayStart = base + dayOffset * 86400000;
    const dow = new Date(dayStart).getUTCDay();
    for (const w of norm) {
      if (!w.days.includes(dow)) continue;
      const startMs = dayStart + w.startMin * 60000;
      // For an overnight window the end belongs to the following day.
      const endMs = dayStart + (w.endMin > w.startMin ? w.endMin : w.endMin + MINUTES_IN_DAY) * 60000;
      if (startMs > nowMs) candidates.push(startMs);
      if (endMs > nowMs) candidates.push(endMs);
    }
    // Tail of an overnight window that started yesterday: its end lands
    // today even though today is not a listed window day.
    for (const w of norm) {
      if (w.endMin > w.startMin) continue;
      if (!w.days.includes((dow + 6) % 7)) continue;
      const tailEndMs = dayStart + w.endMin * 60000;
      if (tailEndMs > nowMs) candidates.push(tailEndMs);
    }
  }
  if (candidates.length === 0) throw new Error("No upcoming transition found (empty schedule?)");
  const atMs = Math.min(...candidates);
  const at = new Date(atMs);
  // State right after the boundary (+1s so we never land exactly on it).
  const to = isPeak(new Date(atMs + 1000), norm) ? "peak" : "offpeak";
  return { at, to, inMs: atMs - nowMs };
}

/**
 * Full status for a moment in time.
 * @returns {{ now: Date, peak: boolean, window: object|null, transition: {at,to,inMs}, windows }}
 */
export function status(date = new Date(), windows = loadSchedule()) {
  const norm = isNormalized(windows) ? windows : normalizeWindows(windows);
  return {
    now: new Date(date.getTime()),
    peak: isPeak(date, norm),
    window: windowAt(date, norm),
    transition: nextTransition(date, norm),
    windows: norm,
  };
}

/** ms -> "2d 04:05:06" / "04:05:06" / "00:00:07". */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  const d = Math.floor(total / 86400);
  const pad = (n) => String(n).padStart(2, "0");
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d}d ${clock}` : clock;
}

/** "2026-09-14 09:06:38 UTC". */
export function formatTimeUTC(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`
  );
}

function localOffsetLabel(date) {
  const offMin = -date.getTimezoneOffset(); // positive = east of UTC
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const pad = (n) => String(n).padStart(2, "0");
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "2026-09-14 14:06:38 (UTC+05:00)". */
export function formatTimeLocal(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} (${localOffsetLabel(date)})`
  );
}

/** "HH:MM UTC" for short deadline references. */
export function formatClockUTC(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** Human-readable window list, e.g. "Mon–Fri 01:00–04:00; Mon–Fri 06:00–10:00 UTC". */
export function describeWindows(windows = loadSchedule()) {
  const norm = isNormalized(windows) ? windows : normalizeWindows(windows);
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const fmtClock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const fmtDays = (days) => {
    if (days.length === 7) return "daily";
    if (days.length === 5 && days.every((d, i) => d === i + 1)) return "Mon–Fri";
    if (days.length === 2 && days[0] === 0 && days[1] === 6) return "weekends";
    return days.map((d) => dayNames[d]).join(",");
  };
  return (
    norm
      .map((w) => {
        const overnight = w.endMin <= w.startMin ? " (+1 day)" : "";
        return `${fmtDays(w.days)} ${fmtClock(w.startMin)}–${fmtClock(w.endMin)}${overnight}`;
      })
      .join("; ") + " UTC"
  );
}

/**
 * Split a UTC calendar day into equal slots for timeline rendering.
 * Each slot is classified by its midpoint, so exact boundaries never matter.
 * @returns {Array<{ start: Date, peak: boolean }>} (default: 48 half-hour slots)
 */
export function dayCells(day, windows = loadSchedule(), slotsPerHour = 2) {
  const norm = isNormalized(windows) ? windows : normalizeWindows(windows);
  if (!Number.isInteger(slotsPerHour) || slotsPerHour < 1 || slotsPerHour > 12) {
    throw new Error("slotsPerHour must be an integer between 1 and 12");
  }
  const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const slotMs = 3600000 / slotsPerHour;
  const cells = [];
  for (let i = 0; i < 24 * slotsPerHour; i++) {
    cells.push({
      start: new Date(start + i * slotMs),
      peak: isPeak(new Date(start + (i + 0.5) * slotMs), norm),
    });
  }
  return cells;
}
