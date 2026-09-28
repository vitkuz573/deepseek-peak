import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_DEEPSEEK_HOSTS,
  hostOf,
  nameMatches,
  providerBaseURL,
  endpointOf,
  shouldGuardDeepSeek,
} from "../lib/match.mjs";

describe("hostOf", () => {
  it("lowercases and strips ports/paths", () => {
    assert.equal(hostOf("HTTPS://API.DEEPSEEK.COM:443/v1"), "api.deepseek.com");
    assert.equal(hostOf("https://api.neutralbeats.com/v1"), "api.neutralbeats.com");
  });
  it("garbage in, empty string out", () => {
    assert.equal(hostOf("::::"), "");
    assert.equal(hostOf(""), "");
    assert.equal(hostOf(undefined), "");
    assert.equal(hostOf(null), "");
  });
});

describe("nameMatches", () => {
  it("matches case-insensitively, skips junk entries", () => {
    assert.equal(nameMatches(["neutralbeats-chat", "DeepSeek-V4.1-Flash"], ["deepseek"]), true);
    assert.equal(nameMatches(["neutralbeats-chat", "claude-haiku"], ["deepseek"]), false);
    assert.equal(nameMatches(["", undefined, null, 42], ["deepseek"]), false);
    assert.equal(nameMatches(["", "x"], ["X"]), true);
  });
});

describe("providerBaseURL", () => {
  const OFFICIAL = "https://api.deepseek.com";
  it("reads the V2 Provider.Info shape (settings.baseURL)", () => {
    assert.equal(providerBaseURL({ id: "deepseek", name: "DeepSeek", settings: { baseURL: OFFICIAL } }), OFFICIAL);
  });
  it("empty strings and junk yield unknown", () => {
    assert.equal(providerBaseURL({ settings: { baseURL: "" } }), "");
    assert.equal(providerBaseURL({ id: "deepseek" }), "");
    assert.equal(providerBaseURL({ settings: { baseURL: 42 } }), "");
    assert.equal(providerBaseURL({ settings: null }), "");
    assert.equal(providerBaseURL(null), "");
    assert.equal(providerBaseURL(undefined), "");
    assert.equal(providerBaseURL("https://api.deepseek.com"), "");
  });
});

describe("endpointOf", () => {
  const OFFICIAL = "https://api.deepseek.com";
  const PROXY = "https://api.neutralbeats.com/v1";
  it("prefers the request-scoped baseURL the server resolved", () => {
    assert.equal(
      endpointOf({ baseURL: PROXY, provider: { settings: { baseURL: OFFICIAL } } }),
      PROXY,
    );
  });
  it("falls back to the provider catalog entry", () => {
    assert.equal(endpointOf({ provider: { id: "deepseek", settings: { baseURL: OFFICIAL } } }), OFFICIAL);
  });
  it("ignores an empty request baseURL and keeps the catalog one", () => {
    assert.equal(endpointOf({ baseURL: "", provider: { settings: { baseURL: OFFICIAL } } }), OFFICIAL);
  });
  it("empty when neither source has an endpoint", () => {
    assert.equal(endpointOf({ provider: { id: "x", settings: {} } }), "");
    assert.equal(endpointOf(), "");
    assert.equal(endpointOf({}), "");
  });
});

describe("shouldGuardDeepSeek", () => {
  const OFFICIAL = "https://api.deepseek.com";
  const PROXY = "https://api.neutralbeats.com/v1";
  const cases = [
    // [name, info, options, expected]
    ["official endpoint blocks (endpoint mode)", { providerID: "deepseek", modelId: "deepseek-chat", baseURL: OFFICIAL }, { mode: "endpoint" }, { guard: true, reason: "endpoint" }],
    ["official endpoint from the provider catalog blocks", { providerID: "deepseek", modelId: "deepseek-flash", baseURL: OFFICIAL }, { mode: "endpoint" }, { guard: true, reason: "endpoint" }],
    ["flat-rate proxy passes (endpoint mode)", { providerID: "neutralbeats-chat", providerName: "", modelId: "deepseek-v4.1-flash", modelName: "", baseURL: PROXY }, { mode: "endpoint" }, { guard: false, reason: "proxy" }],
    ["non-deepseek on proxy passes", { providerID: "neutralbeats-chat", modelId: "claude-haiku", baseURL: PROXY }, { mode: "endpoint" }, { guard: false, reason: "proxy" }],
    ["unknown endpoint falls back to names (hit)", { providerID: "neutralbeats-chat", modelId: "deepseek-chat" }, { mode: "endpoint" }, { guard: true, reason: "name" }],
    ["unknown endpoint falls back to names (miss)", { providerID: "neutralbeats-chat", modelId: "claude-haiku" }, { mode: "endpoint" }, { guard: false, reason: "other" }],
    ["garbage baseURL counts as unknown", { providerID: "x", modelId: "deepseek-chat", baseURL: "::::" }, { mode: "endpoint" }, { guard: true, reason: "name" }],
    ["name mode blocks the proxy too", { providerID: "neutralbeats-chat", modelId: "deepseek-chat", baseURL: PROXY }, { mode: "name" }, { guard: true, reason: "name" }],
    ["name mode passes non-deepseek", { providerID: "neutralbeats-chat", modelId: "claude-haiku", baseURL: PROXY }, { mode: "name" }, { guard: false, reason: "other" }],
    ["both mode blocks the proxy", { providerID: "neutralbeats-chat", modelId: "deepseek-chat", baseURL: PROXY }, { mode: "both" }, { guard: true, reason: "name" }],
    ["both mode passes non-deepseek on proxy", { providerID: "neutralbeats-chat", modelId: "claude-haiku", baseURL: PROXY }, { mode: "both" }, { guard: false, reason: "other" }],
    ["official endpoint in name mode still matches by name", { providerID: "deepseek", modelId: "deepseek-chat", baseURL: OFFICIAL }, { mode: "name" }, { guard: true, reason: "name" }],
    ["extra needles apply to the name fallback", { providerID: "my-cloud", modelId: "my-llm-1" }, { mode: "endpoint", extraNeedles: ["my-llm"] }, { guard: true, reason: "name" }],
    ["known proxy wins over extra needles in endpoint mode", { providerID: "my-cloud", modelId: "my-llm-1", baseURL: PROXY }, { mode: "endpoint", extraNeedles: ["my-llm"] }, { guard: false, reason: "proxy" }],
    ["extra needles apply in name mode", { providerID: "my-cloud", modelId: "my-llm-1", baseURL: PROXY }, { mode: "name", extraNeedles: ["MY-LLM"] }, { guard: true, reason: "name" }],
  ];
  for (const [name, info, options, expected] of cases) {
    it(name, () => {
      assert.deepEqual(shouldGuardDeepSeek(info, options), expected);
    });
  }

  it("defaults: endpoint mode, no extra needles", () => {
    assert.deepEqual(
      shouldGuardDeepSeek({ providerID: "deepseek", modelId: "deepseek-chat" }),
      { guard: true, reason: "name" },
    );
    assert.deepEqual(shouldGuardDeepSeek({ providerID: "x", modelId: "y" }), { guard: false, reason: "other" });
  });

  it("official hosts list", () => {
    assert.deepEqual(OFFICIAL_DEEPSEEK_HOSTS, ["api.deepseek.com"]);
  });
});
