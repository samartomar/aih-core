// This entry is data only. Importing it performs no host observation.
import { distribution } from '../distribution.mjs';
import { userToolsRepair } from './user-trust-definitions.mjs';
import { jvmRepair } from './jvm-trust-definitions.mjs';
import { snapshotTrustData } from './trust-data.mjs';
import { buildTrustCapabilities, selectRepairDefinition as selectDefinition } from './trust-definitions.mjs';
import { trustCellRecords } from './trust-capabilities.mjs';
export { verificationPublishers, validateVerificationPublisherRecords, selectVerificationPublishers } from './verification-publishers.mjs';
export { buildTrustDefinitions, trustRepairIndex, trustLimits, trustAdapters, trustPlatformMatrix, consumerProfiles, validateRepairDefinition11,
  validateTrustCapabilities, selectTrustCell, buildCertificateExportRecipe, trustProfiles, trustTransformIds, resolveTrustRecipeRef,
  exportAdmissionTemplate, exportDefaultNames } from './trust-definitions.mjs';
// Admission cells are static raw data (trust-capabilities.mjs): only exact tested export format/profile cells are admitted;
// native and file repair cells stay absent until their own published evidence exists.
export const trustCapabilities = buildTrustCapabilities(distribution, trustCellRecords);
export { nativeClientIds, nativeVerificationDefinitions, validateNativeVerificationDefinition,
  validateNativeTestIdentity } from './native/contracts.mjs';
export const contractSupport = Object.freeze({
  schema: 'urn:aihq:package-support:1.0.0',
  package: distribution,
  contracts: Object.freeze([
    Object.freeze({ id: 'urn:aihq:harness:diagnostic:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/diagnostic/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:repair:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/repair/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:repair:1.1.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/repair/1.1.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:trust-capabilities:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/trust-capabilities/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:report:snapshot:1.0.0', role: 'both',
      schemaExport: '@aihq/core/report/schema' }),
    Object.freeze({ id: 'urn:aihq:core:recipe:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/schemas/recipe/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:native-verification-definition:1.0.0', role: 'both',
      schemaExport: '@aihq/core/harness/schemas/native-verification-definition/1.0.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:native-verification-definition:1.1.0', role: 'both',
      schemaExport: '@aihq/core/harness/schemas/native-verification-definition/1.1.0.json' }),
    Object.freeze({ id: 'urn:aihq:harness:native-test-identity:1.0.0', role: 'accepts',
      schemaExport: '@aihq/core/harness/schemas/native-test-identity/1.0.0.json' })
  ]),
  entries: Object.freeze([
    { export: '@aihq/core/harness', runtime: 'portable' },
    { export: '@aihq/core/report', runtime: 'portable' },
    { export: '@aihq/core/report/render', runtime: 'portable' },
    { export: '@aihq/core/harness/runtime', runtime: 'node', nodeRange: '>=24.15.0 <25' }
  ])
});

// Presence signals and fixed origins are extracted from the prior CLI registry
// and heal inventory. A config trace never proves a runnable binary.
export const repairIndex = Object.freeze([Object.freeze({
  id: 'node-npm-ca', description: 'Add supplied CA certificates to user-scope Node and npm trust',
  schema: 'urn:aihq:harness:repair:1.0.0', scope: 'user',
  managementId: 'node-npm-trust', materialName: 'trust.pem',
  variants: Object.freeze(['win32', 'darwin', 'linux'].flatMap(os =>
    [['node'], ['npm'], ['node', 'npm']].flatMap(targets =>
      ['declared', 'off'].map(network => Object.freeze({ os,
        architectures: Object.freeze(os === 'darwin' ? ['arm64', 'x64'] : ['x64', 'arm64']),
        targets: Object.freeze(targets), network,
        recipeRef: `node-npm-ca/${os}/${targets.join('+')}/${network}`, transformId: 'node-npm-ca-bindings' }))))),
  targets: Object.freeze(['node', 'npm']),
  inputs: Object.freeze({ caFile: Object.freeze({ type: 'file', required: true, description: 'Certificate-only PEM file' }) }),
  limits: Object.freeze({ sourceBytes: 1048576, certificateBlocks: 256, blockBytes: 65536 }),
  offlineVerification: Object.freeze([
    { target: 'node', operationId: 'node-config', checkId: 'node-tls' },
    { target: 'npm', operationId: 'npm-config', checkId: 'npm-behavior' }
  ])
}), Object.freeze({
  id: 'node-os-trust', description: 'Use a bounded OS-trusted candidate for user-scope Node TLS',
  schema: 'urn:aihq:harness:repair:1.0.0', scope: 'user',
  candidateDiagnostic: 'node-os-trust',
  managementId: 'node-os-trust', materialName: 'trust.pem',
  variants: Object.freeze(['win32', 'darwin', 'linux'].flatMap(os =>
    ['system-ca', 'extra-ca'].map(candidate => Object.freeze({ os,
      architectures: Object.freeze(['x64', 'arm64']), targets: Object.freeze(['node']),
      network: 'declared', candidate,
      recipeRef: `node-os-trust/${os}/${candidate}`, transformId: 'node-os-trust-bindings' })))),
  targets: Object.freeze(['node']),
  inputs: Object.freeze({ originId: Object.freeze({ type: 'string', required: true, maxLength: 64,
    description: 'Installed selector for the effective HTTPS npm registry: npm-registry' }) }),
  limits: Object.freeze({ sourceBytes: 1048576, certificateBlocks: 256, blockBytes: 65536 }),
  offlineVerification: Object.freeze([])
}), userToolsRepair, jvmRepair]);
/** Select by (request schema, repair ID, definition schema); the 1.0 index stays reachable for legacy requests. */
export const selectRepairDefinition = query => selectDefinition(query, repairIndex);
// Organization keys are selected independently. AIHQ publisher trust is carried
// by verificationPublishers; test keys never ship in either inventory.
export const verificationKeys = Object.freeze([]);
export const verificationKeyPurposes = Object.freeze(['scan-report']);

const keyRecordIsPlainObject = value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const KEY_RECORD_FIELDS = ['keyId', 'algorithm', 'publicKeySpkiBase64', 'identity', 'purposes'];
const KEY_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ED25519_SPKI_PREFIX_HEX = '302a300506032b6570032100';
const keyHex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const keyDiagnostic = (reason, message, path) => ({ code: 'INPUT_INVALID', reason, message, path });

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length > 5464 || !KEY_BASE64_RE.test(value)) return undefined;
  let binary;
  try {
    binary = atob(value);
  } catch {
    return undefined;
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== value) return undefined;
  return bytes;
}

export async function validateVerificationKeyRecords(records) {
  try { records = snapshotTrustData(records); }
  catch { return { valid: false, diagnostics: [keyDiagnostic('record-shape', 'Verification keys must be bounded plain data.', '')] }; }
  if (!Array.isArray(records))
    return { valid: false, diagnostics: [keyDiagnostic('records-not-array', 'Verification key records must be an array.', '')] };
  if (records.length > 128)
    return { valid: false, diagnostics: [keyDiagnostic('records-count', 'Verification key records exceed the bounded inventory size.', '')] };
  const diagnostics = [];
  const seenKeyIds = new Set();
  for (const [index, record] of records.entries()) {
    const base = `/${index}`;
    if (!keyRecordIsPlainObject(record) ||
        Object.keys(record).length !== KEY_RECORD_FIELDS.length ||
        !KEY_RECORD_FIELDS.every(field => Object.hasOwn(record, field))) {
      diagnostics.push(keyDiagnostic('record-shape',
        'A verification key record must be a plain object with exactly the keyId, algorithm, publicKeySpkiBase64, identity and purposes fields.', base));
      continue;
    }
    if (record.algorithm !== 'Ed25519')
      diagnostics.push(keyDiagnostic('algorithm', "A verification key record's algorithm must be 'Ed25519'.", `${base}/algorithm`));
    if (typeof record.identity !== 'string' || record.identity.length === 0 ||
        record.identity.length > 256 || new TextEncoder().encode(record.identity).length > 256 ||
        !record.identity.isWellFormed() || record.identity.normalize('NFC') !== record.identity || /[\x00-\x1f\x7f]/.test(record.identity))
      diagnostics.push(keyDiagnostic('identity',
        'A verification key identity must be a nonempty bounded string without control characters.', `${base}/identity`));
    const purposes = record.purposes;
    if (!Array.isArray(purposes) || purposes.length === 0 || new Set(purposes).size !== purposes.length ||
        purposes.some(purpose => typeof purpose !== 'string' || !verificationKeyPurposes.includes(purpose)))
      diagnostics.push(keyDiagnostic('purposes',
        'A verification key record must declare a nonempty set of unique supported purposes.', `${base}/purposes`));
    const der = decodeCanonicalBase64(record.publicKeySpkiBase64);
    if (der === undefined)
      diagnostics.push(keyDiagnostic('public-key-base64',
        'publicKeySpkiBase64 must be canonical Base64 of the SPKI DER.', `${base}/publicKeySpkiBase64`));
    else if (der.length !== 44 || keyHex(der.subarray(0, 12)) !== ED25519_SPKI_PREFIX_HEX)
      diagnostics.push(keyDiagnostic('public-key-der',
        'publicKeySpkiBase64 must decode to the 44-byte Ed25519 SPKI DER.', `${base}/publicKeySpkiBase64`));
    else {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', der);
      if (record.keyId !== `ed25519:${keyHex(new Uint8Array(digest))}`)
        diagnostics.push(keyDiagnostic('key-id',
          'keyId must equal ed25519: plus the lowercase SHA-256 of the decoded SPKI DER.', `${base}/keyId`));
    }
    if (typeof record.keyId === 'string') {
      if (seenKeyIds.has(record.keyId))
        diagnostics.push(keyDiagnostic('key-id-duplicate', 'Verification key records must not repeat a keyId.', `${base}/keyId`));
      seenKeyIds.add(record.keyId);
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export async function selectVerificationKeys(purpose, records = verificationKeys) {
  if (typeof purpose !== 'string' || !verificationKeyPurposes.includes(purpose))
    return { status: 'invalid', diagnostics: [keyDiagnostic('purpose-unsupported',
      'The requested verification-key purpose is not supported.', '/purpose')] };
  try { records = snapshotTrustData(records); }
  catch { return { status: 'invalid', diagnostics: [keyDiagnostic('record-shape', 'Verification keys must be bounded plain data.', '')] }; }
  const validation = await validateVerificationKeyRecords(records);
  if (!validation.valid) return { status: 'invalid', diagnostics: validation.diagnostics };
  return {
    status: 'selected',
    keys: Object.freeze(records
      .filter(record => record.purposes.includes(purpose))
      .map(record => Object.freeze({
        identity: record.identity, keyId: record.keyId, publicKeySpkiBase64: record.publicKeySpkiBase64
      })))
  };
}
export const helperMetadata = Object.freeze({
  repairs: Object.freeze([
    { id: 'node-npm-ca', helper: 'renderRepair', targets: ['node', 'npm'] },
    { id: 'node-os-trust', helper: 'renderRepair', targets: ['node'] },
    { id: 'user-tools-ca', helper: 'renderRepair', targets: ['python', 'pip', 'git', 'cargo', 'conda'] },
    { id: 'jvm-ca', helper: 'renderRepair', targets: ['gradle', 'maven'] }
  ]),
  diagnostics: Object.freeze([
    { id: 'existing-tools', kind: 'diagnostic', purpose: 'Inspect installed tools and their declared TLS origins',
      targets: ['node', 'npm', 'git', 'python', 'pip', 'cargo', 'conda', 'claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'opencode', 'kimi', 'kiro',
        'rg', 'fd', 'jq', 'curl', 'keytool', 'bash', 'antigravity', 'zed'],
      profile: { phaseMs: 180000, maxActiveProbes: 2, localProcessMs: 30000, networkProcessMs: 25000,
        networkSocketMs: 20000, outputBytes: 65536, checkDetailBytes: 4096, phaseDetailBytes: 65536,
        configuredMcpOrigins: 3, configuredMcpMs: 60000 } }
  ])
});

export const targets = Object.freeze([
  { id: 'node', label: 'Node.js', binaries: ['node'], configDirs: [], origins: [] },
  { id: 'npm', label: 'npm', binaries: ['npm'], configDirs: [], origins: ['https://registry.npmjs.org'] },
  { id: 'git', label: 'Git', binaries: ['git'], configDirs: [], origins: [] },
  { id: 'python', label: 'Python', binaries: ['python3', 'python'], configDirs: [], origins: ['https://pypi.org'] },
  { id: 'pip', label: 'pip', binaries: ['pip', 'pip3'], configDirs: [], origins: ['https://pypi.org'] },
  { id: 'cargo', label: 'Cargo', binaries: ['cargo'], configDirs: ['.cargo'], origins: ['https://crates.io'] },
  { id: 'conda', label: 'conda', binaries: ['conda'], configDirs: [], origins: ['https://repo.anaconda.com'] },
  { id: 'claude', label: 'Claude Code', binaries: ['claude'], configDirs: ['.claude'], origins: [] },
  { id: 'codex', label: 'Codex CLI', binaries: ['codex'], configDirs: ['.codex'], origins: [] },
  { id: 'cursor', label: 'Cursor', binaries: ['cursor', 'cursor-agent', 'agent'], configDirs: ['.cursor'], origins: [] },
  { id: 'gemini', label: 'Gemini CLI', binaries: ['gemini'], configDirs: ['.gemini/tmp', '.gemini/extensions', '.gemini/commands', '.gemini/history'], origins: [] },
  { id: 'copilot', label: 'GitHub Copilot', binaries: ['copilot'], configDirs: ['.config/github-copilot', '.copilot'], origins: [] },
  { id: 'windsurf', label: 'Windsurf', binaries: ['windsurf'], configDirs: ['.codeium/windsurf', '.windsurf'], origins: [] },
  { id: 'opencode', label: 'OpenCode', binaries: ['opencode'], configDirs: ['.config/opencode', '.opencode'], origins: [] },
  { id: 'kimi', label: 'Kimi Code', binaries: ['kimi'], configDirs: ['.kimi-code'], origins: [] },
  { id: 'kiro', label: 'Kiro', binaries: ['kiro-cli'], configDirs: ['.kiro'], origins: ['https://kiro.dev'] },
  // Helpers: presence and a version probe only; no general tool inventory.
  { id: 'rg', label: 'ripgrep', binaries: ['rg'], configDirs: [], origins: [] },
  { id: 'fd', label: 'fd', binaries: ['fd', 'fdfind'], configDirs: [], origins: [] },
  { id: 'jq', label: 'jq', binaries: ['jq'], configDirs: [], origins: [] },
  { id: 'curl', label: 'curl', binaries: ['curl'], configDirs: [], origins: [] },
  { id: 'keytool', label: 'Java keytool', binaries: ['keytool'], configDirs: [], origins: [] },
  { id: 'bash', label: 'Bash', binaries: ['bash'], configDirs: [], origins: [] },
  // Clients: signals from vendor docs (antigravity.google, zed.dev). Presence never proves native loading.
  { id: 'antigravity', label: 'Google Antigravity', binaries: ['agy', 'antigravity'],
    configDirs: ['.gemini/antigravity-cli', '.gemini/antigravity', '.gemini/config'], origins: [] },
  { id: 'zed', label: 'Zed', binaries: ['zed', 'zeditor', 'zedit'],
    configDirs: ['.config/zed', 'AppData/Roaming/Zed'], origins: [] }
]);
for (const target of targets) {
  Object.freeze(target.binaries);
  Object.freeze(target.configDirs);
  Object.freeze(target.origins);
  Object.freeze(target);
}
