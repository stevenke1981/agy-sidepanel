// Independent zip reader for tests. It walks the end-of-central-directory, central and local headers
// itself, inflates deflated data and checks CRC-32 (bitwise reference) and sizes. It shares no code
// with scripts/build.mjs, so a bug in the writer cannot hide itself here.
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Bit-by-bit CRC-32 reference. */
export function referenceCrc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDir(buf) {
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('end of central directory not found');
}

function readLocalData(buf, meta) {
  assert.equal(buf.readUInt32LE(meta.localOffset), LOCAL_SIG, `bad local header for ${meta.name}`);
  const nameLen = buf.readUInt16LE(meta.localOffset + 26);
  const extraLen = buf.readUInt16LE(meta.localOffset + 28);
  const start = meta.localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + meta.compressedSize);
  assert.equal(raw.length, meta.compressedSize, `truncated data for ${meta.name}`);
  const data = meta.method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
  assert.equal(data.length, meta.size, `size mismatch for ${meta.name}`);
  assert.equal(referenceCrc32(data), meta.crc, `CRC mismatch for ${meta.name}`);
  return data;
}

function readCentralEntry(buf, p) {
  assert.equal(buf.readUInt32LE(p), CENTRAL_SIG, 'bad central header signature');
  const nameLen = buf.readUInt16LE(p + 28);
  const meta = {
    flags: buf.readUInt16LE(p + 8),
    method: buf.readUInt16LE(p + 10),
    crc: buf.readUInt32LE(p + 16),
    compressedSize: buf.readUInt32LE(p + 20),
    size: buf.readUInt32LE(p + 24),
    localOffset: buf.readUInt32LE(p + 42),
    name: buf.toString('utf8', p + 46, p + 46 + nameLen),
  };
  const next = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  return { entry: { ...meta, data: readLocalData(buf, meta) }, next };
}

/** Returns [{name, flags, method, crc, compressedSize, size, data}] from a zip Buffer. */
export function parseZip(buf) {
  const eocd = findEndOfCentralDir(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  assert.equal(buf.readUInt16LE(eocd + 8), count, 'entries on disk must equal total entries');
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    const { entry, next } = readCentralEntry(buf, p);
    entries.push(entry);
    p = next;
  }
  assert.equal(p - cdOffset, cdSize, 'central directory size mismatch');
  return entries;
}
