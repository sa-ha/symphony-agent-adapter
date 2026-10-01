/**
 * @fileoverview Codex app-server handshake のテスト。backend は fake。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { CodexAppServerShim, extractPrompt } from "../src/appServer.js";

/**
 * テスト用 backend。本物の Cursor / Pi は呼ばない。
 *
 * @property {string[]} startedWorkspaces 渡された workspace
 * @property {string[]} prompts 渡された prompt
 * @property {boolean} stopped stop 済みなら true
 * @property {boolean} failNext 次の turn を失敗させるなら true
 */
class FakeBackend {
  /**
   * 空の記録用 backend を作る。
   */
  constructor() {
    this.startedWorkspaces = [];
    this.prompts = [];
    this.stopped = false;
    this.failNext = false;
  }

  /**
   * workspace を記録する。
   *
   * @param {string} workspacePath
   * @returns {Promise<void>}
   */
  async startSession(workspacePath) {
    this.startedWorkspaces.push(workspacePath);
  }

  /**
   * prompt を記録し、成功または失敗を返す。
   *
   * @param {string} prompt
   * @returns {Promise<{sessionId: string, lastMessage: string}>}
   */
  async runTurn(prompt) {
    this.prompts.push(prompt);
    if (this.failNext) {
      const error = new Error("boom");
      error.code = "agentAbnormalExit";
      throw error;
    }
    return { sessionId: "fake-session", lastMessage: "ok" };
  }

  /**
   * 停止済みフラグを立てる。
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this.stopped = true;
  }
}

/**
 * @param {FakeBackend} backend
 * @returns {{shim: CodexAppServerShim, stdin: PassThrough, stdoutLines: string[]}}
 */
function startShim(backend) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stdoutLines = [];
  let pending = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk) => {
    pending += chunk;
    let newlineIndex = pending.indexOf("\n");
    while (newlineIndex !== -1) {
      stdoutLines.push(pending.slice(0, newlineIndex));
      pending = pending.slice(newlineIndex + 1);
      newlineIndex = pending.indexOf("\n");
    }
  });
  const shim = new CodexAppServerShim({ backend, stdin, stdout });
  shim.start();
  return { shim, stdin, stdoutLines };
}

test("extractPrompt reads Symphony turn/start input text", () => {
  const prompt = extractPrompt({
    input: [{ type: "text", text: "implement the ticket" }],
    cwd: "/tmp/workspace",
  });
  assert.equal(prompt, "implement the ticket");
});

test("handshake answers initialize, thread/start, turn/start, then turn/completed", async () => {
  const backend = new FakeBackend();
  const { stdin, stdoutLines } = startShim(backend);

  stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
  stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  stdin.write(
    `${JSON.stringify({ id: 2, method: "thread/start", params: { cwd: "/tmp/issue-workspace" } })}\n`,
  );
  await waitUntil(() => stdoutLines.length >= 2);

  stdin.write(
    `${JSON.stringify({
      id: 3,
      method: "turn/start",
      params: { input: [{ type: "text", text: "first prompt" }], cwd: "/tmp/issue-workspace" },
    })}\n`,
  );
  await waitUntil(() => stdoutLines.some((line) => line.includes("turn/completed")));

  const messages = stdoutLines.map((line) => JSON.parse(line));
  assert.deepEqual(messages[0], { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(messages[1].result.thread.id, "symphony-agent-thread");
  assert.match(messages[2].result.turn.id, /^turn-/);
  const completed = messages.find((message) => message.method === "turn/completed");
  assert.equal(completed.params.lastMessage, "ok");
  assert.deepEqual(backend.startedWorkspaces, ["/tmp/issue-workspace"]);
  assert.deepEqual(backend.prompts, ["first prompt"]);
});

test("backend failure becomes turn/failed", async () => {
  const backend = new FakeBackend();
  backend.failNext = true;
  const { stdin, stdoutLines } = startShim(backend);

  stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
  stdin.write(`${JSON.stringify({ id: 2, method: "thread/start", params: { cwd: "/tmp/ws" } })}\n`);
  await waitUntil(() => stdoutLines.length >= 2);
  stdin.write(
    `${JSON.stringify({
      id: 3,
      method: "turn/start",
      params: { input: [{ type: "text", text: "fail" }] },
    })}\n`,
  );
  await waitUntil(() => stdoutLines.some((line) => line.includes("turn/failed")));
  const failed = stdoutLines.map((line) => JSON.parse(line)).find((message) => message.method === "turn/failed");
  assert.equal(failed.params.code, "agentAbnormalExit");
});

/**
 * @param {() => boolean} predicate
 * @returns {Promise<void>}
 */
async function waitUntil(predicate) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitUntil timed out");
}
