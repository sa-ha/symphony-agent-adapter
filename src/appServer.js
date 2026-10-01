/**
 * @fileoverview Codex app-server JSON-RPC を stdin/stdout で話す shim。
 *
 * Symphony（Elixir / symphony-ts）は本 process を `codex app-server` だと思って起動する。
 * 固有の Cursor / Pi イベントはこの layer で turn/completed などに畳む。
 */

import {
  AdapterError,
  ERROR_ABNORMAL_EXIT,
  ERROR_CANCELLED,
  ERROR_PROTOCOL,
} from "./errors.js";

/**
 * @typedef {object} AgentBackend
 * @property {(workspacePath: string) => Promise<void>} startSession
 * @property {(prompt: string) => Promise<{sessionId: string | null, lastMessage: string | null}>} runTurn
 * @property {() => Promise<void>} stop
 */

export class CodexAppServerShim {
  /**
   * @param {object} options
   * @param {AgentBackend} options.backend 実際の coding agent
   * @param {NodeJS.ReadableStream} [options.stdin]
   * @param {NodeJS.WritableStream} [options.stdout]
   */
  constructor(options) {
    this.backend = options.backend;
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.threadId = "symphony-agent-thread";
    this.nextTurnNumber = 1;
    this.workspacePath = process.cwd();
    this.currentTurnId = null;
    this.closed = false;
    this.pending = "";
    this.processing = Promise.resolve();
  }

  /**
   * stdin の読み取りを開始する。
   *
   * @returns {void}
   */
  start() {
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => {
      this.processing = this.processing
        .then(() => this.handleChunk(chunk))
        .catch((error) => {
          writeStderr(`CodexAppServerShim.start handleChunk failed: ${errorMessage(error)}`);
        });
    });
    this.stdin.on("end", () => {
      void this.shutdown("stdin_end");
    });
    if (this.stdin === process.stdin) {
      process.on("SIGTERM", () => {
        void this.shutdown("SIGTERM");
      });
      process.on("SIGINT", () => {
        void this.shutdown("SIGINT");
      });
    }
  }

  /**
   * stdin chunk を行に分割して処理する。
   *
   * @param {string} chunk
   * @returns {Promise<void>}
   */
  async handleChunk(chunk) {
    this.pending += chunk;
    let newlineIndex = this.pending.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.pending.slice(0, newlineIndex);
      this.pending = this.pending.slice(newlineIndex + 1);
      if (line.trim() !== "") {
        await this.handleLine(line);
      }
      newlineIndex = this.pending.indexOf("\n");
    }
  }

  /**
   * JSON-RPC 1 行を処理する。
   *
   * @param {string} line
   * @returns {Promise<void>}
   */
  async handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      writeStderr(`CodexAppServerShim.handleLine malformed JSON: ${errorMessage(error)} line=${line}`);
      return;
    }
    if (message === null || typeof message !== "object") {
      return;
    }

    const method = message.method;
    const id = message.id;
    const params = message.params ?? {};

    try {
      if (method === "initialize") {
        this.writeResponse(id, {});
        return;
      }
      if (method === "initialized") {
        return;
      }
      if (method === "thread/start") {
        await this.handleThreadStart(id, params);
        return;
      }
      if (method === "turn/start") {
        await this.handleTurnStart(id, params);
        return;
      }
      if (typeof id !== "undefined") {
        this.writeError(id, ERROR_PROTOCOL, `CodexAppServerShim.handleLine unsupported method=${method}`);
      }
    } catch (error) {
      if (typeof id !== "undefined") {
        this.writeError(id, errorCode(error), errorMessage(error));
      } else {
        writeStderr(`CodexAppServerShim.handleLine failed: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * thread を開始し、backend session を開く。
   *
   * @param {string | number} id JSON-RPC id
   * @param {Record<string, unknown>} params thread/start params
   * @returns {Promise<void>}
   */
  async handleThreadStart(id, params) {
    if (typeof params.cwd === "string" && params.cwd !== "") {
      this.workspacePath = params.cwd;
    }
    await this.backend.startSession(this.workspacePath);
    this.writeResponse(id, { thread: { id: this.threadId } });
  }

  /**
   * turn を開始する。応答を先に返し、agent 完了後に terminal event を送る。
   *
   * @param {string | number} id JSON-RPC id
   * @param {Record<string, unknown>} params turn/start params
   * @returns {Promise<void>}
   */
  async handleTurnStart(id, params) {
    const prompt = extractPrompt(params);
    const turnId = `turn-${this.nextTurnNumber}`;
    this.nextTurnNumber += 1;
    this.currentTurnId = turnId;
    if (typeof params.cwd === "string" && params.cwd !== "") {
      this.workspacePath = params.cwd;
    }

    this.writeResponse(id, { turn: { id: turnId } });

    try {
      const result = await this.backend.runTurn(prompt);
      if (this.closed) {
        return;
      }
      this.writeNotification("turn/completed", {
        turnId,
        lastMessage: result.lastMessage,
        sessionId: result.sessionId,
      });
    } catch (error) {
      if (this.closed) {
        return;
      }
      const method = errorCode(error) === ERROR_CANCELLED ? "turn/cancelled" : "turn/failed";
      this.writeNotification(method, {
        turnId,
        reason: errorMessage(error),
        code: errorCode(error),
      });
    } finally {
      this.currentTurnId = null;
    }
  }

  /**
   * 取消して終了する。
   *
   * @param {string} reason 終了理由
   * @returns {Promise<void>}
   */
  async shutdown(reason) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.currentTurnId !== null) {
      this.writeNotification("turn/cancelled", {
        turnId: this.currentTurnId,
        reason,
        code: ERROR_CANCELLED,
      });
    }
    try {
      await this.backend.stop();
    } catch (error) {
      writeStderr(`CodexAppServerShim.shutdown backend.stop failed: ${errorMessage(error)} reason=${reason}`);
    }
    if (this.stdin === process.stdin) {
      process.exit(0);
    }
  }

  /**
   * JSON-RPC 成功応答を書く。
   *
   * @param {string | number} id
   * @param {unknown} result
   * @returns {void}
   */
  writeResponse(id, result) {
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  /**
   * JSON-RPC error 応答を書く。
   *
   * @param {string | number} id
   * @param {string} code
   * @param {string} message
   * @returns {void}
   */
  writeError(id, code, message) {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: `${code}: ${message}` },
    });
  }

  /**
   * notification を書く。
   *
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @returns {void}
   */
  writeNotification(method, params) {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  /**
   * stdout へ 1 JSON 行を書く。
   *
   * @param {Record<string, unknown>} message
   * @returns {void}
   */
  writeMessage(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

/**
 * turn/start から prompt 文字列を取り出す。
 *
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export function extractPrompt(params) {
  const input = params.input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (item !== null && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
        return item.text;
      }
    }
  }
  if (typeof params.prompt === "string") {
    return params.prompt;
  }
  throw new AdapterError(
    ERROR_PROTOCOL,
    `extractPrompt failed: turn/start input text is missing. params=${JSON.stringify(params)}`,
    { functionName: "extractPrompt", params },
  );
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorCode(error) {
  if (error instanceof AdapterError) {
    return error.code;
  }
  return ERROR_ABNORMAL_EXIT;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} message
 * @returns {void}
 */
function writeStderr(message) {
  process.stderr.write(`${message}\n`);
}
