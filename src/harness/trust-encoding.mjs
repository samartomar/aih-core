// Deterministic certificate-set encodings. Serialization of PKCS#7 uses a maintained library
// (loaded lazily); parsing is an independent strict DER structure reader plus node:crypto.
import { createHash, X509Certificate } from 'node:crypto';
import { consumerProfiles } from './trust-definitions.mjs';

export const OUTPUT_LIMIT = 12_582_912;
export const PRIOR_OUTPUT_LIMIT = 16 * 1024 * 1024;
const CERT_LIMIT = 65_536;
const OID_SIGNED_DATA = [1, 2, 840, 113549, 1, 7, 2];
const OID_DATA = [1, 2, 840, 113549, 1, 7, 1];

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
const clean = (value, max = 256) => String(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, max);
const iso = text => { const time = Date.parse(text); return Number.isFinite(time) ? new Date(time).toISOString() : null; };

/** Parse one DER certificate; no trust decision is made here. */
export function describeCertificate(derInput) {
  const der = Buffer.from(derInput);
  if (der.length === 0 || der.length > CERT_LIMIT) return undefined;
  let cert;
  try { cert = new X509Certificate(der); } catch { return undefined; }
  if (!cert.raw.equals(der)) return undefined;
  const notBefore = iso(cert.validFrom); const notAfter = iso(cert.validTo);
  if (!notBefore || !notAfter) return undefined;
  return { fingerprint: sha256Hex(der), der: new Uint8Array(der), subject: clean(cert.subject), issuer: clean(cert.issuer),
    notBefore, notAfter, ca: cert.ca, extendedKeyUsage: cert.keyUsage ?? null };
}

const compareBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Unique certificates in the deterministic PEM order: lowercase DER SHA-256. */
export function orderByFingerprint(certificates) {
  const seen = new Map();
  for (const item of certificates) {
    const der = Buffer.from(item.der);
    seen.set(sha256Hex(der), der);
  }
  return [...seen.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([fingerprint, der]) => ({ fingerprint, der }));
}

export function encodePem(certificates) {
  return Buffer.from(orderByFingerprint(certificates).map(({ der }) => {
    const base64 = der.toString('base64');
    const lines = base64.match(/.{1,64}/g) ?? [];
    return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
  }).join(''), 'utf8');
}

const BEGIN = '-----BEGIN CERTIFICATE-----';
const END = '-----END CERTIFICATE-----';
const whitespace = /[ \t\r\n]/;

/** Parse a certificate-only PEM bundle (any prior managed or exported text). */
export function parsePemBundle(bytes, maxBytes = PRIOR_OUTPUT_LIMIT) {
  if (!(bytes instanceof Uint8Array)) return { status: 'invalid', reason: 'bytes-invalid' };
  if (bytes.byteLength > maxBytes) return { status: 'invalid', reason: 'output-byte-limit' };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { status: 'invalid', reason: 'utf8-invalid' }; }
  const found = new Map(); let position = 0;
  while (position < text.length) {
    while (position < text.length && whitespace.test(text[position])) position++;
    if (position >= text.length) break;
    if (!text.startsWith(BEGIN, position)) return { status: 'invalid', reason: 'pem-envelope' };
    const bodyStart = position + BEGIN.length;
    const end = text.indexOf(END, bodyStart);
    if (end < 0) return { status: 'invalid', reason: 'pem-end-missing' };
    const encoded = text.slice(bodyStart, end).replace(/[ \t\r\n]/g, '');
    if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return { status: 'invalid', reason: 'base64-invalid' };
    const der = Buffer.from(encoded, 'base64');
    if (der.toString('base64') !== encoded) return { status: 'invalid', reason: 'base64-noncanonical' };
    const described = describeCertificate(der);
    if (!described) return { status: 'invalid', reason: 'x509-invalid' };
    if (!found.has(described.fingerprint)) found.set(described.fingerprint, described);
    position = end + END.length;
  }
  if (!found.size) return { status: 'invalid', reason: 'source-empty' };
  return { status: 'parsed', certificates: [...found.values()] };
}

// ---- strict DER structure reader (independent of the serializer) ----------------------------

function tlv(buffer, offset, limit) {
  if (offset >= limit) throw new Error('der-truncated');
  const tag = buffer[offset];
  if ((tag & 0x1f) === 0x1f) throw new Error('der-high-tag');
  let cursor = offset + 1;
  if (cursor >= limit) throw new Error('der-truncated');
  let length = buffer[cursor++];
  if (length === 0x80) throw new Error('der-indefinite');
  if (length > 0x80) {
    const count = length & 0x7f;
    if (count < 1 || count > 4 || cursor + count > limit) throw new Error('der-length');
    if (buffer[cursor] === 0) throw new Error('der-length-minimal');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buffer[cursor++];
    if (length < 0x80) throw new Error('der-length-minimal');
  }
  const end = cursor + length;
  if (end > limit) throw new Error('der-truncated');
  return { tag, start: offset, valueStart: cursor, end };
}
function children(buffer, node) {
  const items = []; let cursor = node.valueStart;
  while (cursor < node.end) { const item = tlv(buffer, cursor, node.end); items.push(item); cursor = item.end; }
  return items;
}
function oidValue(buffer, node) {
  if (node.tag !== 0x06 || node.end === node.valueStart) throw new Error('der-oid');
  const parts = []; let value = 0;
  for (let i = node.valueStart; i < node.end; i++) {
    value = value * 128 + (buffer[i] & 0x7f);
    if (!(buffer[i] & 0x80)) { parts.push(value); value = 0; }
  }
  if (buffer[node.end - 1] & 0x80) throw new Error('der-oid');
  const first = parts.shift();
  return [Math.min(2, Math.floor(first / 40)), first - 40 * Math.min(2, Math.floor(first / 40)), ...parts];
}
const sameOid = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Strict parse of a certificates-only DER PKCS#7 container; any other shape is invalid. */
export function parsePkcs7(bytes) {
  if (!(bytes instanceof Uint8Array)) return { status: 'invalid', reason: 'bytes-invalid' };
  if (bytes.byteLength > OUTPUT_LIMIT) return { status: 'invalid', reason: 'output-byte-limit' };
  const buffer = Buffer.from(bytes);
  try {
    const outer = tlv(buffer, 0, buffer.length);
    if (outer.tag !== 0x30 || outer.end !== buffer.length) return { status: 'invalid', reason: 'pkcs7-structure' };
    const [contentType, explicit, ...extraOuter] = children(buffer, outer);
    if (extraOuter.length || !explicit || !sameOid(oidValue(buffer, contentType), OID_SIGNED_DATA) || explicit.tag !== 0xa0)
      return { status: 'invalid', reason: 'pkcs7-structure' };
    const [signed, ...extraExplicit] = children(buffer, explicit);
    if (extraExplicit.length || signed?.tag !== 0x30) return { status: 'invalid', reason: 'pkcs7-structure' };
    const [version, digests, encapsulated, certs, signers, ...unexpected] = children(buffer, signed);
    // Exactly: version, empty digests, content type only, certificates, no CRLs, empty signerInfos.
    if (unexpected.length || !version || version.tag !== 0x02 || version.end - version.valueStart !== 1 || buffer[version.valueStart] !== 1 ||
        digests?.tag !== 0x31 || digests.valueStart !== digests.end ||
        encapsulated?.tag !== 0x30 || certs?.tag !== 0xa0 || signers?.tag !== 0x31 || signers.valueStart !== signers.end)
      return { status: 'invalid', reason: 'pkcs7-structure' };
    const encap = children(buffer, encapsulated);
    if (encap.length !== 1 || !sameOid(oidValue(buffer, encap[0]), OID_DATA)) return { status: 'invalid', reason: 'pkcs7-content' };
    const found = new Map(); let previous;
    for (const item of children(buffer, certs)) {
      if (item.tag !== 0x30) return { status: 'invalid', reason: 'pkcs7-certificate' };
      const der = buffer.subarray(item.start, item.end);
      if (previous && Buffer.compare(previous, der) >= 0) return { status: 'invalid', reason: 'pkcs7-order' };
      previous = der;
      const described = describeCertificate(Buffer.from(der));
      if (!described) return { status: 'invalid', reason: 'x509-invalid' };
      found.set(described.fingerprint, described);
    }
    if (!found.size) return { status: 'invalid', reason: 'source-empty' };
    return { status: 'parsed', certificates: [...found.values()] };
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error && error.message.startsWith('der-') ? error.message : 'pkcs7-structure' };
  }
}

// ---- maintained serializer (lazy) ------------------------------------------------------------

const defaultBackend = async () => ({ pkijs: await import('pkijs'), asn1js: await import('asn1js') });

async function serializePkcs7(certificates, loadBackend) {
  let backend;
  try { backend = await loadBackend(); } catch { return undefined; }
  const { pkijs, asn1js } = backend;
  try {
    // DER SET OF ordering follows encoded bytes, not fingerprints.
    const ordered = [...certificates].sort((a, b) => compareBytes(a.der, b.der));
    const parsed = ordered.map(item => {
      const der = Buffer.from(item.der);
      const asn1 = asn1js.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength));
      if (asn1.offset === -1) throw new Error('certificate-asn1');
      return new pkijs.Certificate({ schema: asn1.result });
    });
    const signed = new pkijs.SignedData({ version: 1, encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: '1.2.840.113549.1.7.1' }), certificates: parsed });
    const info = new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: signed.toSchema(true) });
    return Buffer.from(info.toSchema().toBER(false));
  } catch { return undefined; }
}

/** Serialize the full set; failure is a precise unavailable result, never a substituted format. */
export async function serializeCertificateSet({ format, certificates }, internal = {}) {
  const unavailable = reason => ({ status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason });
  if (format !== 'pem' && format !== 'pkcs7-der') return unavailable('trust-format-unavailable');
  if (!Array.isArray(certificates) || certificates.some(item => !(item?.der instanceof Uint8Array))) return unavailable('trust-format-unavailable');
  const unique = orderByFingerprint(certificates);
  if (!unique.length) return unavailable('trust-output-empty');
  let bytes;
  if (format === 'pem') bytes = encodePem(unique);
  else bytes = await serializePkcs7(unique, internal.loadBackend ?? defaultBackend);
  if (!bytes) return unavailable('trust-format-unavailable');
  if (bytes.byteLength > OUTPUT_LIMIT) return { status: 'unavailable', code: 'SOURCE_LIMIT', reason: 'source-limit' };
  const reparsed = format === 'pem' ? parsePemBundle(bytes, OUTPUT_LIMIT) : parsePkcs7(bytes);
  const expected = unique.map(item => item.fingerprint);
  if (reparsed.status !== 'parsed' || reparsed.certificates.length !== expected.length ||
      reparsed.certificates.map(item => item.fingerprint).sort().join() !== expected.join()) return unavailable('trust-format-unavailable');
  if (format === 'pem' && !Buffer.from(bytes).equals(encodePem(reparsed.certificates))) return unavailable('trust-format-unavailable');
  return { status: 'serialized', bytes: new Uint8Array(bytes), sha256: sha256Hex(bytes), fingerprints: expected,
    certificateCount: expected.length, consumerProfile: consumerProfiles[format] };
}
