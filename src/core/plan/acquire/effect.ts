// Apply's acquisition for one `acquire` step (contract 8.1, D54, D86, D105, C46, C60, C78): run immediately before Core
// writes the step's marker file, inside the engine's ordered, cancellable run. Every acquired byte comes from the one
// source the review named and is checked against the qualification; a mismatch fails the step and never switches
// branches or sources. A Python tool tries the installed interpreter Prepare found, and moves to the reviewed fallback
// only after a real failure. A closure wheel with a recorded build uses its qualified bytes when obtainable and
// installable on the interpreter in use, and is otherwise built offline from its pinned source and dependency wheels
// (recorded as built, never as byte-qualified). The folder is created by this acquisition and marked while it is
// incomplete, so an interrupted or failed attempt is removed, never adopted; build and temporary folders live inside it.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { childEnvironment, resolveExecutable, resolveProgram } from '../../internal/approved-process.js';
import { directoryIdentity, type CreatedDirectories } from '../../internal/created-directories.js';
import { readArchive } from './archive.js';
import { AcquireError } from './download.js';
import { environmentPython, interpreterIdentity, probeInterpreter, runHelper, standalonePython } from './interpreter.js';
import { inRange } from './range.js';
import { obtain, sourceKey, type Sources } from './sources.js';
import { ACQUIRING, MANIFEST, type AcquireFacts, type AcquireSpec, type ClosureWheel, type Download, type DownloadRecord, type DownloadRole,
  type InstalledInterpreter } from './types.js';
import type { Json } from '../../types.js';
import type { BuildFailureRecord, BuildPhase, PlacedExecutable } from '../types.js';
export type { BuildFailureRecord } from '../types.js';

export interface EffectOutcome { status: 'passed' | 'failed' | 'cancelled'; reason: string; effectsUncertain: boolean; facts?: Json;
  /** Each failed source build of this acquisition, in order (a build that failed on the installed branch, then the fallback's). */
  buildFailures?: BuildFailureRecord[] }
const LOG_LINES = 40;
const LOG_LINE_CHARS = 1000;
/** Host variables whose values a build log never shows, by name. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH/i;
/**
 * The last lines of a build log as Core records it: every bound secret value of the plan and the value of every host
 * variable named like a secret read `[REDACTED]`; control characters read `?`; each line is bounded.
 */
export function redactedLog(text: string | undefined, secrets: readonly string[]): string[] {
  if (!text) return [];
  let result = text;
  const values = [...secrets, ...Object.entries(process.env).filter(([name, value]) => SECRET_NAME.test(name) && value && value.length >= 6).map(([, value]) => value!)];
  for (const value of [...new Set(values)].sort((a, b) => b.length - a.length)) if (value) result = result.split(value).join('[REDACTED]');
  const lines = result.split(/\r?\n/);
  while (lines.length && lines.at(-1)!.trim() === '') lines.pop();
  return lines.slice(-LOG_LINES).map(line => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?').slice(0, LOG_LINE_CHARS));
}
export interface Acquisition { run(signal?: AbortSignal): Promise<EffectOutcome> }
const DOWNLOAD_DEADLINE = 30 * 60_000;
const PROCESS_DEADLINE = 10 * 60_000;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const normal = (name: string): string => name.replace(/[-_.]+/g, '-').toLowerCase();

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

/** What a failed install is attributed to: one wheel, or the closure when the log names none of its files. */
type Attributed = { name: string; version: string } | 'closure';
/**
 * The wheel a failed install's log names (pip reports a refused wheel by its file name on an `ERROR` line): the latest
 * error line naming one of `files`, else `closure`. A wheel the log does not name is never blamed.
 */
export function reportedWheel(log: string | undefined, files: readonly [string, Attributed][]): Attributed {
  const lines = (log ?? '').split(/\r?\n/).filter(line => /\berror\b/i.test(line));
  for (const line of lines.reverse()) {
    // The longest file name first, so a name that is a prefix of another never wins.
    const found = [...files].sort((a, b) => b[0].length - a[0].length).find(([file]) => line.includes(file));
    if (found) return found[1];
  }
  return 'closure';
}

/** A failed build on one interpreter: a real failure that switches the installed interpreter to the fallback. */
class BuildFailure extends Error {
  constructor(readonly phase: BuildPhase, readonly log: string | undefined) { super('build-failed'); }
}
type ToolRecord = NonNullable<DownloadRecord['built']>['tools'][number];
/**
 * A host build tool's observed identity (C78): its executable's sha256 and the first line of `--version`, recorded next to
 * the qualification's. A missing tool is a build failure; a different hash is recorded, not refused.
 */
async function observeTool(name: string, signal?: AbortSignal): Promise<ToolRecord['observed'] | undefined> {
  const found = resolveExecutable(name);
  if (!found) return undefined;
  let digest: string;
  try { digest = sha256(readFileSync(found.path)); } catch { return undefined; }
  const version = await new Promise<string>(resolve => {
    execFile(found.launchPath, ['--version'], { timeout: 15_000, windowsHide: true, maxBuffer: 1_048_576, env: childEnvironment(process.env),
      ...(signal ? { signal } : {}) },
      (_error, stdout) => resolve(String(stdout ?? '').split(/\r?\n/)[0]!.trim().slice(0, 512)));
  });
  return { version, sha256: digest };
}

/** C compilers a build record can name, each with the C++ driver of its family. */
const COMPILERS: Readonly<Record<string, string>> = { gcc: 'g++', clang: 'clang++', cc: 'c++' };
/**
 * The compiler a build uses (C78): when the build record names a C compiler, `CC` is that tool as found on PATH (the host's
 * own `CC` never reaches a build, and an interpreter's recorded default, such as python-build-standalone's `clang`, is not
 * used). `CXX` is the record's C++ driver of the same family when listed, else that driver beside the compiler when
 * present. On Linux `LDSHARED` links extensions with the same compiler. Nothing is set when no C compiler is named.
 */
export function compilerEnvironment(tools: readonly string[]): Record<string, string> {
  const name = tools.find(tool => Object.hasOwn(COMPILERS, tool));
  if (!name) return {};
  const cc = resolveExecutable(name);
  if (!cc) return {};
  const env: Record<string, string> = { CC: cc.launchPath };
  const driver = COMPILERS[name]!;
  const listed = tools.includes(driver) ? resolveExecutable(driver) : undefined;
  const beside = join(dirname(cc.launchPath), process.platform === 'win32' ? `${driver}.exe` : driver);
  const cxx = listed?.launchPath ?? (existsSync(beside) ? resolveExecutable(beside)?.launchPath : undefined);
  if (cxx) env.CXX = cxx;
  if (process.platform === 'linux') env.LDSHARED = `${cc.launchPath} -shared`;
  return env;
}

export function acquisition(spec: AcquireSpec, home: string, installed: InstalledInterpreter | null,
    progress: (event: Json) => void, sources: Sources = new Map(), secrets: readonly string[] = []): Acquisition {
  const folder = join(home, ...spec.into.split('/'));
  const report = (phase: string, extra: Record<string, Json> = {}) => progress({ step: spec.step, op: 'acquire', aiSetup: spec.aiSetup, phase, ...extra });
  const records = new Map<string, DownloadRecord>();
  /** One download from its reviewed source (C78), byte-checked, with where it came from recorded. */
  const fetchInto = async (role: DownloadRole, item: Download, signal?: AbortSignal): Promise<Buffer> => {
    const source = sources.get(sourceKey(role, item)) ?? (item.url ? { kind: 'url' as const, url: item.url } : { kind: 'none' as const });
    const got = await obtain(item, source, { ...(signal ? { signal } : {}), deadlineMs: DOWNLOAD_DEADLINE,
      onBytes: length => report('bytes', { file: item.file, bytes: length }) });
    if (signal?.aborted) throw new AcquireError('cancelled');
    records.set(sourceKey(role, item), { role, file: item.file, sha256: item.sha256, origin: got.origin, ...(got.url ? { url: got.url } : {}) });
    return got.bytes;
  };
  // Build inputs are obtained once and reused when the fallback builds again.
  const cached = new Map<string, Buffer>();
  const fetchOnce = async (role: DownloadRole, item: Download, signal?: AbortSignal): Promise<Buffer> => {
    const key = sourceKey(role, item);
    if (!cached.has(key)) cached.set(key, await fetchInto(role, item, signal));
    return cached.get(key)!;
  };
  const options = (signal?: AbortSignal, env?: Record<string, string>) =>
    ({ ...(signal ? { signal } : {}), timeoutMs: PROCESS_DEADLINE, cwd: folder, ...(env ? { env, build: true } : {}) });
  const step = (phase: BuildPhase, result: { ok: boolean; reason: string; log?: string }): void => {
    if (result.reason === 'cancelled') throw new AcquireError('cancelled');
    if (!result.ok) throw new BuildFailure(phase, result.log ?? `the helper ended with ${result.reason}`);
  };
  let builds = 0;
  const failures: BuildFailureRecord[] = [];
  const failed = (wheel: Attributed, phase: BuildPhase, branch: 'installed' | 'fallback', reason: string, log: string | undefined): void => {
    const record: BuildFailureRecord = { wheel: wheel === 'closure' ? 'closure' : { name: wheel.name, version: wheel.version }, phase, branch, reason,
      log: redactedLog(log, secrets) };
    failures.push(record);
    report('build-failed', record as unknown as Record<string, Json>);
  };

  /**
   * Builds one closure wheel from its pinned source with one interpreter (C78): a dedicated build environment holding only
   * the pinned dependency wheels, installed offline, then an offline build without build isolation, so no unpinned build
   * dependency is ever fetched or run. The wheel must be the closure entry's distribution and version.
   */
  async function build(python: string, wheel: ClosureWheel, signal?: AbortSignal): Promise<{ path: string; record: DownloadRecord }> {
    const recipe = wheel.build!;
    const tools: ToolRecord[] = [];
    for (const tool of recipe.tools) {
      const observed = await observeTool(tool.name, signal);
      if (signal?.aborted) throw new AcquireError('cancelled');
      if (!observed) throw new BuildFailure('build-deps', `build tool ${tool.name} was not found on PATH`);
      tools.push({ name: tool.name, qualified: { version: tool.version, sha256: tool.sha256 }, observed });
    }
    const work = join(folder, 'build', String(builds++));
    const inputs = join(work, 'inputs'), out = join(work, 'out'), temp = join(work, 'tmp');
    for (const dir of [inputs, out, temp]) mkdirSync(dir, { recursive: true });
    const sourcePath = join(inputs, recipe.source.file);
    const dependencies: string[] = [];
    // A source or dependency that can't be obtained keeps its own reason (a mismatch never becomes a build failure).
    try {
      writeFileSync(sourcePath, await fetchOnce('build-source', recipe.source, signal), { flag: 'wx', mode: 0o644 });
      for (const dependency of recipe.dependencies) {
        const path = join(inputs, dependency.file);
        writeFileSync(path, await fetchOnce('build-dependency', dependency, signal), { flag: 'wx', mode: 0o644 });
        dependencies.push(path);
      }
    } catch (error) {
      if (error instanceof AcquireError && error.reason !== 'cancelled') throw Object.assign(error, { phase: 'obtain-source' as const });
      throw error;
    }
    // The build's home, user data and temporary files are its own folder: no host configuration or cache is read (C78).
    const compiler = compilerEnvironment(recipe.tools.map(tool => tool.name));
    const env: Record<string, string> = { TMPDIR: temp, TEMP: temp, TMP: temp, HOME: temp, USERPROFILE: temp,
      ...(process.platform === 'win32' ? { APPDATA: temp } : {}), ...compiler };
    const environment = join(work, 'env');
    step('build-deps', await runHelper(python, ['venv', environment], options(signal, env)));
    const buildPython = environmentPython(environment);
    step('build-deps', await runHelper(buildPython, ['buildenv', ...dependencies], options(signal, env)));
    const made = await runHelper(buildPython, ['build', sourcePath, out], options(signal, env));
    step('build', made);
    const wheels = (made.output as { wheels?: unknown } | null)?.wheels;
    if (!Array.isArray(wheels) || wheels.length !== 1 || typeof wheels[0] !== 'string' || !wheels[0].endsWith('.whl'))
      throw new BuildFailure('build', `the build made ${JSON.stringify(wheels ?? null).slice(0, 512)}, not one wheel`);
    const file = wheels[0] as string;
    const [name, version] = file.split('-');
    if (!name || normal(name) !== normal(wheel.name) || version !== wheel.version)
      throw new BuildFailure('build', `the build made ${file.slice(0, 256)}, not ${wheel.name} ${wheel.version}`);
    const path = join(out, file);
    return { path, record: { role: 'closure', file: wheel.file, sha256: wheel.sha256, origin: 'built', built: { file, sha256: sha256(readFileSync(path)),
      byteQualified: false, source: recipe.source.sha256, dependencies: recipe.dependencies.map(dependency => dependency.sha256), tools,
      ...(compiler.CC ? { env: compiler as { CC: string; CXX?: string; LDSHARED?: string } } : {}) } } };
  }

  /** Makes a dedicated environment from one interpreter, installs the wheels offline and reads the tool back. */
  async function install(python: string, branch: 'installed' | 'fallback', wheels: string[], qualified: Map<ClosureWheel, string | null>, environment: string,
      signal?: AbortSignal):
      Promise<'ok' | 'wheel-install-failed' | 'readback-failed' | 'build-failed' | 'cancelled'> {
    const made = await runHelper(python, ['venv', environment], options(signal));
    if (made.reason === 'cancelled') return 'cancelled';
    if (!made.ok) return 'wheel-install-failed';
    const envPython = environmentPython(environment);
    // A wheel with a recorded build: its qualified bytes when obtained and installable here, else built from pinned source.
    const present = [...qualified].filter((entry): entry is [ClosureWheel, string] => entry[1] !== null);
    let fits: boolean[] = present.map(() => false);
    if (present.length) {
      const checked = await runHelper(envPython, ['compatible', ...present.map(([, path]) => path)], options(signal));
      if (checked.reason === 'cancelled') return 'cancelled';
      const answer = (checked.output as { compatible?: unknown } | null)?.compatible;
      if (checked.ok && Array.isArray(answer) && answer.length === present.length) fits = answer.map(value => value === true);
    }
    const chosen: string[] = []; const built: DownloadRecord[] = []; const builtWheels: ClosureWheel[] = [];
    for (const [wheel, path] of qualified) {
      const at = present.findIndex(([candidate]) => candidate === wheel);
      if (path !== null && fits[at]) { chosen.push(path); continue; }
      try { const result = await build(python, wheel, signal); chosen.push(result.path); built.push(result.record); builtWheels.push(wheel); }
      catch (error) {
        if (error instanceof BuildFailure) { failed(wheel, error.phase, branch, 'build-failed', error.log); return 'build-failed'; }
        if (error instanceof AcquireError && error.reason === 'cancelled') return 'cancelled';
        if (error instanceof AcquireError && (error as { phase?: unknown }).phase === 'obtain-source')
          failed(wheel, 'obtain-source', branch, error.reason, `the pinned build input could not be used: ${error.reason}`);
        throw error;
      }
    }
    const installedWheels = await runHelper(envPython, ['install', ...wheels, ...chosen], options(signal));
    if (installedWheels.reason === 'cancelled') return 'cancelled';
    if (!installedWheels.ok) {
      // After a build the install is part of that build's outcome: it is the wheel pip reports that failed, never just the
      // first one built; when pip names none of the files, the closure's.
      if (builtWheels.length) {
        const files: [string, Attributed][] = [...spec.closure.map(wheel => [wheel.file, wheel] as [string, Attributed]),
          [spec.artifact.file, { name: spec.artifact.file.split('-')[0]!, version: spec.version }],
          ...built.map((record, at) => [record.built!.file, builtWheels[at]!] as [string, Attributed])];
        failed(reportedWheel(installedWheels.log, files), 'install', branch, 'wheel-install-failed', installedWheels.log);
      }
      return 'wheel-install-failed';
    }
    // The readback goes through the program the step names: placed there, launchable by Core's own rules and the same
    // program as the environment's console script, which must be the tool's (C46, so a missing one is a real failure).
    if (spec.executable && !placeExecutable(environment)) return 'readback-failed';
    const name = spec.artifact.file.split('-')[0]!;
    const read = await runHelper(envPython, ['readback', name, ...(spec.executable?.script ? [spec.executable.script] : [])], options(signal));
    if (read.reason === 'cancelled') return 'cancelled';
    if (!(read.ok && (read.output as { version?: unknown } | null)?.version === spec.version)) return 'readback-failed';
    for (const record of built) records.set(sourceKey('closure', record), record);
    return 'ok';
  }

  let placed: PlacedExecutable | undefined;
  const named = (path: string): string => join(folder, ...path.split('/'));
  /**
   * Puts the step's named executable where it names it, pointing at the environment's console script, and checks it can be
   * started from there and is that script: a symlink (POSIX; Core's launcher script where links can't be made), a hard
   * link (a Windows `.exe`: a copy of a console-script launcher is not the same program), or Core's launcher (a Windows
   * `.cmd`). Returns false when the environment has no such script or the named path is not it.
   */
  function placeExecutable(environment: string): boolean {
    const { path, script } = spec.executable!;
    placed = undefined;
    const windows = process.platform === 'win32';
    const entry = join(environment, windows ? 'Scripts' : 'bin', windows ? `${script}.exe` : script!);
    if (!existsSync(entry)) return false;
    const target = named(path);
    let how: PlacedExecutable['placed']; let launcher: Buffer | undefined;
    if (path.split('/')[0] === 'env') how = 'environment';
    else {
      rmSync(target, { force: true });
      mkdirSync(dirname(target), { recursive: true });
      const link = relative(dirname(target), entry);
      if (windows && /\.cmd$/i.test(target)) {
        launcher = Buffer.from(`@"%~dp0${link}" %*\r\n`);
        writeFileSync(target, launcher, { flag: 'wx', mode: 0o755 }); how = 'launcher';
      } else if (windows) {
        try { linkSync(entry, target); } catch { throw new AcquireError('executable-unplaced'); }
        how = 'hardlink';
      } else {
        try { symlinkSync(link, target); how = 'symlink'; }
        catch {
          launcher = Buffer.from(`#!/bin/sh\nexec '${entry.replaceAll("'", "'\\''")}' "$@"\n`);
          writeFileSync(target, launcher, { flag: 'wx', mode: 0o755 }); how = 'launcher';
        }
      }
    }
    const program = resolveProgram(target);
    if (!program) return false;
    const same = launcher ? readFileSync(target).equals(launcher) : how === 'hardlink' ?
      ((a, b) => a.dev === b.dev && a.ino === b.ino)(statSync(target, { bigint: true }), statSync(entry, { bigint: true })) :
      realpathSync.native(target) === realpathSync.native(entry);
    if (!same) return false;
    placed = { path: `${spec.into}/${path}`, placed: how };
    return true;
  }

  async function python(signal?: AbortSignal): Promise<AcquireFacts> {
    const wheelDir = join(folder, 'wheels'); mkdirSync(wheelDir, { recursive: true });
    const wheels: string[] = [];
    const qualified = new Map<ClosureWheel, string | null>();
    const items: [DownloadRole, Download, ClosureWheel | null][] = [...spec.closure.map(wheel => ['closure', wheel, wheel] as [DownloadRole, Download, ClosureWheel]),
      ['artifact', spec.artifact, null]];
    for (const [role, item, wheel] of items) {
      let bytes: Buffer | null;
      try { bytes = await fetchInto(role, item, signal); }
      catch (error) {
        // A wheel with a recorded build and no obtainable qualified bytes is built instead (C78); a mismatch never is.
        if (!(wheel?.build && error instanceof AcquireError && error.reason === 'artifact-unavailable')) throw error;
        bytes = null;
      }
      const path = bytes ? join(wheelDir, item.file) : null;
      if (bytes && path) writeFileSync(path, bytes, { flag: 'wx', mode: 0o644 });
      if (wheel?.build) qualified.set(wheel, path); else wheels.push(path!);
    }
    const environment = join(folder, 'env');
    const done = (facts: AcquireFacts): AcquireFacts => { rmSync(join(folder, 'build'), { recursive: true, force: true, maxRetries: 3 });
      return placed ? { ...facts, executable: placed } : facts; };
    let reason: string;
    if (installed === null) reason = 'none-found';
    else {
      // Only the interpreter Prepare found runs: the same real file with the same bytes, not just the same version.
      const identity = installed.identity ? interpreterIdentity(installed.path) : undefined;
      const same = !installed.identity || identity?.realpath === installed.identity.realpath && identity.sha256 === installed.identity.sha256;
      const now = same ? await probeInterpreter(installed.path, signal) : undefined;
      if (signal?.aborted) throw new AcquireError('cancelled');
      if (!same) reason = 'none-found';
      else if (!now || !inRange(now.version, spec.interpreter!.range)) reason = 'outside-range';
      else {
        const outcome = await install(now.path, 'installed', wheels, qualified, environment, signal);
        if (outcome === 'cancelled') throw new AcquireError('cancelled');
        if (outcome === 'ok') return done({ branch: 'installed', interpreter: now, fallback: false, fallbackReason: null });
        reason = outcome;
      }
      rmSync(environment, { recursive: true, force: true });
    }
    // The reviewed fallback, byte-checked like every wheel (D86); its failure fails the step.
    report('fallback', { reason });
    const archive = await fetchInto('interpreter', spec.interpreter!.fallback, signal);
    const root = join(folder, 'interpreter'); mkdirSync(root, { recursive: true });
    writeEntries(root, readArchive(archive, spec.interpreter!.fallback.file));
    const executable = standalonePython(root);
    if (!existsSync(executable)) throw new AcquireError('interpreter-unavailable');
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
    const outcome = await install(executable, 'fallback', wheels, qualified, environment, signal);
    if (outcome === 'cancelled') throw new AcquireError('cancelled');
    if (outcome !== 'ok') throw new AcquireError(outcome);
    return done({ branch: 'fallback', interpreter: { path: executable, version: spec.interpreter!.fallback.version }, fallback: true, fallbackReason: reason });
  }

  async function native(signal?: AbortSignal): Promise<AcquireFacts> {
    const bytes = await fetchInto('artifact', spec.artifact, signal);
    const entries = readArchive(bytes, spec.artifact.file);
    for (const member of spec.members) {
      const entry = entries.find(candidate => candidate.type === 'file' && candidate.path === member.path);
      if (!entry || sha256(entry.data!) !== member.sha256) throw new AcquireError('artifact-mismatch');
      const target = join(folder, ...member.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data!, { flag: 'wx', mode: member.executable ? 0o755 : 0o644 });
      if (member.executable && process.platform !== 'win32') chmodSync(target, 0o755);
    }
    // The named program is the qualified member, extracted where the step names it and launchable from there.
    if (spec.executable) {
      const member = spec.members.find(entry => entry.path === spec.executable!.path);
      const program = resolveProgram(named(spec.executable.path));
      if (!member || !program || program.sha256 !== member.sha256) throw new AcquireError('readback-failed');
      placed = { path: `${spec.into}/${spec.executable.path}`, placed: 'member' };
    }
    return { branch: null, interpreter: null, fallback: false, fallbackReason: null, ...(placed ? { executable: placed } : {}) };
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
        const facts: AcquireFacts = { ...(spec.kind === 'pypi-wheel' ? await python(signal) : await native(signal)), downloads: [...records.values()] };
        rmSync(join(folder, ACQUIRING), { force: true });
        report('finish', { status: 'passed' });
        return { status: 'passed', reason: 'acquired', effectsUncertain: false, facts: facts as unknown as Json, ...(failures.length ? { buildFailures: failures } : {}) };
      } catch (error) {
        const reason = error instanceof AcquireError ? error.reason : error instanceof BuildFailure ? 'build-failed' : 'acquisition-failed';
        let cleared = false;
        try { rmSync(folder, { recursive: true, force: true, maxRetries: 3 }); cleared = !existsSync(folder); } catch { /* the marker stays for the next attempt */ }
        report('finish', { status: reason === 'cancelled' ? 'cancelled' : 'failed', reason });
        return { status: reason === 'cancelled' || signal?.aborted ? 'cancelled' : 'failed', reason, effectsUncertain: !cleared,
          ...(failures.length ? { buildFailures: failures } : {}) };
      }
    }
  };
}

/**
 * After removal: the AI setup folder whose marker is gone, with every file the acquisition left in it. Its empty version
 * and name folders go too, and so do the empty parents above them (`.aihq/ai-setup`, `.aihq`) that `created` records as
 * made by Core with the identity they still have; a folder the person made stays.
 */
export function removeAcquiredFolder(home: string, into: string, created: CreatedDirectories = {}): boolean {
  if (!contained(home, into)) return false;
  const folder = join(home, ...into.split('/'));
  if (!existsSync(folder) || existsSync(join(folder, MANIFEST))) return false;
  rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  const parents = into.split('/').slice(0, -1);
  for (let depth = 0; parents.length; parents.pop(), depth++) {
    const path = parents.join('/');
    try {
      if (depth >= 2 && (created[path] === undefined || directoryIdentity(home, path) !== created[path])) break;
      const current = join(home, ...parents);
      if (readdirSync(current).length) break;
      rmdirSync(current);
    } catch { break; }
  }
  return true;
}
