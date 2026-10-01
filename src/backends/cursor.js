/**
 * @fileoverview Cursor Agent CLI backend。
 *
 * 公式 headless CLI を 1 turn 1 process で起動する。
 * model / provider は Cursor 側設定を使い、ここには持ち込まない。
 *
 * @property {string} kind 固定値 "cursor"
 * @property {string} command 起動 command
 * @property {string | null} workspacePath 作業ディレクトリ
 * @property {string | null} sessionId resume 用 id
 * @property {import("node:child_process").ChildProcess | null} currentChild 実行中 process
 * @property {boolean} cancelled 取消済みなら true
 */

import {
  AdapterError,
  ERROR_CANCELLED,
  ERROR_MALFORMED_OUTPUT,
  ERROR_START_FAILED,
} from "../errors.js";
import {
  attachLineReader,
  classifyExit,
  ensureCommandAvailable,
  killChildProcess,
  startChildProcess,
} from "../processRunner.js";

/** @type {string} */
export const DEFAULT_CURSOR_COMMAND = "agent -p --output-format stream-json --trust --force";

export class CursorBackend {
  /**
   * @param {string} [command] 上書き command
   */
  constructor(command = DEFAULT_CURSOR_COMMAND) {
    this.kind = "cursor";
    this.command = command;
    this.workspacePath = null;
    this.sessionId = null;
    this.currentChild = null;
    this.cancelled = false;
  }

  /**
   * workspace を記録し、CLI の存在だけ確認する。process はまだ起動しない。
   *
   * @param {string} workspacePath Symphony から渡された cwd
   * @returns {Promise<void>}
   */
  async startSession(workspacePath) {
    this.workspacePath = workspacePath;
    this.cancelled = false;
    ensureCommandAvailable("CursorBackend.startSession", this.kind, this.command);
  }

  /**
   * 1 turn を実行する。前回の sessionId があれば `--resume` を付ける。
   *
   * @param {string} prompt turn 入力
   * @returns {Promise<{sessionId: string | null, lastMessage: string | null}>}
   */
  async runTurn(prompt) {
    if (this.cancelled) {
      throw new AdapterError(ERROR_CANCELLED, "CursorBackend.runTurn failed: already cancelled.", {
        functionName: "CursorBackend.runTurn",
        kind: this.kind,
        workspacePath: this.workspacePath,
      });
    }

    const resumeArgs =
      typeof this.sessionId === "string" && this.sessionId !== ""
        ? `--resume ${shellSingleQuote(this.sessionId)}`
        : "";
    const launchCommand = `${this.command} ${resumeArgs} -- "$SYMPHONY_AGENT_PROMPT"`;
    let child;
    try {
      child = startChildProcess({
        command: launchCommand,
        cwd: this.workspacePath ?? process.cwd(),
        env: { SYMPHONY_AGENT_PROMPT: prompt },
      });
    } catch (error) {
      throw new AdapterError(
        ERROR_START_FAILED,
        `CursorBackend.runTurn failed to spawn. kind=${this.kind} command=${launchCommand} error=${errorMessage(error)}`,
        { functionName: "CursorBackend.runTurn", kind: this.kind, command: launchCommand },
      );
    }

    this.currentChild = child;
    const stderrChunks = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });

    /** @type {string | null} */
    let lastMessage = null;
    let sawResult = false;
    let settled = false;

    const waitForExit = new Promise((resolve, reject) => {
      const settle = (handler, value) => {
        if (settled) {
          return;
        }
        settled = true;
        handler(value);
      };

      attachLineReader(child.stdout, (line) => {
        const payload = decodeJsonObject(line);
        if (payload === null) {
          return;
        }
        if (payload.type === "system" && typeof payload.session_id === "string") {
          this.sessionId = payload.session_id;
        }
        if (payload.type === "result") {
          sawResult = true;
          if (typeof payload.session_id === "string" && payload.session_id !== "") {
            this.sessionId = payload.session_id;
          }
          if (payload.is_error === true) {
            settle(
              reject,
              classifyExit(
                "CursorBackend.runTurn",
                this.kind,
                1,
                String(payload.result ?? "cursor result is_error=true"),
              ),
            );
          } else if (typeof payload.result === "string") {
            lastMessage = payload.result;
          }
        }
      });

      child.on("error", (error) => {
        settle(
          reject,
          new AdapterError(
            ERROR_START_FAILED,
            `CursorBackend.runTurn process error. kind=${this.kind} error=${errorMessage(error)}`,
            { functionName: "CursorBackend.runTurn", kind: this.kind },
          ),
        );
      });

      child.on("exit", (status) => {
        if (this.cancelled) {
          settle(
            reject,
            new AdapterError(ERROR_CANCELLED, "CursorBackend.runTurn failed: cancelled.", {
              functionName: "CursorBackend.runTurn",
              kind: this.kind,
            }),
          );
          return;
        }
        const stderr = stderrChunks.join("").trim();
        if (sawResult) {
          settle(resolve, { sessionId: this.sessionId, lastMessage });
          return;
        }
        if (stderr !== "") {
          settle(reject, classifyExit("CursorBackend.runTurn", this.kind, status, stderr));
          return;
        }
        if (status === 0) {
          settle(
            reject,
            new AdapterError(
              ERROR_MALFORMED_OUTPUT,
              `CursorBackend.runTurn failed: missing terminal result event. kind=${this.kind} status=${status} stderr=${stderr}`,
              { functionName: "CursorBackend.runTurn", kind: this.kind, status, stderr },
            ),
          );
          return;
        }
        settle(reject, classifyExit("CursorBackend.runTurn", this.kind, status, stderr));
      });
    });

    try {
      return await waitForExit;
    } finally {
      this.currentChild = null;
    }
  }

  /**
   * 実行中 process を止める。
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this.cancelled = true;
    killChildProcess(this.currentChild);
    this.currentChild = null;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function shellSingleQuote(value) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

/**
 * @param {string} line
 * @returns {Record<string, unknown> | null}
 */
function decodeJsonObject(line) {
  try {
    const payload = JSON.parse(line);
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      return payload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
