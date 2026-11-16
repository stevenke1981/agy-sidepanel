// ZIP writer round-trip, checked by the independent reader in support/zip-reader.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { assertArchiveName, buildZip, crc32, toDosDateTime } from '../build.mjs';
import { parseZip } from './support/zip-reader.mjs';

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('crc32', () => {
  it('matches the standard check value for "123456789"', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  it('agrees with a bitwise reference on non-trivial data', () => {
    const data = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) & 0xff));
    let ref = 0xffffffff;
    for (const byte of data) {
      ref ^= byte;
      for (let k = 0; k < 8; k += 1) ref = ref & 1 ? (ref >>> 1) ^ 0xedb88320 : ref >>> 1;
    }
    assert.equal(crc32(data), (ref ^ 0xffffffff) >>> 0);
  });
});

describe('buildZip round-trip', () => {
  it('round-trips deflated, stored, empty and UTF-8 named entries with correct CRC and sizes', () => {
    const compressible = Buffer.from('agy bridge line\n'.repeat(500));
    const incompressible = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 97 + 13) & 0xff));
    const input = [
      { name: 'extension/manifest.json', data: compressible },
      { name: 'host/src/bridge.mjs', data: incompressible },
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: '說明/讀我.md', data: Buffer.from('中文內容 OK') },
    ];
    const entries = parseZip(buildZip(input));
    assert.deepEqual(entries.map((e) => e.name), input.map((e) => e.name));
    entries.forEach((entry, index) => {
      assert.deepEqual(entry.data, input[index].data, `content differs for ${entry.name}`);
    });
  });

  it('uses deflate for compressible data and store when deflate would not shrink it', () => {
    const entries = parseZip(
      buildZip([
        { name: 'a.txt', data: Buffer.from('x'.repeat(2000)) },
        { name: 'b.bin', data: Buffer.from([1, 2, 3]) },
      ]),
    );
    assert.equal(entries[0].method, 8);
    assert.equal(entries[1].method, 0);
  });

  it('sets the UTF-8 name flag (bit 11) on every entry', () => {
    const entries = parseZip(buildZip([{ name: '檔案.txt', data: Buffer.from('a') }]));
    assert.equal(entries[0].flags & 0x0800, 0x0800);
  });

  it('is byte-identical across runs for the same input and timestamp', () => {
    const time = new Date(Date.UTC(2024, 5, 1, 12, 0, 0));
    const input = [{ name: 'x/y.js', data: Buffer.from('export {};') }];
    assert.deepEqual(buildZip(input, { time }), buildZip(input, { time }));
  });

  it('rejects unsafe archive paths', () => {
    for (const bad of ['../evil', '/abs', 'a\\b', 'a/../b', 'a//b', '', 'C:/x', 'dir/']) {
      assert.throws(() => assertArchiveName(bad), /unsafe archive path/, bad);
    }
    assert.equal(assertArchiveName('extension/manifest.json'), 'extension/manifest.json');
  });

  it('rejects timestamps outside the DOS range', () => {
    assert.throws(() => toDosDateTime(new Date(Date.UTC(1975, 0, 1))), RangeError);
  });

  it('encodes DOS date and time for a known instant', () => {
    const { time, day } = toDosDateTime(new Date(Date.UTC(2020, 0, 2, 3, 4, 6)));
    assert.equal(time, (3 << 11) | (4 << 5) | 3);
    assert.equal(day, ((2020 - 1980) << 9) | (1 << 5) | 2);
  });
});

describe('system tar reads the archive (Windows bsdtar)', () => {
  it('lists the fixture entries with tar -tf', (t) => {
    if (process.platform !== 'win32') {
      t.skip('tar -tf zip check is Windows-only; Linux relies on the parseZip round-trip above');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'agyb-tar-'));
    tempDirs.push(dir);
    const zipPath = join(dir, 'fixture.zip');
    writeFileSync(zipPath, buildZip([
      { name: 'extension/manifest.json', data: Buffer.from('{}') },
      { name: 'host/src/bridge.mjs', data: Buffer.from('export {};') },
    ]));
    const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-tf', zipPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /extension\/manifest\.json/);
    assert.match(result.stdout, /host\/src\/bridge\.mjs/);
  });
});
