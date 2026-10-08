// Real Windows Job-object lifecycle and fixed pipe-facility acceptance at the exported seams.
//
// These tests exercise only exported behavior across the OS/process boundary. They never inspect a
// helper's private functions and never substitute a controlled peer for the production OS facility.
// On a non-Windows host the Job mechanism is honestly unavailable and the process mechanisms are
// skipped rather than simulated.
//
// The peer checks below rely on the OS facility's connection-bound identity:
//   { status, pid, birth, executablePath, executableSha256, argv, selectedEntryId }
// Missing, expired or mismatched process identity cannot authenticate a stream.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { bundledNativeFixtures } from '../../src/harness/native/contracts.mjs';
import { createEvidenceChannel, evaluateServerEvidence } from '../../src/harness/native/evidence.mjs';
import { fixtureFiles, fixtureMarker } from '../../src/harness/native/fixture-data.mjs';
import * as lifecycle from '../../src/harness/native/lifecycle.mjs';
import { protectWindowsCell } from '../../src/harness/native/windows-facility.mjs';

const WINDOWS = process.platform === 'win32';
const WINDOWS_ONLY = WINDOWS ? false : 'Windows Job facility only';
const OFF_WINDOWS_ONLY = WINDOWS ? 'the Job facility is exercised on Windows' : false;
const WINDOWS_MECHANISM = { skip: WINDOWS_ONLY, timeout: 60_000 };
const MARKER = '--aihq-native-absolute-entry';

const FIXTURE_SPEC = (() => {
  const { server, instructions } = bundledNativeFixtures[0];
  return { attestTool: 'aihq_attest_instruction', queryTool: server.queryTool, toolNames: [...server.toolNames],
    markerSha256: instructions[0].markerSha256, expectedResultSha256: server.expectedResultSha256 };
})();

const hashFile = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});

async function pinExecutable(file) {
  const path = realpathSync.native(file);
  return { path, sha256: await hashFile(path), byteLength: statSync(path).size };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

async function waitUntil(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function respond(promise, timeoutMs, message) {
  return Promise.race([promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  })]);
}

function firstLine(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const finish = (error) => {
      clearTimeout(timer);
      stream.off('data', onData);
      if (error) reject(error);
      else resolve(buffer.slice(0, buffer.indexOf('\n')).trim());
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      if (buffer.includes('\n')) finish(null);
    };
    const timer = setTimeout(() => finish(new Error(`no child pid within ${timeoutMs}ms`)), timeoutMs);
    stream.on('data', onData);
    stream.once('error', (error) => finish(error));
  });
}

function tempDirectory(prefix = 'aihq-win-job-') {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

function stageFixtureServer(directory, name = 'server.mjs') {
  const file = join(directory, name);
  writeFileSync(file, fixtureFiles.server.text);
  return file;
}

function childEnv(extra = {}) {
  const env = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.TEMP) env.TEMP = process.env.TEMP;
  if (process.env.TMP) env.TMP = process.env.TMP;
  return { ...env, ...extra };
}

async function prepareContext(input) {
  assert.equal(typeof lifecycle.prepareLifecycleContext, 'function',
    'lifecycle.prepareLifecycleContext must be exported at the agreed prepareLifecycleContext seam');
  return lifecycle.prepareLifecycleContext({
    lifecycleId: 'windows-job.v1',
    os: 'win32',
    signal: new AbortController().signal,
    deadline: performance.now() + 30_000,
    ...input
  });
}

async function readyContext({ directory, selectedEntries = [] } = {}) {
  const dir = directory ?? tempDirectory();
  const controller = new AbortController();
  const prepared = await prepareContext({
    directory: dir,
    deadline: performance.now() + 20_000,
    signal: controller.signal,
    runtimePins: [await pinExecutable(process.execPath)],
    selectedEntries
  });
  return { directory: dir, controller, prepared };
}

// The exact selected-entry argv shape: the absolute pinned module path,
// the fixed absolute-entry marker, then (for the recorder) the declared remaining arguments.
function ownershipPolicy(entry, executableSha256, onIdentity = () => {}) {
  return (identity) => {
    onIdentity(identity);
    return identity?.status === 'observed' && identity.selectedEntryId === entry.id &&
      identity.executableSha256 === executableSha256 && Array.isArray(identity.argv) &&
      identity.argv.length === entry.argv.length && identity.argv.every((value, index) => value === entry.argv[index]);
  };
}

// A root that starts one immediate grandchild, waits until that grandchild reports it is actually
// running, then reports the pid and exits on its own. The grandchild is spawned detached so Node's
// own libuv child Job does not terminate it when the root exits; that does not grant the OS
// BREAKAWAY_FROM_JOB flag and the grandchild must still belong to the outer owned Job.
const GRANDCHILD_SCRIPT = String.raw`process.stdout.write('ready\n');setInterval(()=>{},1000);`;
const GRANDCHILD_B64 = Buffer.from(GRANDCHILD_SCRIPT, 'utf8').toString('base64');
const ROOT_WITH_GRANDCHILD = [
  "const{spawn}=require('node:child_process');",
  `const script=Buffer.from('${GRANDCHILD_B64}','base64').toString('utf8');`,
  "const child=spawn(process.execPath,['-e',script],{stdio:['ignore','pipe','ignore'],detached:true,windowsHide:true});",
  "child.on('error',()=>process.exit(2));",
  "let seen='';",
  "child.stdout.on('data',chunk=>{seen+=chunk;if(seen.includes('ready'))process.stdout.write(String(child.pid)+'\\n',()=>process.exit(0));});",
  "const guard=setTimeout(()=>process.exit(2),8000);guard.unref();"
].join('');

// A disposable in-Job client that is the declared selected entry but reports another PID in its
// hello, so the channel's OS-observed identity and the claimed identity disagree.
const FORGED_PID_CLIENT = [
  "import net from 'node:net';",
  "const socket=net.connect(process.env.AIHQ_NATIVE_EVIDENCE_CHANNEL);",
  "socket.on('connect',()=>socket.write(JSON.stringify({version:1,token:process.env.AIHQ_NATIVE_EVIDENCE_TOKEN,pid:process.pid+1})+'\\n'));",
  "socket.on('error',()=>process.exit(0));",
  "socket.on('close',()=>process.exit(0));",
  "setTimeout(()=>process.exit(0),8000).unref();"
].join('\n');

// A peer spawned by the test itself, never by the owned context, so it is outside the owned Job.
const OUTSIDE_JOB_CLIENT = [
  "const net=require('node:net');",
  "const socket=net.connect(process.env.AIHQ_TEST_PIPE);",
  "socket.on('connect',()=>socket.write(JSON.stringify({version:1,token:process.env.AIHQ_TEST_TOKEN,pid:process.pid})+'\\n'));",
  "socket.on('error',()=>process.exit(0));",
  "socket.on('close',()=>process.exit(0));",
  "setTimeout(()=>process.exit(0),8000).unref();"
].join('');

test('windows-job.v1 availability is a bounded real host probe, not a static refusal', async () => {
  assert.equal(typeof lifecycle.lifecycleAvailability, 'function');
  const observed = await lifecycle.lifecycleAvailability('windows-job.v1', 'win32', { deadline: performance.now() + 10_000 });
  if (WINDOWS) {
    assert.equal(observed.status, 'available', `the Windows host must expose a working Job facility, got ${JSON.stringify(observed)}`);
  } else {
    assert.equal(observed.status, 'unavailable', `a non-Windows host cannot expose windows-job.v1, got ${JSON.stringify(observed)}`);
  }
});

test('an empty Job context is cleaned up to active zero even though no client ever starts', { skip: WINDOWS_ONLY }, async (t) => {
  const { directory, controller, prepared } = await readyContext();
  t.after(() => { controller.abort(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const receipt = await prepared.context.terminate({ graceMs: 2000, deadlineMs: 15_000 });
  assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
  assert.deepEqual(receipt.survivors, []);
});

test('windows-job.v1 cleanup reaches active zero for a grandchild after the root exits', { skip: WINDOWS_ONLY, timeout: 60_000 }, async (t) => {
  const { directory, controller, prepared } = await readyContext();
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = prepared.context;
  let grandchild = null;
  let terminated = null;
  t.after(async () => {
    controller.abort();
    if (!terminated) { try { await context.terminate({ graceMs: 2000, deadlineMs: 15_000 }); } catch { /* best effort */ } }
    if (grandchild !== null && alive(grandchild)) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* best effort */ } }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const started = await context.start({
    file: process.execPath,
    argv: ['-e', ROOT_WITH_GRANDCHILD],
    cwd: directory,
    env: childEnv()
  });
  assert.equal(started.status, 'started', JSON.stringify(started));
  const handle = started.handle;
  grandchild = Number(await firstLine(handle.stdout, 10_000));
  assert.ok(Number.isSafeInteger(grandchild) && grandchild > 0, `grandchild pid ${grandchild}`);
  assert.equal(alive(grandchild), true, 'the grandchild must already be running before the root exits');
  const exit = await handle.exited;
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0);
  assert.equal(alive(handle.pid), false, 'the root must have exited before aggregate cleanup');
  assert.equal(alive(grandchild), true, 'the detached immediate grandchild outlives the root until the Job is closed');
  terminated = await context.terminate({ graceMs: 3000, deadlineMs: 15_000 });
  assert.equal(terminated.processes, 'confirmed', JSON.stringify(terminated));
  assert.deepEqual(terminated.survivors, []);
  assert.equal(await waitUntil(() => !alive(grandchild), 5000), true, 'the grandchild must be gone after active-zero cleanup');
});

test('windows-job.v1 context is unavailable to a non-Windows host without pretending to launch', { skip: OFF_WINDOWS_ONLY }, async () => {
  const directory = tempDirectory();
  try {
    const prepared = await prepareContext({
      directory,
      deadline: performance.now() + 5000,
      runtimePins: [await pinExecutable(process.execPath)],
      selectedEntries: []
    });
    assert.equal(prepared.status, 'unavailable');
    assert.equal(typeof prepared.reason, 'string');
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('a same-Job selected absolute-entry peer is the only authenticated pipe peer and answers the fixture', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  const serverFile = stageFixtureServer(directory);
  const nodePin = await pinExecutable(process.execPath);
  const modulePin = await pinExecutable(serverFile);
  const entry = { id: 'aihq-native-fixture-server', executablePath: nodePin.path,
    executableSha256: nodePin.sha256, argv: [modulePin.path, MARKER] };
  const prepared = await prepareContext({ directory, deadline: performance.now() + 30_000,
    runtimePins: [nodePin, modulePin], selectedEntries: [entry] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = prepared.context;
  let channel = null;
  t.after(async () => {
    try { await channel?.close(); } catch { /* best effort */ }
    try { await context.terminate({ graceMs: 2000, deadlineMs: 15_000 }); } catch { /* best effort */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const connections = [];
  let observedPeer = null;
  let ownershipChecked = false;
  const created = await context.createPipe();
  assert.equal(created.status, 'ready', JSON.stringify(created));
  created.transport.onConnection((socket) => connections.push(socket));
  channel = await createEvidenceChannel({ directory, transport: created.transport,
    isOwnedServer: ownershipPolicy(entry, nodePin.sha256, (identity) => { ownershipChecked = true; observedPeer = identity; }) });
  const started = await context.start({ file: nodePin.path, argv: [...entry.argv], cwd: directory,
    env: childEnv({ AIHQ_NATIVE_EVIDENCE_CHANNEL: channel.endpoint, AIHQ_NATIVE_EVIDENCE_TOKEN: channel.token }) });
  assert.equal(started.status, 'started', JSON.stringify(started));
  const handle = started.handle;
  const lines = createInterface({ input: handle.stdout })[Symbol.asyncIterator]();
  const rpc = async (id, method, params) => {
    handle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const { value, done } = await respond(lines.next(), 20_000, `the fixture server never answered ${method}`);
    assert.equal(done, false, `the fixture server ended before answering ${method}`);
    return JSON.parse(value);
  };
  try {
    const initialized = await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(initialized.result.serverInfo.name, 'aihq-native-fixture');
    assert.equal(connections.length, 1, 'exactly one pipe connection carries the session');
    assert.equal(ownershipChecked, true, 'the OS peer identity must reach the ownership policy');
    assert.ok(observedPeer, 'the peer must be observed, not merely accepted');
    assert.equal(observedPeer.pid, handle.pid, 'the OS peer is the launched root inside the owned Job');
    assert.match(String(observedPeer.birth), /^\d+$/, 'the peer birth is the real OS process creation time');
    assert.equal(observedPeer.executablePath.toLowerCase(), nodePin.path.toLowerCase());
    const attestation = await rpc(2, 'tools/call', { name: 'aihq_attest_instruction',
      arguments: { marker: fixtureMarker, challenge: channel.challenge } });
    assert.deepEqual(JSON.parse(attestation.result.content[0].text),
      { markerSha256: FIXTURE_SPEC.markerSha256, challenge: channel.challenge });
    const query = await rpc(3, 'tools/call', { name: 'aihq_graph_query', arguments: { node: 'entry', challenge: channel.challenge } });
    assert.deepEqual(query.result, { content: [{ type: 'text', text: 'leaf' }], isError: false });
    handle.stdin.end();
    const exit = await respond(handle.exited, 20_000, 'the fixture server did not exit after its input closed');
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0);
    assert.notEqual((await connections[0].observePeer()).status, 'observed',
      'a held peer identity cannot be reused after its process exits');
    const closed = await channel.close();
    channel = null;
    assert.equal(closed.peer, 'authenticated', JSON.stringify(closed));
    assert.equal(closed.violation, null);
    const evaluation = evaluateServerEvidence(closed.frames, FIXTURE_SPEC);
    assert.equal(evaluation.attestation, 'attested');
    assert.equal(evaluation.ambiguousBeforeAttestation, false);
    assert.equal(evaluation.query, 'answered');
    const receipt = await context.terminate({ graceMs: 2000, deadlineMs: 15_000 });
    assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
    assert.deepEqual(receipt.survivors, []);
  } finally {
    if (!handle.stdin.writableEnded) handle.stdin.end();
  }
});

test('a pipe peer outside the owned Job is refused even when it presents the exact live token', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  const nodePin = await pinExecutable(process.execPath);
  const prepared = await prepareContext({ directory, deadline: performance.now() + 30_000,
    runtimePins: [nodePin], selectedEntries: [] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = prepared.context;
  let channel = null;
  let outsider = null;
  let ownershipChecked = false;
  t.after(async () => {
    try { outsider?.kill(); } catch { /* best effort */ }
    try { await channel?.close(); } catch { /* best effort */ }
    try { await context.terminate({ graceMs: 1000, deadlineMs: 10_000 }); } catch { /* best effort */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const created = await context.createPipe();
  assert.equal(created.status, 'ready', JSON.stringify(created));
  channel = await createEvidenceChannel({ directory, transport: created.transport,
    isOwnedServer: () => { ownershipChecked = true; return false; } });
  outsider = spawn(process.execPath, ['-e', OUTSIDE_JOB_CLIENT], { stdio: 'ignore', windowsHide: true,
    env: { ...process.env, AIHQ_TEST_PIPE: channel.endpoint, AIHQ_TEST_TOKEN: channel.token } });
  assert.equal(await waitUntil(() => channel.snapshot().peer !== 'none', 15_000), true,
    'an outside-Job peer must be refused, not left pending');
  const snapshot = channel.snapshot();
  assert.notEqual(snapshot.peer, 'authenticated');
  assert.equal(snapshot.connections, 1);
  assert.equal(snapshot.frames.length, 0);
  assert.equal(snapshot.violation, null);
  assert.equal(ownershipChecked, false, 'an unobservable OS peer must be refused before the ownership policy runs');
});

test('an in-Job peer running a module other than the declared entry is refused', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  const declaredFile = stageFixtureServer(directory, 'declared.mjs');
  const actualFile = stageFixtureServer(directory, 'actual.mjs');
  const nodePin = await pinExecutable(process.execPath);
  const declaredPin = await pinExecutable(declaredFile);
  const actualPin = await pinExecutable(actualFile);
  const entry = { id: 'declared-entry', executablePath: nodePin.path, executableSha256: nodePin.sha256,
    argv: [declaredPin.path, MARKER] };
  const prepared = await prepareContext({ directory, deadline: performance.now() + 30_000,
    runtimePins: [nodePin, declaredPin, actualPin], selectedEntries: [entry] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = prepared.context;
  let channel = null;
  let ownershipChecked = false;
  t.after(async () => {
    try { await channel?.close(); } catch { /* best effort */ }
    try { await context.terminate({ graceMs: 2000, deadlineMs: 15_000 }); } catch { /* best effort */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const created = await context.createPipe();
  assert.equal(created.status, 'ready', JSON.stringify(created));
  channel = await createEvidenceChannel({ directory, transport: created.transport,
    isOwnedServer: () => { ownershipChecked = true; return false; } });
  const started = await context.start({ file: nodePin.path, argv: [actualPin.path, MARKER], cwd: directory,
    env: childEnv({ AIHQ_NATIVE_EVIDENCE_CHANNEL: channel.endpoint, AIHQ_NATIVE_EVIDENCE_TOKEN: channel.token }) });
  assert.equal(started.status, 'started', JSON.stringify(started));
  assert.equal(await waitUntil(() => channel.snapshot().peer !== 'none', 15_000), true,
    'the undeclared in-Job module must be refused, not left pending');
  const snapshot = channel.snapshot();
  assert.notEqual(snapshot.peer, 'authenticated');
  assert.equal(snapshot.frames.length, 0);
  assert.equal(ownershipChecked, false, 'an undeclared module must never reach the ownership policy');
  const receipt = await context.terminate({ graceMs: 2000, deadlineMs: 15_000 });
  assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
  assert.deepEqual(receipt.survivors, []);
});

test('an exact selected entry presenting a forged token is refused before any peer identity is trusted', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  const serverFile = stageFixtureServer(directory);
  const nodePin = await pinExecutable(process.execPath);
  const modulePin = await pinExecutable(serverFile);
  const entry = { id: 'forged-token-entry', executablePath: nodePin.path, executableSha256: nodePin.sha256,
    argv: [modulePin.path, MARKER] };
  const prepared = await prepareContext({ directory, deadline: performance.now() + 30_000,
    runtimePins: [nodePin, modulePin], selectedEntries: [entry] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = prepared.context;
  let channel = null;
  let ownershipChecked = false;
  t.after(async () => {
    try { await channel?.close(); } catch { /* best effort */ }
    try { await context.terminate({ graceMs: 2000, deadlineMs: 15_000 }); } catch { /* best effort */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const created = await context.createPipe();
  assert.equal(created.status, 'ready', JSON.stringify(created));
  channel = await createEvidenceChannel({ directory, transport: created.transport,
    isOwnedServer: () => { ownershipChecked = true; return false; } });
  const forgedToken = 'f'.repeat(64);
  assert.notEqual(forgedToken, channel.token);
  const started = await context.start({ file: nodePin.path, argv: [modulePin.path, MARKER], cwd: directory,
    env: childEnv({ AIHQ_NATIVE_EVIDENCE_CHANNEL: channel.endpoint, AIHQ_NATIVE_EVIDENCE_TOKEN: forgedToken }) });
  assert.equal(started.status, 'started', JSON.stringify(started));
  assert.equal(await waitUntil(() => channel.snapshot().peer !== 'none', 15_000), true,
    'a forged token must be refused, not left pending');
  const snapshot = channel.snapshot();
  assert.equal(snapshot.peer, 'rejected');
  assert.equal(snapshot.frames.length, 0);
  assert.equal(ownershipChecked, false, 'a failed token exchange must never reach the ownership policy');
});

test('an OS-observed exact selected entry that claims a different PID is refused', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  const clientFile = join(directory, 'forged-pid.mjs');
  writeFileSync(clientFile, FORGED_PID_CLIENT);
  const nodePin = await pinExecutable(process.execPath);
  const clientPin = await pinExecutable(clientFile);
  const entry = { id: 'forged-pid-entry', executablePath: nodePin.path, executableSha256: nodePin.sha256,
    argv: [clientPin.path, MARKER] };
  const prepared = await prepareContext({ directory, deadline: performance.now() + 30_000,
    runtimePins: [nodePin, clientPin], selectedEntries: [entry] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = prepared.context;
  let channel = null;
  let ownershipChecked = false;
  t.after(async () => {
    try { await channel?.close(); } catch { /* best effort */ }
    try { await context.terminate({ graceMs: 2000, deadlineMs: 15_000 }); } catch { /* best effort */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const created = await context.createPipe();
  assert.equal(created.status, 'ready', JSON.stringify(created));
  channel = await createEvidenceChannel({ directory, transport: created.transport,
    isOwnedServer: () => { ownershipChecked = true; return false; } });
  const started = await context.start({ file: nodePin.path, argv: [clientPin.path, MARKER], cwd: directory,
    env: childEnv({ AIHQ_NATIVE_EVIDENCE_CHANNEL: channel.endpoint, AIHQ_NATIVE_EVIDENCE_TOKEN: channel.token }) });
  assert.equal(started.status, 'started', JSON.stringify(started));
  assert.equal(await waitUntil(() => channel.snapshot().peer !== 'none', 15_000), true,
    'a forged PID must be refused, not left pending');
  const snapshot = channel.snapshot();
  assert.equal(snapshot.peer, 'rejected', 'the peer must be OS-observed and then refused on the PID binding');
  assert.equal(snapshot.frames.length, 0);
  assert.equal(ownershipChecked, false, 'the PID binding must be refused before the ownership policy runs');
});

test('declared entries that are relative or unpinned are refused before any Job starts', { skip: WINDOWS_ONLY, timeout: 30_000 }, async (t) => {
  const directory = tempDirectory();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const serverFile = stageFixtureServer(directory);
  const nodePin = await pinExecutable(process.execPath);
  const modulePin = await pinExecutable(serverFile);
  const base = { id: 'entry', executablePath: nodePin.path, executableSha256: nodePin.sha256, argv: [modulePin.path, MARKER] };
  const relative = await prepareContext({ directory, deadline: performance.now() + 10_000,
    runtimePins: [nodePin, modulePin], selectedEntries: [{ ...base, argv: ['server.mjs', MARKER] }] });
  assert.equal(relative.status, 'unavailable', JSON.stringify(relative));
  assert.equal(typeof relative.reason, 'string');
  const unpinnedModule = await prepareContext({ directory, deadline: performance.now() + 10_000,
    runtimePins: [nodePin], selectedEntries: [base] });
  assert.equal(unpinnedModule.status, 'unavailable', JSON.stringify(unpinnedModule));
  const unpinnedExecutable = await prepareContext({ directory, deadline: performance.now() + 10_000,
    runtimePins: [modulePin], selectedEntries: [{ ...base, executableSha256: '0'.repeat(64) }] });
  assert.equal(unpinnedExecutable.status, 'unavailable', JSON.stringify(unpinnedExecutable));
  const emptyArgv = await prepareContext({ directory, deadline: performance.now() + 10_000,
    runtimePins: [nodePin, modulePin], selectedEntries: [{ ...base, argv: [] }] });
  assert.equal(emptyArgv.status, 'unavailable', JSON.stringify(emptyArgv));
});

test('the relative configured entry re-execs once to the declared exact absolute module', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  const nested = join(directory, '.aihq-native');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'server.mjs'), fixtureFiles.server.text);
  const nodePin = await pinExecutable(process.execPath);
  const modulePin = await pinExecutable(join(nested, 'server.mjs'));
  const entry = { id: 'relative-configured-server', executablePath: nodePin.path, executableSha256: nodePin.sha256,
    argv: [modulePin.path, MARKER] };
  const prepared = await prepareContext({ directory, deadline: performance.now() + 30_000,
    runtimePins: [nodePin, modulePin], selectedEntries: [entry] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = prepared.context;
  let channel = null;
  let observedPeer = null;
  t.after(async () => {
    try { await channel?.close(); } catch { /* best effort */ }
    try { await context.terminate({ graceMs: 2000, deadlineMs: 15_000 }); } catch { /* best effort */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const created = await context.createPipe();
  assert.equal(created.status, 'ready', JSON.stringify(created));
  channel = await createEvidenceChannel({ directory, transport: created.transport,
    isOwnedServer: ownershipPolicy(entry, nodePin.sha256, (identity) => { observedPeer = identity; }) });
  const started = await context.start({ file: nodePin.path, argv: ['.aihq-native/server.mjs'], cwd: directory,
    env: childEnv({ AIHQ_NATIVE_EVIDENCE_CHANNEL: channel.endpoint, AIHQ_NATIVE_EVIDENCE_TOKEN: channel.token }) });
  assert.equal(started.status, 'started', JSON.stringify(started));
  const handle = started.handle;
  const lines = createInterface({ input: handle.stdout })[Symbol.asyncIterator]();
  handle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  const { value, done } = await respond(lines.next(), 20_000,
    'the relative entry did not re-exec to the declared absolute module and authenticate');
  assert.equal(done, false);
  assert.equal(JSON.parse(value).result.serverInfo.name, 'aihq-native-fixture');
  assert.ok(observedPeer, 'the absolute-entry re-exec child must be the observed peer');
  assert.notEqual(observedPeer.pid, handle.pid, 'the peer is the absolute-entry child, not the relative parent');
  const closed = await channel.close();
  channel = null;
  assert.equal(closed.peer, 'authenticated', JSON.stringify(closed));
  assert.equal(closed.violation, null);
  const receipt = await context.terminate({ graceMs: 2000, deadlineMs: 15_000 });
  assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
  assert.deepEqual(receipt.survivors, []);
});

test('an expired deadline or an already-aborted signal refuses the context without launching a helper', { skip: WINDOWS_ONLY, timeout: 30_000 }, async (t) => {
  const directory = tempDirectory();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const nodePin = await pinExecutable(process.execPath);
  const expired = await prepareContext({ directory, deadline: performance.now() - 1, runtimePins: [nodePin], selectedEntries: [] });
  assert.equal(expired.status, 'unavailable', JSON.stringify(expired));
  assert.equal(expired.reason, 'deadline');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await prepareContext({ directory, signal: controller.signal, deadline: performance.now() + 10_000,
    runtimePins: [nodePin], selectedEntries: [] });
  assert.equal(cancelled.status, 'unavailable', JSON.stringify(cancelled));
  assert.equal(cancelled.reason, 'cancelled');
});

test('a runtime pin whose bytes no longer match refuses the context before any launch', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const nodePin = await pinExecutable(process.execPath);
  const drifted = { path: nodePin.path, sha256: '0'.repeat(64), byteLength: nodePin.byteLength };
  const prepared = await prepareContext({ directory, deadline: performance.now() + 20_000,
    runtimePins: [drifted], selectedEntries: [] });
  assert.equal(prepared.status, 'unavailable', JSON.stringify(prepared));
  assert.equal(typeof prepared.reason, 'string');
});

test('cancellation stops the owned Job while retaining the observer for confirmed cleanup', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  const controller = new AbortController();
  const nodePin = await pinExecutable(process.execPath);
  const prepared = await prepareContext({ directory, signal: controller.signal, deadline: performance.now() + 30_000,
    runtimePins: [nodePin], selectedEntries: [] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = prepared.context;
  t.after(async () => {
    try { await context.terminate({ graceMs: 0, deadlineMs: 10_000 }); } catch { /* best effort */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const started = await context.start({ file: nodePin.path, argv: ['-e', 'setInterval(()=>{},1000)'], cwd: directory, env: childEnv() });
  assert.equal(started.status, 'started', JSON.stringify(started));
  assert.equal(alive(started.handle.pid), true);
  controller.abort();
  assert.equal(await waitUntil(() => !alive(started.handle.pid), 15_000), true,
    'cancellation must stop the owned process through the Job');
  const receipt = await context.terminate({ graceMs: 1000, deadlineMs: 10_000 });
  assert.equal(receipt.processes, 'confirmed', 'the retained observer must query actual active-zero cleanup');
  assert.deepEqual(receipt.survivors, []);
  assert.equal(alive(started.handle.pid), false);
});

test('actual helper loss kills the owned Job and leaves its cleanup unconfirmed', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  const nodePin = await pinExecutable(process.execPath);
  const prepared = await prepareContext({ directory, deadline: performance.now() + 30_000,
    runtimePins: [nodePin], selectedEntries: [] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = prepared.context;
  t.after(async () => {
    try { await context.terminate({ graceMs: 0, deadlineMs: 10_000 }); } catch { /* best effort */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  // The disposable root's actual parent is its owning helper. It kills only that
  // process; closing the helper's sole Job handle must kill this root as well.
  const script = "process.stdout.write(String(process.ppid)+'\\n',()=>setTimeout(()=>process.kill(process.ppid,'SIGKILL'),100));setInterval(()=>{},1000);";
  const started = await context.start({ file: nodePin.path, argv: ['-e', script], cwd: directory, env: childEnv() });
  assert.equal(started.status, 'started', JSON.stringify(started));
  const helperPid = Number(await firstLine(started.handle.stdout, 5000));
  assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0 && helperPid !== started.handle.pid);
  assert.equal(await waitUntil(() => !alive(started.handle.pid), 10_000), true);
  const receipt = await context.terminate({ graceMs: 0, deadlineMs: 10_000 });
  assert.equal(receipt.processes, 'unresolved');
  assert.equal(alive(helperPid), false);
});

test('a control frame beyond the fixed bridge cap is refused before it is sent', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  const nodePin = await pinExecutable(process.execPath);
  const prepared = await prepareContext({ directory, deadline: performance.now() + 30_000,
    runtimePins: [nodePin], selectedEntries: [] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = prepared.context;
  t.after(async () => {
    try { await context.terminate({ graceMs: 0, deadlineMs: 10_000 }); } catch { /* best effort */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const started = await context.start({ file: nodePin.path, argv: ['-e', '0'], cwd: directory,
    env: childEnv({ AIHQ_TEST_BIG: 'x'.repeat(1_100_000) }) });
  assert.equal(started.status, 'unavailable', JSON.stringify(started));
  assert.equal(started.reason, 'input-limit');
  assert.equal(started.partial, undefined);
});

test('child output over the fixed facility bound faults and is never confirmed as clean cleanup', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  const nodePin = await pinExecutable(process.execPath);
  const prepared = await prepareContext({ directory, deadline: performance.now() + 30_000,
    runtimePins: [nodePin], selectedEntries: [] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = prepared.context;
  t.after(async () => {
    try { await context.terminate({ graceMs: 0, deadlineMs: 10_000 }); } catch { /* best effort */ }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const script = "const chunk=Buffer.alloc(65536,97);let sent=0;const write=()=>{while(sent<33554432){sent+=chunk.length;if(!process.stdout.write(chunk))return process.stdout.once('drain',write);}process.exit(0);};write();";
  const started = await context.start({ file: nodePin.path, argv: ['-e', script], cwd: directory, env: childEnv() });
  assert.equal(started.status, 'started', JSON.stringify(started));
  let bytes = 0;
  started.handle.stdout.on('data', (chunk) => { bytes += chunk.length; });
  const exit = await respond(started.handle.exited, 20_000, 'the faulted child never settled');
  assert.equal(exit.signal, null);
  assert.equal(exit.reason, 'limit-exceeded');
  assert.equal(started.handle.failure.reason, 'limit-exceeded');
  assert.equal(started.handle.failure.limitSource, 'output');
  assert.ok(started.handle.failure.observedBytes > 2 * 1024 * 1024);
  assert.ok(bytes > 0 && bytes <= 2 * 1024 * 1024, `bounded child output, observed ${bytes} bytes`);
  const receipt = await context.terminate({ graceMs: 0, deadlineMs: 10_000 });
  assert.equal(receipt.processes, 'unresolved', JSON.stringify(receipt));
  assert.deepEqual(receipt.survivors, []);
});

test('an active operation deadline stops the Job and keeps the cleanup observer', WINDOWS_MECHANISM, async t => {
  const directory = tempDirectory();
  const nodePin = await pinExecutable(process.execPath);
  const deadline = performance.now() + 5000;
  const prepared = await prepareContext({ directory, deadline, runtimePins: [nodePin], selectedEntries: [] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const context = prepared.context;
  t.after(async () => {
    await context.terminate({ graceMs: 0, deadlineMs: 10000 });
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const started = await context.start({ file: nodePin.path, argv: ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], cwd: directory, env: childEnv() });
  assert.equal(started.status, 'started', JSON.stringify(started));
  assert.equal(await firstLine(started.handle.stdout, 4000), 'ready');
  assert.equal(alive(started.handle.pid), true);
  assert.equal(await waitUntil(() => !alive(started.handle.pid), 8000), true);
  assert.ok(performance.now() >= deadline);
  const receipt = await context.terminate({ graceMs: 0, deadlineMs: 10000 });
  assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
  assert.equal(receipt.activeProcesses, 0);
  assert.deepEqual(receipt.survivors, []);
});

test('a rejected launch without a client PID still reports helper cleanup', WINDOWS_MECHANISM, async t => {
  const directory = tempDirectory();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await lifecycle.startLifecycle({ lifecycleId: 'windows-job.v1', os: 'win32',
    file: process.execPath, argv: ['-e', 'throw Error("must not start")'], cwd: join(directory, 'missing'),
    // The deadline bounds preparation (pinning node and the helper). Under loaded CI a short one expired before
    // the helper existed, leaving nothing to clean up and never reaching the rejected launch under test.
    env: childEnv(), deadline: performance.now() + 60_000 });
  assert.equal(result.status, 'unavailable', JSON.stringify(result));
  assert.equal(result.partial, undefined);
  assert.ok(result.cleanup, JSON.stringify(result));
  assert.equal(result.cleanup.confirmed, true);
  assert.deepEqual(result.cleanup.survivors, []);
  assert.ok(Number.isFinite(result.cleanupStartedAt));
});

test('cell protection refuses a hardlinked file before changing its outside-cell object', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  const cell = join(directory, 'cell');
  mkdirSync(cell);
  const outside = join(directory, 'outside.txt');
  writeFileSync(outside, 'disposable outside-cell canary');
  linkSync(outside, join(cell, 'linked.txt'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const result = await protectWindowsCell({ directory: cell, deadline: performance.now() + 5000 });
  assert.equal(result.status, 'unavailable', 'a protected cell must not mutate a shared outside-cell object');
  assert.equal(statSync(outside).nlink, 2);
});

test('a native child requesting OS breakaway is denied by the owning Job', WINDOWS_MECHANISM, async (t) => {
  const directory = tempDirectory();
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const source = join(directory, 'breakaway.cs');
  const program = join(directory, 'breakaway.exe');
  // Independent Win32 fixture: it asks for real CREATE_BREAKAWAY_FROM_JOB.
  // If a regression permits it, the fixture terminates/waits its held child.
  writeFileSync(source, String.raw`using System;
using System.Runtime.InteropServices;
using System.Text;
class Breakaway {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,reservedSize; public IntPtr reservedBytes,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct Created { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="CreateProcessW")] static extern bool Create(string file,StringBuilder command,IntPtr ps,IntPtr ts,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out Created created);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint exit);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process,uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static int Main(string[] args) {
    Startup startup=new Startup();startup.cb=(uint)Marshal.SizeOf(typeof(Startup));Created child;
    bool created=Create(args[0],new StringBuilder("\""+args[0]+"\" -e \"process.exit(0)\""),IntPtr.Zero,IntPtr.Zero,false,0x01000000u|0x08000000u,IntPtr.Zero,null,ref startup,out child);
    int error=Marshal.GetLastWin32Error();
    if(created){TerminateProcess(child.process,1);WaitForSingleObject(child.process,5000);CloseHandle(child.thread);CloseHandle(child.process);}
    Console.WriteLine(created?"escaped":"denied:"+error);return created?1:0;
  }
}`);
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${program}`, source],
    { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
  const programPin = await pinExecutable(program);
  const nodePin = await pinExecutable(process.execPath);
  const prepared = await prepareContext({ directory, deadline: performance.now() + 20_000,
    runtimePins: [programPin, nodePin], selectedEntries: [] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  t.after(async () => { await prepared.context.terminate({ graceMs: 0, deadlineMs: 10_000 }); });
  const started = await prepared.context.start({ file: programPin.path, argv: [nodePin.path], cwd: directory, env: childEnv() });
  assert.equal(started.status, 'started', JSON.stringify(started));
  assert.equal(await firstLine(started.handle.stdout, 5000), 'denied:5');
  assert.equal((await started.handle.exited).code, 0);
  assert.equal((await prepared.context.terminate({ graceMs: 0, deadlineMs: 10_000 })).processes, 'confirmed');
});
