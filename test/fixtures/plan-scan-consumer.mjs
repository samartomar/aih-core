// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Scan evidence with plan requests (contract 13). `@aihq/scan` here is the Core-side scan-read-fixture and the
// summaries are TEST-ONLY vectors (scan-fixture.mjs); plan, content and the Catalog reader are Core-side FIXTURES.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFormat } from '@aihq/core/contracts';
import { signerRecords } from '@aihq/core/harness';
import { apply, list, prepare, prepareRemoval } from '@aihq/core';
import { renderRequest, savedDocument } from './plan-fixture.mjs';
import { A, B, inventoryOf, scanEntry, scannedRequest, vectors } from './scan-fixture.mjs';
import * as reader from '@aihq/catalog/reader';

const here = dirname(fileURLToPath(import.meta.url));
const NOTES = 'local-my-skills.skill.notes';
const MEMORY = join(process.env.HOME, '.aih', 'core', 'scans.json');
const CODEX = { id: 'codex', surface: 'cli' };
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.deepEqual(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
/** Scan never decides the status: every prepared request here is ready, whatever its evidence says. */
const shown = prepared => { assert.equal(prepared.status, 'ready', JSON.stringify(prepared)); conforms(prepared.review); return prepared.review.scans; };
const tampered = name => ({ ...scanEntry(name), summary: `${scanEntry(name).summary} ` });
function project(name) {
  const path = mkdtempSync(join(process.env.HOME, `${name}-`));
  writeFileSync(join(path, 'README.md'), 'mine\n');
  return path;
}
function organizationFile(scanSigners) {
  const path = join(process.env.HOME, `org-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ schema: 'urn:aihq:core:organization:0.1.0', id: 'acme',
    entries: [{ id: 'skills-welcome', obligation: 'recommended', content: { kind: 'skill' } }], scanSigners }));
  return { provider: 'local', path };
}
const enterprise = request => ({ ...request, mode: 'enterprise', target: { ...request.target, client: CODEX } });
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

if (process.argv[2] === 'without-scan') {
  await check('without @aihq/scan installed, supplied evidence is an explicit unavailable result and the install still runs', async () => {
    const target = project('no-scan');
    const prepared = await prepare(scannedRequest(target, ['notes'], [scanEntry('notes-r2-a')]));
    const [result] = shown(prepared);
    assert.deepEqual([result.status, result.reason, result.signer, result.match.status], ['unavailable', 'scan-unavailable', null, 'not-checked']);
    assert.equal(conforms(await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  });
  console.log(JSON.stringify({ status: 'passed', checks }));
  process.exit(0);
}

const installed = project('shown');
await check('a summary is shown with its authenticated signer, label, coverage, revision and match; a DO NOT INSTALL score changes nothing', async () => {
  assert.equal(signerRecords.schema, 'urn:aihq:core:signer-records:0.1.0');
  conforms(signerRecords);
  const prepared = await prepare(scannedRequest(installed, ['notes'], [scanEntry('notes-r2-a')]));
  const [result] = shown(prepared);
  assert.deepEqual({ status: result.status, scanKey: result.scanKey, revision: result.revision, label: result.label, coverage: result.coverage,
    withdrawn: result.withdrawn, older: result.older, managementIds: result.managementIds, match: result.match.status, source: result.match.source },
  { status: 'verified', scanKey: vectors.keys.notes, revision: 2, label: 'DO NOT INSTALL', coverage: 'partial', withdrawn: false, older: false,
    managementIds: [NOTES], match: 'matches', source: 'files' });
  // Without an organization only the default signer records are trusted: signer A is authenticated, not trusted.
  assert.deepEqual(result.signer, { identity: A.subject, trusted: false, issuer: A.issuer, subject: A.subject });
  assert.ok(result.sentence.includes('not by a trusted publisher'), result.sentence);
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const entry = conforms(await list({ target: { project: installed }, scope: 'project' })).entries.find(row => row.managementId === NOTES);
  assert.deepEqual(entry.scans.map(row => [row.scanKey, row.revision, row.signer.subject, row.label, row.match]),
    [[vectors.keys.notes, 2, A.subject, 'DO NOT INSTALL', 'matches']]);
});

await check('an older revision is flagged per key and signer, and the memory outlives removal and reinstall', async () => {
  const [olderA, firstB] = shown(await prepare(scannedRequest(project('older'), ['notes'], [scanEntry('notes-r1-a'), scanEntry('notes-r1-b')])));
  assert.deepEqual([olderA.older, olderA.lastSeen, olderA.sentence.includes('older than the last result seen')], [true, 2, true]);
  // Another signer's results are its own: signer B has seen nothing older.
  assert.deepEqual([firstB.older, firstB.lastSeen, firstB.signer.subject], [false, null, B.subject]);
  const removal = await prepareRemoval({ target: { project: installed }, scope: 'project', removals: [{ managementId: NOTES }] });
  assert.equal(conforms(await apply(removal.handle, approve(removal.review))).completion, 'complete');
  const again = await prepare(scannedRequest(installed, ['notes'], [scanEntry('notes-r1-a')]));
  assert.deepEqual(shown(again).map(row => [row.older, row.lastSeen]), [[true, 2]]);
  assert.equal(conforms(await apply(again.handle, approve(again.review))).completion, 'complete');
  assert.deepEqual(shown(await prepare(scannedRequest(project('reinstalled'), ['notes'], [scanEntry('notes-r1-a')]))).map(row => row.older), [true]);
});

await check('an organization adds or replaces the allowed signers: trust follows the authenticated issuer and subject, never a label', async () => {
  const request = () => enterprise(scannedRequest(project('org'), ['notes'], [scanEntry('notes-r1-a'), scanEntry('notes-r1-b')], { clis: ['codex'] }));
  const added = shown(await prepare(request(), { organization: organizationFile({ add: [A] }) }));
  assert.deepEqual(added.map(row => [row.signer.subject, row.signer.trusted, row.signer.identity]), [[A.subject, true, A.identity], [B.subject, false, B.subject]]);
  const replaced = shown(await prepare(request(), { organization: organizationFile({ replace: [B] }) }));
  assert.deepEqual(replaced.map(row => [row.signer.subject, row.signer.trusted]), [[A.subject, false], [B.subject, true]]);
  // A label naming signer A but another subject trusts nobody.
  const label = shown(await prepare(request(), { organization: organizationFile({ replace: [{ identity: A.identity, issuer: A.issuer, subject: 'https://test.invalid/other' }] }) }));
  assert.deepEqual(label.map(row => row.signer.trusted), [false, false]);
});

await check('a withdrawal counts only authenticated for the same key and signer; withdrawn-through is remembered even from a later revision', async () => {
  const where = project('withdrawn');
  const foreign = shown(await prepare(scannedRequest(where, ['notes'], [scanEntry('notes-r3-a', { withdrawn: ['notes-through-9-b', 'tools-through-9-a'] })])))[0];
  assert.deepEqual([foreign.withdrawn, foreign.withdrawals.map(row => [row.status, row.reason])],
    [false, [['not-applicable', 'other-signer'], ['not-applicable', 'other-key']]]);
  const later = shown(await prepare(scannedRequest(where, ['notes'], [scanEntry('notes-r5-a', { withdrawn: ['notes-through-3-a'] })])))[0];
  assert.deepEqual([later.withdrawn, later.withdrawals], [false, [{ status: 'not-applicable', reason: 'later-revision', throughRevision: 3 }]]);
  // Revision 3 is now remembered as withdrawn for A, and older than revision 5.
  const remembered = shown(await prepare(scannedRequest(where, ['notes'], [scanEntry('notes-r3-a'), scanEntry('notes-r1-b')])));
  assert.deepEqual(remembered.map(row => [row.withdrawn, row.older]), [[true, true], [false, false]]);
  assert.ok(remembered[0].sentence.includes('withdrawn'), remembered[0].sentence);
  const supplied = shown(await prepare(scannedRequest(where, ['notes'], [scanEntry('notes-r3-a', { withdrawn: ['notes-through-3-a'] })])))[0];
  assert.deepEqual([supplied.withdrawn, supplied.signer.trusted, supplied.withdrawals], [true, false, [{ status: 'applies', throughRevision: 3 }]]);
});

await check('matching uses the source tree: missing inventory is not checked, a supplied inventory matches or differs, and unverifiable evidence shows nothing', async () => {
  const where = project('match');
  const omitted = shown(await prepare(scannedRequest(where, ['tools'], [scanEntry('tools-r1-a')], { omit: { tools: 'helper.md' } })))[0];
  assert.deepEqual(omitted.match, { status: 'not-checked', reason: 'inventory-not-supplied' });
  assert.ok(omitted.sentence.includes('match not checked: inventory not supplied'), omitted.sentence);
  const complete = shown(await prepare(scannedRequest(where, ['tools'], [scanEntry('tools-r1-a', { inventory: inventoryOf('tools') })], { omit: { tools: 'helper.md' } })))[0];
  assert.deepEqual([complete.match.status, complete.match.source], ['matches', 'inventory']);
  const wrong = shown(await prepare(scannedRequest(where, ['tools'], [scanEntry('tools-r1-a', { inventory: inventoryOf('tools', { 'helper.md': 'Changed.\n' }) })], { omit: { tools: 'helper.md' } })))[0];
  assert.deepEqual([wrong.match.status, wrong.match.differences.changed], ['differs', ['helper.md']]);
  const edited = shown(await prepare(scannedRequest(where, ['notes'], [scanEntry('notes-r5-a')], { changed: { notes: { 'SKILL.md': 'Edited.\n' } } })))[0];
  assert.deepEqual([edited.match.status, edited.match.source, edited.match.differences.changed], ['differs', 'files', ['SKILL.md']]);
  const forged = shown(await prepare(scannedRequest(where, ['notes'], [tampered('notes-r5-a')])))[0];
  assert.deepEqual([forged.status, forged.reason, forged.scanKey, forged.label, forged.signer], ['not-verified', 'invalid-signature', null, null, null]);
});

await check('rendered output is reported as not scanned and never as covered by the source scan', async () => {
  const request = renderRequest(reader, project('render'), { notes: vectors.content.notes }, ['codex']);
  for (const item of request.contents[0].items) item.scanKey = vectors.keys.notes;
  const prepared = await prepare({ ...request, scans: [scanEntry('notes-r5-a')] }, { catalog: { version: '0.0.0-core-fixture', renderStep: reader.renderStep } });
  const [result] = shown(prepared);
  assert.equal(result.match.status, 'matches');
  const renders = request.plan.plan.flatMap((step, index) => step.render !== undefined ? [index] : []);
  assert.ok(renders.length > 0);
  assert.deepEqual(prepared.review.notScanned.map(row => [row.step, row.reason]), renders.map(index => [index, 'rendered']));
});

await check('Scan state changing between Prepare and Apply never invalidates the reviewed Apply', async () => {
  const where = project('stale-scan');
  const request = scannedRequest(where, ['notes'], [scanEntry('notes-r2-a')]);
  const prepared = await prepare(request);
  shown(prepared);
  shown(await prepare(scannedRequest(project('meanwhile'), ['notes'], [scanEntry('notes-r5-a', { withdrawn: ['notes-through-3-a'] })])));
  request.scans.push(tampered('notes-r1-a'));
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
});

await check('the 2 MiB memory evicts the oldest unheld entries first, then the oldest held with scan-memory-full, and never refuses', async () => {
  const seed = (scanKey, count) => {
    const current = JSON.parse(readFileSync(MEMORY, 'utf8'));
    for (let index = 0; index < count; index++) current.entries.unshift({ scanKey: scanKey ?? `git-sha1:${index.toString(16).padStart(40, '0')}`,
      issuer: 'https://issuer.test.invalid', subject: `https://test.invalid/filler-${index}-${'x'.repeat(300)}`, revision: 1, withdrawnThrough: null, seen: 1 });
    writeFileSync(MEMORY, JSON.stringify(current));
    assert.ok(statSync(MEMORY).size > 2 * 1_048_576);
  };
  // Installed notes (the "Scan state" check's install) hold the notes key.
  seed(undefined, 6000);
  const unheld = await prepare(scannedRequest(project('evict'), ['notes'], [scanEntry('notes-r1-a')]));
  assert.deepEqual(shown(unheld).map(row => row.older), [true], 'the held key keeps its memory');
  assert.equal(unheld.review.warnings.some(text => text.startsWith('scan-memory-full')), false);
  assert.ok(statSync(MEMORY).size <= 2 * 1_048_576);
  const kept = JSON.parse(readFileSync(MEMORY, 'utf8')).entries;
  // Signer B's entry for the held key was not touched by this request, and stays; unheld filler went first.
  assert.ok(kept.some(row => row.scanKey === vectors.keys.notes && row.subject === B.subject));
  assert.ok(kept.filter(row => row.subject.includes('filler')).length < 6000);
  seed(vectors.keys.notes, 6000);
  const held = await prepare(scannedRequest(project('evict-held'), ['notes'], [scanEntry('notes-r1-a')]));
  shown(held);
  assert.ok(held.review.warnings.some(text => text.startsWith('scan-memory-full')), JSON.stringify(held.review.warnings));
  assert.ok(statSync(MEMORY).size <= 2 * 1_048_576);
  assert.equal(conforms(await apply(held.handle, approve(held.review))).completion, 'complete');
});

await check('the aih CLI installs a saved request with DO NOT INSTALL and unverifiable evidence, with the ordinary exit codes', async () => {
  const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
  const aih = args => {
    const child = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return { code: child.status, result: JSON.parse(child.stdout.trim().split('\n').at(-1)) };
  };
  const target = project('cli');
  const source = mkdtempSync(join(process.env.HOME, 'source-'));
  const request = scannedRequest(target, ['notes'], [scanEntry('notes-r2-a'), tampered('notes-r2-a')]);
  for (const file of request.files) { mkdirSync(dirname(join(source, file.sourcePath)), { recursive: true }); writeFileSync(join(source, file.sourcePath), file.bytes); }
  const document = join(source, '..', 'scan-request.json');
  writeFileSync(document, JSON.stringify(savedDocument(request)));
  const preview = aih(['install', document, '--project', target, '--source', `local-my-skills=${source}`, '--json']);
  assert.deepEqual([preview.code, preview.result.status], [0, 'ready'], JSON.stringify(preview));
  const done = aih(['install', document, '--project', target, '--source', `local-my-skills=${source}`, '--apply', '--yes', '--json']);
  assert.deepEqual([done.code, done.result.completion], [0, 'complete'], JSON.stringify(done));
});

console.log(JSON.stringify({ status: 'passed', checks }));
