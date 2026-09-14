import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WINDOWS,
  loadSchedule,
  isPeak,
  nextTransition,
  status,
  formatDuration,
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
  });
});
