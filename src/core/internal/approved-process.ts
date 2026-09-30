import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { sha256 } from './host-files.js';
import { readRegularFileWithStats } from './fsxn.js';
import type { PathPin } from './host-files.js';

export interface ResolvedExecutable { path: string; launchPath: string; pins: PathPin[]; sha256: string }
export interface ProcessResult {
  status: 'passed' | 'failed' | 'unavailable' | 'cancelled'; reason: string;
  exitCode?: number; effectsUncertain: boolean; terminationUnconfirmed: boolean;
}
const WINDOWS_SUFFIX = process.platform === 'win32' ? ['.exe', '.com'] : [''];

// Read-only executable admission has different link rules from mutation targets.
// Pin the selected path and its resolved regular file; never reuse
// these pins to authorize a file write.
function executablePathPins(path: string): PathPin[] {
  const absolute = resolve(path), base = parse(absolute).root;
  let current = base;
  return ['', ...relative(base, absolute).split(/[\\/]/).filter(Boolean)].map(segment => {
    if (segment) current = join(current, segment);
    const stats = lstatSync(current, { bigint: true });
    if (stats.ino === 0n || !stats.isFile() && !stats.isDirectory() && !stats.isSymbolicLink())
      throw new Error('executable-path');
    const link = stats.isSymbolicLink() ? Buffer.from(readlinkSync(current)).toString('hex') : '';
    return { path: current, identity: `executable:${stats.dev}:${stats.ino}:${stats.mode}:${stats.isFile() ? stats.nlink : 0n}:${link}` };
  });
}

export function executablePinsMatch(pins: PathPin[]): boolean {
  return pins.length > 0 && pins.every(pin => {
    try {
      const current = executablePathPins(pin.path).at(-1);
      return current?.path === pin.path && current.identity === pin.identity;
    } catch { return false; }
  });
}

/** Re-resolve the launcher too: lexical pins cannot cover intermediate link targets. */
export function executableIdentityMatches(executable: Pick<ResolvedExecutable, 'path' | 'launchPath' | 'pins'>): boolean {
  try {
    return executablePinsMatch(executable.pins) && realpathSync.native(executable.launchPath) === executable.path;
  } catch { return false; }
}

export function resolveExecutable(name: string): ResolvedExecutable | undefined {
  if (!name || /[\r\n\0]/.test(name)) return undefined;
  const candidates: string[] = [];
  if (isAbsolute(name)) candidates.push(name);
  else if (!/[\\/]/.test(name) && name !== '.' && name !== '..') {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir || !isAbsolute(dir)) continue;
      for (const suffix of WINDOWS_SUFFIX) candidates.push(join(dir, process.platform === 'win32' && !/\.(exe|com)$/i.test(name) ? name + suffix : name));
    }
  }
  for (const path of candidates) {
    if (process.platform === 'win32' && !/\.(exe|com)$/i.test(path)) continue;
    try {
      accessSync(path, constants.X_OK);
      const resolved = realpathSync.native(path);
      const pins = [...executablePathPins(path), ...executablePathPins(resolved)];
      const captured = readRegularFileWithStats(resolved, { maxBytes: 512 * 1024 * 1024 });
      const current = lstatSync(resolved, { bigint: true });
      if (captured && current.isFile() && captured.identity.dev === current.dev && captured.identity.ino === current.ino &&
          realpathSync.native(path) === resolved && executablePinsMatch(pins))
        return { path: resolved, launchPath: resolve(path), pins, sha256: sha256(captured.contents) };
    } catch { /* Try the next explicit PATH candidate. */ }
  }
  return undefined;
}

export async function runApprovedProcess(request: {
  executable: ResolvedExecutable; args: string[]; cwd: string; env: Record<string, string>;
  stdin?: string; timeoutMs: number; maxOutputBytes: number; acceptedExitCodes: number[];
  signal?: AbortSignal;
}): Promise<ProcessResult> {
  if (request.signal?.aborted) return { status: 'cancelled', reason: 'cancelled', effectsUncertain: false, terminationUnconfirmed: false };
  const live = executableIdentityMatches(request.executable) ?
    readRegularFileWithStats(request.executable.path, { maxBytes: 512 * 1024 * 1024 }) : undefined;
  if (!live || sha256(live.contents) !== request.executable.sha256 || !executableIdentityMatches(request.executable))
    return { status: 'unavailable', reason: 'executable-changed', effectsUncertain: false, terminationUnconfirmed: false };
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    let byteCount = 0; let settled = false; let closing = false; let forcedReason: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: ProcessResult['status'], reason: string, exitCode?: number, uncertain = false, unconfirmed = false) => {
      if (settled) return;
      settled = true; if (timeout) clearTimeout(timeout); if (cleanup) clearTimeout(cleanup);
      request.signal?.removeEventListener('abort', abort);
      resolve({ status, reason, ...(exitCode === undefined ? {} : { exitCode }), effectsUncertain: uncertain, terminationUnconfirmed: unconfirmed });
    };
    const stop = (reason: string) => {
      if (closing || settled) return;
      closing = true; forcedReason = reason;
      try { child.kill(); } catch { /* Close or the cleanup deadline determines uncertainty. */ }
      cleanup = setTimeout(() => finish(reason === 'cancelled' ? 'cancelled' : 'failed', reason, undefined, true, true), 2_000);
      cleanup.unref?.();
    };
    const abort = () => stop('cancelled');
    try {
      // Dispatchers such as rustup select the tool by the original launcher name.
      // The launcher still resolves to the reviewed, byte-pinned executable.
      child = spawn(request.executable.launchPath, request.args, { shell: false, windowsHide: true, cwd: request.cwd,
        env: { ...process.env, ...request.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { finish('unavailable', 'spawn-failed'); return; }
    const observe = (chunk: Buffer) => { byteCount += chunk.byteLength; if (byteCount > request.maxOutputBytes) stop('output-bytes'); };
    child.stdout?.on('data', observe); child.stderr?.on('data', observe);
    child.once('error', () => finish('unavailable', 'spawn-failed', undefined, false));
    child.once('close', code => {
      if (request.signal?.aborted) { finish('cancelled', 'cancelled', code ?? undefined, true); return; }
      if (forcedReason) { finish('failed', forcedReason, code ?? undefined, true); return; }
      const accepted = code !== null && request.acceptedExitCodes.includes(code);
      finish(accepted ? 'passed' : 'failed', accepted ? 'exit-accepted' : 'exit-code', code ?? undefined, !accepted);
    });
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    timeout = setTimeout(() => stop('deadline'), request.timeoutMs);
    timeout.unref?.();
    child.stdin?.on('error', () => stop('stdin-failed'));
    try { child.stdin?.end(request.stdin); } catch { stop('stdin-failed'); }
  });
}
