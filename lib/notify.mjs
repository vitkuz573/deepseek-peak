// Best-effort outbound notifications (transition alerts).
//
// POSTs a JSON payload to any HTTP(S) endpoint — works with ntfy.sh
// (the JSON lands as the message text), healthcheck-style webhooks,
// or your own collector. Used by the CLI (`wait --notify`) and the
// opencode plugin (`notifyUrl` option).
//
// Never throws: resolves true on HTTP 2xx, false otherwise.

/**
 * @param {string} url destination endpoint
 * @param {Record<string, unknown>} payload JSON body
 * @param {{ timeoutMs?: number }} options
 * @returns {Promise<boolean>}
 */
export async function notify(url, payload, { timeoutMs = 5000 } = {}) {
  try {
    if (typeof url !== "string" || url.trim() === "") return false;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "deepseek-peak" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
