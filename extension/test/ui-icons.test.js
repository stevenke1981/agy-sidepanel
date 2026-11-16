import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { crc32, renderIconPng, renderIconPixels, ICON_SIZES } from '../../scripts/gen-icons.mjs';

const PNG_SIGNATURE = '89504e470d0a1a0a';

function readChunks(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), PNG_SIGNATURE);
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    const storedCrc = png.readUInt32BE(offset + 8 + length);
    chunks.push({ type, data, storedCrc, crcInput: png.subarray(offset + 4, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

test('crc32 matches the standard IEEE check value', () => {
  // Arrange
  const input = Buffer.from('123456789', 'ascii');
  // Act
  const result = crc32(input);
  // Assert
  assert.equal(result, 0xcbf43926);
});

test('every PNG chunk carries a valid CRC and the chunk order is IHDR, IDAT, IEND', () => {
  for (const size of ICON_SIZES) {
    const chunks = readChunks(renderIconPng(size));
    assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
    for (const chunk of chunks) assert.equal(crc32(chunk.crcInput), chunk.storedCrc, `${chunk.type} CRC`);
  }
});

test('IHDR declares the requested square size, 8-bit RGBA', () => {
  for (const size of ICON_SIZES) {
    const [ihdr] = readChunks(renderIconPng(size));
    assert.equal(ihdr.data.readUInt32BE(0), size);
    assert.equal(ihdr.data.readUInt32BE(4), size);
    assert.equal(ihdr.data[8], 8);
    assert.equal(ihdr.data[9], 6);
  }
});

test('IDAT inflates to filter-byte scanlines of the declared size', () => {
  const size = 32;
  const chunks = readChunks(renderIconPng(size));
  const raw = inflateSync(chunks.find((c) => c.type === 'IDAT').data);
  assert.equal(raw.length, (size * 4 + 1) * size);
  for (let y = 0; y < size; y++) assert.equal(raw[y * (size * 4 + 1)], 0);
});

test('corners are transparent and the centre is an opaque gradient or glyph pixel', () => {
  const size = 48;
  const pixels = renderIconPixels(size);
  const alphaAt = (x, y) => pixels[(y * size + x) * 4 + 3];
  assert.equal(alphaAt(0, 0), 0);
  assert.equal(alphaAt(size - 1, size - 1), 0);
  assert.equal(alphaAt(size >> 1, size >> 1), 255);
});

test('gradient runs indigo at top-left toward violet at bottom-right', () => {
  const size = 128;
  const pixels = renderIconPixels(size);
  const at = (x, y) => [0, 1, 2].map((i) => pixels[(y * size + x) * 4 + i]);
  const [tlR, , tlB] = at(24, 24); // inside the rounded corner (radius 30px at 128)
  const [brR, , brB] = at(size - 14, size - 40);
  assert.ok(tlB > tlR, 'top-left is indigo (blue dominant)');
  assert.ok(brR > tlR, 'bottom-right is more violet (red rises)');
  assert.ok(brB >= 200, 'bottom-right blue stays high');
});
