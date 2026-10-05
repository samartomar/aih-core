import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLinuxPlatformRecord, validateLinuxLibraryAliasInventory, windowsPolicyDirectoryFromMounts, observedWslNetworkingMode, resolveLinuxPlatform } from '../../src/harness/native/linux-platform.mjs';

const hash = 'a'.repeat(64);
const artifact = version => ({ version, sha256: hash, byteLength: 123 });
const record = () => ({ schemaVersion: '1.0.0', platform: 'linux-x64', roles: {
  node: artifact('24.19.0'), client: artifact('2.1.285'), bash: artifact('5.3-2ubuntu1'),
  env: artifact('0.8.0-0ubuntu3'), bwrap: artifact('0.11.1-1ubuntu0.3'),
  socat: artifact('1.8.1.1-1ubuntu0.1'), rg: artifact('15.1.0-1ubuntu1'), which: artifact('5.23.2build1'), wslinfo: null
}, libraries: [{ path: '/usr/lib/x86_64-linux-gnu/libc.so.6', sha256: hash, byteLength: 123 },
{ path: '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', aliases: ['/lib64/ld-linux-x86-64.so.2', '/usr/lib64/ld-linux-x86-64.so.2'], sha256: hash, byteLength: 123 }],
libraryAliasDirectories: [{ path: '/usr/lib64', entries: [{ name: 'ld-linux-x86-64.so.2', target: '../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2' }] }],
readFiles: [{ path: '/usr/bin/dash', aliases: ['/bin/sh', '/usr/bin/sh'], sha256: hash, byteLength: 123 }], wsl: { networkingMode: 'nat' } });

test('fixed platform source record accepts only exact version and byte references', () => {
  assert.equal(validateLinuxPlatformRecord(record()), true);
  for (const change of [r => { r.roles.node.version = '24.19.1'; }, r => { r.roles.bwrap.version = '0.11.1-1ubuntu0.1'; },
    r => { r.roles.env.path = '/caller/program'; }, r => { r.roles.client.sha256 = 'A'.repeat(64); },
    r => { r.roles.client.byteLength = 268435457; }, r => { r.roles.client.sha256 = hash + '\n'; }, r => { r.roles.shell = artifact('1'); },
    r => { r.wsl.networkingMode = 'mirrored'; }, r => { r.libraries[0].path = '/home/owner/.ssh/id_rsa'; },
    r => { r.readFiles[0].path = '/etc/ssl/private/key.pem'; }, r => { r.readFiles.push(r.readFiles[0]); }]) {
    const candidate = record(); change(candidate); assert.equal(validateLinuxPlatformRecord(candidate), false);
  }
});

test('platform record validation refuses getters without invoking them', () => {
  const candidate = record(); let calls = 0;
  Object.defineProperty(candidate.roles.node, 'sha256', { enumerable: true, get() { calls++; return hash; } });
  assert.equal(validateLinuxPlatformRecord(candidate), false); assert.equal(calls, 0);
});

test('outer SRT lookup requires the fixed independently pinned which utility', () => {
  const candidate = record(); assert.equal(validateLinuxPlatformRecord(candidate), true);
  delete candidate.roles.which; assert.equal(validateLinuxPlatformRecord(candidate), false);
  candidate.roles.which = artifact('5.23.2build2'); assert.equal(validateLinuxPlatformRecord(candidate), false);
  candidate.roles.which = artifact('5.23.2build1'); candidate.readFiles = [];
  assert.equal(validateLinuxPlatformRecord(candidate), false);
});

test('library aliases and the one fixed socat-relative libwrap location stay bounded', () => {
  const candidate = record();
  candidate.libraries[0].aliases = ['/lib/x86_64-linux-gnu/libc.so.6'];
  candidate.libraries.push({ role: 'socat', relative: '../lib/x86_64-linux-gnu/libwrap.so.0.7.6',
    aliases: ['../lib/x86_64-linux-gnu/libwrap.so.0'], sha256: hash, byteLength: 123 });
  assert.equal(validateLinuxPlatformRecord(candidate), true);
  for (const mutate of [r => { r.libraries[2].relative = '../../secrets'; }, r => { r.libraries[2].role = 'node'; },
    r => { r.libraries[2].aliases = ['../lib/libother.so.0']; }, r => { r.libraries[0].aliases = ['/home/owner/private']; },
    r => { r.readFiles[0].aliases = ['/bin/bash']; }]) {
    const changed = structuredClone(candidate); mutate(changed); assert.equal(validateLinuxPlatformRecord(changed), false);
  }
});

test('loader alias directory inventory rejects additions, writable ownership and retargeting', () => {
  const inventory = { directory: { uid: 0, mode: 0o755, symlink: false }, lib64Canonical: '/usr/lib64',
    entries: [{ name: 'ld-linux-x86-64.so.2', uid: 0, type: 'symlink', target: '../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2' }] };
  assert.equal(validateLinuxLibraryAliasInventory(inventory), true);
  for (const mutate of [r => { r.directory.uid = 1000; }, r => { r.directory.mode = 0o775; }, r => { r.directory.symlink = true; },
    r => { r.entries.push({ ...r.entries[0], name: 'additional' }); }, r => { r.entries[0].target = '../private'; },
    r => { r.entries[0].type = 'file'; }, r => { r.entries[0].uid = 1000; }, r => { r.lib64Canonical = '/other'; }]) {
    const changed = structuredClone(inventory); mutate(changed); assert.equal(validateLinuxLibraryAliasInventory(changed), false);
  }
  const bad = record(); bad.libraryAliasDirectories[0].path = '/usr/lib'; assert.equal(validateLinuxPlatformRecord(bad), false);
});

const cMount = 'C:\\134 /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,trans=fd 0 0\n';
test('WSL Windows policy reference needs one exact observed C root mount', () => {
  assert.equal(windowsPolicyDirectoryFromMounts(cMount), '/mnt/c/Program Files/ClaudeCode');
  assert.equal(windowsPolicyDirectoryFromMounts('/dev/sdb / ext4 rw 0 0\n' + cMount), '/mnt/c/Program Files/ClaudeCode');
  for (const text of ['', cMount + cMount, cMount.replace('/mnt/c', '/somewhere'), cMount.replace('C:', 'D:'),
    cMount.replace('9p', 'ext4'), cMount.replace('aname=drvfs', 'aname=other'),
    cMount + '/dev/sdb /mnt/c/Program\\040Files ext4 rw 0 0\n', 'x'.repeat(262145)]) {
    assert.equal(windowsPolicyDirectoryFromMounts(text), null);
  }
});

test('only an exact observed NAT response is supported, never a record assertion', () => {
  for (const response of ['nat', 'nat\n', 'nat\r\n']) assert.equal(observedWslNetworkingMode(response), 'nat');
  for (const response of ['', 'mirrored\n', 'virtioproxy\n', 'NAT', 'nat\nmirrored', 'nat\n\n', ' nat\n', 'nat\0', 'nat'.repeat(100)]) {
    assert.equal(observedWslNetworkingMode(response), null);
  }
});

test('platform resolution propagates the trusted deadline check before filesystem access', async () => {
  const stop = new Error('controlled deadline');
  await assert.rejects(resolveLinuxPlatform({ check() { throw stop; } }), error => error === stop);
});

test('platform resolver has no invented ready result without an independent record', async () => {
  const result = await resolveLinuxPlatform({ check() {} });
  assert.equal(result.status, 'unavailable');
});
