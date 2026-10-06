// Linux sandbox composition. Protocol tests use a synthetic transport and prove only transcript logic;
// isolation claims come solely from the gated real C facility + pinned SRT tests at the end.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
import * as sandbox from '../../src/harness/native/linux-sandbox.mjs';
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
  assert.equal(session.state.ended, true); assert.equal(calls.inspect, 3);
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

test('a live helper argv leak remains violated after the helper exits before the end frame', async () => {
  const { session, socket, calls } = await authenticated({ inspect: [true, true, false, true] });
  socket.send(probes()); await waitFor(() => socket.sent.length === 2, 'start');
  socket.send({ type: 'client', pid: 9 }); await waitFor(() => socket.sent.length === 3, 'resume');
  await session.auditArguments();
  assert.equal(calls.inspect, 3);
  assert.equal(session.proof.argumentsClean, false);
  assert.equal(session.state.violation, true);
  socket.send({ type: 'end', code: 0 }); await settle();
  assert.equal(session.proof.argumentsClean, false);
  assert.equal(evaluateLinuxIsolation(session.proof), 'violated');
  assert.equal(session.state.ended, false);
});

test('a known argv coverage gap at end stays unavailable even if a later audit would be clean', async () => {
  const { session, socket, calls } = await authenticated({ inspect: [true, true, null, true] });
  socket.send(probes()); await waitFor(() => socket.sent.length === 2, 'start');
  socket.send({ type: 'client', pid: 9 }); await waitFor(() => socket.sent.length === 3, 'resume');
  socket.send({ type: 'end', code: 0 }); await waitFor(() => session.state.closed, 'coverage gap closes proof');
  assert.equal(session.proof.argumentsClean, null); assert.equal(session.state.ended, false);
  assert.equal(session.state.violation, false); assert.equal(socket.sent.length, 3);
  const before = calls.inspect; assert.equal(await session.auditArguments(), null);
  assert.equal(calls.inspect, before); assert.equal(session.proof.argumentsClean, null);
});

test('post-client drain audits retained generations after end instead of reusing the clean transcript', async () => {
  for (const late of [false, null, true]) {
    const { session, socket, calls } = await authenticated({ inspect: [true, true, true, late] });
    socket.send(probes()); await waitFor(() => socket.sent.length === 2, 'start');
    socket.send({ type: 'client', pid: 9 }); await waitFor(() => socket.sent.length === 3, 'resume');
    socket.send({ type: 'end', code: 0 }); await waitFor(() => socket.sent.length === 4, 'finish');
    session.proof.serverBound = true;
    assert.equal(evaluateLinuxIsolation(session.proof), 'observed');
    assert.equal(await session.auditArguments({ final: true }), late);
    assert.equal(calls.inspect, 4);
    assert.equal(session.versionProbeReady(false), false);
    assert.equal(evaluateLinuxIsolation(session.proof), late === false ? 'violated' : late === null ? 'unobservable' : 'observed');
    assert.equal(session.versionProbeReady(true), late === true);
  }
});

test('a clean empty final audit preserves acknowledged proof only after confirmed complete cleanup', t => {
  // Controlled OS/profile facilities let the actual composition, classifiers, transcript,
  // final receipt and session-observation gate run on every host. This is no OS admission claim.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-clean-final-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = join(root, 'final-clean.mjs');
  writeFileSync(fixture, String.raw`import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
const target = process.argv[2], root = process.argv[3];
const hash = value => createHash('sha256').update(value).digest('hex');
const inner = { pid: '4:11', mount: '4:12', network: '4:13', user: '4:14' };
const host = { pid: '4:1', mount: '4:2', network: '4:3', user: '4:4' };
const mocks = {
  './linux-facility.mjs': 'export const prepareLinuxContext=async input=>globalThis.fixture.prepare(input);',
  './linux-cell-profile.mjs': 'export const acquireLinuxCellProfile=()=>globalThis.fixture.profile;',
  './linux-canaries.mjs': 'export const createLinuxCanaries=()=>globalThis.fixture.canaries;',
  './linux-profile.mjs': 'export const deriveLinuxSessionProfile=()=>({});',
  './linux-platform.mjs': 'export const revalidateLinuxLibraryAliases=async()=>({status:"ready"});',
  'node:fs': "export * from 'node:fs'; import {lstatSync as real} from 'node:fs';" +
    "export const lstatSync=path=>path==='/run/user/1000'?{isDirectory:()=>true,isSymbolicLink:()=>false,uid:1000,mode:0o700}:" +
    "/fixture-(?:http|socks)$/.test(path)?{isSocket:()=>true,uid:1000}:real(path);",
  'node:net': 'export default {createServer:()=>({listening:false,maxConnections:0,once(){},' +
    'listen(target,done){this.listening=true;done();},address:()=>({port:32123}),close(done){this.listening=false;done();}})};'
};
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === target && mocks[specifier]) return {
    url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true
  };
  return next(specifier, context);
} });
// Only this disposable process substitutes the unavailable OS prerequisites.
Object.defineProperty(process, 'platform', { value: 'linux' });
Object.defineProperty(process, 'arch', { value: 'x64' });
Object.defineProperty(process, 'getuid', { value: () => 1000 });
const { composeLinuxSandbox } = await import(target);
class Peer extends Duplex {
  constructor(observed) { super(); this.observed = observed; this.sent = []; }
  _read() {}
  _write(bytes, encoding, done) { this.sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)); done(); }
  observePeer() { return Promise.resolve(this.observed); }
  send(value) { this.push(JSON.stringify(value) + '\n'); }
}
const waitFor = async predicate => {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('controlled transcript did not reach its next phase');
};
const executable = realpathSync.native(process.execPath), pin = { path: executable,
  sha256: hash(readFileSync(executable)), byteLength: readFileSync(executable).length };
for (const mode of ['clean-graceful', 'clean-forced', 'live-empty', 'late-clean', 'initial-empty', 'end-gap', 'zero-argv',
  'leak', 'gap', 'unfresh', 'inspect', 'ack', 'changed', 'late-unacknowledged', 'missing-coverage', 'unresolved', 'release', 'remove', 'deadline']) {
  const path = join(root, mode); mkdirSync(path);
  const cell = { path, ...Object.fromEntries(['home', 'project', 'scratch', 'observations'].map(name => [name, join(path, name)])) };
  for (const name of ['home', 'project', 'scratch', 'observations']) mkdirSync(cell[name]);
  const runtime = { node: executable, client: executable, bash: '/runtime/bash', bwrap: '/runtime/bwrap', which: '/runtime/which',
    libraryAliasDirectories: ['/usr/lib64'], libraryClosure: [] };
  let transportCount = 0, probe, plan, ending = false, audits = 0, inspections = 0, acks = 0, terminal = 0;
  const row = generation => ({ pid: 4101, birth: '778', generation });
  const client = { status: 'observed', pid: 4101, birth: '778', namespacePid: 9, namespaces: inner,
    executablePath: executable, executableSha256: pin.sha256, argv: [executable, '--version'] };
  const native = { hostNamespaces: host,
    createPipe: async () => ({ status: 'ready', transport: { endpoint: ++transportCount === 1 ? 'fixture-probe' : 'fixture-evidence',
      onConnection(callback) { probe = callback; } } }),
    auditInventory: async () => {
      audits++;
      return { status: 'observed', coverageGap: ending && mode === 'gap' || mode === 'end-gap' && audits === 3,
        fresh: !(ending && mode === 'unfresh'),
        snapshots: mode === 'initial-empty' || mode === 'live-empty' && audits > 1 ? [] :
          !ending ? [row(audits)] : ['late-clean', 'zero-argv', 'leak', 'inspect', 'ack', 'changed'].includes(mode) ? [row(audits)] : [] };
    },
    inspectAudit: async observed => {
      inspections++;
      if (ending && mode === 'inspect') return { status: 'unavailable' };
      return { ...client, ...observed, ...(ending && mode === 'zero-argv' ? { argv: [] } : {}),
        ...(ending && mode === 'leak' ? { argv: [executable, 'secret-value'] } : {}),
        ...(ending && mode === 'changed' ? { executablePath: runtime.bash, executableSha256: 'f'.repeat(64) } : {}) };
    },
    acknowledgeAudit: async () => { acks++; return { ok: !(ending && mode === 'ack') }; },
    observe: async () => ({ status: 'observed', processes: [client] }), inspect: async () => client,
    async start() {
      const slots = { collector: 'http://fixture/v1/logs', evidence: 'fixture-evidence', probe: 'fixture-probe',
        http: join(plan.bridge, 'fixture-http'), socks: join(plan.bridge, 'fixture-socks') };
      writeFileSync(plan.profileFile, '{}');
      writeFileSync(plan.receiptFile, JSON.stringify({ slots, baseSha256: hash('{}'), profileSha256: hash('{}'), proxyCapabilitySha256: hash('proxy') }));
      const entry = globalThis.fixture.entry;
      const socket = new Peer({ status: 'observed', pid: 4100, birth: '777', namespacePid: 3, namespaces: inner,
        executablePath: entry.executablePath, executableSha256: entry.executableSha256, selectedEntryId: entry.id, argv: [...entry.argv] });
      probe(socket);
      socket.send({ version: 1, token: globalThis.fixture.token, pid: 3 });
      await waitFor(() => socket.sent.length === 1);
      const { isolationProbeNames } = await import(new URL('linux-isolation.mjs', target));
      socket.send({ type: 'probes', challenge: socket.sent[0].challenge,
        probes: Object.fromEntries(isolationProbeNames.map(name => [name, true])) });
      await waitFor(() => socket.sent.length === 2 || socket.destroyed);
      if (!socket.destroyed) {
        socket.send({ type: 'client', pid: 9 }); await waitFor(() => socket.sent.length === 3);
        socket.send({ type: 'end', code: 0 }); await waitFor(() => socket.sent.length === 4 || socket.destroyed);
      }
      socket.push(null);
      return { status: 'started', handle: { ...client, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        exited: Promise.resolve({ code: 0 }), track: async () => {} } };
    },
    async terminate({ audit }) {
      ending = true; await audit(); terminal++;
      return { processes: mode === 'unresolved' ? 'unresolved' : 'confirmed', survivors: [],
        ...(mode === 'missing-coverage' ? {} : { auditCoverage: mode !== 'late-unacknowledged' }) };
    }
  };
  globalThis.fixture = {
    prepare: async input => { globalThis.fixture.entry = input.selectedEntries.at(-1); return { status: 'ready', context: native }; },
    profile: { planFile: join(cell.observations, 'plan.json'), baseFile: join(cell.observations, 'base.json'),
      windowsCanary: join(cell.observations, 'canary.exe'), base: {}, staged: { directory: '' }, pins: [],
      profileInput: { cell, runtime, selectedPaths: [] }, validate() {}, writePlan(bytes) { plan = JSON.parse(bytes); },
      release(confirmed) {
        assert.equal(context.versionProbeReady(), false, 'no readiness before resource release');
        assert.equal(context.isolation(), mode === 'leak' ? 'violated' : 'unobservable', 'no observed isolation before resource release');
        return confirmed && mode !== 'release';
      } },
    canaries: { files: [], writes: [], pathname: join(cell.observations, 'outside.sock'),
      snapshot: () => ({ readIntact: true, writeAbsent: true }), remove: () => mode !== 'remove' }
  };
  // The production start supplies this private token only to the controlled launch facility.
  const originalStart = native.start;
  native.start = async input => { globalThis.fixture.token = input.env.AIHQ_NATIVE_ISOLATION_TOKEN; return originalStart(); };
  const prepared = await composeLinuxSandbox({ cell, runtime, vendor: { status: 'ready', entry: executable, treeSha256: 'a'.repeat(64), pins: [] },
    deadline: performance.now() + 10000, execution: 'native', collector: { endpoint: 'http://fixture', probeToken: 'a'.repeat(64), token: 'secret-value' },
    runtimePins: [pin], selectedEntries: [], selectedPaths: [], expectedArgv: ['--version'] }, () => []);
  assert.equal(prepared.status, 'ready', mode);
  const context = prepared.context;
  assert.equal((await context.createPipe()).status, 'ready');
  const started = await context.start({ file: executable, argv: ['--version'], cwd: cell.project, env: {} });
  assert.equal(started.status, 'started', JSON.stringify(started));
  assert.equal(await context.acceptServer({ status: 'observed', pid: 4102, birth: '779', namespaces: inner, selectedEntryId: 'controlled-server' }), mode !== 'initial-empty');
  assert.equal(context.isolationRecord().ended, !['initial-empty', 'end-gap'].includes(mode));
  assert.equal(context.isolationRecord().argumentsClean, ['initial-empty', 'end-gap'].includes(mode) ? null : true);
  assert.equal(context.versionProbeReady(), false); assert.equal(context.isolation(), 'unobservable');
  const beforeCount = mode === 'initial-empty' ? 0 : mode === 'live-empty' ? 1 : 3;
  assert.equal(inspections, beforeCount); assert.equal(acks, beforeCount);
  const receipt = await context.terminate({ graceMs: mode === 'clean-graceful' ? 1000 : 0, deadlineMs: mode === 'deadline' ? 0 : 10000 });
  const clean = ['clean-graceful', 'clean-forced', 'live-empty', 'late-clean'].includes(mode);
  assert.equal(context.versionProbeReady(), clean, mode + ': successful final receipt must preserve clean ACKed proof');
  assert.equal(context.isolation(), mode === 'leak' ? 'violated' : clean ? 'observed' : 'unobservable', mode + ': session observation');
  assert.equal(context.isolationRecord().outcome, context.isolation());
  assert.equal(context.isolationRecord().argumentsClean,
    ['initial-empty', 'end-gap', 'zero-argv', 'gap', 'unfresh', 'inspect', 'ack', 'changed', 'late-unacknowledged', 'missing-coverage'].includes(mode)
      ? null : mode === 'leak' ? false : true, mode);
  assert.equal(receipt.processes, ['unresolved', 'release', 'remove', 'deadline'].includes(mode) ? 'unresolved' : 'confirmed', mode);
  assert.equal(terminal, 1); assert.equal(await context.terminate(), receipt, 'idempotent finalization');
  assert.equal(audits, mode === 'initial-empty' ? 2 : mode === 'unfresh' ? 6 : 4, 'final audit always runs, including closed transcripts');
  if (mode.startsWith('clean-')) assert.equal(inspections, 3, 'empty drain does not fabricate a new inspection');
  if (mode === 'late-clean') { assert.equal(inspections, 4); assert.equal(acks, 4); }
}
console.log('FINAL_CLEAN_RECEIPT_PASS');
`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [fixture, new URL('../../src/harness/native/linux-sandbox.mjs', import.meta.url).href, root],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /FINAL_CLEAN_RECEIPT_PASS/);
});

test('changed proxy executable bytes are unavailable rather than an argv leak', () => {
  const runtime = { bwrap: '/runtime/bwrap', bash: '/runtime/bash' };
  const expected = { runtime, runtimePins: Object.values(runtime).map(path => ({ path, sha256: 'c'.repeat(64) })),
    protectedValues: [TOKEN], proxyCapabilitySha256: 'd'.repeat(64) };
  for (const executablePath of Object.values(runtime)) {
    const observed = { executablePath, executableSha256: 'e'.repeat(64), argv: [executablePath, 'controlled'] };
    const changed = sandbox.classifyLinuxAuditSnapshot(observed, expected);
    assert.equal(changed.argumentsResult.clean, true); assert.equal(changed.proxy, null);
    assert.equal(changed.reason, 'executable-changed');
    const clean = sandbox.classifyLinuxAuditSnapshot({ ...observed, executableSha256: 'c'.repeat(64) }, expected);
    assert.equal(clean.reason, undefined); assert.equal(clean.argumentsResult.clean, true); assert.equal(clean.proxy.clean, true);
    const leaked = sandbox.classifyLinuxAuditSnapshot({ ...observed, executableSha256: 'c'.repeat(64), argv: [executablePath, TOKEN] }, expected);
    assert.equal(leaked.argumentsResult.clean, false);
  }
});

test('the deciding Linux version result reads proof after the final coverage receipt', t => {
  // A separate process replaces only platform facilities. The actual version-probe
  // orchestration runs unchanged; this proves ordering, not OS/client admission.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-version-final-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = join(root, 'version-final.mjs');
  writeFileSync(fixture, `import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';import {PassThrough} from 'node:stream';
    import {mkdirSync} from 'node:fs';import {join} from 'node:path';
    const target=process.argv[2],root=process.argv[3];
    const mocks={
      './collector.mjs':'export const createClaudeCollector=()=>globalThis.fixture.collector;',
      './linux-platform.mjs':'export const resolveLinuxPlatform=async()=>({status:"ready",pins:[],runtime:{node:process.execPath,client:process.execPath},libraryClosure:[]});export const windowsPolicyDirectoryFromMounts=()=>null;',
      './managed-policy.mjs':'export const observeLinuxManagedPolicy=()=>({outcome:"file-sources-clear"});',
      './linux-runtime.mjs':'export const verifyLinuxVendorClosure=()=>({status:"ready",pins:[],treeSha256:"a".repeat(64)});',
      './linux-sandbox.mjs':'export const linuxObserverPins=()=>[];export const prepareLinuxSandboxContext=async()=>({status:"ready",context:globalThis.fixture.context});'
    };
    registerHooks({resolve(specifier,context,next){
      if(context.parentURL===target && mocks[specifier])return {url:'data:text/javascript,'+encodeURIComponent(mocks[specifier]),shortCircuit:true};
      return next(specifier,context);
    }});
    const {resolveLinuxNativeClient}=await import(target);
    for(const mode of ['leak','gap','changed','clean']){
      const path=join(root,mode);mkdirSync(path);const cell={path,home:path,scratch:path,project:path};
      let clean=true,terminated=0,exit;const exited=new Promise(resolve=>{exit=resolve});
      const handle={pid:1234,argv:[],stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exited,track:async()=>{}};
      globalThis.fixture={collector:{start:async()=>({endpoint:'controlled'}),cancel:async()=>{}},context:{
        createPipe:async()=>({status:'ready'}),start:async()=>{setImmediate(()=>{handle.stdout.end('2.1.285 (Claude Code)\\n');exit({code:0});});return {status:'started',handle};},
        versionProbeReady:()=>clean,isolationRecord:()=>({argumentsClean:clean}),
        get failureReason(){return mode==='changed' && terminated ? 'executable-changed':undefined;},
        terminate:async()=>{terminated++;clean=mode==='clean';return {processes:'confirmed',survivors:[],auditCoverage:clean};}
      }};
      const result=await resolveLinuxNativeClient({definition:{id:'controlled',platform:{execution:'native'},versionArgv:['--version'],sessionArgv:[]},
        input:{deadline:performance.now()+5000},client:{path:process.execPath,sha256:'a'.repeat(64)},cell,check:()=>{}});
      assert.equal(terminated,1,'one aggregate cleanup');
      if(mode==='clean')assert.equal(result.status,'resolved');
      else {assert.equal(result.outcome,'unavailable',mode+' must not use the pre-cleanup proof');
        assert.equal(result.reason,mode==='changed'?'executable-changed':'isolation-unobserved');}
    }
    console.log('VERSION_FINAL_RECEIPT_PASS');`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [fixture, new URL('../../src/harness/native/linux-client.mjs', import.meta.url).href, root],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /VERSION_FINAL_RECEIPT_PASS/);
});

test('the bound client is audited before resume and overlapping live audits share one observation', async () => {
  const refused = await authenticated({ inspect: [true, false] });
  refused.socket.send(probes()); await waitFor(() => refused.socket.sent.length === 2, 'start');
  refused.socket.send({ type: 'client', pid: 9 }); await settle();
  assert.equal(refused.socket.sent.length, 2);
  assert.equal(refused.session.state.violation, true);
  const { session, socket, calls } = await authenticated();
  socket.send(probes()); await waitFor(() => socket.sent.length === 2, 'start');
  socket.send({ type: 'client', pid: 9 }); await waitFor(() => socket.sent.length === 3, 'resume');
  const before = calls.inspect;
  await Promise.all([session.auditArguments(), session.auditArguments(), session.auditArguments()]);
  assert.equal(calls.inspect - before, 1);
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
  const root = realpathSync.native(mkdtempSync(join('/tmp', 'ahb-')));
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
  const root = realpathSync.native(mkdtempSync(join('/tmp', 'ahm-')));
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
async function composition(t, argv, prior) {
  const described = JSON.parse(readFileSync(RUNTIME, 'utf8'));
  const vendor = verifyLinuxVendorClosure(); assert.equal(vendor.status, 'ready');
  const root = prior?.cell.path ?? realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-native-')));
  if (!prior) t.after(() => rmSync(root, { recursive: true, force: true }));
  const cell = prior?.cell ?? { path: root, ...Object.fromEntries(['home', 'project', 'scratch', 'observations'].map(name => [name, join(root, name)])) };
  if (!prior) for (const name of ['home', 'project', 'scratch', 'observations']) mkdirSync(cell[name], { mode: 0o700 });
  const selected = join(cell.project, 'selected.txt'); if (!prior) writeFileSync(selected, 'synthetic', { mode: 0o600 });
  const collector = await probeCollector(t);
  const observerPins = linuxObserverSources.map(name => pin(fileURLToPath(new URL(name, sourceRoot))));
  const input = { cell, runtime: { ...described.runtime, ldLibraryPath: described.ldLibraryPath }, vendor,
    deadline: performance.now() + 60_000, collector, execution: described.execution, selectedPaths: [selected], expectedArgv: argv,
    runtimePins: described.pins, selectedEntries: [] };
  const prepared = await composeLinuxSandbox(input, () => observerPins);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  t.after(() => prepared.context.terminate({ graceMs: 0, deadlineMs: 10_000 }));
  assert.equal((await prepared.context.createPipe()).status, 'ready');
  const evidenceToken = randomBytes(32).toString('hex');
  const started = await prepared.context.start({ file: described.runtime.client, argv, cwd: cell.project, env: {
    PATH: '/usr/bin', HOME: cell.home, TMPDIR: join(cell.scratch, 'tmp'), AIHQ_NATIVE_EVIDENCE_TOKEN: evidenceToken } });
  assert.equal(started.status, 'started', JSON.stringify(started));
  // Real adapters track the outer runner while probes are still running and no client PID exists.
  await started.handle.track();
  return { cell, input, observerPins, context: prepared.context, handle: started.handle, secrets: [collector.token, collector.probeToken, evidenceToken] };
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
  assert.equal(context.versionProbeReady(), false); // final coverage is still pending
  for (const secret of secrets) assert.equal(JSON.stringify(record).includes(secret), false);
  const receipt = await context.terminate({ graceMs: 1000, deadlineMs: 10_000 });
  assert.equal(receipt.processes, 'confirmed', JSON.stringify(receipt));
  assert.equal(receipt.auditCoverage, true, JSON.stringify(receipt));
  assert.equal(context.versionProbeReady(), true);
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

test('sequential sessions retain one immutable base and reject changed or concurrent requests', { ...composed, timeout: 180_000 }, async t => {
  const argv = ['-c', 'read -t 2 _ || true'];
  const first = await composition(t, argv);
  const concurrent = await composeLinuxSandbox(first.input, () => first.observerPins);
  if (concurrent.status === 'ready') t.after(() => concurrent.context.terminate({ graceMs: 0, deadlineMs: 10000 }));
  assert.equal(concurrent.status, 'unavailable');
  await first.handle.exited;
  const firstRecord = first.context.isolationRecord();
  const firstProfileFile = readdirSync(first.cell.observations).find(name => /^d[0-9a-f]+\.json$/.test(name));
  const firstProfile = JSON.parse(readFileSync(join(first.cell.observations, firstProfileFile), 'utf8'));
  const firstResources = readdirSync(first.cell.observations).filter(name => /^[bpw][0-9a-f]+\.(?:json|exe)$/.test(name) || /^l[0-9a-zA-Z]+$/.test(name)).sort();
  assert.equal(first.context.versionProbeReady(), false);
  assert.equal((await first.context.terminate({ graceMs: 0, deadlineMs: 10000 })).processes, 'confirmed');
  assert.equal(first.context.versionProbeReady(), true);
  for (const changed of [
    { selectedPaths: [...first.input.selectedPaths, join(first.cell.project, 'extra.txt')] },
    { runtime: { ...first.input.runtime, readFiles: [...first.input.runtime.readFiles, '/etc/hosts'] } },
    { runtime: { ...first.input.runtime, node: first.input.runtime.bash } },
    { vendor: { ...first.input.vendor, treeSha256: '0'.repeat(64) } }
  ]) assert.equal((await composeLinuxSandbox({ ...first.input, ...changed }, () => first.observerPins)).status, 'unavailable');
  const second = await composition(t, argv, first);
  await second.handle.exited;
  const secondRecord = second.context.isolationRecord();
  const secondProfileFile = readdirSync(first.cell.observations).find(name => /^d[0-9a-f]+\.json$/.test(name));
  const secondProfile = JSON.parse(readFileSync(join(first.cell.observations, secondProfileFile), 'utf8'));
  assert.equal(second.context.versionProbeReady(), false);
  assert.equal(secondRecord.baseSha256, firstRecord.baseSha256);
  assert.notEqual(secondRecord.profileSha256, firstRecord.profileSha256);
  const withoutSlots = profile => ({ ...profile,
    network: { ...profile.network, allowedDomains: profile.network.allowedDomains.filter(value => !/^127\.0\.0\.1:/.test(value)) },
    filesystem: { ...profile.filesystem, allowRead: profile.filesystem.allowRead.filter(value => !value.startsWith(first.cell.observations + '/') ||
      firstResources.some(name => value === join(first.cell.observations, name) || value.startsWith(join(first.cell.observations, name) + '/'))) } });
  assert.deepEqual(withoutSlots(secondProfile), withoutSlots(firstProfile));
  assert.equal((await second.context.terminate({ graceMs: 0, deadlineMs: 10000 })).processes, 'confirmed');
  assert.equal(second.context.versionProbeReady(), true);
  assertNoLeftovers(first.cell);
  assert.deepEqual(readdirSync(first.cell.observations).filter(name => /^[bpw][0-9a-f]+\.(?:json|exe)$/.test(name) || /^l[0-9a-zA-Z]+$/.test(name)).sort(), firstResources);
  const baseFile = join(first.cell.observations, firstResources.find(name => /^b/.test(name)));
  const bytes = readFileSync(baseFile); rmSync(baseFile); writeFileSync(baseFile, bytes, { mode: 0o400 });
  assert.equal((await composeLinuxSandbox({ ...first.input, deadline: performance.now() + 60000 }, () => first.observerPins)).status, 'unavailable');
});

test('a short descendant token leak can never leave a clean argv sub-proof', composed, async t => {
  const { runtime } = JSON.parse(readFileSync(RUNTIME, 'utf8'));
  // Built-in bounded waits keep the leaked helper alive even when native stdin is already at EOF.
  const argv = ['-c', `"${runtime.bash}" -c 'end=$((SECONDS+2)); while ((SECONDS<end)); do :; done' "$AIHQ_NATIVE_EVIDENCE_TOKEN" & end=$((SECONDS+4)); while ((SECONDS<end)); do :; done; wait`];
  const { context, handle, secrets } = await composition(t, argv);
  for (let i = 0; i < 400 && context.isolation() !== 'violated'; i++) {
    await handle.track(); await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(context.isolationRecord().clientBound, true, JSON.stringify(context.isolationRecord()));
  await handle.exited;
  assert.notEqual(context.isolationRecord().argumentsClean, true, JSON.stringify(context.isolationRecord()));
  assert.equal(context.isolation(), 'violated', JSON.stringify(context.isolationRecord()));
  assert.equal(context.versionProbeReady(), false);
  for (const value of secrets) assert.equal(JSON.stringify(context.isolationRecord()).includes(value), false);
  assert.equal((await context.terminate({ graceMs: 0, deadlineMs: 10000 })).processes, 'confirmed');
});

test('a readiness-held live helper token leak is detected and remains a violation', composed, async t => {
  const { runtime } = JSON.parse(readFileSync(RUNTIME, 'utf8'));
  const argv = ['-c', `"${runtime.bash}" -c 'printf "audit-helper-ready\\n"; end=$((SECONDS+15)); while [[ ! -e "$TMPDIR/argv-audit-release" ]] && ((SECONDS<end)); do :; done' "$AIHQ_NATIVE_EVIDENCE_TOKEN" & wait`];
  const { context, handle, cell, secrets } = await composition(t, argv);
  let seen = false, pending = '';
  const ready = new Promise(resolve => handle.stdout.on('data', bytes => {
    pending += bytes.toString(); assert.ok(pending.length <= 256);
    if (pending.includes('audit-helper-ready\n')) { seen = true; resolve(); }
  }));
  await Promise.race([ready, handle.exited]); assert.equal(seen, true);
  for (let i = 0; i < 100 && context.isolation() !== 'violated'; i++) {
    await handle.track(); await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(context.isolation(), 'violated', JSON.stringify(context.isolationRecord()));
  writeFileSync(join(cell.scratch, 'tmp', 'argv-audit-release'), 'release', { mode: 0o600 });
  await handle.exited; assert.equal(context.isolation(), 'violated');
  for (const value of secrets) assert.equal(JSON.stringify(context.isolationRecord()).includes(value), false);
  assert.equal((await context.terminate({ graceMs: 0, deadlineMs: 10000 })).processes, 'confirmed');
});
