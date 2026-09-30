import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { pathPins, pinsMatch } from './host-files.js';
import { sha256 } from './host-files.js';
import { readRegularFileWithStats } from './fsxn.js';
import type { PathPin } from './host-files.js';

export interface ResolvedExecutable { path: string; pins: PathPin[]; sha256: string }
export interface ProcessResult {
  status: 'passed' | 'failed' | 'unavailable' | 'cancelled'; reason: string;
  exitCode?: number; effectsUncertain: boolean; terminationUnconfirmed: boolean;
}
const WINDOWS_SUFFIX = process.platform === 'win32' ? ['.exe', '.com'] : [''];

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
      const pins = pathPins(path);
      if (pins.at(-1)?.identity !== 'absent') {
        const captured = readRegularFileWithStats(path, { maxBytes: 512 * 1024 * 1024 });
        if (captured && pinsMatch(pins)) return { path, pins, sha256: sha256(captured.contents) };
      }
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
  const live = pinsMatch(request.executable.pins) ?
    readRegularFileWithStats(request.executable.path, { maxBytes: 512 * 1024 * 1024 }) : undefined;
  if (!live || sha256(live.contents) !== request.executable.sha256 || !pinsMatch(request.executable.pins))
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
      child = spawn(request.executable.path, request.args, { shell: false, windowsHide: true, cwd: request.cwd,
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
