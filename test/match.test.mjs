import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_DEEPSEEK_HOSTS,
  hostOf,
  nameMatches,
  providerBaseURL,
  modelApiURL,
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
  const PROXY = "https://api.neutralbeats.com/v1";
  it("reads the flat Provider.Info shape (current runtime)", () => {
    assert.equal(providerBaseURL({ id: "deepseek", options: { baseURL: OFFICIAL } }), OFFICIAL);
  });
  it("reads the wrapped ProviderContext shape (older types)", () => {
    assert.equal(
      providerBaseURL({ source: "config", info: { id: "deepseek", options: { baseURL: OFFICIAL } } }),
      OFFICIAL,
    );
  });
  it("prefers the top-level options over the wrapped ones", () => {
    assert.equal(
      providerBaseURL({ options: { baseURL: PROXY }, info: { options: { baseURL: OFFICIAL } } }),
      PROXY,
    );
  });
  it("empty strings and junk yield unknown", () => {
    assert.equal(providerBaseURL({ options: { baseURL: "" }, info: { options: {} } }), "");
    assert.equal(providerBaseURL({ source: "config" }), "");
    assert.equal(providerBaseURL({ options: { baseURL: 42 } }), "");
    assert.equal(providerBaseURL(null), "");
    assert.equal(providerBaseURL(undefined), "");
    assert.equal(providerBaseURL("https://api.deepseek.com"), "");
  });
});

describe("modelApiURL / endpointOf", () => {
  const OFFICIAL = "https://api.deepseek.com";
  const PROXY = "https://api.neutralbeats.com/v1";
  const model = (url) => ({ id: "deepseek-flash", providerID: "deepseek", api: { id: "deepseek-flash", url } });
  it("reads the model's canonical api.url", () => {
    assert.equal(modelApiURL(model("https://api.deepseek.com")), "https://api.deepseek.com");
    assert.equal(modelApiURL({}), "");
    assert.equal(modelApiURL({ api: { url: 42 } }), "");
    assert.equal(modelApiURL(null), "");
  });
  it("explicit provider baseURL wins over model api.url", () => {
    assert.equal(endpointOf({ options: { baseURL: PROXY } }, model("https://api.deepseek.com")), PROXY);
  });
  it("falls back to model api.url when the provider has no baseURL", () => {
    // The built-in deepseek provider: options carry no baseURL, only api.url.
    assert.equal(endpointOf({ id: "deepseek", options: {} }, model(OFFICIAL)), OFFICIAL);
    assert.equal(endpointOf({ source: "config" }, model(OFFICIAL)), OFFICIAL);
  });
  it("empty when neither source has an endpoint", () => {
    assert.equal(endpointOf({ options: {} }, {}), "");
  });
});

describe("shouldGuardDeepSeek", () => {
  const OFFICIAL = "https://api.deepseek.com";
  const PROXY = "https://api.neutralbeats.com/v1";
  const cases = [
    // [name, info, options, expected]
    ["official endpoint blocks (endpoint mode)", { providerID: "deepseek", modelId: "deepseek-chat", baseURL: OFFICIAL }, { mode: "endpoint" }, { guard: true, reason: "endpoint" }],
    ["official api.url blocks when baseURL is absent (built-in deepseek provider)", { providerID: "deepseek", modelId: "deepseek-flash", apiURL: OFFICIAL }, { mode: "endpoint" }, { guard: true, reason: "endpoint" }],
    ["explicit proxy baseURL wins over official api.url", { providerID: "deepseek", modelId: "deepseek-chat", baseURL: PROXY, apiURL: OFFICIAL }, { mode: "endpoint" }, { guard: false, reason: "proxy" }],
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
