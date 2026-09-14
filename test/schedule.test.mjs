import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import {
  DEFAULT_WINDOWS,
  loadSchedule,
  loadScheduleWithMeta,
  normalizeWindows,
  defaultCachePath,
  resolveCachePath,
  readCacheFile,
  cacheAgeDays,
  isPeak,
  windowAt,
  nextTransition,
  status,
  formatDuration,
  describeWindows,
  formatTimeLocal,
  dayCells,
} from "../lib/schedule.mjs";

const W = loadSchedule({}); // defaults, no ENV
const D = (iso) => new Date(iso);

// 2026-09-14 is a Monday, 2026-09-18 a Friday, 2026-09-19/20 Sat/Sun, 2026-09-21 a Monday.

describe("isPeak: window boundaries (Mon)", () => {
  const cases = [
    ["2026-09-14T00:59:59Z", false],
    ["2026-09-14T01:00:00Z", true],
    ["2026-09-14T02:30:00Z", true],
    ["2026-09-14T03:59:59Z", true],
    ["2026-09-14T04:00:00Z", false],
    ["2026-09-14T05:59:59Z", false],
    ["2026-09-14T06:00:00Z", true],
    ["2026-09-14T09:06:38Z", true],
    ["2026-09-14T09:59:59Z", true],
    ["2026-09-14T10:00:00Z", false],
    ["2026-09-14T23:59:59Z", false],
  ];
  for (const [iso, expected] of cases) {
    it(`${iso} -> ${expected ? "peak" : "off-peak"}`, () => {
      assert.equal(isPeak(D(iso), W), expected);
    });
  }
});

describe("isPeak: weekends are always off-peak", () => {
  for (const iso of ["2026-09-19T02:00:00Z", "2026-09-19T07:00:00Z", "2026-09-20T03:00:00Z", "2026-09-20T08:30:00Z"]) {
    it(`${iso} -> off-peak`, () => {
      assert.equal(isPeak(D(iso), W), false);
    });
  }
});

describe("isPeak: Friday evening and Tuesday night", () => {
  it("Fri 09:59 peak, Fri 10:00 off-peak", () => {
    assert.equal(isPeak(D("2026-09-18T09:59:00Z"), W), true);
    assert.equal(isPeak(D("2026-09-18T10:00:00Z"), W), false);
  });
  it("Tue 03:00 peak", () => {
    assert.equal(isPeak(D("2026-09-15T03:00:00Z"), W), true);
  });
});

describe("nextTransition", () => {
  const cases = [
    // [now, expected transition ISO, direction]
    ["2026-09-14T00:30:00Z", "2026-09-14T01:00:00.000Z", "peak"],
    ["2026-09-14T01:00:00Z", "2026-09-14T04:00:00.000Z", "offpeak"],
    ["2026-09-14T09:06:38Z", "2026-09-14T10:00:00.000Z", "offpeak"],
    ["2026-09-14T10:00:00Z", "2026-09-15T01:00:00.000Z", "peak"],
    ["2026-09-18T10:00:00Z", "2026-09-21T01:00:00.000Z", "peak"], // Fri -> Mon (63h)
    ["2026-09-20T12:00:00Z", "2026-09-21T01:00:00.000Z", "peak"], // Sun -> Mon
    ["2026-09-19T00:00:00Z", "2026-09-21T01:00:00.000Z", "peak"], // Sat -> Mon
  ];
  for (const [now, expectedAt, expectedTo] of cases) {
    it(`${now} -> ${expectedTo} at ${expectedAt}`, () => {
      const t = nextTransition(D(now), W);
      assert.equal(t.at.toISOString(), expectedAt);
      assert.equal(t.to, expectedTo);
      assert.ok(t.inMs > 0);
      assert.equal(t.inMs, t.at.getTime() - D(now).getTime());
    });
  }
});

describe("status", () => {
  it("Mon 09:06:38Z is peak, transitions to off-peak at 10:00", () => {
    const s = status(D("2026-09-14T09:06:38Z"), W);
    assert.equal(s.peak, true);
    assert.equal(s.transition.to, "offpeak");
    assert.equal(s.transition.at.toISOString(), "2026-09-14T10:00:00.000Z");
  });
});

describe("formatDuration", () => {
  it("53m22s", () => assert.equal(formatDuration((53 * 60 + 22) * 1000), "00:53:22"));
  it("63 hours -> days", () => assert.equal(formatDuration(63 * 3600 * 1000), "2d 15:00:00"));
  it("zero and negatives", () => {
    assert.equal(formatDuration(0), "00:00:00");
    assert.equal(formatDuration(-5000), "00:00:00");
  });
});

describe("loadSchedule", () => {
  it("defaults without ENV", () => {
    assert.deepEqual(loadSchedule({}), loadSchedule({ DEEPSEEK_PEAK_SCHEDULE: "" }));
    assert.equal(DEFAULT_WINDOWS.length, 2);
  });
  it("custom schedule via ENV", () => {
    const w = loadSchedule({
      DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([{ days: [0, 6], start: "12:00", end: "13:00" }]),
    });
    assert.equal(isPeak(D("2026-09-19T12:30:00Z"), w), true); // Sat
    assert.equal(isPeak(D("2026-09-14T12:30:00Z"), w), false); // Mon
    assert.equal(isPeak(D("2026-09-14T02:00:00Z"), w), false); // default peak overridden
  });
  it("broken JSON -> clear error", () => {
    assert.throws(() => loadSchedule({ DEEPSEEK_PEAK_SCHEDULE: "{oops" }), /not valid JSON/);
  });
  it("overnight window", () => {
    const w = loadSchedule({
      DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([{ days: [1], start: "22:00", end: "02:00" }]),
    });
    assert.equal(isPeak(D("2026-09-14T23:00:00Z"), w), true);
    assert.equal(isPeak(D("2026-09-14T21:59:00Z"), w), false);
    // the window tail belongs to the next day
    assert.equal(isPeak(D("2026-09-15T01:00:00Z"), w), true);
    assert.equal(isPeak(D("2026-09-15T02:00:00Z"), w), false);
    assert.equal(isPeak(D("2026-09-16T01:00:00Z"), w), false); // Wed: prev day not a window day
  });

  it("overnight transitions include the tail end", () => {
    const w = loadSchedule({
      DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([{ days: [1], start: "22:00", end: "02:00" }]),
    });
    // Mon 2026-09-14, Tue 2026-09-15, next Mon 2026-09-21.
    let t = nextTransition(D("2026-09-14T21:00:00Z"), w);
    assert.equal(t.at.toISOString(), "2026-09-14T22:00:00.000Z");
    assert.equal(t.to, "peak");
    t = nextTransition(D("2026-09-14T23:00:00Z"), w);
    assert.equal(t.at.toISOString(), "2026-09-15T02:00:00.000Z");
    assert.equal(t.to, "offpeak");
    t = nextTransition(D("2026-09-15T01:00:00Z"), w); // inside the tail
    assert.equal(t.at.toISOString(), "2026-09-15T02:00:00.000Z");
    assert.equal(t.to, "offpeak");
    t = nextTransition(D("2026-09-15T03:00:00Z"), w);
    assert.equal(t.at.toISOString(), "2026-09-21T22:00:00.000Z");
    assert.equal(t.to, "peak");
  });
});

describe("dayCells", () => {
  it("Monday: 48 half-hour slots, peak at 01-04 and 06-10", () => {
    const cells = dayCells(D("2026-09-14T12:00:00Z"), W);
    assert.equal(cells.length, 48);
    assert.equal(cells[0].start.toISOString(), "2026-09-14T00:00:00.000Z");
    const peakIdx = cells.map((c, i) => (c.peak ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(peakIdx, [2, 3, 4, 5, 6, 7, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it("Saturday: all off-peak", () => {
    assert.ok(dayCells(D("2026-09-19T12:00:00Z"), W).every((c) => !c.peak));
  });

  it("hourly slots", () => {
    const cells = dayCells(D("2026-09-14T12:00:00Z"), W, 1);
    assert.equal(cells.length, 24);
    assert.deepEqual(
      cells.map((c) => c.peak),
      [0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].map(Boolean),
    );
  });

  it("rejects bad granularity", () => {
    assert.throws(() => dayCells(D("2026-09-14T00:00:00Z"), W, 0), /slotsPerHour/);
  });
});

describe("normalizeWindows validation", () => {
  it("rejects garbage schedules", () => {
    assert.throws(() => loadSchedule({ DEEPSEEK_PEAK_SCHEDULE: "[]" }), /non-empty array/);
    assert.throws(() => loadSchedule({ DEEPSEEK_PEAK_SCHEDULE: "{}" }), /non-empty array/);
    assert.throws(() => loadSchedule({ DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([{}]) }), /"days"/);
    assert.throws(() => loadSchedule({ DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([{ days: [] }]) }), /"days"/);
    assert.throws(() => loadSchedule({ DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([{ days: [7] }]) }), /bad day/);
    assert.throws(
      () => loadSchedule({ DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([{ days: [1], start: "x", end: "02:00" }]) }),
      /Bad clock/,
    );
    assert.throws(
      () => loadSchedule({ DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([{ days: [1], start: "25:00", end: "02:00" }]) }),
      /Bad clock/,
    );
  });
});

describe("raw (non-normalized) windows", () => {
  it("work everywhere normalized ones do", () => {
    const raw = DEFAULT_WINDOWS;
    assert.equal(isPeak(D("2026-09-14T02:00:00Z"), raw), true);
    assert.equal(isPeak(D("2026-09-14T12:00:00Z"), raw), false);
    assert.ok(windowAt(D("2026-09-14T02:00:00Z"), raw));
    assert.equal(windowAt(D("2026-09-14T12:00:00Z"), raw), null);
    assert.equal(status(D("2026-09-14T02:00:00Z"), raw).peak, true);
    assert.equal(nextTransition(D("2026-09-14T00:30:00Z"), raw).to, "peak");
    assert.match(describeWindows(raw), /Mon–Fri/);
    assert.equal(dayCells(D("2026-09-14T00:00:00Z"), raw).length, 48);
  });

  it("rejects empty and non-array input", () => {
    assert.throws(() => isPeak(D("2026-09-14T00:00:00Z"), []), /non-empty array/);
    assert.throws(() => isPeak(D("2026-09-14T00:00:00Z"), "nope"), /non-empty array/);
  });

  it("a schedule with no valid day has no transitions", () => {
    assert.throws(
      () => nextTransition(D("2026-09-14T00:00:00Z"), [{ days: [99], startMin: 0, endMin: 60 }]),
      /No upcoming transition/,
    );
  });
});

describe("describeWindows variants", () => {
  const w = (json) => loadSchedule({ DEEPSEEK_PEAK_SCHEDULE: JSON.stringify(json) });
  it("daily, weekends, single days and overnight marks", () => {
    assert.match(describeWindows(w([{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "01:00" }])), /daily/);
    assert.match(describeWindows(w([{ days: [0, 6], start: "12:00", end: "13:00" }])), /weekends/);
    assert.match(describeWindows(w([{ days: [3], start: "12:00", end: "13:00" }])), /Wed/);
    assert.match(describeWindows(w([{ days: [5], start: "22:00", end: "02:00" }])), /\(\+1 day\)/);
  });
});

describe("local time formatting", () => {
  it("covers both sides of UTC", () => {
    const d = new Date("2026-09-14T09:06:38Z");
    assert.match(formatTimeLocal(d), /UTC[+-]\d{2}:\d{2}/);
    const west = new Date("2026-09-14T09:06:38Z");
    west.getTimezoneOffset = () => 300; // UTC-05:00
    assert.match(formatTimeLocal(west), /\(UTC-05:00\)/);
    const east = new Date("2026-09-14T09:06:38Z");
    east.getTimezoneOffset = () => -330; // UTC+05:30
    assert.match(formatTimeLocal(east), /\(UTC\+05:30\)/);
  });
});

describe("schedule cache", () => {
  const cacheFile = join(tmpdir(), `deepseek-peak-cache-test-${process.pid}.json`);
  after(async () => {
    await unlink(cacheFile).catch(() => {});
  });

  it("default and resolve paths", () => {
    assert.ok(defaultCachePath({}).endsWith(join("deepseek-peak", "schedule.json")));
    assert.equal(defaultCachePath({ XDG_CACHE_HOME: "/tmp/xdg" }), "/tmp/xdg/deepseek-peak/schedule.json");
    assert.ok(defaultCachePath({ XDG_CACHE_HOME: "" }).endsWith(join("deepseek-peak", "schedule.json")));
    assert.equal(resolveCachePath({ DEEPSEEK_PEAK_CACHE: "/tmp/c.json" }), "/tmp/c.json");
    assert.ok(resolveCachePath({ DEEPSEEK_PEAK_CACHE: "" }).endsWith("schedule.json"));
    assert.ok(resolveCachePath({}).endsWith("schedule.json"));
  });

  it("readCacheFile states", async () => {
    assert.deepEqual(readCacheFile(join(tmpdir(), `deepseek-peak-nope-${process.pid}.json`)), { status: "missing" });
    assert.deepEqual(readCacheFile(tmpdir()).status, "invalid");
    assert.match(readCacheFile(tmpdir()).error, /unreadable/);
    await writeFile(cacheFile, "not json");
    assert.match(readCacheFile(cacheFile).error, /not valid JSON/);
    await writeFile(cacheFile, "5");
    assert.match(readCacheFile(cacheFile).error, /not an object/);
    await writeFile(cacheFile, JSON.stringify({ version: 999, schedule: [] }));
    assert.match(readCacheFile(cacheFile).error, /unsupported version/);
    await writeFile(cacheFile, JSON.stringify({ version: 1, schedule: [{ days: [9] }] }));
    assert.match(readCacheFile(cacheFile).error, /bad schedule/);
    const good = {
      version: 1,
      sourceUrl: "u",
      fetchedAt: "2026-09-14T00:00:00.000Z",
      excerpt: "e",
      schedule: [{ days: [1], start: "01:00", end: "02:00" }],
    };
    await writeFile(cacheFile, JSON.stringify(good));
    const back = readCacheFile(cacheFile);
    assert.equal(back.status, "ok");
    assert.equal(back.meta.sourceUrl, "u");
    assert.deepEqual(back.windows, normalizeWindows(good.schedule));
  });

  it("cacheAgeDays", () => {
    const now = new Date("2026-09-14T00:00:00.000Z");
    assert.equal(cacheAgeDays({ fetchedAt: "2026-09-13T00:00:00.000Z" }, now), 1);
    assert.equal(cacheAgeDays(undefined, now), Infinity);
    assert.equal(cacheAgeDays({}, now), Infinity);
    assert.equal(cacheAgeDays({ fetchedAt: "garbage" }, now), Infinity);
  });

  it("loadScheduleWithMeta precedence", async () => {
    const fromEnv = loadScheduleWithMeta({
      DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([{ days: [0], start: "00:00", end: "01:00" }]),
    });
    assert.equal(fromEnv.source, "env");
    const good = {
      version: 1,
      fetchedAt: new Date().toISOString(),
      schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "01:00" }],
    };
    await writeFile(cacheFile, JSON.stringify(good));
    const fromCache = loadScheduleWithMeta({ DEEPSEEK_PEAK_CACHE: cacheFile });
    assert.equal(fromCache.source, "cache");
    assert.ok(isPeak(new Date("2026-09-14T00:30:00Z"), fromCache.windows));
    await writeFile(cacheFile, "junk");
    const fallback = loadScheduleWithMeta({ DEEPSEEK_PEAK_CACHE: cacheFile });
    assert.equal(fallback.source, "builtin");
    assert.match(fallback.cacheIssue, /not valid JSON/);
    const plain = loadScheduleWithMeta({ DEEPSEEK_PEAK_CACHE: join(tmpdir(), `deepseek-peak-nope2-${process.pid}.json`) });
    assert.equal(plain.source, "builtin");
    assert.equal(plain.cacheIssue, undefined);
    assert.ok(Array.isArray(loadSchedule({})));
  });
});

describe("overlapping windows", () => {
  // Mon 2026-09-14, Tue 2026-09-15, next Mon 2026-09-21.
  const overlapping = () =>
    loadSchedule({
      DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([
        { days: [1], start: "01:00", end: "04:00" },
        { days: [1], start: "02:00", end: "03:00" },
      ]),
    });

  it("skips inner boundaries that change nothing", () => {
    const w = overlapping();
    let t = nextTransition(D("2026-09-14T00:30:00Z"), w);
    assert.equal(t.at.toISOString(), "2026-09-14T01:00:00.000Z");
    assert.equal(t.to, "peak");
    t = nextTransition(D("2026-09-14T02:30:00Z"), w); // inside both windows
    assert.equal(t.at.toISOString(), "2026-09-14T04:00:00.000Z"); // not 03:00!
    assert.equal(t.to, "offpeak");
    t = nextTransition(D("2026-09-14T03:30:00Z"), w); // inside the outer window only
    assert.equal(t.at.toISOString(), "2026-09-14T04:00:00.000Z");
    assert.equal(t.to, "offpeak");
    t = nextTransition(D("2026-09-14T04:30:00Z"), w);
    assert.equal(t.at.toISOString(), "2026-09-21T01:00:00.000Z");
    assert.equal(t.to, "peak");
  });

  it("adjacent windows merge into one peak stretch", () => {
    const w = loadSchedule({
      DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([
        { days: [1], start: "01:00", end: "02:00" },
        { days: [1], start: "02:00", end: "03:00" },
      ]),
    });
    const t = nextTransition(D("2026-09-14T01:30:00Z"), w);
    assert.equal(t.at.toISOString(), "2026-09-14T03:00:00.000Z"); // not 02:00!
    assert.equal(t.to, "offpeak");
  });

  it("duplicate windows behave like one", () => {
    const w = loadSchedule({
      DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([
        { days: [1], start: "01:00", end: "02:00" },
        { days: [1], start: "01:00", end: "02:00" },
      ]),
    });
    const t = nextTransition(D("2026-09-14T00:30:00Z"), w);
    assert.equal(t.at.toISOString(), "2026-09-14T01:00:00.000Z");
    assert.equal(t.to, "peak");
  });

  it("24/7 peak has no transitions and fails loud", () => {
    const w = loadSchedule({
      DEEPSEEK_PEAK_SCHEDULE: JSON.stringify([
        { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
      ]),
    });
    assert.equal(isPeak(D("2026-09-14T12:00:00Z"), w), true);
    assert.throws(() => nextTransition(D("2026-09-14T12:00:00Z"), w), /No upcoming transition/);
  });
});
