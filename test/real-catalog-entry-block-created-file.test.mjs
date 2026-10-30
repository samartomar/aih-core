// An entry file Core created for Project basics' shared block goes with the last AIH block in it, so removal returns the
// project to its seeded tree. A file that was there before, or that holds anything the person wrote, stays without the
// blocks. Real Catalog 1.7.0 content: project-basics.shared-block rendered for Claude Code from its published text,
// vendored in the fixture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, prepare, prepareManagedRemoval } from '../dist/core/index.js';
import { removalClaims } from '../dist/core/contracts.js';
import { renderDelivery, toolBindings } from '../dist/harness/contracts.mjs';
import { approve, catalogRoot, controls } from './real-catalog-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-entry-created-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(scratch, { recursive: true, force: true });
});
const read = name => JSON.parse(readFileSync(join(catalogRoot, name), 'utf8'));
const basics = read('release-project-basics.content.json');
const texts = read('rule-texts.json');
const item = basics.items.find(entry => entry.id === 'project-basics.shared-block');
const claude = toolBindings.find(binding => binding.tool === 'claude');
const MANAGEMENT_ID = 'project--aihq.catalog--project-basics.shared-block';

function sharedBlock() {
  const contents = Object.fromEntries(item.materials.filter(member => member.role === 'content').map(member => [member.id, texts[member.packagePath]]));
  assert.ok(Object.values(contents).every(text => typeof text === 'string' && text.length > 0), 'the published block text is vendored');
  const rendered = renderDelivery({ tool: 'claude', item, binding: claude, scope: 'project', contents });
  assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
  assert.deepEqual(rendered.recipe.operations.map(operation => [operation.kind, operation.target.segments.map(segment => segment.literal).join('/')]),
    [['text.block', 'CLAUDE.md'], ['text.block', 'CLAUDE.md']], 'the shared block and the entry pointer both go into CLAUDE.md');
  return { id: 'shared-block', managementId: MANAGEMENT_ID, scope: 'project', configuration: {}, requires: [], recipe: { inline: rendered.recipe },
    item: { framework: 'project-basics', itemId: item.id, contentSha256: item.contentSha256, behaviourSha256: item.behaviourSha256 },
    tool: 'claude', name: item.name ?? item.label, kind: item.kind, origins: [{ reasonIncluded: 'chosen' }] };
}
// Another AIH block in the same file, from another selection: the rendered block operation with its own markers.
function otherBlock() {
  const recipe = structuredClone(sharedBlock().recipe.inline);
  const [operation] = recipe.operations;
  return { id: 'other-block', managementId: 'other-block', scope: 'project', configuration: {}, requires: [],
    recipe: { inline: { ...recipe, id: 'other-block', inputs: {}, operations: [{ ...operation, id: 'other', blockId: 'other',
      startMarker: '<!-- BEGIN other -->', endMarker: '<!-- END other -->', content: { literal: 'Other text.\n' } }] } } };
}
async function install(project, selections) {
  const prepared = await prepare({ useCase: 'policy', policy: { schema: 'urn:aihq:core:execution-policy:1.5.0', mode: 'vibe', selections },
    target: { project } }, controls());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const run = await apply(prepared.prepared, approve(prepared.review), controls());
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
}
async function remove(project, managementId = MANAGEMENT_ID) {
  const removal = await prepareManagedRemoval({ target: { project }, scope: 'project', removals: [{ managementId }] }, { logging: 'off' });
  assert.equal(removal.disposition, 'prepared', JSON.stringify(removal));
  assert.equal(removal.preparation.status, 'ready', JSON.stringify(removal.preparation.diagnostics));
  const run = await apply(removal.preparation.prepared, approve({ reviewDigest: removal.reviewDigest }), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  return { removal, run };
}
function seeded(name) {
  const folder = join(scratch, name); mkdirSync(folder);
  const project = realpathSync(folder);
  return { project, entry: join(project, 'CLAUDE.md') };
}

test('a CLAUDE.md Core created for the shared block is deleted with the blocks, reviewed as a file removal', async () => {
  const { project, entry } = seeded('created');
  await install(project, [sharedBlock()]);
  assert.match(readFileSync(entry, 'utf8'), /aih:shared/);
  const { removal, run } = await remove(project);
  const writes = removal.preparation.review.operations.filter(operation => operation.details.target === entry);
  assert.equal(writes.length, 2, JSON.stringify(writes));
  assert.deepEqual(writes.map(operation => operation.effects).sort(), ['remove-file', 'replace-file'],
    'the last block removal deletes the file Core created');
  assert.ok(!existsSync(entry), 'CLAUDE.md is gone');
  assert.deepEqual(removalClaims(removal, run).removals.map(claim => claim.claim), ['removed']);
});

test('a created CLAUDE.md the person added to keeps only their line', async () => {
  const { project, entry } = seeded('person-line');
  await install(project, [sharedBlock()]);
  appendFileSync(entry, 'My own line.\n');
  await remove(project);
  assert.equal(readFileSync(entry, 'utf8'), 'My own line.\n');
});

test('a CLAUDE.md that was there before, empty, stays empty', async () => {
  const { project, entry } = seeded('pre-existing');
  writeFileSync(entry, '');
  await install(project, [sharedBlock()]);
  await remove(project);
  assert.ok(existsSync(entry), 'the pre-existing file stays');
  assert.equal(readFileSync(entry).length, 0);
});

test('a created CLAUDE.md that still holds another AIH block stays', async () => {
  const { project, entry } = seeded('two-blocks');
  await install(project, [sharedBlock(), otherBlock()]);
  await remove(project);
  assert.equal(readFileSync(entry, 'utf8'), '<!-- BEGIN other -->\nOther text.\n<!-- END other -->\n');
});
