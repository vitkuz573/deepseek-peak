// Smoke test for the opencode TUI plugin.
//
// The terminal runtime is not needed: the entrypoint is a thin adapter over
// lib/present.mjs, so the test drives it with a fake TUI context and checks
// that alerts become toasts, that the configuration switches are honoured, and
// that cleanup detaches the subscription.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const plugin = (await import("../tui.ts")).default;

const flush = () => new Promise((r) => setImmediate(r));

const alert = (over = {}) => ({
  kind: "blocked",
  title: "DeepSeek peak hours",
  message: "request blocked",
  variant: "error",
  ...over,
});

/** A fake TUI context whose alert stream the test drives. */
function makeTui({ options = {}, failStream = false } = {}) {
  const toasts = [];
  const subscriptions = [];
  let waiting = null;

  const stream = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () =>
      new Promise((resolve, reject) => {
        if (failStream) {
          reject(new Error("no server"));
          return;
        }
        waiting = { resolve, reject };
      }),
    return: () => Promise.resolve({ done: true, value: undefined }),
  };

  const context = {
    options,
    client: {
      rpc: (definition) => {
        assert.equal(definition.id, "deepseek-peak");
        return {
          events: {
            subscribe: (name, { signal } = {}) => {
              subscriptions.push({ name, signal });
              if (failStream) {
                queueMicrotask(() => {});
              }
              return stream;
            },
          },
        };
      },
    },
    ui: {
      toast: {
        show: (input) => toasts.push(input),
      },
    },
  };

  return {
    context,
    toasts,
    subscriptions,
    push: async (payload) => {
      const w = waiting;
      if (!w) throw new Error("nothing is subscribed");
      waiting = null;
      w.resolve({ value: payload, done: false });
      await flush();
    },
  };
}

describe("opencode TUI plugin", () => {
  it("renders every server alert as a toast", async () => {
    const tui = makeTui();
    const cleanup = plugin.setup(tui.context);
    assert.equal(typeof cleanup, "function");
    assert.equal(tui.subscriptions.length, 1);
    assert.equal(tui.subscriptions[0].name, "alert");

    await tui.push(alert({ kind: "blocked", variant: "error" }));
    await tui.push(alert({ kind: "peak-start", title: "DeepSeek peak hours", variant: "warning" }));

    assert.deepEqual(tui.toasts, [
      alert({ kind: "blocked", variant: "error" }),
      alert({ kind: "peak-start", title: "DeepSeek peak hours", variant: "warning" }),
    ]);

    await cleanup();
  });

  it("passes the caller's abort signal to the subscription", async () => {
    const tui = makeTui();
    const cleanup = plugin.setup(tui.context);
    assert.ok(tui.subscriptions[0].signal, "the subscription must be abortable");
    await cleanup();
    assert.equal(tui.subscriptions[0].signal.aborted, true, "cleanup aborts the stream");
  });

  it("drops payloads that are not valid alerts", async () => {
    const tui = makeTui();
    const cleanup = plugin.setup(tui.context);
    await tui.push({ kind: "nope" });
    await tui.push(null);
    await tui.push(alert());
    assert.deepEqual(tui.toasts, [alert()]);
    await cleanup();
  });

  it("subscribes to nothing when toasts are disabled", async () => {
    const tui = makeTui({ options: { toast: false } });
    assert.equal(plugin.setup(tui.context), undefined);
    assert.deepEqual(tui.subscriptions, []);
  });

  it("subscribes to nothing when the plugin is disabled", async () => {
    const tui = makeTui({ options: { disabled: true } });
    assert.equal(plugin.setup(tui.context), undefined);
    assert.deepEqual(tui.subscriptions, []);
  });

  it("honours the toast switch from the environment", async () => {
    const previous = process.env.DEEPSEEK_PEAK_TOAST;
    process.env.DEEPSEEK_PEAK_TOAST = "0";
    try {
      const tui = makeTui();
      assert.equal(plugin.setup(tui.context), undefined);
      assert.deepEqual(tui.subscriptions, []);
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_PEAK_TOAST;
      else process.env.DEEPSEEK_PEAK_TOAST = previous;
    }
  });

  it("survives a server that is not reachable", async () => {
    const tui = makeTui({ failStream: true });
    const cleanup = plugin.setup(tui.context);
    await flush();
    assert.deepEqual(tui.toasts, []);
    await cleanup();
  });

  it("is idempotent on repeated cleanup", async () => {
    const tui = makeTui();
    const cleanup = plugin.setup(tui.context);
    await cleanup();
    await cleanup();
  });
});
