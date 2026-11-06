// How long Core keeps recovery data (contract 5, 7): a run's snapshots stay while its outcome may still need them, and a
// kept original stays while a receipt still names it. Everything here only removes data nothing references any more.
import { lstatSync, readdirSync, rmSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { readRegularFile } from './fsxn.js';
import { OWNERSHIP_RECORD_BYTES, protectState, stateRoot } from './state.js';

const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ORIGINAL = /^([a-f0-9]{64})\.bin$/;
/** A kept original no run of this operation released is removed only once it has gone unused this long. */
export const ORIGINAL_IDLE_MS = 60 * 60_000;
/** A completed run's folder no record names is removed only this long after it was written. */
export const ORPHAN_RUN_MS = 24 * 60 * 60_000;
/** A failed, stopped or unrecorded run's folder no record names is removed only this long after it was written. */
export const ORPHAN_FAILED_RUN_MS = 7 * 24 * 60 * 60_000;
/** At most this many orphaned run folders are removed by one operation. */
export const ORPHAN_SWEEP_LIMIT = 16;

const names = (relative: string): string[] => { try { return readdirSync(join(stateRoot(), relative)); } catch { return []; } };
const age = (path: string): number => { try { return Date.now() - lstatSync(path).mtimeMs; } catch { return -1; } };
/** The text of every receipt, staged receipt and custody record: what still names recovery data. */
function recordsText(ownRun?: string): string {
  const texts: string[] = [];
  const read = (relative: string) => {
    try { const bytes = readRegularFile(join(stateRoot(), relative), { maxBytes: OWNERSHIP_RECORD_BYTES }); if (bytes) texts.push(bytes.toString('latin1')); }
    catch { /* unreadable records keep everything: see `unreadable` */ }
  };
  const ownership = names('ownership');
  if (ownership.length > 8192) throw new Error('ownership-limit');
  // A run's own staged receipt is its capacity reservation, not a record: it goes when the run ends.
  for (const name of ownership) if (!ownRun || !name.startsWith(`.pending-${ownRun}-`)) read(`ownership/${name}`);
  for (const name of names('')) if (name.endsWith('.json')) read(name);
  return texts.join('\n');
}

/** The original-file digests a receipt value names. */
export function originalDigests(value: unknown): string[] {
  return [...JSON.stringify(value ?? null).matchAll(/"originalFile":\{"sha256":"([a-f0-9]{64})"/g)].map(match => match[1]!);
}

/** Refreshes a reused original's age, so an unused-original sweep never takes one a run just relied on. */
export function touchOriginal(relative: string): void {
  const now = new Date();
  try { utimesSync(join(stateRoot(), relative), now, now); } catch { /* age only narrows the sweep */ }
}

/** Removes a completed run's own snapshots and manifest: every write committed and its receipt is published. */
export function releaseRunRecovery(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error('recovery-cleanup');
  protectState([`recovery/${runId}`]);
  rmSync(join(stateRoot(), 'recovery', runId), { recursive: true, force: true });
}

/**
 * Removes kept originals no receipt names any more: those `released` by this operation at once, and any other only after
 * it has gone unused for `ORIGINAL_IDLE_MS`. Reports the digests it removed.
 */
export function releaseOriginals(released: Iterable<string>, ownRun?: string): string[] {
  const now = new Set(released);
  const files = names(join('recovery', 'originals'));
  const candidates = files.flatMap(name => {
    const digest = ORIGINAL.exec(name)?.[1];
    if (!digest) return [];
    return now.has(digest) || age(join(stateRoot(), 'recovery', 'originals', name)) > ORIGINAL_IDLE_MS ? [digest] : [];
  });
  if (!candidates.length) return [];
  const records = recordsText(ownRun);
  const removed: string[] = [];
  for (const digest of candidates) {
    if (records.includes(digest)) continue;
    const relative = `recovery/originals/${digest}.bin`;
    protectState([relative]);
    try { unlinkSync(join(stateRoot(), relative)); removed.push(digest); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return removed;
}

/**
 * Removes at most `ORPHAN_SWEEP_LIMIT` run folders earlier runs left that no receipt or custody record names any more:
 * a completed run's once older than `ORPHAN_RUN_MS`; a failed or stopped run's, or one without history, once older than
 * `ORPHAN_FAILED_RUN_MS`. A run a record still names (interrupted, or with pending trust or session recovery) keeps
 * its folder. Call it under the operation's state locks.
 */
export function sweepOrphanRecovery(): number {
  const runs = names('recovery').filter(name => RUN_ID.test(name) && age(join(stateRoot(), 'recovery', name)) > ORPHAN_RUN_MS);
  if (!runs.length) return 0;
  const records = recordsText();
  let removed = 0;
  for (const runId of runs) {
    if (removed >= ORPHAN_SWEEP_LIMIT) break;
    if (records.includes(runId)) continue;
    let completed = false;
    try {
      const history = readRegularFile(join(stateRoot(), 'runs', `${runId}.json`), { maxBytes: 1_048_576 });
      completed = !!history && (JSON.parse(history.toString('utf8')) as { completion?: unknown }).completion === 'complete';
    } catch { completed = false; }
    if (!completed && age(join(stateRoot(), 'recovery', runId)) <= ORPHAN_FAILED_RUN_MS) continue;
    try { releaseRunRecovery(runId); removed++; } catch { /* kept for a later operation */ }
  }
  return removed;
}
