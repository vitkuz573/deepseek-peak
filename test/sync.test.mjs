import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink, readFile, writeFile } from "node:fs/promises";
import {
  PRICING_URL,
  fetchPricingPage,
  htmlToText,
  extractSchedule,
  schedulesEqual,
  writeCacheFile,
  syncSchedule,
} from "../lib/sync.mjs";
import { normalizeWindows, readCacheFile } from "../lib/schedule.mjs";

const page = (body) =>
  `<html><head><title>Pricing</title><style>.x{color:red}</style><script>var x = 1;</script></head><body><main><p>${body}</p></main></body></html>`;

const CURRENT = "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak).";

describe("htmlToText", () => {
  it("strips tags, scripts, styles and collapses whitespace", () => {
    assert.equal(htmlToText(page("Hello <b>peak</b>  hours")), "Pricing Hello peak hours");
    assert.equal(htmlToText(null), "");
    assert.equal(htmlToText("  a\n\tb  "), "a b");
  });
});

describe("extractSchedule", () => {
  it("parses the current docs sentence", () => {
    const { windows, excerpt } = extractSchedule(page(CURRENT));
    assert.deepEqual(windows, [
      { days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" },
      { days: [1, 2, 3, 4, 5], start: "06:00", end: "10:00" },
    ]);
    assert.match(excerpt, /Peak hours are/);
    // The result validates cleanly.
    assert.equal(normalizeWindows(windows).length, 2);
  });

  it("skips footnote mentions without times (live page shape)", () => {
    const { windows } = extractSchedule(
      page("(3) Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak)."),
    );
    assert.deepEqual(windows, [
      { days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" },
      { days: [1, 2, 3, 4, 5], start: "06:00", end: "10:00" },
    ]);
  });

  it("rethrows the parse error when every mention fails", () => {
    assert.throws(() => extractSchedule(page("Peak hours are great, trust us.")), /no UTC timezone marker/);
  });

  const variants = [
    ["en-dash + Mon-Fri", "Peak hours: 02:00–05:00 UTC, Mon-Fri.", [[1, 2, 3, 4, 5]], [["02:00", "05:00"]]],
    ["to separator + weekends", "Peak hours are 01:00 to 04:00 UTC on weekends.", [[0, 6]], [["01:00", "04:00"]]],
    ["daily", "Peak hours are 00:00 - 01:00 UTC daily.", [[0, 1, 2, 3, 4, 5, 6]], [["00:00", "01:00"]]],
    ["weekdays word", "Peak hours are 09:00 - 12:00 UTC on weekdays.", [[1, 2, 3, 4, 5]], [["09:00", "12:00"]]],
    [
      "Monday through Sunday",
      "Peak hours are 00:00 - 01:00 UTC, Monday through Sunday.",
      [[0, 1, 2, 3, 4, 5, 6]],
      [["00:00", "01:00"]],
    ],
    ["overnight", "Peak hours are 22:00 - 02:00 UTC, Monday through Friday.", [[1, 2, 3, 4, 5]], [["22:00", "02:00"]]],
    ["no trailing period", "Peak hours are 22:00 - 02:00 UTC, Monday through Friday", [[1, 2, 3, 4, 5]], [["22:00", "02:00"]]],
  ];
  for (const [name, sentence, [days], [[start, end]]] of variants) {
    it(name, () => {
      const { windows } = extractSchedule(page(sentence));
      assert.deepEqual(windows, [{ days, start, end }]);
    });
  }

  const failures = [
    ["no peak sentence", "Our prices are great and flat all week.", /no "peak hours" statement/],
    ["no UTC marker", "Peak hours are 01:00 - 04:00, Monday through Friday.", /no UTC timezone marker/],
    ["non-UTC offset", "Peak hours are 09:00 - 12:00 UTC+8, Monday through Friday.", /non-UTC offset/],
    ["removed peak", "Peak hours have been removed. Everything is off-peak now.", /removed/],
    ["no times", "Peak hours apply UTC, Monday through Friday.", /no HH:MM time ranges/],
    ["implausible time", "Peak hours are 25:00 - 26:00 UTC, Monday through Friday.", /implausible time/],
    ["zero-length window", "Peak hours are 01:00 - 01:00 UTC, Monday through Friday.", /zero-length/],
    ["no day scope", "Peak hours are 01:00 - 04:00 UTC.", /which days/],
  ];
  for (const [name, sentence, pattern] of failures) {
    it(`fails loud: ${name}`, () => {
      assert.throws(() => extractSchedule(page(sentence)), pattern);
    });
  }
});

describe("schedulesEqual", () => {
  const a = normalizeWindows([{ days: [1, 2], start: "01:00", end: "02:00" }]);
  it("equal regardless of window/day order", () => {
    const b = normalizeWindows([{ days: [2, 1], start: "01:00", end: "02:00" }]);
    assert.equal(schedulesEqual(a, b), true);
  });
  it("detects time, day and length differences", () => {
    assert.equal(schedulesEqual(a, normalizeWindows([{ days: [1, 2], start: "01:00", end: "03:00" }])), false);
    assert.equal(schedulesEqual(a, normalizeWindows([{ days: [1, 3], start: "01:00", end: "02:00" }])), false);
    assert.equal(
      schedulesEqual(a, normalizeWindows([{ days: [1, 2], start: "01:00", end: "02:00" }, { days: [1], start: "03:00", end: "04:00" }])),
      false,
    );
  });
});

describe("fetchPricingPage", () => {
  it("reads 2xx bodies and rejects the rest", async () => {
    const srv = createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page(CURRENT));
      } else {
        res.writeHead(500);
        res.end("boom");
      }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${srv.address().port}`;
      assert.match(await fetchPricingPage(`${base}/ok`), /Peak hours are/);
      await assert.rejects(() => fetchPricingPage(`${base}/nope`), /HTTP 500/);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  it("times out on hanging servers", async () => {
    const srv = createServer(() => {});
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(
        () => fetchPricingPage(`http://127.0.0.1:${srv.address().port}/hang`, { timeoutMs: 100 }),
        /./,
      );
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});

describe("syncSchedule", () => {
  const cache = join(tmpdir(), `deepseek-peak-sync-test-${process.pid}.jsonl`);
  after(async () => {
    await unlink(cache).catch(() => {});
  });

  it("writes a valid cache via injected fetch", async () => {
    const now = new Date("2026-09-14T10:00:00.000Z");
    const result = await syncSchedule({
      url: "https://example.invalid/pricing",
      cachePath: cache,
      fetchPage: async () => page(CURRENT),
      now,
    });
    assert.equal(result.changed, false);
    assert.equal(result.meta.fetchedAt, "2026-09-14T10:00:00.000Z");
    assert.equal(result.meta.sourceUrl, "https://example.invalid/pricing");
    assert.equal(result.cachePath, cache);
    const onDisk = JSON.parse(await readFile(cache, "utf8"));
    assert.equal(onDisk.version, 1);
    assert.deepEqual(readCacheFile(cache), {
      status: "ok",
      windows: result.windows,
      meta: result.meta,
    });
  });

  it("detects changed hours", async () => {
    const result = await syncSchedule({
      url: "https://example.invalid/pricing",
      cachePath: cache,
      fetchPage: async () => page("Peak hours are 02:00 - 05:00 UTC, Monday through Friday."),
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.windows, normalizeWindows([{ days: [1, 2, 3, 4, 5], start: "02:00", end: "05:00" }]));
  });

  it("propagates fetch and parse failures without touching the cache", async () => {
    await writeFile(cache, "sentinel");
    await assert.rejects(
      () => syncSchedule({ url: "https://example.invalid/x", cachePath: cache, fetchPage: async () => { throw new Error("down"); } }),
      /down/,
    );
    await assert.rejects(
      () => syncSchedule({ url: "https://example.invalid/x", cachePath: cache, fetchPage: async () => page("no peak info here") }),
      /no "peak hours" statement/,
    );
    assert.equal(await readFile(cache, "utf8"), "sentinel");
  });

  it("writeCacheFile round-trips", async () => {
    const target = join(tmpdir(), `deepseek-peak-cache-rt-${process.pid}.json`);
    try {
      await writeCacheFile(target, {
        windows: [{ days: [1], start: "01:00", end: "02:00" }],
        meta: { fetchedAt: "2026-09-14T00:00:00.000Z", sourceUrl: "u", excerpt: "e" },
      });
      const back = readCacheFile(target);
      assert.equal(back.status, "ok");
      assert.equal(back.meta.sourceUrl, "u");
    } finally {
      await unlink(target).catch(() => {});
    }
  });

  it("PRICING_URL points at the docs", () => {
    assert.match(PRICING_URL, /^https:\/\/api-docs\.deepseek\.com\//);
  });
});
