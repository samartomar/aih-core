// Behavioral tests for the fixed Linux SRT vendor-closure verifier. Synthetic fixtures
// live in isolated temporary directories under a real node_modules layout so import
// resolution is exercised; the packaged fixed closure is read for the real happy path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { compareCodeUnits, canonicalJson, sha256Hex } from '../../src/harness/native/canonical.mjs';
import { inspectLinuxVendorTree, validateLinuxRuntimeLock, verifyLinuxVendorClosure }
  from '../../src/harness/native/linux-runtime.mjs';

const VENDOR = '@anthropic-ai/sandbox-runtime';
const NAMES = [VENDOR, '@pondwader/socks5-server', 'commander', 'node-forge', 'zod'];
const VERSIONS = new Map([[VENDOR, '0.0.78'], ['@pondwader/socks5-server', '1.0.10'],
  ['commander', '12.1.0'], ['node-forge', '1.4.0'], ['zod', '3.25.76']]);
// Only the sha512 shape matters to the verifier; the expected bytes are the file pins.
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const RELEASE_COMMIT = 'a'.repeat(40);
// The fixtures use the five registered package identities so the closed five-package shape
// and the registered dependency map are exercised, not loosened.
const FIXTURE_FILES = new Map([
  [VENDOR, [['cli.js', '#!/usr/bin/env node\n'], ['dist/index.js', 'export {};\n']]],
  ['@pondwader/socks5-server', [['dist/index.js', 'module.exports = {};\n']]],
  ['commander', [['index.js', 'module.exports = {};\n']]],
  ['node-forge', [['lib/index.js', 'module.exports = {};\n']]],
  ['zod', [['index.cjs', 'module.exports = {};\n']]]
]);
const FIXTURE_MANIFEST = new Map([
  [VENDOR, { bin: { srt: 'cli.js' }, main: './dist/index.js' }],
  ['@pondwader/socks5-server', { main: 'dist/index.js' }],
  ['commander', { main: 'index.js' }],
  ['node-forge', { main: 'lib/index.js' }],
  ['zod', { main: 'index.cjs' }]
]);

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = path => realpathSync.native(path);

const withRoot = body => {
  const root = mkdtempSync(join(tmpdir(), 'aihq-linux-runtime-'));
  try { return body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const writeFixture = root => {
  for (const name of NAMES) {
    const directory = join(root, 'node_modules', name);
    mkdirSync(directory, { recursive: true });
    const dependencies = name === VENDOR
      ? Object.fromEntries(NAMES.slice(1).map(dependency => [dependency, '^1.0.0'])) : {};
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name, version: VERSIONS.get(name),
      ...FIXTURE_MANIFEST.get(name), ...(name === VENDOR ? { dependencies } : {}) }, null, 2)}\n`);
    for (const [path, content] of FIXTURE_FILES.get(name)) {
      const file = join(directory, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  return root;
};

// Rebuild the fixture lock exactly the way the packaged lock is shaped: canonical file
// order, byte pins, and a canonical package digest.
const buildLock = root => {
  const packages = NAMES.map(name => {
    const directory = join(root, 'node_modules', name);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const files = [];
    const visit = (current, prefix) => {
      for (const entry of readdirSync(current).sort(compareCodeUnits)) {
        const child = join(current, entry);
        const path = prefix === '' ? entry : `${prefix}/${entry}`;
        if (lstatSync(child).isDirectory()) visit(child, path);
        else { const bytes = readFileSync(child); files.push({ path, byteLength: bytes.length, sha256: sha(bytes) }); }
      }
    };
    visit(directory, '');
    return { name, version: manifest.version, integrity: INTEGRITY, files };
  });
  return { format: 1, vendor: { name: VENDOR, version: VERSIONS.get(VENDOR), releaseCommit: RELEASE_COMMIT,
    archiveIntegrity: INTEGRITY }, packages, treeSha256: sha256Hex(canonicalJson(packages)) };
};

const rootsFor = root => NAMES.map(name => ({ name, root: join(root, 'node_modules', name) }));

const syntheticLock = () => {
  const packages = NAMES.map((name, index) => ({ name, version: VERSIONS.get(name), integrity: INTEGRITY,
    files: [{ path: index === 0 ? 'a.js' : 'package.json', byteLength: 2, sha256: 'a'.repeat(64) }] }));
  return { format: 1, vendor: { name: VENDOR, version: VERSIONS.get(VENDOR), releaseCommit: RELEASE_COMMIT,
    archiveIntegrity: INTEGRITY }, packages, treeSha256: sha256Hex(canonicalJson(packages)) };
};

const clone = value => JSON.parse(JSON.stringify(value));

const fixedLock = () => JSON.parse(readFileSync(
  new URL('../../src/harness/native/linux/runtime-lock.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------------------
// Portable lock validation
// ---------------------------------------------------------------------------------------

test('the packaged fixed lock validates with the fixed five packages and 848 files', () => {
  const lock = fixedLock();
  assert.equal(validateLinuxRuntimeLock(lock), true);
  assert.equal(lock.packages.length, 5);
  assert.equal(lock.packages.reduce((total, pkg) => total + pkg.files.length, 0), 848);
  assert.deepEqual(lock.packages.map(pkg => pkg.name),
    [VENDOR, '@pondwader/socks5-server', 'commander', 'node-forge', 'zod']);
  assert.equal(lock.vendor.name, lock.packages[0].name);
  assert.equal(lock.vendor.archiveIntegrity, lock.packages[0].integrity);
  assert.equal(lock.treeSha256, sha256Hex(canonicalJson(clone(lock.packages))));
});

test('a small synthetic five-package lock validates', () => {
  assert.equal(validateLinuxRuntimeLock(syntheticLock()), true);
});

test('validateLinuxRuntimeLock rejects malformed identities and closed shapes', () => {
  const base = syntheticLock();
  const reject = (label, mutate) => {
    const value = clone(base);
    mutate(value);
    assert.equal(validateLinuxRuntimeLock(value), false, label);
  };
  reject('format', value => { value.format = 2; });
  reject('extra top-level key', value => { value.extra = true; });
  reject('missing vendor key', value => { delete value.vendor.releaseCommit; });
  reject('bad release commit', value => { value.vendor.releaseCommit = 'zz'; });
  reject('bad archive integrity', value => { value.vendor.archiveIntegrity = 'sha512-short'; });
  reject('package name', value => { value.packages[3].name = 'Bad Name'; });
  reject('package version', value => { value.packages[1].version = 'not a version'; });
  reject('package integrity', value => { value.packages[2].integrity = 'sha256-abc'; });
  reject('vendor identity mismatch', value => { value.vendor.version = '9.9.9'; });
  reject('four packages', value => { value.packages.pop(); });
  reject('six packages', value => { value.packages.push(clone(value.packages[0])); });
  reject('duplicate package', value => { value.packages[4].name = value.packages[3].name; });
  reject('files not an array', value => { value.packages[0].files = {}; });
  reject('file key set', value => { delete value.packages[0].files[0].sha256; });
  reject('unsafe parent path', value => { value.packages[0].files[0].path = '../escape.js'; });
  reject('absolute path', value => { value.packages[0].files[0].path = '/etc/passwd'; });
  reject('backslash path', value => { value.packages[0].files[0].path = 'lib\\index.js'; });
  reject('colon path', value => { value.packages[0].files[0].path = 'C:/index.js'; });
  reject('empty path part', value => { value.packages[0].files[0].path = 'lib//index.js'; });
  reject('duplicate path', value => { value.packages[0].files.push(clone(value.packages[0].files[0])); });
  reject('file and directory conflict', value => {
    value.packages[0].files = [{ path: 'lib', byteLength: 1, sha256: 'a'.repeat(64) },
      { path: 'lib/index.js', byteLength: 1, sha256: 'a'.repeat(64) }];
  });
  reject('unsorted paths', value => {
    value.packages[0].files = [{ path: 'b.js', byteLength: 1, sha256: 'a'.repeat(64) },
      { path: 'a.js', byteLength: 1, sha256: 'a'.repeat(64) }];
  });
  reject('negative byte length', value => { value.packages[0].files[0].byteLength = -1; });
  reject('non-integer byte length', value => { value.packages[0].files[0].byteLength = 1.5; });
  reject('over per-file bound', value => { value.packages[0].files[0].byteLength = 8 * 1024 * 1024 + 1; });
  reject('over depth bound', value => { value.packages[0].files[0].path = `${'d/'.repeat(17)}file.js`; });
  reject('bad file sha256', value => { value.packages[0].files[0].sha256 = 'not-a-digest'; });
  reject('wrong tree digest', value => { value.treeSha256 = 'b'.repeat(64); });
});

test('validateLinuxRuntimeLock rejects the closed byte and count bounds', () => {
  const base = syntheticLock();
  const overBytes = clone(base);
  for (const pkg of overBytes.packages) pkg.files = [{ path: 'big.bin', byteLength: 8 * 1024 * 1024, sha256: 'a'.repeat(64) }];
  overBytes.treeSha256 = sha256Hex(canonicalJson(overBytes.packages));
  assert.equal(validateLinuxRuntimeLock(overBytes), false, 'total bytes over 32 MiB');

  const manyFiles = clone(base);
  manyFiles.packages[0].files = Array.from({ length: 1025 }, (unused, index) => ({
    path: `f${String(index).padStart(4, '0')}.bin`, byteLength: 1, sha256: 'a'.repeat(64) }));
  manyFiles.treeSha256 = sha256Hex(canonicalJson(manyFiles.packages));
  assert.equal(validateLinuxRuntimeLock(manyFiles), false, 'more than 1024 files');
});

// ---------------------------------------------------------------------------------------
// Fixed public verifier against the actual installed closure
// ---------------------------------------------------------------------------------------

test('the actual installed SRT closure verifies against the packaged fixed lock', () => {
  const lock = fixedLock();
  const result = verifyLinuxVendorClosure();
  assert.equal(result.status, 'ready');
  assert.deepEqual(Object.keys(result).sort(), ['entry', 'pins', 'status', 'treeSha256']);
  assert.equal(result.treeSha256, lock.treeSha256);
  const vendorRoot = dirname(canonical(createRequire(import.meta.url).resolve(`${VENDOR}/package.json`)));
  const modulesRoot = dirname(dirname(vendorRoot));
  assert.equal(result.entry, join(vendorRoot, 'dist/index.js'));
  assert.equal(result.pins.length, 848);
  assert.equal(result.pins[0].path, join(vendorRoot, 'LICENSE'));
  const byPath = new Map(result.pins.map(pin => [pin.path, pin]));
  for (const pkg of lock.packages) {
    for (const file of pkg.files) {
      const pin = byPath.get(join(canonical(join(modulesRoot, pkg.name)), file.path));
      assert.ok(pin, `${pkg.name}/${file.path} pin`);
      assert.equal(pin.sha256, file.sha256, `${pkg.name}/${file.path} sha256`);
      assert.equal(pin.byteLength, file.byteLength, `${pkg.name}/${file.path} byteLength`);
    }
  }
});

// ---------------------------------------------------------------------------------------
// Internal inspection seam with synthetic closed fixtures
// ---------------------------------------------------------------------------------------

test('inspection verifies a synthetic closed closure and returns ordered absolute pins', () =>
  withRoot(root => {
    writeFixture(root);
    const lock = buildLock(root);
    const result = inspectLinuxVendorTree({ lock, roots: rootsFor(root) });
    assert.equal(result.status, 'ready');
    assert.equal(result.treeSha256, lock.treeSha256);
    assert.equal(result.entry, join(canonical(join(root, 'node_modules', VENDOR)), 'dist/index.js'));
    const expected = [];
    for (const pkg of lock.packages) {
      for (const file of pkg.files) {
        expected.push(join(canonical(join(root, 'node_modules', pkg.name)), file.path));
      }
    }
    assert.deepEqual(result.pins.map(pin => pin.path), expected);
    assert.equal(new Set(result.pins.map(pin => pin.path)).size, result.pins.length);
  }));

test('inspection rejects a missing pinned file', () =>
  withRoot(root => {
    writeFixture(root);
    const lock = buildLock(root);
    unlinkSync(join(root, 'node_modules', VENDOR, 'dist/index.js'));
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: rootsFor(root) }),
      { status: 'unavailable', reason: 'executable-changed' });
  }));

test('inspection rejects an extra unaccounted file', () =>
  withRoot(root => {
    writeFixture(root);
    const lock = buildLock(root);
    writeFileSync(join(root, 'node_modules', 'commander', 'extra.js'), 'module.exports = 1;\n');
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: rootsFor(root) }),
      { status: 'unavailable', reason: 'executable-changed' });
  }));

test('inspection rejects tampered bytes at the same or a different length', () =>
  withRoot(root => {
    writeFixture(root);
    const lock = buildLock(root);
    const target = join(root, 'node_modules', 'commander', 'index.js');
    writeFileSync(target, 'module.exports = {};\n'.replace('{}', '[]'));
    assert.equal(readFileSync(target).length, 'module.exports = {};\n'.length);
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: rootsFor(root) }),
      { status: 'unavailable', reason: 'executable-changed' });
    writeFileSync(target, 'module.exports = { larger: true };\n');
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: rootsFor(root) }),
      { status: 'unavailable', reason: 'executable-changed' });
  }));

test('inspection rejects a symlinked dependency file', t =>
  withRoot(root => {
    writeFixture(root);
    const lock = buildLock(root);
    const link = join(root, 'node_modules', 'commander', 'link.js');
    try { symlinkSync(join(root, 'node_modules', 'commander', 'index.js'), link, 'file'); }
    catch { t.skip('symlink creation is not permitted on this platform'); return; }
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: rootsFor(root) }),
      { status: 'unavailable', reason: 'executable-changed' });
  }));

test('inspection rejects a nested node_modules shadow copy', () =>
  withRoot(root => {
    writeFixture(root);
    const lock = buildLock(root);
    const shadow = join(root, 'node_modules', VENDOR, 'node_modules', 'commander');
    mkdirSync(shadow, { recursive: true });
    writeFileSync(join(shadow, 'package.json'), JSON.stringify({ name: 'commander', version: '12.1.0' }));
    writeFileSync(join(shadow, 'index.js'), 'module.exports = {};\n');
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: rootsFor(root) }),
      { status: 'unavailable', reason: 'executable-changed' });
  }));

test('inspection rejects an unrecognized dependency map in a pinned manifest', () =>
  withRoot(root => {
    writeFixture(root);
    const manifestPath = join(root, 'node_modules', VENDOR, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies.lodash = '^4.0.0';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const lock = buildLock(root);
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: rootsFor(root) }),
      { status: 'unavailable', reason: 'executable-changed' });
  }));

test('inspection rejects a malformed dependency range in a pinned manifest', () =>
  withRoot(root => {
    writeFixture(root);
    const manifestPath = join(root, 'node_modules', VENDOR, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies.commander = 5;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const lock = buildLock(root);
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: rootsFor(root) }),
      { status: 'unavailable', reason: 'executable-changed' });
  }));

test('inspection rejects roots that are duplicated, extra or the wrong identity', () =>
  withRoot(root => {
    writeFixture(root);
    const lock = buildLock(root);
    const duplicate = rootsFor(root).map(entry => entry.name === 'commander'
      ? { name: 'commander', root: join(root, 'node_modules', 'node-forge') } : entry);
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: duplicate }),
      { status: 'unavailable', reason: 'executable-changed' });
    const missing = rootsFor(root).slice(0, 4);
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: missing }),
      { status: 'unavailable', reason: 'executable-changed' });
    const extra = [...rootsFor(root), { name: 'zod', root: join(root, 'node_modules', 'zod') }];
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: extra }),
      { status: 'unavailable', reason: 'executable-changed' });
    const unregistered = rootsFor(root).map(entry => entry.name === 'zod'
      ? { name: 'lodash', root: entry.root } : entry);
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: unregistered }),
      { status: 'unavailable', reason: 'executable-changed' });
  }));

test('inspection rejects a lock whose tree digest does not match its pins', () =>
  withRoot(root => {
    writeFixture(root);
    const lock = buildLock(root);
    lock.treeSha256 = 'b'.repeat(64);
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: rootsFor(root) }),
      { status: 'unavailable', reason: 'executable-changed' });
  }));

test('inspection reports limit-exceeded for an over-bound observed file', () =>
  withRoot(root => {
    writeFixture(root);
    const lock = buildLock(root);
    writeFileSync(join(root, 'node_modules', 'commander', 'big.bin'), Buffer.alloc(8 * 1024 * 1024 + 1));
    assert.deepEqual(inspectLinuxVendorTree({ lock, roots: rootsFor(root) }),
      { status: 'unavailable', reason: 'limit-exceeded' });
  }));

// ---------------------------------------------------------------------------------------
// Trusted-host deadline check
// ---------------------------------------------------------------------------------------

test('a throwing inspection check is preserved, never converted to unavailable', () =>
  withRoot(root => {
    writeFixture(root);
    const lock = buildLock(root);
    assert.throws(() => inspectLinuxVendorTree({ lock, roots: rootsFor(root),
      check: () => { throw new Error('budget-stop'); } }), /budget-stop/);
  }));

test('a throwing verifier check is preserved, never converted to unavailable', () => {
  assert.throws(() => verifyLinuxVendorClosure({ check: () => { throw new Error('budget-stop'); } }),
    /budget-stop/);
});
