// deepseek-peak — opencode plugin.
//
// Blocks requests billed through DeepSeek's official API during peak pricing
// hours, and aborts already-running official-API sessions the moment peak
// begins, so you never pay the 2x peak rates by accident. Off-peak requests
// pass through untouched — and so does anything served by a flat-rate proxy
// or mirror, because peak pricing applies ONLY to api.deepseek.com.
// Matching is endpoint-first (see lib/match.mjs).
//
// Peak schedule (UTC): Mon–Fri 01:00–04:00 and 06:00–10:00, everything else
// is off-peak. Source: https://api-docs.deepseek.com/quick_start/pricing
// Schedule resolution order: DEEPSEEK_PEAK_SCHEDULE env >
// `deepseek-peak sync` cache file > built-in defaults (see lib/schedule.mjs).
//
// Installation (global).
// Option A — drop-in, no config edit needed: copy opencode-plugin.ts plus the
// lib/ directory into ~/.config/opencode/plugins/, keeping their relative
// layout (plugins/deepseek-peak.ts + plugins/lib/schedule.mjs), so the
// relative import of ./lib/schedule.mjs keeps resolving. Files directly
// under plugins/ are auto-loaded.
// Option B — reference by path in ~/.config/opencode/opencode.jsonc:
//   "plugin": [
//     ["file:///path/to/deepseek-peak/opencode-plugin.ts", { "mode": "block" }]
//   ]
// Then restart opencode (config and plugins load once at startup).
//
// Options (tuple second element) — every option also has an ENV override:
//   mode            "block" (default) throws in chat.params during peak;
//                   "warn" lets the request through with a warning toast.
//                   ENV: DEEPSEEK_PEAK_MODE
//   abortOnPeak     abort busy DeepSeek sessions when peak begins (default true).
//                   ENV: DEEPSEEK_PEAK_ABORT=0 to disable
//   abortAllOnPeak  also abort busy non-DeepSeek sessions (default false).
//                   ENV: DEEPSEEK_PEAK_ABORT_ALL=1 to enable
//   toast           show TUI toasts on block/transitions (default true).
//                   ENV: DEEPSEEK_PEAK_TOAST=0 to disable
//   log             write to the opencode log via client.app.log (default true).
//                   ENV: DEEPSEEK_PEAK_LOG=0 to disable
//   match           extra case-insensitive name substrings treated as DeepSeek,
//                   e.g. ["my-proxy"]. Feeds the name rule (mode "name" and
//                   "both", plus the unknown-endpoint fallback).
//   matchMode       "endpoint" (default): guard official-endpoint traffic;
//                   known proxies always pass, unknown endpoints fall back
//                   to name matching. "name": match by id/name only.
//                   "both": guard when either rule hits.
//                   ENV: DEEPSEEK_PEAK_MATCH
//   warnBeforeMin   heads-up toast N minutes before each transition (default 10,
//                   0 disables). ENV: DEEPSEEK_PEAK_WARN_BEFORE
//   ledger          append every block/abort/transition to a JSONL ledger for
//                   `deepseek-peak report` (default true = XDG data dir;
//                   string = custom path; false = off). ENV: DEEPSEEK_PEAK_LEDGER
//   notifyUrl       POST a JSON alert to this URL on every transition
//                   (e.g. https://ntfy.sh/your-topic). ENV: DEEPSEEK_PEAK_NOTIFY_URL
//   disabled        hard kill-switch (default false). ENV: DEEPSEEK_PEAK_DISABLE=1

import type { Plugin } from "@opencode-ai/plugin";
import {
  loadScheduleWithMeta,
  status,
  isPeak,
  nextTransition,
  formatDuration,
  formatTimeUTC,
  formatClockUTC,
  describeWindows,
  cacheAgeDays,
} from "./lib/schedule.mjs";
import { STALE_AFTER_DAYS } from "./lib/sync.mjs";
import { resolveLedgerPath, appendEvent } from "./lib/ledger.mjs";
import { notify } from "./lib/notify.mjs";
import { shouldGuardDeepSeek, hostOf } from "./lib/match.mjs";

export type DeepSeekPeakOptions = {
  disabled?: boolean;
  mode?: "block" | "warn";
  abortOnPeak?: boolean;
  abortAllOnPeak?: boolean;
  toast?: boolean;
  log?: boolean;
  match?: string[];
  matchMode?: "endpoint" | "name" | "both";
  warnBeforeMin?: number;
  ledger?: boolean | string;
  notifyUrl?: string;
};

type ResolvedOptions = {
  disabled: boolean;
  mode: "block" | "warn";
  abortOnPeak: boolean;
  abortAllOnPeak: boolean;
  toast: boolean;
  log: boolean;
  match: string[];
  matchMode: "endpoint" | "name" | "both";
  warnBeforeMin: number;
  ledger: boolean | string;
  notifyUrl: string;
};

function boolOpt(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
  }
  return undefined;
}

function numOpt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function resolveOptions(raw?: Record<string, unknown>): ResolvedOptions {
  const env = process.env;
  const modeRaw = typeof raw?.mode === "string" ? raw.mode : env.DEEPSEEK_PEAK_MODE;
  const ledgerRaw = raw?.ledger;
  const matchModeRaw = typeof raw?.matchMode === "string" ? raw.matchMode : env.DEEPSEEK_PEAK_MATCH;
  let matchMode: "endpoint" | "name" | "both" = "endpoint";
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
    match: Array.isArray(raw?.match)
      ? (raw.match as unknown[]).filter((m: unknown): m is string => typeof m === "string" && m.length > 0)
      : [],
    matchMode,
    warnBeforeMin: Math.max(0, numOpt(raw?.warnBeforeMin) ?? numOpt(env.DEEPSEEK_PEAK_WARN_BEFORE) ?? 10),
    ledger:
      typeof ledgerRaw === "string" || typeof ledgerRaw === "boolean" ? ledgerRaw : true,
    notifyUrl:
      typeof raw?.notifyUrl === "string" && raw.notifyUrl
        ? raw.notifyUrl
        : env.DEEPSEEK_PEAK_NOTIFY_URL ?? "",
  };
}

export const DeepSeekPeak: Plugin = async ({ client }, rawOptions) => {
  const opts = resolveOptions(rawOptions);
  if (opts.disabled) return {};

  const loaded = loadScheduleWithMeta();
  const windows = loaded.windows;
  // Last endpoint info seen per session (from chat.params) + sessions currently
  // busy (from session.status events). Used to abort official-API sessions when
  // peak begins.
  const sessionModels = new Map<
    string,
    { providerID: string; providerName: string; baseURL: string; modelId: string; modelName: string }
  >();
  const busySessions = new Set<string>();
  const ledgerPath = resolveLedgerPath(opts.ledger);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let warnTimer: ReturnType<typeof setTimeout> | undefined;

  const log = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> => {
    if (!opts.log) return;
    try {
      await client.app.log({ body: { service: "deepseek-peak", level, message, ...(extra ? { extra } : {}) } });
    } catch {
      // Logging must never break the session.
    }
  };

  const toast = async (message: string, variant: "info" | "success" | "warning" | "error"): Promise<void> => {
    if (!opts.toast) return;
    try {
      await client.tui.showToast({ body: { message, variant } });
    } catch {
      // No TUI attached (headless run, remote client, …) — not fatal.
    }
  };

  const onTransition = async (): Promise<void> => {
    armTimer(); // schedule the transition after this one
    const now = new Date();
    if (!isPeak(now, windows)) {
      const t = nextTransition(now, windows);
      const message = `DeepSeek off-peak started — 0.5x rates until ${formatClockUTC(t.at)}.`;
      void appendEvent(ledgerPath, { type: "offpeak-start" });
      if (opts.notifyUrl) {
        void notify(opts.notifyUrl, { service: "deepseek-peak", event: "offpeak-start", message, at: now.toISOString() });
      }
      await toast(message, "success");
      await log("info", `Off-peak started; next peak at ${formatTimeUTC(t.at)}.`);
      return;
    }
    // Peak just started: abort running DeepSeek sessions.
    const busy = new Set(busySessions);
    try {
      // Defensive: also ask the server, in case a busy session was missed by events.
      const res = (await client.session.status()) as unknown;
      const map = (res as { data?: unknown })?.data ?? res;
      if (map && typeof map === "object") {
        for (const [id, st] of Object.entries(map as Record<string, unknown>)) {
          if ((st as { type?: string })?.type === "busy") busy.add(id);
        }
      }
    } catch {
      // Fall back to the event-tracked set.
    }
    const aborted: string[] = [];
    const skipped: string[] = [];
    if (opts.abortOnPeak) {
      for (const id of busy) {
        const rec = sessionModels.get(id);
        // Sessions we never saw (started before the plugin loaded) are
        // aborted conservatively; known proxies are left alone.
        const matched =
          !rec || shouldGuardDeepSeek(rec, { mode: opts.matchMode, extraNeedles: opts.match }).guard;
        if (!matched && !opts.abortAllOnPeak) {
          skipped.push(id);
          continue;
        }
        try {
          const ok = (await client.session.abort({ path: { id } })) as unknown;
          if (ok === false) skipped.push(id);
          else {
            aborted.push(id);
            await appendEvent(ledgerPath, {
              type: "aborted",
              session: id,
              model: rec ? `${rec.providerID}/${rec.modelId}` : "unknown",
              endpoint: rec ? hostOf(rec.baseURL) || "unknown" : "unknown",
            });
          }
        } catch {
          skipped.push(id);
        }
      }
    }
    busySessions.clear();
    const t = nextTransition(now, windows);
    const message =
      `DeepSeek peak hours started (until ${formatClockUTC(t.at)}). ` +
      (opts.abortOnPeak
        ? `Aborted ${aborted.length} DeepSeek session(s)` +
          (skipped.length ? `, left ${skipped.length} other session(s) running` : "") +
          `. `
        : `Session abort is disabled (abortOnPeak=false). `) +
      `Off-peak rates resume at ${formatClockUTC(t.at)}.`;
    void appendEvent(ledgerPath, { type: "peak-start", aborted: aborted.length, skipped: skipped.length });
    if (opts.notifyUrl) {
      void notify(opts.notifyUrl, { service: "deepseek-peak", event: "peak-start", message, at: now.toISOString() });
    }
    await toast(message, "warning");
    await log("warn", message, { aborted, skipped });
  };

  const onWarn = async (): Promise<void> => {
    // Heads-up shortly before a transition. Recomputes live, so a late
    // firing (e.g. after sleep) still reports correct numbers.
    const now = new Date();
    const tr = nextTransition(now, windows);
    const message =
      tr.to === "peak"
        ? `DeepSeek peak starts in ${formatDuration(tr.inMs)} (at ${formatClockUTC(tr.at)}) — wrap up DeepSeek work.`
        : `DeepSeek off-peak starts in ${formatDuration(tr.inMs)} (at ${formatClockUTC(tr.at)}) — 0.5x rates.`;
    await toast(message, "info");
    await log("info", message);
  };

  function armTimer(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (warnTimer) clearTimeout(warnTimer);
    warnTimer = undefined;
    // nextTransition cannot throw here: windows come from loadSchedule, which
    // only returns normalized non-empty schedules, and every weekday occurs
    // within the scanned 9-day span — so a future boundary always exists.
    const t = nextTransition(new Date(), windows);
    // unref is load-bearing: without it, a non-interactive `opencode run`
    // would hang until the next transition instead of exiting after answering.
    timer = setTimeout(() => void onTransition(), Math.min(Math.max(t.inMs, 1000), 2_147_483_647));
    timer.unref();
    if (opts.warnBeforeMin > 0) {
      const delay = t.at.getTime() - opts.warnBeforeMin * 60000 - Date.now();
      if (delay > 1000) {
        warnTimer = setTimeout(() => void onWarn(), Math.min(delay, 2_147_483_647));
        warnTimer.unref();
      }
    }
  }

  const s0 = status(new Date(), windows);
  await log(
    "info",
    `deepseek-peak active (mode=${opts.mode}, match=${opts.matchMode}, abortOnPeak=${opts.abortOnPeak}, ` +
      `warnBeforeMin=${opts.warnBeforeMin}, ledger=${ledgerPath ?? "off"}, notify=${opts.notifyUrl ? "on" : "off"}, ` +
      `source=${loaded.source}). ` +
      `Now: ${s0.peak ? "PEAK" : "OFF-PEAK"}; next change: ${s0.transition.to} at ` +
      `${formatTimeUTC(s0.transition.at)} (in ${formatDuration(s0.transition.inMs)}).`,
  );
  if (loaded.source === "cache" && cacheAgeDays(loaded.meta) > STALE_AFTER_DAYS) {
    await log(
      "warn",
      `Schedule cache is older than ${STALE_AFTER_DAYS} days (fetched ${loaded.meta.fetchedAt ?? "unknown"}) — ` +
        `run \`deepseek-peak sync\` to refresh.`,
    );
  } else if (loaded.source === "builtin" && loaded.cacheIssue) {
    await log(
      "warn",
      `Schedule cache ignored (${loaded.cacheIssue}) — using built-in defaults. Run \`deepseek-peak sync\` to refresh.`,
    );
  }
  armTimer();

  return {
    "chat.params": async (input) => {
      const modelId = input.model.id;
      const modelName = input.model.name;
      const providerID = input.model.providerID;
      // NOTE: `provider.info` is typed as required but is undefined at runtime
      // for some providers (observed live) — hence the optional chaining.
      const providerName = input.provider.info?.name ?? "";
      const baseURL = input.provider.options?.baseURL ?? "";
      const info = { providerID, providerName, baseURL, modelId, modelName };
      sessionModels.set(input.sessionID, info);
      armTimer(); // re-arm on activity: heals the schedule after sleep/suspend
      const verdict = shouldGuardDeepSeek(info, { mode: opts.matchMode, extraNeedles: opts.match });
      if (!verdict.guard) return;
      const now = new Date();
      if (!isPeak(now, windows)) return;
      const s = status(now, windows);
      const label = `${providerID || "?"}/${modelId || "?"}`;
      const endpoint = hostOf(baseURL) || "unknown";
      if (opts.mode === "warn") {
        await appendEvent(ledgerPath, { type: "allowed-warn", session: input.sessionID, model: label, endpoint, reason: verdict.reason });
        await toast(`DeepSeek peak hours: ${label} bills at 2x rates until ${formatClockUTC(s.transition.at)}.`, "warning");
        await log("warn", `Peak-hour request to ${label} allowed (mode=warn), session ${input.sessionID}.`);
        return;
      }
      const message = [
        `DeepSeek peak hours — request blocked by the deepseek-peak plugin.`,
        verdict.reason === "endpoint"
          ? `Model: ${label} via ${endpoint} (official API). Peak windows (UTC): ${describeWindows(windows)} — standard (2x) rates apply right now.`
          : `Model: ${label} (endpoint ${endpoint}, matched by name). Peak windows (UTC): ${describeWindows(windows)} — standard (2x) rates apply right now.`,
        `Off-peak starts at ${formatClockUTC(s.transition.at)} (in ${formatDuration(s.transition.inMs)}), rates drop to 0.5x.`,
        `Options: switch to a non-DeepSeek model, wait for off-peak, or relax the guard with`,
        `the plugin option mode:"warn" or the DEEPSEEK_PEAK_MODE=warn environment variable.`,
      ].join("\n");
      await appendEvent(ledgerPath, { type: "blocked", session: input.sessionID, model: label, endpoint, reason: verdict.reason });
      await toast(`Blocked DeepSeek request to ${label} (${endpoint}): peak hours until ${formatClockUTC(s.transition.at)}.`, "warning");
      await log("warn", `Blocked peak-hour request to ${label}, session ${input.sessionID}.`);
      throw new Error(message);
    },

    event: async ({ event }) => {
      // Narrow the bus event without importing SDK event types (keeps the
      // plugin dependency-free at runtime — only a type-only import above).
      const props = (event as unknown as { properties?: { sessionID?: string; status?: { type?: string } } })
        .properties;
      const sessionID = props?.sessionID;
      if (!sessionID) return;
      if (event.type === "session.status") {
        if (props?.status?.type === "busy") busySessions.add(sessionID);
        else busySessions.delete(sessionID);
      } else if (event.type === "session.idle" || event.type === "session.deleted") {
        busySessions.delete(sessionID);
        if (event.type === "session.deleted") sessionModels.delete(sessionID);
      }
    },

    dispose: async () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (warnTimer) clearTimeout(warnTimer);
      warnTimer = undefined;
    },
  };
};

export default DeepSeekPeak;
