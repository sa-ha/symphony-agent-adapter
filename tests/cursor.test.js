/**
 * @fileoverview Cursor backend の process 実行テスト。本物の Cursor API は呼ばない。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CursorBackend } from "../src/backends/cursor.js";
import { ERROR_AUTH_MISSING, ERROR_CANCELLED, ERROR_CLI_NOT_FOUND } from "../src/errors.js";
import { fakeCursorPath, runSuccessfulTurn, startAdapter } from "./helpers.js";

/**
 * 偽 Cursor CLI の起動 command。
 *
 * @returns {string}
 */
function fakeCursorCommand() {
  return `${process.execPath} ${fakeCursorPath}`;
}

test("cursor success and resume pass --resume on the second turn", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "symphony-agent-cursor-"));
  const argsLog = path.join(workspace, "args.log");
  const backend = new CursorBackend(fakeCursorCommand());
  try {
    process.env.FAKE_CURSOR_MODE = "success";
    process.env.FAKE_CURSOR_ARGS_LOG = argsLog;
    await backend.startSession(workspace);
    const first = await backend.runTurn("first prompt");
    assert.equal(first.sessionId, "cursor-session-1");
    const second = await backend.runTurn("second prompt");
    assert.equal(second.sessionId, "cursor-session-1");
    const args = readFileSync(argsLog, "utf8");
    assert.match(args, /first prompt/);
    assert.match(args, /--resume/);
    assert.match(args, /cursor-session-1/);
  } finally {
    delete process.env.FAKE_CURSOR_MODE;
    delete process.env.FAKE_CURSOR_ARGS_LOG;
    await backend.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("cursor authentication failure is a common auth error", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "symphony-agent-cursor-auth-"));
  const backend = new CursorBackend(fakeCursorCommand());
  try {
    process.env.FAKE_CURSOR_MODE = "auth";
    await backend.startSession(workspace);
    await assert.rejects(() => backend.runTurn("auth"), (error) => {
      assert.equal(error.code, ERROR_AUTH_MISSING);
      assert.match(error.message, /CURSOR_API_KEY/);
      return true;
    });
  } finally {
    delete process.env.FAKE_CURSOR_MODE;
    await backend.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("cursor cancellation stops a hanging process", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "symphony-agent-cursor-cancel-"));
  const backend = new CursorBackend(fakeCursorCommand());
  try {
    process.env.FAKE_CURSOR_MODE = "hang";
    await backend.startSession(workspace);
    const running = backend.runTurn("cancel");
    await waitForFile(path.join(workspace, ".symphony-agent", "started"));
    await backend.stop();
    await assert.rejects(() => running, (error) => error.code === ERROR_CANCELLED);
  } finally {
    delete process.env.FAKE_CURSOR_MODE;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("cursor missing CLI is a configuration error", async () => {
  const backend = new CursorBackend("/tmp/missing-cursor-agent-binary");
  await assert.rejects(
    () => backend.startSession(process.cwd()),
    (error) => error.code === ERROR_CLI_NOT_FOUND,
  );
});

test("cursor adapter completes a Symphony handshake with a fake CLI", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "symphony-agent-cursor-rpc-"));
  const client = startAdapter(["--kind", "cursor", "--command", fakeCursorCommand()], {
    cwd: workspace,
    env: { FAKE_CURSOR_MODE: "success" },
  });
  try {
    const messages = await runSuccessfulTurn(client, workspace, "ship it");
    const completed = messages.find((message) => message.method === "turn/completed");
    assert.equal(completed.params.lastMessage, "ok");
    client.close();
    await client.waitForExit();
  } finally {
    client.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

/**
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function waitForFile(filePath) {
  const { existsSync } = await import("node:fs");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}
