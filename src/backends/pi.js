/**
 * @fileoverview Pi coding agent の公式 RPC backend。
 *
 * `pi --mode rpc` を長寿命 process として起動し、prompt / abort だけを扱う。
 * model / provider は Pi 自身の設定に任せ、ここには持ち込まない。
 *
 * @property {string} kind 固定値 "pi"
 * @property {string} command 起動 command
 * @property {string | null} workspacePath 作業ディレクトリ
 * @property {string | null} sessionId Pi session id
 * @property {import("node:child_process").ChildProcess | null} child RPC process
 * @property {boolean} cancelled 取消済みなら true
 */

import {
  AdapterError,
  ERROR_ABNORMAL_EXIT,
  ERROR_CANCELLED,
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
export const DEFAULT_PI_COMMAND = "pi --mode rpc --session-dir .symphony-agent/pi-session";

export class PiBackend {
  /**
   * @param {string} [command] 上書き command
   */
  constructor(command = DEFAULT_PI_COMMAND) {
    this.kind = "pi";
    this.command = command;
    this.workspacePath = null;
    this.sessionId = null;
    this.child = null;
    this.cancelled = false;
    /** @type {((payload: Record<string, unknown>) => void) | null} */
    this.turnHandler = null;
    this.stderrChunks = [];
    this.exitError = null;
  }

  /**
   * Pi RPC process を workspace で起動する。
   *
   * @param {string} workspacePath Symphony から渡された cwd
   * @returns {Promise<void>}
   */
  async startSession(workspacePath) {
    this.workspacePath = workspacePath;
    this.cancelled = false;
    ensureCommandAvailable("PiBackend.startSession", this.kind, this.command);

    let child;
    try {
      child = startChildProcess({
        command: this.command,
        cwd: workspacePath,
      });
    } catch (error) {
      throw new AdapterError(
        ERROR_START_FAILED,
        `PiBackend.startSession failed to spawn. kind=${this.kind} command=${this.command} error=${errorMessage(error)}`,
        { functionName: "PiBackend.startSession", kind: this.kind, command: this.command, workspacePath },
      );
    }

    this.child = child;
    this.stderrChunks = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrChunks.push(chunk);
    });

    attachLineReader(child.stdout, (line) => {
      const payload = decodeJsonObject(line);
      if (payload === null) {
        return;
      }
      if (payload.type === "session" && typeof payload.id === "string") {
        this.sessionId = payload.id;
      }
      if (this.turnHandler !== null) {
        this.turnHandler(payload);
      }
    });

    child.on("error", (error) => {
      this.exitError = new AdapterError(
        ERROR_START_FAILED,
        `PiBackend process error. kind=${this.kind} error=${errorMessage(error)}`,
        { functionName: "PiBackend.startSession", kind: this.kind },
      );
    });

    child.on("exit", (status) => {
      const stderr = this.stderrChunks.join("").trim();
      if (this.cancelled) {
        this.exitError = new AdapterError(ERROR_CANCELLED, "PiBackend stopped: cancelled.", {
          functionName: "PiBackend.stop",
          kind: this.kind,
          status,
        });
      } else if (this.exitError === null) {
        this.exitError = classifyExit("PiBackend", this.kind, status, stderr);
      }
      if (this.turnHandler !== null) {
        this.turnHandler({ type: "__process_exit", status, stderr });
      }
    });
  }

  /**
   * RPC prompt を送り、agent_end または agent_settled まで待つ。
   *
   * @param {string} prompt turn 入力
   * @returns {Promise<{sessionId: string | null, lastMessage: string | null}>}
   */
  async runTurn(prompt) {
    if (this.cancelled) {
      throw new AdapterError(ERROR_CANCELLED, "PiBackend.runTurn failed: already cancelled.", {
        functionName: "PiBackend.runTurn",
        kind: this.kind,
      });
    }
    if (this.child === null || this.child.stdin === null) {
      throw new AdapterError(
        ERROR_START_FAILED,
        `PiBackend.runTurn failed: RPC process is not running. kind=${this.kind} workspacePath=${this.workspacePath}`,
        { functionName: "PiBackend.runTurn", kind: this.kind, workspacePath: this.workspacePath },
      );
    }
    if (this.exitError !== null) {
      throw this.exitError;
    }

    const requestId = `symphony-pi-${Date.now()}`;
    /** @type {string | null} */
    let lastMessage = null;

    const waitForTurn = new Promise((resolve, reject) => {
      this.turnHandler = (payload) => {
        if (payload.type === "__process_exit") {
          reject(
            this.cancelled
              ? new AdapterError(ERROR_CANCELLED, "PiBackend.runTurn failed: cancelled.", {
                  functionName: "PiBackend.runTurn",
                  kind: this.kind,
                })
              : this.exitError ??
                  classifyExit("PiBackend.runTurn", this.kind, payload.status ?? 1, String(payload.stderr ?? "")),
          );
          return;
        }
        if (payload.type === "response" && payload.success === false) {
          reject(
            new AdapterError(
              ERROR_ABNORMAL_EXIT,
              `PiBackend.runTurn failed: RPC response success=false. kind=${this.kind} error=${payload.error} requestId=${requestId}`,
              { functionName: "PiBackend.runTurn", kind: this.kind, requestId, error: payload.error },
            ),
          );
          return;
        }
        if (payload.type === "agent_end") {
          const failure = extractFailureReason(payload);
          if (failure !== null) {
            reject(
              new AdapterError(
                ERROR_ABNORMAL_EXIT,
                `PiBackend.runTurn failed: ${failure}. kind=${this.kind} requestId=${requestId}`,
                { functionName: "PiBackend.runTurn", kind: this.kind, requestId },
              ),
            );
            return;
          }
          lastMessage = extractLastAssistantText(payload) ?? lastMessage;
          resolve({ sessionId: this.sessionId, lastMessage });
          return;
        }
        if (payload.type === "agent_settled") {
          resolve({ sessionId: this.sessionId, lastMessage });
        }
      };
    });

    try {
      this.child.stdin.write(`${JSON.stringify({ id: requestId, type: "prompt", message: prompt })}\n`);
    } catch (error) {
      this.turnHandler = null;
      throw new AdapterError(
        ERROR_START_FAILED,
        `PiBackend.runTurn failed to write prompt. kind=${this.kind} requestId=${requestId} error=${errorMessage(error)}`,
        { functionName: "PiBackend.runTurn", kind: this.kind, requestId },
      );
    }

    try {
      return await waitForTurn;
    } finally {
      this.turnHandler = null;
    }
  }

  /**
   * abort を送り、RPC process を止める。
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this.cancelled = true;
    if (this.child?.stdin !== undefined && this.child.stdin !== null && !this.child.stdin.destroyed) {
      try {
        this.child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
      } catch {
        // 閉じていても無視
      }
    }
    killChildProcess(this.child);
    this.child = null;
  }
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {string | null}
 */
function extractFailureReason(payload) {
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  const last = messages[messages.length - 1];
  if (last === null || typeof last !== "object") {
    return null;
  }
  const stopReason = last.stopReason;
  if (stopReason === "error" || stopReason === "aborted") {
    if (typeof last.errorMessage === "string" && last.errorMessage !== "") {
      return last.errorMessage;
    }
    return `pi turn ended with stopReason=${stopReason}`;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {string | null}
 */
function extractLastAssistantText(payload) {
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const text = extractText(message.content);
    if (text !== null) {
      return text;
    }
  }
  return null;
}

/**
 * @param {unknown} content
 * @returns {string | null}
 */
function extractText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (block?.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return null;
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
