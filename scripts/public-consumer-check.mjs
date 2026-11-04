// Runs inside the isolated consumer of scripts/verify-public-consumer.mjs, with HOME set to a disposable home and
// TEST_PROJECT to a disposable project. Prints a JSON receipt `{ status, checks, notExercised }` as its last line.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checks = [], notExercised = [];
async function check(name, body) {
  try { await body(); checks.push({ name, status: 'passed' }); }
  catch (error) { checks.push({ name, status: 'failed', error: String(error?.stack ?? error).slice(0, 4000) }); }
}
const core = await import('@aihq/core');
const contracts = await import('@aihq/core/contracts');
const harness = await import('@aihq/core/harness');
const runtime = await import('@aihq/core/harness/runtime');
const installed = fileURLToPath(new URL('../../', import.meta.resolve('@aihq/core')));
const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
const project = process.env.TEST_PROJECT;
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });

await check('exactly four package entries and the two bins', () => {
  assert.deepEqual(Object.keys(manifest.exports), ['.', './contracts', './harness', './harness/runtime']);
  assert.deepEqual(Object.keys(manifest.bin).sort(), ['aih', 'aih-linux-facility']);
});
await check('nothing removed by contract 17 can be imported', async () => {
  for (const specifier of ['@aihq/core/support', '@aihq/core/report', '@aihq/core/schemas/recipe/1.0.0.json', '@aihq/core/harness/schemas/repair/1.0.0.json'])
    await assert.rejects(import(specifier, specifier.endsWith('.json') ? { with: { type: 'json' } } : undefined), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  const names = [...Object.keys(core), ...Object.keys(contracts), ...Object.keys(harness), ...Object.keys(runtime)];
  for (const retired of ['renderDelivery', 'checkCompatibility', 'deriveRecipeIdentity', 'authenticateEvidence', 'verificationPublishers',
    'createTufTrustClient', 'verifyNativeClient', 'parsePolicy', 'validatePolicy', 'listManagedSelections', 'prepareManagedRemoval', 'checkFileState'])
    assert.equal(names.includes(retired), false, retired);
});
await check('one schema per format; every valid fixture reads ok and every invalid one invalid', () => {
  const ids = Object.keys(contracts.schemas);
  assert.ok(ids.length > 0 && ids.every(id => /^urn:aihq:core:[a-z-]+:0\.1\.0$/.test(id)));
  for (const [id, entry] of Object.entries(contracts.schemas)) {
    assert.deepEqual(contracts.validateFormat(entry.fixtures.valid), { status: 'ok', schema: id });
    assert.equal(contracts.validateFormat(entry.fixtures.invalid).status, 'invalid');
  }
  assert.deepEqual(contracts.contractSupport.contracts.map(item => item.id).sort(), [...ids].sort());
});
await check('Core reaches Scan only through @aihq/scan/read, as an optional peer', () => {
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), ['@aihq/scan']);
  assert.deepEqual(manifest.peerDependenciesMeta?.['@aihq/scan'], { optional: true });
  for (const name of ['@aihq/catalog', '@aihq/scan', '@aihq/harness']) assert.equal(manifest.dependencies?.[name], undefined, name);
  const found = new Set();
  const walk = dir => { for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) walk(path);
    else if (/\.m?js$/.test(name.name)) for (const match of readFileSync(path, 'utf8').matchAll(/['"](@aihq\/scan(?:\/[\w./-]*)?)['"]/g)) found.add(match[1]);
  } };
  walk(join(installed, 'dist'));
  assert.deepEqual([...found], ['@aihq/scan/read']);
});
await check('own content (FIXTURE plan): install, list as chosen, compare files, remove, with receipts in the one receipt format', async () => {
  const { ownRequest } = await import('./plan-fixture.mjs');
  const request = () => ownRequest(project, { notes: { 'SKILL.md': '# Notes\n' } }, ['claude-code', 'codex']);
  const prepared = await core.prepare(request());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal((await core.apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const inventory = await core.list({ target: { project }, scope: 'project' });
  assert.ok(inventory.entries.every(entry => entry.origin === 'chosen' && entry.data === null));
  assert.equal(contracts.validateFormat(await core.checkFiles(request())).status, 'ok');
  for (const name of readdirSync(join(process.env.HOME, '.aih/core/ownership')))
    assert.equal(contracts.validateFormat(JSON.parse(readFileSync(join(process.env.HOME, '.aih/core/ownership', name), 'utf8'))).schema, 'urn:aihq:core:receipt:0.1.0');
  const removal = await core.prepareRemoval({ target: { project }, scope: 'project', removals: inventory.entries.map(entry => ({ managementId: entry.managementId })) });
  assert.equal((await core.apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.equal(existsSync(join(project, '.claude')), false);
});
await check('a change is reviewed, applied and removed, restoring the original bytes', async () => {
  const request = { schema: 'urn:aihq:core:change-request:0.1.0', mode: 'vibe', scope: 'project', target: { project },
    changes: [{ managementId: 'team-guidance', inputs: {}, requires: [], change: { schema: 'urn:aihq:core:change:0.1.0', id: 'team-guidance',
      description: 'Project guidance', inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [],
      operations: [{ id: 'write', purpose: 'Write project guidance', kind: 'file.write', scope: 'project',
        target: { root: 'project', segments: [{ literal: 'TEAM.md' }] }, content: { literal: 'Guidance\n' }, requires: [], checks: [] }] } }] };
  const prepared = await core.prepare(request);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal((await core.apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const removal = await core.prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: 'team-guidance' }] });
  assert.equal((await core.apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.equal(existsSync(join(project, 'TEAM.md')), false);
});
await check('an older request format is not read', async () => {
  assert.equal((await core.prepare({ schema: 'urn:aihq:core:execution-policy:1.4.0' })).status, 'unsupported-version');
});
await check('history and receipts hold no private input value', async () => {
  const text = readdirSync(join(process.env.HOME, '.aih/core'), { recursive: true }).join('\n');
  assert.equal(text.includes('SECRET'), false);
});
await check('portable Harness data reads as its own formats, repairs named by their repair ids', () => {
  for (const value of [...harness.repairIndex, harness.trustCapabilities, harness.toolRegistry, harness.signerRecords, harness.macosSessionProfiles])
    assert.equal(contracts.validateFormat(value).status, 'ok', value.schema);
  assert.ok(harness.repairIndex.every(definition => definition.managementId === definition.id));
});
// Producers: a real Catalog and a real Scan are exercised only when their artifacts are supplied.
let catalog;
try { catalog = await import('@aihq/catalog/reader'); } catch { catalog = undefined; }
if (catalog) await check('the supplied Catalog exposes the reader Core uses (renderStep, planRecipe)', () => {
  for (const name of ['renderStep', 'planRecipe']) assert.equal(typeof catalog[name], 'function', name);
});
else notExercised.push('Real Catalog plan: renderStep/planRecipe/planInstall from a delivered @aihq/catalog artifact (Core-side FIXTURES only here)');
let scan;
try { scan = await import('@aihq/scan/read'); } catch { scan = undefined; }
if (scan) await check('the supplied Scan exposes @aihq/scan/read (verifySummary, matchScan)', () => {
  for (const name of ['verifySummary', 'matchScan']) assert.equal(typeof scan[name], 'function', name);
});
else notExercised.push('Real Scan summary: verifySummary/matchScan from a delivered @aihq/scan artifact');
notExercised.push('Native client and platform claims (verify-client on an admitted cell, live plugins.remove) need separately identified real evidence');
const failed = checks.filter(item => item.status !== 'passed');
console.log(JSON.stringify({ status: failed.length ? 'failed' : 'passed', checks, notExercised }));
