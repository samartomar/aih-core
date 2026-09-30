import { createHash, X509Certificate } from 'node:crypto';
import tls from 'node:tls';

const MAX_SOURCE = 1_048_576;
const MAX_BLOCKS = 256;
const MAX_BLOCK = 65_536;
const whitespace = /[ \t\r\n]/;
const problem = (reason, block, offset) => ({ code: 'INPUT_INVALID', reason,
  message: 'The complete certificate input was rejected.', ...(block === undefined ? {} : { block }),
  ...(offset === undefined ? {} : { offset }) });

/** Validate every byte and certificate before returning any importable material. */
export function validateSuppliedCa(bytes, options = {}) {
  const diagnostics = [];
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
    return { valid: false, diagnostics: [problem('source-unavailable')], assessedBlocks: 0 };
  if (bytes.byteLength > MAX_SOURCE)
    return { valid: false, diagnostics: [problem('source-byte-limit')], assessedBlocks: 0,
      assessmentLimit: 'source-byte-limit' };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { valid: false, diagnostics: [problem('utf8-invalid')], assessedBlocks: 0 }; }
  const bomBytes = text.charCodeAt(0) === 0xfeff ? 3 : 0;
  if (bomBytes) text = text.slice(1);
  const issue = (reason, block, offset) => problem(reason, block,
    offset === undefined ? undefined : bomBytes + Buffer.byteLength(text.slice(0, offset), 'utf8'));
  if (!text.trim()) return { valid: false, diagnostics: [problem('source-empty')], assessedBlocks: 0 };
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) return { valid: false, diagnostics: [problem('evaluation-time')], assessedBlocks: 0 };
  const seen = new Set(); const certificates = [];
  let blocks = 0; let offset = 0; let assessmentLimit;
  while (offset < text.length) {
    while (offset < text.length && whitespace.test(text[offset])) offset++;
    if (offset === text.length) break;
    const begin = '-----BEGIN CERTIFICATE-----';
    if (!text.startsWith(begin, offset)) {
      const match = /^-----BEGIN ([^\r\n]{1,80})-----/.exec(text.slice(offset));
      diagnostics.push(issue(match ? 'block-label' : 'pem-envelope', blocks + 1, offset));
      assessmentLimit = 'structure'; break;
    }
    const start = offset; offset += begin.length;
    const end = text.indexOf('-----END CERTIFICATE-----', offset);
    if (end < 0) { diagnostics.push(issue('pem-end-missing', blocks + 1, start)); assessmentLimit = 'structure'; break; }
    const close = end + '-----END CERTIFICATE-----'.length;
    if (blocks === MAX_BLOCKS) {
      diagnostics.push(issue('block-count-limit', blocks + 1, start)); assessmentLimit = 'block-count-limit'; break;
    }
    if (Buffer.byteLength(text.slice(start, close)) > MAX_BLOCK) {
      diagnostics.push(issue('block-byte-limit', blocks + 1, start)); assessmentLimit = 'block-byte-limit'; break;
    }
    blocks++;
    const payload = text.slice(offset, end);
    offset = close;
    if (payload.includes('-----BEGIN') || payload.includes('-----END')) {
      diagnostics.push(issue('pem-nested', blocks, start)); continue;
    }
    if (/[^A-Za-z0-9+/= \t\r\n]/.test(payload)) {
      diagnostics.push(issue('base64-character', blocks, start)); continue;
    }
    const encoded = payload.replace(/[ \t\r\n]/g, '');
    if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      diagnostics.push(issue('base64-invalid', blocks, start)); continue;
    }
    const der = Buffer.from(encoded, 'base64');
    if (der.toString('base64') !== encoded) {
      diagnostics.push(issue('base64-noncanonical', blocks, start)); continue;
    }
    let cert;
    try { cert = new X509Certificate(der); }
    catch { diagnostics.push(issue('x509-invalid', blocks, start)); continue; }
    if (!cert.raw.equals(der)) { diagnostics.push(issue('x509-extra-data', blocks, start)); continue; }
    if (!cert.ca) diagnostics.push(issue('not-ca', blocks, start));
    const from = Date.parse(cert.validFrom); const to = Date.parse(cert.validTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) diagnostics.push(issue('date-invalid', blocks, start));
    else if (now < from) diagnostics.push(issue('not-yet-valid', blocks, start));
    else if (now > to) diagnostics.push(issue('expired', blocks, start));
    const fingerprint = createHash('sha256').update(der).digest('hex');
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      certificates.push({ fingerprint, subject: cert.subject.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 256),
        validFrom: cert.validFrom, validTo: cert.validTo, pem: cert.toString() });
    }
  }
  if (!blocks && !assessmentLimit) diagnostics.push(issue('pem-envelope'));
  return diagnostics.length ? { valid: false, diagnostics, assessedBlocks: blocks,
    ...(assessmentLimit ? { assessmentLimit } : {}) } :
    { valid: true, diagnostics: [], assessedBlocks: blocks, duplicates: blocks - certificates.length,
      certificates, material: certificates.map(cert => cert.pem.trimEnd()).join('\n') + '\n', evaluatedAt: new Date(now).toISOString() };
}

/** Existing managed trust may be expired; preservation never validates it as new input. */
export function composeExistingTrust(existing, additions, options = {}) {
  let text = '';
  if (existing?.length) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(existing); }
    catch { return undefined; }
  }
  const parseBlocks = value => {
    const identities = new Set(); const blocks = [];
    let position = 0;
    while (position < value.length) {
      while (position < value.length && whitespace.test(value[position])) position++;
      if (position === value.length) break;
      if (!value.startsWith('-----BEGIN CERTIFICATE-----', position)) return undefined;
      const start = position;
      position += '-----BEGIN CERTIFICATE-----'.length;
      const end = value.indexOf('-----END CERTIFICATE-----', position);
      if (end < 0) return undefined;
      const encoded = value.slice(position, end).replace(/[ \t\r\n]/g, '');
      if (!encoded || encoded.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
      const der = Buffer.from(encoded, 'base64');
      if (der.toString('base64') !== encoded) return undefined;
      try {
        const cert = new X509Certificate(der);
        if (!cert.raw.equals(der)) return undefined;
        const fingerprint = createHash('sha256').update(der).digest('hex');
        identities.add(fingerprint);
        blocks.push({ fingerprint, text: value.slice(start, end + '-----END CERTIFICATE-----'.length) });
      } catch { return undefined; }
      position = end + '-----END CERTIFICATE-----'.length;
    }
    return blocks.length ? { identities, blocks } : undefined;
  };
  const prior = text ? parseBlocks(text) : { identities: new Set(), blocks: [] };
  const incoming = parseBlocks(additions);
  if (!prior || !incoming) return undefined;
  const defaults = options.includeNodeDefaults ? parseBlocks(tls.rootCertificates.join('\n')) : undefined;
  if (options.includeNodeDefaults && !defaults) return undefined;
  const used = new Set(prior.identities);
  const fresh = [];
  for (const block of [...incoming.blocks, ...defaults?.blocks ?? []]) {
    if (!used.has(block.fingerprint)) { used.add(block.fingerprint); fresh.push(block); }
  }
  if (!fresh.length) return text;
  return text + (text && !text.endsWith('\n') ? '\n' : '') + fresh.map(block => block.text).join('\n') + '\n';
}
