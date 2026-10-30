// The one shared copy of a recipe-less supporting document is owned by the document's own selection. Its requirers
// protect it only through their `requires` edges: while any requirer remains, the copy stays and the document's
// selection is retained rather than removed. Real Catalog 1.7.0 ECC content: the release document and the published
// bytes of ecc.notices and two agents that require it, vendored in the fixture, so no packed Catalog is needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, prepare, prepareManagedRemoval } from '../dist/core/index.js';
import { removalClaims } from '../dist/core/contracts.js';
import { toolBindings } from '../dist/harness/contracts.mjs';
import { approve, catalogRoot, controls } from './real-catalog-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-shared-copy-removal-'));
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
const managementId = id => `project--aihq.catalog--${id}`;
const selection = (id, origins, requires) => {
  const found = item(id);
  return { id, managementId: managementId(id), scope: 'project', configuration: {}, requires,
    item: { framework: 'ecc', itemId: id, contentSha256: found.contentSha256, behaviourSha256: found.behaviourSha256 },
    tool: 'claude', name: found.name ?? found.label, kind: found.kind, origins, bindingDigest: claude.digest };
};
const policy = () => ({ schema: 'urn:aihq:core:execution-policy:1.6.0', mode: 'vibe',
  catalogReleases: [{ framework: 'ecc', source: { kind: 'local', input: 'catalog' }, path, sha256: sha256(bytes), byteLength: bytes.length }],
  selections: [
    selection('ecc.notices', AGENTS.map(itemId => ({ reasonIncluded: 'required-by', requiredBy: { framework: 'ecc', itemId } })), []),
    ...AGENTS.map(id => selection(id, [{ reasonIncluded: 'chosen' }], ['ecc.notices']))] });
const removal = (project, ids) => prepareManagedRemoval({ target: { project }, scope: 'project',
  removals: ids.map(id => ({ managementId: managementId(id) })) }, { logging: 'off' });

test('the shared notices copy stays while a requirer remains and goes, verified, with the last one', async () => {
  for (const id of ['ecc.notices', ...AGENTS]) for (const member of item(id).materials)
    assert.equal(sha256(readFileSync(join(catalogRoot, member.packagePath))), member.sha256, `${id} ${member.relPath} is the published bytes`);
  const folder = join(scratch, 'project'); mkdirSync(folder);
  const project = realpathSync(folder);
  const copy = ['LICENSE', 'AGENTS.md', 'README.md', 'plugin.json'].map(name => join(project, '.aih', 'notices', 'ecc', 'ecc.notices', name));

  const prepared = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, controls());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  // Both agents keep no folder of their own, so they share one neutral copy, planned once.
  const targets = prepared.review.operations.filter(operation => operation.kind === 'file.write').map(operation => operation.details.target);
  assert.deepEqual(targets.filter(target => target.includes('ecc.notices')).sort(), [...copy].sort());
  const installed = await apply(prepared.prepared, approve(prepared.review), controls());
  assert.equal(installed.completion, 'complete', JSON.stringify(installed.diagnostics));
  assert.ok(copy.every(existsSync));

  // Removing the first requirer, also asking for the notices: the other agent still requires them, so the notices
  // selection is retained, not offered for removal, and the copy stays.
  const first = await removal(project, [AGENTS[0], 'ecc.notices']);
  assert.equal(first.disposition, 'prepared', JSON.stringify(first));
  const entries = Object.fromEntries(first.removals.map(entry => [entry.managementId, entry]));
  assert.equal(entries[managementId(AGENTS[0])].disposition, 'prepared', JSON.stringify(first.removals));
  assert.equal(entries[managementId('ecc.notices')].disposition, 'retained', JSON.stringify(first.removals));
  assert.deepEqual(entries[managementId('ecc.notices')].diagnostics.map(item => [item.code, item.reason]), [['PREREQUISITE_UNAVAILABLE', 'dependency-retained']]);
  assert.deepEqual(entries[managementId('ecc.notices')].members, [], 'none of its members is offered for removal');
  assert.ok(first.preparation.review.operations.length > 0);
  assert.deepEqual(first.preparation.review.operations.filter(operation => copy.includes(operation.details.target)), [],
    'no reviewed operation touches the shared copy');
  const removedFirst = await apply(first.preparation.prepared, approve({ reviewDigest: first.reviewDigest }), { logging: 'off' });
  assert.equal(removedFirst.completion, 'complete', JSON.stringify(removedFirst.diagnostics));
  assert.ok(copy.every(existsSync), 'the shared copy is still present');
  assert.ok(!existsSync(join(project, '.claude', 'agents', 'a11y-architect.md')), 'the first agent is gone');
  // Asked on its own, the notices selection is retained too.
  const alone = await prepareManagedRemoval({ target: { project }, scope: 'project', mode: 'vibe', managementId: managementId('ecc.notices') }, { logging: 'off' });
  assert.equal(alone.disposition, 'retained', JSON.stringify(alone));
  assert.deepEqual(alone.diagnostics.map(item => item.reason), ['dependency-retained']);

  // The remaining requirer and the notices together: everything goes, checked on disk.
  const last = await removal(project, [AGENTS[1], 'ecc.notices']);
  assert.equal(last.disposition, 'prepared', JSON.stringify(last));
  assert.ok(last.removals.every(entry => entry.disposition === 'prepared'), JSON.stringify(last.removals));
  const removedLast = await apply(last.preparation.prepared, approve({ reviewDigest: last.reviewDigest }), { logging: 'off' });
  assert.equal(removedLast.completion, 'complete', JSON.stringify(removedLast.diagnostics));
  assert.ok(!copy.some(existsSync), 'the shared copy is gone');
  const checked = removedLast.members.filter(member => copy.includes(member.path));
  assert.equal(checked.length, copy.length, JSON.stringify(removedLast.members));
  assert.ok(checked.every(member => member.intent !== 'write' && member.check === 'absent'), JSON.stringify(checked));
  for (const operation of removedLast.operations) assert.deepEqual(operation.verification, { status: 'passed', reason: 'member-checked' });
  assert.deepEqual(removalClaims(last, removedLast).removals.map(entry => entry.claim), ['removed', 'removed']);
});
