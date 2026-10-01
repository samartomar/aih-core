import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathPins, pinsMatch } from '../internal/host-files.js';
import { authenticateEvidence } from './authenticate.js';
import { selectTrust } from './trust.js';
import type { AssociateEvidenceInput, AssociateEvidenceControls, AssociationResult, EvidenceAssociation } from './types.js';
import { ArtifactError, artifactLimits, invalid, limited, object, text, validScanId } from './validation.js';

const acquisitionMs = 60_000;
const redirects = 5;
function unavailable(): never { throw new ArtifactError('invalid-input', 'unavailable'); }
function checkBudget(signal: AbortSignal, deadline: number): void {
  if (signal.aborted || Date.now() >= deadline) unavailable();
}
function httpsUrl(value: unknown): URL {
  const raw = text(value, 2048);
  if (/[\u0000-\u0020\u007f]/u.test(raw)) invalid();
  let url: URL;
  try { url = new URL(raw); } catch { invalid(); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.href.includes('#')) invalid();
  return url;
}
function associationFor(value: unknown): EvidenceAssociation {
  const association = object(value, ['schema', 'scanId', 'location']);
  if (association.schema !== 'urn:aihq:scan:evidence-association:1.0.0') invalid();
  const scanId = validScanId(association.scanId);
  const location = object(association.location, ['kind'], ['path', 'url']);
  if (location.kind === 'file') {
    object(location, ['kind', 'path']);
    const path = text(location.path, 4096);
    if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path) || path.split(/[\\/]/u).some(part => part === '.' || part === '..')) invalid();
    return { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId, location: { kind: 'file', path } };
  }
  if (location.kind === 'https') {
    object(location, ['kind', 'url']);
    const url = httpsUrl(location.url).href;
    return { schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId, location: { kind: 'https', url } };
  }
  invalid();
}
function stable(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    right.isFile() && right.ino !== 0n && right.nlink === 1n;
}
function readFile(path: string, signal: AbortSignal, deadline: number): Uint8Array {
  checkBudget(signal, deadline);
  const pins = pathPins(path);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.ino === 0n || before.nlink !== 1n) unavailable();
  if (before.size > BigInt(artifactLimits.artifact)) limited();
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!stable(before, fstatSync(descriptor, { bigint: true })) || !pinsMatch(pins)) unavailable();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      checkBudget(signal, deadline);
      const count = readSync(descriptor, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (count === 0) unavailable();
      offset += count;
    }
    checkBudget(signal, deadline);
    if (!stable(before, fstatSync(descriptor, { bigint: true })) ||
        !stable(before, lstatSync(path, { bigint: true })) || !pinsMatch(pins)) unavailable();
    return bytes;
  } finally { closeSync(descriptor); }
}
async function readHttps(location: string, signal: AbortSignal, deadline: number, bearer?: string): Promise<Uint8Array> {
  let url = httpsUrl(location);
  const origin = url.origin;
  for (let followed = 0; ; followed++) {
    checkBudget(signal, deadline);
    const response = await fetch(url, { redirect: 'manual', signal, credentials: 'omit',
      headers: { Accept: 'application/json', ...(bearer && url.origin === origin ? { Authorization: `Bearer ${bearer}` } : {}) } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (followed >= redirects) unavailable();
      const location = response.headers.get('location');
      if (!location) unavailable();
      url = httpsUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); unavailable(); }
    const length = response.headers.get('content-length');
    if (length && /^[0-9]+$/.test(length) && BigInt(length) > BigInt(artifactLimits.artifact)) {
      await response.body.cancel(); limited();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        checkBudget(signal, deadline);
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > artifactLimits.artifact) limited();
        chunks.push(value);
      }
      checkBudget(signal, deadline);
      return Buffer.concat(chunks, total);
    } finally { await reader.cancel().catch(() => {}); }
  }
}

export async function associateEvidence(input: AssociateEvidenceInput, controls: AssociateEvidenceControls = {}): Promise<AssociationResult> {
  let scanId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let acquiring = false;
  try {
    const supplied = object(input, [], ['association', 'acquire', 'trust']);
    if (supplied.association === undefined) return { status: 'skipped', reason: 'not-supplied' };
    const association = associationFor(supplied.association);
    scanId = association.scanId;
    if (supplied.acquire !== undefined && typeof supplied.acquire !== 'boolean') invalid();
    if (supplied.acquire !== true) return { scanId, status: 'skipped', reason: 'not-requested' };
    const selectedControls = object(controls, [], ['signal', 'authentication']);
    if (selectedControls.signal !== undefined && !(selectedControls.signal instanceof AbortSignal)) invalid();
    let bearer: string | undefined;
    if (selectedControls.authentication !== undefined) {
      const authentication = object(selectedControls.authentication, ['kind'], ['token']);
      if (authentication.kind === 'none') object(authentication, ['kind']);
      else if (authentication.kind === 'bearer') {
        object(authentication, ['kind', 'token']);
        bearer = text(authentication.token, 8192);
        if (/[\u0000-\u0020\u007f]/u.test(bearer)) invalid();
      } else invalid();
    }
    // Capture the caller-selected policy before any awaited acquisition. A
    // later mutation of host input cannot rotate trust during this request.
    const trust = selectTrust(supplied.trust ?? { keys: [], publishers: [] }).trust;
    const controller = new AbortController();
    const deadline = Date.now() + acquisitionMs;
    timer = setTimeout(() => controller.abort(), acquisitionMs);
    const signal = selectedControls.signal === undefined ? controller.signal :
      AbortSignal.any([controller.signal, selectedControls.signal as AbortSignal]);
    acquiring = true;
    const bytes = association.location.kind === 'file' ? readFile(association.location.path, signal, deadline) :
      await readHttps(association.location.url, signal, deadline, bearer);
    return await authenticateEvidence({ bytes, expectedScanId: scanId, trust });
  } catch (error) {
    const reason = error instanceof ArtifactError ? error.reason :
      error instanceof Error && 'code' in error && error.code === 'resource-limit' ? 'resource-limit' :
      acquiring ? 'unavailable' : 'malformed';
    return { ...(scanId ? { scanId } : {}), status: 'unverifiable',
      reason };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
