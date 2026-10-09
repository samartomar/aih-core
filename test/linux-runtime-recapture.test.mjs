import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyseRecapture, parseArguments, parseDpkgOwner } from '../scripts/linux-runtime-recapture.mjs';
import { validateLinuxPlatformRecord } from '../src/harness/native/linux-platform.mjs';

const root = new URL('../', import.meta.url);
const real = JSON.parse(readFileSync(new URL('src/harness/native/linux/runtime-platform.json', root), 'utf8'));
const fixtureTemplate = readFileSync(new URL('test/fixtures/linux-runtime-recapture/native-fixture.json', root), 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const LIBC = '/usr/lib/x86_64-linux-gnu/libc.so.6', LIBM = '/usr/lib/x86_64-linux-gnu/libm.so.6';
const CLIENT = '/opt/tools/client', NODE = '/usr/bin/node';

// Builds a fake linux host whose file bytes match a synthetic copy of the real record.
function scenario() {
  const files = new Map(), links = new Map(), roleBinaries = {};
  const record = structuredClone(real);
  const content = (path, tag = 'v1') => Buffer.from(`${tag}:${path}`);
  for (const [name, row] of Object.entries(record.roles)) {
    if (!row) continue;
    const path = name === 'node' ? NODE : name === 'client' ? CLIENT : `/usr/bin/${name}`;
    roleBinaries[name] = path; files.set(path, content(path));
    row.sha256 = sha(files.get(path)); row.byteLength = files.get(path).length;
  }
  const socatBase = posix.dirname(roleBinaries.socat);
  for (const rows of [record.libraries, record.readFiles]) {
    for (const row of rows) {
      const base = row.role ? socatBase : null;
      const path = base ? posix.resolve(base, row.relative) : row.path;
      files.set(path, content(path));
      row.sha256 = sha(files.get(path)); row.byteLength = files.get(path).length;
      for (const alias of row.aliases ?? []) links.set(base ? posix.resolve(base, alias) : alias, path);
    }
  }
  const recordText = JSON.stringify(record, null, 2) + '\n';
  const host = {
    platform: 'linux', arch: 'x64', execPath: NODE, pathEnv: '/usr/bin:/bin',
    readFile(path) { const bytes = files.get(path); if (!bytes) throw new Error('ENOENT'); return bytes; },
    realpath(path) { return links.get(path) ?? path; },
    which: name => roleBinaries[name] ?? null,
    owners: new Map(), verifyOutput: new Map(), versions: new Map(),
    dpkgOwner(path) { return this.owners.get(path) ?? `pkg-${posix.basename(path)}:amd64: ${path}\n`; },
    dpkgVerify(pkg) { return this.verifyOutput.get(pkg) ?? ''; },
    dpkgVersion(pkg) { return this.versions.get(pkg) ?? '1.0'; },
  };
  for (const [name, row] of Object.entries(record.roles)) if (row && name !== 'node' && name !== 'client') host.versions.set(`pkg-${posix.basename(roleBinaries[name])}`, row.version);
  const drift = (path, tag = 'v2') => { files.set(path, content(path, tag)); };
  const run = (extra = {}) => analyseRecapture({ host, recordText, client: CLIENT, ...extra });
  return { host, files, record, recordText, run, drift, links };
}

const fixtureFor = (s, hashes = {}) => fixtureTemplate
  .replaceAll('{{libc}}', hashes.libc ?? sha(s.files.get(LIBC)))
  .replaceAll('{{libm}}', hashes.libm ?? sha(s.files.get(LIBM)))
  .replaceAll('{{record}}', hashes.record ?? sha(Buffer.from(s.recordText)));
const rowOf = (record, path) => record.libraries.find(row => row.path === path);

test('no drift exits 0 with no writes', () => {
  const s = scenario(), result = s.run();
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.report.changed, []);
  assert.deepEqual(result.writes, []);
});

test('verified library drift is reported and rewrites only that row', () => {
  const s = scenario(); s.drift(LIBC);
  const result = s.run();
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.changed.length, 1);
  const [change] = result.report.changed;
  assert.equal(change.table, 'libraries'); assert.equal(change.key, LIBC);
  assert.equal(change.package, 'pkg-libc.so.6'); assert.equal(change.packageVersion, '1.0');
  assert.equal(change.old.sha256, rowOf(s.record, LIBC).sha256);
  const [write] = result.writes;
  assert.equal(write.target, 'record');
  const next = JSON.parse(write.text);
  assert.equal(validateLinuxPlatformRecord(next), true);
  assert.equal(write.text, JSON.stringify(next, null, 2) + '\n');
  // Deep diff: only the libc sha256/byteLength differ.
  const expected = structuredClone(s.record);
  const row = rowOf(expected, LIBC);
  row.sha256 = change.new.sha256; row.byteLength = change.new.byteLength;
  assert.deepEqual(next, expected);
  assert.notEqual(row.sha256, rowOf(s.record, LIBC).sha256);
});

test('drift of a read file is rewritable when the package verifies', () => {
  const s = scenario(); s.drift('/usr/bin/dash');
  const result = s.run();
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.changed[0].table, 'readFiles');
});

test('socat role library drift resolves relative to the socat role', () => {
  const s = scenario(); s.drift('/usr/lib/x86_64-linux-gnu/libwrap.so.0.7.6');
  const result = s.run();
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.changed[0].key, 'socat:../lib/x86_64-linux-gnu/libwrap.so.0.7.6');
  const next = JSON.parse(result.writes[0].text);
  assert.equal(next.libraries.find(row => row.role === 'socat').sha256, result.report.changed[0].new.sha256);
});

test('report is deterministic and sorted', () => {
  const s = scenario(); s.drift(LIBM); s.drift(LIBC);
  const a = s.run(), b = s.run();
  assert.deepEqual(a.report.changed.map(row => row.key), [LIBC, LIBM]);
  assert.equal(JSON.stringify(a.report), JSON.stringify(b.report));
});

for (const [name, output, pattern] of [
  ['no owner', '', /no owning package/],
  ['multiple owners', `a:amd64, b:amd64: ${LIBC}\n`, /multiple owning packages/],
  ['two lines two owners', `a:amd64: ${LIBC}\nb:amd64: ${LIBC}\n`, /multiple owning packages/],
  ['diversion', `diversion by libc-divert from: ${LIBC}\n`, /diverted/],
]) {
  test(`dpkg -S ${name} refuses and blocks writes`, () => {
    const s = scenario(); s.drift(LIBC); s.drift(LIBM); s.host.owners.set(LIBC, output);
    const result = s.run();
    assert.equal(result.exitCode, 1);
    assert.match(result.report.refused.find(row => row.key === LIBC).reason, pattern);
    assert.deepEqual(result.writes, []);
  });
}

test('dpkg -S failure (non-zero exit) is a refusal', () => {
  const s = scenario(); s.drift(LIBC);
  s.host.dpkgOwner = () => { throw new Error('exit 1'); };
  assert.equal(s.run().exitCode, 1);
});

test('dpkg --verify output refuses', () => {
  const s = scenario(); s.drift(LIBC); s.host.verifyOutput.set('pkg-libc.so.6', '??5?????? /usr/lib/x86_64-linux-gnu/libc.so.6\n');
  const result = s.run();
  assert.equal(result.exitCode, 1);
  assert.match(result.report.refused[0].reason, /does not verify clean/);
  assert.deepEqual(result.writes, []);
});

test('alias realpath mismatch refuses', () => {
  const s = scenario(); s.links.set('/usr/lib64/ld-linux-x86-64.so.2', '/tmp/elsewhere');
  const result = s.run();
  assert.equal(result.exitCode, 1);
  assert.match(result.report.refused[0].reason, /alias/);
});

for (const role of ['client', 'node']) {
  test(`${role} change is always refused`, () => {
    const s = scenario(); s.drift(role === 'client' ? CLIENT : NODE);
    const result = s.run();
    assert.equal(result.exitCode, 1);
    assert.match(result.report.refused[0].reason, /reviewed code change/);
    assert.deepEqual(result.writes, []);
  });
}

test('distro role byte change with same package version and clean verify is rewritable', () => {
  const s = scenario(); s.drift('/usr/bin/bwrap');
  const result = s.run();
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.changed[0].package, 'pkg-bwrap');
});

test('distro role package version change is refused', () => {
  const s = scenario(); s.drift('/usr/bin/bwrap'); s.host.versions.set('pkg-bwrap', '9.9');
  const result = s.run();
  assert.equal(result.exitCode, 1);
  assert.match(result.report.refused[0].reason, /reviewed code change/);
});

test('distro role that is not dpkg-owned is refused', () => {
  const s = scenario(); s.drift('/usr/bin/wslinfo'); s.host.owners.set('/usr/bin/wslinfo', '');
  assert.equal(s.run().exitCode, 1);
});

test('one refusal blocks every write, including verified rows', () => {
  const s = scenario(); s.drift(LIBC); s.drift(CLIENT);
  const result = s.run();
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.writes, []);
  assert.equal(result.report.changed.length, 2);
});

test('non-linux or non-x64 hosts are refused', () => {
  for (const patch of [{ platform: 'win32' }, { arch: 'arm64' }]) {
    const s = scenario(); Object.assign(s.host, patch);
    const result = s.run();
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.refused[0].table, 'host');
  }
});

test('invalid source record is refused', () => {
  const s = scenario();
  const broken = JSON.parse(s.recordText); broken.wsl.networkingMode = 'mirrored';
  const result = analyseRecapture({ host: s.host, recordText: JSON.stringify(broken, null, 2) + '\n', client: CLIENT });
  assert.equal(result.exitCode, 1);
});

test('missing role binary is refused', () => {
  const s = scenario(); s.host.which = () => null;
  assert.equal(s.run().exitCode, 1);
});

test('fixture update rewrites matching libraryClosure and pins and the record-file pin', () => {
  const s = scenario(); const fixtureText = fixtureFor(s); s.drift(LIBC);
  const result = s.run({ fixtureText });
  assert.equal(result.exitCode, 2);
  const newRecordText = result.writes.find(write => write.target === 'record').text;
  const fixtureWrite = result.writes.find(write => write.target === 'fixture').text;
  const fixture = JSON.parse(fixtureWrite);
  const newLibc = result.report.changed[0].new;
  const [closureLibc, closureLibm] = fixture.result.libraryClosure;
  assert.equal(closureLibc.sha256, newLibc.sha256); assert.equal(closureLibc.byteLength, newLibc.byteLength);
  assert.equal(closureLibm.sha256, sha(s.files.get(LIBM)));
  const [recordPin, libcPin] = fixture.result.pins;
  assert.equal(libcPin.sha256, newLibc.sha256);
  assert.equal(recordPin.sha256, sha(Buffer.from(newRecordText)));
  assert.equal(recordPin.byteLength, Buffer.byteLength(newRecordText));
  assert.equal(result.report.fixture.changed.length, 3);
  assert.equal(fixtureWrite, JSON.stringify(fixture, null, 2) + '\n');
});

test('fixture row with an unexpected third hash is refused and nothing is written', () => {
  const s = scenario(); s.drift(LIBC);
  const result = s.run({ fixtureText: fixtureFor(s, { libc: 'f'.repeat(64) }) });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.refused[0].table, 'fixture');
  assert.deepEqual(result.writes, []);
});

test('fixture record pin with an unmatched hash is reported, left unchanged, and does not refuse', () => {
  const s = scenario(); const fixtureText = fixtureFor(s, { record: '0'.repeat(64) }); s.drift(LIBC);
  const result = s.run({ fixtureText });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.report.fixture.unmatchedRecordPins,
    [{ key: '/opt/pkg/harness/native/linux/runtime-platform.json', sha256: '0'.repeat(64) }]);
  const fixture = JSON.parse(result.writes.find(write => write.target === 'fixture').text);
  assert.equal(fixture.result.pins[0].sha256, '0'.repeat(64));
  assert.equal(fixture.result.pins[0].byteLength, 0);
  assert.equal(fixture.result.pins[1].sha256, result.report.changed[0].new.sha256);
});

test('fixture whose formatting cannot be reproduced is refused', () => {
  const s = scenario(); s.drift(LIBC);
  const result = s.run({ fixtureText: fixtureFor(s).replace('"status": "ready"', '"status":   "ready"') });
  assert.equal(result.exitCode, 1);
  assert.match(result.report.refused[0].reason, /formatting/);
});

test('fixture with four-space indent keeps its indent', () => {
  const s = scenario(); s.drift(LIBC);
  const text = JSON.stringify(JSON.parse(fixtureFor(s)), null, 4) + '\n';
  const result = s.run({ fixtureText: text });
  assert.equal(result.exitCode, 2);
  assert.match(result.writes.find(write => write.target === 'fixture').text, /^\{\n {4}"result"/);
});

test('fixture with no drift produces no changes', () => {
  const s = scenario(); const result = s.run({ fixtureText: fixtureFor(s) });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.writes, []);
});

test('non-canonical record formatting is refused rather than reformatted', () => {
  const s = scenario(); s.drift(LIBC);
  const result = analyseRecapture({ host: s.host, recordText: s.recordText.replace(/\n/g, '\r\n'), client: CLIENT });
  assert.equal(result.exitCode, 1);
});

test('dpkg owner parser handles arch-qualified single owners', () => {
  assert.equal(parseDpkgOwner(`libc6:amd64: ${LIBC}\n`, LIBC), 'libc6');
  assert.throws(() => parseDpkgOwner('libc6:amd64: /other\n', LIBC));
});

test('argument parsing', () => {
  assert.deepEqual(parseArguments(['--client', '/c', '--role', 'node=/n', '--write', '--fixture', 'f.json']),
    { client: '/c', roles: { node: '/n' }, fixture: 'f.json', write: true });
  assert.throws(() => parseArguments([]));
  assert.throws(() => parseArguments(['--client', '/c', '--role', 'bogus=/n']));
  assert.throws(() => parseArguments(['--client', '/c', '--nope']));
});

test('the real source record is canonically formatted and valid', () => {
  const text = readFileSync(new URL('src/harness/native/linux/runtime-platform.json', root), 'utf8');
  assert.equal(JSON.stringify(JSON.parse(text), null, 2) + '\n', text);
  assert.equal(validateLinuxPlatformRecord(JSON.parse(text)), true);
});

test('build and package do not reference the re-capture tooling', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.ok(!pkg.files.some(entry => entry === 'scripts' || entry.startsWith('scripts/')));
  assert.ok(!JSON.stringify(pkg.scripts).includes('recapture'));
  assert.ok(!readFileSync(fileURLToPath(new URL('scripts/build.mjs', root)), 'utf8').includes('recapture'));
});
