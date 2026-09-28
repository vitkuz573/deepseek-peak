// Smoke test for the opencode server plugin (runs without an opencode server).
//
// The plugin reads the real clock, so most tests synthesize a peak window
// around "now" via DEEPSEEK_PEAK_SCHEDULE before importing the plugin:
// a 2-hour window starting at the current UTC hour, on today's weekday.
// That makes the tests deterministic no matter when they run.
// A dedicated off-peak-schedule section covers the off-peak paths.
//
// The plugin is driven through its real V2 surface — Plugin.define, setup(ctx),
// ctx.session.hook, ctx.event.subscribe, ctx.rpc — with a fake context, so the
// guard, the abort-on-transition path and every channel (alerts, ledger,
// webhook) are exercised exactly as OpenCode would call them.
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

/** Poll an async predicate — used for ledger writes, which land on the I/O queue. */
async function waitForAsync(fn, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => realSetTimeout(r, 25));
  }
}

/** Let queued microtasks and immediates settle. */
const flush = () => new Promise((r) => setImmediate(r));

/**
 * A webhook receiver for the notify tests. Connections are closed per response
 * on purpose: the suite runs longer than the default keep-alive timeout, and a
 * pooled socket that the server closes mid-suite makes undici's reuse racy.
 */
function webhookServer(onBody) {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      onBody(body);
      res.writeHead(200, { "content-type": "text/plain", connection: "close" });
      res.end("ok");
    });
  });
}

// The catalog the fake server exposes. Mirrors the V2 shapes: providers carry
// settings.baseURL, models carry a display name and no api.url.
const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", settings: { baseURL: OFFICIAL } },
  { id: "neutralbeats-chat", name: "NeutralBeats Chat", settings: { baseURL: PROXY } },
  { id: "my-proxy", name: "My Proxy", settings: {} },
  { id: "bare", name: "", settings: {} },
  { id: "deepseek-mirror", name: "DeepSeek Mirror", settings: {} },
];
const MODELS = [
  { id: "deepseek-chat", providerID: "deepseek", name: "DeepSeek Chat" },
  { id: "deepseek-flash", providerID: "deepseek", name: "DeepSeek Flash" },
  { id: "deepseek-v4.1-flash", providerID: "neutralbeats-chat", name: "DeepSeek V4.1 Flash" },
  { id: "claude-haiku", providerID: "neutralbeats-chat", name: "Claude Haiku" },
  { id: "llama", providerID: "my-proxy", name: "Llama" },
  { id: "mystery", providerID: "bare", name: "Mystery Model" },
  { id: "gpt-mirror", providerID: "deepseek-mirror", name: "GPT Mirror" },
];

/**
 * A fake V2 plugin context. `hooks` holds the registered session hooks, and
 * `send` delivers events into the live subscription the plugin opened.
 */
function makeCtx({
  options = {},
  providers = PROVIDERS,
  models = MODELS,
  interrupt,
  emitFails = false,
  listFails = false,
} = {}) {
  const calls = { alerts: [], interrupts: [], disposals: 0, hooks: [] };
  const hooks = new Map();
  let waiting = null;

  const stream = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        if (listFails === "stream") reject(new Error("stream down"));
      });
    },
    return() {
      return Promise.resolve({ done: true, value: undefined });
    },
  };

  const ctx = {
    options,
    app: { name: "cli", version: "2.0.16", channel: "latest" },
    location: { directory: "/tmp/project", project: { id: "p", directory: "/tmp/project", canonical: "/tmp/project" } },
    rpc: {
      async register() {
        return {
          events: {
            emit: async (name, data) => {
              if (emitFails) throw new Error("no client attached");
              calls.alerts.push({ name, data });
            },
          },
          dispose: async () => {
            calls.disposals++;
          },
        };
      },
    },
    model: {
      list: async () => {
        if (listFails === "models") throw new Error("catalog down");
        return { data: models };
      },
    },
    provider: {
      list: async () => {
        if (listFails === "providers") throw new Error("catalog down");
        return { data: providers };
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks.set(name, callback);
        calls.hooks.push(name);
        return { dispose: async () => hooks.delete(name) };
      },
      interrupt:
        interrupt ??
        (async ({ sessionID }) => {
          calls.interrupts.push(sessionID);
          return { interrupted: true };
        }),
    },
    event: {
      subscribe: ({ signal } = {}) => {
        signal?.addEventListener("abort", () => {
          const w = waiting;
          waiting = null;
          w?.resolve({ done: true, value: undefined });
        });
        return stream;
      },
    },
  };

  /** Deliver one event and let the plugin's consumer loop pick it up. */
  const send = async (event) => {
    const w = waiting;
    if (!w) throw new Error("plugin is not subscribed to the event stream");
    waiting = null;
    w.resolve({ value: event, done: false });
    await flush();
  };

  /** Fire the registered model.request hook exactly as the server would. */
  const request = (input) => hooks.get("model.request")(input);

  return { ctx, calls, send, request, hooks };
}

/** A model.request hook event as OpenCode delivers it. */
function modelRequest(sessionID, modelID, providerID, baseURL, kind = "primary") {
  return {
    sessionID,
    agent: "build",
    model: { id: modelID, providerID, variant: "default" },
    kind,
    ...(baseURL === undefined ? {} : { baseURL }),
    headers: {},
  };
}

const exec = (type, sessionID) => ({ type, data: { sessionID } });

const tmpLedger = join(tmpdir(), `deepseek-peak-plugin-test-${process.pid}.jsonl`);

describe("opencode plugin (synthetic peak window)", () => {
  let plugin;
  let harness;
  let notifyServer;
  let notifyUrl;
  let notified = [];

  before(async () => {
    synthesizePeakAroundNow();
    notified = [];
    notifyServer = webhookServer((body) => notified.push(body));
    await new Promise((resolve) => notifyServer.listen(0, "127.0.0.1", resolve));
    notifyUrl = `http://127.0.0.1:${notifyServer.address().port}/hook`;
    plugin = (await import("../index.ts")).default;
    // ledger:false — the default ledger path is the real user data dir,
    // which tests must never touch.
    harness = makeCtx({ options: { mode: "block", ledger: false } });
    await plugin.setup(harness.ctx);
  });

  after(async () => {
    delete process.env.DEEPSEEK_PEAK_SCHEDULE;
    delete process.env.DEEPSEEK_PEAK_LEDGER;
    delete process.env.DEEPSEEK_PEAK_MATCH;
    delete process.env.DEEPSEEK_PEAK_WARN_BEFORE;
    await new Promise((resolve) => notifyServer.close(resolve));
    await unlink(tmpLedger).catch(() => {});
  });

  it("registers the model.request guard and publishes the activation notice", async () => {
    assert.ok(harness.calls.hooks.includes("model.request"));
    const withLedger = makeCtx({ options: { ledger: tmpLedger } });
    await plugin.setup(withLedger.ctx);
    const events = await readEvents(tmpLedger);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "notice");
    assert.match(events[0].notice, /deepseek-peak active/);
    assert.match(events[0].notice, /match=endpoint/);
    await unlink(tmpLedger).catch(() => {});
  });

  it("blocks official-endpoint DeepSeek during peak", async () => {
    await assert.rejects(
      () => harness.request(modelRequest("sess-deep", "deepseek-chat", "deepseek", OFFICIAL)),
      /official API/,
    );
  });

  it("blocks when the endpoint comes from the provider catalog", async () => {
    // No baseURL on the hook event: the catalog entry supplies the endpoint.
    await assert.rejects(
      () => harness.request(modelRequest("sess-catalog", "deepseek-flash", "deepseek", undefined)),
      /official API/,
    );
  });

  it("reads provider and model display names from the catalog", async () => {
    // "mystery"/"bare" is neither DeepSeek nor on a known proxy, but the
    // provider is named "My DeepSeek Mirror" once the catalog is refreshed.
    const h = makeCtx({
      options: { ledger: false },
      providers: [{ id: "bare", name: "My DeepSeek Mirror", settings: {} }],
    });
    await plugin.setup(h.ctx);
    await assert.rejects(
      () => h.request(modelRequest("sess-flatname", "mystery", "bare", undefined)),
      /matched by name/,
    );
  });

  it("passes DeepSeek models on a flat-rate proxy", async () => {
    await harness.request(modelRequest("sess-proxy", "deepseek-v4.1-flash", "neutralbeats-chat", PROXY));
    await harness.request(modelRequest("sess-proxy2", "deepseek-v4.1-flash", "neutralbeats-chat"));
  });

  it("name fallback blocks when the endpoint is unknown", async () => {
    // No baseURL on the hook event and none in the catalog: the provider id
    // and name carry the DeepSeek signal, so the name rule decides.
    await assert.rejects(
      () => harness.request(modelRequest("sess-direct", "gpt-mirror", "deepseek-mirror", undefined)),
      /matched by name/,
    );
  });

  it("name fallback passes unknown non-deepseek traffic", async () => {
    const h = makeCtx({ options: { ledger: false } });
    await plugin.setup(h.ctx);
    await h.request(modelRequest("sess-claude", "claude-haiku", "neutralbeats-chat", undefined));
    await h.request(modelRequest("sess-empty", "", "x", undefined));
  });

  it("blocks with an empty provider id (label fallback)", async () => {
    await assert.rejects(
      () => harness.request(modelRequest("sess-noprov", "deepseek-chat", "", OFFICIAL)),
      /\?\/deepseek-chat/,
    );
  });

  it("blocks with an empty model id (label fallback)", async () => {
    await assert.rejects(
      () => harness.request(modelRequest("sess-nomodel", "", "deepseek")),
      /deepseek\/\?/,
    );
  });

  it("names the request kind for non-primary calls", async () => {
    await assert.rejects(
      () => harness.request(modelRequest("sess-title", "deepseek-chat", "deepseek", OFFICIAL, "title")),
      /title request blocked/,
    );
    await assert.rejects(
      () => harness.request(modelRequest("sess-compact", "deepseek-chat", "deepseek", OFFICIAL, "compaction")),
      /compaction request blocked/,
    );
  });

  it("publishes an alert for every block", async () => {
    const h = makeCtx({ options: { ledger: false } });
    await plugin.setup(h.ctx);
    await assert.rejects(
      () => h.request(modelRequest("sess-alert", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    assert.equal(h.calls.alerts.length, 1);
    assert.equal(h.calls.alerts[0].name, "alert");
    assert.equal(h.calls.alerts[0].data.kind, "blocked");
    assert.equal(h.calls.alerts[0].data.variant, "error");
    assert.match(h.calls.alerts[0].data.title, /DeepSeek peak hours/);
  });

  it("warn mode lets requests through with a warning alert", async () => {
    const h = makeCtx({ options: { mode: "warn", ledger: false } });
    await plugin.setup(h.ctx);
    await h.request(modelRequest("sess-warn", "deepseek-chat", "deepseek", OFFICIAL));
    assert.equal(h.calls.alerts.length, 1);
    assert.equal(h.calls.alerts[0].data.kind, "allowed-warn");
    assert.equal(h.calls.alerts[0].data.variant, "warning");
    assert.match(h.calls.alerts[0].data.message, /2x off-peak rates/);
  });

  it("survives a failing alert channel", async () => {
    const h = makeCtx({ options: { ledger: false }, emitFails: true });
    await plugin.setup(h.ctx);
    await assert.rejects(
      () => h.request(modelRequest("sess-nochan", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
  });

  it("writes blocked requests to the ledger", async () => {
    const h = makeCtx({ options: { ledger: tmpLedger } });
    await plugin.setup(h.ctx);
    await unlink(tmpLedger).catch(() => {});
    await assert.rejects(
      () => h.request(modelRequest("sess-ledger", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    // The hook awaits ledger writes, so the event is on disk already.
    const events = await readEvents(tmpLedger);
    const blocked = events.filter((e) => e.type === "blocked");
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].session, "sess-ledger");
    assert.equal(blocked[0].endpoint, "api.deepseek.com");
    assert.equal(blocked[0].reason, "endpoint");
    await unlink(tmpLedger).catch(() => {});
  });

  it("warns shortly before the transition", async () => {
    // scheduled: [transition, warn] per plugin instance; [0] and [1] are ours.
    const warnTimer = scheduled[1];
    assert.ok(warnTimer && warnTimer.ms > 1000, "expected an armed transition timer");
    const before = harness.calls.alerts.length;
    await warnTimer.fn();
    await flush();
    assert.equal(harness.calls.alerts.length, before + 1);
    assert.equal(harness.calls.alerts.at(-1).data.kind, "warn");
    assert.match(harness.calls.alerts.at(-1).data.message, /starts in/);
  });

  it("POSTs a JSON alert on peak start and interrupts official sessions", async () => {
    const h = makeCtx({
      options: { ledger: false, notifyUrl },
      interrupt: async ({ sessionID }) => {
        h.calls.interrupts.push(sessionID);
        return { interrupted: true };
      },
    });
    const base = scheduled.length;
    await plugin.setup(h.ctx);
    await assert.rejects(
      () => h.request(modelRequest("sess-notify", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    await h.send(exec("session.execution.started", "sess-notify"));
    await scheduled[base].fn();
    await flush();
    // notify() is fire-and-forget by design — poll for the HTTP round-trip.
    await waitFor(() => notified.length > 0);
    assert.deepEqual(h.calls.interrupts, ["sess-notify"]);
    const body = JSON.parse(notified.at(-1));
    assert.equal(body.service, "deepseek-peak");
    assert.equal(body.event, "peak-start");
    assert.match(body.message, /peak hours started/);
    assert.equal(h.calls.alerts.at(-1).data.kind, "peak-start");
  });

  it("interrupts official sessions at peak start, keeps proxies and strangers", async () => {
    // sess-deep: official endpoint, recorded by the block above.
    // sess-proxy: flat-rate proxy, recorded by the pass-through above.
    // sess-ghost: never seen (no model.request) — interrupted conservatively.
    for (const id of ["sess-deep", "sess-proxy", "sess-ghost"]) {
      await harness.send(exec("session.execution.started", id));
    }
    const armedAtInit = scheduled[0];
    assert.ok(armedAtInit && armedAtInit.ms > 0, "expected an armed transition timer");
    await armedAtInit.fn();
    await flush();
    assert.deepEqual(harness.calls.interrupts, ["sess-deep", "sess-ghost"]);
    assert.ok(harness.calls.alerts.some((a) => /peak hours started/.test(a.data.message)));
  });

  it("abortAllOnPeak also interrupts proxy sessions", async () => {
    const h = makeCtx({ options: { ledger: false, abortAllOnPeak: true } });
    const base = scheduled.length;
    await plugin.setup(h.ctx);
    await h.request(modelRequest("sess-p", "deepseek-chat", "neutralbeats-chat", PROXY));
    await h.send(exec("session.execution.started", "sess-p"));
    await scheduled[base].fn();
    await flush();
    assert.deepEqual(h.calls.interrupts, ["sess-p"]);
  });

  it("abortOnPeak:false interrupts nothing", async () => {
    const h = makeCtx({ options: { ledger: false, abortOnPeak: false } });
    const base = scheduled.length;
    await plugin.setup(h.ctx);
    await assert.rejects(
      () => h.request(modelRequest("sess-a", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    await h.send(exec("session.execution.started", "sess-a"));
    await scheduled[base].fn();
    await flush();
    assert.deepEqual(h.calls.interrupts, []);
    assert.ok(h.calls.alerts.some((a) => /abort is disabled/.test(a.data.message)));
  });

  it("counts sessions that could not be interrupted as skipped", async () => {
    for (const [label, impl] of [
      ["already finished", async () => ({ interrupted: false })],
      ["no verdict at all", async () => undefined],
      ["server error", async () => {
        throw new Error("gone");
      }],
    ]) {
      const h = makeCtx({
        options: { ledger: false },
        interrupt: async ({ sessionID }) => {
          h.calls.interrupts.push(sessionID);
          return impl();
        },
      });
      const base = scheduled.length;
      await plugin.setup(h.ctx);
      await assert.rejects(
        () => h.request(modelRequest("sess-r", "deepseek-chat", "deepseek", OFFICIAL)),
        /peak hours/,
      );
      await h.send(exec("session.execution.started", "sess-r"));
      await scheduled[base].fn();
      await flush();
      assert.deepEqual(h.calls.interrupts, ["sess-r"], label);
      assert.ok(
        h.calls.alerts.some((a) => new RegExp(`left 1 other session`).test(a.data.message)),
        `${label}: skipped sessions must be reported`,
      );
    }
  });

  it("writes interrupted sessions to the ledger", async () => {
    const h = makeCtx({ options: { ledger: tmpLedger } });
    const base = scheduled.length;
    await plugin.setup(h.ctx);
    await unlink(tmpLedger).catch(() => {});
    await h.request(modelRequest("sess-ledger-abort", "deepseek-chat", "deepseek", OFFICIAL)).catch(() => {});
    await h.send(exec("session.execution.started", "sess-ledger-abort"));
    await scheduled[base].fn();
    const aborted = await waitForAsync(async () => {
      const found = (await readEvents(tmpLedger)).filter((e) => e.type === "aborted");
      return found.length ? found : undefined;
    });
    assert.equal(aborted.length, 1);
    assert.equal(aborted[0].session, "sess-ledger-abort");
    assert.equal(aborted[0].model, "deepseek/deepseek-chat");
    assert.equal(aborted[0].endpoint, "api.deepseek.com");
    const peak = (await readEvents(tmpLedger)).filter((e) => e.type === "peak-start");
    assert.equal(peak.length, 1);
    assert.equal(peak[0].aborted, 1);
    await unlink(tmpLedger).catch(() => {});
  });

  it("records the endpoint as unknown when a guarded session has none", async () => {
    // Guarded by name, so it is interrupted, but nothing knows its endpoint.
    const h = makeCtx({ options: { ledger: tmpLedger } });
    const base = scheduled.length;
    await plugin.setup(h.ctx);
    await unlink(tmpLedger).catch(() => {});
    await h.request(modelRequest("sess-noep", "gpt-mirror", "deepseek-mirror", undefined)).catch(() => {});
    await h.send(exec("session.execution.started", "sess-noep"));
    await scheduled[base].fn();
    const aborted = await waitForAsync(async () => {
      const found = (await readEvents(tmpLedger)).filter((e) => e.type === "aborted");
      return found.length ? found : undefined;
    });
    assert.equal(aborted[0].model, "deepseek-mirror/gpt-mirror");
    assert.equal(aborted[0].endpoint, "unknown");
    await unlink(tmpLedger).catch(() => {});
  });

  it("records aborted sessions with an unknown model when the session was never seen", async () => {
    const h = makeCtx({ options: { ledger: tmpLedger } });
    const base = scheduled.length;
    await plugin.setup(h.ctx);
    await unlink(tmpLedger).catch(() => {});
    await h.send(exec("session.execution.started", "sess-unknown"));
    await scheduled[base].fn();
    const aborted = await waitForAsync(async () => {
      const found = (await readEvents(tmpLedger)).filter((e) => e.type === "aborted");
      return found.length ? found : undefined;
    });
    assert.equal(aborted[0].model, "unknown");
    assert.equal(aborted[0].endpoint, "unknown");
    await unlink(tmpLedger).catch(() => {});
  });

  it("tracks liveness from the execution event stream", async () => {
    const h = makeCtx({ options: { ledger: false } });
    const base = scheduled.length;
    await plugin.setup(h.ctx);
    const sid = "sess-life";
    await h.request(modelRequest(sid, "deepseek-chat", "deepseek", OFFICIAL)).catch(() => {});
    // Non-busy events must not enqueue the session.
    await h.send(exec("session.created", sid));
    await h.send(exec("session.idle", sid));
    await h.send(exec("session.execution.succeeded", sid));
    await h.send(exec("session.execution.failed", sid));
    await h.send(exec("session.execution.interrupted", sid));
    // Deleting forgets the recorded endpoint, so the next pass treats it as
    // unknown and interrupts it conservatively.
    await h.send(exec("session.deleted", sid));
    await h.send(exec("session.execution.started", sid));
    await scheduled[base].fn();
    await flush();
    assert.deepEqual(h.calls.interrupts, [sid]);
  });

  it("keeps the catalog fresh when the server reports a change", async () => {
    const providers = [{ id: "bare", name: "", settings: {} }];
    const h = makeCtx({ options: { ledger: false }, providers, models: [] });
    await plugin.setup(h.ctx);
    // First pass: the name is not DeepSeek yet, so the request passes.
    await h.request(modelRequest("sess-cat", "mystery", "bare", undefined));
    // The catalog changes and the server says so.
    providers[0].name = "DeepSeek Mirror";
    await h.send({ type: "model.updated", data: {} });
    await assert.rejects(
      () => h.request(modelRequest("sess-cat", "mystery", "bare", undefined)),
      /matched by name/,
    );
    // provider.updated invalidates the same cache.
    providers[0].name = "";
    await h.send({ type: "provider.updated", data: {} });
    await h.request(modelRequest("sess-cat", "mystery", "bare", undefined));
  });

  it("ignores events it does not act on and survives a broken stream", async () => {
    const h = makeCtx({ options: { ledger: false }, listFails: "stream" });
    await plugin.setup(h.ctx);
    // setup must not hang on an immediately failing subscription.
    await h.request(modelRequest("sess-broken", "deepseek-chat", "deepseek", OFFICIAL)).catch(() => {});
  });

  it("matchMode name/both also guard the proxy", async () => {
    for (const matchMode of ["name", "both"]) {
      const h = makeCtx({ options: { ledger: false, matchMode } });
      await plugin.setup(h.ctx);
      await assert.rejects(
        () => h.request(modelRequest(`sess-${matchMode}`, "deepseek-chat", "neutralbeats-chat", PROXY)),
        /peak hours/,
        `mode ${matchMode} should block the proxy`,
      );
    }
  });

  it("invalid matchMode falls back to endpoint", async () => {
    const h = makeCtx({ options: { ledger: false, matchMode: "bogus" } });
    await plugin.setup(h.ctx);
    await h.request(modelRequest("sess-inv", "deepseek-chat", "neutralbeats-chat", PROXY));
  });

  it("matchMode and notifyUrl come from the environment too", async () => {
    await withEnv({ DEEPSEEK_PEAK_MATCH: "both", DEEPSEEK_PEAK_NOTIFY_URL: notifyUrl }, async () => {
      const h = makeCtx({ options: { ledger: false } });
      const base = scheduled.length;
      await plugin.setup(h.ctx);
      // DEEPSEEK_PEAK_MATCH=both must guard the proxy like the config option.
      await assert.rejects(
        () => h.request(modelRequest("sess-env", "deepseek-chat", "neutralbeats-chat", PROXY)),
        /peak hours/,
      );
      await h.send(exec("session.execution.started", "sess-env"));
      await scheduled[base].fn();
      await flush();
      assert.deepEqual(h.calls.interrupts, ["sess-env"], "transition must interrupt the guarded session");
      assert.ok(
        h.calls.alerts.some((a) => a.data.kind === "peak-start"),
        "transition must publish a peak-start alert",
      );
      await waitFor(() => notified.length > 1);
    });
    await withEnv({ DEEPSEEK_PEAK_MATCH: "bogus" }, async () => {
      const h = makeCtx({ options: { ledger: false } });
      await plugin.setup(h.ctx);
      await h.request(modelRequest("sess-env2", "deepseek-chat", "neutralbeats-chat", PROXY));
    });
  });

  it("empty notifyUrl disables notifications", async () => {
    const h = makeCtx({ options: { ledger: tmpLedger, notifyUrl: "" } });
    await unlink(tmpLedger).catch(() => {});
    await plugin.setup(h.ctx);
    const events = await readEvents(tmpLedger);
    assert.match(events[0].notice, /notify=off/);
    await unlink(tmpLedger).catch(() => {});
  });

  it("boolean-ish env strings are parsed", async () => {
    await withEnv({ DEEPSEEK_PEAK_ABORT: "0", DEEPSEEK_PEAK_WARN_BEFORE: "0" }, async () => {
      const h = makeCtx({ options: { ledger: tmpLedger } });
      const base = scheduled.length;
      await unlink(tmpLedger).catch(() => {});
      await plugin.setup(h.ctx);
      const events = await readEvents(tmpLedger);
      assert.match(events[0].notice, /abortOnPeak=false/);
      assert.equal(scheduled.length, base + 1, "warnBeforeMin=0 must arm the transition timer only");
      await unlink(tmpLedger).catch(() => {});
    });
    await withEnv({ DEEPSEEK_PEAK_ABORT: "maybe", DEEPSEEK_PEAK_WARN_BEFORE: "soon" }, async () => {
      const h = makeCtx({ options: { ledger: tmpLedger } });
      await unlink(tmpLedger).catch(() => {});
      await plugin.setup(h.ctx);
      const events = await readEvents(tmpLedger);
      assert.match(events[0].notice, /abortOnPeak=true/);
      assert.match(events[0].notice, /warnBeforeMin=10/);
      await unlink(tmpLedger).catch(() => {});
    });
  });

  it("warn timer can be disabled or pushed out of range", async () => {
    for (const warnBeforeMin of [0, -5, 1000000]) {
      const base = scheduled.length;
      const h = makeCtx({ options: { ledger: false, warnBeforeMin } });
      await plugin.setup(h.ctx);
      assert.equal(scheduled.length, base + 1, `warnBeforeMin=${warnBeforeMin} must arm transition only`);
    }
    const base = scheduled.length;
    await plugin.setup(makeCtx({ options: { ledger: false, warnBeforeMin: "3" } }).ctx);
    assert.equal(scheduled.length, base + 2, "string warnBeforeMin must arm both timers");
    const b3 = scheduled.length;
    await plugin.setup(makeCtx({ options: { ledger: false, warnBeforeMin: NaN } }).ctx);
    assert.equal(scheduled.length, b3 + 2, "NaN warnBeforeMin falls back to default");
  });

  it("log:false silences the ledger without weakening the guard", async () => {
    // `toast` is a presentation switch honoured by the TUI half, so the server
    // keeps publishing alerts; `log:false` stops the plugin writing diagnostics.
    const h = makeCtx({ options: { ledger: tmpLedger, toast: false, log: false } });
    await unlink(tmpLedger).catch(() => {});
    await plugin.setup(h.ctx);
    await assert.rejects(
      () => h.request(modelRequest("sess-s", "deepseek-chat", "deepseek", OFFICIAL)),
      /peak hours/,
    );
    assert.equal(h.calls.alerts.length, 1, "alerts are published regardless of the toast switch");
    const events = await readEvents(tmpLedger);
    assert.deepEqual(
      events.filter((e) => e.type === "notice"),
      [],
      "log:false must not write diagnostics",
    );
    assert.equal(
      events.filter((e) => e.type === "blocked").length,
      1,
      "the block itself stays in the audit ledger regardless of log",
    );
  });

  it("extra match needles apply", async () => {
    const h = makeCtx({
      options: { ledger: false, matchMode: "name", match: ["my-proxy", "", 42] },
    });
    await plugin.setup(h.ctx);
    await assert.rejects(
      () => h.request(modelRequest("sess-m", "llama", "my-proxy", PROXY)),
      /peak hours/,
    );
  });

  it("disabled plugin registers nothing", async () => {
    const h = makeCtx({ options: { disabled: true } });
    assert.equal(await plugin.setup(h.ctx), undefined);
    assert.deepEqual(h.calls.hooks, []);
  });

  it("works without options (all defaults)", async () => {
    const h = makeCtx({ options: { ledger: tmpLedger } });
    await unlink(tmpLedger).catch(() => {});
    await plugin.setup(h.ctx);
    const events = await readEvents(tmpLedger);
    assert.match(events[0].notice, /match=endpoint/);
    assert.match(events[0].notice, /abortOnPeak=true/);
    assert.match(events[0].notice, /OFF-PEAK|PEAK/);
    await unlink(tmpLedger).catch(() => {});
  });

  it("rejects a broken schedule env", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: "{oops" }, async () => {
      await assert.rejects(() => plugin.setup(makeCtx({ options: { ledger: false } }).ctx), /not valid JSON/);
    });
  });

  it("releases timers, the subscription and the rpc registration on cleanup", async () => {
    const h = makeCtx({ options: { ledger: false } });
    const cleanup = await plugin.setup(h.ctx);
    assert.equal(typeof cleanup, "function");
    await cleanup();
    await cleanup(); // idempotent
    assert.equal(h.calls.disposals, 2);
    assert.deepEqual(h.calls.interrupts, []);
  });

  it("re-arms cleanly when no heads-up timer is configured", async () => {
    const h = makeCtx({ options: { ledger: false, warnBeforeMin: 0 } });
    await plugin.setup(h.ctx);
    // Repeated requests re-arm the transition timer; with warnBeforeMin=0
    // there is never a heads-up timer to clear.
    for (const id of ["sess-a", "sess-b", "sess-c"]) {
      await h.request(modelRequest(id, "claude-haiku", "neutralbeats-chat", PROXY));
    }
    const cleanup = await plugin.setup(makeCtx({ options: { ledger: false, warnBeforeMin: 0 } }).ctx);
    await cleanup();
  });
});

describe("opencode plugin (synthetic off-peak window)", () => {
  let plugin;
  let notified = [];
  let notifyUrl;

  before(async () => {
    const srv = webhookServer((body) => notified.push(body));
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    notifyUrl = `http://127.0.0.1:${srv.address().port}/hook`;
    globalThis.__offpeakSrv = srv;
    plugin = (await import("../index.ts")).default;
  });

  after(async () => {
    await new Promise((resolve) => globalThis.__offpeakSrv.close(resolve));
  });

  it("passes official traffic off-peak and announces the transition", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: offPeakScheduleNow() }, async () => {
      const h = makeCtx({ options: { ledger: false, notifyUrl } });
      const base = scheduled.length;
      await plugin.setup(h.ctx);
      // Not peak → the request goes through untouched.
      await h.request(modelRequest("sess-off", "deepseek-chat", "deepseek", OFFICIAL));
      // Warn timer points at the upcoming peak start.
      await scheduled[base + 1].fn();
      await flush();
      assert.ok(h.calls.alerts.some((a) => /peak starts in/.test(a.data.message)));
      // Firing the transition timer still sees off-peak wall-clock time,
      // so it takes the off-peak branch: alert + ledger + notify.
      await scheduled[base].fn();
      await flush();
      await waitFor(() => notified.length > 0);
      const body = JSON.parse(notified.at(-1));
      assert.equal(body.event, "offpeak-start");
      assert.ok(h.calls.alerts.some((a) => /off-peak started/.test(a.data.message)));
      // Same transition without notifyUrl: alert only, no HTTP.
      const h2 = makeCtx({ options: { ledger: false } });
      const base2 = scheduled.length;
      await plugin.setup(h2.ctx);
      const seen2 = notified.length;
      await scheduled[base2].fn();
      await flush();
      assert.ok(h2.calls.alerts.some((a) => /off-peak started/.test(a.data.message)));
      assert.equal(notified.length, seen2);
    });
  });

  it("warns about an upcoming off-peak window", async () => {
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: offPeakScheduleNow() }, async () => {
      const h = makeCtx({ options: { ledger: false } });
      const base = scheduled.length;
      await plugin.setup(h.ctx);
      // Re-arm so the heads-up points at the peak window, not at "now".
      await h.request(modelRequest("sess-off2", "deepseek-chat", "deepseek", OFFICIAL));
      const warn = scheduled.slice(base).find((s, i) => i > 0);
      assert.ok(warn);
      await warn.fn();
      await flush();
      const kinds = h.calls.alerts.map((a) => a.data.kind);
      assert.ok(kinds.includes("warn"));
    });
  });
});

describe("opencode plugin (sync cache schedules)", () => {
  let plugin;

  const cacheFor = (n) => join(tmpdir(), `deepseek-peak-smoke-cache-${process.pid}-${n}.json`);
  const caches = [cacheFor(1), cacheFor(2), cacheFor(3), cacheFor(4)];

  before(async () => {
    plugin = (await import("../index.ts")).default;
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

  const noticeFor = async (options) => {
    const h = makeCtx({ options: { ...options, ledger: tmpLedger } });
    await unlink(tmpLedger).catch(() => {});
    await plugin.setup(h.ctx);
    const events = await readEvents(tmpLedger);
    await unlink(tmpLedger).catch(() => {});
    return events.map((e) => e.notice ?? "").join("\n");
  };

  it("uses the sync cache when present", async () => {
    await writeCache(caches[0], peakCacheNow());
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: undefined, DEEPSEEK_PEAK_CACHE: caches[0] }, async () => {
      const notice = await noticeFor({});
      assert.match(notice, /source=cache/);
      // Cached hours say peak now (regardless of the real schedule) → official blocks.
      const h = makeCtx({ options: { ledger: false } });
      await plugin.setup(h.ctx);
      await assert.rejects(
        () => h.request(modelRequest("sess-cache", "deepseek-chat", "deepseek", OFFICIAL)),
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
      assert.match(await noticeFor({}), /older than 30 days/);
    });
  });

  it("warns on a dateless cache (unknown age counts as stale)", async () => {
    await writeCache(caches[2], {
      version: 1,
      schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "01:00" }],
    });
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: undefined, DEEPSEEK_PEAK_CACHE: caches[2] }, async () => {
      assert.match(await noticeFor({}), /unknown/);
    });
  });

  it("warns on an invalid cache and falls back to built-in", async () => {
    await writeCache(caches[3], "junk {{{");
    await withEnv({ DEEPSEEK_PEAK_SCHEDULE: undefined, DEEPSEEK_PEAK_CACHE: caches[3] }, async () => {
      const notice = await noticeFor({});
      assert.match(notice, /source=builtin/);
      assert.match(notice, /cache ignored/);
    });
  });
});
