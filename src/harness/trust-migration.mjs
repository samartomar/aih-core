// Versioned, finite historical continuity. Never reports a new native execution.
import { lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalTrustJson } from './trust-source.mjs';
import { trustMigrationPolicy as policy } from './trust-migration-policy.mjs';
import { migrationMethod, legacyHelperNames, projectLegacyHelper, serializeMigrationPolicy } from './trust-migration-rules.mjs';
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
function regular(root, name) {
  // All names come from the fixed shipped policy, not the caller or envelope.
  if (!/^dist\/(?:harness|core)\/[a-z0-9.-]+\.(?:mjs|js)$/.test(name)) throw new Error('migration-policy');
  let ancestor = root;
  for (const segment of name.split('/').slice(0, -1)) {
    ancestor = join(ancestor, segment); const directory = lstatSync(ancestor);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('migration-input');
  }
  const path = join(root, name); const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000000) throw new Error('migration-input');
  return readFileSync(path);
}
export function checkTrustMigration({ record, cell, subject, packageRoot, checkOriginal, parseOriginal, profile, librariesSha256 }) {
  try {
    if (!exact(record, ['schema','kind','cellId','subjectSha256','method','proofSha256','originalRecordBytes','originalFiles','limitations']) ||
        record.schema !== 'aih.trust.acceptance-migration.v1' || record.kind !== 'equivalence-migration' ||
        record.cellId !== cell.id || record.subjectSha256 !== subject || record.method !== migrationMethod ||
        record.proofSha256 !== policy.proofSha256) return 'migration-shape';
    const predecessor = policy.predecessors?.find(item => item.id === cell.id);
    if (!predecessor || policy.method !== migrationMethod || digest(policy.proof) !== policy.proofSha256) return 'migration-policy';
    if (!regular(packageRoot, 'dist/harness/trust-migration-policy.mjs').equals(Buffer.from(serializeMigrationPolicy(policy)))) return 'migration-policy-changed';
    const originalBytes = bytes64(record.originalRecordBytes);
    if (sha(originalBytes) !== predecessor.recordSha256) return 'migration-original-digest';
    // Exact known bytes are checked before parsing: no caller-selected historical JSON has authority.
    const original = parseOriginal(new TextDecoder('utf-8', { fatal: true }).decode(originalBytes));
    const expectedLimitations = [...original.limitations, 'equivalence-migration-no-new-old-os-execution'];
    if (canonicalTrustJson(record.limitations) !== canonicalTrustJson(expectedLimitations)) return 'migration-limitations';
    if (!Array.isArray(record.originalFiles) || record.originalFiles.length !== legacyHelperNames.length) return 'migration-inputs';
    const files = [];
    for (const [index, name] of legacyHelperNames.entries()) {
      const item = record.originalFiles[index];
      if (!exact(item, ['name','bytesBase64']) || item.name !== name) return 'migration-inputs';
      const before = bytes64(item.bytesBase64);
      if (sha(before) !== policy.originalFiles[index]?.sha256 || policy.originalFiles[index]?.name !== name) return 'migration-preimage';
      if (!projectLegacyHelper(name, before).equals(regular(packageRoot, name))) return 'migration-executable-change';
      files.push({ name, sha256: sha(before) });
    }
    for (const item of policy.currentFiles) if (sha(regular(packageRoot, item.name)) !== item.sha256) return 'migration-current-input';
    const { evidence: _evidence, ...tested } = cell;
    const libraries = profile.configuration === 'pkcs7-certificate-import-v1' ? policy.originalLibrariesSha256 : null;
    if (librariesSha256 !== libraries) return 'migration-library-change';
    const oldSubject = digest({ cell: tested, files, libraries });
    if (oldSubject !== predecessor.subjectSha256) return 'migration-original-subject';
    const historicalCell = { ...cell, evidence: { reference: 'original', sha256: predecessor.recordSha256, subjectSha256: oldSubject } };
    return checkOriginal(original, historicalCell, oldSubject, profile);
  } catch { return 'migration-invalid'; }
}
