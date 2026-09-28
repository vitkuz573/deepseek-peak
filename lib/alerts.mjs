// The alert contract shared by the server plugin and the TUI plugin.
//
// The server plugin owns the schedule and every money-affecting decision, so it
// is the only thing that decides *that* something happened. It publishes each
// decision as an `alert` event over the ./rpc channel; the TUI plugin does
// nothing but render those alerts as toasts. One source of truth, no duplicated
// peak timers, and a terminal connected to a remote server still gets its
// notifications.
//
// This module is the payload contract only, kept dependency-free so both
// entrypoints and the tests can share it. The RPC definition itself lives in
// rpc.ts.

/** Alert categories the server plugin publishes. */
export const ALERT_KINDS = /** @type {const} */ (["blocked", "allowed-warn", "warn", "peak-start", "offpeak-start"]);

/** Toast variants, matching the TUI toast API. */
export const ALERT_VARIANTS = /** @type {const} */ (["info", "success", "warning", "error"]);

/**
 * @typedef {(typeof ALERT_KINDS)[number]} AlertKind
 * @typedef {(typeof ALERT_VARIANTS)[number]} AlertVariant
 * @typedef {{ kind: AlertKind, title: string, message: string, variant: AlertVariant }} Alert
 */

/**
 * JSON Schema payloads arrive as `unknown` on the client side, so the shape is
 * re-established here instead of being asserted at each use site.
 *
 * @param {unknown} data
 * @returns {Alert | undefined} undefined when the payload is not a valid alert.
 */
export function parseAlert(data) {
  if (!data || typeof data !== "object") return undefined;
  const { kind, title, message, variant } = /** @type {Record<string, unknown>} */ (data);
  if (typeof kind !== "string" || !ALERT_KINDS.includes(/** @type {AlertKind} */ (kind))) return undefined;
  if (typeof title !== "string" || typeof message !== "string") return undefined;
  if (typeof variant !== "string" || !ALERT_VARIANTS.includes(/** @type {AlertVariant} */ (variant))) return undefined;
  return { kind: /** @type {AlertKind} */ (kind), title, message, variant: /** @type {AlertVariant} */ (variant) };
}
