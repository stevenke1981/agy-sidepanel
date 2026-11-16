// Native messaging framing (4-byte little-endian length prefix + UTF-8 JSON)
// and NDJSON line splitting for agy stdout/stderr.
import { LIMITS } from '../../extension/src/lib/protocol.js';

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 4;
const NEWLINE = 0x0a;

function toBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
}

function frameError(message, fatal) {
  return Object.assign(new Error(message), { code: 'FRAME_ERROR', fatal });
}

export function encodeMessage(obj) {
  const json = JSON.stringify(obj);
  if (json === undefined) throw new TypeError('message is not JSON-serializable');
  const body = Buffer.from(json, 'utf8');
  if (body.length > MAX_FRAME_BYTES) {
    throw new RangeError(`frame of ${body.length} bytes exceeds ${MAX_FRAME_BYTES}`);
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental frame decoder. Chunks may split frames anywhere and may carry several frames.
 * - Invalid JSON inside a complete frame: onError(non-fatal), decoding continues.
 * - Declared length > MAX_FRAME_BYTES: onError(fatal), decoder stops and ignores further input.
 */
export function createDecoder(onMessage, onError) {
  let pending = Buffer.alloc(0);
  let broken = false;

  function deliver(body) {
    let message;
    try {
      message = JSON.parse(body.toString('utf8'));
    } catch (error) {
      onError(frameError(`invalid JSON frame: ${error.message}`, false));
      return;
    }
    onMessage(message);
  }

  function markBroken(length) {
    broken = true;
    pending = Buffer.alloc(0);
    onError(frameError(`frame of ${length} bytes exceeds ${MAX_FRAME_BYTES}`, true));
  }

  function drain() {
    while (!broken && pending.length >= HEADER_BYTES) {
      const length = pending.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) return markBroken(length);
      if (pending.length < HEADER_BYTES + length) return;
      const body = pending.subarray(HEADER_BYTES, HEADER_BYTES + length);
      pending = pending.subarray(HEADER_BYTES + length);
      deliver(body);
    }
  }

  return {
    push(chunk) {
      if (broken) return;
      pending = Buffer.concat([pending, toBuffer(chunk)]);
      drain();
    },
    isBroken: () => broken,
  };
}

function decodeLine(buf) {
  const end = buf.length > 0 && buf[buf.length - 1] === 0x0d ? buf.length - 1 : buf.length;
  return buf.toString('utf8', 0, end);
}

/**
 * Splits a byte stream into '\n'-terminated lines (CR stripped).
 * A line longer than maxLineBytes is discarded up to its newline and reported via onOverflow().
 * Call flush() at end of stream to emit an unterminated trailing line.
 */
export function createLineSplitter({
  onLine,
  onOverflow = () => {},
  maxLineBytes = LIMITS.MAX_LINE_BYTES,
}) {
  let pending = Buffer.alloc(0);
  let discarding = false;

  function absorb(part) {
    if (discarding || part.length === 0) return;
    if (pending.length + part.length > maxLineBytes) {
      discarding = true;
      pending = Buffer.alloc(0);
      return;
    }
    pending = Buffer.concat([pending, part]);
  }

  function emitLine() {
    if (discarding) {
      discarding = false;
      onOverflow();
    } else {
      onLine(decodeLine(pending));
    }
    pending = Buffer.alloc(0);
  }

  return {
    push(chunk) {
      const data = toBuffer(chunk);
      let offset = 0;
      for (;;) {
        const newline = data.indexOf(NEWLINE, offset);
        absorb(data.subarray(offset, newline === -1 ? data.length : newline));
        if (newline === -1) return;
        emitLine();
        offset = newline + 1;
      }
    },
    flush() {
      if (discarding || pending.length > 0) emitLine();
    },
  };
}
