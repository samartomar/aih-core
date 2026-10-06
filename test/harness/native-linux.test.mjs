// Real Linux OS facility tests. Off-Linux behavior is unavailable; no simulated peers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { linuxAvailability, prepareLinuxContext, isLinuxTransport } from '../../src/harness/native/linux-facility.mjs';
import { evaluateLinuxIsolation, inspectLinuxArguments, isolationProbeNames } from '../../src/harness/native/linux-isolation.mjs';
import { createLinuxProbeSession } from '../../src/harness/native/linux-sandbox.mjs';

const LINUX = process.platform === 'linux' && process.arch === 'x64';
const native = { skip: LINUX ? false : 'Linux x64 OS mechanism only', timeout: 40_000 };
const facility = fileURLToPath(new URL('../../src/harness/native/linux/facility', import.meta.url));
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

test('fixed interop exec probe refuses non-MZ and non-executable MZ with closed output', native, t => {
  const f = fixture(t, 'controlled non-MZ');
  for (const [bytes, mode] of [[Buffer.from('controlled non-MZ'), 0o700], [Buffer.from('MZcontrolled'), 0o600]]) {
    rmSync(f.file); writeFileSync(f.file, bytes, { mode });
    const result = spawnSync(facility, ['--interop-probe', f.file], { env: { LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8', timeout: 1000 });
    assert.equal(result.status, 125); assert.equal(result.stdout, 'unproven'); assert.equal(result.stderr, '');
  }
});
async function context(t, f, selectedEntries = [], options = {}) {
  const prepared = await prepareLinuxContext({ directory: f.directory, deadline: performance.now() + 25_000,
    runtimePins: [f.nodePin, f.modulePin], selectedEntries, ...options });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  t.after(async () => { await prepared.context.terminate({ graceMs: 0, deadlineMs: 10_000 }); });
  return prepared.context;
}

async function executableCacheFixture(t) {
  try { accessSync('/bin/bash', constants.X_OK); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    t.skip('controlled executable cache fixture requires standalone /bin/bash'); return;
  }
  const f = fixture(t, `import {spawn} from 'node:child_process';
    import {once} from 'node:events';import {createInterface} from 'node:readline';
    const lines=createInterface({input:process.stdin});let child;
    console.log('ready');for await(const text of lines){const command=JSON.parse(text);
      if(command.file){child=spawn(command.file,['--noprofile','--norc','-c','read -r -t 30'],{stdio:['pipe','ignore','ignore'],env:{}});
        await once(child,'spawn');console.log(child.pid);
      }else if(command.status){console.log(child&&child.exitCode===null&&child.signalCode===null?'running':'exited');
      }else{if(!child||child.exitCode!==null||child.signalCode!==null)throw Error('controlled cache child exited before stop');
        const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=null;console.log('stopped');}
    }`);
  const c = await context(t, f, [], { deadline: performance.now() + 60_000 });
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started');
  const lines = createInterface({ input: started.handle.stdout });
  const replies = lines[Symbol.asyncIterator](); t.after(() => lines.close());
  const next = async () => { const reply = await bounded(replies.next()); assert.equal(reply.done, false); return reply.value; };
  assert.equal(await next(), 'ready');
  const command = async value => { started.handle.stdin.write(JSON.stringify(value) + '\n'); return next(); };
  // Bash is a standalone ELF on both GNU-coreutils and uutils hosts. Its builtin
  // read waits on the parent's open pipe, without starting another executable.
  const image = readFileSync('/bin/bash');
  assert.equal(image.subarray(0, 4).toString('hex'), '7f454c46', 'controlled cache fixture requires a regular ELF image');
  const install = (name, suffix) => {
    const file = join(f.directory, name);
    writeFileSync(file, Buffer.concat([image, Buffer.from(suffix)]), { mode: 0o700 });
    return file;
  };
  const start = async file => { const pid = Number(await command({ file })); assert.ok(Number.isSafeInteger(pid) && pid > 0); return pid; };
  const stop = async pid => { assert.equal(await command({}), 'stopped'); assert.equal(alive(pid), false); };
  const inspect = async (pid, file, expected) => {
    let row;
    await bounded((async () => { for (;;) {
      assert.equal(await command({ status: true }), 'running', 'controlled cache child exited before discovery');
      const inventory = await c.observe(); assert.equal(inventory.status, 'observed', JSON.stringify(inventory));
      row = inventory.processes.find(row => row.pid === pid);
      if (row) {
        assert.equal(await command({ status: true }), 'running', 'controlled cache child exited before discovery');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    } })());
    // This fixture and its child share the observer's PID namespace.
    assert.equal(row.namespacePid, pid);
    // Repeated generic inspection and the held-generation audit both use the image cache.
    for (let i = 0; i < 2; i++) {
      const observed = await c.inspect(row); assert.equal(observed.status, 'observed', JSON.stringify(observed));
      assert.equal(observed.executablePath, file); assert.equal(observed.executableSha256, expected);
    }
    const audit = await c.auditInventory(); assert.equal(audit.status, 'observed'); assert.equal(audit.fresh, true);
    let found = false;
    for (const snapshot of audit.snapshots) {
      const observed = await c.inspectAudit(snapshot); assert.equal(observed.status, 'observed', JSON.stringify(observed));
      if (snapshot.pid === pid && observed.executablePath === file) {
        assert.equal(observed.executableSha256, expected); found = true;
      }
      assert.equal((await c.acknowledgeAudit(snapshot)).ok, true);
    }
    assert.equal(found, true);
  };
  return { ...f, c, install, start, stop, inspect };
}

test('executable hash cache rehashes a replacement inode at the same path', native, async t => {
  const f = await executableCacheFixture(t); if (!f) return;
  const file = f.install('helper', 'original-image'); const original = pin(file);
  const before = statSync(file, { bigint: true });
  let pid = await f.start(file); await f.inspect(pid, file, original.sha256); await f.stop(pid);
  const replacement = f.install('replacement', 'replacement-image'); renameSync(replacement, file);
  assert.notEqual(statSync(file, { bigint: true }).ino, before.ino);
  const changed = pin(file); assert.notEqual(changed.sha256, original.sha256);
  pid = await f.start(file); await f.inspect(pid, file, changed.sha256); await f.stop(pid);
  assert.equal((await f.c.terminate({ graceMs: 0 })).processes, 'confirmed');
});

test('executable hash cache rehashes same-inode size and ctime changes with restored mtime', native, async t => {
  const f = await executableCacheFixture(t); if (!f) return;
  const file = f.install('helper', 'original-image'); const fixedTime = 1_600_000_000;
  utimesSync(file, fixedTime, fixedTime);
  let previous = pin(file), before = statSync(file, { bigint: true });
  let pid = await f.start(file); await f.inspect(pid, file, previous.sha256); await f.stop(pid);
  for (const grow of [true, false]) {
    await new Promise(resolve => setTimeout(resolve, 20));
    const bytes = readFileSync(file);
    if (!grow) bytes[bytes.length - 1] ^= 1;
    writeFileSync(file, grow ? Buffer.concat([bytes, Buffer.from('changed-image')]) : bytes);
    utimesSync(file, fixedTime, fixedTime);
    const after = statSync(file, { bigint: true }), changed = pin(file);
    assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
    assert.notEqual(after.ctimeNs, before.ctimeNs);
    if (grow) assert.ok(after.size > before.size); else assert.equal(after.size, before.size);
    assert.notEqual(changed.sha256, previous.sha256);
    pid = await f.start(file); await f.inspect(pid, file, changed.sha256); await f.stop(pid);
    before = after; previous = changed;
  }
  assert.equal((await f.c.terminate({ graceMs: 0 })).processes, 'confirmed');
});

test('a full executable hash cache hashes distinct and rewritten images without stale entries', { ...native, timeout: 60_000 }, async t => {
  const f = await executableCacheFixture(t); if (!f) return;
  const source = readFileSync(new URL('../../src/harness/native/linux/facility.c', import.meta.url), 'utf8');
  const limit = Number(source.match(/^#define MAX_IMAGE_CACHE (\d+)$/m)?.[1]);
  assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit < 128);
  const files = [], hashes = new Set();
  // Fill with distinct held inodes; the final images exceed every cache slot even without the root image.
  for (let i = 0; i < limit + 2; i++) {
    const file = f.install(`helper-${i}`, `distinct-image-${i}`), expected = pin(file);
    files.push(file); hashes.add(expected.sha256);
    const pid = await f.start(file); await f.inspect(pid, file, expected.sha256); await f.stop(pid);
  }
  assert.equal(hashes.size, limit + 2);
  // Revisit one cached and one uncached inode, then change each while the cache stays full.
  for (const file of [files[0], files.at(-1)]) {
    const original = pin(file); let pid = await f.start(file);
    await f.inspect(pid, file, original.sha256); await f.stop(pid);
    const before = statSync(file, { bigint: true });
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('after-cache-full')]));
    assert.equal(statSync(file, { bigint: true }).ino, before.ino);
    const changed = pin(file); assert.notEqual(changed.sha256, original.sha256);
    pid = await f.start(file); await f.inspect(pid, file, changed.sha256); await f.stop(pid);
  }
  assert.equal((await f.c.terminate({ graceMs: 0 })).processes, 'confirmed');
});

test('exited known argv snapshots require generation-bound audit acknowledgement', native, async t => {
  const f = fixture(t, 'process.stdout.write("ready\\n");setTimeout(()=>{},3000);');
  const c = await context(t, f);
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started'); await bounded(line(started.handle.stdout));
  const inventory = await c.auditInventory();
  assert.equal(inventory.status, 'observed'); assert.equal(inventory.coverageGap, false);
  assert.ok(inventory.snapshots.length); await bounded(started.handle.exited);
  const exited = await c.auditInventory();
  assert.equal(exited.status, 'observed'); assert.equal(exited.coverageGap, false);
  for (const row of inventory.snapshots) {
    assert.ok(exited.snapshots.some(retained => retained.pid === row.pid && retained.birth === row.birth && retained.generation === row.generation));
  }
  let actualImage = false;
  for (const row of inventory.snapshots) {
    assert.equal((await c.inspect(row)).reason, 'process-exited');
    assert.equal((await c.acknowledgeAudit(row)).ok, false);
    const observed = await c.inspectAudit(row);
    assert.equal(observed.status, 'observed'); assert.equal(observed.generation, row.generation);
    if (observed.executablePath === f.nodePin.path) {
      assert.deepEqual(observed.argv, [f.nodePin.path, f.file]); actualImage = true;
    }
    assert.equal((await c.acknowledgeAudit({ ...row, generation: row.generation + 1000 })).ok, false);
    assert.equal((await c.acknowledgeAudit(row)).ok, true);
    assert.equal((await c.acknowledgeAudit(row)).ok, false);
  }
  assert.equal(actualImage, true);
  assert.equal((await c.auditInventory()).coverageGap, false);
  assert.equal((await c.terminate({ graceMs: 0, deadlineMs: 10000 })).auditCoverage, true);
});

test('generic inspection cannot erase a known unaudited lifetime at finalization', native, async t => {
  const f = fixture(t, 'process.stdout.write("ready\\n");setTimeout(()=>{},3000);');
  const c = await context(t, f);
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(await bounded(new Promise(resolve => started.handle.stdout.once('data', bytes => resolve(bytes.toString().trim())))), 'ready');
  const inventory = await c.observe(); const row = inventory.processes.find(row => row.pid === started.handle.pid);
  assert.equal((await c.inspect(row)).status, 'observed'); await bounded(started.handle.exited);
  const receipt = await c.terminate({ graceMs: 0, deadlineMs: 10000 });
  assert.equal(receipt.processes, 'confirmed'); assert.equal(receipt.auditCoverage, false);
});

test('post-client drain retains a detached helper exec and audits it before final coverage', native, async t => {
  const bash = realpathSync.native('/bin/bash');
  for (const leak of [true, false]) {
    const token = createHash('sha256').update(`controlled-post-client-${leak}`).digest('hex');
    const f = fixture(t, `import {spawn} from 'node:child_process';
      import {createInterface} from 'node:readline';
      const child=spawn(process.env.BASH,['-c',
        'end=$((SECONDS+20)); while [[ ! -e "$RELEASE" ]] && ((SECONDS<end)); do :; done; exec "$BASH" -c "end=$((SECONDS+20)); while ((SECONDS<end)); do :; done" "$LATE_ARG"'],
        {detached:true,stdio:'ignore',env:process.env});
      child.unref();console.log(child.pid);
      const lines=createInterface({input:process.stdin});
      for await(const text of lines){if(text==='exit')process.exit(0);}`);
    const release = join(f.directory, 'release');
    const c = await context(t, f, [], { runtimePins: [f.nodePin, f.modulePin, pin(bash)] });
    const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory,
      env: env({ BASH: bash, RELEASE: release, LATE_ARG: leak ? token : 'controlled-clean' }) });
    assert.equal(started.status, 'started');
    const helper = Number(await bounded(line(started.handle.stdout))); assert.ok(helper > 0);
    // ACK every initial generation, then let the client/root exit. The helper is owned
    // by the subreaper and has not yet exec'd its late argv; no watchdog runs in drain.
    const initial = await c.auditInventory(); assert.equal(initial.status, 'observed');
    for (const row of initial.snapshots) {
      const observed = await c.inspectAudit(row); assert.equal(observed.status, 'observed');
      assert.equal(inspectLinuxArguments(observed.argv, [token]).clean, true);
      assert.equal((await c.acknowledgeAudit(row)).ok, true);
    }
    started.handle.stdin.write('exit\n'); await bounded(started.handle.exited);
    assert.equal(alive(helper), true);
    writeFileSync(release, 'release', { mode: 0o600 });
    await new Promise(resolve => setTimeout(resolve, 200));
    let lateArg, finalClean = true, audited = false;
    const session = createLinuxProbeSession({ inspectArguments: async () => {
      audited = true;
      const final = await c.auditInventory(); assert.equal(final.status, 'observed');
      assert.equal(final.coverageGap, false); assert.equal(final.fresh, true);
      for (const row of final.snapshots) {
        const observed = await c.inspectAudit(row); assert.equal(observed.status, 'observed');
        if (row.pid === helper && observed.argv.at(-1) === (leak ? token : 'controlled-clean')) lateArg = observed.argv.at(-1);
        if (inspectLinuxArguments(observed.argv, [token]).clean !== true) finalClean = false;
        assert.equal((await c.acknowledgeAudit(row)).ok, true);
      }
      return finalClean;
    } });
    // Controlled prior transcript proof, not a claim of real peer or client admission.
    // The final classifier above uses actual kernel-retained helper argv and ACKs.
    Object.assign(session.proof, { authenticated: true, clientBound: true, serverBound: true,
      profileCompared: true, namespaceSeparated: true, argumentsClean: true,
      probes: Object.fromEntries(isolationProbeNames.map(name => [name, true])) });
    session.state.ended = true;
    const receipt = await c.terminate({ graceMs: 0, deadlineMs: 10000,
      audit: () => session.auditArguments({ final: true }) });
    assert.equal(audited, true, 'termination must run the final classifier');
    assert.equal(lateArg, leak ? token : 'controlled-clean');
    assert.equal(finalClean, !leak);
    assert.equal(evaluateLinuxIsolation(session.proof), leak ? 'violated' : 'observed');
    assert.equal(session.versionProbeReady(receipt.auditCoverage), !leak);
    assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
    assert.equal(receipt.auditCoverage, true, JSON.stringify(receipt));
    assert.ok(receipt.elapsedMs <= 10000); assert.equal(alive(helper), false);
  }
});

test('a final audit that never settles still leaves native stopping its reserved budget', native, async t => {
  const f = fixture(t, `console.log('ready'); setInterval(() => {}, 1000);`);
  const c = await context(t, f);
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started'); assert.equal(await bounded(line(started.handle.stdout)), 'ready');
  let audited = false;
  const receipt = await c.terminate({ graceMs: 0, deadlineMs: 10000, audit: () => { audited = true; return new Promise(() => {}); } });
  assert.equal(audited, true);
  assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
  assert.equal(receipt.auditCoverage, false, 'an unfinished final audit must fail closed');
  assert.ok(receipt.elapsedMs <= 10000, JSON.stringify(receipt));
});

test('immediate same-image forks from an owned descendant retain actual argv generations', native, async t => {
  try { accessSync('/bin/bash', constants.X_OK); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    t.skip('controlled pure-fork fixture requires standalone /bin/bash'); return;
  }
  // Each background builtin forks Bash and exits immediately, without exec or
  // a readiness wait. The intermediate Bash is itself an owned descendant.
  const count = 48, marker = 'controlled-fork-argv';
  const script = `for ((i=0;i<${count};i++)); do (:) & printf '%s\\n' "$!"; done; wait; printf 'done\\n'; read -r hold`;
  const bash = pin('/bin/bash');
  const f = fixture(t, `import {spawn} from 'node:child_process';
    const child=spawn(${JSON.stringify(bash.path)},['--noprofile','--norc','-c',${JSON.stringify(script)},${JSON.stringify(marker)}],
      {stdio:['pipe','inherit','inherit'],env:{}});child.on('error',()=>process.exit(125));
    child.on('exit',code=>process.exit(code??125));process.stdin.pipe(child.stdin);`);
  const c = await context(t, f, [], { runtimePins: [f.nodePin, f.modulePin, bash] });
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started');
  const lines = createInterface({ input: started.handle.stdout }); t.after(() => lines.close());
  const children = [];
  await bounded((async () => { for await (const value of lines) {
    if (value === 'done') return;
    assert.match(value, /^\d+$/); children.push(Number(value));
  } throw new Error('controlled fork fixture exited before completion'); })());
  assert.equal(children.length, count); assert.equal(new Set(children).size, count);
  const inventory = await c.auditInventory();
  assert.equal(inventory.status, 'observed', JSON.stringify(inventory));
  const snapshots = new Map();
  for (const row of inventory.snapshots) {
    const observed = await c.inspectAudit(row);
    assert.equal(observed.status, 'observed', JSON.stringify(observed));
    if (children.includes(row.pid)) {
      assert.equal(observed.executablePath, bash.path);
      assert.equal(observed.executableSha256, bash.sha256);
      assert.deepEqual(observed.argv, [bash.path, '--noprofile', '--norc', '-c', script, marker]);
      assert.equal(alive(row.pid), false, 'the pure-fork snapshot must outlive its child');
      snapshots.set(row.pid, row);
    }
    assert.equal((await c.acknowledgeAudit(row)).ok, true);
  }
  // A clean result must never cover a receipt-list child whose actual argv was
  // not read. This fixture additionally demands complete supported capture.
  if (snapshots.size !== count) {
    assert.ok(inventory.coverageGap || !inventory.fresh);
    assert.equal((await c.terminate({ graceMs: 0 })).auditCoverage, false);
  }
  assert.equal(snapshots.size, count, 'every immediate pure-fork lifetime requires its own retained snapshot');
  assert.equal(inventory.coverageGap, false); assert.equal(inventory.fresh, true);
  const exited = bounded(started.handle.exited);
  started.handle.stdin.write('release\n'); await exited;
  const final = await c.auditInventory();
  assert.equal(final.coverageGap, false);
  for (const row of final.snapshots) {
    assert.equal((await c.inspectAudit(row)).status, 'observed');
    assert.equal((await c.acknowledgeAudit(row)).ok, true);
  }
  const receipt = await c.terminate({ graceMs: 0, deadlineMs: 10000 });
  assert.equal(receipt.processes, 'confirmed'); assert.equal(receipt.auditCoverage, true);
});

test('kernel-held capture preserves job-control stops and ordinary signal delivery', native, async t => {
  const f = fixture(t, `process.on('SIGTERM',()=>console.log('term-delivered'));
    process.on('SIGCONT',()=>console.log('continued'));
    process.stdin.on('data',()=>console.log('input-delivered'));console.log('ready');setInterval(()=>{},1000);`);
  const c = await context(t, f);
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started');
  const lines = createInterface({ input: started.handle.stdout }); t.after(() => lines.close());
  const replies = lines[Symbol.asyncIterator]();
  const next = async () => { const reply = await bounded(replies.next()); assert.equal(reply.done, false); return reply.value; };
  assert.equal(await next(), 'ready');
  let inputDelivered = false;
  lines.on('line', value => { if (value === 'input-delivered') inputDelivered = true; });
  process.kill(started.handle.pid, 'SIGSTOP');
  await bounded((async () => { for (;;) {
    const stat = readFileSync(`/proc/${started.handle.pid}/stat`, 'utf8');
    if (/^[Tt] /.test(stat.slice(stat.lastIndexOf(')') + 2))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } })());
  started.handle.stdin.write('request\n');
  // LISTEN can retain the kernel's tracing-stop state. Require persistence
  // through observer progress and no userspace input processing before CONT.
  for (let i = 0; i < 5; i++) {
    assert.equal((await c.observe()).status, 'observed');
    await new Promise(resolve => setTimeout(resolve, 20));
    const stat = readFileSync(`/proc/${started.handle.pid}/stat`, 'utf8');
    assert.match(stat.slice(stat.lastIndexOf(')') + 2), /^[Tt] /);
    assert.equal(inputDelivered, false);
  }
  process.kill(started.handle.pid, 'SIGCONT');
  assert.deepEqual([await next(), await next()].sort(), ['continued', 'input-delivered']);
  process.kill(started.handle.pid, 'SIGTERM'); assert.equal(await next(), 'term-delivered');
  const receipt = await c.terminate({ graceMs: 0, deadlineMs: 10000 });
  assert.equal(receipt.processes, 'confirmed'); assert.equal(alive(started.handle.pid), false);
});

test('every live audit captures a fresh argv generation after an acknowledged observation', native, async t => {
  const f = fixture(t, 'process.stdin.once("data",()=>{process.title="controlled-argv-change";console.log("changed");});console.log("ready");setInterval(()=>{},1000);');
  const c = await context(t, f);
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(await bounded(new Promise(resolve => started.handle.stdout.once('data', bytes => resolve(bytes.toString().trim())))), 'ready');
  const first = await c.auditInventory();
  for (const row of first.snapshots) { assert.equal((await c.inspectAudit(row)).status, 'observed'); assert.equal((await c.acknowledgeAudit(row)).ok, true); }
  const changed = new Promise(resolve => started.handle.stdout.once('data', bytes => resolve(bytes.toString().trim())));
  started.handle.stdin.write('change\n'); assert.equal(await bounded(changed), 'changed');
  const second = await c.auditInventory(); assert.equal(second.coverageGap, false); assert.equal(second.fresh, true);
  let found = false;
  for (const row of second.snapshots) {
    assert.ok(row.generation > Math.max(...first.snapshots.map(row => row.generation)));
    const observed = await c.inspectAudit(row); assert.equal(observed.status, 'observed');
    found ||= observed.argv.some(value => value.includes('controlled-argv-change'));
    assert.equal((await c.acknowledgeAudit(row)).ok, true);
  }
  assert.equal(found, true);
  const third = await c.auditInventory(); assert.ok(third.snapshots.length > 0);
  for (const row of third.snapshots) { assert.equal((await c.inspectAudit(row)).status, 'observed'); assert.equal((await c.acknowledgeAudit(row)).ok, true); }
  assert.equal((await c.terminate({ graceMs: 0, deadlineMs: 10000 })).auditCoverage, true);
});

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
  try { accessSync('/usr/bin/bwrap', constants.X_OK); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    t.skip('controlled nested namespace test requires executable /usr/bin/bwrap'); return;
  }
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

test('traced multithreaded Node roots confirm immediate, forced and graceful tree closure', { ...native, timeout: 90_000 }, async t => {
  const f = fixture(t, `import {Worker} from 'node:worker_threads';
    import {spawn} from 'node:child_process';import {once} from 'node:events';
    import {readdirSync,writeFileSync} from 'node:fs';
    const workers=Array.from({length:4},()=>new Worker(
      "const {parentPort}=require('node:worker_threads');parentPort.postMessage('ready');setInterval(()=>{},1000)",{eval:true}));
    await Promise.all(workers.map(worker=>once(worker,'message')));
    const children=Array.from({length:3},()=>spawn(process.execPath,
      ['-e',"console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore'],env:{}}));
    await Promise.all(children.map(child=>once(child.stdout,'data')));
    process.on('SIGTERM',()=>{
      if(process.env.GRACEFUL==='yes'){writeFileSync(process.env.REPORT,'term-delivered');process.exit(0);}
    });
    console.log(JSON.stringify({pids:children.map(child=>child.pid),
      tids:readdirSync('/proc/self/task').map(Number)}));setInterval(()=>{},1000);`);
  // Preserve the host's reproducible held-closure input shape for the startup
  // cases, in addition to testing the ordinary small-pin fully started roots.
  const startupPins = [];
  for (let i = 0; i < 300; i++) {
    const file = join(f.directory, `startup-pin-${i}.mjs`);
    writeFileSync(file, `export const value=${i};`); startupPins.push(pin(file));
  }
  // No readiness hold: terminate can interrupt Node's own startup clone events.
  // Repeat the exact trigger separately from the fully started Worker fixture.
  for (let i = 0; i < 3; i++) {
    const c = await context(t, f, [], { runtimePins: [f.nodePin, f.modulePin, ...startupPins] });
    const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
    assert.equal(started.status, 'started');
    const receipt = await c.terminate({ graceMs: 0, deadlineMs: 10000 });
    assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
    assert.equal(receipt.activeProcesses, 0); assert.deepEqual(receipt.survivors, []);
    assert.ok(receipt.elapsedMs <= 10000); assert.equal(alive(started.handle.pid), false);
  }
  for (const graceful of [false, true]) {
    const report = join(f.directory, graceful ? 'graceful.txt' : 'forced.txt');
    const c = await context(t, f);
    const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory,
      env: env({ GRACEFUL: graceful ? 'yes' : 'no', REPORT: report }) });
    assert.equal(started.status, 'started');
    const { pids, tids } = JSON.parse(await bounded(line(started.handle.stdout)));
    assert.equal(pids.length, 3); assert.ok(tids.length >= 5, 'root must have live Worker threads');
    for (const pid of [...pids, ...tids]) assert.equal(alive(pid), true);
    const receipt = await c.terminate({ graceMs: graceful ? 1000 : 0, deadlineMs: 10000 });
    assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
    assert.equal(receipt.activeProcesses, 0); assert.deepEqual(receipt.survivors, []);
    assert.ok(receipt.elapsedMs <= 10000);
    for (const pid of [started.handle.pid, ...pids, ...tids]) assert.equal(alive(pid), false);
    const exited = await bounded(started.handle.exited);
    assert.equal(exited.code, graceful ? 0 : 137);
    if (graceful) assert.equal(readFileSync(report, 'utf8'), 'term-delivered');
  }
});

test('forced observer death cannot confirm traced process closure', native, async t => {
  const f = fixture(t, `import {readFileSync} from 'node:fs';
    const tracer=Number(readFileSync('/proc/self/status','utf8').match(/^TracerPid:\\s+(\\d+)$/m)?.[1]);
    console.log(tracer);setInterval(()=>{},1000);`);
  const c = await context(t, f);
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started');
  const tracer = Number(await bounded(line(started.handle.stdout)));
  assert.ok(Number.isSafeInteger(tracer) && tracer > 0 && tracer !== process.pid);
  // Only kill the kernel-reported observer of this controlled root. EXITKILL
  // provides a backstop, but the lost wait/closure receipt must remain unresolved.
  process.kill(tracer, 'SIGKILL');
  const receipt = await c.terminate({ graceMs: 0, deadlineMs: 10000 });
  assert.equal(receipt.processes, 'unresolved', JSON.stringify(receipt));
  assert.ok(receipt.elapsedMs <= 10000);
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

test('more than 256 sequential descendant lifetimes reclaim pidfd-confirmed dead slots', { ...native, timeout: 60_000 }, async t => {
  try { accessSync('/bin/sleep', constants.X_OK); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    t.skip('controlled churn fixture requires executable /bin/sleep'); return;
  }
  const f = fixture(t, 'import {spawn} from "node:child_process";const wave=()=>Promise.all(Array.from({length:8},()=>new Promise(done=>spawn("/bin/sleep",["0.12"],{stdio:"ignore",env:{}}).on("exit",done))));for(let i=0;i<40;i++)await wave();console.log("churn-done");setInterval(()=>{},1000);');
  const c = await context(t, f);
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started');
  assert.equal(await bounded(line(started.handle.stdout), 30000), 'churn-done');
  const inventory = await c.observe();
  assert.equal(inventory.status, 'observed', JSON.stringify(inventory));
  assert.deepEqual(inventory.processes.map(p => p.pid), [started.handle.pid]);
  assert.equal((await c.auditInventory()).coverageGap, true);
  const receipt = await c.terminate({ graceMs: 0, deadlineMs: 10000 });
  assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
  assert.equal(receipt.auditCoverage, false);
  assert.equal(alive(started.handle.pid), false);
});

test('ownership overflow starts bounded cleanup without a host request and preserves an outsider', native, async t => {
  try { accessSync('/bin/sleep', constants.X_OK); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    t.skip('controlled overflow fixture requires executable /bin/sleep'); return;
  }
  const outsider = spawn('/bin/sleep', ['30'], { stdio: 'ignore', env: {} });
  t.after(() => outsider.kill('SIGKILL'));
  const f = fixture(t, 'import {spawn} from "node:child_process";import {appendFileSync,writeFileSync} from "node:fs";writeFileSync(process.env.REPORT,"");for(let i=0;i<300;i++){const child=spawn("/bin/sleep",["30"],{stdio:"ignore",env:{}});if(child.pid)appendFileSync(process.env.REPORT,child.pid+"\\n");}setInterval(()=>{},1000);');
  const report = join(f.directory, 'owned-pids.txt');
  const c = await context(t, f);
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env({ REPORT: report }) });
  assert.equal(started.status, 'started');
  // No observe/inspect/terminate RPC may be needed to trigger the observer's fail-closed cleanup.
  await bounded(started.handle.exited, 20000);
  const bytes = readFileSync(report, 'utf8'); assert.ok(bytes.length <= 4096);
  const pids = bytes.trim().split('\n').map(Number);
  // Overflow fires once the owned table (root included) is full, so the root records roughly that many children
  // before cleanup lands; how many more it records first depends on runner timing.
  assert.ok(pids.length >= 200 && pids.length <= 300, `recorded ${pids.length} descendants`); assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  const receipt = await c.terminate({ graceMs: 0, deadlineMs: 10000 });
  assert.equal(receipt.processes, 'unresolved', JSON.stringify(receipt));
  assert.ok(receipt.elapsedMs <= 10000, JSON.stringify(receipt));
  assert.equal(alive(started.handle.pid), false);
  for (const pid of pids) assert.equal(alive(pid), false, `proven-owned descendant ${pid} survived overflow cleanup`);
  assert.equal(alive(outsider.pid), true, 'unrelated same-user process must not be signalled');
});

test('inspect distinguishes pidfd-confirmed exit from live membership and non-membership', native, async t => {
  const f = fixture(t, 'import {spawn} from "node:child_process";const child=spawn(process.execPath,["-e","setTimeout(()=>{},1500)"],{stdio:"ignore",env:{}});console.log(child.pid);setInterval(()=>{},1000);');
  const c = await context(t, f);
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started');
  const pid = Number(await bounded(line(started.handle.stdout)));
  let row;
  await bounded((async () => { for (;;) { const inventory = await c.observe(); assert.equal(inventory.status, 'observed'); row = inventory.processes.find(p => p.pid === pid); if (row) return; await new Promise(resolve => setTimeout(resolve, 20)); } })());
  const live = await c.inspect(row);
  assert.equal(live.status, 'observed', JSON.stringify(live));
  assert.equal((await c.inspect({ pid, birth: '1' })).reason, 'ipc-peer-membership');
  await bounded((async () => { while (alive(pid)) await new Promise(resolve => setTimeout(resolve, 20)); })());
  const exited = await c.inspect(row);
  assert.equal(exited.status, 'unavailable', JSON.stringify(exited));
  assert.equal(exited.reason, 'process-exited');
  const root = await c.inspect({ pid: started.handle.pid, birth: started.handle.birth });
  assert.equal(root.status, 'observed', JSON.stringify(root));
  assert.equal((await c.terminate({ graceMs: 0 })).processes, 'confirmed');
});

test('a live image observation failure never reports kernel-confirmed exit', native, async t => {
  const f = fixture(t, 'import {spawn} from "node:child_process";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)",...Array(510).fill("fixed")],{stdio:"ignore",env:{}});console.log(child.pid);setInterval(()=>{},1000);');
  const c = await context(t, f);
  const started = await c.start({ file: f.nodePin.path, argv: [f.file], cwd: f.directory, env: env() });
  assert.equal(started.status, 'started'); const pid = Number(await bounded(line(started.handle.stdout)));
  const inventory = await c.observe(); assert.equal(inventory.status, 'observed');
  const row = inventory.processes.find(p => p.pid === pid); assert.ok(row);
  const refused = await c.inspect(row);
  assert.equal(refused.status, 'unavailable'); assert.equal(refused.reason, 'ipc-peer-image');
  assert.equal(alive(pid), true);
  assert.equal((await c.terminate({ graceMs: 0 })).processes, 'confirmed'); assert.equal(alive(pid), false);
});

test('a raw NUL escape byte on the wire is rejected as malformed input', native, async t => {
  const run = bytes => new Promise((resolve, reject) => {
    const helper = spawn(facility, [], { env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    helper.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
    helper.once('error', reject);
    helper.once('close', code => resolve({ code, replies: out.split('\n').filter(Boolean)
      .map(text => { try { return JSON.parse(text); } catch { return null; } })
      .filter(message => message && Number.isSafeInteger(message.id)) }));
    helper.stdin.write(bytes); helper.stdin.end();
  });
  const valid = await bounded(run(Buffer.from('{"id":1,"op":"probe"}\n')));
  assert.equal(valid.code, 0);
  assert.equal(valid.replies.length, 1);
  assert.equal(valid.replies[0].result.status, 'available');
  const malformed = await bounded(run(Buffer.concat([Buffer.from('{"id":1,"op":"probe\\'), Buffer.from([0]), Buffer.from('"}\n')])));
  assert.equal(malformed.code, 125);
  assert.equal(malformed.replies.length, 0);
});

test('a faulted facility never reports complete argv coverage even without owned processes', native, async () => {
  const result = await bounded(new Promise((resolve, reject) => {
    const helper = spawn(facility, [], { env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    helper.stdout.on('data', chunk => { output += chunk.toString(); });
    helper.once('error', reject);
    helper.once('close', code => resolve({ code, messages: output.split('\n').filter(Boolean).map(JSON.parse) }));
    helper.stdin.end('{"id":1,"op":"probe","unexpected":true}\n{"id":2,"op":"terminate","graceMs":0,"deadlineMs":1000}\n');
  }));
  assert.equal(result.code, 125);
  const receipt = result.messages.find(message => message.id === 2)?.result;
  assert.equal(receipt?.processes, 'unresolved');
  assert.equal(receipt.auditCoverage, false);
});
