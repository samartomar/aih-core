// Apply's acquisition for one `acquire` step (contract 8.1, D54, D86, D105, C46, C60): run immediately before Core
// writes the step's marker file, inside the engine's ordered, cancellable run. Every downloaded byte is checked against
// the qualification; a mismatch fails the step and never switches branches. A Python tool tries the installed
// interpreter Prepare found, and moves to the reviewed fallback only after a real failure. The folder is created by
// this acquisition and marked while it is incomplete, so an interrupted or failed attempt is removed, never adopted.
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readArchive } from './archive.js';
import { AcquireError, downloadBytes } from './download.js';
import { environmentPython, probeInterpreter, runHelper, standalonePython } from './interpreter.js';
import { inRange } from './range.js';
import { ACQUIRING, MANIFEST, type AcquireFacts, type AcquireSpec, type Download, type InstalledInterpreter } from './types.js';
import type { Json } from '../../types.js';

export interface EffectOutcome { status: 'passed' | 'failed' | 'cancelled'; reason: string; effectsUncertain: boolean; facts?: Json }
export interface Acquisition { run(signal?: AbortSignal): Promise<EffectOutcome> }
const DOWNLOAD_DEADLINE = 30 * 60_000;
const PROCESS_DEADLINE = 10 * 60_000;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The folder's ancestors under home are real directories: no link or junction is followed into or out of it. */
function contained(home: string, into: string): boolean {
  let current = home;
  for (const segment of into.split('/')) {
    current = join(current, segment);
    try { const stats = lstatSync(current); if (stats.isSymbolicLink() || !stats.isDirectory()) return false; }
    catch { return true; }
  }
  return true;
}
function writeEntries(root: string, entries: ReturnType<typeof readArchive>): void {
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    const target = join(root, ...entry.path.split('/'));
    if (entry.type === 'directory') { mkdirSync(target, { recursive: true }); continue; }
    mkdirSync(dirname(target), { recursive: true });
    if (entry.type === 'file') { writeFileSync(target, entry.data!, { flag: 'wx', mode: entry.mode & 0o111 ? 0o755 : 0o644 }); files.set(entry.path, entry.data!); }
    else if (entry.type === 'hardlink') {
      const source = files.get(entry.target!); if (!source) throw new AcquireError('archive-invalid');
      try { linkSync(join(root, ...entry.target!.split('/')), target); } catch { writeFileSync(target, source, { flag: 'wx', mode: 0o755 }); }
    } else {
      // A contained relative link (checked by the reader). Where links can't be made, the archive can't be laid out.
      try { symlinkSync(entry.target!, target); } catch { throw new AcquireError('archive-links-unavailable'); }
    }
  }
}

export function acquisition(spec: AcquireSpec, home: string, installed: InstalledInterpreter | null,
    progress: (event: Json) => void): Acquisition {
  const folder = join(home, ...spec.into.split('/'));
  const report = (phase: string, extra: Record<string, Json> = {}) => progress({ step: spec.step, op: 'acquire', aiSetup: spec.aiSetup, phase, ...extra });
  const fetchInto = async (item: Download, signal?: AbortSignal): Promise<Buffer> => {
    const bytes = await downloadBytes(item, { ...(signal ? { signal } : {}), deadlineMs: DOWNLOAD_DEADLINE, onBytes: length => report('bytes', { file: item.file, bytes: length }) });
    if (signal?.aborted) throw new AcquireError('cancelled');
    return bytes;
  };

  /** Makes a dedicated environment from one interpreter, installs the wheels offline and reads the tool back. */
  async function install(python: string, wheels: string[], environment: string, signal?: AbortSignal): Promise<'ok' | 'wheel-install-failed' | 'readback-failed' | 'cancelled'> {
    const options = { ...(signal ? { signal } : {}), timeoutMs: PROCESS_DEADLINE, cwd: folder };
    const made = await runHelper(python, ['venv', environment], options);
    if (made.reason === 'cancelled') return 'cancelled';
    if (!made.ok) return 'wheel-install-failed';
    const envPython = environmentPython(environment);
    const installedWheels = await runHelper(envPython, ['install', ...wheels], options);
    if (installedWheels.reason === 'cancelled') return 'cancelled';
    if (!installedWheels.ok) return 'wheel-install-failed';
    const name = spec.artifact.file.split('-')[0]!;
    const read = await runHelper(envPython, ['readback', name], options);
    if (read.reason === 'cancelled') return 'cancelled';
    return read.ok && (read.output as { version?: unknown } | null)?.version === spec.version ? 'ok' : 'readback-failed';
  }

  async function python(signal?: AbortSignal): Promise<AcquireFacts> {
    const wheelDir = join(folder, 'wheels'); mkdirSync(wheelDir, { recursive: true });
    const wheels: string[] = [];
    for (const item of [...spec.closure, spec.artifact]) {
      const bytes = await fetchInto(item, signal);
      const path = join(wheelDir, item.file); writeFileSync(path, bytes, { flag: 'wx', mode: 0o644 }); wheels.push(path);
    }
    const environment = join(folder, 'env');
    let reason: string;
    if (installed === null) reason = 'none-found';
    else {
      const now = await probeInterpreter(installed.path, signal);
      if (signal?.aborted) throw new AcquireError('cancelled');
      if (!now || !inRange(now.version, spec.interpreter!.range)) reason = 'outside-range';
      else {
        const outcome = await install(now.path, wheels, environment, signal);
        if (outcome === 'cancelled') throw new AcquireError('cancelled');
        if (outcome === 'ok') return { branch: 'installed', interpreter: now, fallback: false, fallbackReason: null };
        reason = outcome;
      }
      rmSync(environment, { recursive: true, force: true });
    }
    // The reviewed fallback, byte-checked like every wheel (D86); its failure fails the step.
    report('fallback', { reason });
    const archive = await fetchInto(spec.interpreter!.fallback, signal);
    const root = join(folder, 'interpreter'); mkdirSync(root, { recursive: true });
    writeEntries(root, readArchive(archive, spec.interpreter!.fallback.file));
    const executable = standalonePython(root);
    if (!existsSync(executable)) throw new AcquireError('interpreter-unavailable');
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
    const outcome = await install(executable, wheels, environment, signal);
    if (outcome === 'cancelled') throw new AcquireError('cancelled');
    if (outcome !== 'ok') throw new AcquireError(outcome);
    return { branch: 'fallback', interpreter: { path: executable, version: spec.interpreter!.fallback.version }, fallback: true, fallbackReason: reason };
  }

  async function native(signal?: AbortSignal): Promise<AcquireFacts> {
    const bytes = await fetchInto(spec.artifact, signal);
    const entries = readArchive(bytes, spec.artifact.file);
    for (const member of spec.members) {
      const entry = entries.find(candidate => candidate.type === 'file' && candidate.path === member.path);
      if (!entry || sha256(entry.data!) !== member.sha256) throw new AcquireError('artifact-mismatch');
      const target = join(folder, ...member.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data!, { flag: 'wx', mode: member.executable ? 0o755 : 0o644 });
      if (member.executable && process.platform !== 'win32') chmodSync(target, 0o755);
    }
    return { branch: null, interpreter: null, fallback: false, fallbackReason: null };
  }

  return {
    async run(signal) {
      report('start');
      if (!contained(home, spec.into)) return { status: 'failed', reason: 'unsafe-path', effectsUncertain: false };
      if (existsSync(folder)) {
        // Only Core's own unfinished attempt is cleared; anything else in the folder is not Core's to replace.
        if (!existsSync(join(folder, ACQUIRING)) || existsSync(join(folder, MANIFEST))) return { status: 'failed', reason: 'target-occupied', effectsUncertain: false };
        rmSync(folder, { recursive: true, force: true });
      }
      mkdirSync(folder, { recursive: true, mode: 0o755 });
      writeFileSync(join(folder, ACQUIRING), `${spec.aiSetup} ${spec.version} ${spec.cell}\n`, { flag: 'wx', mode: 0o600 });
      try {
        const facts = spec.kind === 'pypi-wheel' ? await python(signal) : await native(signal);
        rmSync(join(folder, ACQUIRING), { force: true });
        report('finish', { status: 'passed' });
        return { status: 'passed', reason: 'acquired', effectsUncertain: false, facts: facts as unknown as Json };
      } catch (error) {
        const reason = error instanceof AcquireError ? error.reason : 'acquisition-failed';
        let cleared = false;
        try { rmSync(folder, { recursive: true, force: true, maxRetries: 3 }); cleared = !existsSync(folder); } catch { /* the marker stays for the next attempt */ }
        report('finish', { status: reason === 'cancelled' ? 'cancelled' : 'failed', reason });
        return { status: reason === 'cancelled' || signal?.aborted ? 'cancelled' : 'failed', reason, effectsUncertain: !cleared };
      }
    }
  };
}

/** After removal: the AI setup folder whose marker is gone, with every file the acquisition left in it. */
export function removeAcquiredFolder(home: string, into: string): boolean {
  if (!contained(home, into)) return false;
  const folder = join(home, ...into.split('/'));
  if (!existsSync(folder) || existsSync(join(folder, MANIFEST))) return false;
  rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  // Empty version and name folders go too; `.aihq/ai-setup` itself stays.
  for (let current = dirname(folder), depth = 0; depth < 2; current = dirname(current), depth++) {
    try { if (readdirSync(current).length) break; rmdirSync(current); } catch { break; }
  }
  return true;
}
