// Apply's effects for program steps (contract 8.1, 12, C30, C60), run inside the engine's ordered, cancellable run after
// the pending receipt is written: an `upstream-setup`'s clone at the exact commit (before its marker file is written),
// and a command whose program only exists once an earlier step made it (the AI setup's acquired executable, a program
// inside the clone). A failure fails that step, so the rest of its item and its dependants are not attempted. A command
// that started may have changed things: its failure is `effectsUncertain`, never a rollback.
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { argumentsRunnable, resolveProgram, runApprovedProcess, type ResolvedExecutable } from '../../internal/approved-process.js';
import { SETUP_MARKER } from '../steps/upstream-setup.js';
import { recordTree, removeRecordedTree } from '../../internal/tree-manifest.js';
import { PRIOR } from '../steps/tool-command.js';
import type { LoweredProgram, Readback } from '../steps/types.js';

export interface EffectOutcome { status: 'passed' | 'failed' | 'cancelled'; reason: string; effectsUncertain: boolean }
/** What a `tool-command` with a restore records once its prior value is read: the undo, and whether the value was kept. */
export interface ProgramRecord { undo: { argv: string[]; readback: Readback } | null; prior: 'read' | 'withheld' }
/**
 * `recordProgram`: the engine merges these facts into the receipt's program entry for the plan step, called before the
 * command starts.
 */
export interface Effect { run(signal?: AbortSignal, hooks?: { recordProgram(step: number, facts: ProgramRecord): void }): Promise<EffectOutcome> }
/** What one program step's check found, by plan step: its readback (tool-command) or that its effects can't be checked. */
export type Verifications = Map<number, { status: string; reason: string }>;
const COMMAND_DEADLINE = 30 * 60_000;
const OUTPUT_BYTES = 1_048_576;

/** Whether the command's output shows the expected value: one output line, trimmed, equals it. */
export function readbackMatches(stdout: Buffer | undefined, expected: string): boolean {
  if (!stdout) return false;
  const text = stdout.toString('utf8').trim();
  // An empty expected value means the output must be empty, never that some blank line exists.
  return expected.trim() === '' ? text === '' : text.split(/\r?\n/).some(line => line.trim() === expected.trim());
}

/** The folder's ancestors under its root are real folders: no link or junction is followed into it. */
function contained(root: string, relative: string): boolean {
  let current = root;
  for (const segment of relative.split('/')) {
    current = join(current, segment);
    try { const stats = lstatSync(current); if (stats.isSymbolicLink() || !stats.isDirectory()) return false; }
    catch { return true; }
  }
  return true;
}

/**
 * The clone for an `upstream-setup`: `git clone --no-checkout`, `checkout --detach <commit>`, and `rev-parse HEAD` must
 * name that commit, all in a fresh sibling folder that is moved into place only once checked. An earlier clone of
 * Core's own (its marker present) is replaced; anything else in the folder is not Core's to replace.
 */
export function cloneEffect(clone: NonNullable<LoweredProgram['clone']>, root: string, git: ResolvedExecutable): Effect {
  const folder = join(root, ...clone.into.split('/'));
  return {
    async run(signal) {
      if (!contained(root, clone.into)) return { status: 'failed', reason: 'unsafe-path', effectsUncertain: false };
      if (existsSync(folder) && !existsSync(join(folder, SETUP_MARKER))) return { status: 'failed', reason: 'target-occupied', effectsUncertain: false };
      mkdirSync(dirname(folder), { recursive: true });
      const staging = join(dirname(folder), `.${basename(folder)}.aih-clone-${randomUUID()}`);
      const env = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' };
      const git$ = (args: string[], capture = false) => runApprovedProcess({ executable: git, args, cwd: dirname(folder), env,
        timeoutMs: COMMAND_DEADLINE, maxOutputBytes: OUTPUT_BYTES, acceptedExitCodes: [0], capture, ...(signal ? { signal } : {}) });
      const clear = () => { try { rmSync(staging, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left beside the folder */ } };
      for (const args of [['-c', 'core.hooksPath=', 'clone', '--quiet', '--no-checkout', '--template=', '--', clone.repository, staging],
        ['-C', staging, '-c', 'core.hooksPath=', 'checkout', '--quiet', '--detach', clone.commit]]) {
        const outcome = await git$(args);
        if (outcome.status !== 'passed') { clear(); return { status: outcome.status === 'cancelled' ? 'cancelled' : 'failed',
          reason: outcome.status === 'cancelled' ? 'cancelled' : 'clone-failed', effectsUncertain: false }; }
      }
      const head = await git$(['-C', staging, 'rev-parse', 'HEAD'], true);
      if (head.status !== 'passed' || head.stdout?.toString('utf8').trim() !== clone.commit) {
        clear(); return { status: head.status === 'cancelled' ? 'cancelled' : 'failed', reason: head.status === 'cancelled' ? 'cancelled' : 'clone-commit-mismatch', effectsUncertain: false };
      }
      try {
        if (existsSync(folder)) rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
        renameSync(staging, folder);
      } catch { clear(); return { status: 'failed', reason: 'clone-unplaced', effectsUncertain: true }; }
      // What the clone placed, so its removal deletes exactly that (contract 14); what the setup adds later is not.
      recordTree(folder, join(folder, ...CLONE_MANIFEST));
      return { status: 'passed', reason: 'cloned', effectsUncertain: false };
    }
  };
}

/**
 * One reviewed command. The program is the one Prepare pinned (a PATH program), or is resolved now: the AI setup's
 * acquired executable, checked against its qualified sha256 when the qualification lists it, or the clone's own
 * program. A `tool-command` then runs its readback, which must show the expected value (D57).
 */
export function commandEffect(lowered: LoweredProgram, root: string, pinned: ResolvedExecutable | undefined, step: number,
    verifications: Verifications, secrets: readonly string[] = []): Effect {
  const cwd = lowered.cwd ? join(root, ...lowered.cwd.split('/')) : root;
  const run = (executable: ResolvedExecutable, args: string[], capture: boolean, signal?: AbortSignal) => runApprovedProcess({ executable, args, cwd,
    env: lowered.env, timeoutMs: COMMAND_DEADLINE, maxOutputBytes: OUTPUT_BYTES, acceptedExitCodes: [0], capture, ...(signal ? { signal } : {}) });
  return {
    async run(signal, hooks) {
      let executable = pinned;
      if (lowered.executable.from === 'acquired') {
        executable = resolveProgram(join(root, ...lowered.executable.path.split('/')));
        if (executable && lowered.executable.sha256 && executable.sha256 !== lowered.executable.sha256) executable = undefined;
      } else if (lowered.executable.from === 'clone') {
        if (!contained(root, `${lowered.cwd}/${lowered.executable.path}`)) return { status: 'failed', reason: 'unsafe-path', effectsUncertain: false };
        executable = resolveProgram(join(cwd, ...lowered.executable.path.split('/')));
      }
      if (!executable) return { status: 'failed', reason: 'program-unavailable', effectsUncertain: false };
      // A restore needs the value before the command: the readback runs first and its output is kept in the receipt
      // before the command starts. Nothing runs when no prior value can be read.
      // An earlier install's record of it, kept at Prepare (`kept`), is never read again.
      if (lowered.restore && lowered.readback && !lowered.kept) {
        const prior = await priorValue(executable, lowered.readback.argv, cwd, lowered.env, signal);
        if (prior.status === 'cancelled') return { status: 'cancelled', reason: 'cancelled', effectsUncertain: false };
        if (prior.status !== 'passed') {
          verifications.set(step, { status: 'failed', reason: prior.reason });
          return { status: 'failed', reason: prior.reason, effectsUncertain: false };
        }
        const filled = lowered.restore.argv.map(arg => arg === PRIOR ? prior.value : arg);
        // A restore the program could never be given (a command shim refuses `"`, `%`): nothing runs, so nothing is
        // left that removal can't undo.
        if (!argumentsRunnable(executable, filled)) {
          verifications.set(step, { status: 'failed', reason: 'prior-unrestorable' });
          return { status: 'failed', reason: 'prior-unrestorable', effectsUncertain: false };
        }
        // A prior value holding a secret value bound anywhere in the plan is never recorded (`withheld`); then removal
        // can't restore it, and says so.
        const secret = secrets.some(value => value !== '' && prior.value.includes(value));
        hooks?.recordProgram(step, secret ? { undo: null, prior: 'withheld' } :
          { undo: { argv: filled, readback: { argv: [...lowered.readback.argv], expected: prior.value } }, prior: 'read' });
      }
      // A tool-command's argv follows its executable; the other kinds name the program first.
      const program = lowered.op === 'tool-command' ? lowered.argv : lowered.argv.slice(1);
      const outcome = await run(executable, program, false, signal);
      if (outcome.status !== 'passed') return { status: outcome.status === 'cancelled' ? 'cancelled' : 'failed',
        reason: outcome.status === 'cancelled' ? 'cancelled' : outcome.status === 'unavailable' ? outcome.reason : 'command-failed', effectsUncertain: outcome.effectsUncertain || outcome.status === 'failed' };
      // The reviewed setup's own files are part of what Core placed in its clone; later edits and additions are not.
      if (lowered.clone && lowered.cwd === lowered.clone.into) recordTree(cwd, join(cwd, ...CLONE_MANIFEST));
      if (!lowered.readback) { verifications.set(step, { status: 'unverified', reason: 'command-effects-unknown' }); return { status: 'passed', reason: 'exit-accepted', effectsUncertain: false }; }
      const read = await readbackRun(executable, lowered.readback, cwd, lowered.env, signal);
      verifications.set(step, read.status === 'passed' ? { status: 'passed', reason: 'readback-matched' } : { status: 'failed', reason: read.reason });
      if (read.status === 'cancelled') return { status: 'cancelled', reason: 'cancelled', effectsUncertain: true };
      return read.status === 'passed' ? { status: 'passed', reason: 'readback-matched', effectsUncertain: false } :
        { status: 'failed', reason: read.reason, effectsUncertain: true };
    }
  };
}

/**
 * The value a `tool-command`'s readback shows before the command runs: its output trimmed, one line of at most 4096
 * characters. A readback that fails or shows anything else gives no prior value (`prior-unreadable`).
 */
async function priorValue(executable: ResolvedExecutable, argv: string[], cwd: string, env: Record<string, string>, signal?: AbortSignal):
    Promise<{ status: 'passed'; value: string } | { status: 'failed' | 'cancelled'; reason: string }> {
  const outcome = await runApprovedProcess({ executable, args: argv, cwd, env, timeoutMs: 60_000, maxOutputBytes: OUTPUT_BYTES,
    acceptedExitCodes: [0], capture: true, ...(signal ? { signal } : {}) });
  if (outcome.status === 'cancelled') return { status: 'cancelled', reason: 'cancelled' };
  const value = outcome.status === 'passed' ? outcome.stdout?.toString('utf8').trim() : undefined;
  // Any control character (a line break, NUL, an escape sequence) is no value Core can record or pass back.
  if (value === undefined || /[\u0000-\u001f\u007f]/.test(value) || value.length > 4096) return { status: 'failed', reason: 'prior-unreadable' };
  return { status: 'passed', value };
}

/** Runs one readback with the command's program and compares its output (D57). */
export async function readbackRun(executable: ResolvedExecutable, readback: Readback, cwd: string, env: Record<string, string>, signal?: AbortSignal):
    Promise<{ status: 'passed' | 'failed' | 'cancelled'; reason: string }> {
  const outcome = await runApprovedProcess({ executable, args: readback.argv, cwd, env, timeoutMs: 60_000, maxOutputBytes: OUTPUT_BYTES,
    acceptedExitCodes: [0], capture: true, ...(signal ? { signal } : {}) });
  if (outcome.status === 'cancelled') return { status: 'cancelled', reason: 'cancelled' };
  if (outcome.status !== 'passed') return { status: 'failed', reason: `readback-${outcome.reason}` };
  return readbackMatches(outcome.stdout, readback.expected) ? { status: 'passed', reason: 'readback-matched' } : { status: 'failed', reason: 'readback-mismatch' };
}

/** Where a clone's record of what it placed is kept: inside its Git folder, so it never shows as a change in the clone. */
const CLONE_MANIFEST = ['.git', 'aih-tree.json'];
/**
 * After removal: the clone whose marker is gone, with the files the clone recorded placing that still hold the recorded
 * bytes. Anything else (your edits, files the setup or you added, or every file of a clone with no record) is kept and
 * returned in `kept`, relative to the clone.
 */
export function removeClone(markerPath: string): { removed: boolean; kept: string[] } {
  const folder = dirname(markerPath);
  try {
    if (basename(markerPath) !== SETUP_MARKER || existsSync(markerPath)) return { removed: false, kept: [] };
    const stats = lstatSync(folder);
    if (stats.isSymbolicLink() || !stats.isDirectory() || !existsSync(join(folder, '.git'))) return { removed: false, kept: [] };
    return removeRecordedTree(folder, join(folder, ...CLONE_MANIFEST));
  } catch { return { removed: false, kept: [] }; }
}
