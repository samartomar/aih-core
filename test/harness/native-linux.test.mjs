// Real Linux OS facility tests. Off-Linux behavior is unavailable; no simulated peers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { linuxAvailability, prepareLinuxContext, isLinuxTransport } from '../../src/harness/native/linux-facility.mjs';

const LINUX = process.platform === 'linux' && process.arch === 'x64';
const native = { skip: LINUX ? false : 'Linux x64 OS mechanism only', timeout: 40_000 };
const pin = file => { const path = realpathSync.native(file); const bytes = readFileSync(path); return { path, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }; };
const env = extra => ({ LANG: 'C.UTF-8', ...extra });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const bounded = async (promise, ms = 8000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('controlled fixture timed out')), ms); })]); } finally { clearTimeout(timer); } };
async function line(stream) {
  let buffer = '';
  for await (const bytes of stream) { buffer += bytes.toString(); if (buffer.includes('\n')) return buffer.slice(0, buffer.indexOf('\n')); }
  throw new Error('controlled fixture exited without readiness');
}
function fixture(t, script) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'aihq-linux-facility-')));
  const file = join(directory, 'fixture.mjs'); writeFileSync(file, script, { mode: 0o600 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file, nodePin: pin(process.execPath), modulePin: pin(file) };
}
async function context(t, f, selectedEntries = [], options = {}) {
  const prepared = await prepareLinuxContext({ directory: f.directory, deadline: performance.now() + 25_000,
    runtimePins: [f.nodePin, f.modulePin], selectedEntries, ...options });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  t.after(async () => { await prepared.context.terminate({ graceMs: 0, deadlineMs: 10_000 }); });
  return prepared.context;
}

test('off-Linux facility reports unavailable without starting an OS helper', { skip: LINUX }, async () => {
  assert.equal((await linuxAvailability()).status, 'unavailable');
  assert.equal((await prepareLinuxContext()).reason, 'platform-unsupported');
  assert.equal(isLinuxTransport({ endpoint: '/invented', onConnection() {} }), false);
});

test('expired and pre-aborted Linux operations refuse before resource access', async () => {
  const expired = await prepareLinuxContext({ deadline: performance.now() - 1 });
  assert.equal(expired.status, 'unavailable');
  assert.equal(expired.reason, 'deadline');
  const controller = new AbortController(); controller.abort();
  assert.equal((await prepareLinuxContext({ signal: controller.signal })).reason, 'cancelled');
});

test('Linux availability observes subreaper and pidfd support and helper closure', native, async () => {
  const result = await linuxAvailability({ deadline: performance.now() + 8000 });
  assert.equal(result.status, 'available', JSON.stringify(result));
  assert.equal(result.cleanup.confirmed, true);
  assert.deepEqual(Object.keys(result.hostNamespaces).sort(), ['mount', 'network', 'pid', 'user']);
});

test('kernel socket peer identity ignores the connecting process forged hello PID', native, async t => {
  const f = fixture(t, 'import net from "node:net"; const s=net.connect(process.env.SOCKET); s.on("connect",()=>s.write(JSON.stringify({pid:1})+"\\n")); setInterval(()=>{},1000);');
  const entry = { id: 'controlled-peer', executablePath: f.nodePin.path, executableSha256: f.nodePin.sha256, argv: [f.file] };
  const c = await context(t, f, [entry]); const pipe = await c.createPipe();
  assert.equal(pipe.status, 'ready'); assert.equal(isLinuxTransport(pipe.transport), true);
  let resolvePeer; const peer = new Promise(resolve => { resolvePeer = resolve; });
  pipe.transport.onConnection(socket => { socket.once('data', async bytes => {
    assert.equal(JSON.parse(bytes.toString()).pid, 1);
    resolvePeer(await socket.observePeer());
  }); });
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env({ SOCKET: pipe.transport.endpoint }) });
  assert.equal(started.status, 'started', JSON.stringify(started));
  const identity = await bounded(peer);
  assert.equal(identity.status, 'observed', JSON.stringify(identity));
  assert.equal(identity.pid, started.handle.pid); assert.notEqual(identity.pid, 1);
  assert.equal(identity.uid, process.getuid()); assert.equal(identity.namespacePid, identity.pid);
  assert.match(identity.birth, /^[0-9]+$/); assert.match(identity.namespace, /^[0-9]+:[0-9]+$/);
  assert.equal(identity.namespace, identity.namespaces.pid); assert.deepEqual(identity.namespaces, c.hostNamespaces);
  assert.equal(identity.executableSha256, f.nodePin.sha256); assert.equal(identity.selectedEntryId, entry.id);
  assert.deepEqual(identity.argv, [f.file]);
  const receipt = await c.terminate({ graceMs: 0, deadlineMs: 10000 });
  assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt)); assert.deepEqual(receipt.survivors, []);
  assert.equal(isLinuxTransport(pipe.transport), false);
});

test('normal root exit cannot hide a detached adopted descendant from cleanup', native, async t => {
  const f = fixture(t, 'import {spawn} from "node:child_process";const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore",env:{}}); c.unref();process.stdout.write(String(c.pid)+"\\n");');
  const c = await context(t, f);
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started');
  const descendant = Number(await bounded(line(started.handle.stdout)));
  await bounded(started.handle.exited); assert.equal(alive(descendant), true);
  const receipt = await c.terminate({ graceMs: 0, deadlineMs: 10000 });
  assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt)); assert.equal(receipt.activeProcesses, 0);
  assert.equal(alive(descendant), false); assert.deepEqual(receipt.survivors, []);
});

test('replaced selected module bytes cannot authenticate a real same-user peer', native, async t => {
  const f = fixture(t, 'import net from "node:net";const s=net.connect(process.env.SOCKET);s.on("connect",()=>s.write("hello\\n"));setInterval(()=>{},1000);');
  const entry = { id: 'controlled-peer', executablePath: f.nodePin.path, executableSha256: f.nodePin.sha256, argv: [f.file] };
  const c = await context(t, f, [entry]); const pipe = await c.createPipe();
  writeFileSync(f.file, 'process.exit(99);');
  const result = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env({ SOCKET: pipe.transport.endpoint }) });
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'runtime-changed');
  assert.equal((await c.terminate({ graceMs: 0 })).processes, 'confirmed');
});

test('two private channels route concurrent callbacks independently and close separately', native, async t => {
  const f = fixture(t, 'import net from "node:net";for(const [key,value] of [["ONE","one"],["TWO","two"]]){const s=net.connect(process.env[key]);s.on("connect",()=>s.write(value));}setInterval(()=>{},1000);');
  const entry = { id: 'controlled-peer', executablePath: f.nodePin.path, executableSha256: f.nodePin.sha256, argv: [f.file] };
  const c = await context(t, f, [entry]);
  const first = await c.createPipe(), second = await c.createPipe();
  assert.equal(first.status, 'ready'); assert.equal(second.status, 'ready');
  assert.notEqual(first.transport.endpoint, second.transport.endpoint);
  assert.equal((await c.createPipe()).status, 'unavailable');
  const getPeer = (transport, expected) => new Promise(resolve => transport.onConnection(socket => socket.once('data', async bytes => {
    assert.equal(bytes.toString(), expected); resolve(await socket.observePeer());
  })));
  const one = getPeer(first.transport, 'one'), two = getPeer(second.transport, 'two');
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env({ ONE: first.transport.endpoint, TWO: second.transport.endpoint }) });
  assert.equal(started.status, 'started');
  const identities = await bounded(Promise.all([one, two]));
  for (const identity of identities) { assert.equal(identity.status, 'observed'); assert.equal(identity.pid, started.handle.pid); }
  await first.transport.close();
  assert.equal(isLinuxTransport(first.transport), false); assert.equal(isLinuxTransport(second.transport), true);
  const inventory = await c.observe(); assert.equal(inventory.status, 'observed');
  const root = inventory.processes.find(p => p.pid === started.handle.pid); assert.ok(root);
  const inspected = await c.inspect(root);
  assert.equal(inspected.status, 'observed'); assert.deepEqual(inspected.argv, [f.nodePin.path, f.file]);
  assert.equal((await c.inspect({ ...root, birth: '1' })).status, 'unavailable');
  assert.equal((await c.terminate({ graceMs: 0 })).processes, 'confirmed');
});

test('a real same-user socket connection outside the facility tree is rejected', native, async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);');
  const c = await context(t, f); const pipe = await c.createPipe();
  const observed = new Promise(resolve => pipe.transport.onConnection(async socket => resolve(await socket.observePeer())));
  const outsider = net.connect(pipe.transport.endpoint); outsider.on('error', () => {}); t.after(() => outsider.destroy());
  const identity = await bounded(observed);
  assert.equal(identity.status, 'unavailable'); assert.equal(identity.reason, 'ipc-peer-membership');
  assert.equal((await c.terminate({ graceMs: 0 })).processes, 'confirmed');
});

test('an authenticated peer in nested namespaces reports host and namespace PIDs separately', native, async t => {
  const f = fixture(t, 'import net from "node:net";const s=net.connect(process.env.SOCKET);s.on("connect",()=>s.write(String(process.pid)));setInterval(()=>{},1000);');
  const bwrap = pin('/usr/bin/bwrap');
  const entry = { id: 'controlled-namespaced-peer', executablePath: f.nodePin.path, executableSha256: f.nodePin.sha256, argv: [f.file] };
  const c = await context(t, f, [entry], { runtimePins: [f.nodePin, f.modulePin, bwrap] }); const pipe = await c.createPipe();
  const peer = new Promise(resolve => pipe.transport.onConnection(socket => socket.once('data', async bytes => resolve({ claimed: Number(bytes.toString()), observed: await socket.observePeer() }))));
  const started = await c.start({ file: bwrap.path, argv: ['--new-session', '--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', f.nodePin.path, f.file], cwd: f.directory, env: env({ SOCKET: pipe.transport.endpoint }) });
  assert.equal(started.status, 'started');
  const { claimed, observed } = await bounded(peer);
  assert.equal(observed.status, 'observed', JSON.stringify(observed));
  assert.equal(observed.namespacePid, claimed); assert.notEqual(observed.pid, claimed);
  assert.notEqual(observed.pid, started.handle.pid);
  for (const name of ['pid', 'mount', 'network', 'user']) {
    assert.match(observed.namespaces[name], /^[0-9]+:[0-9]+$/);
    assert.notEqual(observed.namespaces[name], c.hostNamespaces[name]);
  }
  const inventory = await c.observe();
  assert.equal(inventory.status, 'observed'); assert.ok(inventory.processes.some(p => p.pid === observed.pid && p.birth === observed.birth));
  assert.equal((await c.terminate({ graceMs: 0 })).processes, 'confirmed');
});

test('double-forked detached descendant remains accounted after both ancestors exit', native, async t => {
  const middle = 'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore",env:{}});child.unref();console.log(child.pid);';
  const f = fixture(t, `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e',${JSON.stringify(middle)}],{detached:true,env:{},stdio:['ignore','pipe','ignore']});child.stdout.pipe(process.stdout);child.unref();`);
  const c = await context(t, f); const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started'); const descendant = Number(await bounded(line(started.handle.stdout)));
  await bounded(started.handle.exited); assert.equal(alive(descendant), true);
  const inventory = await c.observe(); assert.equal(inventory.status, 'observed'); assert.ok(inventory.processes.some(p => p.pid === descendant));
  const receipt = await c.terminate({ graceMs: 0 }); assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
  assert.equal(alive(descendant), false); assert.equal(receipt.activeProcesses, 0);
});

test('partial launch failure and cancellation each close the owned process tree', native, async t => {
  const f = fixture(t, 'console.log("ready");setInterval(()=>{},1000);');
  const controller = new AbortController(); const c = await context(t, f, [], { signal: controller.signal });
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started'); await bounded(line(started.handle.stdout)); controller.abort();
  const receipt = await c.terminate({ graceMs: 0 }); assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
  assert.equal(alive(started.handle.pid), false); assert.ok(receipt.elapsedMs <= 10000);
  const other = await context(t, f);
  const failed = await other.start({ file: f.nodePin.path, argv: [f.file], cwd: join(f.directory, 'missing'), env: env() });
  assert.equal(failed.status, 'unavailable'); assert.ok(failed.partial?.pid > 0);
  assert.equal((await other.terminate({ graceMs: 0 })).processes, 'confirmed');
  assert.equal(alive(failed.partial.pid), false);
});

test('bounded output failure keeps cleanup observable without surfacing raw child bytes', native, async t => {
  const f = fixture(t, 'process.stdout.write(Buffer.alloc(3000000,65));setInterval(()=>{},1000);');
  const c = await context(t, f); const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started');
  let count = 0; started.handle.stdout.on('data', bytes => { count += bytes.length; });
  await bounded(started.handle.exited);
  assert.equal(started.handle.failure.reason, 'limit-exceeded'); assert.equal(started.handle.failure.limitSource, 'output');
  assert.ok(count <= 2097152);
  const receipt = await c.terminate({ graceMs: 0 }); assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
  assert.equal(alive(started.handle.pid), false);
});

test('held runtime closure accepts more than 256 individually pinned files and refuses aggregate overflow', native, async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);');
  const additional = [];
  for (let i = 0; i < 300; i++) {
    const file = join(f.directory, `module-${i}.mjs`); writeFileSync(file, `export const value=${i};`); additional.push(pin(file));
  }
  const c = await context(t, f, [], { runtimePins: [f.nodePin, f.modulePin, ...additional] });
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started'); assert.equal((await c.terminate({ graceMs: 0 })).processes, 'confirmed');
  for (const runtimePins of [Array(2049).fill(f.modulePin), [f.nodePin, ...additional.slice(0, 3).map(row => ({ ...row, byteLength: 268435456 }))]]) {
    const rejected = await prepareLinuxContext({ directory: f.directory, runtimePins, deadline: performance.now() + 5000 });
    assert.equal(rejected.status, 'unavailable'); assert.equal(rejected.reason, 'runtime-changed');
  }
});

test('own-tree inspection bounds observed argv separately from the fixed launch argv cap', native, async t => {
  const f = fixture(t, 'import {spawn} from "node:child_process";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)",...Array.from({length:100},(_,i)=>"fixed-"+i)],{stdio:"ignore",env:{}});console.log(child.pid);setInterval(()=>{},1000);');
  const c = await context(t, f); const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started'); const pid = Number(await bounded(line(started.handle.stdout)));
  const inventory = await c.observe(); assert.equal(inventory.status, 'observed'); const child = inventory.processes.find(p => p.pid === pid); assert.ok(child);
  const inspected = await c.inspect(child); assert.equal(inspected.status, 'observed'); assert.equal(inspected.argv.length, 103);
  assert.equal(inspected.argv.at(-1), 'fixed-99');
  assert.equal((await c.terminate({ graceMs: 0 })).processes, 'confirmed'); assert.equal(alive(pid), false);
});
