// deepseek-peak — opencode TUI plugin.
//
// The server plugin owns the schedule and every money-affecting decision; it
// publishes each decision over the ./rpc contract. This half only renders those
// alerts as toasts, so the terminal can be anywhere — including on another
// machine against a remote server — without duplicating peak detection or the
// abort logic. It is loaded automatically alongside the server plugin because
// the package exposes a ./tui entrypoint; no extra cli.json entry is needed.

import { Plugin } from "@opencode/plugin/tui";
import { DeepSeekPeak } from "./rpc.ts";
import { resolveOptions } from "./lib/options.mjs";
import { presentAlerts } from "./lib/present.mjs";

export default Plugin.define({
  id: "deepseek-peak.tui",
  setup(context) {
    const opts = resolveOptions(context.options);
    if (opts.disabled || !opts.toast) return;

    const controller = new AbortController();
    const { signal } = controller;
    const client = context.client.rpc(DeepSeekPeak);
    const stop = presentAlerts(
      (abort) => client.events.subscribe("alert", { signal: abort }),
      (alert) => context.ui.toast.show(alert),
      { signal },
    );

    return () => {
      stop();
      controller.abort();
    };
  },
});
