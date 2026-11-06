import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "vite";

await build({ configFile: false, logLevel: "silent", build: {
  lib: { entry: "src/main/script-runner.ts", formats: ["es"], fileName: () => "runner.mjs" },
  outDir: ".test-dist", minify: false,
} });
const { ScriptRunner } = await import("../.test-dist/runner.mjs");

function setup(editorType = "figma") {
  const messages = [];
  let commits = 0;
  globalThis.figma = {
    root: { id: "0:0" }, editorType, mode: "default",
    ui: { postMessage: msg => messages.push(msg) },
    commitUndo: () => { commits++; },
    triggerUndo: () => { throw new Error("Unsafe undo must never be called"); },
  };
  const runner = new ScriptRunner();
  runner.transport("session");
  const request = (id, code, timeout = 1000) => runner.request({
    type: "request_script_execution", requestId: id,
    params: { description: `Изменить ${id}`, code, executionTimeoutMs: timeout },
  }, "session");
  const card = id => messages.find(msg => msg.type === "script-card" && msg.card.requestId === id)?.card;
  const decide = (id, approve = true, changes = {}) => runner.decide({ ...card(id), approve, ...changes });
  const outcomes = () => messages.filter(msg => msg.type === "request_script_execution").map(msg => msg.data);
  return { runner, request, card, decide, messages, outcomes, commits: () => commits };
}

test("requires exact request, token, code and session; duplicate approval cannot rerun", async () => {
  const s = setup();
  await s.request("a", "figma.root.changed = true; await Promise.resolve(); return { id: figma.root.id };");
  assert.equal(figma.root.changed, undefined);
  await s.decide("a", true, { code: "return 1" });
  await s.decide("a", true, { token: "wrong" });
  await s.decide("a", true, { sessionId: "old" });
  assert.equal(s.outcomes().length, 0);
  await s.decide("a");
  await s.decide("a");
  assert.equal(figma.root.changed, true);
  assert.deepEqual(s.outcomes()[0], { requestId: "a", status: "success", result: { id: "0:0" } });
  assert.equal(s.outcomes().length, 1);
  assert.equal(s.commits(), 2);
});

test("rejection is separate and makes no undo entries or changes", async () => {
  const s = setup();
  await s.request("a", "throw new Error('must not run');");
  await s.decide("a", false);
  assert.deepEqual(s.outcomes(), [{ requestId: "a", status: "rejected" }]);
  assert.equal(s.commits(), 0);
});

test("captures bounded circular logs and error stack without global console replacement or rollback", async () => {
  const s = setup();
  const originalConsole = globalThis.console;
  await s.request("a", `const value = { n: 3 }; value.self = value;
    console.log(value); console.info(1); console.warn('w'); console.debug('d'); console.error('e');
    for (let i = 0; i < 1000; i++) console.log('x'.repeat(2000));
    figma.root.partial = true; throw new Error('partial failure');`);
  await s.decide("a");
  const outcome = s.outcomes()[0];
  assert.equal(outcome.status, "error");
  assert.equal(outcome.error.message, "partial failure");
  assert.match(outcome.error.stack, /partial failure/);
  const logs = s.messages.filter(msg => msg.type === "script-log");
  assert.equal(logs[0].data.args[0].self, "[Circular]");
  assert.ok(logs.length <= 201);
  assert.match(JSON.stringify(logs.at(-1)), /Log limit reached/);
  assert.equal(globalThis.console, originalConsole);
  assert.equal(figma.root.partial, true);
  assert.equal(s.commits(), 2);
});

test("scripts queue sequentially and timeout does not release a still-running script", async () => {
  const s = setup();
  let release;
  figma.wait = new Promise(resolve => { release = resolve; });
  await s.request("a", "await figma.wait; return 'late';", 100);
  await s.request("b", "return 'second';");
  const first = s.decide("a");
  assert.equal(s.card("b"), undefined);
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(s.outcomes()[0].status, "timeout");
  assert.equal(s.card("b"), undefined);
  release();
  await first;
  assert.ok(s.card("b"));
  await s.decide("b");
  assert.deepEqual(s.outcomes().map(o => o.status), ["timeout", "success"]);
});

test("disconnect invalidates pending approval, while a running script holds the lock across reconnect", async () => {
  const s = setup();
  let release;
  figma.wait = new Promise(resolve => { release = resolve; });
  await s.request("a", "await figma.wait; return 1;");
  await s.request("b", "figma.root.unwanted = true;");
  const run = s.decide("a");
  s.runner.transport(null);
  s.runner.transport("session");
  await s.decide("b");
  assert.equal(figma.root.unwanted, undefined);
  await s.request("c", "return 3;");
  assert.equal(s.card("c"), undefined);
  release();
  await run;
  assert.ok(s.card("c"));
  assert.equal(s.outcomes().find(o => o.requestId === "b").status, "unavailable");
});

test("Dev Mode rejects scripts without executing; capability probe uses actual injected figma", async () => {
  const s = setup("dev");
  await s.runner.status();
  await s.request("a", "figma.root.bad = true;");
  assert.equal(s.outcomes()[0].status, "unavailable");
  assert.equal(figma.root.bad, undefined);
  assert.equal(s.messages.find(m => m.type === "script-capability").supported, false);
});

test("runtime without Function support fails closed", async () => {
  const original = globalThis.Function;
  globalThis.Function = function () { throw new Error("disabled in runtime"); };
  let s;
  try { s = setup(); } finally { globalThis.Function = original; }
  await s.request("a", "figma.root.bad = true;");
  assert.equal(s.outcomes()[0].status, "unavailable");
  assert.match(s.outcomes()[0].error.message, /disabled in runtime/);
});

test("syntax errors and cyclic return values are returned as errors", async () => {
  const s = setup();
  await s.request("a", "return (;");
  await s.decide("a");
  await s.request("b", "const x = {}; x.self = x; return x;");
  await s.decide("b");
  assert.deepEqual(s.outcomes().map(o => o.status), ["error", "error"]);
});

test("hostile thrown values cannot break error delivery or deadlock the queue", async () => {
  const s = setup();
  await s.request("a", "throw Object.create(null);");
  await s.request("b", "const e = new Error(); e.message = null; throw e;");
  await s.request("c", "throw new Proxy({}, { get() { throw new Error('getter'); } });");
  for (const id of ["a", "b", "c"]) await s.decide(id);
  assert.deepEqual(s.outcomes().map(o => o.status), ["error", "error", "error"]);
  assert.ok(s.outcomes().every(o => typeof o.error.message === "string"));
  assert.equal(s.commits(), 6);
});
