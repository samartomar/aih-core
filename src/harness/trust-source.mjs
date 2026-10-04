// Source composition for trust export and file repair: partitions, suitability, limits, hashes, deltas.
import { createHash, X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { validateSuppliedCa } from './ca.mjs';
import { validateBaselineStore } from './jvm-trust.mjs';
import { describeCertificate, sha256Hex } from './trust-encoding.mjs';
import { trustLimits } from './trust-definitions.mjs';

export const SOURCE_DOMAIN = 'aih.trust.sources.v1';
export const POLICY_DOMAIN = 'aih.trust.policy.v1';
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const ANY_EKU = '2.5.29.37.0';
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Restricted canonical JSON: UTF-16 key order, authored array order, no whitespace. */
export function canonicalTrustJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error('canonical-number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTrustJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalTrustJson(value[key])}`).join(',')}}`;
  throw new Error('canonical-value');
}
export const domainHash = (domain, value) =>
  createHash('sha256').update(Buffer.concat([Buffer.from(domain, 'utf8'), Buffer.from([0]),
    Buffer.from(canonicalTrustJson(value), 'utf8')])).digest('hex');
export const hashTrustSourceSet = rows => domainHash(SOURCE_DOMAIN, rows);

const diag = (code, reason, message, sourceId) => ({ code, reason, message, ...(sourceId ? { sourceId } : {}) });
const sortedUnique = values => [...new Set(values)].sort();
const reasonMessage = {
  'source-limit': 'A trust source exceeds a published boundary; nothing was truncated.',
  'trust-discovery-incomplete': 'The OS trust set could not be established completely.',
  'trust-platform-unsupported': 'The OS trust projection is not supported on this platform.',
  'trust-configuration-unavailable': 'The trust configuration could not be established.',
  'trust-policy-loss': 'A suitable OS certificate has a trust restriction that a certificate file cannot preserve.',
  'trust-source-empty': 'The OS trust source has no suitable certificate.',
  'trust-output-empty': 'The combined trust set would be empty.',
  'supplied-source-unavailable': 'A retained supplied source is unavailable.',
  'supplied-source-changed': 'A retained supplied source no longer matches its admitted bytes.',
  'supplied-source-expired': 'A retained supplied source contains an expired certificate.',
  'invalid-source-selection': 'The source selection is invalid.'
};
const message = reason => reasonMessage[reason] ?? 'The trust source was rejected.';

const row = fields => ({ id: fields.id, kind: fields.kind, adapter: fields.adapter ?? null, scope: fields.scope,
  completeness: fields.completeness, policySha256: fields.policySha256 ?? null, sourceSha256: fields.sourceSha256 ?? null,
  runtimeVersion: fields.runtimeVersion ?? null, reason: fields.reason ?? null,
  fingerprints: sortedUnique(fields.fingerprints ?? []) });

/** Classify one candidate for effective TLS server-auth suitability. */
function suitability(described, candidate, now) {
  const reasons = [];
  if (!described.ca) reasons.push('not-ca');
  if (now < Date.parse(described.notBefore)) reasons.push('not-yet-valid');
  if (now > Date.parse(described.notAfter)) reasons.push('expired');
  const eku = described.extendedKeyUsage;
  if (eku && !eku.includes(SERVER_AUTH) && !eku.includes(ANY_EKU)) reasons.push('purpose-not-server-auth');
  if (candidate.verdict === 'distrusted') reasons.push('explicit-distrust');
  if (candidate.verdict === 'purpose-denied') reasons.push('purpose-not-server-auth');
  return sortedUnique(reasons);
}

/**
 * Compose partitions into the reviewed source set. Inputs are already-observed snapshots:
 * `os` is an adapter observation, `supplied` entries carry bytes, `bundled` is a boolean.
 */
export function composeTrustSources({ os = null, supplied = [], baseline, includeNodeBundled = false, osRequested = os !== null,
  now = Date.now() } = {}) {
  const diagnostics = []; const rows = [];
  const known = new Map(); // fingerprint -> public + private facts
  const incidences = { candidate: 0, combined: 0, candidateBytes: 0, combinedBytes: 0 };
  let overflow = false;
  const overLimit = sourceId => {
    if (!overflow) diagnostics.push(diag('SOURCE_LIMIT', 'source-limit', message('source-limit'), sourceId));
    overflow = true;
  };
  const fact = described => {
    let item = known.get(described.fingerprint);
    if (!item) {
      item = { fingerprint: described.fingerprint, der: described.der, subject: described.subject, issuer: described.issuer,
        notBefore: described.notBefore, notAfter: described.notAfter, sources: new Set(), excludedFrom: new Set(), reasons: new Set() };
      known.set(described.fingerprint, item);
    }
    return item;
  };
  const admit = (described, ownerId) => {
    fact(described).sources.add(ownerId);
    incidences.combined++; incidences.combinedBytes += described.der.byteLength;
  };

  // ---- selection validity -------------------------------------------------------------------
  const suppliedIds = new Set();
  if (!Array.isArray(supplied) || supplied.length > trustLimits.suppliedSources) overLimit();
  for (const entry of Array.isArray(supplied) ? supplied : []) {
    if (!entry || typeof entry.id !== 'string' || !idPattern.test(entry.id) || suppliedIds.has(entry.id))
      diagnostics.push(diag('INPUT_INVALID', 'invalid-source-selection', message('invalid-source-selection'), entry?.id));
    suppliedIds.add(entry?.id);
  }
  if (!osRequested && !includeNodeBundled && (!Array.isArray(supplied) || supplied.length === 0) && baseline === undefined)
    diagnostics.push(diag('INPUT_INVALID', 'invalid-source-selection', message('invalid-source-selection')));

  // ---- OS partition -------------------------------------------------------------------------
  if (os) {
    const adapter = os.adapter ?? null;
    const base = { id: 'os', kind: 'os', adapter, scope: 'effective-current-user' };
    if (os.status !== 'complete') {
      const reason = os.status === 'incomplete' ? 'trust-discovery-incomplete' :
        os.reason === 'trust-configuration-unavailable' ? 'trust-configuration-unavailable' : 'trust-platform-unsupported';
      rows.push(row({ ...base, completeness: os.status === 'incomplete' ? 'incomplete' : 'unavailable',
        reason: os.reason ?? reason, policySha256: os.policy ? domainHash(POLICY_DOMAIN, os.policy) : null }));
      diagnostics.push(diag('PREREQUISITE_UNAVAILABLE', reason, message(reason), 'os'));
    } else {
      const policySha256 = domainHash(POLICY_DOMAIN, os.policy ?? null);
      const admitted = new Map(); const provenance = {}; let lost = false;
      const candidates = Array.isArray(os.candidates) ? os.candidates : [];
      for (const candidate of candidates) {
        const incidence = Math.max(1, Array.isArray(candidate.provenance) ? candidate.provenance.length : 1);
        const size = candidate.der?.byteLength ?? 0;
        incidences.candidate += incidence; incidences.candidateBytes += size * incidence;
        if (size > trustLimits.certificateBytes) overLimit('os');
      }
      if (incidences.candidate > trustLimits.candidateIncidences || incidences.candidateBytes > trustLimits.derBytes) overLimit('os');
      if (!overflow) for (const candidate of candidates) {
        const described = describeCertificate(candidate.der);
        if (!described) { diagnostics.push(diag('PREREQUISITE_UNAVAILABLE', 'trust-discovery-incomplete', message('trust-discovery-incomplete'), 'os')); lost = true; continue; }
        const reasons = suitability(described, candidate, now);
        const item = fact(described);
        if (reasons.length) { item.excludedFrom.add('os'); reasons.forEach(reason => item.reasons.add(reason)); continue; }
        if (Array.isArray(candidate.restrictions) && candidate.restrictions.length) {
          lost = true; candidate.restrictions.forEach(reason => item.reasons.add(`conditional-trust:${reason}`));
        }
        admitted.set(described.fingerprint, described);
        provenance[described.fingerprint] = sortedUnique([...(provenance[described.fingerprint] ?? []), ...(candidate.provenance ?? [])]);
      }
      if (lost) diagnostics.push(diag('PREREQUISITE_UNAVAILABLE', 'trust-policy-loss', message('trust-policy-loss'), 'os'));
      for (const described of admitted.values()) admit(described, 'os');
      const fingerprints = [...admitted.keys()];
      rows.push(row({ ...base, completeness: 'complete', policySha256, fingerprints,
        sourceSha256: domainHash(SOURCE_DOMAIN, { fingerprints: sortedUnique(fingerprints), provenance }) }));
    }
  }

  // ---- supplied partitions ------------------------------------------------------------------
  for (const entry of (Array.isArray(supplied) ? supplied : []).slice(0, trustLimits.suppliedSources)) {
    const id = `supplied:${entry?.id}`;
    const base = { id, kind: 'supplied', scope: 'explicit-source' };
    const retained = entry?.origin === 'retained';
    const unavailable = reason => {
      rows.push(row({ ...base, completeness: 'unavailable', reason }));
      diagnostics.push(diag('PREREQUISITE_UNAVAILABLE', reason, message(reason), id));
    };
    if (!(entry?.bytes instanceof Uint8Array)) {
      if (retained) unavailable('supplied-source-unavailable');
      else { rows.push(row({ ...base, completeness: 'unavailable', reason: 'source-unavailable' }));
        diagnostics.push(diag('INPUT_INVALID', 'source-unavailable', 'The supplied certificate input is unavailable.', id)); }
      continue;
    }
    const digest = sha256Hex(entry.bytes);
    if (retained && entry.admittedSha256 !== digest) { unavailable('supplied-source-changed'); continue; }
    const accepted = validateSuppliedCa(entry.bytes, { now });
    if (!accepted.valid) {
      const first = accepted.diagnostics[0]?.reason ?? 'source-unavailable';
      if (retained && accepted.diagnostics.some(item => item.reason === 'expired')) { unavailable('supplied-source-expired'); continue; }
      rows.push(row({ ...base, completeness: 'unavailable', reason: first }));
      diagnostics.push(diag('INPUT_INVALID', first, 'The supplied certificate input was rejected.', id));
      continue;
    }
    const fingerprints = [];
    for (const certificate of accepted.certificates) {
      const described = describeCertificate(Buffer.from(new X509Certificate(certificate.pem).raw));
      if (!described) continue;
      fingerprints.push(described.fingerprint);
      incidences.candidate++; incidences.candidateBytes += described.der.byteLength;
      admit(described, id);
    }
    rows.push(row({ ...base, completeness: 'complete', sourceSha256: digest, fingerprints }));
  }

  // ---- Node-bundled partition ---------------------------------------------------------------
  if (includeNodeBundled) {
    const fingerprints = [];
    for (const pem of tls.rootCertificates) {
      const described = describeCertificate(Buffer.from(new X509Certificate(pem).raw));
      if (!described) continue;
      fingerprints.push(described.fingerprint);
      admit(described, 'node-bundled-default');
    }
    const unique = sortedUnique(fingerprints);
    rows.push(row({ id: 'node-bundled-default', kind: 'node-bundled', scope: 'runtime-bundled', completeness: 'complete',
      runtimeVersion: process.version, fingerprints: unique,
      sourceSha256: domainHash(SOURCE_DOMAIN, { fingerprints: unique, runtimeVersion: process.version }) }));
  }

  // ---- JKS baseline binding (separate limits; not part of the PEM/P7B certificate set) -------
  if (baseline !== undefined) {
    const base = { id: 'jvm-baseline', kind: 'jvm-baseline', scope: 'selected-jvm-baseline' };
    const checked = validateBaselineStore(baseline?.bytes);
    if (!checked.valid) {
      rows.push(row({ ...base, completeness: 'unavailable', reason: checked.reason }));
      diagnostics.push(diag('INPUT_INVALID', checked.reason, checked.message, 'jvm-baseline'));
    } else rows.push(row({ ...base, completeness: 'complete', sourceSha256: sha256Hex(baseline.bytes), fingerprints: checked.fingerprints }));
  }

  // ---- combined boundaries ------------------------------------------------------------------
  if (incidences.combined > trustLimits.combinedIncidences || incidences.combinedBytes > trustLimits.derBytes) overLimit();
  const admittedCount = [...known.values()].filter(item => item.sources.size).length;
  const blocked = diagnostics.length > 0;
  if (!blocked && admittedCount === 0)
    diagnostics.push(diag('PREREQUISITE_UNAVAILABLE', osRequested ? 'trust-source-empty' : 'trust-output-empty',
      message(osRequested ? 'trust-source-empty' : 'trust-output-empty')));

  rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const status = diagnostics.some(item => item.code === 'INPUT_INVALID') ? 'invalid' : diagnostics.length ? 'blocked' : 'ready';
  const certificates = [...known.values()].sort((a, b) => a.fingerprint < b.fingerprint ? -1 : 1).map(item => ({
    fingerprint: item.fingerprint, subject: item.subject, issuer: item.issuer, notBefore: item.notBefore, notAfter: item.notAfter,
    sources: sortedUnique(item.sources), excludedFrom: sortedUnique(item.excludedFrom), reasons: sortedUnique(item.reasons) }));
  const ready = status === 'ready';
  return {
    status, diagnostics, sources: rows, certificates,
    suitableFingerprints: ready ? certificates.filter(item => item.sources.length).map(item => item.fingerprint) : [],
    // Blocked/invalid calls still bind the public observed rows; the digest claims neither completeness nor output.
    sourceSetSha256: rows.length ? hashTrustSourceSet(rows) : null,
    der: ready ? new Map([...known.values()].filter(item => item.sources.size).map(item => [item.fingerprint, item.der])) : new Map(),
    binding: { adapter: os?.adapter ?? null, policySha256: os?.policy ? domainHash(POLICY_DOMAIN, os.policy) : null,
      osObservationSha256: os?.status === 'complete' ? rows.find(item => item.id === 'os')?.sourceSha256 ?? null : null }
  };
}

const byFingerprintThenDisposition = (a, b) => a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 :
  a.disposition < b.disposition ? -1 : a.disposition > b.disposition ? 1 : 0;

/** Certificate review rows: no truncation; old-only certificates come from the parsed prior output. */
export function reviewTrustDelta({ discovery, prior }) {
  const priorSources = prior?.sources;
  const priorOutput = prior?.output?.certificates;
  const hasProvenance = Array.isArray(priorSources);
  const before = new Map(); // fingerprint -> parsed prior certificate or undefined
  if (priorOutput) for (const item of priorOutput) before.set(item.fingerprint, item);
  else if (hasProvenance) for (const source of priorSources) for (const fingerprint of source.fingerprints) before.set(fingerprint, undefined);
  const beforeOwners = fingerprint => hasProvenance ?
    priorSources.filter(source => source.fingerprints.includes(fingerprint)).map(source => source.id) : [];
  const rows = []; const done = new Set();
  for (const item of discovery.certificates) {
    done.add(item.fingerprint);
    const inBefore = before.has(item.fingerprint);
    const inAfter = item.sources.length > 0;
    const beforeSources = sortedUnique(beforeOwners(item.fingerprint));
    const afterSources = item.sources;
    const reasons = [...item.reasons];
    let disposition;
    if (inBefore && inAfter) {
      const same = beforeSources.join() === afterSources.join();
      if (!hasProvenance) reasons.push('prior-provenance-unknown');
      disposition = hasProvenance && !same ? 'provenance-changed' : 'retained';
      if (hasProvenance && beforeSources.includes('os') && !afterSources.includes('os')) reasons.push('os-source-removed');
    } else if (inBefore) disposition = 'removed';
    else if (inAfter) disposition = 'added';
    else disposition = 'excluded';
    rows.push({ fingerprint: item.fingerprint, subject: item.subject, issuer: item.issuer, notBefore: item.notBefore,
      notAfter: item.notAfter, beforeSources, afterSources, disposition, reasons: sortedUnique(reasons) });
  }
  for (const [fingerprint, parsed] of before) {
    if (done.has(fingerprint)) continue;
    rows.push({ fingerprint, subject: parsed?.subject ?? '', issuer: parsed?.issuer ?? '', notBefore: parsed?.notBefore ?? '1970-01-01T00:00:00.000Z',
      notAfter: parsed?.notAfter ?? '1970-01-01T00:00:00.000Z', beforeSources: sortedUnique(beforeOwners(fingerprint)), afterSources: [],
      disposition: 'removed', reasons: hasProvenance ? [] : ['prior-provenance-unknown'] });
  }
  return rows.sort(byFingerprintThenDisposition);
}
