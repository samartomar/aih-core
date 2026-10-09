import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeReadPinned, nativeReadPinnedRuntime } from '../dist/core/internal/native-material.js';
import { ownedDirectoryChain, pathPins, pinsMatch } from '../dist/core/internal/host-files.js';

const posix = process.platform !== 'win32';
// Fixtures live under the home directory, not the sticky world-writable temp directory, so the mode and
// chain refusals below cannot pass vacuously because an ancestor is already group/other writable.
const root = mkdtempSync(join(realpathSync(homedir()), '.aihq-core-test-'));
const cleanChain = posix && ownedDirectoryChain(join(root, 'file'), () => true);
const cleanSkip = !cleanChain && 'the temporary fixture directory chain is group/other writable or not a real-directory chain on this host';
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
test('the runtime reader refuses a multi-link file without POSIX, ownership or a clean mode', { skip: cleanSkip }, () => {
  const file = fixture('seamed', { links: 2 });
  // Positive control: the same file and chain are accepted by the seam, so each refusal below is attributable.
  assert.equal(nativeReadPinnedRuntime(file, 1024, check, seam).toString(), 'runtime-bytes');
  refused(() => nativeReadPinnedRuntime(file, 1024, check, { posix: false, owned: () => true }));
  refused(() => nativeReadPinnedRuntime(file, 1024, check, { posix: true, owned: () => false }));
  // Group/other write on the file refuses even when ownership and the chain would pass.
  try {
    for (const mode of [0o666, 0o664, 0o646, 0o620, 0o602]) {
      chmodSync(file, mode); refused(() => nativeReadPinnedRuntime(file, 1024, check, seam));
    }
  } finally { chmodSync(file, 0o644); }
  assert.equal(nativeReadPinnedRuntime(file, 1024, check, seam).toString(), 'runtime-bytes');
});
test('a link created during the read is refused unless the multi-link rule already holds', { skip: cleanSkip }, () => {
  const file = fixture('raced');
  const accepting = { posix: true, owned: () => true };
  // Positive control: an undisturbed single-link read is accepted under the same seam.
  assert.equal(nativeReadPinnedRuntime(file, 1024, check, accepting).toString(), 'runtime-bytes');
  let count = 0;
  const linking = { posix: true, owned: () => false, afterRead() { linkSync(file, join(file + '-race-' + count++)); } };
  refused(() => nativeReadPinnedRuntime(file, 1024, check, linking));
  assert.equal(count, 1);
});
test('the directory chain predicate demands real, owned, non-writable directories', { skip: cleanSkip }, () => {
  const directory = join(root, 'chain'); mkdirSync(directory);
  const file = join(directory, 'file');
  assert.equal(ownedDirectoryChain(file, () => true), true);
  assert.equal(ownedDirectoryChain(file, () => false), false);
  try {
    chmodSync(directory, 0o777);
    assert.equal(ownedDirectoryChain(file, () => true), false);
  } finally { chmodSync(directory, 0o755); }
  assert.equal(ownedDirectoryChain(file, () => true), true);
  assert.equal(ownedDirectoryChain(join(directory, 'missing', 'file'), () => true), false);
  const system = lstatSync('/usr/lib', { bigint: true });
  if (system.uid === 0n && (system.mode & 0o022n) === 0n) assert.equal(ownedDirectoryChain('/usr/lib/anything', uid => uid === 0n), true);
});
test('the directory chain predicate refuses any symlink ancestor', { skip: cleanSkip }, () => {
  const real = join(root, 'real-chain'); mkdirSync(real);
  const link = join(root, 'link-chain'); symlinkSync(real, link, 'dir');
  assert.equal(ownedDirectoryChain(join(real, 'file'), () => true), true);
  assert.equal(ownedDirectoryChain(join(link, 'file'), () => true), false);
  mkdirSync(join(real, 'inner'));
  assert.equal(ownedDirectoryChain(join(link, 'inner', 'file'), () => true), false);
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
