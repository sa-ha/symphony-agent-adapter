#!/usr/bin/env node
/**
 * @fileoverview テスト用の偽 Cursor CLI。本物の Cursor API は呼ばない。
 *
 * FAKE_CURSOR_MODE=success|auth|hang
 * FAKE_CURSOR_ARGS_LOG があれば argv を追記する。
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.env.FAKE_CURSOR_MODE ?? "success";
const argsLog = process.env.FAKE_CURSOR_ARGS_LOG;

if (typeof argsLog === "string" && argsLog !== "") {
  appendFileSync(argsLog, `${process.argv.slice(2).join(" ")}\n`);
}

if (mode === "auth") {
  process.stderr.write("Error: not logged in. Set CURSOR_API_KEY\n");
  process.exit(1);
}

if (mode === "hang") {
  mkdirSync(".symphony-agent", { recursive: true });
  writeFileSync(".symphony-agent/started", "started");
  await delay(30_000);
  process.exit(0);
}

process.stdout.write(
  `${JSON.stringify({ type: "system", subtype: "init", session_id: "cursor-session-1" })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    session_id: "cursor-session-1",
  })}\n`,
);
