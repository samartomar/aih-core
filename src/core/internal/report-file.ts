// Exclusive creation of an explicitly requested Markdown report file.
// The destination is caller-chosen: no default name, suffix selection,
// directory creation, overwrite, history entry or share/upload happens here.
import { constants, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathPins, pinsMatch, type PathPin } from './host-files.js';
import type { Diagnostic } from '../types.js';

export type ReportFileStatus = 'written' | 'exists' | 'invalid' | 'failed' | 'cancelled';
export interface ReportFileResult { status: ReportFileStatus; path?: string; diagnostics: Diagnostic[] }

const O_NOFOLLOW = (constants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
const CHUNK_BYTES = 64 * 1024;

const invalid = (reason: string, message: string): ReportFileResult =>
  ({ status: 'invalid', diagnostics: [{ code: 'INPUT_INVALID', reason, message }] });
const failed = (reason = 'failed', path?: string): ReportFileResult => ({
  status: 'failed',
  diagnostics: [{ code: 'WRITE_FAILED', reason, message: reason === 'partial-report-retained' ?
    'A partial report could not be removed; review and delete it yourself.' : 'The report could not be written safely.',
    ...(path === undefined ? {} : { path }) }]
});
const cancelled = (): ReportFileResult =>
  ({ status: 'cancelled', diagnostics: [{ code: 'CANCELLED', reason: 'cancelled', message: 'The report write was cancelled.' }] });

interface CreatedIdentity { dev: bigint; ino: bigint }

/** The path still names the exact regular file this invocation created. */
function identityIntact(path: string, identity: CreatedIdentity): boolean {
  try {
    const current = lstatSync(path, { bigint: true });
    return !current.isSymbolicLink() && current.isFile() &&
      identity.ino !== 0n && current.dev === identity.dev && current.ino === identity.ino;
  } catch { return false; }
}

/** Remove only the file this invocation created. Returns true when it was retained. */
function removeCreated(path: string, identity: CreatedIdentity): boolean {
  try {
    if (!identityIntact(path, identity)) return true;
    unlinkSync(path);
    return false;
  } catch { return true; }
}

class AbortWrite extends Error { }
class UnsafeDestination extends Error { }
class UnsafeParent extends Error { }

export async function writeExclusiveReportFile(
  path: string, contents: Uint8Array, options: { signal?: AbortSignal } = {}
): Promise<ReportFileResult> {
  const { signal } = options;
  if (signal?.aborted) return cancelled();
  if (typeof path !== 'string' || !isAbsolute(path) || /\p{Cc}/u.test(path) || !/\.md$/i.test(path))
    return invalid('invalid-path', 'Use an absolute path ending in .md without control characters.');
  const directory = dirname(path);
  let pins: PathPin[];
  try { pins = pathPins(directory); }
  catch { return invalid('unsafe-parent', 'The report directory chain must not contain links.'); }
  if (pins.at(-1)?.identity === 'absent')
    return invalid('parent-missing', 'The report directory must already exist.');
  let directoryStats;
  try { directoryStats = lstatSync(directory); }
  catch { return failed(); }
  if (!directoryStats.isDirectory())
    return invalid('parent-not-directory', 'The report path parent must be a directory.');
  const canonical = join(realpathSync.native(directory), basename(path));
  try {
    const existing = lstatSync(path);
    if (!existing.isSymbolicLink() && existing.isFile())
      return { status: 'exists', diagnostics: [{ code: 'OUTPUT_EXISTS', reason: 'exists', message: 'The destination already exists.' }] };
    return invalid('unsafe-destination', 'The destination must not be a link, directory or other non-file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return failed();
  }
  if (signal?.aborted) return cancelled();
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // Lost a creation race; classify the winner without touching its bytes.
      try {
        const winner = lstatSync(path);
        if (!winner.isSymbolicLink() && winner.isFile())
          return { status: 'exists', diagnostics: [{ code: 'OUTPUT_EXISTS', reason: 'exists', message: 'The destination already exists.' }] };
      } catch { /* fall through to the unsafe-destination refusal */ }
      return invalid('unsafe-destination', 'The destination must not be a link, directory or other non-file.');
    }
    if (code === 'ENOENT') return invalid('parent-missing', 'The report directory must already exist.');
    return failed();
  }
  let identity: CreatedIdentity | undefined;
  try {
    const stats = await handle.stat({ bigint: true });
    identity = { dev: stats.dev, ino: stats.ino };
    if (!stats.isFile() || stats.ino === 0n) throw new UnsafeDestination();
    if (!pinsMatch(pins)) throw new UnsafeParent();
    for (let offset = 0; offset < contents.length; offset += CHUNK_BYTES) {
      if (signal?.aborted) throw new AbortWrite();
      await handle.write(contents.subarray(offset, Math.min(offset + CHUNK_BYTES, contents.length)));
    }
    if (signal?.aborted) throw new AbortWrite();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    // Without the created identity the file cannot be safely attributed to
    // this invocation; retain it for user review rather than unlinking blindly.
    const cleanup = (): boolean => identity === undefined || removeCreated(path, identity);
    if (error instanceof UnsafeDestination) {
      cleanup();
      return invalid('unsafe-destination', 'The destination must not be a link, directory or other non-file.');
    }
    if (error instanceof UnsafeParent) {
      cleanup();
      return invalid('unsafe-parent', 'The report directory chain must not contain links.');
    }
    const wasCancelled = error instanceof AbortWrite || signal?.aborted === true;
    if (cleanup()) return failed('partial-report-retained', canonical);
    return wasCancelled ? cancelled() : failed();
  }
  // The file is complete and closed; a late abort must not undo it. Recheck
  // the pinned directory chain and the created identity before success.
  if (identity === undefined || !pinsMatch(pins) || !identityIntact(path, identity)) {
    if (identity === undefined || removeCreated(path, identity)) return failed('partial-report-retained', canonical);
    return failed();
  }
  return { status: 'written', path: canonical, diagnostics: [] };
}
