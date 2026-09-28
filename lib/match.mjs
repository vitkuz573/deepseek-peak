// Decides whether a request actually bills through DeepSeek's official API.
//
// Peak pricing applies ONLY to the official endpoint. Flat-rate proxies and
// mirrors serving DeepSeek models must not be blocked — so matching is
// endpoint-first, with a name fallback only when no endpoint is known:
//
//   mode "endpoint" (default): block official-endpoint traffic; a *known*
//     non-official endpoint always passes; an *unknown* endpoint falls back
//     to name matching (conservative).
//   mode "name": block purely by provider/model id and name.
//   mode "both": block when either rule hits (most conservative).
//
// Endpoint resolution, most authoritative first:
//   1. the baseURL the server resolved for this exact request, handed to the
//      plugin by the `model.request` hook;
//   2. the provider catalog entry's `settings.baseURL`.
//
// Both are plain URLs; only the host matters for the decision.

/** Hosts billed directly by DeepSeek (peak pricing applies). */
export const OFFICIAL_DEEPSEEK_HOSTS = ["api.deepseek.com"];

/** Default name substrings (lowercase) treated as DeepSeek. */
export const DEFAULT_NAME_NEEDLES = ["deepseek"];

/** Lowercase hostname of a URL, or "" when unparseable. */
export function hostOf(url) {
  try {
    return new URL(String(url ?? "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** True when any haystack entry contains any needle (all lowercase-compared). */
export function nameMatches(parts, needles) {
  const hay = parts
    .filter((p) => typeof p === "string" && p !== "")
    .map((p) => p.toLowerCase());
  const low = needles.map((n) => String(n).toLowerCase());
  return low.some((n) => hay.some((h) => h.includes(n)));
}

/**
 * baseURL declared by a provider catalog entry, or "" when the provider is
 * unknown or leaves the endpoint to the protocol default.
 * @param {unknown} provider a `Provider.Info` from the provider catalog
 * @returns {string}
 */
export function providerBaseURL(provider) {
  if (!provider || typeof provider !== "object") return "";
  const raw = (/** @type {{ settings?: Record<string, unknown> }} */ (provider)).settings?.baseURL;
  return typeof raw === "string" ? raw : "";
}

/**
 * Resolve the effective billing endpoint: the request-scoped baseURL wins
 * because the server already applied the selected protocol, connection and
 * per-request overrides; the catalog entry is the fallback.
 *
 * @param {{ baseURL?: string, provider?: unknown }} [source]
 * @returns {string} "" when the endpoint is unknown.
 */
export function endpointOf({ baseURL, provider } = {}) {
  return typeof baseURL === "string" && baseURL !== "" ? baseURL : providerBaseURL(provider);
}

/**
 * @param {{ providerID?: string, providerName?: string, baseURL?: string, modelId?: string, modelName?: string }} info
 * @param {{ mode?: "endpoint" | "name" | "both", extraNeedles?: string[] }} options
 * @returns {{ guard: boolean, reason: "endpoint" | "name" | "proxy" | "other" }}
 */
export function shouldGuardDeepSeek(info, { mode = "endpoint", extraNeedles = [] } = {}) {
  const needles = [...DEFAULT_NAME_NEEDLES, ...extraNeedles.map((n) => String(n).toLowerCase())];
  const nameHit = nameMatches([info.providerID, info.providerName, info.modelId, info.modelName], needles);
  const host = hostOf(info.baseURL ?? "");
  const official = host !== "" && OFFICIAL_DEEPSEEK_HOSTS.includes(host);
  if (mode === "name") return nameHit ? { guard: true, reason: "name" } : { guard: false, reason: "other" };
  if (official) return { guard: true, reason: "endpoint" };
  if (mode === "both") return nameHit ? { guard: true, reason: "name" } : { guard: false, reason: "other" };
  // "endpoint": a known non-official endpoint always passes; an unknown
  // endpoint falls back to name matching.
  if (host !== "") return { guard: false, reason: "proxy" };
  return nameHit ? { guard: true, reason: "name" } : { guard: false, reason: "other" };
}
