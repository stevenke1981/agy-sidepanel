// Native messaging client for the agy host. chrome.* is never touched at import time: the port factory,
// request-id generator and lastError reader are injectable so node:test can drive a fake port.
import { HOST_NAME, PROTOCOL_VERSION, REQ, RES, ERR, validateOpenIdePath } from './protocol.js';

/** Client-only error codes (never sent by the host). */
export const CLIENT_ERR = Object.freeze({ DISCONNECTED: 'DISCONNECTED', TIMEOUT: 'TIMEOUT' });

const DEFAULT_TIMEOUT_MS = 10_000;

/** @returns {string} request id: 'r' + 32 hex chars (33 total, matches the host REQ_ID_RE) */
function defaultRequestId() {
  return `r${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
}

/** @returns {string|null} */
function defaultLastError() {
  return globalThis.chrome?.runtime?.lastError?.message ?? null;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @param {unknown} entry @returns {boolean} */
function isModelEntry(entry) {
  return Boolean(entry) && typeof entry === 'object' && typeof entry.id === 'string';
}

/**
 * @typedef {{handle: (msg: object) => void, fail: (message: string) => void}} PendingEntry
 * @typedef {{connectNative?: (hostName: string) => any, hostName?: string, newReqId?: () => string,
 *   getLastError?: () => string|null, timeoutMs?: number}} NativeClientOptions
 */

export class NativeClient {
  /** @type {any} */
  #port = null;
  /** @type {Map<string, PendingEntry>} */
  #pending = new Map();
  /** @type {PendingEntry|null} */
  #helloWaiter = null;
  /** @type {Set<(message: string) => void>} */
  #disconnectListeners = new Set();
  /** @type {Set<(msg: object) => void>} */
  #globalErrorListeners = new Set();
  /** @type {Required<NativeClientOptions>} */
  #opts;

  /** @param {NativeClientOptions} [options] */
  constructor(options = {}) {
    this.#opts = {
      connectNative: options.connectNative ?? ((name) => globalThis.chrome.runtime.connectNative(name)),
      hostName: options.hostName ?? HOST_NAME,
      newReqId: options.newReqId ?? defaultRequestId,
      getLastError: options.getLastError ?? defaultLastError,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  /**
   * Open the port if needed. Failures are reported asynchronously through onDisconnect listeners.
   * @returns {boolean} false when connectNative threw
   */
  connect() {
    if (this.#port) return true;
    let port;
    try {
      port = this.#opts.connectNative(this.#opts.hostName);
    } catch (err) {
      queueMicrotask(() => this.#handleDisconnect(messageOf(err)));
      return false;
    }
    this.#port = port;
    port.onMessage.addListener((msg) => this.#dispatch(msg));
    port.onDisconnect.addListener(() => {
      if (this.#port === port) this.#handleDisconnect(this.#opts.getLastError() ?? 'Native host disconnected');
    });
    return true;
  }

  /**
   * Close the port from our side and fail everything still pending.
   * @returns {void}
   */
  disconnect() {
    const port = this.#port;
    if (!port) return;
    this.#port = null;
    port.disconnect();
    this.#handleDisconnect('Disconnected by extension');
  }

  /**
   * Handshake. Resolves with the RES.HELLO message (agyPath, agyVersion, ideAvailable, defaultCwd, ...).
   * @returns {Promise<object>}
   */
  hello() {
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer);
        this.#helloWaiter = null;
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, this.#timeoutError()), this.#opts.timeoutMs);
      this.#helloWaiter = {
        handle: (msg) => this.#onHelloMessage(msg, finish, resolve, reject),
        fail: (message) => finish(reject, new Error(message)),
      };
      this.#send({ type: REQ.HELLO, protocol: PROTOCOL_VERSION });
    });
  }

  /**
   * @param {object} msg
   * @param {(fn: Function, value: unknown) => void} finish
   * @param {(value: object) => void} resolve
   * @param {(err: Error) => void} reject
   */
  #onHelloMessage(msg, finish, resolve, reject) {
    if (msg.type === RES.ERROR) return finish(reject, new Error(`${msg.code ?? ERR.INTERNAL}: ${msg.message ?? ''}`));
    if (msg.protocol !== PROTOCOL_VERSION) {
      return finish(reject, new Error(`${ERR.PROTOCOL_MISMATCH}: host protocol ${msg.protocol}, extension ${PROTOCOL_VERSION}`));
    }
    return finish(resolve, msg);
  }

  /**
   * Resolve the model list from the host.
   * @returns {Promise<Array<{id: string, label: string}>>}
   */
  listModels() {
    return this.#request((reqId) => ({ type: REQ.MODELS, reqId }), RES.MODELS, (msg) =>
      Array.isArray(msg.models) ? msg.models.filter(isModelEntry) : []);
  }

  /**
   * Open a folder in the Antigravity IDE. The path is validated before anything is sent.
   * @param {string} path
   * @returns {Promise<void>}
   */
  openIde(path) {
    const check = validateOpenIdePath(path);
    if (!check.ok) return Promise.reject(new Error(check.message));
    return this.#request((reqId) => ({ type: REQ.OPEN_IDE, reqId, path }), RES.OK, () => undefined);
  }

  /**
   * Start a run. onMessage receives every message for this reqId (EVENT, STDERR, ERROR, CANCELLED, EXIT).
   * EXIT is always last. If the host or port fails, a synthetic ERROR{DISCONNECTED} and EXIT are delivered.
   * @param {string} prompt
   * @param {object} options RunOptions
   * @param {(msg: object) => void} onMessage
   * @returns {{reqId: string, cancel: () => boolean}}
   */
  run(prompt, options, onMessage) {
    const reqId = this.#opts.newReqId();
    let cancelRequested = false;
    this.#pending.set(reqId, {
      handle: (msg) => {
        onMessage(msg);
        if (msg.type === RES.EXIT || (msg.type === RES.ERROR && msg.code !== ERR.SPAWN_FAILED)) {
          this.#pending.delete(reqId);
        }
      },
      fail: (message) => {
        this.#pending.delete(reqId);
        onMessage({ type: RES.ERROR, reqId, code: CLIENT_ERR.DISCONNECTED, message });
        onMessage({ type: RES.EXIT, reqId, code: null, signal: null, cancelled: cancelRequested });
      },
    });
    this.#send({ type: REQ.RUN, reqId, prompt, options });
    return {
      reqId,
      cancel: () => {
        cancelRequested = true;
        return this.#send({ type: REQ.CANCEL, reqId });
      },
    };
  }

  /**
   * Subscribe to disconnects. The listener receives the chrome.runtime.lastError message (or a fallback).
   * @param {(message: string) => void} cb
   * @returns {() => void} unsubscribe
   */
  onDisconnect(cb) {
    this.#disconnectListeners.add(cb);
    return () => this.#disconnectListeners.delete(cb);
  }

  /**
   * Subscribe to host ERROR messages that carry no reqId and match no pending hello.
   * @param {(msg: object) => void} cb
   * @returns {() => void} unsubscribe
   */
  onGlobalError(cb) {
    this.#globalErrorListeners.add(cb);
    return () => this.#globalErrorListeners.delete(cb);
  }

  /**
   * Shared request/response helper for single-reply messages (models, openIde).
   * @template T
   * @param {(reqId: string) => object} build
   * @param {string} expectType
   * @param {(msg: object) => T} parse
   * @returns {Promise<T>}
   */
  #request(build, expectType, parse) {
    return new Promise((resolve, reject) => {
      const reqId = this.#opts.newReqId();
      const finish = (fn, value) => {
        clearTimeout(timer);
        this.#pending.delete(reqId);
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, this.#timeoutError()), this.#opts.timeoutMs);
      this.#pending.set(reqId, {
        handle: (msg) => {
          if (msg.type === RES.ERROR) return finish(reject, new Error(`${msg.code ?? ERR.INTERNAL}: ${msg.message ?? ''}`));
          if (msg.type === expectType) return finish(resolve, parse(msg));
          return undefined;
        },
        fail: (message) => finish(reject, new Error(message)),
      });
      this.#send(build(reqId));
    });
  }

  /** @returns {Error} */
  #timeoutError() {
    return new Error(`${CLIENT_ERR.TIMEOUT}: no response from native host`);
  }

  /**
   * Post a message, connecting lazily. Returns false when the message could not be sent; the failure is
   * then reported to pending requests through handleDisconnect on a microtask.
   * @param {object} msg
   * @returns {boolean}
   */
  #send(msg) {
    if (!this.connect()) return false;
    try {
      this.#port.postMessage(msg);
      return true;
    } catch (err) {
      queueMicrotask(() => this.#handleDisconnect(messageOf(err)));
      return false;
    }
  }

  /** @param {object} msg */
  #dispatch(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (this.#helloWaiter && (msg.type === RES.HELLO || (msg.type === RES.ERROR && msg.reqId == null))) {
      this.#helloWaiter.handle(msg);
      return;
    }
    if (typeof msg.reqId === 'string' && this.#pending.has(msg.reqId)) {
      this.#pending.get(msg.reqId)?.handle(msg);
      return;
    }
    if (msg.type === RES.ERROR && msg.reqId == null) {
      for (const cb of this.#globalErrorListeners) cb(msg);
    }
    // Any other message names a reqId we no longer track (stale after cancel or disconnect): dropped.
  }

  /** @param {string} message */
  #handleDisconnect(message) {
    this.#port = null;
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) entry.fail(message);
    this.#helloWaiter?.fail(message);
    for (const cb of this.#disconnectListeners) cb(message);
  }
}

/**
 * Factory used by the side panel and options page.
 * @param {ConstructorParameters<typeof NativeClient>[0]} [opts]
 * @returns {NativeClient}
 */
export function createNativeClient(opts) {
  return new NativeClient(opts);
}
