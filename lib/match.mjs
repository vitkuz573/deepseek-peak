// Decides whether a request actually bills through DeepSeek's official API.
//
// Peak pricing applies ONLY to the official endpoint. Flat-rate proxies and
// mirrors serving DeepSeek models must not be blocked — so matching is
// endpoint-first, with a name fallback only when no endpoint is known:
//
//   mode "endpoint" (default): block official-endpoint traffic; a *known*
//     non-official endpoint always passes; an *unknown* endpoint falls back
//     to name matching (conservative).
//   mode "name": block purely by provider/model id and name (old behavior).
//   mode "both": block when either rule hits (most conservative).
//
// Endpoint resolution: an explicit `provider.options.baseURL` (custom config
// override) wins when present; otherwise the model's canonical
// `model.api.url` (models.dev default, e.g. https://api.deepseek.com for the
// built-in deepseek provider, whose options carry no baseURL) is used.
// Either source may be absent depending on the opencode version and provider
// shape (flat Provider.Info vs wrapped ProviderContext) — see
// providerBaseURL() / modelApiURL().

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
 * Extract a baseURL from the many provider shapes seen across opencode
 * versions. Newer runtimes pass a flat Provider.Info (id/name/options at
 * the top level); older typed wrappers nest it under `.info`. Both are
 * accepted; anything else yields "" (unknown endpoint).
 */
export function providerBaseURL(provider) {
  if (!provider || typeof provider !== "object") return "";
  // Flat Provider.Info carries options at the top level; the older wrapped
  // ProviderContext shape nests them under .info (and may also repeat the
  // resolved options at the top level) — check both.
  for (const options of [provider.options, provider.info?.options]) {
    const raw = options?.baseURL;
    if (typeof raw === "string" && raw !== "") return raw;
  }
  return "";
}

/** Canonical endpoint for a model (models.dev default), or "" when absent. */
export function modelApiURL(model) {
  const raw = model?.api?.url;
  return typeof raw === "string" ? raw : "";
}

/**
 * Resolve the effective billing endpoint: explicit provider baseURL first
 * (a custom config override), else the model's canonical api.url.
 */
export function endpointOf(provider, model) {
  return providerBaseURL(provider) || modelApiURL(model);
}

/**
 * @param {{ providerID?: string, providerName?: string, baseURL?: string, apiURL?: string, modelId?: string, modelName?: string }} info
 * @param {{ mode?: "endpoint" | "name" | "both", extraNeedles?: string[] }} options
 * @returns {{ guard: boolean, reason: "endpoint" | "name" | "proxy" | "other" }}
 */
export function shouldGuardDeepSeek(info, { mode = "endpoint", extraNeedles = [] } = {}) {
  const needles = [...DEFAULT_NAME_NEEDLES, ...extraNeedles.map((n) => String(n).toLowerCase())];
  const nameHit = nameMatches(
    [info.providerID, info.providerName, info.modelId, info.modelName],
    needles,
  );
  // Back-compat: callers may pass a pre-resolved baseURL and/or apiURL.
  const host = hostOf(info.baseURL || info.apiURL || "");
  const official = host !== "" && OFFICIAL_DEEPSEEK_HOSTS.includes(host);
  if (mode === "name") return nameHit ? { guard: true, reason: "name" } : { guard: false, reason: "other" };
  if (official) return { guard: true, reason: "endpoint" };
  if (mode === "both") return nameHit ? { guard: true, reason: "name" } : { guard: false, reason: "other" };
  // "endpoint": a known non-official endpoint always passes; an unknown
  // endpoint falls back to name matching.
  if (host !== "") return { guard: false, reason: "proxy" };
  return nameHit ? { guard: true, reason: "name" } : { guard: false, reason: "other" };
}
