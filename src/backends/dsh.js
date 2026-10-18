/**
 * @fileoverview rdsh（@deepseek-ai/dsh の Rust launcher）headless backend。
 *
 * `rdsh --profile headless --patch <overlay> -- --json -` を 1 turn 1 process で起動し、
 * prompt は stdin で渡す。stdout の NDJSON から `session` の sessionId と `final` の text を拾う。
 * 2 turn 目以降は `--session-id` で同じ dsh Session を続ける。
 *
 * key: SYMPHONY_DSH_API_KEY を子 process の OPENCODE_API_KEY としてだけ渡す。
 * 親 env の OPENCODE_API_KEY / OPENCODE_GO_API_KEY（hermes 用）は使わない。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdapterError,
  ERROR_ABNORMAL_EXIT,
  ERROR_AUTH_MISSING,
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @type {string} */
export const DEFAULT_DSH_PATCH = path.join(repoRoot, "config", "dsh-opencode-go.patch.yml");

/** @type {string} */
export const DEFAULT_DSH_COMMAND = `rdsh --no-slim --profile headless --patch ${DEFAULT_DSH_PATCH}`;

/** @type {string} */
export const DSH_KEY_ENV = "SYMPHONY_DSH_API_KEY";

/** 1 turn の上限（ms）。provider が応答しないまま止まる事例があったため必須。 */
export const DEFAULT_DSH_TURN_TIMEOUT_MS = 20 * 60 * 1_000;

/** adapter 終了時に kill する実行中 rdsh。 */
const liveChildren = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const killAll = () => { for (const child of liveChildren) killChildProcess(child); liveChildren.clear(); };
  process.on("exit", killAll);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.once(signal, () => { killAll(); process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[signal]); });
  }
}

/**
 * @param {Record<string, string | undefined>} environment
 * @returns {number}
 */
export function parseTurnTimeout(environment) {
  const parsed = Number(environment.SYMPHONY_DSH_TURN_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DSH_TURN_TIMEOUT_MS;
}

export class DshBackend {
  /**
   * @param {string} [command] 上書き command（`-- --json` より前まで）
   * @param {Record<string, string | undefined>} [environment] key 解決用 env
   */
  constructor(command = DEFAULT_DSH_COMMAND, environment = process.env) {
    this.kind = "rdsh";
    this.command = command;
    this.environment = environment;
    this.workspacePath = null;
    this.sessionId = null;
    this.currentChild = null;
    this.cancelled = false;
    this.turnTimeoutMs = parseTurnTimeout({ ...process.env, ...environment });
  }

  /**
   * @param {string} workspacePath
   * @returns {Promise<void>}
   */
  async startSession(workspacePath) {
    this.workspacePath = workspacePath;
    this.cancelled = false;
    ensureCommandAvailable("DshBackend.startSession", this.kind, this.command);
    this.apiKey();
  }

  /**
   * @returns {string}
   */
  apiKey() {
    const key = String(this.environment[DSH_KEY_ENV] ?? "").trim();
    if (key === "") {
      throw new AdapterError(
        ERROR_AUTH_MISSING,
        `DshBackend failed: ${DSH_KEY_ENV} is not set. Add a dedicated opencode-go key; the hermes key is not reused.`,
        { functionName: "DshBackend.apiKey", kind: this.kind },
      );
    }
    return key;
  }

  /**
   * @param {string} prompt
   * @returns {Promise<{sessionId: string | null, lastMessage: string | null}>}
   */
  async runTurn(prompt) {
    if (this.cancelled) {
      throw new AdapterError(ERROR_CANCELLED, "DshBackend.runTurn failed: already cancelled.", {
        functionName: "DshBackend.runTurn",
        kind: this.kind,
      });
    }
    const sessionArgs = this.sessionId ? ` --session-id ${shellSingleQuote(this.sessionId)}` : "";
    const launchCommand = `${this.command} -- --json${sessionArgs} -`;
    let child;
    try {
      child = startChildProcess({
        command: launchCommand,
        cwd: this.workspacePath ?? process.cwd(),
        env: { OPENCODE_API_KEY: this.apiKey(), OPENCODE_GO_API_KEY: "" },
      });
    } catch (error) {
      throw new AdapterError(
        ERROR_START_FAILED,
        `DshBackend.runTurn failed to spawn. kind=${this.kind} command=${launchCommand} error=${errorMessage(error)}`,
        { functionName: "DshBackend.runTurn", kind: this.kind, command: launchCommand },
      );
    }
    this.currentChild = child;
    installExitHook();
    liveChildren.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildProcess(child);
    }, this.turnTimeoutMs);
    const stderrChunks = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    let lastMessage = null;
    let errorEvent = null;
    const waitForExit = new Promise((resolve, reject) => {
      attachLineReader(child.stdout, (line) => {
        const payload = decodeJsonObject(line);
        if (payload === null) return;
        if (payload.type === "session" && typeof payload.sessionId === "string") {
          this.sessionId = payload.sessionId;
        }
        if (payload.type === "final" && typeof payload.text === "string") {
          lastMessage = payload.text;
        }
        if (payload.type === "error") {
          errorEvent = String(payload.message ?? JSON.stringify(payload));
        }
      });
      child.on("error", (error) => {
        reject(
          new AdapterError(ERROR_START_FAILED, `DshBackend.runTurn process error. error=${errorMessage(error)}`, {
            functionName: "DshBackend.runTurn",
            kind: this.kind,
          }),
        );
      });
      child.on("exit", (status) => {
        clearTimeout(timer);
        liveChildren.delete(child);
        if (timedOut) {
          reject(new AdapterError(ERROR_ABNORMAL_EXIT, `DshBackend.runTurn failed: turn timeout ${this.turnTimeoutMs} ms. kind=${this.kind}`, {
            functionName: "DshBackend.runTurn",
            kind: this.kind,
            timeoutMs: this.turnTimeoutMs,
          }));
          return;
        }
        if (this.cancelled) {
          reject(new AdapterError(ERROR_CANCELLED, "DshBackend.runTurn failed: cancelled.", {
            functionName: "DshBackend.runTurn",
            kind: this.kind,
          }));
          return;
        }
        if (status === 0) {
          resolve({ sessionId: this.sessionId, lastMessage });
          return;
        }
        const stderr = [errorEvent, stderrChunks.join("").trim()].filter(Boolean).join("\n");
        reject(classifyExit("DshBackend.runTurn", this.kind, status, stderr));
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    try {
      return await waitForExit;
    } finally {
      this.currentChild = null;
    }
  }

  /** @returns {Promise<void>} */
  async stop() {
    this.cancelled = true;
    killChildProcess(this.currentChild);
    this.currentChild = null;
  }
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function decodeJsonObject(line) {
  try {
    const payload = JSON.parse(line);
    return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
