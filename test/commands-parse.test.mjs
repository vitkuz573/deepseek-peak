import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldColor,
  createColors,
  setColors,
  nextPeakStart,
  renderStatus,
  renderSourceLine,
  renderWatchFrame,
  renderDay,
  parseDay,
  parseArgs,
  resolveSyncUrl,
} from "../lib/commands.mjs";
import { loadSchedule } from "../lib/schedule.mjs";
import { PRICING_URL } from "../lib/sync.mjs";
import { withEnv, peakScheduleNow, offPeakScheduleNow } from "./helpers.mjs";

const FIXED_WINDOWS = loadSchedule({});

function fixedStatus(peak, to) {
  return {
    now: new Date("2026-09-14T09:00:00Z"),
    peak,
    transition: { at: new Date("2026-09-14T10:00:00Z"), to, inMs: 3600000 },
    windows: FIXED_WINDOWS,
  };
}

describe("colors", () => {
  it("shouldColor matrix", () => {
    assert.equal(shouldColor({ isTTY: true }, {}), true);
    assert.equal(shouldColor({ isTTY: true }, { NO_COLOR: "1" }), false);
    assert.equal(shouldColor({}, {}), false);
    assert.equal(shouldColor({ isTTY: false }, {}), false);
  });

  it("createColors on/off for every style", () => {
    const on = createColors(true);
    const off = createColors(false);
    for (const [name, code] of [["red", 31], ["green", 32], ["bold", 1], ["dim", 2]]) {
      assert.match(on[name]("x"), new RegExp(`\\x1b\\[${code}m`));
      assert.equal(off[name]("x"), "x");
    }
    setColors(createColors(false)); // keep the rest of the suite on plain output
  });
});

describe("pure renders", () => {
  it("nextPeakStart finds the upcoming peak from both states", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: peakScheduleNow() }, async () => {
      const w = loadSchedule();
      const t1 = nextPeakStart(new Date(), w);
      assert.equal(t1.to, "peak");
      assert.ok(t1.at.getTime() > Date.now());
    });
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: offPeakScheduleNow() }, async () => {
      const w = loadSchedule();
      const t2 = nextPeakStart(new Date(), w);
      assert.equal(t2.to, "peak");
    });
    assert.throws(
      () => nextPeakStart(new Date("2026-09-14T00:00:00Z"), [{ days: [99], startMin: 0, endMin: 60 }]),
      /No upcoming transition/,
    );
  });

  it("renderStatus peak and off-peak", () => {
    const peak = renderStatus(fixedStatus(true, "offpeak"), { source: "builtin" });
    assert.match(peak, /PEAK/);
    assert.match(peak, /Peak ends at 10:00 UTC/);
    assert.match(peak, /Next peak:/);
    assert.match(peak, /Schedule source: built-in defaults/);
    const off = renderStatus(fixedStatus(false, "peak"), { source: "builtin" });
    assert.match(off, /OFF-PEAK/);
    assert.match(off, /Peak starts at 10:00 UTC/);
  });

  it("renderSourceLine covers every origin", () => {
    assert.equal(renderSourceLine({ source: "env" }), "Schedule source: DEEPSEEK_PEAK_SCHEDULE override");
    assert.match(
      renderSourceLine({ source: "cache", meta: { fetchedAt: new Date().toISOString() } }),
      /Schedule source: cache \(fetched /,
    );
    assert.doesNotMatch(renderSourceLine({ source: "cache", meta: { fetchedAt: new Date().toISOString() } }), /STALE/);
    assert.match(renderSourceLine({ source: "cache", meta: { fetchedAt: "2020-01-01T00:00:00.000Z" } }), /STALE/);
    assert.match(renderSourceLine({ source: "cache", meta: {} }), /unknown fetch date/);
    assert.match(renderSourceLine({ source: "cache" }), /unknown fetch date/);
    assert.match(
      renderSourceLine({ source: "builtin", cacheIssue: "not valid JSON" }),
      /built-in defaults \(schedule cache invalid/,
    );
    assert.match(renderSourceLine({ source: "builtin" }), new RegExp(PRICING_URL.replace(/[.:/]/g, "\\$&")));
  });

  it("renderWatchFrame all four state combos", () => {
    assert.match(renderWatchFrame(fixedStatus(true, "offpeak")), /Peak ends in/);
    assert.match(renderWatchFrame(fixedStatus(false, "peak")), /Peak starts in/);
    assert.match(renderWatchFrame(fixedStatus(true, "offpeak")), /Next peak:/);
    assert.match(renderWatchFrame(fixedStatus(false, "peak")), /Ctrl\+C to exit/);
  });

  it("renderDay marker on/off and peak state", () => {
    const day = new Date(Date.UTC(2026, 8, 14));
    const w = loadSchedule({});
    const markedPeak = renderDay(day, w, new Date("2026-09-14T09:00:00Z"));
    assert.match(markedPeak, /\^ now 09:00 UTC — PEAK/);
    assert.equal(markedPeak.split("\n")[3].length, 48);
    const markedOff = renderDay(day, w, new Date("2026-09-14T12:00:00Z"));
    assert.match(markedOff, /OFF-PEAK/);
    const otherDay = renderDay(day, w, new Date("2026-09-15T09:00:00Z"));
    assert.doesNotMatch(otherDay, /\^ now/);
  });

  it("parseDay", () => {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ymd = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`;
    assert.equal(parseDay(undefined).toISOString().slice(0, 10), ymd);
    assert.equal(parseDay("").toISOString().slice(0, 10), ymd);
    assert.equal(parseDay("2026-09-19").toISOString(), "2026-09-19T00:00:00.000Z");
    assert.throws(() => parseDay("garbage"), /Bad --date/);
    assert.throws(() => parseDay("2026-13-01"), /Bad --date/);
    assert.throws(() => parseDay("2026-00-10"), /Bad --date/);
    assert.throws(() => parseDay("2026-01-00"), /Bad --date/);
    assert.throws(() => parseDay("2026-01-32"), /Bad --date/);
  });
});

describe("parseArgs", () => {
  const flagCases = [
    [["--json"], (o) => assert.equal(o.json, true)],
    [["--unix"], (o) => assert.equal(o.unix, true)],
    [["--quiet"], (o) => assert.equal(o.quiet, true)],
    [["-q"], (o) => assert.equal(o.quiet, true)],
    [["--for", "peak"], (o) => assert.equal(o.for, "peak")],
    [["--for=peak"], (o) => assert.equal(o.for, "peak")],
    [["--for"], (o) => assert.equal(o.for, "offpeak")],
    [["--timeout", "3"], (o) => assert.equal(o.timeout, 3)],
    [["--timeout=3"], (o) => assert.equal(o.timeout, 3)],
    [["--timeout"], (o) => assert.equal(o.timeout, 0)],
    [["--poll", "2"], (o) => assert.equal(o.poll, 2)],
    [["--poll=2"], (o) => assert.equal(o.poll, 2)],
    [["--poll"], (o) => assert.equal(o.poll, 5)],
    [["--exec", "echo hi"], (o) => assert.equal(o.exec, "echo hi")],
    [["--exec=echo hi"], (o) => assert.equal(o.exec, "echo hi")],
    [["--exec"], (o) => assert.equal(o.exec, null)],
    [["--notify", "https://x"], (o) => assert.equal(o.notify, "https://x")],
    [["--notify=https://x"], (o) => assert.equal(o.notify, "https://x")],
    [["--notify"], (o) => assert.equal(o.notify, null)],
    [["--url", "https://x"], (o) => assert.equal(o.url, "https://x")],
    [["--url=https://x"], (o) => assert.equal(o.url, "https://x")],
    [["--url"], (o) => assert.equal(o.url, null)],
    [["--cache", "/tmp/c"], (o) => assert.equal(o.cache, "/tmp/c")],
    [["--cache=/tmp/c"], (o) => assert.equal(o.cache, "/tmp/c")],
    [["--cache"], (o) => assert.equal(o.cache, null)],
    [["--check"], (o) => assert.equal(o.check, true)],
    [["--date", "2026-09-19"], (o) => assert.equal(o.date, "2026-09-19")],
    [["--date=2026-09-19"], (o) => assert.equal(o.date, "2026-09-19")],
    [["--date="], (o) => assert.equal(o.date, "")],
    [["--date"], (o) => assert.equal(o.date, null)],
    [["--since", "2026-09-01"], (o) => assert.equal(o.since, "2026-09-01")],
    [["--since=2026-09-01"], (o) => assert.equal(o.since, "2026-09-01")],
    [["--since"], (o) => assert.equal(o.since, null)],
    [["--ledger", "/tmp/l"], (o) => assert.equal(o.ledger, "/tmp/l")],
    [["--ledger=/tmp/l"], (o) => assert.equal(o.ledger, "/tmp/l")],
    [["--ledger"], (o) => assert.equal(o.ledger, null)],
    [["--frames"], (o) => assert.equal(o.frames, 1)],
    [["--frames=2"], (o) => assert.equal(o.frames, 2)],
    [["--estimate"], (o) => assert.equal(o.estimate, true)],
    [["--avg-in", "1"], (o) => assert.equal(o.avgIn, 1)],
    [["--avg-in=1"], (o) => assert.equal(o.avgIn, 1)],
    [["--avg-in"], (o) => assert.equal(o.avgIn, 4000)],
    [["--avg-out", "2"], (o) => assert.equal(o.avgOut, 2)],
    [["--avg-out=2"], (o) => assert.equal(o.avgOut, 2)],
    [["--avg-out"], (o) => assert.equal(o.avgOut, 1000)],
    [["--input-price", "0.5"], (o) => assert.equal(o.inputPrice, 0.5)],
    [["--input-price=0.5"], (o) => assert.equal(o.inputPrice, 0.5)],
    [["--input-price"], (o) => assert.equal(o.inputPrice, 0.3)],
    [["--output-price", "2"], (o) => assert.equal(o.outputPrice, 2)],
    [["--output-price=2"], (o) => assert.equal(o.outputPrice, 2)],
    [["--output-price"], (o) => assert.equal(o.outputPrice, 1.2)],
    [["-h"], (p) => assert.equal(p.command, "help")],
    [["--help"], (p) => assert.equal(p.command, "help")],
    [["day", "extra", "--json"], (p) => assert.equal(p.command, "day")],
  ];
  for (const [args, check] of flagCases) {
    it(`parse ${args.join(" ")}`, () => {
      const parsed = parseArgs(args);
      check({ ...parsed.opts, command: parsed.command });
    });
  }

  it("defaults", () => {
    const { command, opts } = parseArgs([]);
    assert.equal(command, "status");
    assert.equal(opts.for, "offpeak");
    assert.equal(opts.poll, 5);
    assert.equal(opts.frames, null);
  });

  it("rejects unknown flags, commands and --for", () => {
    assert.throws(() => parseArgs(["--bogus"]), /Unknown flag/);
    assert.throws(() => parseArgs(["bogus-cmd"]), /Unknown command/);
    assert.throws(() => parseArgs(["--for", "x"]), /--for must be/);
  });

  it("resolveSyncUrl prefers flag, then env, then docs", async () => {
    assert.equal(resolveSyncUrl({ url: "https://flag.invalid" }), "https://flag.invalid");
    await withEnv({ DEEPSEEK_PEAK_URL: "https://env.invalid" }, async () => {
      assert.equal(resolveSyncUrl({ url: null }), "https://env.invalid");
    });
    await withEnv({ DEEPSEEK_PEAK_URL: undefined }, async () => {
      assert.equal(resolveSyncUrl({ url: null }), PRICING_URL);
    });
  });
});

