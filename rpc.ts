// RPC definition for the deepseek-peak alert channel.
//
// The definition is the wire contract; the payload shape lives in
// lib/alerts.mjs so the server plugin, the TUI plugin and the tests all agree
// on one source of truth.

import { Rpc } from "@opencode/plugin/rpc";

export const DeepSeekPeak = Rpc.define({
  id: "deepseek-peak",
  methods: {},
  events: {
    alert: {
      schema: {
        type: "object",
        properties: {
          kind: { type: "string" },
          title: { type: "string" },
          message: { type: "string" },
          variant: { type: "string" },
        },
        required: ["kind", "title", "message", "variant"],
        additionalProperties: false,
      },
    },
  },
});
