import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { trustCapabilities } from '../../dist/harness/contracts.mjs';
import { trustHelperFiles, trustCellSubjectSha256 } from '../../src/harness/trust.mjs';
import { trustProfiles } from '../../src/harness/trust-definitions.mjs';
const source = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const historical = trustCapabilities.cells.filter(cell => cell.evidence.reference.includes('/migration-'));
assert.equal(historical.length,4);

test('generator refuses duplicate native cells, wrong tuples and mismatched record identities', () => {
  const scratch = join(source, '.scratch'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'migration-generator-'));
  try {
    const copy = name => { mkdirSync(dirname(join(root,name)), { recursive:true }); cpSync(join(source,name),join(root,name),{recursive:true}); };
    for (const name of ['src/harness','src/core/trust.ts','scripts/generate-trust-migration.mjs',
      'scripts/fixtures/trust-migration-predecessor.json','package.json']) copy(name);
    for (const name of trustHelperFiles) copy(name);
    mkdirSync(join(root,'dist/harness/acceptance'),{recursive:true});
    for (const name of ['src/fixtures/harness/trust-capabilities/1.0.0','dist/fixtures/harness/trust-capabilities/1.0.0']) copy(name);
    // These disposable passing-case fixtures test structural refusal only. They
    // are never written to the product tree or represented as native evidence.
    const native = historical.map(old => {
      const id = old.id.replace('win32-', 'win32-26340-9767-');
      const cell = { ...old, id, platform: { ...old.platform, release: 'Windows 11 26H2 build 26340.9767' },
        evidence: { reference:`dist/harness/acceptance/${id}.json`,sha256:'',subjectSha256:'' } };
      const { evidence, ...tested } = cell;
      const subject = trustCellSubjectSha256(cell, root);
      const record = {schema:'aih.trust.acceptance.v1',cellId:id,cell:tested,subjectSha256:subject,
        cases:trustProfiles[cell.probeProfile].requiredCases.map(item => ({id:item.id,kind:item.kind,outcome:'passed',summary:'Fixture for structural refusal.'})),
        limitations:['no-os-fullset-claim','no-native-client-claim']};
      const bytes = Buffer.from(JSON.stringify(record));
      writeFileSync(join(root,'src/harness/acceptance',`${id}.json`),bytes);
      return {...tested,evidence:{...evidence,sha256:sha(bytes),subjectSha256:subject}};
    });
    const run = (cells, expected) => {
      writeFileSync(join(root,'src/harness/trust-capabilities.mjs'),`export const trustCellRecords = Object.freeze(${JSON.stringify([...historical,...cells])});\n`);
      const result = spawnSync(process.execPath,[join(root,'scripts/generate-trust-migration.mjs')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1048576});
      assert.notEqual(result.status,0, 'malformed native table must refuse');
      assert.match(result.stderr,expected);
    };
    run(Array(4).fill(native[0]), /exact unique four native cell IDs required/);
    const wrongTuple = structuredClone(native); wrongTuple[0].network = 'off';
    run(wrongTuple, /native format\/network\/platform tuple must match/);
    for (const field of ['cellId','cell']) {
      const cells = structuredClone(native); const file = join(root,'src/harness/acceptance',`${cells[0].id}.json`);
      const original = readFileSync(file); const record = JSON.parse(original);
      if (field === 'cellId') record.cellId = cells[1].id; else record.cell.network = 'off';
      const bytes = Buffer.from(JSON.stringify(record)); writeFileSync(file,bytes); cells[0].evidence.sha256=sha(bytes);
      run(cells, field === 'cellId' ? /native record ID must match/ : /native record cell must match/);
      writeFileSync(file,original);
    }
  } finally {
    assert.ok(resolve(root).startsWith(resolve(scratch)+sep)); rmSync(root,{recursive:true,force:true});
  }
});
