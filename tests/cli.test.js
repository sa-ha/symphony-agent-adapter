/**
 * @fileoverview CLI 引数と kind 解決のテスト。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createBackend, parseCliArgs } from "../src/cli.js";
import { CursorBackend } from "../src/backends/cursor.js";
import { PiBackend } from "../src/backends/pi.js";
import { ERROR_UNKNOWN_KIND } from "../src/errors.js";
import { cliPath } from "./helpers.js";

test("parseCliArgs reads kind and command", () => {
  assert.deepEqual(parseCliArgs(["--kind", "cursor"]), { kind: "cursor", command: null, help: false });
  assert.deepEqual(parseCliArgs(["--kind=pi", "--command", "pi --mode rpc"]), {
    kind: "pi",
    command: "pi --mode rpc",
    help: false,
  });
});

test("missing kind is a configuration error", () => {
  const result = spawnSync(process.execPath, [cliPath], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--kind is required/);
});

test("unknown kind is a clear configuration error", () => {
  const result = spawnSync(process.execPath, [cliPath, "--kind", "grok"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown kind="grok"/);
  assert.match(result.stderr, /cursor or pi/);
  assert.throws(
    () => createBackend("grok", null),
    (error) => error.code === ERROR_UNKNOWN_KIND,
  );
});

test("createBackend selects cursor or pi", () => {
  assert.equal(createBackend("cursor", null) instanceof CursorBackend, true);
  assert.equal(createBackend("pi", "pi --mode rpc") instanceof PiBackend, true);
});
