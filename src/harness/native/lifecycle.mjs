// Process lifecycle helpers. windows-job.v1 delegates to the fixed shipped Windows facility.
// posix-group.v1 tracks PID+birth identities of the owned tree and
// only signals a PID whose birth identity still matches; it never signals a reused PID.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter as posixDelimiter, isAbsolute, join, posix, win32 } from 'node:path';
import { nativeBounds } from './contracts.mjs';
import { prepareWindowsContext, windowsAvailability } from './windows-facility.mjs';

export async function lifecycleAvailability(lifecycleId, os, bounds = {}) {
  if (lifecycleId === 'posix-group.v1' && (os === 'linux' || os === 'darwin')) return { status: 'available' };
  if (lifecycleId === 'windows-job.v1' && os === 'win32') return windowsAvailability(bounds);
  return { status: 'unavailable', reason: 'platform-unsupported' };
}

// /proc/<pid>/stat: "pid (comm) state ppid pgrp session ... starttime(22nd field)".
export function parseProcStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 1 || close < open) return null;
  const rest = text.slice(close + 2).trim().split(' ');
  const pid = Number(text.slice(0, open).trim());
  if (rest.length < 20 || !Number.isSafeInteger(pid)) return null;
  const [ppid, pgrp, session] = [Number(rest[1]), Number(rest[2]), Number(rest[3])];
  if (![ppid, pgrp, session].every(Number.isSafeInteger) || !/^\d+$/.test(rest[19])) return null;
  return { pid, ppid, pgrp, session, startTicks: rest[19] };
}

export function parsePsTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgrp: Number(match[3]), session: null, birth: match[4] });
  }
  return rows;
}

// Members of the owned tree: the group plus every transitive child, including setsid children.
export function treeMembers(table, rootPid) {
  const members = new Map(table.filter(entry => entry.pgrp === rootPid).map(entry => [entry.pid, entry]));
  if (!members.size && !table.some(entry => entry.pid === rootPid)) return [];
  const root = table.find(entry => entry.pid === rootPid);
  if (root) members.set(root.pid, root);
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of table)
      if (!members.has(entry.pid) && members.has(entry.ppid)) { members.set(entry.pid, entry); grew = true; }
  }
  return [...members.values()];
}

let bootId = null;
function readTable(os) {
  if (os === 'linux') {
    bootId ??= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const rows = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = parseProcStat(readFileSync(`/proc/${name}/stat`, 'utf8'));
        if (stat) rows.push({ pid: stat.pid, ppid: stat.ppid, pgrp: stat.pgrp, session: stat.session, birth: `${bootId}:${stat.startTicks}` });
      } catch { /* the process ended while reading */ }
    }
    return rows;
  }
  return parsePsTable(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }).toString());
}
const birthOfPid = (pid, os) => readTable(os).find(entry => entry.pid === pid)?.birth ?? null;

export function signalIfSame(pid, birth, signal, deps) {
  if (deps.birthOf(pid) !== birth) return 'reused-or-gone';
  try { deps.kill(pid, signal); } catch { return 'reused-or-gone'; }
  return 'signalled';
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function createPosixHandle(child, os) {
  const tracked = new Map(); // pid -> {birth, pgrp, session}
  const root = { pid: child.pid, birth: null };
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const snapshot = () => {
    const table = readTable(os);
    const members = [...treeMembers(table, child.pid), ...table.filter(entry => entry.session === child.pid)];
    for (const member of members) if (!tracked.has(member.pid) || tracked.get(member.pid).birth !== member.birth)
      tracked.set(member.pid, { birth: member.birth, pgrp: member.pgrp, session: member.session });
    return { table, members };
  };
  const live = () => {
    const table = readTable(os);
    const survivors = [];
    for (const [pid, info] of tracked) {
      const current = table.find(entry => entry.pid === pid);
      if (current && current.birth === info.birth) survivors.push(pid);
    }
    return survivors;
  };
  const deps = { birthOf: pid => birthOfPid(pid, os), kill: (pid, signal) => process.kill(pid, signal) };
  const sendAll = signal => { for (const [pid, info] of tracked) signalIfSame(pid, info.birth, signal, deps); };
  try { root.birth = birthOfPid(child.pid, os); snapshot(); } catch { /* terminate reports unresolved */ }
  const timer = setInterval(() => { try { snapshot(); } catch { /* best effort */ } }, 100);
  timer.unref();
  return {
    pid: child.pid, birth: root.birth, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited,
    track: async () => { snapshot(); },
    async terminate({ graceMs = nativeBounds.killGraceMs, deadlineMs = nativeBounds.cleanupAllowanceMs } = {}) {
      const started = Date.now();
      const remaining = () => Math.max(0, deadlineMs - (Date.now() - started));
      try { child.stdin?.end(); } catch { /* already closed */ }
      let observable = true;
      const settle = async limit => {
        const until = Date.now() + Math.min(limit, remaining());
        while (Date.now() < until) {
          try { snapshot(); if (!live().length) return true; } catch { observable = false; return false; }
          await wait(50);
        }
        try { return live().length === 0; } catch { observable = false; return false; }
      };
      try { snapshot(); sendAll('SIGTERM'); } catch { observable = false; }
      let gone = observable && await settle(graceMs);
      if (!gone && observable) {
        try { snapshot(); sendAll('SIGKILL'); } catch { observable = false; }
        gone = observable && await settle(remaining());
      }
      clearInterval(timer);
      let survivors = [];
      try { survivors = live(); } catch { observable = false; }
      // Sampling cannot rule out a double-fork/setsid escape between snapshots. Observed processes
      // are stopped, but the whole owned tree is not proven gone without an OS containment facility.
      return { processes: 'unresolved',
        survivors: survivors.slice(0, nativeBounds.survivors).map(pid => ({ pid, role: pid === child.pid ? 'client' : 'helper' })),
        elapsedMs: Date.now() - started };
    }
  };
}

// Start the owned process. No shell, own process group, nothing inherited beyond the supplied env.
export async function startLifecycle({ lifecycleId, os, file, argv, cwd, env, deadline, signal, context }) {
  if (context) return context.start({ file, argv, cwd, env });
  if (lifecycleId === 'windows-job.v1' && os === 'win32' && process.platform === 'win32') {
    let pin;
    try { const path = realpathSync.native(file); pin = { path, sha256: await hashFile(path), byteLength: statSync(path).size }; }
    catch { return { status: 'unavailable', reason: 'session-launch-failed' }; }
    const prepared = await prepareWindowsContext({ deadline, signal, runtimePins: [pin] });
    if (prepared.status !== 'ready') return prepared;
    const started = await prepared.context.start({ file: pin.path, argv, cwd, env });
    if (started.status !== 'started' && !started.partial) {
      const cleanup = await prepared.context.terminate({ graceMs: 0 });
      return { ...started, cleanup: { confirmed: cleanup.processes === 'confirmed', survivors: cleanup.survivors }, cleanupStartedAt: cleanup.cleanupStartedAt };
    }
    return started;
  }
  const available = await lifecycleAvailability(lifecycleId, os, { deadline, signal });
  if (available.status !== 'available') return { status: 'unavailable', reason: available.reason };
  if (os !== process.platform) return { status: 'unavailable', reason: 'platform-unsupported' };
  return new Promise(resolve => {
    let child;
    try { child = spawn(file, argv, { cwd, env, shell: false, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return resolve({ status: 'unavailable', reason: 'session-launch-failed' }); }
    child.once('error', () => resolve({ status: 'unavailable', reason: 'session-launch-failed' }));
    child.once('spawn', () => resolve({ status: 'started', handle: createPosixHandle(child, os) }));
  });
}

export async function prepareLifecycleContext(input) {
  if (input.lifecycleId === 'windows-job.v1' && input.os === 'win32') return prepareWindowsContext(input);
  return { status: 'unavailable', reason: 'platform-unsupported' };
}

const SHELL_SHIMS = /\.(cmd|bat|ps1|com)$/i;

// Resolve the client once from an explicit PATH value and pin its bytes. Absolute PATH entries only.
export async function pinExecutable({ names, pathEnv, platform }) {
  const pathLib = platform === 'win32' ? win32 : posix;
  const separator = platform === 'win32' ? ';' : posixDelimiter;
  for (const directory of String(pathEnv ?? '').split(separator)) {
    if (!directory || !pathLib.isAbsolute(directory) && !isAbsolute(directory)) continue;
    for (const name of names) {
      if (SHELL_SHIMS.test(name)) continue;
      try {
        const candidate = join(directory, name);
        if (!lstatSync(candidate).isFile() && !lstatSync(candidate).isSymbolicLink()) continue;
        const real = realpathSync.native(candidate);
        const stat = statSync(real);
        if (!stat.isFile()) continue;
        return { status: 'pinned', path: real, sha256: await hashFile(real), byteLength: stat.size };
      } catch { /* try the next candidate */ }
    }
  }
  return { status: 'unavailable', reason: 'client-absent' };
}

const hashFile = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});

export async function revalidateExecutable(pin) {
  try {
    const stat = statSync(pin.path);
    if (!stat.isFile() || stat.size !== pin.byteLength || await hashFile(pin.path) !== pin.sha256)
      return { ok: false, reason: 'executable-changed' };
    return { ok: true };
  } catch { return { ok: false, reason: 'executable-changed' }; }
}
