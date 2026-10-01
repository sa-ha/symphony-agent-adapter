/**
 * @fileoverview Pi backend の process 実行テスト。本物の Pi API は呼ばない。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PiBackend } from "../src/backends/pi.js";
import { ERROR_ABNORMAL_EXIT, ERROR_CANCELLED } from "../src/errors.js";
import { fakePiPath, runSuccessfulTurn, startAdapter } from "./helpers.js";

/**
 * 偽 Pi CLI の起動 command。
 *
 * @returns {string}
 */
function fakePiCommand() {
  return `${process.execPath} ${fakePiPath}`;
}

test("pi success can run two turns on one RPC process", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "symphony-agent-pi-"));
  const backend = new PiBackend(fakePiCommand());
  try {
    process.env.FAKE_PI_MODE = "success";
    await backend.startSession(workspace);
    const first = await backend.runTurn("first prompt");
    assert.equal(first.lastMessage, "ok");
    const second = await backend.runTurn("second prompt");
    assert.equal(second.lastMessage, "ok");
  } finally {
    delete process.env.FAKE_PI_MODE;
    await backend.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("pi failure becomes a common abnormal-exit error", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "symphony-agent-pi-fail-"));
  const backend = new PiBackend(fakePiCommand());
  try {
    process.env.FAKE_PI_MODE = "failure";
    await backend.startSession(workspace);
    await assert.rejects(() => backend.runTurn("fail"), (error) => {
      assert.equal(error.code, ERROR_ABNORMAL_EXIT);
      assert.match(error.message, /boom/);
      return true;
    });
  } finally {
    delete process.env.FAKE_PI_MODE;
    await backend.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("pi cancellation stops a hanging RPC process", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "symphony-agent-pi-cancel-"));
  const backend = new PiBackend(fakePiCommand());
  try {
    process.env.FAKE_PI_MODE = "hang";
    await backend.startSession(workspace);
    const running = backend.runTurn("cancel");
    await waitForFile(path.join(workspace, ".symphony-agent", "started"));
    await backend.stop();
    await assert.rejects(() => running, (error) => error.code === ERROR_CANCELLED);
  } finally {
    delete process.env.FAKE_PI_MODE;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("pi adapter completes a Symphony handshake with a fake CLI", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "symphony-agent-pi-rpc-"));
  const client = startAdapter(["--kind", "pi", "--command", fakePiCommand()], {
    cwd: workspace,
    env: { FAKE_PI_MODE: "success" },
  });
  try {
    const messages = await runSuccessfulTurn(client, workspace, "ship it");
    const completed = messages.find((message) => message.method === "turn/completed");
    assert.ok(completed);
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
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}
