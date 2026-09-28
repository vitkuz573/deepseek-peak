import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ALERT_KINDS, ALERT_VARIANTS, parseAlert } from "../lib/alerts.mjs";

const valid = {
  kind: "blocked",
  title: "DeepSeek peak hours",
  message: "request blocked",
  variant: "error",
};

describe("alert contract", () => {
  it("publishes a closed set of kinds and variants", () => {
    assert.deepEqual(ALERT_KINDS, ["blocked", "allowed-warn", "warn", "peak-start", "offpeak-start"]);
    assert.deepEqual(ALERT_VARIANTS, ["info", "success", "warning", "error"]);
  });
});

describe("parseAlert", () => {
  it("accepts a well-formed alert", () => {
    assert.deepEqual(parseAlert(valid), valid);
  });

  it("accepts every declared kind and variant", () => {
    for (const kind of ALERT_KINDS) {
      for (const variant of ALERT_VARIANTS) {
        assert.deepEqual(parseAlert({ ...valid, kind, variant }), { ...valid, kind, variant });
      }
    }
  });

  it("ignores extra properties the schema forbids anyway", () => {
    assert.deepEqual(parseAlert({ ...valid, extra: 1 }), valid);
  });

  it("rejects non-objects", () => {
    for (const input of [null, undefined, 42, "blocked", true]) {
      assert.equal(parseAlert(input), undefined, String(input));
    }
  });

  it("rejects an unknown kind or variant", () => {
    assert.equal(parseAlert({ ...valid, kind: "nope" }), undefined);
    assert.equal(parseAlert({ ...valid, kind: 7 }), undefined);
    assert.equal(parseAlert({ ...valid, variant: "nope" }), undefined);
    assert.equal(parseAlert({ ...valid, variant: 7 }), undefined);
  });

  it("requires every text field to be a string", () => {
    for (const field of ["kind", "title", "message", "variant"]) {
      assert.equal(parseAlert({ ...valid, [field]: undefined }), undefined, field);
      assert.equal(parseAlert({ ...valid, [field]: 7 }), undefined, field);
    }
  });
});
