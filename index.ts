// deepseek-peak — opencode plugin (OpenCode V2).
//
// Blocks requests billed through DeepSeek's official API during peak pricing
// hours, and interrupts already-running official-API sessions the moment peak
// begins, so peak rates (2x off-peak) are never paid by accident. Off-peak
// requests pass through untouched — and so does anything served by a flat-rate
// proxy or mirror, because peak pricing applies ONLY to api.deepseek.com.
//
// Guard point. The `model.request` hook runs immediately before every model
// call a session issues — the agent loop plus title, compaction and generate
// calls — and the server hands it the baseURL it resolved for that exact
// request. One hook therefore covers every billable path, and the billing
// endpoint is read from the runtime instead of being reconstructed from
// provider configuration. Throwing from the hook aborts the call before it
// leaves the process; verified against a local provider that received zero
// requests while the guard was throwing.
//
// Matching is endpoint-first (see lib/match.mjs): the effective baseURL wins,
// else the provider catalog's settings.baseURL. An explicit baseURL override or
// a known non-DeepSeek endpoint always passes; only an unknown endpoint falls
// back to name matching, which also covers providers whose ids and names
// mention DeepSeek.
//
// Peak schedule (UTC): Mon–Fri 01:00–04:00 and 06:00–10:00, everything else
// is off-peak. Source: https://api-docs.deepseek.com/quick_start/pricing
// Schedule resolution order: DEEPSEEK_PEAK_SCHEDULE env >
// `deepseek-peak sync` cache file > built-in defaults (see lib/schedule.mjs).
//
// Installation (global). Point the config at this directory; OpenCode resolves
// the package entry and also loads ./tui.ts into the CLI, which turns the
// alerts published over ./rpc into toasts:
//   // ~/.config/opencode/opencode.jsonc
//   {
//     "plugins": [
//       { "package": "file:///path/to/deepseek-peak", "options": { "mode": "block" } }
//     ]
//   }
//   opencode service restart
//
// Options — every option also has an ENV override (see lib/options.mjs):
//   mode            "block" (default) throws in the model.request hook during peak;
//                   "warn" lets the request through with a warning alert.
//                   ENV: DEEPSEEK_PEAK_MODE
//   abortOnPeak     interrupt busy DeepSeek sessions when peak begins (default true).
//                   ENV: DEEPSEEK_PEAK_ABORT=0 to disable
//   abortAllOnPeak  also interrupt busy non-DeepSeek sessions (default false).
//                   ENV: DEEPSEEK_PEAK_ABORT_ALL=1 to enable
//   toast           show TUI toasts for alerts (default true).
//                   ENV: DEEPSEEK_PEAK_TOAST=0 to disable
//   log             append diagnostics to the ledger (default true). OpenCode V2
//                   removed the plugin log API, so the durable JSONL ledger is
//                   the plugin's log and `deepseek-peak report` reads it.
//                   ENV: DEEPSEEK_PEAK_LOG=0 to disable
//   match           extra case-insensitive name substrings treated as DeepSeek,
//                   e.g. ["my-proxy"]. Feeds the name rule (mode "name" and
//                   "both", plus the unknown-endpoint fallback).
//   matchMode       "endpoint" (default): guard official-endpoint traffic;
//                   known proxies always pass, unknown endpoints fall back
//                   to name matching. "name": match by id/name only.
//                   "both": guard when either rule hits.
//                   ENV: DEEPSEEK_PEAK_MATCH
//   warnBeforeMin   heads-up alert N minutes before each transition (default 10,
//                   0 disables). ENV: DEEPSEEK_PEAK_WARN_BEFORE
//   ledger          append every block/abort/transition to a JSONL ledger for
//                   `deepseek-peak report` (default true = XDG data dir;
//                   string = custom path; false = off). ENV: DEEPSEEK_PEAK_LEDGER
//   notifyUrl       POST a JSON alert to this URL on every transition
//                   (e.g. https://ntfy.sh/your-topic). ENV: DEEPSEEK_PEAK_NOTIFY_URL
//   disabled        hard kill-switch (default false). ENV: DEEPSEEK_PEAK_DISABLE=1

import { Plugin } from "@opencode/plugin";
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
import { shouldGuardDeepSeek, hostOf, endpointOf } from "./lib/match.mjs";
import { resolveOptions } from "./lib/options.mjs";
import { DeepSeekPeak } from "./rpc.ts";
import type { Alert } from "./lib/alerts.mjs";

/** Everything needed to re-judge a session's billing endpoint later. */
type SessionRecord = {
  providerID: string;
  providerName: string;
  modelId: string;
  modelName: string;
  baseURL: string;
};

/**
 * Provider and model display names plus provider endpoint settings, cached
 * until the server says the catalog changed. Names only feed the name rule and
 * the ledger labels, so a stale entry can never widen the guard on its own.
 */
type Catalog = {
  providerName: Map<string, string>;
  providerEndpoint: Map<string, string>;
  modelName: Map<string, string>;
};

export default Plugin.define({
  id: "deepseek-peak",
  async setup(ctx) {
    const opts = resolveOptions(ctx.options);
    if (opts.disabled) return;

    const loaded = loadScheduleWithMeta();
    const windows = loaded.windows;
    const ledgerPath = resolveLedgerPath(opts.ledger);
    const rpc = await ctx.rpc.register(DeepSeekPeak, {});
    const events = new AbortController();

    // Last endpoint info seen per session (from the model.request hook) plus
    // the sessions currently executing (from the server event stream). Used to
    // interrupt official-API sessions when peak begins.
    const sessionModels = new Map<string, SessionRecord>();
    const busySessions = new Set<string>();
    let catalog: Catalog | null = null;
    let catalogDirty = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let warnTimer: ReturnType<typeof setTimeout> | undefined;

    const notice = async (message: string, detail?: Record<string, unknown>): Promise<void> => {
      if (!opts.log) return;
      await appendEvent(ledgerPath, { type: "notice", notice: message, ...detail });
    };

    /** Publish one decision to every channel: TUI toast, ledger, webhook. */
    const announce = async (
      alert: Alert,
      ledger: Record<string, unknown>,
      { send = false }: { send?: boolean } = {},
    ): Promise<void> => {
      try {
        await rpc.events.emit("alert", alert);
      } catch {
        // No client attached (headless run, remote client gone, …) — not fatal.
      }
      await appendEvent(ledgerPath, ledger);
      if (send && opts.notifyUrl) {
        void notify(opts.notifyUrl, {
          service: "deepseek-peak",
          event: alert.kind,
          message: alert.message,
          at: new Date().toISOString(),
        });
      }
    };

    const catalogKey = (providerID: string, modelId: string): string => `${providerID}/${modelId}`;

    const refreshCatalog = async (): Promise<Catalog> => {
      const [models, providers] = await Promise.all([ctx.model.list(), ctx.provider.list()]);
      catalog = {
        providerName: new Map(providers.data.map((p) => [p.id, p.name])),
        providerEndpoint: new Map(providers.data.map((p) => [p.id, p.settings?.baseURL ?? ""])),
        modelName: new Map(models.data.map((m) => [catalogKey(m.providerID, m.id), m.name])),
      };
      catalogDirty = false;
      return catalog;
    };

    const currentCatalog = async (): Promise<Catalog> => {
      if (!catalog || catalogDirty) return await refreshCatalog();
      return catalog;
    };

    const onTransition = async (): Promise<void> => {
      armTimer(); // schedule the transition after this one
      const now = new Date();
      if (!isPeak(now, windows)) {
        const t = nextTransition(now, windows);
        const message = `DeepSeek off-peak started — 0.5x peak rates until ${formatClockUTC(t.at)}.`;
        await announce(
          { kind: "offpeak-start", title: "DeepSeek off-peak", message, variant: "success" },
          { type: "offpeak-start" },
          { send: true },
        );
        return;
      }
      // Peak just started: interrupt running DeepSeek sessions.
      const busy = [...busySessions];
      const aborted: string[] = [];
      const skipped: string[] = [];
      if (opts.abortOnPeak) {
        for (const id of busy) {
          const rec = sessionModels.get(id);
          // Sessions we never saw (started before the plugin loaded) are
          // interrupted conservatively; known proxies are left alone.
          const matched =
            !rec || shouldGuardDeepSeek(rec, { mode: opts.matchMode, extraNeedles: opts.match }).guard;
          if (!matched && !opts.abortAllOnPeak) {
            skipped.push(id);
            continue;
          }
          // `interrupted` is the server's own verdict: a session that already
          // finished answers false, so no liveness polling is needed.
          try {
            const res = await ctx.session.interrupt({ sessionID: id });
            if (res?.interrupted !== true) {
              skipped.push(id);
              continue;
            }
          } catch {
            skipped.push(id);
            continue;
          }
          aborted.push(id);
          await appendEvent(ledgerPath, {
            type: "aborted",
            session: id,
            model: rec ? `${rec.providerID}/${rec.modelId}` : "unknown",
            endpoint: rec ? hostOf(rec.baseURL) || "unknown" : "unknown",
          });
        }
      }
      busySessions.clear();
      const t = nextTransition(now, windows);
      const message =
        `DeepSeek peak hours started (until ${formatClockUTC(t.at)}). ` +
        (opts.abortOnPeak
          ? `Interrupted ${aborted.length} DeepSeek session(s)` +
            (skipped.length ? `, left ${skipped.length} other session(s) running` : "") +
            `. `
          : `Session abort is disabled (abortOnPeak=false). `) +
        `Off-peak rates resume at ${formatClockUTC(t.at)}.`;
      await announce(
        { kind: "peak-start", title: "DeepSeek peak hours", message, variant: "warning" },
        { type: "peak-start", aborted: aborted.length, skipped: skipped.length },
        { send: true },
      );
    };

    const onWarn = async (): Promise<void> => {
      // Heads-up shortly before a transition. Recomputes live, so a late
      // firing (e.g. after sleep) still reports correct numbers.
      const now = new Date();
      const tr = nextTransition(now, windows);
      const message =
        tr.to === "peak"
          ? `DeepSeek peak starts in ${formatDuration(tr.inMs)} (at ${formatClockUTC(tr.at)}) — wrap up DeepSeek work.`
          : `DeepSeek off-peak starts in ${formatDuration(tr.inMs)} (at ${formatClockUTC(tr.at)}) — 0.5x peak rates.`;
      await announce({ kind: "warn", title: "DeepSeek pricing", message, variant: "info" }, { type: "notice", notice: "transition-warning", message });
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

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          switch (event.type) {
            case "session.execution.started":
              busySessions.add(event.data.sessionID);
              break;
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
            case "session.idle":
              busySessions.delete(event.data.sessionID);
              break;
            case "session.deleted":
              busySessions.delete(event.data.sessionID);
              sessionModels.delete(event.data.sessionID);
              break;
            case "model.updated":
            case "provider.updated":
              catalogDirty = true;
              break;
          }
        }
      } catch {
        // The stream ends when the plugin unloads or the server goes away;
        // liveness data is best-effort and the guard does not depend on it.
      }
    })();

    await ctx.session.hook("model.request", async (event) => {
      const { sessionID, model, baseURL } = event;
      const catalog = await currentCatalog();
      const record: SessionRecord = {
        providerID: model.providerID,
        providerName: catalog.providerName.get(model.providerID) ?? "",
        modelId: model.id,
        modelName: catalog.modelName.get(catalogKey(model.providerID, model.id)) ?? "",
        baseURL: endpointOf({
          baseURL,
          provider: { settings: { baseURL: catalog.providerEndpoint.get(model.providerID) } },
        }),
      };
      sessionModels.set(sessionID, record);
      armTimer(); // re-arm on activity: heals the schedule after sleep/suspend

      const verdict = shouldGuardDeepSeek(record, { mode: opts.matchMode, extraNeedles: opts.match });
      if (!verdict.guard) return;
      const now = new Date();
      if (!isPeak(now, windows)) return;

      const s = status(now, windows);
      const label = `${record.providerID || "?"}/${record.modelId || "?"}`;
      const endpoint = hostOf(record.baseURL) || "unknown";
      const until = `until ${formatClockUTC(s.transition.at)}`;
      const call = event.kind === "primary" ? "request" : `${event.kind} request`;

      if (opts.mode === "warn") {
        const message = `DeepSeek peak hours: ${label} bills at 2x off-peak rates ${until}.`;
        await announce(
          { kind: "allowed-warn", title: "DeepSeek peak hours", message, variant: "warning" },
          { type: "allowed-warn", session: sessionID, model: label, endpoint, reason: verdict.reason },
        );
        return;
      }

      const message = [
        `DeepSeek peak hours — ${call} blocked by the deepseek-peak plugin.`,
        verdict.reason === "endpoint"
          ? `Model: ${label} via ${endpoint} (official API). Peak windows (UTC): ${describeWindows(windows)} — standard rates (2x off-peak) apply right now.`
          : `Model: ${label} (endpoint ${endpoint}, matched by name). Peak windows (UTC): ${describeWindows(windows)} — standard rates (2x off-peak) apply right now.`,
        `Off-peak starts at ${formatClockUTC(s.transition.at)} (in ${formatDuration(s.transition.inMs)}), rates drop to 0.5x peak.`,
        `Options: switch to a non-DeepSeek model, wait for off-peak, or relax the guard with`,
        `the plugin option mode:"warn" or the DEEPSEEK_PEAK_MODE=warn environment variable.`,
      ].join("\n");
      await announce(
        { kind: "blocked", title: "DeepSeek peak hours", message, variant: "error" },
        { type: "blocked", session: sessionID, model: label, endpoint, reason: verdict.reason },
      );
      throw new Error(message);
    });

    const s0 = status(new Date(), windows);
    await notice(
      `deepseek-peak active (mode=${opts.mode}, match=${opts.matchMode}, abortOnPeak=${opts.abortOnPeak}, ` +
        `warnBeforeMin=${opts.warnBeforeMin}, ledger=${ledgerPath ?? "off"}, notify=${opts.notifyUrl ? "on" : "off"}, ` +
        `source=${loaded.source}). ` +
        `Now: ${s0.peak ? "PEAK" : "OFF-PEAK"}; next change: ${s0.transition.to} at ` +
        `${formatTimeUTC(s0.transition.at)} (in ${formatDuration(s0.transition.inMs)}).`,
    );
    if (loaded.source === "cache" && cacheAgeDays(loaded.meta) > STALE_AFTER_DAYS) {
      await notice(
        `Schedule cache is older than ${STALE_AFTER_DAYS} days (fetched ${loaded.meta.fetchedAt ?? "unknown"}) — ` +
          `run \`deepseek-peak sync\` to refresh.`,
      );
    } else if (loaded.source === "builtin" && loaded.cacheIssue) {
      await notice(
        `Schedule cache ignored (${loaded.cacheIssue}) — using built-in defaults. Run \`deepseek-peak sync\` to refresh.`,
      );
    }
    armTimer();

    return async () => {
      events.abort();
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (warnTimer) clearTimeout(warnTimer);
      warnTimer = undefined;
      await rpc.dispose();
    };
  },
});
