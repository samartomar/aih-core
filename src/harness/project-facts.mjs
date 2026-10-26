// Node-only bounded project facts diagnostic for Project basics. It reads the project with
// bounded reads and runs nothing: no tool, script, hook or package manager is executed, not
// even with --version. It never writes, removes or edits anything. A fact it cannot establish
// from the files it read is omitted, never guessed; only the package-manager default is
// inferred, and only from direct evidence (a package.json with no stronger package-manager
// signal), which the fact's confidence states.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const DEFAULT_BUDGET_MS = 10000, MAX_BUDGET_MS = 60000;
const MAX_READS = 64, MAX_FILE_BYTES = 1048576, MAX_FACTS = 16, MAX_VALUE = 256;
const PROJECT_MAX = 4096;

// The fixed candidate list: a bounded look at a repository, at most one read per candidate.
const CANDIDATES = Object.freeze(['package.json', 'package-lock.json', 'npm-shrinkwrap.json',
  'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', '.nvmrc', '.node-version']);
const LOCKFILE_MANAGERS = Object.freeze({ 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' });
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const VERSION_TEXT = /^[^\r\n]{1,64}$/;

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));

function invalidRequest(request, controls) {
  if (!plainObject(request) || Object.keys(request).some(key => key !== 'project')) return 'request-field';
  if (!plainObject(controls) || Object.keys(controls).some(key => !['signal', 'budgetMs'].includes(key))) return 'controls-field';
  if (controls.signal !== undefined && !(controls.signal instanceof AbortSignal)) return 'signal';
  if (controls.budgetMs !== undefined && (!Number.isInteger(controls.budgetMs) || controls.budgetMs < 1 ||
      controls.budgetMs > MAX_BUDGET_MS)) return 'budget-ms';
  if (typeof request.project !== 'string' || !request.project || request.project.length > PROJECT_MAX ||
      request.project.includes('\u0000') || !isAbsolute(request.project)) return 'project';
  return undefined;
}

/**
 * Reads project facts (stack, package manager, test/build/lint commands) with bounded reads
 * and nothing run. Every fact is `detected` from a file this diagnostic read, or `inferred`
 * (today only the npm default for a package.json with no stronger package-manager signal).
 */
export async function detectProjectFacts(request, controls = {}) {
  const started = performance.now();
  const invalid = invalidRequest(request, controls);
  const budgetMs = invalid ? DEFAULT_BUDGET_MS : controls.budgetMs ?? DEFAULT_BUDGET_MS;
  const limits = reads => ({ budgetMs, elapsedMs: Math.round(performance.now() - started), reads, maxReads: MAX_READS });
  if (invalid) return { status: 'invalid', facts: null, diagnostics: [{ code: 'INPUT_INVALID', reason: invalid,
    message: 'Use { project: <absolute folder> } and bounded controls.' }], limits: limits(0) };
  if (controls.signal?.aborted) return { status: 'cancelled', facts: null, diagnostics: [{ code: 'CANCELLED', reason: 'cancelled',
    message: 'Project facts detection was cancelled.' }], limits: limits(0) };

  // Every filesystem read counts against one bound; past the deadline or the read limit the
  // remaining facts are unchecked. Reads run synchronously, so a signal is honoured only when
  // it is already aborted, as in the other bounded diagnostics.
  let reads = 0, stopped;
  const deadline = started + budgetMs;
  class Stop extends Error {}
  const halt = () => {
    if (stopped) return stopped;
    if (performance.now() > deadline) stopped = 'budget';
    else if (reads >= MAX_READS) stopped = 'read-limit';
    return stopped;
  };
  const read = operation => { if (halt()) throw new Stop(); reads += 1; return operation(); };
  // At most MAX_FILE_BYTES+1 bytes are read from a candidate, so a large file is reported
  // over-limit instead of being read whole. The candidate must be a regular file: a FIFO or
  // device can block a synchronous open forever, past any budget, so links and non-regular
  // files are refused. The open is non-blocking and refuses symlinks, and the opened handle
  // is fstat'ed, so a path swapped between the check and the open cannot hang the read.
  const NOFOLLOW = constants.O_NOFOLLOW ?? 0, NONBLOCK = constants.O_NONBLOCK ?? 0;
  const boundedRead = path => read(() => {
    let handle;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) return { present: false, overLimit: false, text: null, irregular: true };
      try { handle = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK); }
      catch (error) {
        if (error && typeof error === 'object' && error.code === 'ELOOP') return { present: false, overLimit: false, text: null, irregular: true };
        throw error;
      }
      const opened = fstatSync(handle);
      if (!opened.isFile()) return { present: false, overLimit: false, text: null, irregular: true };
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const length = readSync(handle, buffer, 0, MAX_FILE_BYTES + 1, 0);
      if (length > MAX_FILE_BYTES) return { present: true, overLimit: true, text: null };
      return { present: true, overLimit: false, text: buffer.toString('utf8', 0, length) };
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return { present: false, overLimit: false, text: null };
      throw error;
    } finally { if (handle !== undefined) { try { closeSync(handle); } catch { /* the read result stands */ } } }
  });

  let project;
  try { project = read(() => realpathSync.native(request.project)); }
  catch {
    return { status: 'invalid', facts: null, diagnostics: [{ code: 'INPUT_INVALID', reason: 'project',
      message: 'The project folder is not an existing absolute folder.' }], limits: limits(reads) };
  }
  let directory = false;
  try { directory = read(() => lstatSync(project).isDirectory()); }
  catch {
    return { status: 'invalid', facts: null, diagnostics: [{ code: 'INPUT_INVALID', reason: 'project',
      message: 'The project folder is not an existing absolute folder.' }], limits: limits(reads) };
  }
  if (!directory) {
    return { status: 'invalid', facts: null, diagnostics: [{ code: 'INPUT_INVALID', reason: 'project',
      message: 'The project path is not a folder.' }], limits: limits(reads) };
  }

  const diagnostics = [];
  const files = new Map();
  for (const name of CANDIDATES) {
    try {
      const result = boundedRead(join(project, name));
      if (result.present) files.set(name, result);
      if (result.irregular) diagnostics.push({ code: 'PREREQUISITE_UNAVAILABLE', reason: 'candidate-not-regular-file',
        message: `${name} is not a regular file; project facts detection never opens links or devices.` });
    } catch (error) {
      if (error instanceof Stop) break;
      diagnostics.push({ code: 'PREREQUISITE_UNAVAILABLE', reason: 'read-failed',
        message: `Could not read ${name} while detecting project facts.` });
    }
  }
  const facts = [];
  const fact = (field, value, confidence) => {
    if (facts.length >= MAX_FACTS || typeof value !== 'string' || !value || value.length > MAX_VALUE) return;
    facts.push({ field, value, confidence });
  };

  let manifest = null;
  const manifestFile = files.get('package.json');
  if (manifestFile && !manifestFile.overLimit && manifestFile.text !== null) {
    try {
      const parsed = JSON.parse(manifestFile.text);
      if (plainObject(parsed)) manifest = parsed;
      else diagnostics.push({ code: 'INPUT_INVALID', reason: 'manifest-invalid',
        message: 'The project package.json is not a JSON object; its facts are omitted.' });
    } catch {
      diagnostics.push({ code: 'INPUT_INVALID', reason: 'manifest-invalid',
        message: 'The project package.json is not valid JSON; its facts are omitted.' });
    }
  } else if (manifestFile?.overLimit) {
    diagnostics.push({ code: 'PREREQUISITE_UNAVAILABLE', reason: 'manifest-over-limit',
      message: 'The project package.json exceeds the bounded read limit.' });
  }

  // The package manager: a declared field or a lockfile is detected; with only a manifest,
  // npm is inferred because Node ships it. The confidence says which.
  let packageManager = null, packageManagerConfidence = null;
  if (manifest && typeof manifest.packageManager === 'string') {
    // The corepack shape is `name@version`; a bare manager name is accepted too.
    const field = manifest.packageManager.trim();
    const name = field.includes('@') ? field.slice(0, field.indexOf('@')) : field;
    if (MANAGERS.has(name)) { packageManager = name; packageManagerConfidence = 'detected'; }
  }
  if (!packageManager) {
    for (const [name, manager] of Object.entries(LOCKFILE_MANAGERS)) {
      if (files.has(name)) { packageManager = manager; packageManagerConfidence = 'detected'; break; }
    }
  }
  if (!packageManager && manifest) { packageManager = 'npm'; packageManagerConfidence = 'inferred'; }

  if (manifest) fact('stack', 'node', 'detected');
  if (packageManager) fact('packageManager', packageManager, packageManagerConfidence);
  const scripts = manifest && plainObject(manifest.scripts) ? manifest.scripts : null;
  if (packageManager && scripts) {
    if (typeof scripts.test === 'string' && scripts.test) fact('testCommand', `${packageManager} test`, 'detected');
    if (typeof scripts.build === 'string' && scripts.build) fact('buildCommand', `${packageManager} run build`, 'detected');
    if (typeof scripts.lint === 'string' && scripts.lint) fact('lintCommand', `${packageManager} run lint`, 'detected');
  }
  for (const name of ['.nvmrc', '.node-version']) {
    const file = files.get(name);
    if (!file || file.overLimit || file.text === null) continue;
    const version = file.text.trim();
    if (version && VERSION_TEXT.test(version)) { fact('nodeVersion', version, 'detected'); break; }
  }

  const status = stopped || diagnostics.length ? 'incomplete' : 'complete';
  return { status, project, facts, diagnostics, limits: limits(reads) };
}
