import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FRAME_BYTES, createDecoder, createLineSplitter, encodeMessage,
} from '../src/framing.mjs';

function decodeAll(chunks) {
  const messages = [];
  const errors = [];
  const decoder = createDecoder((m) => messages.push(m), (e) => errors.push(e));
  for (const chunk of chunks) decoder.push(chunk);
  return { messages, errors, decoder };
}

test('encodeMessage writes a 4-byte little-endian length then UTF-8 JSON', () => {
  const frame = encodeMessage({ type: 'hello', name: '中文' });
  const body = Buffer.from(JSON.stringify({ type: 'hello', name: '中文' }), 'utf8');
  assert.equal(frame.readUInt32LE(0), body.length);
  assert.deepEqual(frame.subarray(4), body);
});

test('decoder reassembles a frame split at every byte boundary', () => {
  const frame = encodeMessage({ type: 'run', prompt: 'split 中文 across bytes' });
  const chunks = [...frame].map((b) => Buffer.from([b]));
  const { messages, errors } = decodeAll(chunks);
  assert.deepEqual(messages, [{ type: 'run', prompt: 'split 中文 across bytes' }]);
  assert.equal(errors.length, 0);
});

test('decoder yields several messages from one chunk in order', () => {
  const chunk = Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2 }), encodeMessage({ n: 3 })]);
  const { messages } = decodeAll([chunk]);
  assert.deepEqual(messages, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('decoder keeps a trailing partial frame until the rest arrives', () => {
  const first = encodeMessage({ n: 1 });
  const second = encodeMessage({ n: 2 });
  const joined = Buffer.concat([first, second]);
  const cut = first.length + 2;
  const { messages, decoder } = decodeAll([joined.subarray(0, cut)]);
  assert.deepEqual(messages, [{ n: 1 }]);
  decoder.push(joined.subarray(cut));
  assert.deepEqual(messages, [{ n: 1 }, { n: 2 }]);
});

test('decoder rejects a frame larger than 64 MB as fatal and stops', () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
  const { messages, errors, decoder } = decodeAll([header, encodeMessage({ after: true })]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, true);
  assert.equal(decoder.isBroken(), true);
  assert.deepEqual(messages, []);
});

test('decoder accepts a frame of exactly 64 MB without reporting an error', () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_FRAME_BYTES, 0);
  const { errors, decoder } = decodeAll([header]);
  assert.equal(errors.length, 0);
  assert.equal(decoder.isBroken(), false);
});

test('decoder reports invalid JSON as non-fatal and keeps decoding', () => {
  const bad = Buffer.alloc(4 + 3);
  bad.writeUInt32LE(3, 0);
  bad.write('{x}', 4, 'utf8');
  const { messages, errors } = decodeAll([Buffer.concat([bad, encodeMessage({ ok: 1 })])]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, false);
  assert.deepEqual(messages, [{ ok: 1 }]);
});

test('encodeMessage refuses frames above 64 MB', () => {
  const huge = 'x'.repeat(MAX_FRAME_BYTES + 1);
  assert.throws(() => encodeMessage({ huge }), RangeError);
});

test('line splitter joins lines across chunks and strips CR', () => {
  const lines = [];
  const splitter = createLineSplitter({ onLine: (l) => lines.push(l) });
  splitter.push('{"a"');
  splitter.push(':1}\r\n{"b":2}\n{"c"');
  splitter.push(':3}');
  splitter.flush();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('line splitter discards an over-long line and reports overflow once', () => {
  const lines = [];
  let overflows = 0;
  const splitter = createLineSplitter({
    onLine: (l) => lines.push(l),
    onOverflow: () => { overflows += 1; },
    maxLineBytes: 10,
  });
  splitter.push('0123456789ABCDEF');
  splitter.push('GHIJ\nok\n');
  assert.deepEqual(lines, ['ok']);
  assert.equal(overflows, 1);
});
