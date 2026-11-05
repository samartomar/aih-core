// Bounded HTTPS downloads with the machine's own Node trust (C36): https only, redirects followed only to https, the
// declared length and sha256 checked, and a byte bound and deadline enforced while reading.
import { createHash } from 'node:crypto';
import { limitValue } from '../limits.js';
import type { Download } from './types.js';

export class AcquireError extends Error { constructor(readonly reason: string) { super(reason); } }
const TLS_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE', 'CERT_REVOKED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE']);
/** Whether a fetch failure is the certificate chain not being trusted here. */
export function isTlsFailure(error: unknown): boolean {
  for (let cause: unknown = error, depth = 0; cause && depth < 5; cause = (cause as { cause?: unknown }).cause, depth++)
    if (TLS_CODES.has((cause as { code?: string }).code ?? '')) return true;
  return false;
}
async function open(url: string, method: 'GET' | 'HEAD', signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    if (!current.startsWith('https://')) throw new AcquireError('download-insecure');
    let response: Response;
    try { response = await fetch(current, { method, redirect: 'manual', signal }); }
    catch (error) {
      if (signal.aborted) throw new AcquireError('cancelled');
      throw new AcquireError(isTlsFailure(error) ? 'tls-untrusted' : 'download-failed');
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel();
      current = new URL(response.headers.get('location')!, current).href; continue;
    }
    return response;
  }
  throw new AcquireError('download-failed');
}
/**
 * Prepare's reachability probe: `tls-untrusted` when this host's trust rejects the server's certificate; any other
 * outcome (including a refused connection) is left to Apply, whose download fails the step.
 */
export async function probe(url: string, signal?: AbortSignal): Promise<'ok' | 'tls-untrusted'> {
  const timeout = AbortSignal.timeout(15_000);
  try { const response = await open(url, 'HEAD', signal ? AbortSignal.any([signal, timeout]) : timeout); await response.body?.cancel(); return 'ok'; }
  catch (error) { return error instanceof AcquireError && error.reason === 'tls-untrusted' ? 'tls-untrusted' : 'ok'; }
}
/** A server's answer that the file is not there: nothing obtainable from this source (C78). */
const absent = (status: number): boolean => status === 404 || status === 410;
/**
 * One bounded JSON answer from an index (C78), or `null` when the index has no such release. Any other failure is a
 * download failure; the answer is data, never trusted beyond the exact file and sha256 Core looks for in it.
 */
export async function fetchJson(url: string, options: { signal?: AbortSignal; deadlineMs: number }): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.deadlineMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await open(url, 'GET', signal);
  if (absent(response.status)) { await response.body?.cancel(); return null; }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new AcquireError('download-failed'); }
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch { throw new AcquireError(options.signal?.aborted ? 'cancelled' : timeout.aborted ? 'acquisition-deadline' : 'download-failed'); }
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > 16 * 1_048_576) throw new AcquireError('download-failed');
      parts.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(parts, length).toString('utf8')); } catch { throw new AcquireError('download-failed'); }
}
/** Downloads one artifact from `url`; any other byte than the planned ones is `artifact-mismatch`. */
export async function downloadBytes(item: Download & { url: string }, options: { signal?: AbortSignal; deadlineMs: number; onBytes?: (bytes: number) => void }): Promise<Buffer> {
  const timeout = AbortSignal.timeout(options.deadlineMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const bound = limitValue('artifact-bytes');
  const response = await open(item.url, 'GET', signal);
  if (absent(response.status)) { await response.body?.cancel(); throw new AcquireError('artifact-unavailable'); }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new AcquireError('download-failed'); }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = []; const hash = createHash('sha256'); let length = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch { throw new AcquireError(options.signal?.aborted ? 'cancelled' : timeout.aborted ? 'acquisition-deadline' : 'download-failed'); }
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > bound || item.bytes !== null && length > item.bytes) throw new AcquireError('artifact-mismatch');
      hash.update(chunk.value); parts.push(chunk.value);
      options.onBytes?.(length);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (item.bytes !== null && length !== item.bytes || hash.digest('hex') !== item.sha256) throw new AcquireError('artifact-mismatch');
  return Buffer.concat(parts, length);
}
/** Supplied or other bytes checked against the planned length and sha256 (C78). */
export function checkBytes(item: Download, bytes: Buffer): Buffer {
  if (item.bytes !== null && bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new AcquireError('artifact-mismatch');
  return bytes;
}
