#!/usr/bin/env node
/**
 * @fileoverview テスト用の偽 Pi RPC CLI。本物の Pi API は呼ばない。
 *
 * FAKE_PI_MODE=success|failure|hang
 */

import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.env.FAKE_PI_MODE ?? "success";
const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of readline) {
  const trimmed = line.trim();
  if (trimmed === "") {
    continue;
  }
  const message = JSON.parse(trimmed);
  if (message.type === "abort") {
    process.stdout.write(`${JSON.stringify({ type: "response", command: "abort", success: true, id: message.id })}\n`);
    break;
  }
  if (message.type !== "prompt") {
    continue;
  }
  if (mode === "hang") {
    mkdirSync(".symphony-agent", { recursive: true });
    writeFileSync(".symphony-agent/started", "started");
    await delay(30_000);
    break;
  }
  if (mode === "failure") {
    process.stdout.write(
      `${JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "nope" }],
            stopReason: "error",
            errorMessage: "boom",
          },
        ],
      })}\n`,
    );
    continue;
  }
  process.stdout.write(`${JSON.stringify({ type: "session", id: "pi-session-1" })}\n`);
  process.stdout.write(
    `${JSON.stringify({ id: message.id, type: "response", command: "prompt", success: true })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
        },
      ],
    })}\n`,
  );
}
