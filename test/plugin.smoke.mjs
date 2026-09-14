// Smoke test for the opencode plugin (runs without an opencode server).
//
// The plugin reads the real clock, so this test synthesizes a peak window
// around "now" via DEEPSEEK_PEAK_SCHEDULE before importing the plugin:
// a 2-hour window starting at the current UTC hour, on today's weekday.
// That makes the test deterministic no matter when it runs.
//
// Requires Node >= 22.18 (type-stripping for the `.ts` plugin import).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { readEvents } from "../lib/ledger.mjs";

const pad = (n) => String(n).padStart(2, "0");

function synthesizePeakAroundNow() {
  const now = new Date();
  const h = now.getUTCHours();
  process.env.DEEPSEEK_PEAK_SCHEDULE = JSON.stringify([
    { days: [now.getUTCDay()], start: `${pad(h)}:00`, end: `${pad((h + 2) % 24)}:00` },
  ]);
}

// Capture armed timers so we can fire the transition callback manually.
const scheduled = [];
const realSetTimeout = globalThis.setTimeout;

async function waitFor(cond, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => realSetTimeout(r, 25));
  }
}

function makeClient(calls, busySessions = { "sess-deep": { type: "busy" } }) {
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

function chatInput(sessionID, modelID, providerID) {
  return {
    sessionID,
    agent: "build",
    model: { id: modelID, name: modelID, providerID },
    provider: { source: "config", info: { id: providerID, name: providerID }, options: {} },
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
    globalThis.setTimeout = (fn, ms, ...rest) => {
      scheduled.push({ fn, ms });
      const handle = realSetTimeout(() => {}, 2_147_483_647);
      if (typeof handle.unref === "function") handle.unref();
      return handle;
    };
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
    calls = { logs: [], toasts: [], aborts: [] };
    plugin = (await import("../opencode-plugin.ts")).default;
    // ledger:false — the default ledger path is the real user data dir,
    // which tests must never touch.
    hooks = await plugin({ client: makeClient(calls) }, { mode: "block", ledger: false });
  });

  after(async () => {
    globalThis.setTimeout = realSetTimeout;
    delete process.env.DEEPSEEK_PEAK_SCHEDULE;
    delete process.env.DEEPSEEK_PEAK_LEDGER;
    await new Promise((resolve) => notifyServer.close(resolve));
    await unlink(tmpLedger).catch(() => {});
  });

  it("logs an activation message on init", () => {
    assert.ok(calls.logs.some((l) => l.service === "deepseek-peak" && /active/.test(l.message)));
  });

  it("blocks DeepSeek requests during peak (model id match)", async () => {
    await assert.rejects(
      () => hooks["chat.params"](chatInput("sess-deep", "deepseek-v4.1-flash", "neutralbeats-chat")),
      /peak hours/,
    );
  });

  it("blocks on provider id match too", async () => {
    await assert.rejects(
      () => hooks["chat.params"](chatInput("sess-direct", "some-model", "deepseek")),
      /peak hours/,
    );
  });

  it("lets non-DeepSeek requests through", async () => {
    await hooks["chat.params"](chatInput("sess-claude", "claude-opus-4-7", "neutralbeats-chat"));
  });

  it("warn mode lets requests through with a toast", async () => {
    const warnCalls = { logs: [], toasts: [], aborts: [] };
    const warnHooks = await plugin({ client: makeClient(warnCalls) }, { mode: "warn", ledger: false });
    await warnHooks["chat.params"](chatInput("sess-warn", "deepseek-chat", "deepseek"));
    assert.equal(warnCalls.toasts.length, 1);
    assert.match(warnCalls.toasts[0].message, /peak hours/);
  });

  it("warns shortly before the transition", async () => {
    // scheduled: [transition, warn] per plugin instance; [0] and [1] are ours.
    const warnTimer = scheduled[1];
    assert.ok(warnTimer && warnTimer.ms > 1000, "expected an armed warn timer");
    const before = calls.toasts.length;
    await warnTimer.fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.toasts.length, before + 1);
    assert.match(calls.toasts.at(-1).message, /starts in/);
  });

  it("writes blocked requests to the ledger", async () => {
    const ledgerCalls = { logs: [], toasts: [], aborts: [] };
    const ledgerHooks = await plugin({ client: makeClient(ledgerCalls) }, { ledger: tmpLedger });
    await assert.rejects(
      () => ledgerHooks["chat.params"](chatInput("sess-ledger", "deepseek-chat", "deepseek")),
      /peak hours/,
    );
    // chat.params awaits ledger writes, so the event is on disk already.
    const events = await readEvents(tmpLedger);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "blocked");
    assert.equal(events[0].session, "sess-ledger");
    assert.match(events[0].model, /deepseek/);
  });

  it("POSTs a JSON alert on peak start", async () => {
    const nCalls = { logs: [], toasts: [], aborts: [] };
    const base = scheduled.length;
    const nHooks = await plugin(
      { client: makeClient(nCalls, { "sess-notify": { type: "busy" } }) },
      { ledger: false, notifyUrl },
    );
    await assert.rejects(
      () => nHooks["chat.params"](chatInput("sess-notify", "deepseek-chat", "deepseek")),
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

  it("aborts busy DeepSeek sessions when peak begins, keeps others", async () => {
    // Both sessions are "busy"; only sess-deep used a DeepSeek model.
    // (chat.params calls above already recorded their models.)
    await hooks.event({
      event: { type: "session.status", properties: { sessionID: "sess-deep", status: { type: "busy" } } },
    });
    await hooks.event({
      event: { type: "session.status", properties: { sessionID: "sess-claude", status: { type: "busy" } } },
    });
    const armedAtInit = scheduled[0];
    assert.ok(armedAtInit && armedAtInit.ms > 0, "expected an armed transition timer");
    await armedAtInit.fn();
    // The timer callback floats the onTransition() promise (fire-and-forget by
    // design), so flush the microtask queue before asserting on its effects.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls.aborts, ["sess-deep"]);
    assert.ok(calls.toasts.some((t) => /peak hours started/.test(t.message)));
  });
});
