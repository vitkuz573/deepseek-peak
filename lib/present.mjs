// Renders the server plugin's alert stream as toasts.
//
// The TUI entrypoint (tui.ts) is a four-line adapter over this function: it
// supplies the subscription and the toast call. Keeping the loop here means the
// reconnect behaviour and the payload validation are unit-testable without the
// terminal runtime, which is what makes the notification path verifiable.

import { parseAlert } from "./alerts.mjs";

/** The alert stream is live-only, so a dropped connection is expected. */
export const RECONNECT_MS = 2_000;

/**
 * Consume alerts until aborted, rendering each valid one.
 *
 * @param {(signal: AbortSignal) => AsyncIterable<unknown>} subscribe
 *   opens the alert stream; called again after the stream ends.
 * @param {(alert: import("./alerts.mjs").Alert) => void} show
 * @param {{ signal: AbortSignal, reconnectMs?: number }} options
 * @returns {() => void} cleanup that aborts the stream and cancels a pending retry.
 */
export function presentAlerts(subscribe, show, { signal, reconnectMs = RECONNECT_MS }) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retry;
  let running = true;

  const stop = () => {
    running = false;
    if (retry) clearTimeout(retry);
    retry = undefined;
  };
  signal.addEventListener("abort", stop, { once: true });

  const pump = async () => {
    try {
      for await (const payload of subscribe(signal)) {
        const alert = parseAlert(payload);
        // A payload we cannot validate is dropped rather than toasted as junk.
        if (alert) show(alert);
      }
    } catch {
      // Aborting, or the server went away. Either way the reconnect decides
      // what happens next; a failed toast must never break the CLI.
    }
    if (!running) return;
    retry = setTimeout(() => void pump(), reconnectMs);
  };

  void pump();

  return stop;
}
