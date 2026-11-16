// agy Bridge native host. Reads framed requests from stdin, drives the agy CLI,
// writes framed responses to stdout. stdout is the protocol channel: never write to it directly.
import { spawn as nodeSpawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDecoder, createLineSplitter, encodeMessage } from './framing.mjs';
import {
  buildArgs, buildStdinPayload, defaultCwd, parseModels, resolveAgyPath, resolveIde, truncateForHost,
} from './agy.mjs';
import {
  ERR, LIMITS, PROTOCOL_VERSION, REQ, RES,
  isValidReqId, validateOpenIdePath, validatePrompt, validateRunOptions,
} from '../../extension/src/lib/protocol.js';

export const HOST_VERSION = '1.0.0';
const VERSION_TIMEOUT_MS = 5_000;
const MODELS_TIMEOUT_MS = 30_000;
const KILL_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 3_000; // bounded wait for a killed child to exit before its EXIT is synthesized

const defaultFs = Object.freeze({
  existsSync,
  mkdirSync,
  appendFileSync,
  isDirectory(target) {
    try {
      return statSync(target).isDirectory();
    } catch {
      return false; // missing or unreadable: treated as "not a directory"
    }
  },
});

const errorMsg = (reqId, code, message) => ({ type: RES.ERROR, reqId, code, message });
const replyId = (msg) => (isValidReqId(msg?.reqId) ? msg.reqId : null);
const failure = (code, message) => ({ ok: false, code, message });
const success = (value) => ({ ok: true, value });
const firstLine = (text) => text.split(/\r?\n/)[0].trim() || null;

function createLogger(env, fsImpl) {
  const logFile = env.AGY_BRIDGE_LOG;
  if (!logFile) return () => {};
  return (event, detail = {}) => {
    // Detail objects must never contain prompt text.
    const line = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`;
    try {
      fsImpl.appendFileSync(logFile, line);
    } catch {
      // A broken debug log must never break the bridge.
    }
  };
}

/** Spawns `exe args` with shell:false and collects stdout. Rejects on spawn error. */
export function runCapture(spawnImpl, exe, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawnImpl(exe, args, {
      shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => child.kill?.(), timeoutMs);
    child.stdout?.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/** Kills a run's whole process tree: taskkill /T /F /PID on Windows, SIGKILL elsewhere. */
export function killProcessTree(child, env = process.env) {
  if (!child || typeof child.pid !== 'number') return Promise.resolve(null);
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return Promise.resolve(null);
  }
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const taskkill = path.win32.join(root, 'System32', 'taskkill.exe');
  return runCapture(nodeSpawn, taskkill, ['/T', '/F', '/PID', String(child.pid)], {
    env, timeoutMs: KILL_TIMEOUT_MS,
  }).then(({ code }) => code);
}

function probeVersionWith(spawnImpl, env) {
  return async (agyPath) => {
    try {
      const { code, stdout } = await runCapture(spawnImpl, agyPath, ['--version'], {
        env, timeoutMs: VERSION_TIMEOUT_MS,
      });
      return code === 0 ? firstLine(stdout) : null;
    } catch {
      return null; // the version is informational only; HELLO reports null instead of failing
    }
  };
}

function makeContext(options) {
  const env = options.env ?? process.env;
  const fsImpl = options.fsImpl ?? defaultFs;
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const send = options.send ?? (() => {});
  return {
    emit: (msg) => send(truncateForHost(msg)),
    env,
    fsImpl,
    spawnImpl,
    killTree: options.killTree ?? killProcessTree,
    probeVersion: options.probeVersion ?? probeVersionWith(spawnImpl, env),
    idleTimeoutMs: options.idleTimeoutMs ?? LIMITS.RUN_IDLE_TIMEOUT_MS,
    killGraceMs: options.killGraceMs ?? KILL_GRACE_MS,
    log: options.log ?? createLogger(env, fsImpl),
    runs: new Map(),
    usedRunIds: new Set(),
    version: null,
  };
}

/**
 * Creates the request dispatcher.
 * options: send(frameObject), spawnImpl, env, fsImpl, killTree, probeVersion, idleTimeoutMs, killGraceMs, log.
 */
export function createBridge(options = {}) {
  const ctx = makeContext(options);
  return {
    handle: (msg) => dispatch(ctx, msg),
    reportFrameError: (error) => ctx.emit(errorMsg(null, ERR.BAD_REQUEST, error.message)),
    shutdown: () => shutdownRuns(ctx),
  };
}

const HANDLERS = Object.freeze({
  [REQ.HELLO]: handleHello,
  [REQ.MODELS]: handleModels,
  [REQ.RUN]: handleRun,
  [REQ.CANCEL]: handleCancel,
  [REQ.OPEN_IDE]: handleOpenIde,
});

async function dispatch(ctx, msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    ctx.emit(errorMsg(null, ERR.BAD_REQUEST, 'message must be an object'));
    return;
  }
  const handler = Object.hasOwn(HANDLERS, msg.type) ? HANDLERS[msg.type] : null;
  if (!handler) {
    ctx.emit(errorMsg(replyId(msg), ERR.BAD_REQUEST, 'unknown message type'));
    return;
  }
  try {
    await handler(ctx, msg);
  } catch (error) {
    ctx.log('handler-error', { type: msg.type, message: error.message });
    ctx.emit(errorMsg(replyId(msg), ERR.INTERNAL, 'internal error'));
  }
}

const findAgy = (ctx) => resolveAgyPath({ env: ctx.env, fsExists: ctx.fsImpl.existsSync });
const findIde = (ctx) => resolveIde({ env: ctx.env, fsExists: ctx.fsImpl.existsSync });

function safeDefaultCwd(ctx) {
  try {
    return defaultCwd({ env: ctx.env, mkdirSync: ctx.fsImpl.mkdirSync });
  } catch (error) {
    ctx.log('default-cwd-unavailable', { message: error.message });
    return null;
  }
}

function getAgyVersion(ctx, agyPath) {
  if (!agyPath) return Promise.resolve(null);
  if (ctx.version?.agyPath !== agyPath) {
    ctx.version = { agyPath, promise: ctx.probeVersion(agyPath) };
  }
  return ctx.version.promise;
}

async function handleHello(ctx, msg) {
  if (msg.protocol !== PROTOCOL_VERSION) {
    ctx.emit(errorMsg(null, ERR.PROTOCOL_MISMATCH, `host speaks protocol ${PROTOCOL_VERSION}`));
    return;
  }
  const agyPath = findAgy(ctx);
  ctx.emit({
    type: RES.HELLO,
    protocol: PROTOCOL_VERSION,
    hostVersion: HOST_VERSION,
    agyPath,
    agyVersion: await getAgyVersion(ctx, agyPath),
    ideAvailable: findIde(ctx) !== null,
    defaultCwd: safeDefaultCwd(ctx),
  });
}

async function captureModels(ctx, agyPath) {
  try {
    const { code, stdout } = await runCapture(ctx.spawnImpl, agyPath, ['models'], {
      env: ctx.env, timeoutMs: MODELS_TIMEOUT_MS,
    });
    return code === 0 ? success(stdout) : failure(ERR.INTERNAL, `agy models exited with code ${code}`);
  } catch (error) {
    return failure(ERR.SPAWN_FAILED, error.message);
  }
}

async function handleModels(ctx, msg) {
  const reqId = replyId(msg);
  if (!reqId) {
    ctx.emit(errorMsg(null, ERR.BAD_REQUEST, 'invalid reqId'));
    return;
  }
  const agyPath = findAgy(ctx);
  if (!agyPath) {
    ctx.emit(errorMsg(reqId, ERR.AGY_NOT_FOUND, 'agy executable not found'));
    return;
  }
  const outcome = await captureModels(ctx, agyPath);
  ctx.emit(outcome.ok
    ? { type: RES.MODELS, reqId, models: parseModels(outcome.value) }
    : errorMsg(reqId, outcome.code, outcome.message));
}

function resolveRunCwd(ctx, requested) {
  if (requested) {
    return ctx.fsImpl.isDirectory(requested)
      ? success(requested)
      : failure(ERR.BAD_REQUEST, 'cwd must be an existing directory');
  }
  const dir = safeDefaultCwd(ctx);
  return dir ? success(dir) : failure(ERR.INTERNAL, 'default workspace is unavailable');
}

/** Validates a RUN request without side effects. Returns success({reqId, prompt, options, cwd, agyPath}). */
function buildRunPlan(ctx, msg, reqId) {
  const prompt = validatePrompt(msg.prompt);
  if (!prompt.ok) return failure(ERR.BAD_REQUEST, prompt.message);
  const options = validateRunOptions(msg.options);
  if (!options.ok) return failure(ERR.BAD_REQUEST, options.message);
  if (ctx.usedRunIds.has(reqId)) return failure(ERR.DUPLICATE_REQ, 'reqId already used');
  if (ctx.runs.size >= LIMITS.MAX_CONCURRENT_RUNS) {
    return failure(ERR.TOO_MANY_RUNS, 'too many concurrent runs');
  }
  const agyPath = findAgy(ctx);
  if (!agyPath) return failure(ERR.AGY_NOT_FOUND, 'agy executable not found');
  const cwd = resolveRunCwd(ctx, options.value.cwd);
  if (!cwd.ok) return cwd;
  return success({ reqId, prompt: prompt.value, options: options.value, cwd: cwd.value, agyPath });
}

async function handleRun(ctx, msg) {
  const reqId = replyId(msg);
  const plan = reqId ? buildRunPlan(ctx, msg, reqId) : failure(ERR.BAD_REQUEST, 'invalid reqId');
  if (!plan.ok) {
    ctx.emit(errorMsg(reqId, plan.code, plan.message));
    return;
  }
  ctx.usedRunIds.add(reqId);
  startRun(ctx, plan.value);
}

function spawnOptions(ctx, cwd) {
  return { cwd, shell: false, windowsHide: true, env: ctx.env, stdio: ['pipe', 'pipe', 'pipe'] };
}

/** A run's `ended` promise resolves exactly once, when its single EXIT has been emitted. */
function createRun(reqId) {
  const run = {
    reqId, child: null, cancelled: false, done: false, idleTimer: null, graceTimer: null,
    splitters: [], resolveEnded: null, ended: null,
  };
  run.ended = new Promise((resolve) => { run.resolveEnded = resolve; });
  return run;
}

function startRun(ctx, plan) {
  const run = createRun(plan.reqId);
  let child;
  try {
    child = ctx.spawnImpl(plan.agyPath, buildArgs(plan.options), spawnOptions(ctx, plan.cwd));
  } catch (error) {
    failSpawn(ctx, run, error);
    return;
  }
  run.child = child;
  ctx.runs.set(run.reqId, run);
  attachRun(ctx, run, plan.prompt);
}

function failSpawn(ctx, run, error) {
  ctx.emit(errorMsg(run.reqId, ERR.SPAWN_FAILED, error.message));
  finishRun(ctx, run, null, null);
}

function attachRun(ctx, run, prompt) {
  const { child } = run;
  const outSplit = createLineSplitter({
    onLine: (line) => onStdoutLine(ctx, run, line),
    onOverflow: () => overflowNote(ctx, run, 'stdout'),
  });
  const errSplit = createLineSplitter({
    onLine: (line) => onStderrLine(ctx, run, line),
    onOverflow: () => overflowNote(ctx, run, 'stderr'),
  });
  run.splitters = [outSplit, errSplit];
  child.on('error', (error) => onRunError(ctx, run, error));
  child.on('close', (code, signal) => finishRun(ctx, run, code, signal));
  // A cancelled run drops its output anyway, so do not wait for stdio to close after the child exited.
  child.on('exit', (code, signal) => {
    if (run.cancelled) finishRun(ctx, run, code, signal);
  });
  child.stdout?.on('data', (chunk) => {
    armIdleTimer(ctx, run);
    outSplit.push(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    armIdleTimer(ctx, run);
    errSplit.push(chunk);
  });
  child.stdin?.on('error', (error) => ctx.log('stdin-error', { reqId: run.reqId, code: error.code }));
  writePrompt(ctx, run, prompt);
  armIdleTimer(ctx, run);
}

function writePrompt(ctx, run, prompt) {
  try {
    run.child.stdin.end(buildStdinPayload(prompt));
  } catch (error) {
    ctx.log('stdin-write-failed', { reqId: run.reqId, code: error.code });
  }
}

function onRunError(ctx, run, error) {
  if (run.done) return;
  if (run.child.pid === undefined) {
    // Node leaves pid undefined when the process could not be created (e.g. ENOENT).
    failSpawn(ctx, run, error);
    return;
  }
  ctx.log('child-error', { reqId: run.reqId, code: error.code });
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** True once output must be dropped: the run was cancelled or its EXIT was already emitted. */
const isSilenced = (run) => run.cancelled || run.done;

function onStdoutLine(ctx, run, line) {
  if (isSilenced(run) || line.trim() === '') return;
  const parsed = parseJson(line);
  ctx.emit(parsed.ok
    ? { type: RES.EVENT, reqId: run.reqId, event: parsed.value }
    : { type: RES.STDERR, reqId: run.reqId, text: line });
}

function onStderrLine(ctx, run, line) {
  if (isSilenced(run) || line.trim() === '') return;
  ctx.emit({ type: RES.STDERR, reqId: run.reqId, text: line });
}

function overflowNote(ctx, run, stream) {
  if (isSilenced(run)) return;
  ctx.emit({
    type: RES.STDERR,
    reqId: run.reqId,
    text: `${stream} line exceeded ${LIMITS.MAX_LINE_BYTES} bytes and was discarded`,
  });
}

function armIdleTimer(ctx, run) {
  clearTimeout(run.idleTimer);
  if (run.done) return; // late output after finalize must not re-arm
  run.idleTimer = setTimeout(() => onIdle(ctx, run), ctx.idleTimeoutMs);
  run.idleTimer.unref(); // the open stdin keeps the host alive; the timer must not pin it
}

function onIdle(ctx, run) {
  if (run.done) return;
  ctx.emit({ type: RES.STDERR, reqId: run.reqId, text: `no output for ${ctx.idleTimeoutMs} ms; stopping agy` });
  trackKill(ctx, run);
}

/**
 * Starts (or re-attempts) the kill of a run's process tree. The run always ends: by its child's
 * exit, or by the grace timer's synthesized EXIT. `run.ended` is what shutdown awaits.
 */
function trackKill(ctx, run) {
  if (!run.child || run.done) return;
  armGrace(ctx, run);
  attemptKill(ctx, run);
}

/** Bounded wait for the child to exit; once it expires the run is ended with a synthesized EXIT. */
function armGrace(ctx, run) {
  if (run.graceTimer) return;
  run.graceTimer = setTimeout(() => {
    ctx.log('kill-grace-expired', { reqId: run.reqId });
    finishRun(ctx, run, null, null);
  }, ctx.killGraceMs);
}

/** Runs killTree off the current tick. A rejection or non-zero exit falls back to child.kill(). */
function attemptKill(ctx, run) {
  Promise.resolve()
    .then(() => (run.done ? undefined : ctx.killTree(run.child, ctx.env)))
    .then((code) => {
      if (typeof code === 'number' && code !== 0) throw new Error(`killTree exited with code ${code}`);
    })
    .catch((error) => onKillFailed(ctx, run, error));
}

function onKillFailed(ctx, run, error) {
  if (run.done) return;
  ctx.log('kill-failed', { reqId: run.reqId, message: error?.message });
  try {
    run.child.kill();
  } catch (killError) {
    ctx.log('child-kill-failed', { reqId: run.reqId, message: killError?.message });
  }
}

function handleCancel(ctx, msg) {
  const reqId = replyId(msg);
  const run = reqId ? ctx.runs.get(reqId) : undefined;
  if (!run) {
    ctx.emit(errorMsg(reqId, ERR.UNKNOWN_RUN, 'no active run with this reqId'));
    return;
  }
  run.cancelled = true;
  trackKill(ctx, run); // a repeated cancel re-attempts the kill while the run is still alive
  ctx.emit({ type: RES.CANCELLED, reqId });
}

/** Emits the single terminal EXIT for an accepted run, after flushing any unterminated output. */
function finishRun(ctx, run, code, signal) {
  if (run.done) return;
  for (const splitter of run.splitters) splitter.flush();
  run.done = true;
  clearTimeout(run.idleTimer);
  clearTimeout(run.graceTimer);
  ctx.runs.delete(run.reqId);
  ctx.emit({
    type: RES.EXIT,
    reqId: run.reqId,
    code: typeof code === 'number' ? code : null,
    signal: typeof signal === 'string' ? signal : null,
    cancelled: run.cancelled,
  });
  run.resolveEnded();
}

/** Kills every active run, then waits until each has ended (child exit or grace expiry). */
async function shutdownRuns(ctx) {
  const runs = [...ctx.runs.values()];
  for (const run of runs) {
    run.cancelled = true;
    trackKill(ctx, run);
  }
  await Promise.all(runs.map((run) => run.ended));
}

function launchIde(ctx, ide, target) {
  const child = ctx.spawnImpl(ide.exe, [ide.cliJs, target], {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
    env: { ...ctx.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.on('error', (error) => ctx.log('ide-spawn-error', { code: error.code }));
  child.unref();
}

async function handleOpenIde(ctx, msg) {
  const reqId = replyId(msg);
  if (!reqId) {
    ctx.emit(errorMsg(null, ERR.BAD_REQUEST, 'invalid reqId'));
    return;
  }
  const target = validateOpenIdePath(msg.path);
  if (!target.ok || !ctx.fsImpl.existsSync(target.value)) {
    ctx.emit(errorMsg(reqId, ERR.BAD_REQUEST, 'path must be an existing absolute path'));
    return;
  }
  const ide = findIde(ctx);
  if (!ide) {
    ctx.emit(errorMsg(reqId, ERR.IDE_NOT_FOUND, 'Antigravity IDE not found'));
    return;
  }
  try {
    launchIde(ctx, ide, target.value);
    ctx.emit({ type: RES.OK, reqId });
  } catch (error) {
    ctx.emit(errorMsg(reqId, ERR.SPAWN_FAILED, error.message));
  }
}

/** Stdin-driven entry point. stdout carries frames only. */
export function main({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  const bridge = createBridge({ send: (msg) => stdout.write(encodeMessage(msg)), env });
  // stdout writes may be asynchronous on Windows pipes, so exit only after they flush.
  const exitAfterFlush = (code) => stdout.write('', () => process.exit(code));
  const stopAndExit = (code) => bridge.shutdown().then(() => exitAfterFlush(code));
  const decoder = createDecoder(
    (msg) => {
      bridge.handle(msg);
    },
    (error) => {
      bridge.reportFrameError(error);
      if (error.fatal) stopAndExit(1);
    },
  );
  stdin.on('data', (chunk) => decoder.push(chunk));
  stdin.on('end', () => stopAndExit(0));
  stdin.on('error', () => stopAndExit(0));
  return bridge;
}

function isDirectRun(moduleUrl) {
  const entry = process.argv[1];
  return typeof entry === 'string' && pathToFileURL(path.resolve(entry)).href === moduleUrl;
}

if (isDirectRun(import.meta.url)) main();
