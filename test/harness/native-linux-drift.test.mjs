// Platform-record drift diagnostics: closed descriptors only, no trust widening.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishNativePlatformDrift } from '../../src/harness/native/admission.mjs';

const native = new URL('../../src/harness/native/', import.meta.url);
const LINUX = process.platform === 'linux' && process.arch === 'x64' && process.getuid?.() !== 0 && process.getuid?.() === process.geteuid?.();

function capture(action) {
  const records = [], stream = channel('aih.native.diagnostics.v1'), sink = value => records.push(value);
  stream.subscribe(sink);
  try { action(); } finally { stream.unsubscribe(sink); }
  return records;
}

test('drift publisher emits one frozen closed record on the diagnostics channel', () => {
  const [role, library, read] = capture(() => {
    publishNativePlatformDrift({ runSha256: 'a'.repeat(64), table: 'roles', key: 'bwrap' });
    publishNativePlatformDrift({ runSha256: 'b'.repeat(64), table: 'libraries', key: 7 });
    publishNativePlatformDrift({ runSha256: 'c'.repeat(64), table: 'readFiles', key: 0 });
  });
  assert.deepEqual(Object.keys(role), ['schema', 'event', 'recordId', 'runSha256', 'definition', 'table', 'key', 'remedy']);
  assert.equal(role.schema, 'aih.native.diagnostics.v1'); assert.equal(role.event, 'native-platform-drift');
  assert.equal(role.definition, 'claude-linux-x64-wsl2-srt-2.1.285'); assert.equal(role.remedy, 'recapture-platform-record');
  assert.equal(role.runSha256, 'a'.repeat(64)); assert.equal(role.table, 'roles'); assert.equal(role.key, 'bwrap');
  assert.equal(Object.isFrozen(role), true);
  assert.deepEqual([library.table, library.key, read.table, read.key], ['libraries', 7, 'readFiles', 0]);
});

test('drift publisher rejects unknown tables and nulls unknown keys without echoing input', () => {
  const records = capture(() => {
    publishNativePlatformDrift({ runSha256: 'a'.repeat(64), table: '/home/privacy-canary', key: 1 });
    publishNativePlatformDrift({ runSha256: 'not-a-digest', table: 'roles', key: '/usr/bin/privacy-canary' });
    publishNativePlatformDrift({ runSha256: 'a'.repeat(64), table: 'libraries', key: 64 });
    publishNativePlatformDrift({ runSha256: 'a'.repeat(64), table: 'libraries', key: 1.5 });
    publishNativePlatformDrift({ runSha256: 'a'.repeat(64), table: 'roles', key: 3 });
    publishNativePlatformDrift({ runSha256: 'a'.repeat(64), table: 'readFiles', key: -1, path: '/etc/privacy-canary', sha256: 'f'.repeat(64) });
    publishNativePlatformDrift(undefined);
  });
  assert.equal(records.length, 5);
  assert.deepEqual(records.map(record => record.key), [null, null, null, null, null]);
  assert.equal(records[0].runSha256, null);
  assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
  assert.equal(JSON.stringify(records).includes('f'.repeat(64)), false);
});

test('drift publisher is silent without subscribers', () => {
  assert.doesNotThrow(() => publishNativePlatformDrift({ runSha256: 'a'.repeat(64), table: 'roles', key: 'env' }));
});

// Runs a private copy of the platform module with a copied record whose role rows describe the running node
// binary, so only the PATH-resolved `bash` role can differ. The shipped module and record are never modified.
async function platformCopy(t) {
  const directory = mkdtempSync(join(tmpdir(), 'aih-drift-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'linux'));
  copyFileSync(fileURLToPath(new URL('canonical.mjs', native)), join(directory, 'canonical.mjs'));
  const source = readFileSync(fileURLToPath(new URL('linux-platform.mjs', native)), 'utf8');
  const patched = source.replace(/node: '24\.19\.0'/, `node: '${process.version.slice(1)}'`);
  assert.notEqual(patched, source, 'VERSIONS pattern must exist');
  writeFileSync(join(directory, 'linux-platform.mjs'), patched);
  const record = JSON.parse(readFileSync(fileURLToPath(new URL('linux/runtime-platform.json', native)), 'utf8'));
  const bytes = readFileSync(process.execPath), sha256 = createHash('sha256').update(bytes).digest('hex');
  for (const name of Object.keys(record.roles)) if (record.roles[name]) record.roles[name] = { ...record.roles[name], sha256, byteLength: bytes.length };
  record.roles.node.version = process.version.slice(1);
  writeFileSync(join(directory, 'linux', 'runtime-platform.json'), JSON.stringify(record, null, 2) + '\n');
  const module = await import(pathToFileURL(join(directory, 'linux-platform.mjs')).href);
  return { module, directory, bytes, client: { path: process.execPath, sha256, byteLength: bytes.length } };
}

function pathWith(t, directory, name, bytes) {
  const bin = join(directory, 'bin'); mkdirSync(bin, { recursive: true });
  if (bytes) { writeFileSync(join(bin, name), bytes); chmodSync(join(bin, name), 0o755); }
  const saved = process.env.PATH; process.env.PATH = bin; t.after(() => { process.env.PATH = saved; });
}

const linuxOnly = { skip: LINUX ? false : 'Linux x64 non-root only' };

test('a same-size PATH role with different bytes refuses as platform-record-drift naming only the role', linuxOnly, async t => {
  const copy = await platformCopy(t);
  const changed = Buffer.from(copy.bytes); changed[changed.length - 1] ^= 0xff;
  pathWith(t, copy.directory, 'bash', changed);
  const result = await copy.module.resolveLinuxPlatform({ client: copy.client });
  assert.deepEqual(result, { status: 'unavailable', reason: 'platform-record-drift', drift: { table: 'roles', key: 'bash' } });
  assert.equal(JSON.stringify(result).includes(copy.directory), false);
});

test('a wrong-size PATH role refuses as platform-record-drift before hashing', linuxOnly, async t => {
  const copy = await platformCopy(t);
  pathWith(t, copy.directory, 'bash', copy.bytes.subarray(0, copy.bytes.length - 1));
  const result = await copy.module.resolveLinuxPlatform({ client: copy.client });
  assert.deepEqual(result, { status: 'unavailable', reason: 'platform-record-drift', drift: { table: 'roles', key: 'bash' } });
});

test('a missing PATH role stays runtime-changed and carries no drift descriptor', linuxOnly, async t => {
  const copy = await platformCopy(t);
  pathWith(t, copy.directory, 'bash', null);
  assert.deepEqual(await copy.module.resolveLinuxPlatform({ client: copy.client }), { status: 'unavailable', reason: 'runtime-changed' });
});

test('a non-ELF PATH candidate of the pinned size stays runtime-changed', linuxOnly, async t => {
  const copy = await platformCopy(t);
  pathWith(t, copy.directory, 'bash', Buffer.alloc(copy.bytes.length, 0x41));
  assert.deepEqual(await copy.module.resolveLinuxPlatform({ client: copy.client }), { status: 'unavailable', reason: 'runtime-changed' });
});
