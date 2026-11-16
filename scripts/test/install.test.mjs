// install.ps1 / uninstall.ps1 end-to-end on Windows, run under Windows PowerShell 5.1 and pwsh 7.
// Uses a temp stub source tree, a temp InstallDir and a throwaway HKCU registry root that is deleted
// afterwards. The real HKCU\Software\Google\Chrome key is never touched.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_PS1 = join(SCRIPTS_DIR, 'install.ps1');
const UNINSTALL_PS1 = join(SCRIPTS_DIR, 'uninstall.ps1');
const NODE = process.execPath;
const ORIGIN = 'chrome-extension://dnildepikbjklalofggmgafohplflpgg/';
const SHELLS = [
  { name: 'Windows PowerShell 5.1', exe: 'powershell.exe' },
  { name: 'PowerShell 7', exe: 'pwsh' },
];
const TMP = tmpdir();
const registryRoots = [];

after(() => {
  for (const name of registryRoots) {
    spawnSync('reg', ['delete', `HKCU\\Software\\${name}`, '/f'], { encoding: 'utf8', windowsHide: true });
  }
});

function skipReason() {
  if (process.platform !== 'win32') return 'install.ps1 targets Windows; not run on this platform';
  if (/[%&"]|[^\x00-\x7F]/.test(TMP)) return `temp dir ${TMP} has characters install.ps1 rejects by design`;
  return null;
}

function shellAvailable(exe) {
  const probe = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  return probe.status === 0;
}

function runScript(shell, script, args) {
  return spawnSync(
    shell.exe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8', timeout: 180000, windowsHide: true },
  );
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function makeSource() {
  const src = mkdtempSync(join(TMP, 'agyb-src-'));
  writeTree(src, {
    'extension/manifest.json': JSON.stringify({ manifest_version: 3, name: 'stub', version: '1.0.0' }),
    'extension/src/lib/protocol.js': 'export const X = 1;\n',
    'extension/test/x.test.js': 'import "node:test";\n',
    'host/src/bridge.mjs': "import '../../extension/src/lib/protocol.js';\n",
    'host/test/b.test.mjs': 'import "node:test";\n',
    'host/agy-bridge.cmd.tpl': '@echo off\r\n"{{NODE}}" "%~dp0src\\bridge.mjs" %*\r\n',
  });
  return src;
}

function makeCase() {
  const name = `agy-bridge-test-${randomBytes(6).toString('hex')}`;
  registryRoots.push(name);
  const base = mkdtempSync(join(TMP, 'agyb-inst-'));
  const installDir = join(base, 'agy-bridge');
  return {
    name,
    regRoot: `HKCU:\\Software\\${name}`,
    installDir,
    src: makeSource(),
    cmdPath: join(installDir, 'host', 'agy-bridge.cmd'),
    manifestPath: join(installDir, 'host', 'com.agy.bridge.json'),
  };
}

function regDefault(caseName, vendorPath) {
  const key = `HKCU\\Software\\${caseName}\\${vendorPath}\\NativeMessagingHosts\\com.agy.bridge`;
  const result = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  const match = /REG_SZ\s+(.*)$/m.exec(result.stdout);
  return match ? match[1].trim() : '';
}

function installArgs(c, extra = []) {
  return ['-InstallDir', c.installDir, '-SourceDir', c.src, '-NodePath', NODE, '-RegistryRoot', c.regRoot, ...extra];
}

function assertCmdFile(path) {
  const bytes = readFileSync(path);
  assert.ok(bytes.every((b) => b < 0x80), 'agy-bridge.cmd must be ASCII');
  const text = bytes.toString('latin1');
  assert.ok(!/(^|[^\r])\n/.test(text), 'every LF must be preceded by CR');
  assert.ok(text.endsWith('\r\n'), 'file must end with CRLF');
  assert.ok(!text.includes('{{NODE}}'), 'placeholder must be replaced');
  assert.ok(text.includes(`"${NODE}" "%~dp0src\\bridge.mjs" %*`), 'node path rendered and quoted');
}

function assertHostManifest(path, cmdPath) {
  const bytes = readFileSync(path);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'manifest must not start with a BOM');
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.equal(manifest.name, 'com.agy.bridge');
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path.toLowerCase(), cmdPath.toLowerCase());
  assert.deepEqual(manifest.allowed_origins, [ORIGIN]);
}

function describeForShell(shell) {
  const reason = skipReason() ?? (shellAvailable(shell.exe) ? null : `${shell.exe} not found`);
  describe(`install.ps1 / uninstall.ps1 under ${shell.name}`, { skip: reason ?? false }, () => {
    it('installs: renders cmd and manifest, registers Chrome, Chromium and Edge with -AllBrowsers', () => {
      const c = makeCase();
      const result = runScript(shell, INSTALL_PS1, installArgs(c, ['-AllBrowsers']));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(existsSync(join(c.installDir, 'extension', 'src', 'lib', 'protocol.js')));
      assert.ok(existsSync(join(c.installDir, 'host', 'src', 'bridge.mjs')));
      assert.ok(!existsSync(join(c.installDir, 'extension', 'test')), 'test folders must not be installed');
      assert.ok(!existsSync(join(c.installDir, 'host', 'test')), 'test folders must not be installed');
      assertCmdFile(c.cmdPath);
      assertHostManifest(c.manifestPath, c.cmdPath);
      assert.equal(regDefault(c.name, 'Google\\Chrome'), c.manifestPath);
      assert.equal(regDefault(c.name, 'Chromium'), c.manifestPath);
      assert.equal(regDefault(c.name, 'Microsoft\\Edge'), c.manifestPath);
    });

    it('without -AllBrowsers registers only Google Chrome', () => {
      const c = makeCase();
      const result = runScript(shell, INSTALL_PS1, installArgs(c));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(regDefault(c.name, 'Google\\Chrome'), c.manifestPath);
      assert.equal(regDefault(c.name, 'Chromium'), null);
      assert.equal(regDefault(c.name, 'Microsoft\\Edge'), null);
    });

    it('replaces an existing install, keeps workspace, and moves the previous payload to .bak', () => {
      const c = makeCase();
      assert.equal(runScript(shell, INSTALL_PS1, installArgs(c)).status, 0);
      mkdirSync(join(c.installDir, 'workspace'), { recursive: true });
      writeFileSync(join(c.installDir, 'workspace', 'keep.txt'), 'keep');
      const second = runScript(shell, INSTALL_PS1, installArgs(c));
      assert.equal(second.status, 0, second.stdout + second.stderr);
      assert.ok(existsSync(join(`${c.installDir}.bak`, 'extension', 'manifest.json')), 'previous payload kept in .bak');
      assert.equal(readFileSync(join(c.installDir, 'workspace', 'keep.txt'), 'utf8'), 'keep');
      assertCmdFile(c.cmdPath);
    });

    it('-WhatIf changes nothing on disk or in the registry', () => {
      const c = makeCase();
      const result = runScript(shell, INSTALL_PS1, installArgs(c, ['-WhatIf']));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(existsSync(c.installDir), false);
      assert.equal(regDefault(c.name, 'Google\\Chrome'), null);
    });

    it('uninstall keeps the workspace, and -Purge removes everything including keys', () => {
      const c = makeCase();
      assert.equal(runScript(shell, INSTALL_PS1, installArgs(c, ['-AllBrowsers'])).status, 0);
      mkdirSync(join(c.installDir, 'workspace'), { recursive: true });
      writeFileSync(join(c.installDir, 'workspace', 'keep.txt'), 'keep');
      const plain = runScript(shell, UNINSTALL_PS1, ['-InstallDir', c.installDir, '-RegistryRoot', c.regRoot]);
      assert.equal(plain.status, 0, plain.stdout + plain.stderr);
      assert.equal(regDefault(c.name, 'Google\\Chrome'), null);
      assert.equal(regDefault(c.name, 'Chromium'), null);
      assert.equal(regDefault(c.name, 'Microsoft\\Edge'), null);
      assert.ok(existsSync(join(c.installDir, 'workspace', 'keep.txt')), 'workspace kept without -Purge');
      assert.equal(existsSync(join(c.installDir, 'host')), false);
      const purge = runScript(shell, UNINSTALL_PS1, ['-InstallDir', c.installDir, '-RegistryRoot', c.regRoot, '-Purge']);
      assert.equal(purge.status, 0, purge.stdout + purge.stderr);
      assert.equal(existsSync(c.installDir), false);
    });

    it('rejects an InstallDir containing % with exit code 2 and changes nothing', () => {
      const c = makeCase();
      const bad = join(dirname(c.installDir), 'bad%dir');
      const result = runScript(shell, INSTALL_PS1, ['-InstallDir', bad, '-SourceDir', c.src, '-NodePath', NODE, '-RegistryRoot', c.regRoot]);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /%/);
      assert.equal(existsSync(bad), false);
    });

    it('rejects Node.js older than 20 with exit code 3', () => {
      const c = makeCase();
      const fake = join(c.src, 'fake-node.cmd');
      writeFileSync(fake, '@echo v18.20.0\r\n');
      const result = runScript(shell, INSTALL_PS1, ['-InstallDir', c.installDir, '-SourceDir', c.src, '-NodePath', fake, '-RegistryRoot', c.regRoot]);
      assert.equal(result.status, 3, result.stdout + result.stderr);
      assert.match(result.stderr, /Node\.js 20/);
      assert.equal(existsSync(c.installDir), false);
    });
  });
}

for (const shell of SHELLS) describeForShell(shell);
