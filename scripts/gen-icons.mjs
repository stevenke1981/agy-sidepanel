#!/usr/bin/env node
// Zero-dependency PNG icon generator for the agy Bridge extension.
// Original mark (no third-party logos): rounded square, indigo-to-violet gradient,
// white chevron (prompt) plus an orbit dot (response). Rendered with 4x4 supersampling.
// Usage: node scripts/gen-icons.mjs [outDir]   (default: extension/icons)

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ICON_SIZES = Object.freeze([16, 32, 48, 128]);
const SUPERSAMPLE = 4;
const CORNER_RADIUS = 0.24;
const CHEVRON = Object.freeze([
  [0.3, 0.36],
  [0.5, 0.52],
  [0.3, 0.68]
]);
const CHEVRON_HALF_WIDTH = 0.06;
const DOT = Object.freeze({ x: 0.7, y: 0.52, r: 0.07 });
const GRADIENT_FROM = Object.freeze([0x31, 0x2e, 0x81]); // indigo
const GRADIENT_TO = Object.freeze([0x8b, 0x5c, 0xf6]); // violet
const WHITE = Object.freeze([255, 255, 255]);

const CRC_TABLE = buildCrcTable();

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32 (IEEE) as used by PNG chunks. */
export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function filteredScanlines(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: None
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  return raw;
}

/** Encode 8-bit RGBA pixels (Buffer, row-major) as a PNG file. */
export function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = deflateSync(filteredScanlines(width, height, rgba), { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function inRoundedSquare(u, v) {
  const half = 0.5 - CORNER_RADIUS;
  const qx = Math.abs(u - 0.5) - half;
  const qy = Math.abs(v - 0.5) - half;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
  return outside - CORNER_RADIUS <= 0;
}

function distanceToSegment(u, v, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(u - (ax + t * dx), v - (ay + t * dy));
}

function inGlyph(u, v) {
  for (let i = 0; i < CHEVRON.length - 1; i++) {
    if (distanceToSegment(u, v, CHEVRON[i], CHEVRON[i + 1]) <= CHEVRON_HALF_WIDTH) return true;
  }
  return Math.hypot(u - DOT.x, v - DOT.y) <= DOT.r;
}

function gradientAt(u, v) {
  const t = (u + v) / 2;
  return GRADIENT_FROM.map((from, i) => Math.round(from + (GRADIENT_TO[i] - from) * t));
}

function samplePixel(px, py, size) {
  let r = 0;
  let g = 0;
  let b = 0;
  let hits = 0;
  const total = SUPERSAMPLE * SUPERSAMPLE;
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const u = (px + (sx + 0.5) / SUPERSAMPLE) / size;
      const v = (py + (sy + 0.5) / SUPERSAMPLE) / size;
      if (!inRoundedSquare(u, v)) continue;
      const [cr, cg, cb] = inGlyph(u, v) ? WHITE : gradientAt(u, v);
      r += cr;
      g += cg;
      b += cb;
      hits++;
    }
  }
  if (hits === 0) return [0, 0, 0, 0];
  return [Math.round(r / hits), Math.round(g / hits), Math.round(b / hits), Math.round((255 * hits) / total)];
}

/** Rasterise the mark at the given square size; returns RGBA Buffer. */
export function renderIconPixels(size) {
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const [r, g, b, a] = samplePixel(px, py, size);
      const o = (py * size + px) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return out;
}

export function renderIconPng(size) {
  return encodePng(size, size, renderIconPixels(size));
}

/** Write icon<size>.png for every size into outDir. Returns the written paths. */
export function writeIcons(outDir, sizes = ICON_SIZES) {
  mkdirSync(outDir, { recursive: true });
  return sizes.map((size) => {
    const path = join(outDir, `icon${size}.png`);
    writeFileSync(path, renderIconPng(size));
    return path;
  });
}

function isMainModule() {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = process.argv[2] ? resolve(process.argv[2]) : join(here, '..', 'extension', 'icons');
  for (const path of writeIcons(outDir)) process.stdout.write(`wrote ${path}\n`);
}
