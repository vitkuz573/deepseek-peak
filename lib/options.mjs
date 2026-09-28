// Option resolution shared by the server plugin and the TUI plugin.
//
// Every option can be set in the opencode plugin config (`options` object) or
// through an environment variable, which always loses to an explicit config
// value. Keeping this in lib/ means the guard and the toast surface can never
// disagree about how the plugin is configured.

/**
 * @typedef {object} DeepSeekPeakOptions
 * @property {boolean} [disabled] Hard kill-switch.
 * @property {"block" | "warn"} [mode] Throw during peak, or allow with a warning.
 * @property {boolean} [abortOnPeak] Interrupt busy DeepSeek sessions when peak begins.
 * @property {boolean} [abortAllOnPeak] Also interrupt busy non-DeepSeek sessions.
 * @property {boolean} [toast] Surface alerts as TUI toasts.
 * @property {boolean} [log] Append diagnostics to the ledger.
 * @property {string[]} [match] Extra case-insensitive name substrings treated as DeepSeek.
 * @property {"endpoint" | "name" | "both"} [matchMode] Which rule decides the guard.
 * @property {number} [warnBeforeMin] Heads-up minutes before each transition; 0 disables.
 * @property {boolean | string} [ledger] Append events to a JSONL ledger; string = custom path.
 * @property {string} [notifyUrl] POST a JSON alert to this URL on every transition.
 */

/**
 * @typedef {object} ResolvedOptions
 * @property {boolean} disabled
 * @property {"block" | "warn"} mode
 * @property {boolean} abortOnPeak
 * @property {boolean} abortAllOnPeak
 * @property {boolean} toast
 * @property {boolean} log
 * @property {string[]} match
 * @property {"endpoint" | "name" | "both"} matchMode
 * @property {number} warnBeforeMin
 * @property {boolean | string} ledger
 * @property {string} notifyUrl
 */

/**
 * Accept real booleans and the usual textual spellings, so the same value can
 * arrive from JSON (`true`) or from an environment variable (`"1"`).
 * @param {unknown} value
 * @returns {boolean | undefined} undefined when the value says nothing.
 */
export function boolOpt(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined} undefined when the value says nothing.
 */
export function numOpt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/**
 * Merge plugin config options with the environment and apply defaults.
 *
 * @param {Record<string, unknown>} [raw] the `options` object from the config entry
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ResolvedOptions}
 */
export function resolveOptions(raw, env = process.env) {
  const modeRaw = typeof raw?.mode === "string" ? raw.mode : env.DEEPSEEK_PEAK_MODE;
  const ledgerRaw = raw?.ledger;
  const matchModeRaw = typeof raw?.matchMode === "string" ? raw.matchMode : env.DEEPSEEK_PEAK_MATCH;
  /** @type {"endpoint" | "name" | "both"} */
  let matchMode = "endpoint";
  if (matchModeRaw === "endpoint" || matchModeRaw === "name" || matchModeRaw === "both") {
    matchMode = matchModeRaw;
  }
  return {
    disabled: boolOpt(raw?.disabled) ?? boolOpt(env.DEEPSEEK_PEAK_DISABLE) ?? false,
    mode: String(modeRaw ?? "").toLowerCase() === "warn" ? "warn" : "block",
    abortOnPeak: boolOpt(raw?.abortOnPeak) ?? boolOpt(env.DEEPSEEK_PEAK_ABORT) ?? true,
    abortAllOnPeak: boolOpt(raw?.abortAllOnPeak) ?? boolOpt(env.DEEPSEEK_PEAK_ABORT_ALL) ?? false,
    toast: boolOpt(raw?.toast) ?? boolOpt(env.DEEPSEEK_PEAK_TOAST) ?? true,
    log: boolOpt(raw?.log) ?? boolOpt(env.DEEPSEEK_PEAK_LOG) ?? true,
    match: Array.isArray(raw?.match) ? raw.match.filter((m) => typeof m === "string" && m.length > 0) : [],
    matchMode,
    warnBeforeMin: Math.max(0, numOpt(raw?.warnBeforeMin) ?? numOpt(env.DEEPSEEK_PEAK_WARN_BEFORE) ?? 10),
    ledger: typeof ledgerRaw === "string" || typeof ledgerRaw === "boolean" ? ledgerRaw : true,
    notifyUrl:
      typeof raw?.notifyUrl === "string" && raw.notifyUrl
        ? raw.notifyUrl
        : env.DEEPSEEK_PEAK_NOTIFY_URL ?? "",
  };
}
