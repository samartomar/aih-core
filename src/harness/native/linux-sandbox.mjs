// Fixed composition of the Linux observer, a fresh SRT instance and one owned verification cell.
// This module is internal to the installed adapter; public requests cannot supply this plan.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { canonicalJson, hasExactKeys, parseStrictJson } from './canonical.mjs';
import { prepareLinuxContext } from './linux-facility.mjs';
import { stageLinuxLibraryClosure } from './linux-libraries.mjs';
import { createLinuxCanaries } from './linux-canaries.mjs';
import { createLinuxBaseProfile, deriveLinuxSessionProfile } from './linux-profile.mjs';
import { evaluateLinuxIsolation, inspectLinuxArguments, inspectLinuxProxyCapability, isolationProbeNames, validIsolationProbes } from './linux-isolation.mjs';

const resource = name => fileURLToPath(new URL(name, import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = bytes => randomBytes(bytes).toString('hex');
const unavailable = (reason = 'isolation-unobserved') => ({ status: 'unavailable', reason });
const HEX = /^[a-f0-9]{64}$/;
const ISOLATION_ENTRY = 'aih-native-isolation';
const NAMESPACES = Object.freeze(['pid', 'mount', 'network', 'user']);
const RUNTIME_KEYS = Object.freeze(['node', 'client', 'bash', 'env', 'bwrap', 'socat', 'rg', 'libraries', 'readFiles']);
const CELL_KEYS = Object.freeze(['path', 'home', 'project', 'scratch', 'observations']);
const WSL_MOUNT_FILES = Object.freeze(['/mnt/c/Windows/System32/cmd.exe', '/mnt/d/Windows/System32/cmd.exe']);
const WSL_INTEROP_FILES = Object.freeze(['/init', '/run/WSL', '/proc/sys/fs/binfmt_misc/WSLInterop']);
// Files loaded by processes in the owned tree outside the sandbox profile's own runtime pins.
export const linuxObserverSources = Object.freeze(['canonical.mjs', 'contracts.mjs', 'fixture-data.mjs', 'fixture-metadata.mjs',
  'linux-runner.mjs', 'linux-workload.mjs', 'linux-profile.mjs', 'linux-runtime.mjs', 'linux/runtime-lock.json',
  'linux/interop-canary.cs', 'linux/interop-canary.exe', 'linux/interop-build-record.json', 'linux/facility', 'linux/build-record.json']);
// Host paths the pinned SRT 0.0.78 can leave when its runner is killed before reset(): bwrap's empty
// read-only mount points for absent mandatory-deny names in the working directory. Deepest first.
const VENDOR_MOUNT_POINTS = Object.freeze(['.git/config', '.git/hooks', '.claude/commands', '.claude/agents', '.claude',
  '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json',
  '.vscode', '.idea']);

const ownUid = () => process.getuid?.() ?? 0;
const exists = path => { try { lstatSync(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } };
const hostVisible = paths => paths.filter(path => { try { return exists(path); } catch { return false; } });
const sameNamespaces = (left, right) => NAMESPACES.every(key => typeof left?.[key] === 'string' && left[key] === right?.[key]);
const separatedNamespaces = (peer, host) => NAMESPACES.every(key => typeof peer?.[key] === 'string' && typeof host?.[key] === 'string')
  ? NAMESPACES.every(key => peer[key] !== host[key]) : null;
const sameArgv = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
const equalToken = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const readBounded = (path, maximum) => {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd), named = lstatSync(path);
    if (!before.isFile() || !named.isFile() || named.isSymbolicLink() || before.size > maximum ||
        before.ino !== named.ino || before.dev !== named.dev) throw Error();
    const bytes = Buffer.alloc(before.size + 1); let size = 0, read;
    while (size < bytes.length && (read = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += read;
    const after = fstatSync(fd);
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error();
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
};

export function linuxObserverPins() {
  const record = parseStrictJson(readBounded(resource('linux/observer-lock.json'), 32768).toString('utf8'));
  if (!hasExactKeys(record, ['version', 'files']) || record.version !== 1 || !Array.isArray(record.files) ||
      record.files.length !== linuxObserverSources.length) throw Error();
  return linuxObserverSources.map(name => {
    const rows = record.files.filter(row => row.name === name);
    if (rows.length !== 1 || !hasExactKeys(rows[0], ['name', 'sha256', 'byteLength'])) throw Error();
    const row = rows[0], path = resource(name), bytes = readBounded(path, 8 * 1024 * 1024);
    if (bytes.length !== row.byteLength || sha256(bytes) !== row.sha256) throw Error();
    return { path: realpathSync.native(path), byteLength: bytes.length, sha256: row.sha256 };
  });
}

export function absentVendorMountPoints(project) {
  return VENDOR_MOUNT_POINTS.filter(name => {
    try { lstatSync(join(project, ...name.split('/'))); return false; } catch (error) { return error?.code === 'ENOENT'; }
  });
}

// Remove only names absent before launch that still have exactly bwrap's mount-point shape.
export function sweepVendorMountPoints(project, absent) {
  const uid = ownUid();
  for (const name of VENDOR_MOUNT_POINTS) {
    if (!absent.includes(name)) continue;
    const path = join(project, ...name.split('/'));
    try {
      const stat = lstatSync(path);
      if (stat.uid !== uid) continue;
      if (stat.isFile() && stat.size === 0 && stat.nlink === 1 && (stat.mode & 0o222) === 0) unlinkSync(path);
      else if (stat.isDirectory() && readdirSync(path).length === 0) rmdirSync(path);
    } catch { /* absent or no longer ours: leave exactly as found */ }
  }
}

// The private bridge may hold only the vendor proxy sockets and its empty bind source. Anything else is
// left in place and the bridge is not removed.
export function sweepLinuxBridge(bridge, runnerPid) {
  let names;
  try { names = readdirSync(bridge); } catch (error) { return error?.code === 'ENOENT'; }
  try {
    if (names.length > 8) return false;
    const uid = ownUid();
    for (const name of names) {
      const path = join(bridge, name), stat = lstatSync(path);
      if (stat.uid !== uid) return false;
      if (/^claude-(?:http|socks)-[0-9a-f]{16}\.sock$/.test(name) && stat.isSocket()) unlinkSync(path);
      else if (Number.isSafeInteger(runnerPid) && runnerPid > 0 && name === `srt-mux-${runnerPid}-0.sock` && stat.isSocket()) unlinkSync(path);
      else if (/^claude-empty-[A-Za-z0-9]{6}$/.test(name) && stat.isDirectory() && readdirSync(path).length === 0) rmdirSync(path);
      else return false;
    }
    rmdirSync(bridge);
    return true;
  } catch { return false; }
}

const removeOwnedSocket = path => {
  try { const stat = lstatSync(path); if (stat.isSocket() && stat.uid === ownUid()) unlinkSync(path); } catch { /* already gone */ }
};

// Private probe transcript. Each phase is reached only after the previous one was authenticated by the
// kernel peer identity; nothing the workload claims is trusted alone. Proven access is a violation;
// anything malformed or missing closes the transcript and stays unobservable.
export function createLinuxProbeSession({ token, challenge, entry, hostNamespaces, verifyProfile, inspectArguments, hostCanaries, bindClient }) {
  const proof = { probes: null, authenticated: false, namespaceSeparated: null, profileCompared: false,
    argumentsClean: null, clientBound: false, serverBound: false, interference: false };
  const state = { peer: null, clientPid: null, code: null, ended: false, violation: false, closed: false, connections: 0, interference: false };
  let current = null;
  const close = () => { state.closed = true; current?.destroy(); };
  const violate = () => { state.violation = true; close(); };
  const interfere = () => { state.interference = true; proof.interference = true; };
  const accept = socket => {
    state.connections += 1;
    socket.on('error', () => {});
    if (current || state.closed) { socket.destroy(); return; }
    current = socket;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = Buffer.alloc(0), phase = 'hello', frames = 0, bytes = 0, chain = Promise.resolve();
    const handle = async line => {
      if (state.closed) return;
      if (++frames > 4) return close();
      const message = parseStrictJson(decoder.decode(line));
      if (phase === 'client' && message?.type === 'end') phase = 'end'; // the client could not be started
      if (phase === 'hello') {
        if (!hasExactKeys(message, ['version', 'token', 'pid']) || message.version !== 1 || !equalToken(message.token, token) ||
            !Number.isSafeInteger(message.pid) || message.pid < 1) return close();
        const observed = await socket.observePeer();
        if (observed?.status !== 'observed' || observed.selectedEntryId !== entry.id || observed.namespacePid !== message.pid ||
            observed.executablePath !== entry.executablePath || observed.executableSha256 !== entry.executableSha256 ||
            !sameArgv(observed.argv, entry.argv) || !Number.isSafeInteger(observed.pid) || typeof observed.birth !== 'string') return close();
        state.peer = Object.freeze({ pid: observed.pid, birth: observed.birth,
          namespaces: Object.freeze(Object.fromEntries(NAMESPACES.map(key => [key, observed.namespaces?.[key]]))) });
        proof.authenticated = true;
        proof.namespaceSeparated = separatedNamespaces(observed.namespaces, hostNamespaces);
        if (proof.namespaceSeparated !== true) return proof.namespaceSeparated === false ? violate() : close();
        proof.profileCompared = verifyProfile() === true;
        if (!proof.profileCompared) return close();
        phase = 'probes'; socket.write(JSON.stringify({ type: 'challenge', challenge }) + '\n');
      } else if (phase === 'probes') {
        if (!hasExactKeys(message, ['type', 'challenge', 'probes']) || message.type !== 'probes' ||
            !equalToken(message.challenge, challenge) || !validIsolationProbes(message.probes)) return close();
        const probes = Object.fromEntries(isolationProbeNames.map(key => [key, message.probes[key]]));
        // The host, not the workload, decides whether its own canaries were changed. A write that landed
        // only in the sandbox's private tmpfs never reaches the host and is still a denial.
        const { readIntact, writeAbsent } = hostCanaries();
        probes.outsideWriteDenied = readIntact === false || writeAbsent === false ? false
          : readIntact === true && writeAbsent === true ? true : null;
        proof.probes = Object.freeze(probes);
        proof.argumentsClean = await inspectArguments();
        if (evaluateLinuxIsolation(proof) === 'violated') return violate();
        if (state.interference) return close();
        if (!isolationProbeNames.every(key => probes[key] === true) || proof.argumentsClean !== true) return close();
        phase = 'client'; socket.write('{"type":"start"}\n');
      } else if (phase === 'client') {
        if (!hasExactKeys(message, ['type', 'pid']) || message.type !== 'client' || !Number.isSafeInteger(message.pid) || message.pid < 1) return close();
        state.clientPid = message.pid; phase = 'end';
        if (await bindClient() !== true) return close();
        socket.write('{"type":"resume"}\n');
      } else if (phase === 'end') {
        if (!hasExactKeys(message, ['type', 'code']) || message.type !== 'end' || !Number.isSafeInteger(message.code) ||
            message.code < 0 || message.code > 255) return close();
        // A late refusal (exiting helpers) adds no evidence; only a proven leak changes the result.
        if (await inspectArguments() === false) { proof.argumentsClean = false; return violate(); }
        state.code = message.code; state.ended = true; phase = 'closed';
        socket.write('{"type":"finish"}\n');
      } else close();
    };
    socket.on('data', chunk => {
      if (state.closed) return;
      bytes += chunk.length;
      if (bytes > 8192) return close();
      pending = Buffer.concat([pending, chunk]);
      for (let end; (end = pending.indexOf(10)) >= 0;) {
        const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
        if (line.length > 4096) return close();
        chain = chain.then(() => handle(line)).catch(close);
      }
      if (pending.length > 4096) close();
    });
    socket.on('end', () => { chain = chain.then(() => { if (!state.ended) close(); }); });
  };
  return { proof, state, accept, close, violate, interfere };
}

export function prepareLinuxSandboxContext(input) { return composeLinuxSandbox(input, linuxObserverPins); }

// Internal composition seam: direct tests supply controlled pins of these same source files.
export async function composeLinuxSandbox(input, observerPins) {
  const { cell, runtime, vendor, deadline, signal, collector, execution, selectedPaths, expectedArgv } = input ?? {};
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() === 0 || vendor?.status !== 'ready' ||
      !['native', 'wsl2'].includes(execution) || typeof observerPins !== 'function') return unavailable('platform-unsupported');
  if (signal?.aborted) return unavailable('cancelled');
  if (!(performance.now() < deadline)) return unavailable('deadline');
  let ldLibraryPath = runtime?.ldLibraryPath ?? '';
  // glibc reads an empty LD_LIBRARY_PATH element as the working directory, which is writable here.
  if (!Array.isArray(expectedArgv) || !Array.isArray(selectedPaths) || typeof collector?.endpoint !== 'string' ||
      !HEX.test(collector?.probeToken ?? '') || typeof ldLibraryPath !== 'string' ||
      (ldLibraryPath && !ldLibraryPath.split(':').every(value => value.startsWith('/')))) return unavailable();
  const token = hex(32), challenge = hex(32), suffix = hex(4);
  const file = (prefix, extension = '') => join(cell.observations, `${prefix}${suffix}${extension}`);
  const planFile = file('p', '.json'), baseFile = file('b', '.json'), profileFile = file('d', '.json'), receiptFile = file('r', '.json');
  const workload = resource('linux-workload.mjs'), runner = resource('linux-runner.mjs'), interopHelper = resource('linux/facility');
  const windowsCanary = execution === 'wsl2' ? file('w', '.exe') : null;
  const collectorEndpoint = `${collector.endpoint}/v1/logs`;
  const canaries = { files: null, writes: null, pathname: null, abstract: `aih-native-${hex(12)}`, port: null,
    hostPid: process.pid, mountFiles: execution === 'wsl2' ? hostVisible(WSL_MOUNT_FILES) : [],
    interopFiles: execution === 'wsl2' ? hostVisible(WSL_INTEROP_FILES) : [] };
  const servers = [], sockets = new Set(), ownedFiles = [];
  let context, probeTransport, evidenceTransport, base, receipt, client = null, binding = null, bridge, bridgeCreated = false;
  let absentMounts = null, protectedValues = [], argumentsInspected = 0, started = false, cleanup, clientPin, session;
  let stagedLibraries, libraryReadPaths, outsideCanaries, runnerPid;
  const proxyArguments = { bwrapArguments: 0, shellArguments: 0, unexpectedArguments: 0 };

  const verifyProfile = () => {
    try {
      const current = parseStrictJson(readBounded(receiptFile, 16384).toString('utf8'));
      const serialized = readBounded(profileFile, 65536).toString('utf8');
      if (!hasExactKeys(current, ['slots', 'baseSha256', 'profileSha256', 'proxyCapabilitySha256']) || !HEX.test(current.proxyCapabilitySha256) ||
          !hasExactKeys(current.slots, ['collector', 'evidence', 'probe', 'http', 'socks'])) return false;
      const { slots } = current;
      const ownedBridgeSocket = path => dirname(path) === bridge && lstatSync(path).isSocket() && lstatSync(path).uid === ownUid();
      // Full structure and serialized bytes: the runner's profile must be exactly the fixed derivation.
      if (slots.collector !== collectorEndpoint || slots.evidence !== evidenceTransport?.endpoint || slots.probe !== probeTransport.endpoint ||
          !ownedBridgeSocket(slots.http) || !ownedBridgeSocket(slots.socks) || current.baseSha256 !== sha256(canonicalJson(base)) ||
          current.profileSha256 !== sha256(serialized) || serialized !== canonicalJson(deriveLinuxSessionProfile(base, slots))) return false;
      receipt = { baseSha256: current.baseSha256, profileSha256: current.profileSha256, proxyCapabilitySha256: current.proxyCapabilitySha256 };
      return true;
    } catch { return false; }
  };
  const inspectArguments = async () => {
    const inventory = await context.observe();
    if (inventory?.status !== 'observed' || !Array.isArray(inventory.processes) || inventory.processes.length > 128) return null;
    let inspected = 0, complete = true;
    for (const row of inventory.processes) {
      const observed = await context.inspect(row);
      if (observed?.status !== 'observed') {
        // An exited short-lived helper supplies no observation; any other refusal leaves the proof open.
        if (!['ipc-peer-membership', 'ipc-peer-birth'].includes(observed?.reason)) complete = false;
        continue;
      }
      const result = inspectLinuxArguments(observed.argv, protectedValues);
      if (result.clean === false) return false;
      if (result.clean !== true) complete = false;
      const proxy = inspectLinuxProxyCapability(observed, { sha256: receipt?.proxyCapabilitySha256, bwrap: runtime.bwrap, bash: runtime.bash });
      for (const key of Object.keys(proxyArguments)) proxyArguments[key] += proxy[key];
      if (proxy.clean === false) return false;
      if (proxy.clean !== true) complete = false;
      inspected += result.inspected;
    }
    argumentsInspected += inspected;
    return complete && inspected > 0 ? true : null;
  };
  const bindClient = () => {
    if (session.proof.clientBound) return Promise.resolve(true);
    // The watchdog runs before the workload announces a client. Never memoize that absence.
    if (!session.state.peer || !session.state.clientPid) return Promise.resolve(false);
    return binding ??= (async () => {
    try {
      const peer = session.state.peer, pid = session.state.clientPid;
      if (session.proof.clientBound) return true;
      if (!peer || !pid) return false;
      const inventory = await context.observe();
      if (inventory?.status !== 'observed' || !Array.isArray(inventory.processes)) return false;
      const rows = inventory.processes.filter(row => row.namespacePid === pid && sameNamespaces(row.namespaces, peer.namespaces) &&
        !(row.pid === peer.pid && row.birth === peer.birth));
      if (rows.length !== 1) return false;
      const observed = await context.inspect(rows[0]);
      if (observed?.status !== 'observed' || observed.pid !== rows[0].pid || observed.birth !== rows[0].birth ||
          observed.namespacePid !== pid || !sameNamespaces(observed.namespaces, peer.namespaces) ||
          observed.executablePath !== runtime.client || observed.executableSha256 !== clientPin.sha256 ||
          !sameArgv(observed.argv, [runtime.client, ...expectedArgv])) return false;
      client = Object.freeze({ pid: observed.pid, birth: observed.birth, namespaces: peer.namespaces });
      session.proof.clientBound = true;
      return true;
    } catch { return false; }
    })().then(result => { if (!result) binding = null; return result; });
  };
  const closeResources = async () => {
    for (const socket of sockets) socket.destroy(); sockets.clear();
    await Promise.all(servers.map(server => new Promise(resolve => { if (!server.listening) return resolve(); server.close(() => resolve()); })));
  };
  const removeOwned = () => {
    let confirmed = true;
    for (const path of ownedFiles) { try { unlinkSync(path); } catch { /* cell removal owns regular files */ } }
    if (canaries.pathname) removeOwnedSocket(canaries.pathname);
    if (bridgeCreated && !sweepLinuxBridge(bridge, runnerPid)) confirmed = false;
    stagedLibraries?.remove();
    if (absentMounts) sweepVendorMountPoints(cell.project, absentMounts);
    return outsideCanaries?.remove() !== false && confirmed;
  };
  // One cleanup allowance; leftovers are removed only after the native owner confirms no owned process remains.
  const terminate = (options = {}) => cleanup ??= (async () => {
    const begun = performance.now();
    const budget = Math.min(10000, Math.max(0, Number.isFinite(options.deadlineMs) ? options.deadlineMs : 10000));
    session?.close();
    const closed = closeResources();
    const result = context ? await context.terminate({ graceMs: Number.isFinite(options.graceMs) ? options.graceMs : 1000,
      deadlineMs: Math.max(0, budget - (performance.now() - begun)) }) : { processes: 'confirmed', survivors: [], elapsedMs: 0 };
    await closed;
    if (result.processes === 'confirmed' && !removeOwned()) return { ...result, processes: 'unresolved' };
    return result;
  })();
  const wrapHandle = handle => {
    runnerPid = handle.pid;
    return { pid: handle.pid, birth: handle.birth, argv: [runtime.node, runner, planFile], stdin: handle.stdin, stdout: handle.stdout,
      stderr: handle.stderr, exited: handle.exited, get failure() { return handle.failure; },
      track: async () => { await handle.track(); await bindClient(); }, terminate };
  };
  const acceptServer = async identity => {
    if (!session.proof.authenticated || identity?.status !== 'observed' || !session.state.clientPid) return false;
    if (!session.proof.clientBound) await bindClient();
    const peer = session.state.peer;
    const accepted = session.proof.clientBound && client !== null && sameNamespaces(identity.namespaces, client.namespaces) &&
      typeof identity.selectedEntryId === 'string' && identity.selectedEntryId !== ISOLATION_ENTRY &&
      !(identity.pid === peer.pid && identity.birth === peer.birth) && !(identity.pid === client.pid && identity.birth === client.birth);
    if (accepted) session.proof.serverBound = true;
    return accepted;
  };
  const isolation = () => session.state.violation && session.proof.authenticated ? 'violated' : evaluateLinuxIsolation(session.proof);
  const bind = async target => {
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      session?.interfere(); socket.end('synthetic-host-canary');
    });
    server.maxConnections = 16;
    servers.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(target, resolve); });
    return server;
  };
  try {
    bridge = ['s1', 's2'].map(name => join(cell.observations, name)).find(path => !exists(path));
    if (!bridge) return unavailable();
    const aliases = await (await import('./linux-platform.mjs')).revalidateLinuxLibraryAliases({
      check: () => { if (signal?.aborted || performance.now() >= deadline) throw Error(); } });
    if (aliases.status !== 'ready' || !Array.isArray(runtime.libraryAliasDirectories) ||
        !sameArgv(runtime.libraryAliasDirectories, ['/usr/lib64']) || !Array.isArray(runtime.libraryClosure)) return unavailable();
    for (const member of runtime.libraryClosure) if (!input.runtimePins.some(pin => pin.path === member.source &&
        pin.sha256 === member.sha256 && pin.byteLength === member.byteLength)) throw Error();
    const loader = runtime.libraryClosure.find(member => member.source === '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2');
    if (!loader) throw Error();
    stagedLibraries = stageLinuxLibraryClosure({ directory: cell.observations, closure: runtime.libraryClosure });
    ldLibraryPath = stagedLibraries.directory;
    libraryReadPaths = [...stagedLibraries.pins.map(pin => pin.path), loader.source, ...runtime.libraryAliasDirectories];
    const merged = new Map();
    for (const pin of [...input.runtimePins, ...stagedLibraries.pins, ...vendor.pins, ...observerPins()]) {
      const path = realpathSync.native(pin.path), prior = merged.get(path);
      if (prior && (prior.sha256 !== pin.sha256 || prior.byteLength !== pin.byteLength)) throw Error();
      merged.set(path, { path, sha256: pin.sha256, byteLength: pin.byteLength });
    }
    const node = realpathSync.native(runtime.node), nodePin = merged.get(node);
    clientPin = merged.get(realpathSync.native(runtime.client));
    if (!nodePin || !clientPin || runtime.client !== realpathSync.native(runtime.client)) throw Error();
    const entry = Object.freeze({ id: ISOLATION_ENTRY, executablePath: node, executableSha256: nodePin.sha256, argv: Object.freeze([workload, planFile]) });
    if (signal?.aborted || !(performance.now() < deadline)) throw Error();
    mkdirSync(bridge, { mode: 0o700 }); bridgeCreated = true;
    mkdirSync(join(cell.scratch, 'tmp'), { mode: 0o700, recursive: true });
    const agentRoot = `/run/user/${ownUid()}`, agentStat = lstatSync(agentRoot);
    if (!agentStat.isDirectory() || agentStat.isSymbolicLink() || agentStat.uid !== ownUid() || (agentStat.mode & 0o077) !== 0) throw Error();
    outsideCanaries = createLinuxCanaries({ home: homedir(), sibling: dirname(cell.path), temporary: tmpdir(),
      provisioner: cell.observations, agent: agentRoot });
    Object.assign(canaries, { files: outsideCanaries.files, writes: outsideCanaries.writes, pathname: outsideCanaries.pathname });
    if (windowsCanary) {
      copyFileSync(resource('linux/interop-canary.exe'), windowsCanary, 1 /* COPYFILE_EXCL */); ownedFiles.push(windowsCanary);
      chmodSync(windowsCanary, 0o700); // a non-executable canary would make an EACCES refusal meaningless
    }
    await bind({ path: canaries.pathname }); await bind({ path: '\0' + canaries.abstract });
    canaries.port = (await bind({ host: '127.0.0.1', port: 0 })).address().port;
    const prepared = await prepareLinuxContext({ directory: cell.observations, deadline, signal, runtimePins: [...merged.values()],
      selectedEntries: [...input.selectedEntries, { ...entry, argv: [...entry.argv] }] });
    if (prepared.status !== 'ready') {
      await closeResources();
      return removeOwned() ? prepared : { ...prepared, cleanup: { confirmed: false, survivors: [] } };
    }
    context = prepared.context;
    session = createLinuxProbeSession({ token, challenge, entry, hostNamespaces: context.hostNamespaces, verifyProfile, inspectArguments,
      bindClient, hostCanaries: () => outsideCanaries.snapshot() });
    const channel = await context.createPipe();
    if (channel.status !== 'ready') throw Error();
    probeTransport = channel.transport;
    probeTransport.onConnection(socket => session.accept(socket));
    return { status: 'ready', context: {
      async createPipe() {
        if (evidenceTransport) return unavailable();
        const created = await context.createPipe();
        if (created.status === 'ready') evidenceTransport = created.transport;
        return created;
      },
      async start({ file: executable, argv, cwd, env, protectedValues: additional = [] } = {}) {
        if (started || !evidenceTransport || executable !== runtime.client || cwd !== cell.project || !sameArgv(argv, expectedArgv) ||
            !env || typeof env !== 'object' || !Array.isArray(additional)) return unavailable('session-launch-failed');
        started = true;
        let serialized;
        try {
          absentMounts = absentVendorMountPoints(cell.project);
          const profileRuntime = Object.fromEntries(RUNTIME_KEYS.map(key => [key, runtime[key]]));
          profileRuntime.libraries = libraryReadPaths;
          profileRuntime.readFiles = [...runtime.readFiles, ...(windowsCanary ? [windowsCanary, interopHelper] : [])];
          const profileInput = { cell: Object.fromEntries(CELL_KEYS.map(key => [key, cell[key]])), runtime: profileRuntime,
            workload, plan: planFile, selectedPaths: [...selectedPaths] };
          base = createLinuxBaseProfile(profileInput);
          serialized = canonicalJson({ version: 1, profileInput, cell: profileInput.cell, runtime: profileRuntime, which: runtime.which, ldLibraryPath,
            vendorEntry: vendor.entry, vendorTreeSha256: vendor.treeSha256, execution, argv: [...expectedArgv], workload, windowsCanary, interopHelper,
            bridge, baseFile, profileFile, receiptFile, collector: collectorEndpoint, evidence: evidenceTransport.endpoint,
            probe: probeTransport.endpoint, canaries, selectedPaths: profileInput.selectedPaths });
          if (Buffer.byteLength(serialized) > 65536) return unavailable('session-launch-failed');
          writeFileSync(baseFile, canonicalJson(base), { flag: 'wx', mode: 0o600 });
          writeFileSync(planFile, serialized, { flag: 'wx', mode: 0o600 });
        } catch { return unavailable('session-launch-failed'); }
        protectedValues = [...additional, token, challenge, collector.probeToken, collector.token, env.AIHQ_NATIVE_EVIDENCE_TOKEN]
          .filter(value => typeof value === 'string' && value.length > 0);
        const launched = await context.start({ file: runtime.node, argv: [runner, planFile], cwd, env: {
          ...env, AIHQ_NATIVE_SANDBOX_PLAN_SHA256: sha256(serialized), AIHQ_NATIVE_ISOLATION_TOKEN: token,
          AIHQ_NATIVE_COLLECTOR_PROBE: collector.probeToken, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', LANG: 'C', LC_ALL: 'C',
          ...(ldLibraryPath ? { LD_LIBRARY_PATH: ldLibraryPath } : {}) } });
        if (launched?.status !== 'started') return launched?.partial ? { ...launched, partial: wrapHandle(launched.partial) } : launched;
        return { status: 'started', handle: wrapHandle(launched.handle) };
      },
      acceptServer,
      isolation,
      isolationRecord() {
        const { proof, state } = session;
        return { version: 1, baseSha256: receipt?.baseSha256, profileSha256: receipt?.profileSha256, proxyArguments: { ...proxyArguments }, compared: proof.profileCompared, probes: proof.probes ? { ...proof.probes } : null,
          authenticated: proof.authenticated, namespaceSeparated: proof.namespaceSeparated, clientBound: proof.clientBound,
          serverBound: proof.serverBound, argumentsClean: proof.argumentsClean, argumentsInspected, ended: state.ended, outcome: isolation() };
      },
      versionProbeReady() {
        const { proof, state } = session;
        return proof.authenticated && proof.clientBound && proof.profileCompared && proof.namespaceSeparated === true && proof.argumentsClean === true &&
          validIsolationProbes(proof.probes) && isolationProbeNames.every(key => proof.probes[key] === true) && state.ended && !state.violation && !state.interference;
      },
      terminate
    } };
  } catch {
    const result = await terminate({ graceMs: 0, deadlineMs: 10000 });
    return { ...unavailable(), cleanup: { confirmed: result.processes === 'confirmed', survivors: result.survivors } };
  }
}
