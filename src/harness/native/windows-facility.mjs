// Fixed Windows Job/pipe bridge. Protocol data is private and never logged.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, win32 } from 'node:path';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';

const resource = name => fileURLToPath(new URL(`./windows/${name}`, import.meta.url));
const unavailable = (reason = 'platform-unsupported') => ({ status: 'unavailable', reason });
const FRAME = 1_048_576, CHUNK = 16_384;
const windowsTransports = new WeakSet();
export const isWindowsTransport = transport => transport !== null && typeof transport === 'object' && windowsTransports.has(transport);
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
  if (record.protocol !== 1 || record.platform !== 'win32-x64') throw new Error('resource');
  const pins = record.resources.map(row => ({ path: resource(row.name), sha256: row.sha256, byteLength: row.byteLength }));
  if (pins.length !== 2 || !record.resources.some(row => row.name === 'facility.exe') || !record.resources.some(row => row.name === 'facility.cs')) throw new Error('resource');
  for (const pin of pins) {
    const info = lstatSync(pin.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== pin.byteLength || await digest(pin.path) !== pin.sha256) throw new Error('resource');
  }
  return pins;
}

function normalizedPins(pins) {
  if (!Array.isArray(pins) || pins.length > 120) throw new Error('pins');
  const seen = new Set();
  return pins.map(pin => {
    if (!pin || !isAbsolute(pin.path) || !/^[a-f0-9]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.byteLength) || pin.byteLength < 0) throw new Error('pins');
    const path = realpathSync.native(pin.path), key = path.toLowerCase();
    if (seen.has(key)) throw new Error('pins'); seen.add(key);
    return { path, sha256: pin.sha256, byteLength: pin.byteLength };
  });
}

async function launchBridge({ deadline, signal } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') return unavailable();
  deadline = until(deadline);
  if (signal?.aborted || !remaining(deadline)) return unavailable(signal?.aborted ? 'cancelled' : 'deadline');
  let pins;
  try { pins = await resourcePins(); } catch { return unavailable('helper-changed'); }
  if (signal?.aborted || !remaining(deadline)) return unavailable(signal?.aborted ? 'cancelled' : 'deadline');
  let helper;
  try { helper = spawn(resource('facility.exe'), [], { shell: false, windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { return { ...unavailable('windows-facility-failed'), cleanup: { confirmed: false, survivors: [] }, cleanupStartedAt: performance.now() }; }
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
  // Cancellation stops the Job immediately but leaves the observer alive for active-zero cleanup.
  // A stuck/lost observer is killed after the one bounded cleanup allowance and remains unresolved.
  const stopOperation = reason => {
    if (dead || stopped) return;
    stopped = reason; markCleanup(); readyResolve(false); clearTimeout(timer);
    timer = setTimeout(() => kill('cleanup-timeout'), 10000);
    const id = ++next, requestTimer = setTimeout(() => kill('cleanup-timeout'), 10000);
    requests.set(id, { resolve() {}, timer: requestTimer });
    helper.stdin.write(`${JSON.stringify({ id, op: 'cancel' })}\n`, error => { if (error) kill('windows-facility-failed'); });
  };
  let timer = setTimeout(() => stopOperation('deadline'), Math.max(1, remaining(deadline)));
  const aborted = () => stopOperation('cancelled'); signal?.addEventListener('abort', aborted, { once: true });
  helper.once('error', () => kill('windows-facility-failed'));
  helper.once('exit', () => { helperExited = true; });
  helper.once('close', () => { closeObserved = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); fault('windows-facility-failed'); closeResolve(); });
  helper.stdin.on('error', () => kill('windows-facility-failed'));
  // stderr is never surfaced; even unexpected diagnostics have a fixed byte bound.
  let stderrBytes = 0; helper.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 4096) kill('windows-facility-failed'); });
  helper.stdout.on('data', bytes => {
    if (dead) return;
    pending = Buffer.concat([pending, bytes]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) { if (pending.length > FRAME) kill('windows-facility-failed'); break; }
      if (end > FRAME) { kill('windows-facility-failed'); break; }
      let message;
      try { message = JSON.parse(pending.subarray(0, end).toString('utf8')); } catch { kill('windows-facility-failed'); break; }
      pending = pending.subarray(end + 1);
      if (message.type === 'ready') { if (message.value?.protocol !== 1) kill('windows-facility-failed'); else readyResolve(true); }
      else if (Number.isSafeInteger(message.id)) {
        const request = requests.get(message.id);
        if (!request) { kill('windows-facility-failed'); break; }
        requests.delete(message.id); clearTimeout(request.timer); request.resolve(message.result);
      } else if (typeof message.type === 'string') { if (message.type === 'fault') markCleanup(); for (const listener of listeners) listener(message); }
      else { kill('windows-facility-failed'); break; }
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
    kill(stopped ?? failure ?? 'windows-facility-failed');
    return { ...unavailable(stopped ?? failure ?? 'windows-facility-failed'), ...await finish(1000) };
  }
  const rpc = (op, fields = {}, timeout = remaining(deadline)) => new Promise(resolve => {
    if (stopped && !['terminate', 'pipe-close', 'pipe-stop', 'input-end'].includes(op)) { resolve(unavailable(stopped)); return; }
    if (dead || timeout <= 0) { resolve(unavailable(failure ?? 'deadline')); return; }
    const id = ++next, text = JSON.stringify({ ...fields, op, id });
    if (Buffer.byteLength(text) > FRAME) { resolve(unavailable('input-limit')); return; }
    if (requests.size >= 256) { kill('windows-facility-failed'); resolve(unavailable('input-limit')); return; }
    const timer = setTimeout(() => { const request = requests.get(id); if (request) request.resolve = () => {}; stopOperation('deadline'); resolve(unavailable('deadline')); }, Math.max(1, timeout));
    requests.set(id, { resolve, timer });
    helper.stdin.write(`${text}\n`, error => { if (error) kill('windows-facility-failed'); });
  });
  return { status: 'ready', pins, rpc, onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    get failed() { return failure; },
    get cleanupStartedAt() { return cleanupStartedAt; },
    // Cleanup replaces the operation deadline/abort listener with its own bounded allowance.
    beginCleanup(milliseconds) { markCleanup(); clearTimeout(timer); signal?.removeEventListener('abort', aborted); return setTimeout(() => kill('cleanup-timeout'), Math.max(1, milliseconds)); },
    finish, kill };
}

export async function windowsAvailability(options = {}) {
  const bridge = await launchBridge({ ...options, deadline: Number.isFinite(options.deadline) ? options.deadline : performance.now() + 5000 });
  if (bridge.status !== 'ready') return { ...bridge, missing: 'windows-job.v1' };
  const result = await bridge.rpc('probe');
  const closure = await bridge.finish(1000);
  return { ...(result.status === 'available' && closure.cleanup.confirmed ? result : unavailable('windows-facility-failed')), ...closure };
}

export async function prepareWindowsContext({ directory, deadline, signal, runtimePins = [], selectedEntries = [] } = {}) {
  deadline = until(deadline);
  let pins, entries;
  try {
    pins = normalizedPins(runtimePins);
    if (!Array.isArray(selectedEntries) || selectedEntries.length > 8) throw new Error('entries');
    entries = selectedEntries.map(entry => {
      if (!entry || typeof entry.id !== 'string' || !Array.isArray(entry.argv) || !entry.argv.length || !isAbsolute(entry.argv[0])) throw new Error('entry');
      const executablePath = realpathSync.native(entry.executablePath);
      if (!pins.some(pin => pin.path.toLowerCase() === executablePath.toLowerCase() && pin.sha256 === entry.executableSha256) || !pins.some(pin => pin.path === entry.argv[0])) throw new Error('entry');
      return { id: entry.id, executablePath, executableSha256: entry.executableSha256, argv: [...entry.argv] };
    });
    if (directory !== undefined && (!isAbsolute(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error('directory');
  } catch { return unavailable('runtime-changed'); }
  const bridge = await launchBridge({ deadline, signal });
  if (bridge.status !== 'ready') return bridge;
  const allPins = [...pins];
  for (const pin of bridge.pins) if (!allPins.some(row => row.path.toLowerCase() === pin.path.toLowerCase())) allPins.push(pin);
  const initialized = await bridge.rpc('init', { deadlineMs: Math.max(1, remaining(deadline)), runtimePins: allPins, selectedEntries: entries });
  if (initialized.status !== 'ready') return { ...initialized, ...await bridge.finish(1000) };
  const stdout = new PassThrough(), stderr = new PassThrough(), peers = new Map(), connectionListeners = new Set();
  let root = null, exitResolve, cleanup = null, transport = null, processFailure = null;
  const exited = new Promise(resolve => { exitResolve = resolve; });
  const writeChunks = async (op, bytes, fields = {}) => {
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const result = await bridge.rpc(op, { ...fields, data: bytes.subarray(offset, offset + CHUNK).toString('base64') });
      if (!result.ok) throw new Error('windows-facility-failed');
    }
  };
  const stdin = new Writable({ write(bytes, encoding, callback) { writeChunks('input', bytes).then(() => callback(), () => callback(new Error('windows-facility-failed'))); },
    final(callback) { bridge.rpc('input-end').then(result => callback(result.ok ? null : new Error('windows-facility-failed'))); } });
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
      const id = value.id;
      const socket = new Duplex({ read() {}, write(bytes, encoding, callback) { writeChunks('pipe-write', bytes, { peer: id }).then(() => callback(), () => callback(new Error('windows-facility-failed'))); },
        final(callback) { bridge.rpc('pipe-close', { peer: id }).then(() => callback()); },
        destroy(error, callback) { peers.delete(id); bridge.rpc('pipe-close', { peer: id }).then(() => callback(error)); } });
      socket.on('error', () => {});
      Object.defineProperty(socket, 'observePeer', { value: async () => {
        if (peers.get(id) !== socket || socket.destroyed) return unavailable('ipc-peer-unavailable');
        const observation = await bridge.rpc('peer', { peer: id });
        return observation.status === 'observed' ? observation : unavailable(/^ipc-peer-(membership|image|command-line|birth|entry)$/.test(observation.reason) ? observation.reason : 'ipc-peer-unavailable');
      }, writable: false, configurable: false });
      peers.set(id, socket); for (const listener of connectionListeners) listener(socket);
    } else if (type === 'pipe-data') peers.get(value.id)?.push(Buffer.from(value.data, 'base64'));
    else if (type === 'pipe-end') { const socket = peers.get(value); peers.delete(value); socket?.push(null); }
    else if (type === 'fault' || type === 'bridge-closed') {
      if (type === 'fault') {
        const reason = typeof value === 'string' ? value : value?.reason;
        if (reason === 'output-limit' || reason === 'pipe-limit') processFailure = Object.freeze({ reason: 'limit-exceeded', limitSource: reason === 'output-limit' ? 'output' : 'pipe',
          ...(Number.isSafeInteger(value?.observedBytes) && value.observedBytes >= 0 ? { observedBytes: value.observedBytes } : {}) });
      }
      if (transport) windowsTransports.delete(transport);
      stdout.end(); stderr.end(); exitResolve({ code: null, signal: null, ...processFailure }); for (const socket of peers.values()) socket.destroy(); peers.clear();
    }
  });
  const context = {
    async createPipe() {
      if (transport || cleanup) return unavailable('windows-facility-failed');
      const result = await bridge.rpc('pipe');
      if (result.status !== 'ready') return result;
      transport = { endpoint: result.endpoint, onConnection(callback) { connectionListeners.add(callback); return () => connectionListeners.delete(callback); },
        async close() { windowsTransports.delete(transport); connectionListeners.clear(); for (const socket of peers.values()) socket.destroy(); peers.clear(); await bridge.rpc('pipe-stop'); } };
      windowsTransports.add(transport);
      Object.freeze(transport);
      return { status: 'ready', transport };
    },
    async start({ file, argv = [], cwd, env = {} }) {
      if (root || cleanup) return unavailable('session-launch-failed');
      let path;
      try { path = realpathSync.native(file); } catch { return unavailable('session-launch-failed'); }
      // The private standalone convenience pins its executable before context creation.
      if (!allPins.some(pin => pin.path.toLowerCase() === path.toLowerCase())) return unavailable('executable-changed');
      const result = await bridge.rpc('start', { file: path, argv, cwd: win32.resolve(cwd), env });
      if (result.status !== 'started') {
        if (root || result.partialPid) { root ??= makeRoot({ pid: result.partialPid }); return { ...result, partial: root }; }
        return result;
      }
      root ??= makeRoot(result);
      return { status: 'started', handle: root };
    },
    terminate({ graceMs = 1000, deadlineMs = 10000 } = {}) {
      if (cleanup) return cleanup;
      cleanup = (async () => {
        if (transport) windowsTransports.delete(transport);
        const start = performance.now(), allowance = Math.min(bound(deadlineMs, 10000, 10000), Math.max(0, 10000 - (start - (bridge.cleanupStartedAt ?? start))));
        // Native stopping must leave time for its receipt and helper closure inside this allowance.
        const nativeBudget = Math.max(0, Math.floor(allowance - Math.min(250, allowance / 4)));
        const cleanupTimer = bridge.beginCleanup(allowance);
        const receipt = await bridge.rpc('terminate', { graceMs: Math.min(nativeBudget, bound(graceMs, 1000, 1000)), deadlineMs: nativeBudget }, allowance);
        clearTimeout(cleanupTimer);
        const closure = await bridge.finish(Math.max(0, allowance - (performance.now() - start)));
        stdout.end(); stderr.end(); for (const socket of peers.values()) socket.destroy(); peers.clear();
        return { processes: receipt.processes === 'confirmed' && closure.cleanup.confirmed ? 'confirmed' : 'unresolved',
          survivors: [...(receipt.survivors ?? []), ...closure.cleanup.survivors], elapsedMs: Math.round(performance.now() - start), cleanupStartedAt: closure.cleanupStartedAt,
          ...(Number.isSafeInteger(receipt.activeProcesses) && receipt.activeProcesses >= 0 ? { activeProcesses: receipt.activeProcesses } : {}) };
      })();
      return cleanup;
    }
  };
  return { status: 'ready', context };
}

export async function windowsCellProtection(options, protect) {
  if (!options || !isAbsolute(options.directory)) return unavailable('cell-protection-unavailable');
  const bridge = await launchBridge(options);
  if (bridge.status !== 'ready') return { ...bridge, reason: 'cell-protection-unavailable' };
  const result = await bridge.rpc(protect ? 'protect' : 'validate', { directory: win32.resolve(options.directory) });
  const closure = await bridge.finish(1000);
  return { ...(result.status === 'protected' && closure.cleanup.confirmed ? result : unavailable('cell-protection-unavailable')), ...closure };
}

export const protectWindowsCell = options => windowsCellProtection(options, true);
export const validateWindowsCell = options => windowsCellProtection(options, false);
