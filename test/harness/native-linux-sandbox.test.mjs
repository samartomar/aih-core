// Linux sandbox composition. Protocol tests use a synthetic transport and prove only transcript logic;
// isolation claims come solely from the gated real C facility + pinned SRT tests at the end.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { absentVendorMountPoints, composeLinuxSandbox, createLinuxProbeSession, linuxObserverSources,
  sweepLinuxBridge, sweepVendorMountPoints } from '../../src/harness/native/linux-sandbox.mjs';
import { evaluateLinuxIsolation, isolationProbeNames } from '../../src/harness/native/linux-isolation.mjs';
import { verifyLinuxVendorClosure } from '../../src/harness/native/linux-runtime.mjs';

const LINUX = process.platform === 'linux' && process.arch === 'x64';
const POSIX = process.platform !== 'win32';
const TOKEN = 'a'.repeat(64), CHALLENGE = 'b'.repeat(64);
const HOST = Object.freeze({ pid: '4:1', mount: '4:2', network: '4:3', user: '4:4' });
const INNER = Object.freeze({ pid: '4:11', mount: '4:12', network: '4:13', user: '4:14' });
const ENTRY = Object.freeze({ id: 'aih-native-isolation', executablePath: '/runtime/node', executableSha256: 'c'.repeat(64),
  argv: Object.freeze(['/package/linux-workload.mjs', '/cell/observations/p00000000.json']) });
const identity = (overrides = {}) => ({ status: 'observed', pid: 4100, uid: 1000, birth: '777', namespace: INNER.pid, namespacePid: 3,
  namespaces: INNER, executablePath: ENTRY.executablePath, executableSha256: ENTRY.executableSha256, selectedEntryId: ENTRY.id,
  argv: [...ENTRY.argv], ...overrides });
const passed = () => Object.fromEntries(isolationProbeNames.map(name => [name, true]));
const hello = (overrides = {}) => ({ version: 1, token: TOKEN, pid: 3, ...overrides });
const probes = (values = {}, overrides = {}) => ({ type: 'probes', challenge: CHALLENGE, probes: { ...passed(), ...values }, ...overrides });

class Peer extends Duplex {
  constructor(observed) { super(); this.observed = observed; this.sent = []; this.peerCalls = 0; }
  _read() {}
  _write(chunk, encoding, callback) {
    for (const line of chunk.toString().split('\n').filter(Boolean)) this.sent.push(JSON.parse(line));
    callback();
  }
  observePeer() { this.peerCalls += 1; return Promise.resolve(this.observed); }
  send(value) { this.push(Buffer.isBuffer(value) ? value : Buffer.from((typeof value === 'string' ? value : JSON.stringify(value)) + '\n')); }
}
const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const waitFor = async (predicate, label) => {
  for (let i = 0; i < 400; i += 1) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail(label);
};
function harness({ peer = identity(), profile = true, inspect = [], canaries = { readIntact: true, writeAbsent: true }, bind = true } = {}) {
  const calls = { bind: 0, inspect: 0 }, results = [...inspect];
  const session = createLinuxProbeSession({ token: TOKEN, challenge: CHALLENGE, entry: ENTRY, hostNamespaces: HOST,
    verifyProfile: () => profile, hostCanaries: () => canaries,
    inspectArguments: async () => { calls.inspect += 1; return results.length ? results.shift() : true; },
    bindClient: async () => { calls.bind += 1; if (bind) session.proof.clientBound = true; return bind; } });
  const socket = new Peer(peer); session.accept(socket);
  return { session, socket, calls };
}
async function authenticated(options) {
  const h = harness(options);
  h.socket.send(hello());
  await waitFor(() => h.socket.sent.length === 1, 'challenge');
  return h;
}

test('authenticated transcript reaches the client only after kernel identity, profile and every denial are proven', async () => {
  const { session, socket, calls } = await authenticated();
  assert.deepEqual(socket.sent[0], { type: 'challenge', challenge: CHALLENGE });
  assert.equal(session.proof.authenticated, true); assert.equal(session.proof.namespaceSeparated, true);
  assert.equal(session.proof.profileCompared, true);
  socket.send(probes());
  await waitFor(() => socket.sent.length === 2, 'start');
  assert.deepEqual(socket.sent[1], { type: 'start' }); assert.equal(session.proof.argumentsClean, true);
  socket.send({ type: 'client', pid: 9 });
  await waitFor(() => calls.bind === 1, 'client binding');
  assert.equal(session.state.clientPid, 9);
  await waitFor(() => socket.sent.length === 3, 'resume bound client');
  assert.deepEqual(socket.sent[2], { type: 'resume' });
  socket.send({ type: 'end', code: 0 });
  await waitFor(() => socket.sent.length === 4, 'finish');
  assert.deepEqual(socket.sent[3], { type: 'finish' });
  assert.equal(session.state.ended, true); assert.equal(calls.inspect, 2);
  assert.equal(evaluateLinuxIsolation(session.proof), 'unobservable'); // no selected server yet
  session.proof.serverBound = true;
  assert.equal(evaluateLinuxIsolation(session.proof), 'observed');
  socket.push(null); await settle();
  assert.equal(session.state.closed, false);
  const text = JSON.stringify({ proof: session.proof, state: session.state });
  assert.equal(text.includes(TOKEN), false); assert.equal(text.includes(CHALLENGE), false);
});

test('a forged or replayed hello never reaches kernel identity or a challenge', async () => {
  for (const forged of [hello({ token: 'd'.repeat(64) }), hello({ token: 'a'.repeat(63) }), hello({ extra: true }),
    hello({ version: 2 }), hello({ pid: 0 }), hello({ pid: '3' })]) {
    const { session, socket } = harness();
    socket.send(forged); await settle();
    assert.equal(socket.sent.length, 0); assert.equal(session.proof.authenticated, false);
    assert.equal(socket.peerCalls, 0); assert.equal(socket.destroyed, true); assert.equal(session.state.violation, false);
  }
});

test('the kernel peer must be the exact selected workload with the claimed namespace PID', async () => {
  for (const observed of [identity({ namespacePid: 4 }), identity({ selectedEntryId: 'other' }), identity({ executableSha256: 'e'.repeat(64) }),
    identity({ executablePath: '/other/node' }), identity({ argv: [...ENTRY.argv, '--inspect'] }), identity({ argv: ENTRY.argv.slice(1) }),
    identity({ birth: 777 }), { status: 'unavailable', reason: 'ipc-peer-membership' }]) {
    const { session, socket } = harness({ peer: observed });
    socket.send(hello()); await settle();
    assert.equal(socket.sent.length, 0); assert.equal(session.proof.authenticated, false);
    assert.equal(evaluateLinuxIsolation(session.proof), 'unobservable');
  }
});

test('a workload sharing any host namespace is a proven violation and never receives a challenge', async () => {
  for (const key of ['pid', 'mount', 'network', 'user']) {
    const { session, socket } = harness({ peer: identity({ namespaces: { ...INNER, [key]: HOST[key] } }) });
    socket.send(hello()); await settle();
    assert.equal(socket.sent.length, 0); assert.equal(session.state.violation, true, key);
    assert.equal(session.proof.namespaceSeparated, false);
    assert.equal(evaluateLinuxIsolation({ ...session.proof, probes: passed() }), 'violated');
  }
  const missing = { ...INNER }; delete missing.user;
  const { session, socket } = harness({ peer: identity({ namespaces: missing }) });
  socket.send(hello()); await settle();
  assert.equal(socket.sent.length, 0); assert.equal(session.state.violation, false); assert.equal(session.proof.namespaceSeparated, null);
});

test('a runner profile that differs from the fixed derivation stops before probes', async () => {
  const { session, socket } = harness({ profile: false });
  socket.send(hello()); await settle();
  assert.equal(socket.sent.length, 0); assert.equal(session.proof.profileCompared, false); assert.equal(session.state.violation, false);
});

test('probe answers must echo the challenge and use the closed tri-state vocabulary', async () => {
  for (const message of [probes({}, { challenge: 'f'.repeat(64) }), probes({ injected: true }), probes({ outsideReadDenied: 'true' }),
    probes({}, { type: 'other' }), probes({}, { extra: 1 })]) {
    const { session, socket } = await authenticated();
    socket.send(message); await settle();
    assert.equal(socket.sent.length, 1); assert.equal(session.state.closed, true); assert.equal(session.state.violation, false);
  }
});

test('proven access stops the client while missing proof leaves isolation unobservable', async () => {
  for (const name of isolationProbeNames.filter(key => key !== 'outsideWriteDenied')) {
    const denied = await authenticated();
    denied.socket.send(probes({ [name]: false })); await settle();
    assert.equal(denied.socket.sent.length, 1, name); assert.equal(denied.session.state.violation, true, name);
    const open = await authenticated();
    open.socket.send(probes({ [name]: null })); await settle();
    assert.equal(open.socket.sent.length, 1, name); assert.equal(open.session.state.violation, false, name);
    assert.equal(evaluateLinuxIsolation(open.session.proof), 'unobservable', name);
  }
  const leaked = await authenticated({ inspect: [false] });
  leaked.socket.send(probes()); await settle();
  assert.equal(leaked.session.state.violation, true); assert.equal(leaked.session.proof.argumentsClean, false);
  const uninspected = await authenticated({ inspect: [null] });
  uninspected.socket.send(probes()); await settle();
  assert.equal(uninspected.socket.sent.length, 1); assert.equal(uninspected.session.state.violation, false);
});

test('the host canary, not the workload report, decides the outside write proof', async () => {
  const written = await authenticated({ canaries: { readIntact: true, writeAbsent: false } });
  written.socket.send(probes()); await settle();
  assert.equal(written.session.proof.probes.outsideWriteDenied, false); assert.equal(written.session.state.violation, true);
  const changed = await authenticated({ canaries: { readIntact: false, writeAbsent: true } });
  changed.socket.send(probes()); await settle();
  assert.equal(changed.session.state.violation, true);
  const unknown = await authenticated({ canaries: { readIntact: true, writeAbsent: null } });
  unknown.socket.send(probes()); await settle();
  assert.equal(unknown.session.proof.probes.outsideWriteDenied, null); assert.equal(unknown.session.state.violation, false);
  const privateTmpfs = await authenticated();
  privateTmpfs.socket.send(probes({ outsideWriteDenied: false }));
  await waitFor(() => privateTmpfs.socket.sent.length === 2, 'start after a sandbox-private write');
  assert.equal(privateTmpfs.session.proof.probes.outsideWriteDenied, true);
});

test('frames are bounded and malformed transport input never becomes evidence', async () => {
  for (const input of [Buffer.from('x'.repeat(4097) + '\n'), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from('{"version":1,\n'),
    Buffer.from('{}'.repeat(4200))]) {
    const { session, socket } = harness();
    socket.send(input); await settle();
    assert.equal(socket.sent.length, 0); assert.equal(session.proof.authenticated, false); assert.equal(session.state.closed, true);
  }
  const extra = await authenticated();
  extra.socket.send(probes()); await waitFor(() => extra.socket.sent.length === 2, 'start');
  extra.socket.send({ type: 'end', code: 0 }); await waitFor(() => extra.socket.sent.length === 3, 'finish');
  extra.socket.send({ type: 'end', code: 0 }); await settle();
  assert.equal(extra.session.state.closed, true);
  const early = await authenticated();
  early.socket.push(null); await settle();
  assert.equal(early.session.state.closed, true); assert.equal(early.session.state.violation, false);
});

test('a second connection is refused without disturbing the authenticated transcript', async () => {
  const { session, socket } = await authenticated();
  const second = new Peer(identity()); session.accept(second);
  assert.equal(second.destroyed, true); assert.equal(session.state.connections, 2);
  socket.send(probes()); await waitFor(() => socket.sent.length === 2, 'start');
});

test('uncorrelated host canary traffic supplies no violation and prevents successful admission', async () => {
  const { session, socket } = await authenticated();
  session.interfere(); socket.send(probes()); await settle();
  assert.equal(session.state.interference, true); assert.equal(session.state.violation, false);
  assert.equal(socket.sent.length, 1); assert.equal(session.state.closed, true);
  session.proof.clientBound = true; session.proof.serverBound = true;
  assert.equal(evaluateLinuxIsolation(session.proof), 'unobservable');
  const reached = await authenticated(); reached.session.interfere();
  reached.socket.send(probes({ proxyWrongPortDenied: false })); await settle();
  assert.equal(reached.session.state.violation, true);
});

test('a client that cannot start ends the transcript without binding a client', async () => {
  const { session, socket, calls } = await authenticated();
  socket.send(probes()); await waitFor(() => socket.sent.length === 2, 'start');
  socket.send({ type: 'end', code: 127 }); await waitFor(() => socket.sent.length === 3, 'finish');
  assert.equal(calls.bind, 0); assert.equal(session.proof.clientBound, false); assert.equal(session.state.code, 127);
});

test('a claimed client PID is never resumed without kernel executable and namespace binding', async () => {
  const { session, socket, calls } = await authenticated({ bind: false });
  socket.send(probes()); await waitFor(() => socket.sent.length === 2, 'start');
  socket.send({ type: 'client', pid: 9 }); await settle();
  assert.equal(calls.bind, 1); assert.equal(session.proof.clientBound, false);
  assert.equal(socket.sent.length, 2); assert.equal(session.state.closed, true);
  assert.equal(session.state.violation, false);
});

test('cleanup removes only vendor mount points that were absent before launch', { skip: POSIX ? false : 'POSIX file modes only' }, t => {
  const project = realpathSync.native(mkdtempSync(join(tmpdir(), 'aihq-linux-mounts-')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(join(project, '.bashrc'), 'owned', { mode: 0o600 });
  writeFileSync(join(project, '.profile'), '', { mode: 0o444 });
  const absent = absentVendorMountPoints(project);
  assert.equal(absent.includes('.bashrc'), false); assert.equal(absent.includes('.profile'), false); assert.ok(absent.includes('.vscode'));
  for (const name of ['.gitconfig', '.vscode']) writeFileSync(join(project, name), '', { mode: 0o444 });
  mkdirSync(join(project, '.claude'));
  writeFileSync(join(project, '.mcp.json'), 'x', { mode: 0o444 });
  writeFileSync(join(project, '.zshrc'), '', { mode: 0o644 });
  mkdirSync(join(project, '.idea')); writeFileSync(join(project, '.idea', 'kept'), 'x');
  sweepVendorMountPoints(project, absent);
  assert.deepEqual(readdirSync(project).sort(), ['.bashrc', '.idea', '.mcp.json', '.profile', '.zshrc']);
});

test('bridge cleanup removes exactly the vendor socket and empty bind source, then the bridge', { skip: POSIX ? false : 'Unix sockets only' }, async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aihq-linux-bridge-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = join(root, 's1'); mkdirSync(bridge, { mode: 0o700 });
  const server = net.createServer(); const socket = join(bridge, 'claude-http-0123456789abcdef.sock');
  await new Promise(resolve => server.listen(socket, resolve));
  mkdirSync(join(bridge, 'claude-empty-AbC123'), { mode: 0o700 });
  assert.equal(sweepLinuxBridge(bridge), true); assert.equal(existsSync(bridge), false);
  await new Promise(resolve => server.close(() => resolve()));
  mkdirSync(bridge); writeFileSync(join(bridge, 'unexpected'), 'x');
  assert.equal(sweepLinuxBridge(bridge), false); assert.equal(existsSync(join(bridge, 'unexpected')), true);
  rmSync(bridge, { recursive: true });
  mkdirSync(join(bridge, 'claude-empty-AbC123'), { recursive: true }); writeFileSync(join(bridge, 'claude-empty-AbC123', 'x'), 'x');
  assert.equal(sweepLinuxBridge(bridge), false);
  rmSync(bridge, { recursive: true });
  assert.equal(sweepLinuxBridge(bridge), true);
});

test('killed-runner cleanup recognizes only its exact fresh vendor multiplex socket', { skip: POSIX ? false : 'Unix sockets only' }, async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aihq-linux-mux-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = join(root, 's1'); mkdirSync(bridge, { mode: 0o700 });
  const server = net.createServer(), path = join(bridge, 'srt-mux-123-0.sock');
  await new Promise(resolve => server.listen(path, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(sweepLinuxBridge(bridge, 124), false); assert.equal(existsSync(path), true);
  assert.equal(sweepLinuxBridge(bridge, 123), true); assert.equal(existsSync(bridge), false);
});

test('off-Linux composition reports unavailable without creating cell material', { skip: LINUX }, async () => {
  assert.equal((await composeLinuxSandbox({ vendor: { status: 'ready' }, execution: 'native' }, () => [])).reason, 'platform-unsupported');
});

// Real C facility + pinned SRT. AIHQ_TEST_LINUX_SANDBOX_RUNTIME names a JSON file
// { runtime: { node, client, bash, env, bwrap, socat, rg, libraries, readFiles }, ldLibraryPath, pins, execution }
// produced from the platform resolver with a controlled synthetic client (bash), never the native client.
const RUNTIME = process.env.AIHQ_TEST_LINUX_SANDBOX_RUNTIME;
const composed = { skip: LINUX && RUNTIME ? false : 'Linux x64 with a controlled pinned runtime description only', timeout: 90_000 };
const sourceRoot = new URL('../../src/harness/native/', import.meta.url);
const pin = path => { const real = realpathSync.native(path), bytes = readFileSync(real); return { path: real, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }; };
async function probeCollector(t) {
  const probeToken = randomBytes(32).toString('hex'), token = randomBytes(32).toString('hex');
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/aih-native-probe' && request.headers.authorization === `Bearer ${probeToken}`) {
      response.setHeader('x-aih-native-probe', probeToken); response.end();
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, token, probeToken };
}
async function composition(t, argv) {
  const described = JSON.parse(readFileSync(RUNTIME, 'utf8'));
  const vendor = verifyLinuxVendorClosure(); assert.equal(vendor.status, 'ready');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-native-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cell = { path: root, ...Object.fromEntries(['home', 'project', 'scratch', 'observations'].map(name => [name, join(root, name)])) };
  for (const name of ['home', 'project', 'scratch', 'observations']) mkdirSync(cell[name], { mode: 0o700 });
  const selected = join(cell.project, 'selected.txt'); writeFileSync(selected, 'synthetic', { mode: 0o600 });
  const collector = await probeCollector(t);
  const observerPins = linuxObserverSources.map(name => pin(fileURLToPath(new URL(name, sourceRoot))));
  const prepared = await composeLinuxSandbox({ cell, runtime: { ...described.runtime, ldLibraryPath: described.ldLibraryPath }, vendor,
    deadline: performance.now() + 60_000, collector, execution: described.execution, selectedPaths: [selected], expectedArgv: argv,
    runtimePins: described.pins, selectedEntries: [] }, () => observerPins);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  t.after(() => prepared.context.terminate({ graceMs: 0, deadlineMs: 10_000 }));
  assert.equal((await prepared.context.createPipe()).status, 'ready');
  const evidenceToken = randomBytes(32).toString('hex');
  const started = await prepared.context.start({ file: described.runtime.client, argv, cwd: cell.project, env: {
    PATH: '/usr/bin', HOME: cell.home, TMPDIR: join(cell.scratch, 'tmp'), AIHQ_NATIVE_EVIDENCE_TOKEN: evidenceToken } });
  assert.equal(started.status, 'started', JSON.stringify(started));
  // Real adapters track the outer runner while probes are still running and no client PID exists.
  await started.handle.track();
  return { cell, context: prepared.context, handle: started.handle, secrets: [collector.token, collector.probeToken, evidenceToken] };
}
const assertNoLeftovers = cell => {
  assert.deepEqual(readdirSync(cell.project), ['selected.txt']);
  for (const name of readdirSync(cell.observations)) {
    assert.equal(['s1', 's2'].includes(name), false, name);
    assert.equal(lstatSync(join(cell.observations, name)).isSocket(), false, name);
  }
};

test('pinned SRT session proves every denial, binds the client and leaves no bridge', composed, async t => {
  const { cell, context, handle, secrets } = await composition(t, ['-c', 'read -t 2 _ || true']);
  await handle.exited;
  const record = context.isolationRecord();
  assert.equal(record.authenticated, true); assert.equal(record.namespaceSeparated, true); assert.equal(record.compared, true);
  assert.deepEqual(record.probes, Object.fromEntries(isolationProbeNames.map(name => [name, true])));
  assert.equal(record.argumentsClean, true); assert.equal(record.clientBound, true); assert.equal(record.ended, true);
  assert.equal(context.isolation(), 'unobservable'); // no selected server in this synthetic session
  assert.equal(context.versionProbeReady(), true);
  for (const secret of secrets) assert.equal(JSON.stringify(record).includes(secret), false);
  const receipt = await context.terminate({ graceMs: 1000, deadlineMs: 10_000 });
  assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
  assertNoLeftovers(cell);
});

test('a runner killed before vendor reset still leaves no socket, bridge or mount point', composed, async t => {
  const { cell, context, handle } = await composition(t, ['-c', 'read -t 30 _ || true']);
  for (let i = 0; i < 200 && !context.isolationRecord().clientBound; i += 1) { await handle.track(); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal(context.isolationRecord().clientBound, true);
  const receipt = await context.terminate({ graceMs: 0, deadlineMs: 10_000 });
  assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt)); assert.ok(receipt.elapsedMs <= 10_000);
  assertNoLeftovers(cell);
});
