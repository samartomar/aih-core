import { verificationKeys, verificationPublishers, selectVerificationKeys,
  selectVerificationPublishers } from './contracts.mjs';

const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const shipped = freeze({ verificationKeys, verificationPublishers, scanEvidencePolicies: [], revocations: [] });
/** Reading a snapshot never refreshes trust. Omitted snapshot means shipped trust. */
export function getTrustSnapshot() { return shipped; }
/** Historical authentication deliberately ignores current revocations. */
export async function getVerificationTrust(snapshot = shipped) {
  snapshot = snapshotTrustData(snapshot);
  const keys = await selectVerificationKeys('scan-report', snapshot.verificationKeys);
  const publishers = selectVerificationPublishers('scan-report', snapshot.verificationPublishers);
  if (keys.status !== 'selected' || publishers.status !== 'selected') throw new Error('trust-records-invalid');
  return freeze({ keys: keys.keys, publishers: publishers.publishers });
}

import { Updater } from 'tuf-js';
// Pinned tuf-js 6.0.0 exposes the default transport from this shipped module.
import { DefaultFetcher } from 'tuf-js/dist/fetcher.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync,
  lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { snapshotTrustData } from './trust-data.mjs';

const schema = 'urn:aihq:harness:trust-update:1.0.0';
const limit = 1048576;
const sha = value => createHash('sha256').update(value).digest('hex');
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
function endpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new Error('trust-source-url-invalid');
  return url.href;
}
function readJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('trust-cache-invalid');
  return snapshotTrustData(JSON.parse(readFileSync(path, 'utf8')));
}
async function admit(value) {
  value = snapshotTrustData(value);
  if (value.schema !== schema || !(await selectVerificationKeys('scan-report', value.verificationKeys)).keys ||
      selectVerificationPublishers('scan-report', value.verificationPublishers).status !== 'selected' ||
      !Array.isArray(value.scanEvidencePolicies) || value.scanEvidencePolicies.length > 32 ||
      value.scanEvidencePolicies.some(p => p?.schema !== 'urn:aihq:scan:evidence-policy:1.0.0') ||
      !Array.isArray(value.revocations) || value.revocations.length > 160 ||
      value.revocations.some(r => !r || !['key', 'publisher'].includes(r.kind) || !label(r.id) || Object.keys(r).length !== 2))
    throw new Error('trust-update-invalid');
  // Unknown downloaded fields, including authority/source hints, are never copied.
  let catalogTufRootBase64;
  if (value.catalogTufRootBase64 !== undefined) {
    if (typeof value.catalogTufRootBase64 !== 'string' || value.catalogTufRootBase64.length > limit / 2)
      throw new Error('catalog-root-invalid');
    const bytes = Buffer.from(value.catalogTufRootBase64, 'base64');
    if (!bytes.length || bytes.toString('base64') !== value.catalogTufRootBase64) throw new Error('catalog-root-invalid');
    const root = JSON.parse(bytes.toString('utf8'));
    if (root.signed?._type !== 'root') throw new Error('catalog-root-invalid');
    catalogTufRootBase64 = value.catalogTufRootBase64;
  }
  return { verificationKeys: value.verificationKeys, verificationPublishers: value.verificationPublishers,
    scanEvidencePolicies: value.scanEvidencePolicies, revocations: value.revocations,
    ...(catalogTufRootBase64 ? { catalogTufRootBase64 } : {}) };
}
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function retain(previous, next, key) {
  const records = new Map(previous.map(record => [key(record), record]));
  for (const record of next) {
    const id = key(record), prior = records.get(id);
    // Previously accepted records cannot be rewritten: retain their exact policy.
    if (prior && canonical(prior) !== canonical(record)) throw new Error('historical-trust-conflict');
    records.set(id, record);
  }
  return [...records.values()];
}
/** Explicitly selected Node client. Construction performs local IO, never network IO. */
export function createTufTrustClient(options) {
  const { cacheDir, targetPath } = options;
  if (!isAbsolute(cacheDir) || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.json$/.test(targetPath))
    throw new Error('trust-source-invalid');
  if (!(options.root instanceof Uint8Array) || !options.root.length || options.root.length > limit)
    throw new Error('trust-root-invalid');
  const root = Buffer.from(options.root);
  const metadataBaseUrl = endpoint(options.metadataBaseUrl), targetBaseUrl = endpoint(options.targetBaseUrl);
  const pin = { rootSha256: sha(root), metadataBaseUrl, targetBaseUrl, targetPath };
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  if (lstatSync(cacheDir).isSymbolicLink()) throw new Error('trust-cache-invalid');
  const pinPath = join(cacheDir, 'source.json');
  for (const entry of readdirSync(cacheDir)) {
    if (!lstatSync(join(cacheDir, entry)).isFile()) throw new Error('trust-cache-invalid');
  }
  if (existsSync(pinPath)) {
    if (JSON.stringify(readJson(pinPath)) !== JSON.stringify(pin)) throw new Error('trust-source-mismatch');
  } else {
    if (readdirSync(cacheDir).length) throw new Error('trust-cache-not-empty');
    // A cache is dedicated to one independently configured source for its lifetime.
    writeFileSync(pinPath, JSON.stringify(pin), { flag: 'wx', mode: 0o600 });
    writeFileSync(join(cacheDir, 'root.json'), root, { flag: 'wx', mode: 0o600 });
  }
  return Object.freeze({ async update() {
    const lock = join(cacheDir, 'update.lock');
    const fd = openSync(lock, 'wx', 0o600);
    try {
      const transport = new DefaultFetcher({ timeout: 10000, retry: false });
      // Signed metadata can advertise lengths larger than the configured fallback.
      // Bound every transfer independently, including those advertised lengths.
      const boundedLength = length => Math.min(limit, length);
      const fetcher = {
        downloadBytes: (url, length) => transport.downloadBytes(url, boundedLength(length)),
        downloadFile: (url, length, handler) => transport.downloadFile(url, boundedLength(length), handler)
      };
      const updater = new Updater({ metadataDir: cacheDir, metadataBaseUrl, targetBaseUrl, fetcher,
        config: { maxRootRotations: 32, maxDelegations: 32, rootMaxLength: limit,
          timestampMaxLength: limit, snapshotMaxLength: limit, targetsMaxLength: limit,
          fetchTimeout: 10000, fetchRetries: 0 } });
      await updater.refresh();
      const info = await updater.getTargetInfo(targetPath);
      if (!info || info.length > limit) throw new Error('trust-target-unavailable');
      const targetFile = join(cacheDir, 'download.json');
      await updater.downloadTarget(info, targetFile);
      const current = await admit(readJson(targetFile));
      const historyFile = join(cacheDir, 'history.json');
      const previous = existsSync(historyFile) ? await admit({ ...readJson(historyFile), schema }) : shipped;
      const snapshot = { ...current,
        verificationKeys: retain(previous.verificationKeys, current.verificationKeys, r => r.keyId),
        verificationPublishers: retain(previous.verificationPublishers, current.verificationPublishers, canonical) };
      // Validate combined inventories against the same bounds as static selection.
      await getVerificationTrust(snapshot);
      writeFileSync(join(cacheDir, 'history.next'), JSON.stringify(snapshot), { mode: 0o600 });
      renameSync(join(cacheDir, 'history.next'), historyFile);
      return freeze(snapshot);
    } finally { closeSync(fd); unlinkSync(lock); }
  } });
}

/** Current status is separate from historical authentication and never filters its keys. */
export function getCurrentTrustStatus(snapshot = shipped, { keyId, publisherIdentity } = {}) {
  if (snapshot.revocations.some(r => r.kind === 'key' && r.id === keyId ||
      r.kind === 'publisher' && r.id === publisherIdentity)) return 'revoked';
  return snapshot.verificationKeys.some(r => r.keyId === keyId) ||
    snapshot.verificationPublishers.some(r => r.identity === publisherIdentity) ? 'current' : 'unknown';
}
/** Named handoff to Catalog readReleaseIndex sources[].trust. Framework authority stays host-selected. */
export function getCatalogIndexTrust(snapshot = shipped) {
  return snapshot.catalogTufRootBase64 ? { tufRoot: new Uint8Array(Buffer.from(snapshot.catalogTufRootBase64, 'base64')) } : 'none';
}
