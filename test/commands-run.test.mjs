import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import {
  shouldColor,
  createColors,
  setColors,
  nextPeakStart,
  renderStatus,
  renderWatchFrame,
  renderDay,
  parseDay,
  parseArgs,
  main,
  cmdWait,
} from "../lib/commands.mjs";
import { loadSchedule } from "../lib/schedule.mjs";
import { withEnv, peakScheduleNow, offPeakScheduleNow, stubConsole } from "./helpers.mjs";

const FIXED_WINDOWS = loadSchedule({});

function fixedStatus(peak, to) {
  return {
    now: new Date("2026-09-14T09:00:00Z"),
    peak,
    transition: { at: new Date("2026-09-14T10:00:00Z"), to, inMs: 3600000 },
    windows: FIXED_WINDOWS,
  };
}

describe("main: one-shot commands", () => {
  let cap;
  beforeEach(() => {
    setColors(createColors(false));
    cap = stubConsole();
  });
  afterEach(() => cap.restore());

  it("help and parse errors", async () => {
    assert.equal(await main(["--help"]), 0);
    assert.match(cap.logs.join("\n"), /Usage:/);
    assert.equal(await main(["bogus"]), 2);
    assert.match(cap.errors.join("\n"), /Unknown command/);
  });

  it("status plain and json", async () => {
    assert.equal(await main(["status"]), 0);
    assert.match(cap.logs.join("\n"), /DeepSeek pricing windows/);
    cap.logs.length = 0;
    assert.equal(await main(["status", "--json"]), 0);
    assert.equal(typeof JSON.parse(cap.logs[0]).peak, "boolean");
  });

  it("is-peak exits both ways", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: peakScheduleNow() }, async () => {
      assert.equal(await main(["is-peak", "--quiet"]), 1);
      cap.logs.length = 0;
      assert.equal(await main(["is-peak"]), 1);
      assert.match(cap.logs.join("\n"), /^peak$/m);
    });
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: offPeakScheduleNow() }, async () => {
      assert.equal(await main(["is-peak", "--quiet"]), 0);
      cap.logs.length = 0;
      assert.equal(await main(["is-peak"]), 0);
      assert.match(cap.logs.join("\n"), /off-peak/);
    });
    assert.equal(await main(["is-peak", "--json"]), 0);
    assert.ok("transition" in JSON.parse(cap.logs.at(-1)));
  });

  it("next in all formats", async () => {
    assert.equal(await main(["next"]), 0);
    assert.match(cap.logs.join("\n"), /Peak (starts|ends)/);
    cap.logs.length = 0;
    assert.equal(await main(["next", "--unix"]), 0);
    assert.match(cap.logs.at(-1), /^\d+$/);
    cap.logs.length = 0;
    assert.equal(await main(["next", "--json"]), 0);
    assert.ok("at" in JSON.parse(cap.logs.at(-1)));
  });

  it("next covers both transition directions", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: peakScheduleNow() }, async () => {
      await main(["next"]);
      assert.match(cap.logs.join("\n"), /Peak ends/);
    });
    cap.logs.length = 0;
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: offPeakScheduleNow() }, async () => {
      await main(["next"]);
      assert.match(cap.logs.join("\n"), /Peak starts/);
    });
  });

  it("day variants", async () => {
    assert.equal(await main(["day"]), 0);
    assert.match(cap.logs.join("\n"), /\(UTC\)/);
    cap.logs.length = 0;
    assert.equal(await main(["day", "--date", "2026-09-19"]), 0);
    assert.match(cap.logs.join("\n"), /Sat 2026-09-19/);
    cap.logs.length = 0;
    assert.equal(await main(["day", "--json"]), 0);
    assert.equal(JSON.parse(cap.logs.at(-1)).length, 48);
    assert.equal(await main(["day", "--date", "garbage"]), 2);
    assert.match(cap.errors.join("\n"), /Bad --date/);
  });

  it("watch without a TTY fails fast", async () => {
    assert.equal(await main(["watch"]), 2);
    assert.match(cap.errors.join("\n"), /needs a TTY/);
  });

  it("watch renders frames on a TTY", async () => {
    const prevIsTTY = process.stdout.isTTY;
    const origWrite = process.stdout.write;
    let written = "";
    process.stdout.isTTY = true;
    process.stdout.write = (chunk) => {
      written += String(chunk);
      return true;
    };
    try {
      assert.equal(await main(["watch", "--frames", "1"]), 0);
      assert.match(written, /peak-hours monitor/);
      written = "";
      assert.equal(await main(["watch", "--frames=2"]), 0);
      assert.match(written, /Next peak:/);
    } finally {
      process.stdout.isTTY = prevIsTTY;
      process.stdout.write = origWrite;
    }
  });
});

describe("main: wait", () => {
  let cap;
  beforeEach(() => {
    setColors(createColors(false));
    cap = stubConsole();
  });
  afterEach(() => cap.restore());

  it("returns immediately when the condition holds", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: offPeakScheduleNow() }, async () => {
      assert.equal(await main(["wait", "--for", "offpeak"]), 0);
      assert.match(cap.logs.join("\n"), /Off-peak hours are on/);
    });
    cap.logs.length = 0;
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: peakScheduleNow() }, async () => {
      assert.equal(await main(["wait", "--for", "peak"]), 0);
      assert.match(cap.logs.join("\n"), /Peak hours are on/);
    });
    cap.logs.length = 0;
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: peakScheduleNow() }, async () => {
      assert.equal(await main(["wait", "--for", "peak", "--quiet"]), 0);
      assert.equal(cap.logs.length, 0);
    });
  });

  it("times out with progress output", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: offPeakScheduleNow() }, async () => {
      assert.equal(await main(["wait", "--for", "peak", "--timeout", "1", "--poll", "1"]), 2);
      assert.match(cap.logs.join("\n"), /waiting for peak — peak starts/);
      assert.match(cap.errors.join("\n"), /timed out/);
    });
  });

  it("times out loudly in the other direction", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: peakScheduleNow() }, async () => {
      assert.equal(await main(["wait", "--for", "offpeak", "--timeout", "1", "--poll", "1"]), 2);
      assert.match(cap.logs.join("\n"), /waiting for off-peak — peak ends/);
      assert.match(cap.errors.join("\n"), /timed out/);
    });
  });

  it("times out quietly", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: peakScheduleNow() }, async () => {
      assert.equal(await main(["wait", "--for", "offpeak", "--timeout", "1", "--poll", "1", "--quiet"]), 2);
      assert.equal(cap.logs.length, 0);
      assert.match(cap.errors.join("\n"), /timed out/);
    });
  });

  it("runs --exec and passes through its exit code", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: offPeakScheduleNow() }, async () => {
      assert.equal(await main(["wait", "--for", "offpeak", "--exec", "true"]), 0);
      assert.equal(await main(["wait", "--for", "offpeak", "--exec", "kill -9 $$"]), 0);
    });
  });

  it("cmdWait works with minimal opts (all defaults)", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: offPeakScheduleNow() }, async () => {
      assert.equal(await cmdWait({ for: "offpeak" }), 0);
      assert.match(cap.logs.join("\n"), /Off-peak hours are on/);
    });
  });

  it("notifies on success and tolerates notify failure", async () => {
    const got = [];
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got.push(JSON.parse(body));
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${srv.address().port}/hook`;
      await withEnv({ DEEPSEEK_PEAK_SCHEDULE: peakScheduleNow() }, async () => {
        assert.equal(await main(["wait", "--for", "peak", "--notify", url]), 0);
        assert.equal(got.at(-1).event, "peak-start");
        assert.match(cap.logs.join("\n"), new RegExp(`Notified ${url.replace(/[.:]/g, "\\$&")}`));
      });
      cap.logs.length = 0;
      await withEnv({ DEEPSEEK_PEAK_SCHEDULE: offPeakScheduleNow() }, async () => {
        assert.equal(await main(["wait", "--for=offpeak", "--notify", url]), 0);
        assert.equal(got.at(-1).event, "offpeak-start");
      });
      cap.logs.length = 0;
      await withEnv({ DEEPSEEK_PEAK_SCHEDULE: peakScheduleNow() }, async () => {
        assert.equal(await main(["wait", "--for", "peak", "--notify", "http://127.0.0.1:1/closed"]), 0);
        assert.match(cap.logs.join("\n"), /failed \(continuing anyway\)/);
      });
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});

describe("main: report", () => {
  let cap;
  const ledger = join(tmpdir(), `deepseek-peak-report-test-${process.pid}.jsonl`);
  before(async () => {
    const now = new Date().toISOString();
    await writeFile(
      ledger,
      [
        JSON.stringify({ ts: now, type: "blocked", session: "s1", model: "deepseek-chat", endpoint: "api.deepseek.com", reason: "endpoint" }),
        JSON.stringify({ type: "aborted", session: "s1" }),
        "not json",
      ].join("\n") + "\n",
    );
  });
  after(async () => {
    await unlink(ledger).catch(() => {});
  });
  beforeEach(() => {
    setColors(createColors(false));
    cap = stubConsole();
  });
  afterEach(() => cap.restore());

  it("empty and missing ledgers", async () => {
    assert.equal(await main(["report", "--ledger", join(tmpdir(), `deepseek-peak-nope-${process.pid}.jsonl`)]), 0);
    assert.match(cap.logs.join("\n"), /No events recorded yet/);
  });

  it("counts, days, estimate and json", async () => {
    assert.equal(await main(["report", "--ledger", ledger]), 0);
    const text = cap.logs.join("\n");
    assert.match(text, /Blocked requests: 1/);
    assert.match(text, /unknown/);
    cap.logs.length = 0;
    assert.equal(await main(["report", "--ledger", ledger, "--estimate"]), 0);
    assert.match(cap.logs.join("\n"), /Rough savings: \$/);
    cap.logs.length = 0;
    assert.equal(await main(["report", "--ledger", ledger, "--estimate", "--json"]), 0);
    const parsed = JSON.parse(cap.logs.at(-1));
    assert.equal(parsed.blocked, 1);
    assert.ok(parsed.estimate.totalUsd > 0);
    cap.logs.length = 0;
    assert.equal(await main(["report", "--ledger", ledger, "--json"]), 0);
    assert.equal(JSON.parse(cap.logs.at(-1)).estimate, null);
  });

  it("since filter can empty the report", async () => {
    assert.equal(await main(["report", "--ledger", ledger, "--since", "2999-01-01"]), 0);
    assert.match(cap.logs.join("\n"), /No events recorded yet/);
  });

  it("reports ledgers without any timestamps", async () => {
    const weird = join(tmpdir(), `deepseek-peak-weird-${process.pid}.jsonl`);
    await writeFile(weird, JSON.stringify({ type: "blocked", session: "s" }) + "\n");
    try {
      assert.equal(await main(["report", "--ledger", weird]), 0);
      assert.match(cap.logs.join("\n"), /\(\? → \?\)/);
    } finally {
      await unlink(weird).catch(() => {});
    }
  });

  it("default ledger path works (whatever it contains)", async () => {
    assert.equal(await main(["report"]), 0);
    assert.match(cap.logs[0], /^DeepSeek peak-guard report/);
  });
});

describe("cli.mjs entry point", () => {
  it("runs main() with process.argv", async () => {
    const prevArgv = process.argv;
    const prevExitCode = process.exitCode;
    const cap = stubConsole();
    process.argv = ["node", "cli.mjs", "next", "--unix"];
    try {
      await import("../cli.mjs");
      assert.match(cap.logs.at(-1), /^\d+$/);
      assert.equal(process.exitCode, 0);
    } finally {
      process.argv = prevArgv;
      process.exitCode = prevExitCode;
      cap.restore();
    }
  });
});
