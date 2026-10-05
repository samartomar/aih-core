import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { lifecycleAvailability, parseProcStat, parsePsTable, treeMembers, signalIfSame, pinExecutable,
  revalidateExecutable, startLifecycle } from '../../src/harness/native/lifecycle.mjs';

// Availability is now an async, bounded probe of the actual host facility rather than a static
// refusal; the Windows Job mechanism itself is proven in native-windows.test.mjs.
test('windows-job.v1 availability reflects the real host Job facility', async () => {
  const observed = await lifecycleAvailability('windows-job.v1', 'win32', { deadline: performance.now() + 10_000 });
  if (process.platform === 'win32') assert.equal(observed.status, 'available', JSON.stringify(observed));
  else assert.equal(observed.status, 'unavailable', JSON.stringify(observed));
});

test('startLifecycle refuses windows-job.v1 off the Windows host', { skip: process.platform === 'win32' && 'the Windows Job facility is exercised by native-windows.test.mjs' }, async () => {
  assert.deepEqual(await startLifecycle({ lifecycleId: 'windows-job.v1', os: 'win32', file: process.execPath, argv: ['-e', '0'], cwd: tmpdir(), env: {} }),
    { status: 'unavailable', reason: 'platform-unsupported' });
});

test('posix-group.v1 is available only on linux and darwin', async () => {
  assert.deepEqual(await lifecycleAvailability('posix-group.v1', 'linux'), { status: 'available' });
  assert.deepEqual(await lifecycleAvailability('posix-group.v1', 'darwin'), { status: 'available' });
  assert.equal((await lifecycleAvailability('posix-group.v1', 'win32')).status, 'unavailable');
  assert.equal((await lifecycleAvailability('unknown.v1', 'linux')).status, 'unavailable');
});

test('/proc stat parsing survives spaces and parentheses in the command name', () => {
  const text = '4242 (we ird) name) S 100 4242 4242 34816 4242 4194560 1 0 0 0 0 0 0 0 20 0 1 0 987654 1000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0';
  assert.deepEqual(parseProcStat(text), { pid: 4242, ppid: 100, pgrp: 4242, session: 4242, startTicks: '987654' });
  assert.equal(parseProcStat('garbage'), null);
  assert.equal(parseProcStat('1 (x) S a b c'), null);
});

test('ps table parsing keeps the start time as the birth identity', () => {
  const rows = parsePsTable(' 10     1    10 Sat Oct  3 12:00:00 2026\n 11    10    10 Sat Oct  3 12:00:01 2026\nnot a row\n');
  assert.deepEqual(rows, [
    { pid: 10, ppid: 1, pgrp: 10, session: null, birth: 'Sat Oct  3 12:00:00 2026' },
    { pid: 11, ppid: 10, pgrp: 10, session: null, birth: 'Sat Oct  3 12:00:01 2026' }]);
});

test('tree membership follows the group and the parent chain, including setsid children', () => {
  const table = [
    { pid: 10, ppid: 1, pgrp: 10 }, { pid: 11, ppid: 10, pgrp: 10 }, { pid: 12, ppid: 11, pgrp: 12 },
    { pid: 13, ppid: 1, pgrp: 10 }, { pid: 20, ppid: 1, pgrp: 20 }, { pid: 21, ppid: 20, pgrp: 20 }];
  assert.deepEqual(treeMembers(table, 10).map(p => p.pid).sort((a, b) => a - b), [10, 11, 12, 13]);
  assert.deepEqual(treeMembers(table, 99), []);
});

test('a reused PID is never signalled', () => {
  const sent = [];
  const deps = { birthOf: () => 'other-birth', kill: (pid, sig) => sent.push([pid, sig]) };
  assert.equal(signalIfSame(55, 'my-birth', 'SIGKILL', deps), 'reused-or-gone');
  assert.deepEqual(sent, []);
  assert.equal(signalIfSame(55, 'other-birth', 'SIGKILL', deps), 'signalled');
  assert.deepEqual(sent, [[55, 'SIGKILL']]);
  const gone = { birthOf: () => null, kill: () => { throw new Error('must not be called'); } };
  assert.equal(signalIfSame(55, 'x', 'SIGTERM', gone), 'reused-or-gone');
});

test('the executable is pinned once and a changed binary is executable-changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aihq-exe-'));
  try {
    const file = join(dir, 'fake-client.exe');
    writeFileSync(file, 'binary-one');
    chmodSync(file, 0o755);
    const pin = await pinExecutable({ names: ['fake-client.exe'], pathEnv: dir, platform: process.platform });
    assert.equal(pin.status, 'pinned');
    assert.equal(pin.sha256, createHash('sha256').update('binary-one').digest('hex'));
    assert.equal(pin.byteLength, 10);
    assert.deepEqual(await revalidateExecutable(pin), { ok: true });
    appendFileSync(file, '!');
    assert.deepEqual(await revalidateExecutable(pin), { ok: false, reason: 'executable-changed' });
    rmSync(file);
    assert.deepEqual(await revalidateExecutable(pin), { ok: false, reason: 'executable-changed' });
    assert.deepEqual(await pinExecutable({ names: ['fake-client.exe'], pathEnv: dir, platform: process.platform }), { status: 'unavailable', reason: 'client-absent' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shell shims and relative PATH entries are never pinned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aihq-exe-'));
  try {
    writeFileSync(join(dir, 'claude.cmd'), '@echo off');
    assert.equal((await pinExecutable({ names: ['claude.cmd'], pathEnv: dir, platform: 'win32' })).status, 'unavailable');
    writeFileSync(join(dir, 'tool'), 'x');
    assert.equal((await pinExecutable({ names: ['tool'], pathEnv: '.', platform: 'linux' })).status, 'unavailable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Real process-group behaviour needs POSIX (run under Linux/macOS or WSL2).
const posix = process.platform === 'linux' || process.platform === 'darwin';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

test('a POSIX group stops observed descendants but retains uncertain breakaway cleanup', { skip: !posix && 'POSIX only' }, async () => {
  const script = "const {spawn}=require('node:child_process');" +
    "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
    "process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000)";
  const started = await startLifecycle({ lifecycleId: 'posix-group.v1', os: process.platform, file: process.execPath,
    argv: ['-e', script], cwd: tmpdir(), env: { PATH: process.env.PATH } });
  assert.equal(started.status, 'started');
  const { handle } = started;
  const grandchild = Number(await new Promise(resolve => handle.stdout.once('data', chunk => resolve(String(chunk).trim()))));
  await handle.track();
  assert.ok(alive(grandchild));
  const result = await handle.terminate({ graceMs: 1000, deadlineMs: 8000 });
  assert.equal(result.processes, 'unresolved');
  assert.deepEqual(result.survivors, []);
  assert.equal(alive(handle.pid), false);
  assert.equal(alive(grandchild), false);
});

test('a spawn that cannot start reports session-launch-failed', { skip: !posix && 'POSIX only' }, async () => {
  const started = await startLifecycle({ lifecycleId: 'posix-group.v1', os: process.platform, file: '/nonexistent/client',
    argv: [], cwd: tmpdir(), env: {} });
  assert.deepEqual(started, { status: 'unavailable', reason: 'session-launch-failed' });
});
