// Test-only: a disposable copy of an installed Core with unpublished synthetic certificate-export admission for one
// exact trust platform, so the public export and removal paths can run on a host that has no published export cell.
// The copy is never the product, and its records are never product evidence.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Copy an installed Core (dist and package.json), sharing its dependencies through a link. */
export function disposableInstall(installed, into, modules = join(installed, 'node_modules')) {
  mkdirSync(into, { recursive: true });
  cpSync(join(installed, 'dist'), join(into, 'dist'), { recursive: true });
  cpSync(join(installed, 'package.json'), join(into, 'package.json'));
  symlinkSync(modules, join(into, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return into;
}

/**
 * Admit one `off` PEM and one `off` P7B synthetic cell for `platform` (an exact trust-matrix row) in the copy at `root`.
 * Run it in a process that will not itself use the copy's Core: the admission table is read once at import.
 */
export async function admitSyntheticExport(root, platform) {
  const load = name => import(pathToFileURL(join(root, 'dist/harness', name)).href);
  const { trustCellSubjectSha256 } = await load('trust.mjs');
  const { trustProfiles } = await load('trust-definitions.mjs');
  const { trustCellRecords } = await load('trust-capabilities.mjs');
  const cells = [];
  for (const [format, configurationProfile, probeProfile] of [['pem', 'pem-server-ca-v1', 'export-pem-parse-v1'],
    ['p7b', 'pkcs7-certificate-import-v1', 'export-p7b-parse-v1']]) {
    const id = `export-${format}-synthetic-test-off`;
    const cell = { id, definitionId: 'certificate-export', route: 'export', target: null,
      platform: { os: platform.os, release: platform.release, architecture: platform.architecture }, network: 'off',
      projection: platform.projection, client: null, configurationProfile, probeProfile, launchContext: 'no-client',
      evidence: { reference: `dist/harness/acceptance/${id}.json`, sha256: '', subjectSha256: '' } };
    const subject = trustCellSubjectSha256(cell, root);
    const { evidence, ...tested } = cell;
    const record = { schema: 'aih.trust.acceptance.v1', cellId: id, subjectSha256: subject, cell: tested,
      cases: trustProfiles[probeProfile].requiredCases.filter(item => !item.os || item.os === platform.os)
        .map(item => ({ id: item.id, kind: item.kind, outcome: 'passed', summary: 'Unpublished synthetic test admission.' })),
      limitations: [...trustProfiles[probeProfile].requiredLimitations] };
    const bytes = Buffer.from(JSON.stringify(record));
    writeFileSync(join(root, evidence.reference), bytes);
    cells.push({ ...tested, evidence: { ...evidence, subjectSha256: subject, sha256: createHash('sha256').update(bytes).digest('hex') } });
  }
  writeFileSync(join(root, 'dist/harness/trust-capabilities.mjs'),
    `export const trustCellRecords = Object.freeze(${JSON.stringify([...trustCellRecords, ...cells])});\n`);
  return cells.map(cell => cell.id);
}
