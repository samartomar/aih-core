// A supporting document goes with the last item that required it. Removing a requirer, by set origin or by itself,
// drops the document's `required-by` origin for it; once no requirer remains and nothing else holds the document
// (no chosen or set origin, no other selection requiring it), the same removal removes it. Real Catalog 1.7.0 ECC
// content: ecc.notices and two agents that share its copy, vendored in the fixture, so no packed Catalog is needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, listManagedSelections, prepare, prepareManagedRemoval } from '../dist/core/index.js';
import { removalClaims } from '../dist/core/contracts.js';
import { toolBindings } from '../dist/harness/contracts.mjs';
import { approve, catalogRoot, controls } from './real-catalog-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-notices-freed-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(scratch, { recursive: true, force: true });
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const path = 'release-ecc.content.json';
const bytes = readFileSync(join(catalogRoot, path));
const ecc = JSON.parse(bytes);
const item = id => ecc.items.find(entry => entry.id === id);
const claude = toolBindings.find(binding => binding.tool === 'claude');
const AGENTS = ['ecc.agent.a11y-architect', 'ecc.agent.agent-evaluator'];
const agentsCore = ecc.sets.find(set => set.id === 'ecc.module.agents-core');
const inSet = { set: { framework: 'ecc', setId: agentsCore.id, setSha256: agentsCore.setSha256 } };
const managementId = id => `project--aihq.catalog--${id}`;
const requiredBy = itemId => ({ reasonIncluded: 'required-by', requiredBy: { framework: 'ecc', itemId } });
const selection = (id, origins, requires) => {
  const found = item(id);
  return { id, managementId: managementId(id), scope: 'project', configuration: {}, requires,
    item: { framework: 'ecc', itemId: id, contentSha256: found.contentSha256, behaviourSha256: found.behaviourSha256 },
    tool: 'claude', name: found.name ?? found.label, kind: found.kind, origins, bindingDigest: claude.digest };
};
// The first agent comes from its starting set, the second is chosen directly; ecc.notices is required by both.
const policy = noticesOrigins => ({ schema: 'urn:aihq:core:execution-policy:1.6.0', mode: 'vibe',
  catalogReleases: [{ framework: 'ecc', source: { kind: 'local', input: 'catalog' }, path, sha256: sha256(bytes), byteLength: bytes.length }],
  selections: [
    selection('ecc.notices', noticesOrigins, []),
    selection(AGENTS[0], [{ reasonIncluded: 'in-set', set: inSet.set }], ['ecc.notices']),
    selection(AGENTS[1], [{ reasonIncluded: 'chosen' }], ['ecc.notices'])] });
const inventory = async project => (await listManagedSelections({ target: { project }, scope: 'project',
  format: 'urn:aihq:core:managed-inventory-result:1.1.0' })).selections;
const originsOf = async (project, id) => (await inventory(project)).find(entry => entry.managementId === managementId(id))?.origins;

async function install(name, noticesOrigins) {
  for (const id of ['ecc.notices', ...AGENTS]) for (const member of item(id).materials)
    assert.equal(sha256(readFileSync(join(catalogRoot, member.packagePath))), member.sha256, `${id} ${member.relPath} is the published bytes`);
  const folder = join(scratch, name); mkdirSync(folder);
  const project = realpathSync(folder);
  const prepared = await prepare({ useCase: 'policy', policy: policy(noticesOrigins), target: { project } }, controls());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const installed = await apply(prepared.prepared, approve(prepared.review), controls());
  assert.equal(installed.completion, 'complete', JSON.stringify(installed.diagnostics));
  const copy = ['LICENSE', 'AGENTS.md', 'README.md', 'plugin.json'].map(file => join(project, '.aih', 'notices', 'ecc', 'ecc.notices', file));
  assert.ok(copy.every(existsSync));
  return { project, copy };
}
async function remove(project, removals) {
  const prepared = await prepareManagedRemoval({ target: { project }, scope: 'project', removals }, { logging: 'off' });
  assert.equal(prepared.disposition, 'prepared', JSON.stringify(prepared));
  const run = await apply(prepared.preparation.prepared, approve({ reviewDigest: prepared.reviewDigest }), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  return { prepared, run };
}

test('the notices lose each removed requirer and go with the last one, by set and by single removal', async () => {
  const { project, copy } = await install('freed', AGENTS.map(requiredBy));

  // Set removal of the first agent: the notices stay for the second, and no longer name the first.
  const first = await remove(project, [{ managementId: managementId(AGENTS[0]), origin: inSet }]);
  assert.deepEqual(first.prepared.removals.map(entry => [entry.disposition, entry.change]), [['prepared', 'remove-selection']]);
  assert.ok(!first.prepared.removals[0].members.some(member => member.path.includes('ecc.notices')), JSON.stringify(first.prepared.removals[0].members));
  assert.ok(copy.every(existsSync), 'the shared copy stays for the remaining requirer');
  assert.deepEqual(await originsOf(project, 'ecc.notices'), [requiredBy(AGENTS[1])]);

  // Removing the last requirer by itself frees the notices: the same review removes them, listed with that removal.
  const last = await remove(project, [{ managementId: managementId(AGENTS[1]), origin: { reasonIncluded: 'chosen' } }]);
  const [entry] = last.prepared.removals;
  assert.deepEqual([entry.disposition, entry.change], ['prepared', 'remove-selection']);
  const listed = entry.members.filter(member => member.path.includes(join('.aih', 'notices', 'ecc', 'ecc.notices')));
  assert.deepEqual(listed.map(member => member.path).sort(), [...copy].sort());
  assert.ok(listed.every(member => member.action === 'remove'), JSON.stringify(listed));
  assert.ok(!copy.some(existsSync), 'the shared copy is gone');
  assert.deepEqual(removalClaims(last.prepared, last.run).removals.map(claim => claim.claim), ['removed']);
  assert.deepEqual(await inventory(project), [], 'nothing is left in custody');
});

test('notices that are also chosen stay when their requirers go, without the removed requirers', async () => {
  const { project, copy } = await install('chosen', [{ reasonIncluded: 'chosen' }, ...AGENTS.map(requiredBy)]);
  const { prepared } = await remove(project, [{ managementId: managementId(AGENTS[0]), origin: inSet },
    { managementId: managementId(AGENTS[1]) }]);
  assert.ok(prepared.removals.every(entry => !entry.members.some(member => member.path.includes('ecc.notices'))), JSON.stringify(prepared.removals));
  assert.ok(copy.every(existsSync), 'the chosen notices stay');
  assert.deepEqual((await inventory(project)).map(entry => [entry.managementId, entry.origins]),
    [[managementId('ecc.notices'), [{ reasonIncluded: 'chosen' }]]]);
});

// Superpowers' shape: a set member also required by another member keeps that inclusion after its set origin goes,
// but its requirer leaves in the same set removal, so it goes too, and the notices with both.
test('a set member required only by another removed member goes with the set, and the notices with them', async () => {
  const folder = join(scratch, 'chain'); mkdirSync(folder);
  const project = realpathSync(folder);
  const base = policy(AGENTS.map(requiredBy));
  const [notices, first, second] = base.selections;
  first.origins = [{ reasonIncluded: 'in-set', set: inSet.set }, requiredBy(AGENTS[1])];
  second.origins = [{ reasonIncluded: 'in-set', set: inSet.set }];
  second.requires = ['ecc.notices', AGENTS[0]];
  const prepared = await prepare({ useCase: 'policy', policy: { ...base, selections: [notices, first, second] }, target: { project } }, controls());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal((await apply(prepared.prepared, approve(prepared.review), controls())).completion, 'complete');
  const removed = await remove(project, AGENTS.map(id => ({ managementId: managementId(id), origin: inSet })));
  assert.deepEqual(removed.prepared.removals.map(entry => [entry.managementId, entry.change]),
    AGENTS.map(id => [managementId(id), 'remove-selection']));
  assert.deepEqual(removalClaims(removed.prepared, removed.run).removals.map(claim => claim.claim), ['removed', 'removed']);
  assert.deepEqual(await inventory(project), [], 'nothing is left in custody');
  assert.ok(!existsSync(join(project, '.aih', 'notices', 'ecc', 'ecc.notices', 'LICENSE')));
});
