// Shared test helpers. This file is support code for tests, not part of the
// coverage gate (only lib/**, cli.mjs and opencode-plugin.ts are measured).

const pad2 = (n) => String(n).padStart(2, "0");

/** A 2-hour peak window starting at the current UTC hour (covers "now"). */
export function peakScheduleNow() {
  const now = new Date();
  const h = now.getUTCHours();
  return JSON.stringify([
    { days: [now.getUTCDay()], start: `${pad2(h)}:00`, end: `${pad2((h + 2) % 24)}:00` },
  ]);
}

/** A 2-hour window that never contains "now" (starts 4h ahead). */
export function offPeakScheduleNow() {
  const now = new Date();
  const h = now.getUTCHours();
  return JSON.stringify([
    { days: [now.getUTCDay()], start: `${pad2((h + 4) % 24)}:00`, end: `${pad2((h + 6) % 24)}:00` },
  ]);
}

export async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

/** Capture console.log/error while still forwarding everything to the real
 *  sinks (passthrough). The test runner's own TAP reporter breaks when
 *  console output is swallowed, so never swallow — only record. */
export function stubConsole() {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a) => {
    logs.push(a.join(" "));
    origLog(...a);
  };
  console.error = (...a) => {
    errors.push(a.join(" "));
    origError(...a);
  };
  return {
    logs,
    errors,
    restore() {
      console.log = origLog;
      console.error = origError;
    },
  };
}
