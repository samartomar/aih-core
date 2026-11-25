// Versioned, finite continuity for the asn1js/pkijs 4 serializer closure and the exact export-host table.
// It carries each predecessor record forward; it never reports a new native execution.
import { createHash } from 'node:crypto';
import { canonicalTrustJson } from './trust-source.mjs';
import { regular } from './trust-migration.mjs';
import { trustMigrationV2Policy as policy } from './trust-migration-v2-policy.mjs';

export const migrationV2Schema = 'aih.trust.acceptance-migration.v2';
export const migrationV2Method = 'core417-serializer-v4-and-exact-export-hosts-v1';
export const migrationV2Limitation = 'equivalence-migration-serializer-v4-no-new-execution';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(Buffer.from(canonicalTrustJson(value)));
const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) &&
  Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
function bytes64(text) {
  if (typeof text !== 'string' || text.length > 524288 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('migration-bytes');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) throw new Error('migration-bytes');
  return bytes;
}
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const replaceOnce = (text, [before, after]) => {
  if (text.split(before).length !== 2) throw new Error('migration-transform');
  return text.replace(before, () => after);
};

// Finite transition only: each step replaces one exact, unique span. Unlisted predecessor helpers must be unchanged.
const dispatchV1 = "    const reason = record?.schema === 'aih.trust.acceptance-migration.v1'\n";
export const predecessorTransitions = Object.freeze({
  'dist/core/trust.js': Object.freeze([
    ["import { detectCertificateExportPlatform, exactExportRelease } from '../harness/trust-export-platform.mjs';",
      "import { detectCertificateExportPlatform, exactExportReleases } from '../harness/trust-export-platform.mjs';"],
    ['if (cell?.platform.release === exactExportRelease && canonicalJson(detectCertificateExportPlatform())',
      'if (cell && exactExportReleases.includes(cell.platform.release) && canonicalJson(detectCertificateExportPlatform())']
  ]),
  'dist/harness/trust-definitions.mjs': Object.freeze([
    ["  Object.freeze({ os: 'win32', release: 'Windows 11 26H2 build 26340.9767', architecture: 'x64', projection: 'windows-effective-server-auth-v1' })\n]);",
      "  Object.freeze({ os: 'win32', release: 'Windows 11 26H2 build 26340.9767', architecture: 'x64', projection: 'windows-effective-server-auth-v1' }),\n" +
      "  Object.freeze({ os: 'win32', release: 'Windows 11 Dev build 29695.1001', architecture: 'x64', projection: 'windows-effective-server-auth-v1' })\n]);"]
  ]),
  'dist/harness/trust-export-platform.mjs': Object.freeze([
    ["export function classifyCertificateExportPlatform(legacy, facts) {\n" +
      "  if (legacy.release !== null || legacy.os !== 'win32' || legacy.architecture !== 'x64') return legacy;\n" +
      "  if (!facts || facts.nodeRelease !== '10.0.26340' || facts.cimVersion !== '10.0.26340' ||\n" +
      "      facts.currentBuild !== '26340' || facts.ubr !== 9767 || facts.displayVersion !== '26H2' ||\n" +
      "      facts.architecture !== 'AMD64' || facts.caption !== 'Microsoft Windows 11 Pro Insider Preview') return legacy;\n" +
      "  return { ...legacy, release: exactExportRelease, projection: 'windows-effective-server-auth-v1' };\n}",
    "// Each additional export host is one exact build and update revision; nothing is matched by range or prefix.\n" +
      "export const exactExportHosts = Object.freeze([\n" +
      "  Object.freeze({ release: exactExportRelease, nodeRelease: '10.0.26340', cimVersion: '10.0.26340', currentBuild: '26340',\n" +
      "    ubr: 9767, displayVersion: '26H2', architecture: 'AMD64', caption: 'Microsoft Windows 11 Pro Insider Preview' }),\n" +
      "  Object.freeze({ release: 'Windows 11 Dev build 29695.1001', nodeRelease: '10.0.29695', cimVersion: '10.0.29695', currentBuild: '29695',\n" +
      "    ubr: 1001, displayVersion: 'Dev', architecture: 'AMD64', caption: 'Microsoft Windows 11 Pro Insider Preview' })\n" +
      "]);\n" +
      "export const exactExportReleases = Object.freeze(exactExportHosts.map(host => host.release));\n" +
      "const hostFacts = Object.freeze(['nodeRelease', 'cimVersion', 'currentBuild', 'ubr', 'displayVersion', 'architecture', 'caption']);\n" +
      "export function classifyCertificateExportPlatform(legacy, facts) {\n" +
      "  if (legacy.release !== null || legacy.os !== 'win32' || legacy.architecture !== 'x64') return legacy;\n" +
      "  const host = facts ? exactExportHosts.find(item => hostFacts.every(name => facts[name] === item[name])) : undefined;\n" +
      "  if (!host) return legacy;\n" +
      "  return { ...legacy, release: host.release, projection: 'windows-effective-server-auth-v1' };\n}"],
    ["if (legacy.release !== null || platform() !== 'win32' || arch() !== 'x64' || release() !== '10.0.26340') return legacy;",
      "if (legacy.release !== null || platform() !== 'win32' || arch() !== 'x64' || !exactExportHosts.some(host => host.nodeRelease === release())) return legacy;"]
  ]),
  'dist/harness/trust-migration.mjs': Object.freeze([
    ['function regular(root, name) {', 'export function regular(root, name) {'],
    ['export function checkTrustMigration({ record, cell, subject, packageRoot, checkOriginal, parseOriginal, profile, librariesSha256 }) {\n  try {',
      'export function checkTrustMigration({ record, cell, subject, packageRoot, checkOriginal, parseOriginal, profile, librariesSha256,\n' +
      '  read = name => regular(packageRoot, name) }) {\n' +
      '  // read supplies the implementation this record is checked against: the installed package, or a verified predecessor.\n  try {'],
    ["if (!regular(packageRoot, 'dist/harness/trust-migration-policy.mjs').equals(", "if (!read('dist/harness/trust-migration-policy.mjs').equals("],
    ["if (!projectLegacyHelper(name, before).equals(regular(packageRoot, name))) return 'migration-executable-change';",
      "if (!projectLegacyHelper(name, before).equals(read(name))) return 'migration-executable-change';"],
    ["for (const item of policy.currentFiles) if (sha(regular(packageRoot, item.name)) !== item.sha256) return 'migration-current-input';",
      "for (const item of policy.currentFiles) if (sha(read(item.name)) !== item.sha256) return 'migration-current-input';"]
  ]),
  'dist/harness/trust.mjs': Object.freeze([
    ["import { checkTrustMigration } from './trust-migration.mjs';",
      "import { checkTrustMigration } from './trust-migration.mjs';\nimport { checkTrustMigrationV2 } from './trust-migration-v2.mjs';"],
    ["  'dist/harness/trust-export-platform.mjs', 'dist/core/trust.js'\n]);",
      "  'dist/harness/trust-export-platform.mjs', 'dist/core/trust.js',\n  'dist/harness/trust-migration-v2.mjs', 'dist/harness/trust-migration-v2-policy.mjs'\n]);"],
    ["export const trustLibraryPackages = Object.freeze(['pkijs', 'asn1js', 'pvtsutils', 'pvutils', 'bytestreamjs', 'tslib', '@noble/hashes']);",
      "export const trustLibraryPackages = Object.freeze(['pkijs', 'asn1js', 'bytestreamjs', '@noble/hashes', '@peculiar/utils']);\n" +
      "const manifestDependencyNames = manifest => ['dependencies', 'peerDependencies', 'optionalDependencies']\n" +
      "  .flatMap(field => Object.keys(manifest?.[field] ?? {}));"],
    ["      version = JSON.parse(readFileSync(manifest, 'utf8')).version;",
      "      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));\n" +
      "      version = parsed.version;\n" +
      "      // The installed closure must be exactly the hashed set: an unhashed dependency could change serializer behaviour.\n" +
      "      if (parsed.name !== name || manifestDependencyNames(parsed).some(dependency => !trustLibraryPackages.includes(dependency)))\n" +
      "        return { status: 'unavailable', reason: 'trust-library-closure', name };"],
    [dispatchV1,
      "    const reason = record?.schema === 'aih.trust.acceptance-migration.v2'\n" +
      "      ? checkTrustMigrationV2({ record, cell, subject, packageRoot: root, checkOriginal: checkAcceptanceRecord, parseOriginal: parseStrictJson, checkMigration: checkTrustMigration, profile: trustProfiles[cell.probeProfile], librariesSha256: trustProfiles[cell.probeProfile].libraries ? hashTrustLibraries({ packageRoot: root }).sha256 : null })\n" +
      "      : record?.schema === 'aih.trust.acceptance-migration.v1'\n"]
  ])
});
/** The Core source counterpart of the dist/core/trust.js steps; the generator checks it against the predecessor source. */
export const predecessorCoreSourceTransitions = Object.freeze([
  ["import { detectCertificateExportPlatform, exactExportRelease } from '../harness/trust-export-platform.mjs';",
    "import { detectCertificateExportPlatform, exactExportReleases } from '../harness/trust-export-platform.mjs';"],
  ['if(cell?.platform.release===exactExportRelease&&', 'if(cell&&exactExportReleases.includes(cell.platform.release)&&']
]);
export function projectPredecessorHelper(name, bytes) {
  const steps = Object.hasOwn(predecessorTransitions, name) ? predecessorTransitions[name] : [];
  return Buffer.from(steps.reduce(replaceOnce, utf8(bytes)));
}
export const projectPredecessorCoreSource = text => predecessorCoreSourceTransitions.reduce(replaceOnce, text);
export const serializeMigrationV2Policy = value => `// Generated finite migration policy; archive hashes live outside this file.\nexport const trustMigrationV2Policy = Object.freeze(${JSON.stringify(value, null, 2)});\n`;

export function checkTrustMigrationV2({ record, cell, subject, packageRoot, checkOriginal, parseOriginal, checkMigration, profile, librariesSha256 }) {
  try {
    if (!exact(record, ['schema','kind','cellId','subjectSha256','method','proofSha256','predecessorRecordBytes','predecessorFiles','limitations']) ||
        record.schema !== migrationV2Schema || record.kind !== 'equivalence-migration' || record.cellId !== cell.id ||
        record.subjectSha256 !== subject || record.method !== migrationV2Method || record.proofSha256 !== policy.proofSha256) return 'migration-v2-shape';
    const predecessor = policy.predecessors?.find(item => item.id === cell.id);
    if (!predecessor || policy.method !== migrationV2Method || digest(policy.proof) !== policy.proofSha256) return 'migration-v2-policy';
    if (!regular(packageRoot, 'dist/harness/trust-migration-v2-policy.mjs').equals(Buffer.from(serializeMigrationV2Policy(policy)))) return 'migration-v2-policy-changed';
    // Exact known predecessor bytes are checked before parsing: no caller-selected historical JSON has authority.
    const previousBytes = bytes64(record.predecessorRecordBytes);
    if (sha(previousBytes) !== predecessor.recordSha256) return 'migration-v2-predecessor-digest';
    const previous = parseOriginal(utf8(previousBytes));
    if (previous?.schema !== predecessor.schema) return 'migration-v2-predecessor-kind';
    if (!Array.isArray(previous.limitations) ||
        canonicalTrustJson(record.limitations) !== canonicalTrustJson([...previous.limitations, migrationV2Limitation])) return 'migration-v2-limitations';
    // Each changed predecessor helper is embedded and must project exactly to the installed bytes; every other one is installed unchanged.
    const embedded = policy.predecessorFiles.filter(item => Object.hasOwn(predecessorTransitions, item.name));
    if (!Array.isArray(record.predecessorFiles) || record.predecessorFiles.length !== embedded.length) return 'migration-v2-inputs';
    const before = new Map();
    for (const [index, item] of embedded.entries()) {
      const entry = record.predecessorFiles[index];
      if (!exact(entry, ['name','bytesBase64']) || entry.name !== item.name) return 'migration-v2-inputs';
      const bytes = bytes64(entry.bytesBase64);
      if (sha(bytes) !== item.sha256) return 'migration-v2-preimage';
      if (!projectPredecessorHelper(item.name, bytes).equals(regular(packageRoot, item.name))) return 'migration-v2-executable-change';
      before.set(item.name, bytes);
    }
    for (const item of policy.predecessorFiles) if (!before.has(item.name)) {
      const bytes = regular(packageRoot, item.name);
      if (sha(bytes) !== item.sha256) return 'migration-v2-executable-change';
      before.set(item.name, bytes);
    }
    for (const item of policy.currentFiles) if (sha(regular(packageRoot, item.name)) !== item.sha256) return 'migration-v2-current-input';
    // The serializer closure is the one proved by the policy's finite case comparison, never a caller-supplied digest.
    const serialized = profile.configuration === 'pkcs7-certificate-import-v1';
    if (librariesSha256 !== (serialized ? policy.currentLibrariesSha256 : null)) return 'migration-v2-library-change';
    const previousLibraries = serialized ? policy.predecessorLibrariesSha256 : null;
    const { evidence: _evidence, ...tested } = cell;
    const files = [...before.keys()].sort().map(name => ({ name, sha256: sha(before.get(name)) }));
    const previousSubject = digest({ cell: tested, files, libraries: previousLibraries });
    if (previousSubject !== predecessor.subjectSha256) return 'migration-v2-predecessor-subject';
    const historicalCell = { ...cell, evidence: { reference: 'predecessor', sha256: predecessor.recordSha256, subjectSha256: previousSubject } };
    if (previous.schema === 'aih.trust.acceptance-migration.v1') {
      const read = name => { if (!before.has(name)) throw new Error('migration-v2-input'); return before.get(name); };
      return checkMigration({ record: previous, cell: historicalCell, subject: previousSubject, packageRoot, checkOriginal, parseOriginal,
        profile, librariesSha256: previousLibraries, read });
    }
    if (previous.schema === 'aih.trust.acceptance.v1') return checkOriginal(previous, historicalCell, previousSubject, profile);
    return 'migration-v2-predecessor-kind';
  } catch { return 'migration-v2-invalid'; }
}
