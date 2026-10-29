// Amendment 3.2.2 (owner decision, 29 October 2026): a notice required by items without a folder of their own is installed
// once per framework in <project>/.aih/notices/<framework>/<document>/, owned by every requiring item. Removing one
// requirer keeps the copy for the others; removing the last removes it, confirmed gone.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { apply, listManagedSelections, prepare, prepareManagedRemoval } from '../dist/core/index.js';
import { removalClaims } from '../dist/core/contracts.js';
import { renderDelivery, toolBindings } from '../dist/harness/contracts.mjs';
import { sandbox } from './hook-group-fixture.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const FRAMEWORK = 'example-framework';
const claude = toolBindings.find(binding => binding.tool === 'claude');

/** A Catalog release item with content files and its behaviour file. */
function catalogItem({ id, kind, payload, files, requires = [] }) {
  const content = Object.entries(files).map(([relPath, text], index) => ({ id: `m${index}`, relPath, sourcePath: relPath,
    packagePath: `release/items/${id}/${relPath}`, sha256: sha256(text), byteLength: Buffer.byteLength(text), executable: false,
    sourceId: 'upstream', role: 'content', text }));
  const dependencies = { requires: requires.map(itemId => ({ itemId })), optional: [], conflicts: [] }, requirements = { inputs: {} };
  const executable = Object.fromEntries(content.map(member => [member.relPath, false]));
  const behaviourText = `${canonical({ kind, payload, requirements, dependencies, executable })}\n`;
  const behaviour = { id: 'behaviour', relPath: 'aih-behaviour.json', sourcePath: null, packagePath: `release/items/${id}/aih-behaviour.json`,
    sha256: sha256(behaviourText), byteLength: Buffer.byteLength(behaviourText), executable: false, sourceId: FRAMEWORK, role: 'behaviour' };
  const lines = members => members.map(member => `${member.relPath}\t${member.sha256}\n`).sort().join('');
  const materials = [...content.map(({ text, ...member }) => member), behaviour];
  return { item: { id, label: id, kind, sourceIds: ['upstream'], targets: [], scopes: ['project'], inputs: {}, materials, dependencies,
    requirements, executable, payload, contentSha256: sha256(lines(content)), behaviourSha256: sha256(lines([...content, behaviour])) }, content };
}
const notices = catalogItem({ id: 'notices', kind: 'document', payload: { files: ['m0', 'm1'], purpose: 'notice' },
  files: { LICENSE: 'MIT\n', 'NOTICE.md': '# Notices\n' } });
const rule = (id, text) => catalogItem({ id, kind: 'rule', payload: { applyTo: ['**'], applyToBasis: 'authored' }, files: { [`${id}.md`]: text },
  requires: ['notices'] });
const style = rule('style', '# Style\n'), naming = rule('naming', '# Naming\n');

/** One rule and its notices, rendered as the Workbench renders them: the notices once beside (here: for) each rule. */
function selectionsFor(requirer) {
  const describe = (entry, rendered, id, requires) => {
    assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
    return { id, managementId: id, scope: 'project', configuration: {}, requires, recipe: { inline: rendered.recipe },
      item: { framework: FRAMEWORK, itemId: entry.item.id, contentSha256: entry.item.contentSha256, behaviourSha256: entry.item.behaviourSha256 },
      tool: 'claude', name: entry.item.id, kind: entry.item.kind, origins: [{ reasonIncluded: 'chosen' }] };
  };
  const noticesId = `notices--${requirer.item.id}`;
  return [describe(requirer, renderDelivery({ tool: 'claude', item: requirer.item, binding: claude, scope: 'project' }), requirer.item.id, [noticesId]),
    describe(notices, renderDelivery({ tool: 'claude', item: notices.item, binding: claude, scope: 'project', requiredBy: requirer.item }), noticesId, [])];
}
const approve = review => ({ reviewDigest: review.reviewDigest, approved: true, origin: 'automation' });

let live = [];
afterEach(() => { for (const s of live) s.dispose(); live = []; });

test('one neutral copy is owned by every requiring item, kept while one remains and removed with the last', async () => {
  const s = sandbox('aih-notices-'); live.push(s);
  const catalog = join(s.root, 'catalog');
  for (const entry of [notices, style, naming]) for (const member of entry.content) {
    mkdirSync(dirname(join(catalog, member.packagePath)), { recursive: true });
    writeFileSync(join(catalog, member.packagePath), member.text);
  }
  const controls = { logging: 'off', materialRoots: { catalog } };
  const policy = { schema: 'urn:aihq:core:execution-policy:1.5.0', mode: 'vibe', selections: [...selectionsFor(style), ...selectionsFor(naming)] };
  const prepared = await prepare({ useCase: 'policy', policy, target: { project: s.project } }, controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal((await apply(prepared.prepared, approve(prepared.review), controls)).completion, 'complete');
  const copy = join(s.project, '.aih', 'notices', FRAMEWORK, 'notices');
  assert.deepEqual([readFileSync(join(copy, 'LICENSE'), 'utf8'), readFileSync(join(copy, 'NOTICE.md'), 'utf8')], ['MIT\n', '# Notices\n']);
  assert.equal(existsSync(join(s.project, '.claude', 'rules', 'notices')), false, 'nothing lands where the tool reads rules');

  // The receipts name both requirers' notices selections as owners of the one copy.
  const inventory = await listManagedSelections({ target: { project: s.project }, scope: 'project',
    format: 'urn:aihq:core:managed-inventory-result:1.1.0' });
  const owners = inventory.selections.filter(row => row.members.some(member => member.path.replaceAll('\\', '/').endsWith('.aih/notices/example-framework/notices/LICENSE')))
    .map(row => row.managementId).sort();
  assert.deepEqual(owners, ['notices--naming', 'notices--style']);

  // Removing one rule keeps the copy for the other ("Kept; also part of naming").
  const first = await prepareManagedRemoval({ target: { project: s.project }, scope: 'project',
    removals: [{ managementId: 'style' }, { managementId: 'notices--style' }] }, { logging: 'off' });
  assert.equal(first.disposition, 'prepared', JSON.stringify(first));
  const kept = first.removals.find(entry => entry.managementId === 'notices--style').members;
  assert.deepEqual([...new Set(kept.map(member => `${member.action}/${member.reason}`))], ['keep-shared/another-selection']);
  assert.equal((await apply(first.preparation.prepared, approve(first.preparation.review), { logging: 'off' })).completion, 'complete');
  assert.equal(existsSync(join(copy, 'LICENSE')), true);

  // Removing the last requirer removes the copy, confirmed gone.
  const last = await prepareManagedRemoval({ target: { project: s.project }, scope: 'project',
    removals: [{ managementId: 'naming' }, { managementId: 'notices--naming' }] }, { logging: 'off' });
  assert.deepEqual([...new Set(last.removals.find(entry => entry.managementId === 'notices--naming').members.map(member => member.action))], ['remove']);
  const run = await apply(last.preparation.prepared, approve(last.preparation.review), { logging: 'off' });
  assert.equal(run.completion, 'complete');
  assert.deepEqual([...new Set(removalClaims(last, run).removals.map(item => item.claim))], ['removed']);
  assert.equal(existsSync(join(copy, 'LICENSE')), false);
  assert.equal(existsSync(join(copy, 'NOTICE.md')), false);
});

test('a requirer installed later joins the existing copy as an owner instead of being offered to adopt it', async () => {
  const s = sandbox('aih-notices-later-'); live.push(s);
  const catalog = join(s.root, 'catalog');
  for (const entry of [notices, style, naming]) for (const member of entry.content) {
    mkdirSync(dirname(join(catalog, member.packagePath)), { recursive: true });
    writeFileSync(join(catalog, member.packagePath), member.text);
  }
  const controls = { logging: 'off', materialRoots: { catalog } };
  const install = async requirer => {
    const policy = { schema: 'urn:aihq:core:execution-policy:1.5.0', mode: 'vibe', selections: selectionsFor(requirer) };
    const prepared = await prepare({ useCase: 'policy', policy, target: { project: s.project } }, controls);
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    assert.equal((await apply(prepared.prepared, approve(prepared.review), controls)).completion, 'complete');
    return prepared;
  };
  await install(style);
  const later = await install(naming);
  const joined = later.review.operations.filter(op => op.id.startsWith('notices--naming/'));
  assert.deepEqual([...new Set(joined.map(op => `${op.effects}/${op.ownership}`))], ['already-satisfied/managed'], 'nothing written, no adopt choice');
  const removal = await prepareManagedRemoval({ target: { project: s.project }, scope: 'project',
    removals: [{ managementId: 'style' }, { managementId: 'notices--style' }] }, { logging: 'off' });
  assert.deepEqual([...new Set(removal.removals.find(entry => entry.managementId === 'notices--style').members.map(member => member.action))], ['keep-shared']);
});
