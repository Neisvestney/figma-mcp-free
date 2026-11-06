import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { Bridge } from "../dist/bridge.js";
import { ScriptLogs } from "../dist/script-logs.js";
import { Follower } from "../dist/follower.js";
import { validateRpc } from "../dist/schema.js";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "figma-script-test-"));
  process.env.FIGMA_SCRIPT_LOG_DIR = directory;
  process.env.FIGMA_SCRIPT_TIMEOUT_MS = "100";
  const bridge = new Bridge();
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => bridge.handleUpgrade(req, socket, head));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const client = new WebSocket(url);
  await once(client, "open");
  t.after(() => { client.terminate(); bridge.close(); server.close(); });
  const send = (request, type, data) => client.send(JSON.stringify({ type, requestId: request.requestId, data }));
  const script = () => bridge.sendWithParams("request_script_execution", undefined, { description: "Изменить кнопку", code: "return 1;" });
  return { directory, bridge, client, url, send, script };
}

test("RPC validates script inputs and retains existing read validation", () => {
  assert.equal(validateRpc("request_script_execution", undefined, { description: "Кнопка", code: "await Promise.resolve();" }), null);
  assert.ok(validateRpc("request_script_execution", undefined, { description: "", code: " " }));
  assert.ok(validateRpc("request_script_execution", undefined, { description: "x", code: "x".repeat(100001) }));
  assert.equal(validateRpc("get_node", ["1:2"]), null);
  assert.ok(validateRpc("get_node", ["1-2"]));
});

test("approval has no bridge timeout; success and streamed logs persist as JSONL", async t => {
  const f = await fixture(t);
  const received = once(f.client, "message");
  let resolved = false;
  const response = f.script().then(value => { resolved = true; return value; });
  const request = JSON.parse((await received)[0].toString());
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(resolved, false);
  f.send(request, "script-started");
  f.send(request, "script-log", { timestamp: new Date().toISOString(), level: "info", args: ["hello"] });
  f.send(request, "request_script_execution", { requestId: request.requestId, status: "success", result: { id: "1:2" } });
  const { data } = await response;
  assert.equal(data.status, "success");
  assert.equal(path.isAbsolute(data.logsPath), true);
  assert.equal(data.logsTail[0].level, "info");
  const records = (await readFile(data.logsPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(r => r.event), ["request", "console", "outcome"]);
  assert.equal(records[2].result.id, "1:2");
});

test("timeout starts only after script-started and reports possible ongoing execution", async t => {
  const f = await fixture(t);
  const received = once(f.client, "message");
  const response = f.script();
  const request = JSON.parse((await received)[0].toString());
  f.send(request, "script-started");
  const { data } = await response;
  assert.equal(data.status, "timeout");
  assert.match(data.error.message, /may still be running/);
  f.send(request, "script-log", { timestamp: "late", level: "error", args: ["late failure"] });
  f.send(request, "script-settled", { requestId: request.requestId, status: "error", error: { message: "late failure", stack: "late stack" } });
  let final;
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    final = await readFile(data.logsPath, "utf8");
    if (final.includes("late stack")) break;
  }
  assert.match(final, /late failure/);
  assert.match(final, /late stack/);
  assert.equal(data.status, "timeout");
});

test("disconnect returns unknown with captured logs; reads still fail promptly", async t => {
  const f = await fixture(t);
  const received = once(f.client, "message");
  const response = f.script();
  const request = JSON.parse((await received)[0].toString());
  f.send(request, "script-log", { timestamp: "now", level: "warn", args: ["partial"] });
  const readFailure = assert.rejects(f.bridge.send("get_selection"), /disconnected/);
  f.client.close();
  const { data } = await response;
  await readFailure;
  assert.equal(data.status, "unknown");
  assert.equal(data.logsTail.length, 1);
  assert.match(await readFile(data.logsPath, "utf8"), /partial/);
});

test("normal completion after server timeout updates the log even without a plugin timeout event", async t => {
  const f = await fixture(t);
  const received = once(f.client, "message");
  const response = f.script();
  const request = JSON.parse((await received)[0].toString());
  f.send(request, "script-started");
  const { data } = await response;
  assert.equal(data.status, "timeout");
  f.send(request, "request_script_execution", { requestId: request.requestId, status: "success", result: "synchronous completion" });
  let final;
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    final = await readFile(data.logsPath, "utf8");
    if (final.includes("synchronous completion")) break;
  }
  assert.match(final, /synchronous completion/);
  assert.equal(data.status, "timeout");
});

test("replacement connection cannot complete an old request", async t => {
  const f = await fixture(t);
  const received = once(f.client, "message");
  const response = f.script();
  const request = JSON.parse((await received)[0].toString());
  const other = new WebSocket(f.url);
  t.after(() => other.terminate());
  await once(other, "open");
  other.send(JSON.stringify({ type: "request_script_execution", requestId: request.requestId,
    data: { requestId: request.requestId, status: "success", result: "forged" } }));
  assert.equal((await response).data.status, "unknown");
});

test("existing read tools still accept screenshot responses larger than 4 MiB", async t => {
  const f = await fixture(t);
  const received = once(f.client, "message");
  const response = f.bridge.send("get_screenshot");
  const request = JSON.parse((await received)[0].toString());
  f.send(request, "get_screenshot", { base64: "a".repeat(5 * 1024 * 1024) });
  assert.equal((await response).data.base64.length, 5 * 1024 * 1024);
});

test("log write failure preserves execution error, stack and tail", async t => {
  const f = await fixture(t);
  const blocked = path.join(f.directory, "file");
  await writeFile(blocked, "file, not directory");
  process.env.FIGMA_SCRIPT_LOG_DIR = blocked;
  const logs = new ScriptLogs();
  const reply = await logs.save({ requestId: randomUUID(), status: "error", error: { message: "partial failure", stack: "stack" } }, "x", []);
  assert.equal(reply.status, "error");
  assert.equal(reply.error.message, "partial failure");
  assert.equal(reply.error.stack, "stack");
  assert.match(reply.logsError, /persist/);
  assert.equal(path.isAbsolute(reply.logsPath), true);
});

test("log storage enforces file byte and retention count limits", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "figma-log-limits-"));
  process.env.FIGMA_SCRIPT_LOG_DIR = directory;
  process.env.FIGMA_SCRIPT_LOG_MAX_BYTES = "4096";
  process.env.FIGMA_SCRIPT_LOG_MAX_FILES = "2";
  const logs = new ScriptLogs();
  for (let i = 0; i < 4; i++) {
    const data = await logs.save({ requestId: randomUUID(), status: "success", result: "x".repeat(100_000) }, "x",
      Array.from({ length: 20 }, () => ({ timestamp: "now", level: "log", args: ["я".repeat(1000)] })));
    assert.equal(data.logsError, undefined);
    assert.ok((await stat(data.logsPath)).size <= 4096);
    (await readFile(data.logsPath, "utf8")).trim().split("\n").forEach(line => JSON.parse(line));
  }
  assert.equal((await readdir(directory)).length, 2);
  delete process.env.FIGMA_SCRIPT_LOG_MAX_BYTES;
  delete process.env.FIGMA_SCRIPT_LOG_MAX_FILES;
});

test("follower forwards scripts once and preserves outcome metadata", async t => {
  let count = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      count++;
      assert.equal(JSON.parse(body).tool, "request_script_execution");
      setTimeout(() => res.end(JSON.stringify({ data: { requestId: "id", status: "rejected", logsPath: "/logs/test", logsTail: [] } })), 120);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const follower = new Follower(`http://127.0.0.1:${server.address().port}`);
  const reply = await follower.sendWithParams("request_script_execution", undefined, { description: "x", code: "return 1" });
  assert.equal(reply.data.status, "rejected");
  assert.equal(reply.data.logsPath, "/logs/test");
  assert.equal(count, 1);
});
