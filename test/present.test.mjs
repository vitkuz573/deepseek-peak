import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { presentAlerts, RECONNECT_MS } from "../lib/present.mjs";

const alert = (over = {}) => ({
  kind: "blocked",
  title: "DeepSeek peak hours",
  message: "request blocked",
  variant: "error",
  ...over,
});

const flush = () => new Promise((r) => setImmediate(r));

/** An alert stream the test drives, one payload per `push`. */
function fakeStream() {
  const opened = [];
  let waiting = null;
  return {
    opened,
    subscribe(signal) {
      opened.push(signal);
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => new Promise((resolve, reject) => (waiting = { resolve, reject })),
        return: () => Promise.resolve({ done: true, value: undefined }),
      };
    },
    push: async (payload) => {
      const w = waiting;
      if (!w) throw new Error("nothing is subscribed");
      waiting = null;
      w.resolve({ value: payload, done: false });
      await flush();
    },
    end: async () => {
      const w = waiting;
      if (!w) throw new Error("nothing is subscribed");
      waiting = null;
      w.resolve({ done: true, value: undefined });
      await flush();
    },
    fail: async (error) => {
      const w = waiting;
      if (!w) throw new Error("nothing is subscribed");
      waiting = null;
      w.reject(error);
      await flush();
    },
  };
}

describe("presentAlerts", () => {
  it("renders every valid alert in order", async () => {
    const stream = fakeStream();
    const shown = [];
    const controller = new AbortController();
    presentAlerts(stream.subscribe, (a) => shown.push(a), { signal: controller.signal });

    await stream.push(alert({ kind: "blocked" }));
    await stream.push(alert({ kind: "peak-start", variant: "warning" }));
    assert.deepEqual(shown.map((a) => a.kind), ["blocked", "peak-start"]);

    controller.abort();
  });

  it("passes the parsed alert straight to the toast call", async () => {
    const stream = fakeStream();
    const shown = [];
    const controller = new AbortController();
    presentAlerts(stream.subscribe, (a) => shown.push(a), { signal: controller.signal });

    await stream.push(alert());
    assert.deepEqual(shown, [alert()]);

    controller.abort();
  });

  it("drops payloads that are not valid alerts", async () => {
    const stream = fakeStream();
    const shown = [];
    const controller = new AbortController();
    presentAlerts(stream.subscribe, (a) => shown.push(a), { signal: controller.signal });

    for (const bad of [null, "blocked", 42, { kind: "nope" }, { ...alert(), variant: "nope" }]) {
      await stream.push(bad);
    }
    await stream.push(alert());
    assert.deepEqual(shown, [alert()], "only the valid alert is rendered");

    controller.abort();
  });

  it("reconnects when the live-only stream ends", async () => {
    const stream = fakeStream();
    const controller = new AbortController();
    const scheduled = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => {
      scheduled.push({ fn, ms });
      return realSetTimeout(() => {}, 2_147_483_647);
    };
    try {
      presentAlerts(stream.subscribe, () => {}, { signal: controller.signal, reconnectMs: 5 });
      await stream.end();
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0].ms, 5);

      // Firing the retry reopens the subscription.
      scheduled[0].fn();
      await flush();
      await flush();
      assert.equal(stream.opened.length, 2);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      controller.abort();
    }
  });

  it("reconnects when the stream fails", async () => {
    const stream = fakeStream();
    const controller = new AbortController();
    const scheduled = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => {
      scheduled.push({ fn, ms });
      return realSetTimeout(() => {}, 2_147_483_647);
    };
    try {
      presentAlerts(stream.subscribe, () => {}, { signal: controller.signal, reconnectMs: 5 });
      await stream.fail(new Error("connection reset"));
      assert.equal(scheduled.length, 1, "a failed stream is retried like an ended one");
    } finally {
      globalThis.setTimeout = realSetTimeout;
      controller.abort();
    }
  });

  it("stops retrying once aborted", async () => {
    const stream = fakeStream();
    const controller = new AbortController();
    const scheduled = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => {
      scheduled.push({ fn, ms });
      return realSetTimeout(() => {}, 2_147_483_647);
    };
    try {
      presentAlerts(stream.subscribe, () => {}, { signal: controller.signal, reconnectMs: 5 });
      controller.abort();
      await stream.end();
      assert.deepEqual(scheduled, [], "no reconnect is armed after abort");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it("cancels a pending retry on cleanup", async () => {
    const stream = fakeStream();
    const controller = new AbortController();
    const scheduled = [];
    const cleared = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, ms) => {
      const handle = realSetTimeout(() => {}, 2_147_483_647);
      scheduled.push({ fn, ms, handle });
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      cleared.push(handle);
      return realClearTimeout(handle);
    };
    try {
      const stop = presentAlerts(stream.subscribe, () => {}, { signal: controller.signal, reconnectMs: 5 });
      await stream.end();
      assert.equal(scheduled.length, 1);

      stop();
      stop(); // idempotent
      assert.deepEqual(cleared, [scheduled[0].handle], "the pending retry is cancelled exactly once");
      assert.equal(scheduled.length, 1, "cleanup arms no further retries");
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      controller.abort();
    }
  });

  it("stops immediately when the signal is already aborted", async () => {
    const stream = fakeStream();
    const shown = [];
    const controller = new AbortController();
    controller.abort();
    presentAlerts(stream.subscribe, (a) => shown.push(a), { signal: controller.signal });
    await flush();
    assert.deepEqual(shown, []);
  });

  it("gives every subscription the caller's signal", async () => {
    const stream = fakeStream();
    const controller = new AbortController();
    presentAlerts(stream.subscribe, () => {}, { signal: controller.signal });
    assert.equal(stream.opened[0], controller.signal);
    controller.abort();
  });

  it("defaults the retry delay", () => {
    assert.equal(RECONNECT_MS, 2_000);
  });
});
