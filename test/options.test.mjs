import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { boolOpt, numOpt, resolveOptions } from "../lib/options.mjs";

const ENV_KEYS = [
  "DEEPSEEK_PEAK_DISABLE",
  "DEEPSEEK_PEAK_MODE",
  "DEEPSEEK_PEAK_ABORT",
  "DEEPSEEK_PEAK_ABORT_ALL",
  "DEEPSEEK_PEAK_TOAST",
  "DEEPSEEK_PEAK_LOG",
  "DEEPSEEK_PEAK_MATCH",
  "DEEPSEEK_PEAK_WARN_BEFORE",
  "DEEPSEEK_PEAK_NOTIFY_URL",
];

const cleanEnv = () => Object.fromEntries(ENV_KEYS.map((k) => [k, undefined]));

describe("boolOpt", () => {
  it("passes real booleans through", () => {
    assert.equal(boolOpt(true), true);
    assert.equal(boolOpt(false), false);
  });
  it("parses the usual textual spellings", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "on"]) assert.equal(boolOpt(v), true, v);
    for (const v of ["0", "false", "No", " off "]) assert.equal(boolOpt(v), false, v);
  });
  it("says nothing about values it cannot read", () => {
    assert.equal(boolOpt("maybe"), undefined);
    assert.equal(boolOpt(""), undefined);
    assert.equal(boolOpt(1), undefined);
    assert.equal(boolOpt(null), undefined);
    assert.equal(boolOpt(undefined), undefined);
    assert.equal(boolOpt({}), undefined);
  });
});

describe("numOpt", () => {
  it("passes finite numbers through", () => {
    assert.equal(numOpt(0), 0);
    assert.equal(numOpt(12.5), 12.5);
  });
  it("parses numeric strings", () => {
    assert.equal(numOpt("30"), 30);
    assert.equal(numOpt(" 7 "), 7);
  });
  it("rejects anything else", () => {
    assert.equal(numOpt("soon"), undefined);
    assert.equal(numOpt(""), undefined);
    assert.equal(numOpt("  "), undefined);
    assert.equal(numOpt(NaN), undefined);
    assert.equal(numOpt(Infinity), undefined);
    assert.equal(numOpt(true), undefined);
    assert.equal(numOpt(null), undefined);
    assert.equal(numOpt(undefined), undefined);
  });
});

describe("resolveOptions", () => {
  const resolve = (raw, env = {}) => resolveOptions(raw, { ...cleanEnv(), ...env });

  it("applies documented defaults", () => {
    assert.deepEqual(resolve(undefined), {
      disabled: false,
      mode: "block",
      abortOnPeak: true,
      abortAllOnPeak: false,
      toast: true,
      log: true,
      match: [],
      matchMode: "endpoint",
      warnBeforeMin: 10,
      ledger: true,
      notifyUrl: "",
    });
  });

  it("takes every option from the config object", () => {
    const opts = resolve({
      disabled: true,
      mode: "warn",
      abortOnPeak: false,
      abortAllOnPeak: true,
      toast: false,
      log: false,
      match: ["a", "", 7, null],
      matchMode: "both",
      warnBeforeMin: 3,
      ledger: "/tmp/ledger.jsonl",
      notifyUrl: "https://example.test/hook",
    });
    assert.equal(opts.disabled, true);
    assert.equal(opts.mode, "warn");
    assert.equal(opts.abortOnPeak, false);
    assert.equal(opts.abortAllOnPeak, true);
    assert.equal(opts.toast, false);
    assert.equal(opts.log, false);
    assert.deepEqual(opts.match, ["a"], "only non-empty strings are needles");
    assert.equal(opts.matchMode, "both");
    assert.equal(opts.warnBeforeMin, 3);
    assert.equal(opts.ledger, "/tmp/ledger.jsonl");
    assert.equal(opts.notifyUrl, "https://example.test/hook");
  });

  it("falls back to the environment for anything the config omits", () => {
    const opts = resolve({}, {
      DEEPSEEK_PEAK_DISABLE: "1",
      DEEPSEEK_PEAK_MODE: "warn",
      DEEPSEEK_PEAK_ABORT: "0",
      DEEPSEEK_PEAK_ABORT_ALL: "yes",
      DEEPSEEK_PEAK_TOAST: "off",
      DEEPSEEK_PEAK_LOG: "no",
      DEEPSEEK_PEAK_MATCH: "name",
      DEEPSEEK_PEAK_WARN_BEFORE: "15",
      DEEPSEEK_PEAK_NOTIFY_URL: "https://env.test/hook",
    });
    assert.equal(opts.disabled, true);
    assert.equal(opts.mode, "warn");
    assert.equal(opts.abortOnPeak, false);
    assert.equal(opts.abortAllOnPeak, true);
    assert.equal(opts.toast, false);
    assert.equal(opts.log, false);
    assert.equal(opts.matchMode, "name");
    assert.equal(opts.warnBeforeMin, 15);
    assert.equal(opts.notifyUrl, "https://env.test/hook");
  });

  it("lets the config win over the environment", () => {
    const opts = resolve({ mode: "block", abortOnPeak: true }, {
      DEEPSEEK_PEAK_MODE: "warn",
      DEEPSEEK_PEAK_ABORT: "0",
    });
    assert.equal(opts.mode, "block");
    assert.equal(opts.abortOnPeak, true);
  });

  it("rejects unusable mode and matchMode values", () => {
    assert.equal(resolve({ mode: "nope" }).mode, "block", "only warn is accepted");
    assert.equal(resolve({ matchMode: "nope" }).matchMode, "endpoint");
    assert.equal(resolve({ mode: 7 }).mode, "block");
    assert.equal(resolve({ matchMode: 7 }).matchMode, "endpoint");
  });

  it("accepts a real matchMode casing from the environment", () => {
    assert.equal(resolve({}, { DEEPSEEK_PEAK_MATCH: "both" }).matchMode, "both");
  });

  it("clamps warnBeforeMin at zero", () => {
    assert.equal(resolve({ warnBeforeMin: -5 }).warnBeforeMin, 0);
    assert.equal(resolve({}, { DEEPSEEK_PEAK_WARN_BEFORE: "-5" }).warnBeforeMin, 0);
  });

  it("keeps only boolean and string ledger settings", () => {
    assert.equal(resolve({ ledger: false }).ledger, false);
    assert.equal(resolve({ ledger: true }).ledger, true);
    assert.equal(resolve({ ledger: 0 }).ledger, true, "numbers are not a ledger setting");
    assert.equal(resolve({ ledger: "  " }).ledger, "  ", "a string is passed to the path resolver");
  });

  it("ignores an empty notifyUrl in the config and uses the environment", () => {
    assert.equal(resolve({ notifyUrl: "" }, { DEEPSEEK_PEAK_NOTIFY_URL: "https://env.test" }).notifyUrl,
      "https://env.test");
    assert.equal(resolve({ notifyUrl: 7 }, { DEEPSEEK_PEAK_NOTIFY_URL: "https://env.test" }).notifyUrl,
      "https://env.test");
  });

  it("reads process.env when no environment is passed", () => {
    const previous = process.env.DEEPSEEK_PEAK_MODE;
    process.env.DEEPSEEK_PEAK_MODE = "warn";
    try {
      assert.equal(resolveOptions({}).mode, "warn");
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_PEAK_MODE;
      else process.env.DEEPSEEK_PEAK_MODE = previous;
    }
  });
});
