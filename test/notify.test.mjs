import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { notify } from "../lib/notify.mjs";

describe("notify", () => {
  let server;
  let url;
  let received = [];

  before(
    () =>
      new Promise((resolve) => {
        server = createServer((req, res) => {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            received.push({ headers: req.headers, body });
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
          });
        });
        server.listen(0, "127.0.0.1", () => {
          url = `http://127.0.0.1:${server.address().port}/hook`;
          resolve();
        });
      }),
  );

  after(() => new Promise((resolve) => server.close(resolve)));

  it("POSTs JSON and resolves true on 2xx", async () => {
    assert.equal(await notify(url, { service: "deepseek-peak", event: "peak-start" }), true);
    assert.equal(received.length, 1);
    assert.match(received[0].headers["content-type"], /application\/json/);
    assert.deepEqual(JSON.parse(received[0].body), { service: "deepseek-peak", event: "peak-start" });
  });

  it("never throws: bad url, closed port, empty url", async () => {
    assert.equal(await notify("http://127.0.0.1:1/closed", { a: 1 }, { timeoutMs: 500 }), false);
    assert.equal(await notify("not a url", { a: 1 }), false);
    assert.equal(await notify("", { a: 1 }), false);
  });
});
