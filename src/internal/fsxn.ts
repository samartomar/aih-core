// Adapted from ai-harness f5d5f84b9006b628778983dab56dd92dc8888156 (Apache-2.0).
import { type BigIntStats, type Stats, constants as fsConstants, openSync, closeSync, fstatSync, lstatSync, readFileSync, readSync } from 'node:fs';
const TRANSIENT_LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const MAX_LOCK_RETRIES = 10;

/** Sleep the current thread synchronously (every fs call below is sync). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a synchronous fs operation, retrying ONLY the transient Windows lock codes
 * in {@link TRANSIENT_LOCK_CODES} with a short bounded backoff (~0.5s worst case).
 * Any other error — `EEXIST` from an exclusive create, a genuine `EACCES` on a
 * locked-down path that never clears — is re-thrown on its first occurrence, so
 * this absorbs the sub-millisecond scanner window without ever masking a real
 * failure. The retry preserves the caller's atomicity/rollback guarantees: it
 * re-issues the same single syscall, nothing more.
 *
 * Exported for direct unit testing — the FS-level retry is exercised through the
 * real filesystem elsewhere, but a transient lock cannot be reproduced on demand,
 * so the retry/give-up/passthrough contract is pinned here.
 */
export function retryTransient<T>(op: () => T): T {
  let delayMs = 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return op();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code !== undefined && TRANSIENT_LOCK_CODES.has(code);
      if (!transient || attempt >= MAX_LOCK_RETRIES) throw err;
      sleepSync(delayMs);
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
}


const O_NOFOLLOW = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
const HAS_O_NOFOLLOW = O_NOFOLLOW !== 0;
/** `O_NONBLOCK` where exposed; a no-op for regular files and prompt refusal for FIFOs. */
const O_NONBLOCK = (fsConstants as Record<string, number | undefined>).O_NONBLOCK ?? 0;


export function readRegularFileWithStats(
  abs: string,
  options: { maxBytes?: number } = {},
):
  | {
      contents: Buffer;
      /** Ordinary descriptor stats retained for existing numeric consumers. */
      stats: Stats;
      /** BigInt identity/link facts from the same descriptor as {@link contents}. */
      identity: Pick<BigIntStats, "dev" | "ino" | "nlink">;
    }
  | undefined {
  let fd: number;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK, 0o600);
  } catch {
    return undefined;
  }
  try {
    const stats = fstatSync(fd);
    const identity = fstatSync(fd, { bigint: true });
    if (!stats.isFile() || !identity.isFile()) return undefined;
    if (options.maxBytes !== undefined && stats.size > options.maxBytes) return undefined;
    if (!HAS_O_NOFOLLOW && !openedPathStillNamesFile(abs, fd)) return undefined;
    const contents =
      options.maxBytes === undefined
        ? readFileSync(fd)
        : readBoundedFileDescriptor(fd, options.maxBytes);
    return contents === undefined
      ? undefined
      : {
          contents,
          identity: { dev: identity.dev, ino: identity.ino, nlink: identity.nlink },
          stats,
        };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read at most `maxBytes + 1` bytes from an already-open descriptor. The extra
 * byte distinguishes an exact-boundary file from one that grew after an earlier
 * `fstat`; returning `undefined` keeps the caller's byte cap effective during
 * the read instead of only before it.
 */
export function readBoundedFileDescriptor(fd: number, maxBytes: number): Buffer | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError("maxBytes must be a non-negative safe integer");
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
    const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > maxBytes) return undefined;
    chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
  }
  return undefined;
}

function openedPathStillNamesFile(path: string, fd: number): boolean {
  let opened: BigIntStats;
  let current: BigIntStats;
  try {
    opened = fstatSync(fd, { bigint: true });
    current = lstatSync(path, { bigint: true });
  } catch {
    return false;
  }
  if (!opened.isFile() || current.isSymbolicLink() || !current.isFile()) return false;
  return sameBigIntFileIdentity(opened, current);
}

function sameBigIntFileIdentity(
  a: Pick<BigIntStats, "dev" | "ino">,
  b: Pick<BigIntStats, "dev" | "ino">,
): boolean {
  if (a.dev !== b.dev) return false;
  if (a.ino === 0n || b.ino === 0n) return false;
  return a.ino === b.ino;
}

export function readRegularFile(
  abs: string,
  options: { maxBytes?: number } = {},
): Buffer | undefined {
  return readRegularFileWithStats(abs, options)?.contents;
}
