// Fixed Linux subreaper/pidfd/socket bridge. Protocol data is private and never logged.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';

const resource = name => fileURLToPath(new URL(`./linux/${name}`, import.meta.url));
const unavailable = (reason = 'platform-unsupported') => ({ status: 'unavailable', reason });
const FRAME = 1_048_576, CHUNK = 16_384;
const linuxTransports = new WeakSet();
export const isLinuxTransport = transport => transport !== null && typeof transport === 'object' && linuxTransports.has(transport);
const bound = (value, fallback, maximum) => Number.isFinite(value) && value >= 0 ? Math.min(value, maximum) : fallback;
const remaining = deadline => Math.max(0, Math.floor(deadline - performance.now()));
const until = deadline => Number.isFinite(deadline) ? deadline : performance.now() + 30_000;
const digest = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', chunk => hash.update(chunk)).once('error', reject).once('end', () => resolve(hash.digest('hex')));
});

async function resourcePins() {
  const recordStat = lstatSync(resource('build-record.json'));
  if (!recordStat.isFile() || recordStat.isSymbolicLink() || recordStat.size > 65536) throw new Error('resource');
  const record = JSON.parse(readFileSync(resource('build-record.json'), 'utf8'));
  if (record.protocol !== 1 || record.platform !== 'linux-x64') throw new Error('resource');
  const pins = record.resources.map(row => ({ path: resource(row.name), sha256: row.sha256, byteLength: row.byteLength }));
  if (pins.length !== 2 || !record.resources.some(row => row.name === 'facility') || !record.resources.some(row => row.name === 'facility.c')) throw new Error('resource');
  for (const pin of pins) {
    const info = lstatSync(pin.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== pin.byteLength || await digest(pin.path) !== pin.sha256) throw new Error('resource');
  }
  return pins;
}

function normalizedPins(pins) {
  if (!Array.isArray(pins) || pins.length > 2048) throw new Error('pins');
  const seen = new Set();
  let bytes = 0;
  return pins.map(pin => {
    if (!pin || !isAbsolute(pin.path) || !/^[a-f0-9]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.byteLength) || pin.byteLength < 0 || pin.byteLength > 268435456) throw new Error('pins');
    bytes += pin.byteLength; if (bytes > 536870912) throw new Error('pins');
    const path = realpathSync.native(pin.path), key = path;
    if (seen.has(key)) throw new Error('pins'); seen.add(key);
    return { path, sha256: pin.sha256, byteLength: pin.byteLength };
  });
}

async function launchBridge({ deadline, signal } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') return unavailable();
  deadline = until(deadline);
  if (signal?.aborted || !remaining(deadline)) return unavailable(signal?.aborted ? 'cancelled' : 'deadline');
  let pins;
  try { pins = await resourcePins(); } catch { return unavailable('helper-changed'); }
  if (signal?.aborted || !remaining(deadline)) return unavailable(signal?.aborted ? 'cancelled' : 'deadline');
  let helper;
  try { helper = spawn(resource('facility'), [], { shell: false, windowsHide: true, env: { LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { return { ...unavailable('linux-facility-failed'), cleanup: { confirmed: false, survivors: [] }, cleanupStartedAt: performance.now() }; }
  let next = 0, pending = Buffer.alloc(0), dead = false, failure = null, stopped = null, readyResolve, closeResolve;
  let cleanupStartedAt, helperExited = false, closeObserved = false;
  const markCleanup = () => cleanupStartedAt ??= performance.now();
  const requests = new Map(), listeners = new Set();
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const closed = new Promise(resolve => { closeResolve = resolve; });
  const fault = reason => {
    if (dead) return;
    dead = true; failure = reason;
    readyResolve(false);
    for (const { resolve, timer } of requests.values()) { clearTimeout(timer); resolve(unavailable(reason)); }
    requests.clear();
    for (const listener of listeners) listener({ type: 'bridge-closed', value: reason });
  };
  const kill = reason => { markCleanup(); fault(reason); try { helper.kill(); } catch { /* close observation remains required */ } };
  // Cancellation stops owned descendants but leaves the subreaper alive for kernel child receipts.
  // A stuck/lost observer is killed after the one bounded cleanup allowance and remains unresolved.
  const stopOperation = reason => {
    if (dead || stopped) return;
    stopped = reason; markCleanup(); readyResolve(false); clearTimeout(timer);
    timer = setTimeout(() => kill('cleanup-timeout'), 10000);
    const id = ++next, requestTimer = setTimeout(() => kill('cleanup-timeout'), 10000);
    requests.set(id, { resolve() {}, timer: requestTimer });
    helper.stdin.write(`${JSON.stringify({ id, op: 'cancel' })}\n`, error => { if (error) kill('linux-facility-failed'); });
  };
  let timer = setTimeout(() => stopOperation('deadline'), Math.max(1, remaining(deadline)));
  const aborted = () => stopOperation('cancelled'); signal?.addEventListener('abort', aborted, { once: true });
  helper.once('error', () => kill('linux-facility-failed'));
  helper.once('exit', () => { helperExited = true; });
  helper.once('close', () => { closeObserved = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); fault('linux-facility-failed'); closeResolve(); });
  helper.stdin.on('error', () => kill('linux-facility-failed'));
  // stderr is never surfaced; even unexpected diagnostics have a fixed byte bound.
  let stderrBytes = 0; helper.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 4096) kill('linux-facility-failed'); });
  helper.stdout.on('data', bytes => {
    if (dead) return;
    pending = Buffer.concat([pending, bytes]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) { if (pending.length > FRAME) kill('linux-facility-failed'); break; }
      if (end > FRAME) { kill('linux-facility-failed'); break; }
      let message;
      try { message = JSON.parse(pending.subarray(0, end).toString('utf8')); } catch { kill('linux-facility-failed'); break; }
      pending = pending.subarray(end + 1);
      if (message.type === 'ready') { if (message.value?.protocol !== 1) kill('linux-facility-failed'); else readyResolve(true); }
      else if (Number.isSafeInteger(message.id)) {
        const request = requests.get(message.id);
        if (!request) { kill('linux-facility-failed'); break; }
        requests.delete(message.id); clearTimeout(request.timer); request.resolve(message.result);
      } else if (typeof message.type === 'string') { if (message.type === 'fault') markCleanup(); for (const listener of listeners) listener(message); }
      else { kill('linux-facility-failed'); break; }
    }
  });
  const finish = async milliseconds => {
    markCleanup();
    const allowance = Math.min(bound(milliseconds, 1000, 10000), Math.max(0, 10000 - (performance.now() - cleanupStartedAt)));
    if (!dead) helper.stdin.end();
    const stop = setTimeout(() => kill('cleanup-timeout'), Math.max(1, allowance));
    let waitTimer;
    await Promise.race([closed, new Promise(resolve => { waitTimer = setTimeout(resolve, Math.max(1, allowance)); })]);
    clearTimeout(waitTimer); clearTimeout(stop);
    const survivors = [];
    if (!closeObserved && !helperExited && Number.isSafeInteger(helper.pid) && helper.pid > 0) {
      try { if (helper.kill(0)) survivors.push({ pid: helper.pid, role: 'helper' }); } catch { /* the observer cannot establish a survivor */ }
    }
    return { cleanup: { confirmed: closeObserved, survivors }, cleanupStartedAt };
  };
  if (!await ready) {
    kill(stopped ?? failure ?? 'linux-facility-failed');
    return { ...unavailable(stopped ?? failure ?? 'linux-facility-failed'), ...await finish(1000) };
  }
  let cleanupDeadline;
  const rpc = (op, fields = {}, timeout = remaining(cleanupDeadline ?? deadline)) => new Promise(resolve => {
    if (stopped && !['terminate', 'pipe-close', 'pipe-stop', 'input-end',
      ...(cleanupDeadline === undefined ? [] : ['audit-inventory', 'audit-inspect', 'audit-ack'])].includes(op)) { resolve(unavailable(stopped)); return; }
    if (dead || timeout <= 0) { resolve(unavailable(failure ?? 'deadline')); return; }
    const id = ++next, text = JSON.stringify({ ...fields, op, id });
    if (Buffer.byteLength(text) > FRAME) { resolve(unavailable('input-limit')); return; }
    if (requests.size >= 256) { kill('linux-facility-failed'); resolve(unavailable('input-limit')); return; }
    const timer = setTimeout(() => { const request = requests.get(id); if (request) request.resolve = () => {}; stopOperation('deadline'); resolve(unavailable('deadline')); }, Math.max(1, timeout));
    requests.set(id, { resolve, timer });
    helper.stdin.write(`${text}\n`, error => { if (error) kill('linux-facility-failed'); });
  });
  return { status: 'ready', pins, rpc, onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    get failed() { return failure; },
    get cleanupStartedAt() { return cleanupStartedAt; },
    // Cleanup replaces the operation deadline/abort listener with its own bounded allowance.
    beginCleanup(milliseconds) { markCleanup(); cleanupDeadline = Math.min(performance.now() + milliseconds, cleanupStartedAt + 10000); clearTimeout(timer); signal?.removeEventListener('abort', aborted); return setTimeout(() => kill('cleanup-timeout'), Math.max(1, milliseconds)); },
    finish, kill };
}

export async function linuxAvailability(options = {}) {
  const bridge = await launchBridge({ ...options, deadline: Number.isFinite(options.deadline) ? options.deadline : performance.now() + 5000 });
  if (bridge.status !== 'ready') return { ...bridge, missing: 'linux-srt.v1' };
  const result = await bridge.rpc('probe');
  const closure = await bridge.finish(1000);
  return { ...(result.status === 'available' && closure.cleanup.confirmed ? result : unavailable('linux-facility-failed')), ...closure };
}

export async function prepareLinuxContext({ directory, deadline, signal, runtimePins = [], selectedEntries = [] } = {}) {
  deadline = until(deadline);
  if (signal?.aborted || !remaining(deadline)) return unavailable(signal?.aborted ? 'cancelled' : 'deadline');
  if (process.platform !== 'linux' || process.arch !== 'x64') return unavailable();
  let pins, entries;
  try {
    pins = normalizedPins(runtimePins);
    if (!Array.isArray(selectedEntries) || selectedEntries.length > 8) throw new Error('entries');
    entries = selectedEntries.map(entry => {
      if (!entry || typeof entry.id !== 'string' || !Array.isArray(entry.argv) || !entry.argv.length || !isAbsolute(entry.argv[0])) throw new Error('entry');
      const executablePath = realpathSync.native(entry.executablePath);
      if (!pins.some(pin => pin.path === executablePath && pin.sha256 === entry.executableSha256) || !pins.some(pin => pin.path === entry.argv[0])) throw new Error('entry');
      return { id: entry.id, executablePath, executableSha256: entry.executableSha256, argv: [...entry.argv] };
    });
    if (directory !== undefined && (!isAbsolute(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error('directory');
  } catch { return unavailable('runtime-changed'); }
  const bridge = await launchBridge({ deadline, signal });
  if (bridge.status !== 'ready') return bridge;
  const allPins = [...pins];
  for (const pin of bridge.pins) if (!allPins.some(row => row.path === pin.path)) allPins.push(pin);
  const initialized = await bridge.rpc('init', { directory, deadlineMs: Math.max(1, remaining(deadline)), runtimePins: allPins, selectedEntries: entries });
  if (initialized.status !== 'ready') return { ...initialized, ...await bridge.finish(1000) };
  const stdout = new PassThrough(), stderr = new PassThrough(), peers = new Map(), transports = new Map();
  let root = null, exitResolve, cleanup = null, processFailure = null;
  const exited = new Promise(resolve => { exitResolve = resolve; });
  const writeChunks = async (op, bytes, fields = {}) => {
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const result = await bridge.rpc(op, { ...fields, data: bytes.subarray(offset, offset + CHUNK).toString('base64') });
      if (!result.ok) throw new Error('linux-facility-failed');
    }
  };
  const stdin = new Writable({ write(bytes, encoding, callback) { writeChunks('input', bytes).then(() => callback(), () => callback(new Error('linux-facility-failed'))); },
    final(callback) { bridge.rpc('input-end').then(result => callback(result.ok ? null : new Error('linux-facility-failed'))); } });
  // Writes may race normal client exit; errors are represented in cleanup, never unhandled.
  stdin.on('error', () => {});
  const makeRoot = identity => ({ pid: identity.pid, birth: identity.birth ?? null, stdin, stdout, stderr, exited,
    get failure() { return processFailure; },
    track: async () => { await bridge.rpc('track'); }, terminate: options => context.terminate(options) });
  bridge.onEvent(message => {
    const { type, value } = message;
    if (type === 'created') root = makeRoot(value);
    else if (type === 'stdout' || type === 'stderr') (type === 'stdout' ? stdout : stderr).write(Buffer.from(value, 'base64'));
    else if (type === 'stdout-end') stdout.end();
    else if (type === 'stderr-end') stderr.end();
    else if (type === 'exit') exitResolve({ ...value, ...processFailure });
    else if (type === 'connect') {
      const id = value.id, channel = transports.get(value.pipeId);
      if (!channel) { bridge.rpc('pipe-close', { peer: id }); return; }
      const socket = new Duplex({ read() {}, write(bytes, encoding, callback) { writeChunks('pipe-write', bytes, { peer: id }).then(() => callback(), () => callback(new Error('linux-facility-failed'))); },
        final(callback) { bridge.rpc('pipe-close', { peer: id }).then(() => callback()); },
        destroy(error, callback) { peers.delete(id); bridge.rpc('pipe-close', { peer: id }).then(() => callback(error)); } });
      socket.on('error', () => {});
      Object.defineProperty(socket, 'observePeer', { value: async () => {
        if (peers.get(id) !== socket || socket.destroyed) return unavailable('ipc-peer-unavailable');
        const observation = await bridge.rpc('peer', { peer: id });
        return observation.status === 'observed' ? observation : unavailable(/^ipc-peer-(membership|image|command-line|birth|entry)$/.test(observation.reason) ? observation.reason : 'ipc-peer-unavailable');
      }, writable: false, configurable: false });
      peers.set(id, socket); channel.peers.add(id); for (const listener of channel.listeners) listener(socket);
    } else if (type === 'pipe-data') peers.get(value.id)?.push(Buffer.from(value.data, 'base64'));
    else if (type === 'pipe-end') { const socket = peers.get(value); peers.delete(value); socket?.push(null); }
    else if (type === 'fault' || type === 'bridge-closed') {
      if (type === 'fault') {
        const reason = typeof value === 'string' ? value : value?.reason;
        if (reason === 'output-limit' || reason === 'pipe-limit') processFailure = Object.freeze({ reason: 'limit-exceeded', limitSource: reason === 'output-limit' ? 'output' : 'pipe',
          ...(Number.isSafeInteger(value?.observedBytes) && value.observedBytes >= 0 ? { observedBytes: value.observedBytes } : {}) });
      }
      for (const { transport } of transports.values()) linuxTransports.delete(transport);
      stdout.end(); stderr.end(); exitResolve({ code: null, signal: null, ...processFailure }); for (const socket of peers.values()) socket.destroy(); peers.clear();
    }
  });
  const context = {
    hostNamespaces: Object.freeze({ ...initialized.hostNamespaces }),
    async createPipe() {
      if (transports.size >= 2 || cleanup) return unavailable('linux-facility-failed');
      const result = await bridge.rpc('pipe');
      if (result.status !== 'ready') return result;
      const channel = { listeners: new Set(), peers: new Set() };
      const transport = { endpoint: result.endpoint, onConnection(callback) { channel.listeners.add(callback); return () => channel.listeners.delete(callback); },
        async close() { linuxTransports.delete(transport); channel.listeners.clear(); for (const id of channel.peers) peers.get(id)?.destroy(); channel.peers.clear(); await bridge.rpc('pipe-stop', { pipeId: result.pipeId }); } };
      channel.transport = transport; transports.set(result.pipeId, channel);
      linuxTransports.add(transport);
      Object.freeze(transport);
      return { status: 'ready', transport };
    },
    observe() { return bridge.rpc('inventory'); },
    auditInventory() { return bridge.rpc('audit-inventory'); },
    inspectAudit({ pid, birth, generation } = {}) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || typeof birth !== 'string' || !/^[0-9]+$/.test(birth) ||
          !Number.isSafeInteger(generation) || generation < 1) return Promise.resolve(unavailable('ipc-peer-membership'));
      return bridge.rpc('audit-inspect', { pid, birth, generation });
    },
    acknowledgeAudit({ pid, birth, generation } = {}) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || typeof birth !== 'string' || !/^[0-9]+$/.test(birth) ||
          !Number.isSafeInteger(generation) || generation < 1) return Promise.resolve({ ok: false });
      return bridge.rpc('audit-ack', { pid, birth, generation });
    },
    inspect({ pid, birth } = {}) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || typeof birth !== 'string' || !/^[0-9]+$/.test(birth)) return Promise.resolve(unavailable('ipc-peer-membership'));
      return bridge.rpc('inspect', { pid, birth });
    },
    async start({ file, argv = [], cwd, env = {} }) {
      if (root || cleanup) return unavailable('session-launch-failed');
      let path;
      try { path = realpathSync.native(file); } catch { return unavailable('session-launch-failed'); }
      // The private standalone convenience pins its executable before context creation.
      if (!allPins.some(pin => pin.path === path)) return unavailable('executable-changed');
      const result = await bridge.rpc('start', { file: path, argv, cwd: resolve(cwd), env });
      if (result.status !== 'started') {
        if (root || result.partialPid) { root ??= makeRoot({ pid: result.partialPid }); return { ...result, partial: root }; }
        return result;
      }
      root ??= makeRoot(result);
      return { status: 'started', handle: root };
    },
    terminate({ graceMs = 1000, deadlineMs = 10000, audit } = {}) {
      if (cleanup) return cleanup;
      cleanup = (async () => {
        for (const { transport } of transports.values()) linuxTransports.delete(transport);
        const start = performance.now(), allowance = Math.min(bound(deadlineMs, 10000, 10000), Math.max(0, 10000 - (start - (bridge.cleanupStartedAt ?? start))));
        const cleanupTimer = bridge.beginCleanup(allowance);
        // The internal Harness classifier drains retained generations before native stopping.
        // Both the drain and closure share this single allowance; a late generation remains
        // unacknowledged and makes the native final coverage receipt false.
        let auditTimer, auditCompleted = typeof audit !== 'function';
        if (typeof audit === 'function') {
          try { await Promise.race([Promise.resolve().then(audit).then(() => { auditCompleted = true; }), new Promise(resolve => {
            auditTimer = setTimeout(resolve, Math.max(1, allowance));
          })]); } catch { /* coverage receipt still fails closed for pending generations */ }
          finally { clearTimeout(auditTimer); }
        }
        const left = Math.max(0, allowance - (performance.now() - start));
        // Native stopping must leave time for its receipt and helper closure inside this allowance.
        const nativeBudget = Math.max(0, Math.floor(left - Math.min(250, left / 4)));
        const receipt = await bridge.rpc('terminate', { graceMs: Math.min(nativeBudget, bound(graceMs, 1000, 1000)), deadlineMs: nativeBudget }, left);
        clearTimeout(cleanupTimer);
        const closure = await bridge.finish(Math.max(0, allowance - (performance.now() - start)));
        stdout.end(); stderr.end(); for (const socket of peers.values()) socket.destroy(); peers.clear();
        return { processes: receipt.processes === 'confirmed' && closure.cleanup.confirmed ? 'confirmed' : 'unresolved',
          auditCoverage: auditCompleted && receipt.auditCoverage === true,
          survivors: [...(receipt.survivors ?? []), ...closure.cleanup.survivors], elapsedMs: Math.round(performance.now() - start), cleanupStartedAt: closure.cleanupStartedAt,
          ...(Number.isSafeInteger(receipt.activeProcesses) && receipt.activeProcesses >= 0 ? { activeProcesses: receipt.activeProcesses } : {}) };
      })();
      return cleanup;
    }
  };
  return { status: 'ready', context };
}
