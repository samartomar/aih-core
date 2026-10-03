// Exclusive creation of an explicitly requested Markdown report file.
// The destination is caller-chosen: no default name, suffix selection,
// directory creation, overwrite, history entry or share/upload happens here.
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathPins, pinsMatch, validSegment, type PathPin } from './host-files.js';
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
    'A partial report may remain at this path; review it before deleting anything.' : 'The report could not be written safely.',
    ...(path === undefined ? {} : { path }) }]
});
const cancelled = (): ReportFileResult =>
  ({ status: 'cancelled', diagnostics: [{ code: 'CANCELLED', reason: 'cancelled', message: 'The report write was cancelled.' }] });

interface CreatedIdentity { dev: bigint; ino: bigint }

/** Attribute the path only while a live descriptor prevents inode reuse. */
function identityIntact(path: string, identity: CreatedIdentity, descriptor: number): boolean {
  try {
    const held = fstatSync(descriptor, { bigint: true });
    if (!held.isFile() || held.nlink === 0n || identity.ino === 0n ||
        held.dev !== identity.dev || held.ino !== identity.ino) return false;
    const current = lstatSync(path, { bigint: true });
    return !current.isSymbolicLink() && current.isFile() &&
      current.dev === identity.dev && current.ino === identity.ino;
  } catch { return false; }
}

/** Remove only the file this invocation created. Returns true when it was retained. */
function removeCreated(path: string, identity: CreatedIdentity, descriptor: number): boolean {
  try {
    if (!identityIntact(path, identity, descriptor)) return true;
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
  // validSegment also refuses Windows alternate data streams and reserved device names.
  if (typeof path !== 'string' || !isAbsolute(path) || /\p{Cc}/u.test(path) || !/\.md$/i.test(path) ||
      !validSegment(basename(path)))
    return invalid('invalid-path', 'Use an absolute path ending in .md with a plain file name and no control characters.');
  const directory = dirname(path);
  let pins: PathPin[];
  try { pins = pathPins(directory); }
  catch { return invalid('unsafe-parent', 'The report directory chain must be accessible and must not contain links.'); }
  if (pins.at(-1)?.identity === 'absent')
    return invalid('parent-missing', 'The report directory must already exist.');
  let directoryStats;
  try { directoryStats = lstatSync(directory); }
  catch { return failed(); }
  if (!directoryStats.isDirectory())
    return invalid('parent-not-directory', 'The report path parent must be a directory.');
  let canonical: string;
  try { canonical = join(realpathSync.native(directory), basename(path)); }
  catch { return failed(); }
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
  let completionPin: number | undefined;
  let completed = false;
  const cleanup = (): boolean => identity === undefined || !pinsMatch(pins) ||
    removeCreated(path, identity, completionPin ?? handle.fd);
  try {
    const stats = await handle.stat({ bigint: true });
    identity = { dev: stats.dev, ino: stats.ino };
    if (!stats.isFile() || stats.ino === 0n) throw new UnsafeDestination();
    if (!pinsMatch(pins)) throw new UnsafeParent();
    for (let offset = 0; offset < contents.length;) {
      if (signal?.aborted) throw new AbortWrite();
      const { bytesWritten } = await handle.write(contents, offset, Math.min(CHUNK_BYTES, contents.length - offset));
      if (bytesWritten < 1) throw new Error('report-write-stalled');
      offset += bytesWritten;
    }
    if (signal?.aborted) throw new AbortWrite();
    // Keep the inode allocated across async close and its final path check. A
    // stale dev/ino snapshot alone could match an unrelated replacement file.
    if (!identityIntact(path, identity, handle.fd)) throw new UnsafeDestination();
    completionPin = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
    if (!identityIntact(path, identity, completionPin)) throw new UnsafeDestination();
    await handle.close();
    // A late abort must not undo the complete, closed file. The pin still holds
    // its identity while checking the path and any required cleanup.
    if (!pinsMatch(pins) || !identityIntact(path, identity, completionPin)) {
      if (cleanup()) return failed('partial-report-retained', canonical);
      return failed();
    }
    completed = true;
    return { status: 'written', path: canonical, diagnostics: [] };
  } catch (error) {
    // Without the created identity the file cannot be safely attributed to
    // this invocation. Cleanup must run before releasing its live descriptor.
    // A created file that cannot be removed safely is always reported with its path.
    if (error instanceof UnsafeDestination) {
      if (cleanup()) return failed('partial-report-retained', canonical);
      return invalid('unsafe-destination', 'The destination must not be a link, directory or other non-file.');
    }
    if (error instanceof UnsafeParent) {
      if (cleanup()) return failed('partial-report-retained', canonical);
      return invalid('unsafe-parent', 'The report directory chain must be accessible and must not contain links.');
    }
    const wasCancelled = error instanceof AbortWrite || signal?.aborted === true;
    if (cleanup()) return failed('partial-report-retained', canonical);
    return wasCancelled ? cancelled() : failed();
  } finally {
    if (handle.fd !== -1) await handle.close().catch(() => undefined);
    if (completionPin !== undefined) {
      try { closeSync(completionPin); }
      catch {
        // Release uncertainty blocks success without hiding an earlier failure
        // or retained-path diagnostic. Do not attempt another path mutation.
        if (completed) return failed('partial-report-retained', canonical);
      }
    }
  }
}
