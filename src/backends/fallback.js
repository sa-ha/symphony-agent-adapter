/**
 * @fileoverview primary が usage / rate limit で失敗した turn を secondary でやり直す backend。
 *
 * - 判定は AdapterError.code === ERROR_USAGE_LIMIT だけ（文言は errors.js の一覧）。
 * - 切替後、その worker の残り turn は secondary に固定する。
 * - adapter は Issue ごとに別 process なので、cooldown は state file に記録し、
 *   期限内に始まった worker は最初から secondary を使う。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ERROR_USAGE_LIMIT } from "../errors.js";

/** @type {number} */
export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1_000;

/** @type {string} */
export const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  ".local",
  "state",
  "symphony-agent-adapter",
  "usage-limit.json",
);

/**
 * @param {{path?: string, now?: () => number}} [options]
 */
export function createCooldownStore({ path: statePath = DEFAULT_STATE_PATH, now = Date.now } = {}) {
  return {
    /** @returns {number | null} 有効な期限（ms）。無ければ null */
    activeUntil() {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        const until = Number(state.until);
        return Number.isFinite(until) && until > now() ? until : null;
      } catch {
        return null;
      }
    },
    /**
     * @param {number} cooldownMs
     * @param {string} reason
     */
    trip(cooldownMs, reason) {
      mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      const temporary = `${statePath}.${process.pid}.tmp`;
      const state = { until: now() + cooldownMs, trippedAt: new Date(now()).toISOString(), reason: reason.slice(0, 500) };
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      renameSync(temporary, statePath);
    },
  };
}

export class FallbackBackend {
  /**
   * @param {{primary: object, secondary: object, cooldownMs?: number, store?: ReturnType<typeof createCooldownStore>, log?: (line: string) => void}} options
   */
  constructor({ primary, secondary, cooldownMs = DEFAULT_COOLDOWN_MS, store = createCooldownStore(), log = (line) => process.stderr.write(`${line}\n`) }) {
    this.kind = `fallback(${primary.kind}->${secondary.kind})`;
    this.primary = primary;
    this.secondary = secondary;
    this.cooldownMs = cooldownMs;
    this.store = store;
    this.log = log;
    this.workspacePath = null;
    this.active = null;
    this.secondaryStarted = false;
  }

  /** @param {string} workspacePath */
  async startSession(workspacePath) {
    this.workspacePath = workspacePath;
    const until = this.store.activeUntil();
    if (until !== null) {
      this.emit("fallback_cooldown_active", { until: new Date(until).toISOString() });
      await this.useSecondary();
      return;
    }
    await this.primary.startSession(workspacePath);
    this.active = this.primary;
  }

  /** @param {string} prompt */
  async runTurn(prompt) {
    if (this.active === this.secondary) {
      return this.secondary.runTurn(prompt);
    }
    try {
      return await this.primary.runTurn(prompt);
    } catch (error) {
      if (error?.code !== ERROR_USAGE_LIMIT) throw error;
      this.store.trip(this.cooldownMs, String(error.message ?? ""));
      this.emit("fallback_switched", { from: this.primary.kind, to: this.secondary.kind, cooldown_ms: this.cooldownMs });
      try { await this.primary.stop(); } catch { /* 既に終了 */ }
      await this.useSecondary();
      return this.secondary.runTurn(prompt);
    }
  }

  async stop() {
    await Promise.allSettled([this.primary.stop(), this.secondaryStarted ? this.secondary.stop() : Promise.resolve()]);
  }

  async useSecondary() {
    if (!this.secondaryStarted) {
      await this.secondary.startSession(this.workspacePath);
      this.secondaryStarted = true;
    }
    this.active = this.secondary;
  }

  emit(event, fields) {
    this.log(JSON.stringify({ event, backend: this.kind, ...fields }));
  }
}
