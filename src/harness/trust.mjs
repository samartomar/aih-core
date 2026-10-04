// Fixed Node trust helper: complete source discovery, deterministic encodings and admission evidence.
// Core owns file capture and custody; this module never sees a private path or writes anything.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { composeTrustSources, canonicalTrustJson, hashTrustSourceSet, reviewTrustDelta } from './trust-source.mjs';
import { observeOsTrust, detectTrustPlatform } from './trust-os.mjs';
import { parsePemBundle, parsePkcs7, serializeCertificateSet, sha256Hex } from './trust-encoding.mjs';
import { validateTrustCapabilities, trustProfiles } from './trust-definitions.mjs';

export { canonicalTrustJson, hashTrustSourceSet, reviewTrustDelta, detectTrustPlatform };
export { buildCertificateExportRecipe, getTrustFileIntegration } from './trust-definitions.mjs';

/** Dist-relative modules that the installed-helper byte binding must hash for trust requests. */
export const trustHelperFiles = Object.freeze([
  'dist/harness/trust.mjs', 'dist/harness/trust-definitions.mjs', 'dist/harness/trust-encoding.mjs',
  'dist/harness/trust-source.mjs', 'dist/harness/trust-os.mjs', 'dist/harness/ca.mjs', 'dist/harness/jvm-trust.mjs'
]);

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));
const emptyDiscovery = (status, diagnostics) => ({ status, diagnostics, sources: [], certificates: [], suitableFingerprints: [],
  sourceSetSha256: null, der: new Map(), binding: { adapter: null, policySha256: null, osObservationSha256: null } });
const invalid = reason => emptyDiscovery('invalid', [{ code: 'INPUT_INVALID', reason, message: 'The trust source request is invalid.' }]);

/** Establish the full reviewed source set. The OS partition is observed read-only; other partitions are snapshots. */
export async function discoverTrustSources(request, controls = {}) {
  const signal = controls.signal ?? request?.signal;
  if (!plain(request) || !plain(request.sources) || typeof request.sources.os !== 'boolean' ||
      !Array.isArray(request.sources.supplied) || !['declared', 'off'].includes(request.network))
    return invalid('invalid-source-selection');
  if (signal?.aborted) return emptyDiscovery('cancelled', []);
  const now = request.now ?? Date.now();
  if (!Number.isFinite(now)) return invalid('evaluation-time');
  let os = null;
  if (request.sources.os) {
    os = await observeOsTrust({ network: request.network, signal });
    if (signal?.aborted || os.reason === 'cancelled') return emptyDiscovery('cancelled', []);
  }
  const baseline = request.sources.baseline === undefined ? undefined : request.sources.baseline;
  return composeTrustSources({ os, osRequested: request.sources.os, supplied: request.sources.supplied, baseline,
    includeNodeBundled: request.includeNodeBundled === true, now });
}

/** Strict, independent parse of a prior or produced certificate output. */
export function parseTrustOutput(bytes, format, options = {}) {
  if (format === 'pem') return parsePemBundle(bytes, options.maxBytes);
  if (format === 'pkcs7-der') return parsePkcs7(bytes);
  return { status: 'invalid', reason: 'format-unsupported' };
}

/** Serialize the complete suitable set. Unavailable never substitutes another format. */
export function serializeTrustSet(request) {
  return serializeCertificateSet({ format: request?.format, certificates: request?.certificates }, request?.internal);
}

/**
 * Subject digest: canonical cell without evidence, the sorted name+hash of every installed helper and
 * profile file, and (for serializer-backed profiles) the installed maintained-library digest. The
 * admission data file is never an input, so a cell cannot hash itself.
 */
export function trustCellSubjectSha256(cell, packageRoot) {
  const root = resolve(packageRoot);
  const profiles = [cell.configurationProfile, cell.probeProfile].map(id => Object.hasOwn(trustProfiles, id) ? trustProfiles[id] : undefined);
  if (profiles.some(item => !item)) return null;
  const names = [...new Set([...trustHelperFiles, ...profiles.flatMap(item => item.files)])].sort();
  const files = [];
  for (const name of names) {
    try { files.push({ name, sha256: sha256Hex(readFileSync(join(root, name))) }); } catch { return null; }
  }
  let libraries = null;
  if (profiles.some(item => item.libraries)) {
    const hashed = hashTrustLibraries({ packageRoot: root });
    if (hashed.status !== 'hashed') return null;
    libraries = hashed.sha256;
  }
  const { evidence: _evidence, ...tested } = cell;
  return sha256Hex(Buffer.from(canonicalTrustJson({ cell: tested, files, libraries }), 'utf8'));
}

/** Installed serializer libraries whose bytes the helper binding must include. */
export const trustLibraryPackages = Object.freeze(['pkijs', 'asn1js', 'pvtsutils', 'pvutils', 'bytestreamjs', 'tslib', '@noble/hashes']);

/** Digest every regular file of the installed serializer packages (resolved as the helper would load them). */
export function hashTrustLibraries({ packageRoot }) {
  const require = createRequire(join(resolve(packageRoot), 'package.json'));
  const packages = []; let total = 0;
  for (const name of trustLibraryPackages) {
    let manifest;
    try { manifest = require.resolve(`${name}/package.json`); }
    catch {
      // Packages with an exports map hide package.json: ascend from the resolved entry to the named manifest.
      try {
        let directory = dirname(require.resolve(name));
        for (let depth = 0; depth < 8 && !manifest; depth++, directory = dirname(directory)) {
          const candidate = join(directory, 'package.json');
          try { if (JSON.parse(readFileSync(candidate, 'utf8')).name === name) manifest = candidate; } catch { /* keep ascending */ }
        }
      } catch { /* unresolved below */ }
      if (!manifest) return { status: 'unavailable', reason: 'trust-library-unavailable', name };
    }
    const base = dirname(manifest); const hash = createHash('sha256'); let version = null;
    const files = [];
    const walk = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('trust-library-link');
        if (entry.isDirectory()) walk(path); else if (entry.isFile()) files.push(path);
      }
    };
    try {
      walk(base);
      if (files.length > 4096) return { status: 'unavailable', reason: 'trust-library-unbounded', name };
      for (const file of files) {
        const bytes = readFileSync(file); total += bytes.length;
        if (total > 64 * 1024 * 1024) return { status: 'unavailable', reason: 'trust-library-unbounded', name };
        hash.update(relative(base, file).split(sep).join('/')).update('\0').update(bytes).update('\0');
      }
      version = JSON.parse(readFileSync(manifest, 'utf8')).version;
    } catch { return { status: 'unavailable', reason: 'trust-library-unavailable', name }; }
    packages.push({ name, version, sha256: hash.digest('hex') });
  }
  return { status: 'hashed', packages, sha256: sha256Hex(Buffer.from(canonicalTrustJson(packages), 'utf8')) };
}

// Strict JSON: duplicate keys, trailing text, non-finite and unsafe numbers are rejected.
function parseStrictJson(text) {
  let index = 0; let depth = 0;
  const fail = () => { throw new Error('json'); };
  const space = () => { while (index < text.length && ' \t\r\n'.includes(text[index])) index++; };
  const value = () => {
    space();
    if (++depth > 32) fail();
    const ch = text[index]; let result;
    if (ch === '{') {
      index++; result = Object.create(null); space();
      if (text[index] === '}') index++;
      else for (;;) {
        space();
        if (text[index] !== '"') fail();
        const key = string(); space();
        if (text[index++] !== ':') fail();
        if (Object.hasOwn(result, key)) fail();
        result[key] = value(); space();
        if (text[index] === ',') { index++; continue; }
        if (text[index++] === '}') break;
        fail();
      }
    } else if (ch === '[') {
      index++; result = []; space();
      if (text[index] === ']') index++;
      else for (;;) {
        result.push(value()); space();
        if (text[index] === ',') { index++; continue; }
        if (text[index++] === ']') break;
        fail();
      }
    } else if (ch === '"') result = string();
    else {
      const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(index, index + 64));
      if (!match) fail();
      index += match[0].length;
      result = JSON.parse(match[0]);
      if (typeof result === 'number' && !Number.isSafeInteger(result)) fail();
    }
    depth--;
    return result;
  };
  const string = () => {
    const start = index++;
    while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
    if (text[index++] !== '"') fail();
    return JSON.parse(text.slice(start, index));
  };
  const result = value(); space();
  if (index !== text.length) fail();
  return result;
}

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === null;
const exact = (value, keys) => isPlain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const acceptanceRecordSchema = 'aih.trust.acceptance.v1';

/** Acceptance record: exact tested subject plus explicitly passed positive/negative/persistence cases and limitations. */
function checkAcceptanceRecord(record, cell, subject, profile) {
  if (!exact(record, ['schema', 'cellId', 'subjectSha256', 'cell', 'cases', 'limitations']) || record.schema !== acceptanceRecordSchema) return 'record-shape';
  if (record.cellId !== cell.id || record.subjectSha256 !== subject || cell.evidence.subjectSha256 !== subject) return 'record-subject';
  const { evidence: _evidence, ...tested } = cell;
  if (canonicalTrustJson(JSON.parse(JSON.stringify(record.cell))) !== canonicalTrustJson(tested)) return 'record-cell';
  if (!Array.isArray(record.cases) || record.cases.length > 128 || !Array.isArray(record.limitations) || record.limitations.length > 64) return 'record-shape';
  const seen = new Map();
  for (const item of record.cases) {
    if (!exact(item, ['id', 'kind', 'outcome', 'summary']) || typeof item.id !== 'string' || seen.has(item.id) ||
        !['positive', 'negative', 'persistence'].includes(item.kind) || typeof item.summary !== 'string' || !item.summary.length || item.summary.length > 512)
      return 'record-case';
    seen.set(item.id, item);
  }
  const required = profile.requiredCases.filter(item => !item.os || item.os === cell.platform.os);
  for (const item of required) {
    const found = seen.get(item.id);
    if (!found) return 'case-missing';
    if (found.kind !== item.kind) return 'case-kind';
    if (found.outcome !== 'passed') return 'case-not-passed';
  }
  if (seen.size !== required.length) return 'case-unrecognized';
  if (record.limitations.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(item)) ||
      !profile.requiredLimitations.every(item => record.limitations.includes(item))) return 'limitation-missing';
  return null;
}

/**
 * Validate admitted cells against their published acceptance records: bytes, parsed outcomes and the exact
 * subject (cell, helper/profile files and serializer libraries). A digest alone is never a claimed outcome.
 */
export function verifyTrustAdmissionEvidence({ packageRoot, capabilities, definitions }) {
  const structure = validateTrustCapabilities(capabilities, { definitions });
  if (!structure.valid) return structure;
  const diagnostics = [];
  const root = resolve(packageRoot);
  capabilities.cells.forEach((cell, index) => {
    const at = `/cells/${index}/evidence`;
    const bad = reason => diagnostics.push({ code: 'PREREQUISITE_UNAVAILABLE', reason, message: 'Admission evidence is not verifiable.', path: at });
    const path = resolve(root, cell.evidence.reference);
    if (path !== root && !path.startsWith(root + sep)) return bad('evidence-path');
    let bytes;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) return bad('evidence-unavailable');
      bytes = readFileSync(path);
    } catch { return bad('evidence-unavailable'); }
    if (sha256Hex(bytes) !== cell.evidence.sha256) return bad('evidence-digest');
    const subject = trustCellSubjectSha256(cell, packageRoot);
    if (!subject) return bad('helper-unavailable');
    if (subject !== cell.evidence.subjectSha256) return bad('evidence-subject');
    let record;
    try { record = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return bad('record-invalid'); }
    const reason = checkAcceptanceRecord(record, cell, subject, trustProfiles[cell.probeProfile]);
    if (reason) return bad(reason);
  });
  return { valid: diagnostics.length === 0, diagnostics };
}
