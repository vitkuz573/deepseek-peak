import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFile, unlink, writeFile } from "node:fs/promises";
import {
  defaultLedgerPath,
  resolveLedgerPath,
  appendEvent,
  readEvents,
  summarize,
  estimateSavings,
} from "../lib/ledger.mjs";

const tmpFile = join(tmpdir(), `deepseek-peak-ledger-test-${process.pid}.jsonl`);
after(async () => {
  await unlink(tmpFile).catch(() => {});
});

describe("resolveLedgerPath", () => {
  it("false disables", () => assert.equal(resolveLedgerPath(false, {}), null));
  it("env 0 disables even when enabled", () => assert.equal(resolveLedgerPath(true, { DEEPSEEK_PEAK_LEDGER: "0" }), null));
  it("explicit path wins", () => assert.equal(resolveLedgerPath("/tmp/x.jsonl", {}), "/tmp/x.jsonl"));
  it("env path wins over default", () =>
    assert.equal(resolveLedgerPath(undefined, { DEEPSEEK_PEAK_LEDGER: "/tmp/y.jsonl" }), "/tmp/y.jsonl"));
  it("defaults to an events.jsonl under data home", () => {
    assert.ok(resolveLedgerPath(undefined, {}).endsWith(join("deepseek-peak", "events.jsonl")));
    assert.ok(defaultLedgerPath({}).endsWith(join("deepseek-peak", "events.jsonl")));
  });
  it("env truthy values force the default path", () => {
    for (const v of ["1", "true", "yes", "on"]) {
      assert.ok(resolveLedgerPath(false, { DEEPSEEK_PEAK_LEDGER: v }).endsWith("events.jsonl"));
    }
  });
  it("empty env falls back to the setting", () => {
    assert.equal(resolveLedgerPath("/tmp/z.jsonl", { DEEPSEEK_PEAK_SCHEDULE: undefined, DEEPSEEK_PEAK_LEDGER: "" }), "/tmp/z.jsonl");
  });
  it("honours XDG_DATA_HOME", () => {
    assert.equal(
      defaultLedgerPath({ XDG_DATA_HOME: "/tmp/xdg" }),
      join("/tmp/xdg", "deepseek-peak", "events.jsonl"),
    );
    assert.ok(defaultLedgerPath({ XDG_DATA_HOME: "" }).endsWith(join("deepseek-peak", "events.jsonl")));
  });
});

describe("append/read/summarize round-trip", () => {
  it("writes, skips corrupt lines, and aggregates", async () => {
    assert.equal(await appendEvent(tmpFile, { type: "blocked", model: "deepseek-chat" }), true);
    assert.equal(await appendEvent(tmpFile, { type: "blocked", model: "deepseek-chat" }), true);
    assert.equal(await appendEvent(tmpFile, { type: "allowed-warn", model: "deepseek-chat" }), true);
    assert.equal(await appendEvent(tmpFile, { type: "aborted", session: "abc" }), true);
    assert.equal(await appendEvent(tmpFile, { type: "peak-start", aborted: 1 }), true);
    assert.equal(await appendEvent(tmpFile, { type: "offpeak-start" }), true);
    await appendFile(tmpFile, "this is not json\nnull\n5\n{}\n", "utf8");
    // A valid event with an ancient date (exercises out-of-order summaries).
    await appendFile(tmpFile, JSON.stringify({ ts: "2000-01-01T00:00:00.000Z", type: "weird" }) + "\n", "utf8");
    assert.equal(await appendEvent(null, { type: "blocked" }), false);

    const events = await readEvents(tmpFile);
    assert.equal(events.length, 7);
    assert.ok(events.every((e) => typeof e.ts === "string"));

    const s = summarize(events);
    assert.equal(s.total, 7);
    assert.equal(s.blocked, 2);
    assert.equal(s.warned, 1);
    assert.equal(s.aborted, 1);
    assert.equal(s.peakStarts, 1);
    assert.equal(s.offpeakStarts, 1);
    assert.equal(s.firstTs, "2000-01-01T00:00:00.000Z");
    assert.ok(s.lastTs && s.firstTs <= s.lastTs);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(s.byDay[today].blocked, 2);
    assert.equal(s.byDay[today].warned, 1);
    assert.equal(s.byDay["2000-01-01"].blocked, 0);
  });

  it("since filter", async () => {
    assert.equal((await readEvents(tmpFile, { since: "2000-01-01" })).length, 7);
    assert.equal((await readEvents(tmpFile, { since: "2999-01-01" })).length, 0);
  });

  it("since drops dateless events", async () => {
    const dateless = join(tmpdir(), `deepseek-peak-dateless-${process.pid}.jsonl`);
    try {
      await writeFile(dateless, JSON.stringify({ type: "blocked" }) + "\n");
      assert.equal((await readEvents(dateless)).length, 1);
      assert.equal((await readEvents(dateless, { since: "2000-01-01" })).length, 0);
    } finally {
      await unlink(dateless).catch(() => {});
    }
  });

  it("non-ENOENT read errors propagate", async () => {
    await assert.rejects(() => readEvents(tmpdir()), /EISDIR/);
  });

  it("missing file reads as empty", async () => {
    assert.deepEqual(await readEvents(join(tmpdir(), `deepseek-peak-nope-${process.pid}.jsonl`)), []);
  });

  it("write failures resolve false", async () => {
    const blocker = join(tmpdir(), `deepseek-peak-blocker-${process.pid}`);
    await writeFile(blocker, "i am a file, not a dir");
    try {
      assert.equal(await appendEvent(join(blocker, "events.jsonl"), { type: "blocked" }), false);
    } finally {
      await unlink(blocker).catch(() => {});
    }
  });
});

describe("estimateSavings", () => {
  it("peak-vs-offpeak delta math", () => {
    // defaults: 4000 in @ $0.30, 1000 out @ $1.20 per 1M (peak); off-peak is half.
    // per request: 0.004*0.15 + 0.001*0.6 = 0.0012
    const e = estimateSavings(10);
    assert.ok(Math.abs(e.perRequestUsd - 0.0012) < 1e-12);
    assert.ok(Math.abs(e.totalUsd - 0.012) < 1e-12);
    assert.equal(estimateSavings(0).totalUsd, 0);
  });

  it("explicit assumptions", () => {
    // 1 in-token @ $3, 2 out-tokens @ $4 per 1M (peak); off-peak is half:
    // per request: 1e-6*1.5 + 2e-6*2 = 5.5e-6
    const e = estimateSavings(10, { avgIn: 1, avgOut: 2, inputPrice: 3, outputPrice: 4 });
    assert.ok(Math.abs(e.perRequestUsd - 5.5e-6) < 1e-15);
    assert.ok(Math.abs(e.totalUsd - 5.5e-5) < 1e-15);
    assert.deepEqual(e.assumptions, { avgIn: 1, avgOut: 2, inputPrice: 3, outputPrice: 4 });
  });
});
