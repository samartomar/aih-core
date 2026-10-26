// Bounded local organization-policy reader: one caller-selected regular file, read offline with no network access.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, isAbsolute, normalize } from 'node:path';
import { contractSupport } from './contracts.mjs';

const MAX_FILE_BYTES = 1_000_000;
const helper = Object.freeze({ id: 'local-policy-reader', package: contractSupport.package });

const isPlainObject = value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const deepFreeze = value => {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
};

function validateSource(source) {
  if (!isPlainObject(source) || Object.keys(source).length !== 2 || source.provider !== 'local' || !Object.hasOwn(source, 'path')) return undefined;
  const { path } = source;
  if (typeof path !== 'string' || path.length === 0 || new TextEncoder().encode(path).length > 4096 || /[\x00-\x1f\x7f]/.test(path) ||
      !isAbsolute(path) || normalize(path) !== path || basename(path) === '') return undefined;
  return Object.freeze({ provider: 'local', path });
}

/** Internal admission check shared with Core's removal preflight. */
export function validLocalPolicySource(source) { return validateSource(source) !== undefined; }

/** The source a person reads in a review: the file name only, never its folder. */
export function localPolicySourceLabel(source) { return Object.freeze({ provider: 'local', fileName: basename(source.path) }); }

const failure = (source, reason, message) => deepFreeze({ status: 'unavailable', code: 'AUTHORITY_UNAVAILABLE', reason, message,
  ...(source ? { source } : {}), helper });

/**
 * Reads one organization document from an absolute local path. The path must name a regular file (not a link), at most
 * 1,000,000 bytes, whose identity does not change while it is read. Nothing else is read, discovered or cached.
 */
export async function readLocalPolicy(source, controls) {
  const normalized = validateSource(source);
  const signal = controls === undefined ? undefined : controls.signal;
  if (!normalized || controls !== undefined && (!isPlainObject(controls) || !Object.keys(controls).every(key => key === 'signal') ||
      signal !== undefined && !(signal instanceof AbortSignal)))
    return deepFreeze({ status: 'invalid', code: 'INPUT_INVALID', reason: 'source-invalid',
      message: 'The organization-policy source or reader controls are structurally invalid.', helper });
  const cancelled = () => deepFreeze({ status: 'cancelled', code: 'CANCELLED', reason: 'cancelled',
    message: 'The read was cancelled by the caller.', source: normalized, helper });
  if (signal?.aborted) return cancelled();
  let before;
  try { before = await lstat(normalized.path); }
  catch { return failure(normalized, 'source-missing-or-inaccessible', 'The selected local organization document cannot be read.'); }
  if (!before.isFile()) return failure(normalized, 'source-not-regular-file', 'The selected path is not a regular file.');
  if (before.size > MAX_FILE_BYTES) return failure(normalized, 'response-bytes', 'The selected file exceeds the 1,000,000-byte bound.');
  let handle;
  try {
    handle = await open(normalized.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      return failure(normalized, 'source-not-regular-file', 'The selected file changed while it was opened.');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      if (signal?.aborted) return cancelled();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_FILE_BYTES) return failure(normalized, 'response-bytes', 'The selected file exceeds the 1,000,000-byte bound.');
    }
    const bytes = new Uint8Array(buffer.subarray(0, length));
    return deepFreeze({ status: 'read', source: normalized, bytes,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, helper });
  } catch {
    return failure(normalized, 'source-missing-or-inaccessible', 'The selected local organization document cannot be read.');
  } finally { await handle?.close(); }
}
