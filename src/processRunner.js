/**
 * @fileoverview Agent CLI の存在確認・起動・行読み取り・process group 終了。
 *
 * Symphony と同じく `bash -lc` で command 文字列を実行する。
 * stdout は LF 区切り JSON、stderr は別 stream で回収する。
 *
 * @module processRunner
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  AdapterError,
  ERROR_ABNORMAL_EXIT,
  ERROR_AUTH_MISSING,
  ERROR_CLI_NOT_FOUND,
} from "./errors.js";

/**
 * command 先頭 token が実行可能か確認する。
 *
 * @param {string} functionName 呼び出し元（error メッセージ用）
 * @param {string} kind agent kind
 * @param {string} command 起動 command
 * @returns {string} 解決した実行ファイル path または先頭 token
 */
export function ensureCommandAvailable(functionName, kind, command) {
  const token = String(command ?? "").trim().split(/\s+/, 1)[0] ?? "";
  if (token === "") {
    throw new AdapterError(ERROR_CLI_NOT_FOUND, `${functionName} failed: empty command. kind=${kind}`, {
      functionName,
      kind,
      command,
    });
  }

  if (token.includes("/") || token.startsWith(".")) {
    const resolved = path.resolve(token);
    if (!existsSync(resolved)) {
      throw new AdapterError(
        ERROR_CLI_NOT_FOUND,
        `${functionName} failed: executable not found. kind=${kind} command=${command} resolved=${resolved}`,
        { functionName, kind, command, resolved },
      );
    }
    return resolved;
  }

  try {
    const found = execFileSync("which", [token], { encoding: "utf8" }).trim();
    if (found !== "") {
      return found;
    }
  } catch {
    // PATH に無い
  }

  throw new AdapterError(
    ERROR_CLI_NOT_FOUND,
    `${functionName} failed: executable not on PATH. kind=${kind} command=${command} token=${token}`,
    { functionName, kind, command, token },
  );
}

/**
 * bash -lc で CLI を起動する。
 *
 * @param {object} options 起動パラメータ
 * @param {string} options.command shell command
 * @param {string} options.cwd working directory
 * @param {Record<string, string>} [options.env] 追加環境変数
 * @returns {import("node:child_process").ChildProcessWithoutNullStreams}
 */
export function startChildProcess(options) {
  const command = options.command;
  const cwd = options.cwd;
  const extraEnv = options.env ?? {};
  const bash = execFileSync("which", ["bash"], { encoding: "utf8" }).trim();
  // detached と setsid を重ねると、既に process group leader の setsid が
  // fork して親だけ抜け、Node が追跡している pid が先に死ぬ。
  const launchCommand = `exec setsid ${command}`;

  return spawn(bash, ["-lc", launchCommand], {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * stdout を LF 区切りで callback する。
 *
 * @param {import("node:stream").Readable} stream stdout
 * @param {(line: string) => void} onLine 1 行ごとの callback
 * @returns {() => string} 未消費 buffer を返す flush 関数
 */
export function attachLineReader(stream, onLine) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    let newlineIndex = pending.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      if (line.trim() !== "") {
        onLine(line);
      }
      newlineIndex = pending.indexOf("\n");
    }
  });
  return () => pending;
}

/**
 * process group ごと終了する。
 *
 * @param {import("node:child_process").ChildProcess | null} child 対象 process
 * @returns {void}
 */
export function killChildProcess(child) {
  if (child === null || child.killed || child.pid === undefined) {
    return;
  }
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // 既に死んでいる
    }
  }
}

/**
 * 終了 code と stderr を共通 error へ変換する。
 *
 * @param {string} functionName 呼び出し元
 * @param {string} kind agent kind
 * @param {number | null} status exit code
 * @param {string} stderr stderr 全文
 * @returns {AdapterError}
 */
export function classifyExit(functionName, kind, status, stderr) {
  const details = { functionName, kind, status, stderr };
  if (isAuthMissingText(stderr)) {
    return new AdapterError(
      ERROR_AUTH_MISSING,
      `${functionName} failed: authentication is not configured. kind=${kind} stderr=${stderr}`,
      details,
    );
  }
  if (status === 127 || isCommandNotFoundText(stderr)) {
    return new AdapterError(
      ERROR_CLI_NOT_FOUND,
      `${functionName} failed: CLI not found. kind=${kind} status=${status} stderr=${stderr}`,
      details,
    );
  }
  return new AdapterError(
    ERROR_ABNORMAL_EXIT,
    `${functionName} failed: abnormal exit. kind=${kind} status=${status} stderr=${stderr}`,
    details,
  );
}

/**
 * @param {string} stderr
 * @returns {boolean}
 */
function isAuthMissingText(stderr) {
  return /not logged in|unauthori[sz]ed|authentication|api[_ -]?key|CURSOR_API_KEY|please (log|sign) in/i.test(
    stderr,
  );
}

/**
 * @param {string} stderr
 * @returns {boolean}
 */
function isCommandNotFoundText(stderr) {
  return /command not found|No such file or directory/i.test(stderr);
}
