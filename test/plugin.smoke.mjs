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

function makeClient(calls) {
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
      status: async () => ({ "sess-deep": { type: "busy" } }),
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

describe("opencode plugin (synthetic peak window)", () => {
  let plugin;
  let hooks;
  let calls;

  before(async () => {
    synthesizePeakAroundNow();
    globalThis.setTimeout = (fn, ms, ...rest) => {
      scheduled.push({ fn, ms });
      const handle = realSetTimeout(() => {}, 2_147_483_647);
      if (typeof handle.unref === "function") handle.unref();
      return handle;
    };
    calls = { logs: [], toasts: [], aborts: [] };
    plugin = (await import("../opencode-plugin.ts")).default;
    hooks = await plugin({ client: makeClient(calls) }, { mode: "block" });
  });

  after(() => {
    globalThis.setTimeout = realSetTimeout;
    delete process.env.DEEPSEEK_PEAK_SCHEDULE;
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
    const warnHooks = await plugin({ client: makeClient(warnCalls) }, { mode: "warn" });
    await warnHooks["chat.params"](chatInput("sess-warn", "deepseek-chat", "deepseek"));
    assert.equal(warnCalls.toasts.length, 1);
    assert.match(warnCalls.toasts[0].message, /peak hours/);
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
