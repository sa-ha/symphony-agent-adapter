/**
 * @fileoverview adapter 共通 error。
 *
 * Symphony 側で扱えるよう、agent 固有の失敗を少数の code に正規化する。
 *
 * @property {string} code 機械可読な error code
 * @property {Record<string, unknown>} details 関数名・引数などの付加情報
 */
export class AdapterError extends Error {
  /**
   * @param {string} code error code
   * @param {string} message 人間向け詳細
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.details = details;
  }
}

/** @type {string} */
export const ERROR_UNKNOWN_KIND = "unknownKind";
/** @type {string} */
export const ERROR_CLI_NOT_FOUND = "agentCliNotFound";
/** @type {string} */
export const ERROR_AUTH_MISSING = "agentAuthMissing";
/** @type {string} */
export const ERROR_START_FAILED = "agentStartFailed";
/** @type {string} */
export const ERROR_ABNORMAL_EXIT = "agentAbnormalExit";
/** @type {string} */
export const ERROR_MALFORMED_OUTPUT = "agentMalformedOutput";
/** @type {string} */
export const ERROR_CANCELLED = "cancelled";
/** @type {string} */
export const ERROR_PROTOCOL = "protocolError";
