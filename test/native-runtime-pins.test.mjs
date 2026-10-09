import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeReadPinned, nativeReadPinnedRuntime } from '../dist/core/internal/native-material.js';
import { ownedDirectoryChain, pathPins, pinsMatch } from '../dist/core/internal/host-files.js';

const posix = process.platform !== 'win32';
const root = mkdtempSync(join(realpathSync(tmpdir()), 'aih-runtime-pins-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const check = () => {};
const seam = { posix: true, owned: () => true };
const refused = fn => assert.throws(fn, error => error.reason === 'configuration-unavailable');
const asRoot = posix && process.getuid() === 0;
function fixture(name, { links = 1, mode = 0o644 } = {}) {
  const directory = join(root, name); mkdirSync(directory); const file = join(directory, 'runtime');
  writeFileSync(file, 'runtime-bytes'); chmodSync(file, mode);
  if (links > 1) linkSync(file, join(directory, 'alias'));
  return file;
}

test('a user-owned multi-link file is refused by the runtime and strict readers', { skip: asRoot && 'running as root' }, () => {
  const file = fixture('user-multilink', { links: 2 });
  refused(() => nativeReadPinnedRuntime(file, 1024, check));
  refused(() => nativeReadPinned(file, 1024, check));
});
test('a single-link file is read unchanged by both readers', () => {
  const file = fixture('single');
  assert.equal(nativeReadPinned(file, 1024, check).toString(), 'runtime-bytes');
  assert.equal(nativeReadPinnedRuntime(file, 1024, check).toString(), 'runtime-bytes');
  assert.equal(nativeReadPinnedRuntime(file, 1024, check, seam).toString(), 'runtime-bytes');
});
test('the runtime reader refuses a multi-link file without POSIX, ownership or a clean mode', () => {
  const file = fixture('seamed', { links: 2 });
  refused(() => nativeReadPinnedRuntime(file, 1024, check, { posix: false, owned: () => true }));
  refused(() => nativeReadPinnedRuntime(file, 1024, check, { posix: true, owned: () => false }));
  // Group/other write on the file refuses even when ownership and the chain would pass.
  for (const mode of [0o666, 0o664, 0o646, 0o620, 0o602]) {
    if (!posix) break;
    chmodSync(file, mode); refused(() => nativeReadPinnedRuntime(file, 1024, check, seam));
  }
  if (!posix) refused(() => nativeReadPinnedRuntime(file, 1024, check, seam)); // Windows modes are never group/other-clean here.
});
test('the directory chain predicate demands real, owned, non-writable directories', { skip: !posix && 'POSIX only' }, () => {
  const directory = join(root, 'chain'); mkdirSync(directory);
  assert.equal(ownedDirectoryChain(join(directory, 'file'), () => false), false);
  chmodSync(directory, 0o777);
  assert.equal(ownedDirectoryChain(join(directory, 'file'), () => true), false);
  assert.equal(ownedDirectoryChain(join(directory, 'missing', 'file'), () => true), false);
  const system = lstatSync('/usr/lib', { bigint: true });
  if (system.uid === 0n && (system.mode & 0o022n) === 0n) assert.equal(ownedDirectoryChain('/usr/lib/anything', uid => uid === 0n), true);
});
test('other path pin callers keep refusing multi-link files', () => {
  const file = fixture('strict-pins', { links: 2 });
  assert.throws(() => pathPins(file), /unsafe-path/);
  const pins = pathPins(file, true);
  assert.equal(pinsMatch(pins), false);
  assert.equal(pinsMatch(pins, true), true);
});
test('a real root-owned multi-link system file is accepted only by the runtime reader', { skip: !posix && 'POSIX only' }, t => {
  const candidates = ['/usr/lib/cargo/bin/coreutils/env', '/usr/bin/perl', '/usr/bin/git', '/usr/bin/gawk', '/usr/bin/mawk',
    ...(existsSync('/usr/bin') ? readdirSync('/usr/bin').filter(name => /^perl5/.test(name)).map(name => `/usr/bin/${name}`) : [])];
  for (const candidate of candidates) {
    let path; let stats;
    try { path = realpathSync(candidate); stats = lstatSync(path, { bigint: true }); } catch { continue; }
    if (!stats.isFile() || stats.nlink < 2n || stats.uid !== 0n || (stats.mode & 0o022n) !== 0n || stats.size > 64n * 1024n * 1024n) continue;
    const bytes = nativeReadPinnedRuntime(path, 64 * 1024 * 1024, check);
    assert.equal(BigInt(bytes.length), stats.size);
    refused(() => nativeReadPinned(path, 64 * 1024 * 1024, check));
    t.diagnostic(`runtime file: ${path} (nlink ${stats.nlink})`);
    return;
  }
  t.skip('no root-owned multi-link regular file with a root-owned chain found on this host');
});
