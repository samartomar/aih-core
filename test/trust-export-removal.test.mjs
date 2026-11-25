import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { trustCapabilities, selectTrustCell } from '../dist/harness/contracts.mjs';
import { trustPlatformMatrix } from '../dist/harness/trust-definitions.mjs';
import { detectCertificateExportPlatform } from '../dist/harness/trust-export-platform.mjs';
import { disposableInstall } from './fixtures/synthetic-export-admission.mjs';

const platform = detectCertificateExportPlatform();
const row = trustPlatformMatrix.find(item => item.os === platform.os && item.release === platform.release &&
  item.architecture === platform.architecture && item.projection === platform.projection);
const admitted = format => selectTrustCell({ definitionId: 'certificate-export', route: 'export', target: null, platform,
  network: 'off', format }, trustCapabilities).status === 'admitted';
const skip = !row ? 'This host is not an exact trust platform.' : false;
const helper = pathToFileURL(fileURLToPath(new URL('./fixtures/synthetic-export-admission.mjs', import.meta.url))).href;

// A disposable installed copy. Where this host has no published export cell, unpublished synthetic cells for its exact
// platform are admitted in the copy only, so the public export and removal paths run here. Never product evidence.
function installedCopy(scratch) {
  const source = fileURLToPath(new URL('../', import.meta.url));
  const installed = disposableInstall(source, join(scratch, 'installed'), join(source, 'node_modules'));
  if (!admitted('pem') || !admitted('pkcs7-der'))
    execFileSync(process.execPath, ['--input-type=module', '-e',
      `const { admitSyntheticExport } = await import(${JSON.stringify(helper)}); await admitSyntheticExport(${JSON.stringify(installed)}, ${JSON.stringify(row)});`],
      { encoding: 'utf8', timeout: 60_000 });
  return name => JSON.stringify(pathToFileURL(join(installed, 'dist', name)).href);
}

for (const format of ['pem', 'pkcs7-der'])
  test(`public prepareRemoval removes an applied ${format} certificate export through its single-id custody`, { skip }, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'aih-export-removal-'));
    try {
      const url = installedCopy(scratch); const home = join(scratch, 'home'); mkdirSync(home);
      const file = join(scratch, 'team.pem'); cpSync(new URL('./fixtures/root-a.pem', import.meta.url), file);
      const script = join(scratch, 'driver.mjs');
      writeFileSync(script, `
import { prepare, apply, prepareRemoval } from ${url('core/index.js')};
import { validateFormat } from ${url('core/contracts.js')};
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const controls = { logging: 'off' };
const receipts = join(process.env.HOME, '.aih/core/ownership');
const owned = id => existsSync(receipts) && readdirSync(receipts).some(name => Object.values(JSON.parse(readFileSync(join(receipts, name), 'utf8')).members).some(m => m.managementId === id));
const authorize = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const custody = () => JSON.parse(readFileSync(join(process.env.HOME, '.aih/core/trust-custody.json'), 'utf8')).entries.map(e => e.managementId);
const p = await prepare({ schema: 'urn:aihq:core:export-request:0.1.0', format: ${JSON.stringify(format)}, output: 'exports/team.${format === 'pem' ? 'pem' : 'p7b'}',
  network: 'off', sources: { os: false, supplied: [{ id: 'team', file: ${JSON.stringify(file)} }] } }, controls);
if (p.status !== 'ready') throw new Error(JSON.stringify(p));
const managementId = p.review.steps[0].managementId;
const written = await apply(p.handle, authorize(p.review), controls);
const path = written.environment.outputs[0].path;
const before = { completion: written.completion, exists: existsSync(path), custody: custody().includes(managementId), owned: owned(managementId) };
const removal = await prepareRemoval({ target: { project: null }, scope: 'user', removals: [{ managementId }] }, controls);
const prepared = { status: removal.status, handle: typeof removal.handle, entries: removal.entries,
  review: removal.review ? validateFormat(removal.review) : null };
const removed = removal.handle ? await apply(removal.handle, authorize(removal.review), controls) : null;
const again = await prepareRemoval({ target: { project: null }, scope: 'user', removals: [{ managementId }] }, controls);
console.log(JSON.stringify({ managementId, before, prepared,
  removed: removed && { run: validateFormat(removed), completion: removed.completion, exists: existsSync(path), custody: custody().includes(managementId), owned: owned(managementId) },
  again: { status: again.status, handle: typeof again.handle, entries: again.entries } }));
`);
      const result = JSON.parse(execFileSync(process.execPath, [script],
        { cwd: scratch, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 120_000 }));
      assert.match(result.managementId, /^ca-export-[a-f0-9]{64}$/);
      assert.deepEqual(result.before, { completion: 'complete', exists: true, custody: true, owned: true });
      // The review names the export's own single-id custody; nothing else is offered for removal.
      assert.equal(result.prepared.status, 'ok', JSON.stringify(result.prepared));
      assert.equal(result.prepared.handle, 'object', JSON.stringify(result.prepared));
      assert.deepEqual(result.prepared.review, { status: 'ok', schema: 'urn:aihq:core:review:0.1.0' });
      assert.deepEqual(result.prepared.entries.map(entry => [entry.managementId, entry.disposition]), [[result.managementId, 'prepared']]);
      // Apply retires the output and its protected custody with the export's ordinary ownership.
      assert.deepEqual(result.removed, { run: { status: 'ok', schema: 'urn:aihq:core:run:0.1.0' }, completion: 'complete', exists: false, custody: false, owned: false });
      assert.equal(result.again.handle, 'undefined');
      assert.ok(result.again.entries.every(entry => entry.disposition !== 'prepared'), JSON.stringify(result.again));
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

// The single-id route is only for one custody-held ID with readable custody. Everything else keeps the batch refusals.
test('public prepareRemoval refuses a multi-ID request with an export, naming why, and unreadable custody, with no handle', { skip }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'aih-export-removal-refusals-'));
  try {
    const url = installedCopy(scratch); const home = join(scratch, 'home'); mkdirSync(home);
    const file = join(scratch, 'team.pem'); cpSync(new URL('./fixtures/root-a.pem', import.meta.url), file);
    const script = join(scratch, 'driver.mjs');
    writeFileSync(script, `
import { prepare, apply, prepareRemoval } from ${url('core/index.js')};
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const controls = { logging: 'off' };
const p = await prepare({ schema: 'urn:aihq:core:export-request:0.1.0', format: 'pem', output: 'exports/team.pem',
  network: 'off', sources: { os: false, supplied: [{ id: 'team', file: ${JSON.stringify(file)} }] } }, controls);
if (p.status !== 'ready') throw new Error(JSON.stringify(p));
const managementId = p.review.steps[0].managementId;
const written = await apply(p.handle, { approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest }, controls);
const path = written.environment.outputs[0].path;
const shape = r => ({ status: r.status, code: r.code, handle: typeof r.handle, entries: r.entries });
const multi = shape(await prepareRemoval({ target: { project: null }, scope: 'user', removals: [{ managementId }, { managementId: 'other-thing' }] }, controls));
const custodyFile = join(process.env.HOME, '.aih/core/trust-custody.json'); const custody = readFileSync(custodyFile);
writeFileSync(custodyFile, '{');
const unreadable = shape(await prepareRemoval({ target: { project: null }, scope: 'user', removals: [{ managementId }] }, controls));
writeFileSync(custodyFile, custody);
console.log(JSON.stringify({ managementId, multi, unreadable, exists: existsSync(path) }));
`);
    const result = JSON.parse(execFileSync(process.execPath, [script],
      { cwd: scratch, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 120_000 }));
    assert.equal(result.multi.status, 'ok', JSON.stringify(result.multi));
    assert.equal(result.multi.handle, 'undefined', JSON.stringify(result.multi));
    // The custody-held export says why it was not prepared: it is removed in its own single-id request (#193).
    // The other entry keeps its ordinary shape.
    assert.deepEqual(result.multi.entries, [
      { managementId: result.managementId, disposition: 'unavailable', members: [], reason: 'single-removal-required' },
      { managementId: 'other-thing', disposition: 'absent', members: [] }], JSON.stringify(result.multi));
    assert.equal(result.unreadable.status, 'refused', JSON.stringify(result.unreadable));
    assert.equal(result.unreadable.handle, 'undefined', JSON.stringify(result.unreadable));
    assert.equal(result.exists, true, 'neither refusal touched the output');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
