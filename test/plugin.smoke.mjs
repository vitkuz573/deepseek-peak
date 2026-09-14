// Smoke test for the opencode plugin (runs without an opencode server).
//
// The plugin reads the real clock, so most tests synthesize a peak window
// around "now" via DEEPSEEK_PEAK_SCHEDULE before importing the plugin:
// a 2-hour window starting at the current UTC hour, on today's weekday.
// That makes the tests deterministic no matter when they run.
// A dedicated off-peak-schedule section covers the off-peak paths.
//
// Requires Node >= 22.18 (type-stripping for the `.ts` plugin import).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink, writeFile } from "node:fs/promises";
import { readEvents } from "../lib/ledger.mjs";

const OFFICIAL = "https://api.deepseek.com";
const PROXY = "https://api.neutralbeats.com/v1";

const pad = (n) => String(n).padStart(2, "0");

function synthesizePeakAroundNow() {
  const now = new Date();
  const h = now.getUTCHours();
  process.env.DEEPSEEK_PEAK_SCHEDULE = JSON.stringify([
    { days: [now.getUTCDay()], start: `${pad(h)}:00`, end: `${pad((h + 2) % 24)}:00` },
  ]);
}

/** A 2-hour window that never contains "now" (starts 4h ahead). */
function offPeakScheduleNow() {
  const now = new Date();
  const h = now.getUTCHours();
  return JSON.stringify([
    { days: [now.getUTCDay()], start: `${pad((h + 4) % 24)}:00`, end: `${pad((h + 6) % 24)}:00` },
  ]);
}

async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// Capture armed timers so we can fire the transition callback manually.
// Installed at module scope (not in a suite hook) so it stays active for
// every suite in this file; restored by the top-level after() below.
const scheduled = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  scheduled.push({ fn, ms });
  const handle = realSetTimeout(() => {}, 2_147_483_647);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
};

after(() => {
  globalThis.setTimeout = realSetTimeout;
});

async function waitFor(cond, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => realSetTimeout(r, 25));
  }
}

function makeClient(calls, busySessions = {}) {
  return {
    app: {
      log: async ({ body }) => {
        calls.logs.push(body);
        return true;
      },
    },
    tui: {
      showToast: async ({ body }) => {
        calls.toasts.push(body);
        return true;
      },
    },
    session: {
      status: async () => busySessions,
      abort: async ({ path }) => {
        calls.aborts.push(path.id);
        return true;
      },
    },
  };
}

function newCalls() {
  return { logs: [], toasts: [], aborts: [] };
}

function chatInput(sessionID, modelID, providerID, baseURL) {
  return {
    sessionID,
    agent: "build",
    model: { id: modelID, name: modelID, providerID },
    provider: {
      source: "config",
      info: { id: providerID, name: providerID },
      options: baseURL === undefined ? {} : { baseURL },
    },
    message: {},
  };
}

/** Shape observed live: some providers omit `info`/`options` entirely. */
function bareChatInput(sessionID, modelID, providerID) {
  return {
    sessionID,
    agent: "build",
    model: { id: modelID, name: modelID, providerID },
    provider: { source: "config" },
    message: {},
  };
}

const tmpLedger = join(tmpdir(), `deepseek-peak-plugin-test-${process.pid}.jsonl`);

describe("opencode plugin (synthetic peak window)", () => {
  let plugin;
  let hooks;
  let calls;
  let notifyServer;
  let notifyUrl;
  let notified = [];

  before(async () => {
    synthesizePeakAroundNow();
    notified = [];
    notifyServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        notified.push(body);
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
    });
    await new Promise((resolve) => notifyServer.listen(0, "127.0.0.1", resolve));
    notifyUrl = `http://127.0.0.1:${notifyServer.address().port}/hook`;
    calls = newCalls();
    plugin = (await import("../opencode-plugin.ts")).default;
    // ledger:false — the default ledger path is the real user data dir,
    // which tests must never touch.
    hooks = await plugin({ client: makeClient(calls) }, { mode: "block", ledger: false });
  });

  after(async () => {
    delete process.env.DEEPSEEK_PEAK_SCHEDULE;
    delete process.env.DEEPSEEK_PEAK_LEDGER;
    delete process.env.DEEPSEEK_PEAK_MATCH;
    delete process.env.DEEPSEEK_PEAK_WARN_BEFORE;
    await new Promise((resolve) => notifyServer.close(resolve));
    await unlink(tmpLedger).catch(() => {});
  });

  it("logs an activation message on init", () => {
    assert.ok(calls.logs.some((l) => l.service === "deepseek-peak" && /active/.test(l.message)));
    assert.ok(calls.logs.some((l) => /match=endpoint/.test(l.message)));
  });

  it("blocks official-endpoint DeepSeek during peak", async () => {
    await assert.rejects(
      () => hooks["chat.params"](chatInput("sess-deep", "deepseek-chat", "deepseek", OFFICIAL)),
      /official API/,
    );
  });

  it("passes DeepSeek models on a flat-rate proxy", async () => {
    await hooks["chat.params"](chatInput("sess-proxy", "deepseek-v4.1-flash", "neutralbeats-chat", PROXY));
  });

  it("name fallback blocks when the endpoint is unknown", async () => {
    await assert.rejects(
      () => hooks["chat.params"](chatInput("sess-direct", "some-model", "deepseek")),
      /matched by name/,
    );
  });

  it("name fallback passes unknown non-deepseek traffic", async () => {
    await hooks["chat.params"](chatInput("sess-claude", "claude-opus-4-7", "neutralbeats-chat"));
  });

  it("passes when nothing matches and the endpoint is unknown", async () => {
    await hooks["chat.params"](chatInput("sess-empty", "", "x"));
  });

  it("blocks with an empty provider id (label fallback)", async () => {
    await assert.rejects(() => hooks["chat.params"](chatInput("sess-noprov", "deepseek-chat", "")), /\?\/deepseek-chat/);
  });

  it("blocks with an empty model id (label fallback)", async () => {
    await assert.rejects(() => hooks["chat.params"](chatInput("sess-nomodel", "", "deepseek")), /deepseek\/\?/);
  });

  it("explicit endpoint mode matches the default", async () => {
    const c = newCalls();
    await plugin({ client: makeClient(c) }, { ledger: false, matchMode: "endpoint" });
    assert.ok(c.logs.some((l) => /match=endpoint/.test(l.message)));
  });

  it("empty notifyUrl option disables notifications", async () => {
    const c = newCalls();
    await plugin({ client: makeClient(c) }, { ledger: false, notifyUrl: "" });
    assert.ok(c.logs.some((l) => /notify=off/.test(l.message)));
  });

  it("notifyUrl comes from the environment too", async () => {
    await withEnv({ DEEPSEEK_PEAK_NOTIFY_URL: notifyUrl }, async () => {
      const c = newCalls();
      const base = scheduled.length;
      const h = await plugin({ client: makeClient(c, { "sess-env": { type: "busy" } }) }, { ledger: false });
      assert.ok(c.logs.some((l) => /notify=on/.test(l.message)));
      await assert.rejects(
        () => h["chat.params"](chatInput("sess-env", "deepseek-chat", "deepseek", OFFICIAL)),
        /peak hours/,
      );
      await h.event({
        event: { type: "session.status", properties: { sessionID: "sess-env", status: { type: "busy" } } },
      });
      const seen = notified.length;
      await scheduled[base].fn();
      await waitFor(() => notified.length > seen);
      assert.deepEqual(c.aborts, ["sess-env"]);
    });
  });

  it("survives providers that omit info/options (observed live)", async () => {
    // No endpoint info → name fallback blocks deepseek names...
    await assert.rejects(() => hooks["chat.params"](bareChatInput("sess-bare", "deepseek-chat", "deepseek")), /matched by name/);
    // ...and passes everything else.
    await hooks["chat.params"](bareChatInput("sess-bare2", "some-model", "somewhere"));
  });

  it("survives info without a name", async () => {
    const input = chatInput("sess-noname", "deepseek-chat", "deepseek", OFFICIAL);
    input.provider.info = {};
    await assert.rejects(() => hooks["chat.params"](input), /official API/);
  });

  it("warn mode lets requests through with a toast", async () => {
    const warnCalls = newCalls();
    const warnHooks = await plugin({ client: makeClient(warnCalls) }, { mode: "warn", ledger: false });
    await warnHooks["chat.params"](chatInput("sess-warn", "deepseek-chat", "deepseek", OFFICIAL));
    assert.equal(warnCalls.toasts.length, 1);
    assert.match(warnCalls.toasts[0].message, /peak hours/);
  });

  it("warns shortly before the transition", async () => {
    // scheduled: [transition, warn] per plugin instance; [0] and [1] are ours.
    const warnTimer = scheduled[1];
    assert.ok(warnTimer && warnTimer.ms > 1000, "expected an armed transition timer");
    const before = calls.toasts.length;
    await warnTimer.fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.toasts.length, before + 1);
    assert.match(calls.toasts.at(-1).message, /starts in/);
  });

  it("writes blocked requests to the ledger", async () => {
    const ledgerCalls = newCalls();
    const ledgerHooks = await plugin({ client: makeClient(ledgerCalls) }, { ledger: tmpLedger });
    await assert.rejects(
      () => ledgerHooks["chat.params"](chatInput("sess-ledger", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    // chat.params awaits ledger writes, so the event is on disk already.
    const events = await readEvents(tmpLedger);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "blocked");
    assert.equal(events[0].session, "sess-ledger");
    assert.equal(events[0].endpoint, "api.deepseek.com");
    assert.equal(events[0].reason, "endpoint");
  });

  it("POSTs a JSON alert on peak start", async () => {
    const nCalls = newCalls();
    const base = scheduled.length;
    const nHooks = await plugin({ client: makeClient(nCalls, { "sess-notify": { type: "busy" } }) }, { ledger: false, notifyUrl });
    await assert.rejects(
      () => nHooks["chat.params"](chatInput("sess-notify", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    await nHooks.event({
      event: { type: "session.status", properties: { sessionID: "sess-notify", status: { type: "busy" } } },
    });
    await scheduled[base].fn(); // this instance's transition timer
    // notify() is fire-and-forget by design — poll for the HTTP round-trip.
    await waitFor(() => notified.length > 0);
    assert.deepEqual(nCalls.aborts, ["sess-notify"]);
    const body = JSON.parse(notified.at(-1));
    assert.equal(body.service, "deepseek-peak");
    assert.equal(body.event, "peak-start");
    assert.match(body.message, /peak hours started/);
  });

  it("aborts official sessions at peak start, keeps proxies and strangers", async () => {
    // sess-deep: official endpoint, recorded via the block above.
    // sess-proxy: flat-rate proxy, recorded via the pass-through above.
    // sess-claude: unknown endpoint, non-deepseek name.
    // sess-direct: unknown endpoint, deepseek provider name (fallback hit).
    // sess-ghost: never seen (no chat.params) — aborted conservatively.
    for (const id of ["sess-deep", "sess-proxy", "sess-claude", "sess-direct", "sess-ghost"]) {
      await hooks.event({
        event: { type: "session.status", properties: { sessionID: id, status: { type: "busy" } } },
      });
    }
    const armedAtInit = scheduled[0];
    assert.ok(armedAtInit && armedAtInit.ms > 0, "expected an armed transition timer");
    await armedAtInit.fn();
    // The timer callback floats the onTransition() promise (fire-and-forget by
    // design), so flush the microtask queue before asserting on its effects.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls.aborts, ["sess-deep", "sess-direct", "sess-ghost"]);
    assert.ok(calls.toasts.some((t) => /peak hours started/.test(t.message)));
  });

  it("abortAllOnPeak also aborts proxy sessions", async () => {
    const c = newCalls();
    const base = scheduled.length;
    const h = await plugin({ client: makeClient(c) }, { ledger: false, abortAllOnPeak: true });
    await h["chat.params"](chatInput("sess-p", "deepseek-chat", "neutralbeats-chat", PROXY));
    await h.event({
      event: { type: "session.status", properties: { sessionID: "sess-p", status: { type: "busy" } } },
    });
    await scheduled[base].fn();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(c.aborts, ["sess-p"]);
  });

  it("abortOnPeak:false aborts nothing", async () => {
    const c = newCalls();
    const base = scheduled.length;
    const h = await plugin({ client: makeClient(c) }, { ledger: false, abortOnPeak: false });
    await assert.rejects(
      () => h["chat.params"](chatInput("sess-a", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    await h.event({
      event: { type: "session.status", properties: { sessionID: "sess-a", status: { type: "busy" } } },
    });
    await scheduled[base].fn();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(c.aborts, []);
    assert.ok(c.toasts.some((t) => /abort is disabled/.test(t.message)));
  });

  it("counts unabortable sessions as skipped", async () => {
    const c = newCalls();
    const refusing = makeClient(c);
    refusing.session.abort = async () => false;
    const base = scheduled.length;
    const h = await plugin({ client: refusing }, { ledger: false });
    await assert.rejects(
      () => h["chat.params"](chatInput("sess-r", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    await h.event({
      event: { type: "session.status", properties: { sessionID: "sess-r", status: { type: "busy" } } },
    });
    await scheduled[base].fn();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(c.aborts, []);
  });

  it("survives a throwing abort", async () => {
    const c = newCalls();
    const throwing = makeClient(c);
    throwing.session.abort = async () => {
      throw new Error("gone");
    };
    const base = scheduled.length;
    const h = await plugin({ client: throwing }, { ledger: false });
    await assert.rejects(
      () => h["chat.params"](chatInput("sess-t", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    await h.event({
      event: { type: "session.status", properties: { sessionID: "sess-t", status: { type: "busy" } } },
    });
    await scheduled[base].fn();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(c.aborts, []);
  });

  it("tolerates odd session.status payloads", async () => {
    for (const payload of [null, 42]) {
      const c = newCalls();
      const broken = makeClient(c, payload);
      const base = scheduled.length;
      const h = await plugin({ client: broken }, { ledger: false });
      const sid = `sess-odd-${String(payload)}`;
      await assert.rejects(
        () => h["chat.params"](chatInput(sid, "deepseek-chat", "deepseek", OFFICIAL)),
        /peak hours/,
      );
      await h.event({
        event: { type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } },
      });
      await scheduled[base].fn();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(c.aborts, [sid]);
    }
  });

  it("skips null entries in the status map", async () => {
    const c = newCalls();
    const base = scheduled.length;
    const h = await plugin({ client: makeClient(c, { "sess-null": null, "sess-ok": { type: "busy" } }) }, { ledger: false });
    await assert.rejects(
      () => h["chat.params"](chatInput("sess-ok", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    await h.event({
      event: { type: "session.status", properties: { sessionID: "sess-ok", status: { type: "busy" } } },
    });
    await scheduled[base].fn();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(c.aborts, ["sess-ok"]);
  });

  it("falls back to event-tracked sessions when status() throws", async () => {
    const c = newCalls();
    const broken = makeClient(c);
    broken.session.status = async () => {
      throw new Error("down");
    };
    const base = scheduled.length;
    const h = await plugin({ client: broken }, { ledger: false });
    await assert.rejects(
      () => h["chat.params"](chatInput("sess-b", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    await h.event({
      event: { type: "session.status", properties: { sessionID: "sess-b", status: { type: "busy" } } },
    });
    await scheduled[base].fn();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(c.aborts, ["sess-b"]);
  });

  it("survives throwing log and toast sinks", async () => {
    const c = newCalls();
    const noisy = makeClient(c);
    noisy.app.log = async () => {
      throw new Error("no log");
    };
    noisy.tui.showToast = async () => {
      throw new Error("no tui");
    };
    const h = await plugin({ client: noisy }, { ledger: false });
    await assert.rejects(
      () => h["chat.params"](chatInput("sess-n", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
  });

  it("forgets deleted sessions, clears idle ones, ignores the rest", async () => {
    const c = newCalls();
    const base = scheduled.length;
    const h = await plugin({ client: makeClient(c) }, { ledger: false });
    await assert.rejects(
      () => h["chat.params"](chatInput("sess-del", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    await h.event({ event: { type: "session.deleted", properties: { sessionID: "sess-del" } } });
    await h.event({
      event: { type: "session.status", properties: { sessionID: "sess-del", status: { type: "busy" } } },
    });
    await h["chat.params"](chatInput("sess-idle", "deepseek-chat", "deepseek", OFFICIAL)).catch(() => {});
    await h.event({
      event: { type: "session.status", properties: { sessionID: "sess-idle", status: { type: "busy" } } },
    });
    await h.event({
      event: { type: "session.status", properties: { sessionID: "sess-idle", status: { type: "idle" } } },
    });
    await h.event({
      event: { type: "session.status", properties: { sessionID: "sess-nostatus" } },
    });
    await h.event({ event: { type: "session.created", properties: { sessionID: "sess-new" } } });
    await h.event({ event: { type: "file.edited", properties: {} } });
    await scheduled[base].fn();
    await new Promise((r) => setImmediate(r));
    // sess-del was forgotten → aborted as unknown; the idle ones are gone.
    assert.deepEqual(c.aborts, ["sess-del"]);
  });

  it("matchMode name/both also guard the proxy", async () => {
    for (const matchMode of ["name", "both"]) {
      const c = newCalls();
      const h = await plugin({ client: makeClient(c) }, { ledger: false, matchMode });
      await assert.rejects(
        () => h["chat.params"](chatInput(`sess-${matchMode}`, "deepseek-chat", "neutralbeats-chat", PROXY)),
        /peak hours/,
        `mode ${matchMode} should block the proxy`,
      );
    }
  });

  it("invalid matchMode falls back to endpoint", async () => {
    const c = newCalls();
    const h = await plugin({ client: makeClient(c) }, { ledger: false, matchMode: "bogus" });
    await h["chat.params"](chatInput("sess-inv", "deepseek-chat", "neutralbeats-chat", PROXY));
  });

  it("matchMode comes from the environment too", async () => {
    await withEnv({ DEEPSEEK_PEAK_MATCH: "both" }, async () => {
      const c = newCalls();
      const h = await plugin({ client: makeClient(c) }, { ledger: false });
      await assert.rejects(
        () => h["chat.params"](chatInput("sess-env", "deepseek-chat", "neutralbeats-chat", PROXY)),
        /peak hours/,
      );
    });
    await withEnv({ DEEPSEEK_PEAK_MATCH: "bogus" }, async () => {
      const c = newCalls();
      const h = await plugin({ client: makeClient(c) }, { ledger: false });
      await h["chat.params"](chatInput("sess-env2", "deepseek-chat", "neutralbeats-chat", PROXY));
    });
  });

  it("boolean-ish env strings are parsed", async () => {
    await withEnv({ DEEPSEEK_PEAK_ABORT: "0", DEEPSEEK_PEAK_TOAST: "yes" }, async () => {
      const c = newCalls();
      await plugin({ client: makeClient(c) }, { ledger: false });
      assert.ok(c.logs.some((l) => /abortOnPeak=false/.test(l.message)));
    });
    await withEnv({ DEEPSEEK_PEAK_ABORT: "maybe", DEEPSEEK_PEAK_WARN_BEFORE: "soon" }, async () => {
      const c = newCalls();
      await plugin({ client: makeClient(c) }, { ledger: false });
      assert.ok(c.logs.some((l) => /abortOnPeak=true/.test(l.message) && /warnBeforeMin=10/.test(l.message)));
    });
  });

  it("warn timer can be disabled or pushed out of range", async () => {
    for (const warnBeforeMin of [0, -5, 1000000]) {
      const base = scheduled.length;
      await plugin({ client: makeClient(newCalls()) }, { ledger: false, warnBeforeMin });
      assert.equal(scheduled.length, base + 1, `warnBeforeMin=${warnBeforeMin} must arm transition only`);
    }
    const base = scheduled.length;
    await plugin({ client: makeClient(newCalls()) }, { ledger: false, warnBeforeMin: "3" });
    assert.equal(scheduled.length, base + 2, "string warnBeforeMin must arm both timers");
    const b3 = scheduled.length;
    await plugin({ client: makeClient(newCalls()) }, { ledger: false, warnBeforeMin: NaN });
    assert.equal(scheduled.length, b3 + 2, "NaN warnBeforeMin falls back to default");
    await withEnv({ DEEPSEEK_PEAK_WARN_BEFORE: "0" }, async () => {
      const b2 = scheduled.length;
      await plugin({ client: makeClient(newCalls()) }, { ledger: false });
      assert.equal(scheduled.length, b2 + 1, "env warnBeforeMin=0 must arm transition only");
    });
  });

  it("silent mode still blocks", async () => {
    const c = newCalls();
    const h = await plugin({ client: makeClient(c) }, { ledger: false, toast: false, log: false });
    await assert.rejects(
      () => h["chat.params"](chatInput("sess-s", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    assert.deepEqual([c.logs.length, c.toasts.length], [0, 0]);
  });

  it("extra match needles apply", async () => {
    const c = newCalls();
    const h = await plugin(
      { client: makeClient(c) },
      { ledger: false, matchMode: "name", match: ["my-proxy", "", 42] },
    );
    await assert.rejects(() => h["chat.params"](chatInput("sess-m", "llama", "my-proxy", PROXY)), /peak hours/);
  });

  it("disabled plugin returns no hooks", async () => {
    assert.deepEqual(await plugin({ client: makeClient(newCalls()) }, { disabled: true }), {});
  });

  it("works without options (all defaults)", async () => {
    const c = newCalls();
    await plugin({ client: makeClient(c) });
    assert.ok(c.logs.some((l) => /match=endpoint/.test(l.message)));
  });

  it("rejects a broken schedule env", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: "{oops" }, async () => {
      await assert.rejects(() => plugin({ client: makeClient(newCalls()) }, { ledger: false }), /not valid JSON/);
    });
  });

  it("dispose is idempotent", async () => {
    const h = await plugin({ client: makeClient(newCalls()) }, { ledger: false });
    await h.dispose?.();
    await h.dispose?.();
  });
});

describe("opencode plugin (synthetic off-peak window)", () => {
  let plugin;
  let notified = [];
  let notifyUrl;

  before(async () => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        notified.push(body);
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    notifyUrl = `http://127.0.0.1:${srv.address().port}/hook`;
    globalThis.__offpeakSrv = srv;
    plugin = (await import("../opencode-plugin.ts")).default;
  });

  after(async () => {
    await new Promise((resolve) => globalThis.__offpeakSrv.close(resolve));
  });

  it("passes official traffic off-peak and announces the transition", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: offPeakScheduleNow() }, async () => {
      const c = newCalls();
      const base = scheduled.length;
      const h = await plugin({ client: makeClient(c) }, { ledger: false, notifyUrl });
      // Not peak → the request goes through untouched.
      await h["chat.params"](chatInput("sess-off", "deepseek-chat", "deepseek", OFFICIAL));
      assert.ok(c.logs.some((l) => /OFF-PEAK/.test(l.message)));
      // Warn timer points at the upcoming peak start.
      await scheduled[base + 1].fn();
      await new Promise((r) => setImmediate(r));
      assert.ok(c.toasts.some((t) => /peak starts in/.test(t.message)));
      // Firing the transition timer still sees off-peak wall-clock time,
      // so it takes the off-peak branch: toast + ledger + notify.
      await scheduled[base].fn();
      await waitFor(() => notified.length > 0);
      const body = JSON.parse(notified.at(-1));
      assert.equal(body.event, "offpeak-start");
      assert.ok(c.toasts.some((t) => /off-peak started/.test(t.message)));
      // Same transition without notifyUrl: toast only, no HTTP.
      const c2 = newCalls();
      const base2 = scheduled.length;
      const h2 = await plugin({ client: makeClient(c2) }, { ledger: false });
      const seen2 = notified.length;
      await scheduled[base2].fn();
      await new Promise((r) => setImmediate(r));
      assert.ok(c2.toasts.some((t) => /off-peak started/.test(t.message)));
      assert.equal(notified.length, seen2);
    });
  });
});

describe("opencode plugin (sync cache schedules)", () => {
  let plugin;

  const cacheFor = (n) => join(tmpdir(), `deepseek-peak-smoke-cache-${process.pid}-${n}.json`);
  const caches = [cacheFor(1), cacheFor(2), cacheFor(3)];

  before(async () => {
    plugin = (await import("../opencode-plugin.ts")).default;
  });

  after(async () => {
    await Promise.all(caches.map((p) => unlink(p).catch(() => {})));
    delete process.env.DEEPSEEK_PEAK_SCHEDULE;
    delete process.env.DEEPSEEK_PEAK_CACHE;
  });

  async function writeCache(path, obj) {
    await writeFile(path, typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  function peakCacheNow() {
    const now = new Date();
    const h = now.getUTCHours();
    return {
      version: 1,
      sourceUrl: "test",
      fetchedAt: now.toISOString(),
      excerpt: "test",
      schedule: [{ days: [now.getUTCDay()], start: `${pad(h)}:00`, end: `${pad((h + 2) % 24)}:00` }],
    };
  }

  it("uses the sync cache when present", async () => {
    await writeCache(caches[0], peakCacheNow());
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: undefined, DEEPSEEK_PEAK_CACHE: caches[0] }, async () => {
      const c = newCalls();
      const h = await plugin({ client: makeClient(c) }, { ledger: false });
      assert.ok(c.logs.some((l) => /source=cache/.test(l.message)));
      // Cached hours say peak now (regardless of the real schedule) → official blocks.
      await assert.rejects(
        () => h["chat.params"](chatInput("sess-cache", "deepseek-chat", "deepseek", OFFICIAL)),
        /peak hours/,
      );
    });
  });

  it("warns on a stale cache", async () => {
    await writeCache(caches[1], {
      version: 1,
      fetchedAt: "2020-01-01T00:00:00.000Z",
      schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "01:00" }],
    });
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: undefined, DEEPSEEK_PEAK_CACHE: caches[1] }, async () => {
      const c = newCalls();
      await plugin({ client: makeClient(c) }, { ledger: false });
      const warn = c.logs.find((l) => /older than 30 days/.test(l.message));
      assert.ok(warn);
      assert.equal(warn.level, "warn");
    });
  });

  it("warns on a dateless cache (unknown age counts as stale)", async () => {
    await writeCache(caches[2], {
      version: 1,
      schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "01:00" }],
    });
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: undefined, DEEPSEEK_PEAK_CACHE: caches[2] }, async () => {
      const c = newCalls();
      await plugin({ client: makeClient(c) }, { ledger: false });
      assert.ok(c.logs.some((l) => /unknown/.test(l.message)));
    });
  });

  it("warns on an invalid cache and falls back to built-in", async () => {
    await writeCache(caches[2], "junk {{{");
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: undefined, DEEPSEEK_PEAK_CACHE: caches[2] }, async () => {
      const c = newCalls();
      await plugin({ client: makeClient(c) }, { ledger: false });
      assert.ok(c.logs.some((l) => /source=builtin/.test(l.message)));
      assert.ok(c.logs.some((l) => /cache ignored/.test(l.message)));
    });
  });
});
