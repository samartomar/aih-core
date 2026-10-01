import { publisherRecords } from './scan-trust.mjs';
import { snapshotTrustData, boundedBase64 } from './trust-data.mjs';

const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
export const verificationPublishers = freeze(publisherRecords);
const diagnostic = (reason, path = '') => ({ code: 'INPUT_INVALID', reason, path,
  message: 'Select bounded plain publisher records with an explicit literal identity policy and independent roots.' });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));
const fields = (value, names) => plain(value) && Object.keys(value).length === names.length &&
  names.every(name => Object.hasOwn(value, name));
const boundedText = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit &&
  new TextEncoder().encode(value).length <= limit && value.isWellFormed() && value.normalize('NFC') === value && !/[\x00-\x1f\x7f]/.test(value);
const label = value => boundedText(value, 256);
const literal = value => boundedText(value, 2048);

function requireShape(value, required, optional = []) {
  if (!plain(value) || !required.every(key => Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => ![...required, ...optional].includes(key))) throw new Error('trust-shape');
}
function list(value, limit) {
  if (!Array.isArray(value) || value.length > limit) throw new Error('trust-limit');
  return value;
}
function timeRange(value) {
  requireShape(value, ['start'], ['end']);
  for (const time of Object.values(value)) {
    if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(time)) throw new Error('trust-time');
    const parsed = Date.parse(time);
    const normalized = time.includes('.') ? time.replace(/\.(\d{1,3})Z$/, (_, part) => `.${part.padEnd(3, '0')}Z`) : time.replace(/Z$/, '.000Z');
    if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== normalized) throw new Error('trust-time');
  }
  if (value.end !== undefined && Date.parse(value.end) < Date.parse(value.start)) throw new Error('trust-time');
}
function rootShape(root) {
  requireShape(root, ['mediaType'], ['tlogs', 'ctlogs', 'certificateAuthorities', 'timestampAuthorities']);
  if (!['application/vnd.dev.sigstore.trustedroot+json;version=0.1',
    'application/vnd.dev.sigstore.trustedroot.v0.1+json', 'application/vnd.dev.sigstore.trustedroot.v0.2+json'].includes(root.mediaType)) throw new Error('trust-root');
  for (const category of ['tlogs', 'ctlogs']) for (const log of list(root[category] ?? [], 64)) {
    requireShape(log, ['baseUrl', 'hashAlgorithm', 'publicKey', 'logId'], ['checkpointKeyId', 'operator']);
    if (!literal(log.baseUrl) || log.hashAlgorithm !== 'SHA2_256' || log.operator !== undefined && !label(log.operator)) throw new Error('trust-log');
    requireShape(log.logId, ['keyId']); boundedBase64(log.logId.keyId, 32, 32);
    if (log.checkpointKeyId !== undefined) { requireShape(log.checkpointKeyId, ['keyId']); boundedBase64(log.checkpointKeyId.keyId, 4, 4); }
    requireShape(log.publicKey, ['rawBytes', 'keyDetails', 'validFor']);
    if (!label(log.publicKey.keyDetails) || !boundedBase64(log.publicKey.rawBytes, 4096).length) throw new Error('trust-key');
    timeRange(log.publicKey.validFor);
  }
  for (const category of ['certificateAuthorities', 'timestampAuthorities']) for (const ca of list(root[category] ?? [], 64)) {
    requireShape(ca, ['uri', 'certChain', 'validFor'], ['subject', 'operator']);
    if (!literal(ca.uri) || ca.operator !== undefined && !label(ca.operator)) throw new Error('trust-ca');
    if (ca.subject !== undefined) { requireShape(ca.subject, [], ['organization', 'commonName']); if (!Object.values(ca.subject).every(label)) throw new Error('trust-subject'); }
    timeRange(ca.validFor); requireShape(ca.certChain, ['certificates']);
    const certificates = list(ca.certChain.certificates, 8);
    if (!certificates.length) throw new Error('trust-chain');
    for (const certificate of certificates) { requireShape(certificate, ['rawBytes']); if (!boundedBase64(certificate.rawBytes, 32768).length) throw new Error('trust-certificate'); }
  }
}

export function validateVerificationPublisherRecords(records) {
  try {
    records = snapshotTrustData(records);
    if (!Array.isArray(records) || records.length > 32) return { valid: false, diagnostics: [diagnostic('records-count')] };
    for (const [index, record] of records.entries()) {
      if (!fields(record, ['profile', 'identity', 'purposes', 'trustedRoot', 'policy']) ||
          record.profile !== 'sigstore-public' || !label(record.identity) ||
          !Array.isArray(record.purposes) || record.purposes.length !== 1 || record.purposes[0] !== 'scan-report' ||
          !plain(record.trustedRoot) || !fields(record.policy, ['issuer', 'subjectAlternativeName', 'requiredCertificateExtensions']) ||
          !literal(record.policy.issuer) || !literal(record.policy.subjectAlternativeName) ||
          !Array.isArray(record.policy.requiredCertificateExtensions))
        return { valid: false, diagnostics: [diagnostic('record-shape', `/${index}`)] };
      rootShape(record.trustedRoot);
      const seen = new Set();
      for (const extension of list(record.policy.requiredCertificateExtensions, 16)) {
        requireShape(extension, ['oid', 'valueDerBase64']);
        const oid = list(extension.oid, 32);
        if (oid.length < 2 || oid.some(arc => !Number.isSafeInteger(arc) || arc < 0 || arc > 4294967295) ||
            oid[0] > 2 || oid[0] < 2 && oid[1] > 39 || seen.has(oid.join('.'))) throw new Error('trust-oid');
        seen.add(oid.join('.')); boundedBase64(extension.valueDerBase64, 4096);
      }
    }
    return { valid: true, diagnostics: [] };
  } catch { return { valid: false, diagnostics: [diagnostic('record-shape')] }; }
}

export function selectVerificationPublishers(purpose, records = verificationPublishers) {
  if (purpose !== 'scan-report') return { status: 'invalid', diagnostics: [diagnostic('purpose-unsupported', '/purpose')] };
  try {
    const snapshot = snapshotTrustData(records);
    const validation = validateVerificationPublisherRecords(snapshot);
    if (!validation.valid) return { status: 'invalid', diagnostics: validation.diagnostics };
    return { status: 'selected', publishers: freeze(snapshot) };
  } catch { return { status: 'invalid', diagnostics: [diagnostic('record-shape')] }; }
}
