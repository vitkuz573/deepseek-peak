import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFile, unlink } from "node:fs/promises";
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
  it("honours XDG_DATA_HOME", () => {
    assert.equal(
      defaultLedgerPath({ XDG_DATA_HOME: "/tmp/xdg" }),
      join("/tmp/xdg", "deepseek-peak", "events.jsonl"),
    );
  });
});

describe("append/read/summarize round-trip", () => {
  it("writes, skips corrupt lines, and aggregates", async () => {
    assert.equal(await appendEvent(tmpFile, { type: "blocked", model: "deepseek-chat" }), true);
    assert.equal(await appendEvent(tmpFile, { type: "blocked", model: "deepseek-chat" }), true);
    assert.equal(await appendEvent(tmpFile, { type: "aborted", session: "abc" }), true);
    assert.equal(await appendEvent(tmpFile, { type: "peak-start", aborted: 1 }), true);
    await appendFile(tmpFile, "this is not json\n", "utf8");
    assert.equal(await appendEvent(null, { type: "blocked" }), false);

    const events = await readEvents(tmpFile);
    assert.equal(events.length, 4);
    assert.ok(events.every((e) => typeof e.ts === "string"));

    const s = summarize(events);
    assert.equal(s.total, 4);
    assert.equal(s.blocked, 2);
    assert.equal(s.aborted, 1);
    assert.equal(s.peakStarts, 1);
    assert.equal(s.warned, 0);
    assert.ok(s.firstTs && s.lastTs && s.firstTs <= s.lastTs);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(s.byDay[today].blocked, 2);
  });

  it("since filter", async () => {
    assert.equal((await readEvents(tmpFile, { since: "2000-01-01" })).length, 4);
    assert.equal((await readEvents(tmpFile, { since: "2999-01-01" })).length, 0);
  });

  it("missing file reads as empty", async () => {
    assert.deepEqual(await readEvents(join(tmpdir(), `deepseek-peak-nope-${process.pid}.jsonl`)), []);
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
});
