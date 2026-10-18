import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterError, ERROR_ABNORMAL_EXIT, ERROR_AUTH_MISSING, ERROR_USAGE_LIMIT, isUsageLimitText } from "../src/errors.js";
import { classifyExit } from "../src/processRunner.js";
import { FallbackBackend, createCooldownStore } from "../src/backends/fallback.js";
import { DshBackend } from "../src/backends/dsh.js";
import { createBackend, parseCliArgs } from "../src/cli.js";

const fakeDsh = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-dsh.mjs");

test("usage limit 文言を分類する", () => {
  for (const text of [
    "You've hit your usage limit",
    "Rate limit exceeded, try again later",
    "HTTP 429",
    "Too Many Requests",
    "quota exceeded for this API key",
    "RESOURCE_EXHAUSTED",
  ]) {
    assert.equal(isUsageLimitText(text), true, text);
    assert.equal(classifyExit("f", "cursor", 1, text).code, ERROR_USAGE_LIMIT, text);
  }
  assert.equal(isUsageLimitText("TypeError: x is undefined"), false);
  assert.equal(classifyExit("f", "cursor", 1, "Not logged in").code, ERROR_AUTH_MISSING);
  assert.equal(classifyExit("f", "cursor", 1, "boom").code, ERROR_ABNORMAL_EXIT);
});

function fakeBackend(kind, behaviour) {
  const calls = [];
  return {
    kind,
    calls,
    async startSession(ws) { calls.push(["start", ws]); },
    async runTurn(prompt) { calls.push(["turn", prompt]); return behaviour(prompt, calls); },
    async stop() { calls.push(["stop"]); },
  };
}

function tempStore(now = () => 1_000) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fb-"));
  return createCooldownStore({ path: path.join(dir, "state.json"), now });
}

test("usage limit なら secondary で同じ turn をやり直し、以後 secondary 固定", async () => {
  const primary = fakeBackend("cursor", () => { throw new AdapterError(ERROR_USAGE_LIMIT, "limit"); });
  const secondary = fakeBackend("rdsh", (p) => ({ sessionId: "s", lastMessage: `ok:${p}` }));
  const store = tempStore();
  const fb = new FallbackBackend({ primary, secondary, cooldownMs: 500, store, log: () => {} });
  await fb.startSession("/ws");
  assert.deepEqual(await fb.runTurn("t1"), { sessionId: "s", lastMessage: "ok:t1" });
  await fb.runTurn("t2");
  assert.equal(primary.calls.filter((c) => c[0] === "turn").length, 1);
  assert.deepEqual(secondary.calls.map((c) => c[0]), ["start", "turn", "turn"]);
  assert.equal(store.activeUntil(), 1_500);
});

test("usage limit 以外の失敗は fallback しない", async () => {
  const primary = fakeBackend("cursor", () => { throw new AdapterError(ERROR_ABNORMAL_EXIT, "boom"); });
  const secondary = fakeBackend("rdsh", () => ({ sessionId: null, lastMessage: "x" }));
  const store = tempStore();
  const fb = new FallbackBackend({ primary, secondary, store, log: () => {} });
  await fb.startSession("/ws");
  await assert.rejects(fb.runTurn("t"), (e) => e.code === ERROR_ABNORMAL_EXIT);
  assert.equal(secondary.calls.length, 0);
  assert.equal(store.activeUntil(), null);
});

test("cooldown 中に始まった worker は最初から secondary、期限後は primary", async () => {
  let clock = 1_000;
  const store = tempStore(() => clock);
  store.trip(1_000, "limit");
  const primary = fakeBackend("cursor", () => ({ sessionId: null, lastMessage: "p" }));
  const secondary = fakeBackend("rdsh", () => ({ sessionId: null, lastMessage: "s" }));
  const fb = new FallbackBackend({ primary, secondary, store, log: () => {} });
  await fb.startSession("/ws");
  assert.equal((await fb.runTurn("t")).lastMessage, "s");
  assert.equal(primary.calls.length, 0);

  clock = 3_000;
  const p2 = fakeBackend("cursor", () => ({ sessionId: null, lastMessage: "p" }));
  const s2 = fakeBackend("rdsh", () => ({ sessionId: null, lastMessage: "s" }));
  const fb2 = new FallbackBackend({ primary: p2, secondary: s2, store, log: () => {} });
  await fb2.startSession("/ws");
  assert.equal((await fb2.runTurn("t")).lastMessage, "p");
});

test("DshBackend は専用 key 必須で hermes 用 key を子に渡さない", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "dsh-ws-"));
  const none = new DshBackend(`${process.execPath} ${fakeDsh}`, {});
  await assert.rejects(none.startSession(ws), (e) => e.code === ERROR_AUTH_MISSING);

  process.env.OPENCODE_GO_API_KEY = "hermes-key";
  try {
    const dsh = new DshBackend(`${process.execPath} ${fakeDsh}`, { SYMPHONY_DSH_API_KEY: "dedicated" });
    await dsh.startSession(ws);
    const first = await dsh.runTurn("hello");
    assert.equal(first.lastMessage, "dsh:key:clean:hello");
    assert.equal(first.sessionId, "session-fake-1");
    await assert.rejects(dsh.runTurn("FAIL_429"), (e) => e.code === ERROR_USAGE_LIMIT);
  } finally {
    delete process.env.OPENCODE_GO_API_KEY;
  }
});

test("CLI の fallback 引数", () => {
  const parsed = parseCliArgs(["--kind", "fallback", "--primary", "cursor", "--secondary=rdsh", "--cooldown-ms", "60000"]);
  assert.equal(parsed.kind, "fallback");
  assert.equal(parsed.secondary, "rdsh");
  const backend = createBackend(parsed.kind, parsed.command, parsed);
  assert.equal(backend.kind, "fallback(cursor->rdsh)");
  assert.equal(backend.cooldownMs, 60000);
  assert.throws(() => createBackend("fallback", null, { primary: "rdsh", secondary: "rdsh" }));
});
