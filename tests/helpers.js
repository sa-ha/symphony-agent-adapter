/**
 * @fileoverview テスト用 JSON-RPC クライアント。本物の Symphony は起動しない。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const cliPath = path.join(repoRoot, "src", "cli.js");
export const fakeCursorPath = path.join(repoRoot, "tests", "fixtures", "fake-cursor.mjs");
export const fakePiPath = path.join(repoRoot, "tests", "fixtures", "fake-pi.mjs");

/**
 * adapter CLI を子 process として起動する。
 *
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {Record<string, string>} [options.env]
 * @returns {{child: import("node:child_process").ChildProcessWithoutNullStreams, send: Function, nextMessage: Function, collectUntil: Function, close: Function, waitForExit: Function, stderr: string[]}}
 */
export function startAdapter(args, options = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  /** @type {Record<string, unknown>[]} */
  const queue = [];
  /** @type {((message: Record<string, unknown>) => void)[]} */
  const waiters = [];
  const stderr = [];
  let pending = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    let newlineIndex = pending.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      if (line.trim() !== "") {
        const message = JSON.parse(line);
        const waiter = waiters.shift();
        if (waiter) {
          waiter(message);
        } else {
          queue.push(message);
        }
      }
      newlineIndex = pending.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
  });

  return {
    child,
    stderr,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    nextMessage() {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift());
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    async collectUntil(predicate, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      const messages = [];
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const message = await Promise.race([
          this.nextMessage(),
          delayReject(remaining, `timed out waiting for adapter JSON. stderr=${stderr.join("")}`),
        ]);
        messages.push(message);
        if (predicate(message)) {
          return messages;
        }
      }
      throw new Error(`collectUntil exceeded timeout. messages=${JSON.stringify(messages)}`);
    },
    close() {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
    waitForExit(timeoutMs = 3_000) {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`adapter did not exit. stderr=${stderr.join("")}`));
        }, timeoutMs);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/**
 * @param {object} client
 * @param {string} cwd
 * @param {string} prompt
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function runSuccessfulTurn(client, cwd, prompt) {
  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "test", version: "0" }, capabilities: {} },
  });
  const initialize = await client.nextMessage();
  client.send({ method: "initialized", params: {} });
  client.send({
    jsonrpc: "2.0",
    id: 2,
    method: "thread/start",
    params: { cwd, approvalPolicy: "never", sandbox: "workspace-write" },
  });
  const threadStart = await client.nextMessage();
  client.send({
    jsonrpc: "2.0",
    id: 3,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [{ type: "text", text: prompt }],
      cwd,
      title: "TEST-1: adapter",
    },
  });
  const turnStart = await client.nextMessage();
  const rest = await client.collectUntil((message) => message.method === "turn/completed" || message.method === "turn/failed");
  return [initialize, threadStart, turnStart, ...rest];
}

/**
 * @param {number} timeoutMs
 * @param {string} message
 * @returns {Promise<never>}
 */
function delayReject(timeoutMs, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), Math.max(timeoutMs, 1));
  });
}
