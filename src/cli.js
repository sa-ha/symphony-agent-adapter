#!/usr/bin/env node
/**
 * @fileoverview Symphony から見て Codex app-server に見える、Cursor / Pi 用の薄い adapter。
 *
 * ## 概要
 * vanilla Symphony（Elixir 公式 / symphony-ts）は `codex.command` で子プロセスを起動し、
 * stdio の JSON-RPC を話す。本 CLI がその契約を満たし、中で Cursor または Pi を起動する。
 *
 * ## 仕様
 * - `--kind cursor|pi` で backend を選ぶ
 * - `--command` で CLI 起動文字列を上書きできる
 * - model / provider / 認証は各 CLI 側の設定を使う
 *
 * ## 制限
 * - Codex の dynamic tool（linear_graphql 等）は橋渡ししない
 * - 対応 kind は cursor / pi / rdsh / fallback
 * - Symphony 本体の fork は不要
 */

import { pathToFileURL } from "node:url";
import { CursorBackend } from "./backends/cursor.js";
import { PiBackend } from "./backends/pi.js";
import { DshBackend } from "./backends/dsh.js";
import { FallbackBackend, DEFAULT_COOLDOWN_MS } from "./backends/fallback.js";
import { CodexAppServerShim } from "./appServer.js";
import { AdapterError, ERROR_UNKNOWN_KIND } from "./errors.js";

const HELP_TEXT = `symphony-agent-adapter

Codex app-server を装い、Cursor Agent または Pi を起動します。
Symphony 本体は改変せず、WORKFLOW.md の codex.command だけ差し替えます。

Usage:
  symphony-agent --kind cursor
  symphony-agent --kind pi
  symphony-agent --kind rdsh
  symphony-agent --kind fallback --primary cursor --secondary rdsh
  symphony-agent --kind cursor --command 'agent -p --output-format stream-json --trust --force'

Options:
  --kind <cursor|pi|rdsh|fallback>  必須。使う coding agent
  --command <string>   任意。agent CLI の起動 command（fallback では primary 用）
  --primary <kind>     fallback 用。既定 cursor
  --secondary <kind>   fallback 用。既定 rdsh。usage/rate limit 時にこちらで turn をやり直す
  --secondary-command <string>  任意。secondary の起動 command
  --cooldown-ms <n>    任意。上限検知後に新規 worker を secondary へ直行させる期間（既定 3600000、env SYMPHONY_FALLBACK_COOLDOWN_MS）
  --help               このメッセージ
`;

/**
 * argv から CLI 設定を読む。
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{kind: string, command: string | null, help: boolean}}
 */
export function parseCliArgs(argv) {
  let kind = "";
  let command = null;
  let help = false;
  let primary = "cursor";
  let secondary = "rdsh";
  let secondaryCommand = null;
  let cooldownMs = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--kind") {
      kind = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (token.startsWith("--kind=")) {
      kind = token.slice("--kind=".length);
      continue;
    }
    if (token === "--command") {
      command = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (token.startsWith("--command=")) {
      command = token.slice("--command=".length);
      continue;
    }
    const valued = { "--primary": "primary", "--secondary": "secondary", "--secondary-command": "secondaryCommand", "--cooldown-ms": "cooldownMs" };
    const [flag, inline] = token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, null];
    if (flag in valued) {
      const value = inline ?? argv[index + 1] ?? "";
      if (inline === null) index += 1;
      if (valued[flag] === "primary") primary = value;
      if (valued[flag] === "secondary") secondary = value;
      if (valued[flag] === "secondaryCommand") secondaryCommand = value;
      if (valued[flag] === "cooldownMs") cooldownMs = value;
    }
  }

  return {
    kind: kind.trim().toLowerCase(),
    command,
    help,
    primary: primary.trim().toLowerCase(),
    secondary: secondary.trim().toLowerCase(),
    secondaryCommand,
    cooldownMs,
  };
}

/**
 * kind から backend を作る。
 *
 * @param {string} kind
 * @param {string | null} command
 * @returns {CursorBackend | PiBackend}
 */
export function createBackend(kind, command, options = {}) {
  if (kind === "fallback") {
    const primaryKind = options.primary ?? "cursor";
    const secondaryKind = options.secondary ?? "rdsh";
    if (primaryKind === "fallback" || secondaryKind === "fallback" || primaryKind === secondaryKind) {
      throw new AdapterError(
        ERROR_UNKNOWN_KIND,
        `createBackend failed: invalid fallback pair primary=${primaryKind} secondary=${secondaryKind}.`,
        { functionName: "createBackend", kind, primaryKind, secondaryKind },
      );
    }
    const raw = options.cooldownMs ?? process.env.SYMPHONY_FALLBACK_COOLDOWN_MS;
    const parsed = Number(raw);
    const cooldownMs = raw !== undefined && raw !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_COOLDOWN_MS;
    return new FallbackBackend({
      primary: createBackend(primaryKind, command),
      secondary: createBackend(secondaryKind, options.secondaryCommand ?? null),
      cooldownMs,
    });
  }
  if (kind === "rdsh" || kind === "dsh") {
    return command ? new DshBackend(command) : new DshBackend();
  }
  if (kind === "cursor") {
    return command ? new CursorBackend(command) : new CursorBackend();
  }
  if (kind === "pi") {
    return command ? new PiBackend(command) : new PiBackend();
  }
  throw new AdapterError(
    ERROR_UNKNOWN_KIND,
    `createBackend failed: unknown kind=${JSON.stringify(kind)}. expected cursor, pi, rdsh or fallback.`,
    { functionName: "createBackend", kind, command },
  );
}

/**
 * CLI エントリポイント。
 *
 * @param {string[]} argv
 * @returns {number | void}
 */
export function main(argv) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (parsed.kind === "") {
    process.stderr.write("createBackend failed: --kind is required. expected cursor or pi.\n");
    process.stderr.write(HELP_TEXT);
    return 2;
  }

  const backend = createBackend(parsed.kind, parsed.command, parsed);
  const shim = new CodexAppServerShim({ backend });
  shim.start();
  return undefined;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    const exitCode = main(process.argv.slice(2));
    if (typeof exitCode === "number") {
      process.exit(exitCode);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }
}
