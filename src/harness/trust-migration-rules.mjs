// Finite transition only: no general AST normalization or omission of executable inputs.
export const migrationMethod = 'core81-inert-exports-and-exact-export-platform-v1';
export const legacyHelperNames = Object.freeze(['dist/harness/ca.mjs', 'dist/harness/jvm-trust.mjs',
  'dist/harness/trust-definitions.mjs', 'dist/harness/trust-encoding.mjs', 'dist/harness/trust-os.mjs',
  'dist/harness/trust-source.mjs', 'dist/harness/trust.mjs']);
export const addedHelperNames = Object.freeze(['dist/harness/trust-migration.mjs', 'dist/harness/trust-migration-rules.mjs',
  'dist/harness/trust-migration-policy.mjs', 'dist/harness/trust-export-platform.mjs', 'dist/core/trust.js']);
export const serializeMigrationPolicy = value => `// Generated finite migration policy; current subjects and archive hashes live outside this file.\nexport const trustMigrationPolicy = Object.freeze(${JSON.stringify(value, null, 2)});\n`;
const once = (text, before, after) => {
  if (text.split(before).length !== 2) throw new Error('migration-transform');
  return text.replace(before, after);
};
export function projectLegacyHelper(name, bytes) {
  let text = bytes.toString('utf8');
  if (name === 'dist/harness/trust-definitions.mjs') {
    text = once(text, 'export const trustTransformIds = Object.freeze(Object.values(TRANSFORMS));\n', '');
    const start = '/** Candidate (not admitted) export cell skeleton and the proof a record must contain; evidence digests stay unset. */\n';
    const end = '/** Fixed supplied-file integrations; JVM trust binds its explicit baseline and both managed outputs. */';
    if (text.split(start).length !== 2 || text.split(end).length !== 2 || text.indexOf(end) < text.indexOf(start)) throw new Error('migration-transform');
    text = text.slice(0, text.indexOf(start)) + text.slice(text.indexOf(end));
    const row = "  Object.freeze({ os: 'win32', release: 'Windows 11 25H2', architecture: 'x64', projection: 'windows-effective-server-auth-v1' }),";
    text = once(text, row, row + "\n  Object.freeze({ os: 'win32', release: 'Windows 11 26H2 build 26340.9767', architecture: 'x64', projection: 'windows-effective-server-auth-v1' }),");
  } else if (name === 'dist/harness/trust.mjs') {
    text = once(text, "export { buildCertificateExportRecipe, getTrustFileIntegration } from './trust-definitions.mjs';", "export { getTrustFileIntegration } from './trust-definitions.mjs';");
    const imported = "import { validateTrustCapabilities, trustProfiles } from './trust-definitions.mjs';";
    text = once(text, imported, imported + "\nimport { checkTrustMigration } from './trust-migration.mjs';");
    const last = "'dist/harness/jvm-trust.mjs'";
    text = once(text, last, last + ",\n  'dist/harness/trust-migration.mjs', 'dist/harness/trust-migration-rules.mjs', 'dist/harness/trust-migration-policy.mjs',\n  'dist/harness/trust-export-platform.mjs', 'dist/core/trust.js'");
    text = once(text,
      '    const reason = checkAcceptanceRecord(record, cell, subject, trustProfiles[cell.probeProfile]);',
      "    const reason = record?.schema === 'aih.trust.acceptance-migration.v1'\n      ? checkTrustMigration({ record, cell, subject, packageRoot: root, checkOriginal: checkAcceptanceRecord, parseOriginal: parseStrictJson, profile: trustProfiles[cell.probeProfile], librariesSha256: trustProfiles[cell.probeProfile].libraries ? hashTrustLibraries({ packageRoot: root }).sha256 : null })\n      : checkAcceptanceRecord(record, cell, subject, trustProfiles[cell.probeProfile]);");
  }
  return Buffer.from(text);
}
export function projectLegacyCore(text) {
  const imported = "import { getTrustRecipe, renderTrustFileRepair, parseJvmTrustStore, assessRepairObservations } from '../harness/runtime.mjs';";
  text = once(text, imported, imported + "\nimport { detectCertificateExportPlatform, exactExportRelease } from '../harness/trust-export-platform.mjs';");
  text = once(text, '      const platform = detectTrustPlatform();', '      const platform = detectCertificateExportPlatform();');
  const gate = "        if(cell&&!verifyTrustAdmissionEvidence({packageRoot:dirname(distributionManifest),capabilities:trustCapabilities}).valid) throw new Error('review-stale');";
  return once(text, gate, gate + "\n        if(cell?.platform.release===exactExportRelease&&canonicalJson(detectCertificateExportPlatform())!==canonicalJson({...cell.platform,projection:cell.projection})) throw new Error('review-stale');");
}
