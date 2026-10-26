// Copied into an outside consumer; only the installed package's public entries are imported.
// Project basics per repository (aih-core#100): the bounded facts diagnostic, project facts in
// the preview and the inventory, aih:shared entry blocks and the entry pointer, edited-block
// drift, the update that moves a person's own lines to the user-owned notes file, and removal
// that takes only the blocks. Disposable projects and an isolated home; nothing is run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { apply, listManagedSelections, prepare, prepareManagedRemoval, prepareUpdate } from '@aihq/core';
import { renderDelivery, toolBindings } from '@aihq/core/harness';
import { detectProjectFacts } from '@aihq/core/harness/runtime';
import preparedWork14 from '@aihq/core/schemas/prepared-work/1.4.0.json' with { type: 'json' };
import preparedWork16 from '@aihq/core/schemas/prepared-work/1.6.0.json' with { type: 'json' };
import inventory11 from '@aihq/core/schemas/managed-inventory-result/1.1.0.json' with { type: 'json' };
import runResult14 from '@aihq/core/schemas/run-result/1.4.0.json' with { type: 'json' };

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const plain = value => JSON.parse(JSON.stringify(value));

const FRAMEWORK = 'example-framework';
const POLICY_14 = 'urn:aihq:core:execution-policy:1.4.0';
const INVENTORY_11 = 'urn:aihq:core:managed-inventory-result:1.1.0';
const SHARED_START = '<!-- BEGIN aih:shared -->';
const SHARED_END = '<!-- END aih:shared -->';
const POINTER_START = '<!-- BEGIN aih:shared:pointer -->';
const POINTER_END = '<!-- END aih:shared:pointer -->';

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(preparedWork14);
const valid = (schema, value, label) => assert.equal(ajv.compile(schema)(value), true, `${label}: ${JSON.stringify(ajv.compile(schema).errors)}`);

const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-project-basics-')));
const project = name => {
  const root = realpathSync.native(mkdtempSync(join(scratch, `${name}-`)));
  return root;
};
const approve = reviewDigest => ({ approved: true, origin: 'automation', reviewDigest });

/** An independently built Catalog release 1.6 item, as the delivery tests build one. */
function catalogItem({ id, kind, payload, files, requirements = { inputs: {} } }) {
  const content = Object.entries(files).map(([relPath, text], index) => ({
    id: relPath === 'LICENSE' ? 'license' : `m${index}`, relPath, sourcePath: relPath,
    packagePath: `release/items/${id}/${relPath}`, sha256: sha256(text), byteLength: Buffer.byteLength(text),
    executable: false, sourceId: 'upstream', role: 'content',
    size: { bytes: Buffer.byteLength(text), chars: [...text].length, status: 'measured' } }));
  const dependencies = { requires: [], optional: [], conflicts: [] };
  const executableMap = Object.fromEntries(content.map(member => [member.relPath, member.executable]));
  const behaviourText = `${canonical({ kind, payload: payload ?? null, requirements, dependencies, executable: executableMap })}\n`;
  const behaviour = { id: 'behaviour', relPath: 'aih-behaviour.json', sourcePath: null, packagePath: `release/items/${id}/aih-behaviour.json`,
    sha256: sha256(behaviourText), byteLength: Buffer.byteLength(behaviourText), executable: false, sourceId: FRAMEWORK, role: 'behaviour' };
  const lines = members => members.map(member => `${member.relPath}\t${member.sha256}\n`).sort().join('');
  return { id, label: id, kind, sourceIds: ['upstream'], targets: [], scopes: ['project'], inputs: {},
    recipe: { id, schema: 'urn:aihq:core:recipe:1.0.0', path: `release/recipes/${id}.json`, sha256: sha256(`${id}-recipe`), byteLength: 900 },
    materials: [...content, behaviour].sort((a, b) => a.id < b.id ? -1 : 1), dependencies, requirements, executable: executableMap,
    contentSha256: sha256(lines(content)), behaviourSha256: sha256(lines([...content, behaviour])), payload };
}
const contentsOf = (item, files) => Object.fromEntries(item.materials.filter(member => member.role === 'content')
  .map(member => [member.id, files[member.relPath]]));
/** A test binding: a shipped binding plus overrides, with the digest recomputed as the renderer checks it. */
function bindingWith(tool, extra = {}) {
  const { digest, ...binding } = plain(toolBindings.find(item => item.tool === tool));
  Object.assign(binding, extra);
  return { ...binding, digest: sha256(canonical(binding)) };
}

await check('the facts diagnostic reads an empty repository as complete with no facts', async () => {
  const root = project('empty');
  const result = await detectProjectFacts({ project: root });
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.deepEqual(result.facts, []);
  assert.ok(result.limits.reads <= result.limits.maxReads);
});

await check('the facts diagnostic reports detected and inferred facts for a Node repository, running nothing', async () => {
  const root = project('node');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sample', scripts: { test: 'node --test', build: 'tsc' } }));
  const result = await detectProjectFacts({ project: root });
  assert.equal(result.status, 'complete', JSON.stringify(result));
  const fact = field => result.facts.find(entry => entry.field === field);
  assert.deepEqual(fact('stack'), { field: 'stack', value: 'node', confidence: 'detected' });
  assert.deepEqual(fact('packageManager'), { field: 'packageManager', value: 'npm', confidence: 'inferred' });
  assert.deepEqual(fact('testCommand'), { field: 'testCommand', value: 'npm test', confidence: 'detected' });
  assert.deepEqual(fact('buildCommand'), { field: 'buildCommand', value: 'npm run build', confidence: 'detected' });
  assert.equal(fact('lintCommand'), undefined, 'an absent script is omitted, never fabricated');
  // A lockfile is stronger evidence than the convention: the same fact becomes detected.
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'sample', lockfileVersion: 3 }));
  const locked = await detectProjectFacts({ project: root });
  assert.deepEqual(locked.facts.find(entry => entry.field === 'packageManager'),
    { field: 'packageManager', value: 'npm', confidence: 'detected' });
  const refused = await detectProjectFacts({ project: join(root, 'missing') });
  assert.equal(refused.status, 'invalid');
});

const SHARED_FILES = { 'shared.md': 'Shared guidance.\n' };
const sharedItem = catalogItem({ id: 'shared-block', kind: 'rule', files: SHARED_FILES,
  payload: { applyTo: ['**'], applyToBasis: 'authored', placement: 'entry-block' } });

await check('rendering writes the shared block with aih:shared markers into each entry file, and the entry pointer the same way', () => {
  const contents = contentsOf(sharedItem, SHARED_FILES);
  const rendered = renderDelivery({ tool: 'codex', item: sharedItem, binding: bindingWith('codex'), scope: 'project',
    projectFolder: 'team-ai', contents });
  assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
  const [block] = rendered.recipe.operations;
  assert.equal(block.kind, 'text.block');
  assert.equal(block.target.segments.map(segment => segment.literal).join('/'), 'AGENTS.md');
  assert.deepEqual([block.startMarker, block.endMarker], [SHARED_START, SHARED_END]);
  assert.equal(rendered.recipe.operations.length, 1, 'no pointer without a binding entryPointer');
  assert.equal(rendered.recipe.inputs.projectFolder.default, 'ai-coding', 'the folder is a reviewed recipe input');
  const pointed = bindingWith('codex', { entryPointer: { file: 'AGENTS.md', template: 'Read {projectFolder}/RULE_ROUTER.md' } });
  const withPointer = renderDelivery({ tool: 'codex', item: sharedItem, binding: pointed, scope: 'project', projectFolder: 'team-ai', contents });
  const pointer = withPointer.recipe.operations.find(op => op.kind === 'text.block' && op.blockId === 'aihq.entry-pointer');
  assert.ok(pointer, 'the pointer is written the same way, from the binding template');
  assert.deepEqual([pointer.startMarker, pointer.endMarker], [POINTER_START, POINTER_END]);
  assert.deepEqual(pointer.content, { literal: 'Read team-ai/RULE_ROUTER.md' });
});

const basicsRecipe = (sharedText, pointerText) => ({
  schema: 'urn:aihq:core:recipe:1.0.0', id: 'project-basics', description: 'Project basics', inputs: {
    projectFolder: { type: 'string', required: true, default: 'ai-coding', minLength: 1, maxLength: 64 } },
  materials: [], targets: ['project'], prerequisites: [], checks: [],
  operations: [
    { id: 'write-router', purpose: 'Write the rule router', kind: 'file.write', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'ai-coding' }, { literal: 'RULE_ROUTER.md' }] },
      content: { literal: '# Rule router\n' }, requires: [], checks: [] },
    { id: 'shared-block', purpose: 'Set the shared guidance block', kind: 'text.block', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'AGENTS.md' }] }, blockId: `${FRAMEWORK}.shared-block`,
      startMarker: SHARED_START, endMarker: SHARED_END, action: 'set', content: { literal: sharedText }, requires: [], checks: [] },
    { id: 'entry-pointer', purpose: 'Point at the shared guidance folder', kind: 'text.block', scope: 'project',
      target: { root: 'project', segments: [{ literal: 'AGENTS.md' }] }, blockId: 'aihq.entry-pointer',
      startMarker: POINTER_START, endMarker: POINTER_END, action: 'set', content: { literal: pointerText }, requires: [], checks: [] }]
});
const itemRef = { framework: FRAMEWORK, itemId: 'shared-block', contentSha256: sha256('content'), behaviourSha256: sha256('behaviour') };
const basicsSelection = (recipe, projectFacts) => ({ id: 'basics', managementId: 'project-basics', scope: 'project', configuration: {}, requires: [],
  recipe: { inline: recipe }, item: itemRef, tool: 'codex', name: 'Project basics', kind: 'rule',
  origins: [{ reasonIncluded: 'chosen' }], ...(projectFacts ? { projectFacts } : {}) });
const basicsPolicy = selection => ({ schema: POLICY_14, mode: 'vibe', selections: [selection] });
const inventory = root => listManagedSelections({ target: { project: root }, scope: 'project', format: INVENTORY_11 });
const PERSON_TEXT = '# Our AGENTS\n\nKeep this line exactly.\n';

await check('install: reviewed project facts reach the preview and the inventory, and the entry blocks keep person text byte for byte', async () => {
  const root = project('install');
  writeFileSync(join(root, 'AGENTS.md'), PERSON_TEXT);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sample', scripts: { test: 'node --test' } }));
  const facts = (await detectProjectFacts({ project: root })).facts;
  assert.ok(facts.some(entry => entry.confidence === 'detected') && facts.some(entry => entry.confidence === 'inferred'));
  const prepared = await prepare({ useCase: 'policy', policy: basicsPolicy(basicsSelection(basicsRecipe('Shared guidance.\n', 'Read ai-coding/RULE_ROUTER.md\n'), facts)),
    target: { project: root } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  valid(preparedWork16, prepared.review, 'prepared work 1.6.0');
  const reviewed = prepared.review.selections.find(entry => entry.selectionId === 'basics');
  assert.deepEqual(reviewed.projectFacts, facts, 'the preview carries the reviewed facts');
  const result = await apply(prepared.prepared, approve(prepared.review.reviewDigest), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  valid(runResult14, result, 'run result 1.4.0');
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith(PERSON_TEXT), 'text outside the block is kept byte for byte');
  assert.ok(agents.includes(`${SHARED_START}\nShared guidance.\n${SHARED_END}`));
  assert.ok(agents.includes(`${POINTER_START}\nRead ai-coding/RULE_ROUTER.md\n${POINTER_END}`));
  const listed = await inventory(root);
  valid(inventory11, listed, 'inventory 1.1.0');
  assert.equal(listed.status, 'complete');
  const row = listed.selections.find(entry => entry.managementId === 'project-basics');
  assert.deepEqual(row.projectFacts, facts, 'the inventory carries the reviewed facts');
  assert.deepEqual(row.members.map(member => member.kind).sort(), ['entry-block', 'entry-pointer', 'file']);
  const shared = row.members.find(member => member.kind === 'entry-block');
  assert.equal(shared.fileState, 'matches');
  assert.equal(shared.blockId, `${FRAMEWORK}.shared-block`);
});

await check('drift: a person\'s edit inside the block reports block-changed, and an update moves those lines to the user-owned file, shown in the preview', async () => {
  const root = project('update');
  writeFileSync(join(root, 'AGENTS.md'), PERSON_TEXT);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sample', scripts: { test: 'node --test' } }));
  const facts = (await detectProjectFacts({ project: root })).facts;
  const prepared = await prepare({ useCase: 'policy', policy: basicsPolicy(basicsSelection(basicsRecipe('Shared guidance.\n', 'Read ai-coding/RULE_ROUTER.md\n'), facts)),
    target: { project: root } }, { logging: 'off' });
  await apply(prepared.prepared, approve(prepared.review.reviewDigest), { logging: 'off' });
  // The person adds their own line inside the shared block.
  const agents = join(root, 'AGENTS.md');
  writeFileSync(agents, readFileSync(agents, 'utf8').replace(`${SHARED_START}\nShared guidance.\n${SHARED_END}`,
    `${SHARED_START}\nShared guidance.\nRemember the release checklist.\n${SHARED_END}`));
  const listed = await inventory(root);
  const shared = listed.selections[0].members.find(member => member.kind === 'entry-block');
  assert.equal(shared.fileState, 'block-changed', 'the edit inside the block is drift');
  const update = await prepareUpdate({ target: { project: root }, scope: 'project',
    updates: [{ managementId: 'project-basics', replacement: basicsSelection(basicsRecipe('Updated guidance.\n', 'Read ai-coding/RULE_ROUTER.md\n'), facts) }] },
    { logging: 'off' });
  assert.equal(update.disposition, 'prepared', JSON.stringify(update.diagnostics));
  valid(preparedWork16, update.preparation.review, 'the update review is prepared work 1.6.0');
  const member = update.updates[0].members.find(entry => entry.kind === 'entry-block');
  assert.equal(member.action, 'replace', 'the block itself updates once the person line is preserved');
  const rescue = update.preparation.review.operations.find(op => op.id === 'basics/shared-block-rescued');
  assert.ok(rescue, 'the preview shows the move to the user-owned file');
  assert.equal(rescue.kind, 'file.write');
  assert.match(rescue.details.target, /ai-coding[\\/]PROJECT\.md$/);
  assert.ok(rescue.details.content.includes('Remember the release checklist.'));
  const result = await apply(update.preparation.prepared, approve(update.reviewDigest), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  assert.ok(readFileSync(join(root, 'ai-coding', 'PROJECT.md'), 'utf8').includes('Remember the release checklist.'),
    'the person line moved to the user-owned file');
  const after = readFileSync(agents, 'utf8');
  assert.ok(after.includes(`${SHARED_START}\nUpdated guidance.\n${SHARED_END}`), 'the block holds the new guidance');
  assert.ok(!after.includes('Remember the release checklist.'), 'the person line no longer sits inside the block');
  assert.ok(after.startsWith(PERSON_TEXT), 'the person text outside the block is untouched');
  const afterUpdate = await inventory(root);
  assert.equal(afterUpdate.selections[0].members.find(member => member.kind === 'entry-block').fileState, 'matches');
});

await check('removal removes only the blocks and restores nothing else; the person text and PROJECT.md stay', async () => {
  const root = project('remove');
  writeFileSync(join(root, 'AGENTS.md'), PERSON_TEXT);
  const prepared = await prepare({ useCase: 'policy', policy: basicsPolicy(basicsSelection(basicsRecipe('Shared guidance.\n', 'Read ai-coding/RULE_ROUTER.md\n'))),
    target: { project: root } }, { logging: 'off' });
  await apply(prepared.prepared, approve(prepared.review.reviewDigest), { logging: 'off' });
  const agents = join(root, 'AGENTS.md');
  writeFileSync(agents, readFileSync(agents, 'utf8').replace(`${SHARED_START}\nShared guidance.\n${SHARED_END}`,
    `${SHARED_START}\nShared guidance.\nKeep my note here.\n${SHARED_END}`));
  const update = await prepareUpdate({ target: { project: root }, scope: 'project',
    updates: [{ managementId: 'project-basics', replacement: basicsSelection(basicsRecipe('Updated guidance.\n', 'Read ai-coding/RULE_ROUTER.md\n')) }] },
    { logging: 'off' });
  await apply(update.preparation.prepared, approve(update.reviewDigest), { logging: 'off' });
  assert.ok(readFileSync(join(root, 'ai-coding', 'PROJECT.md'), 'utf8').includes('Keep my note here.'));
  const removal = await prepareManagedRemoval({ target: { project: root }, scope: 'project',
    removals: [{ managementId: 'project-basics' }] }, { logging: 'off' });
  assert.equal(removal.disposition, 'prepared', JSON.stringify(removal.diagnostics));
  const shared = removal.removals[0].members.find(entry => entry.kind === 'entry-block');
  assert.equal(shared.action, 'remove');
  const notesKept = removal.removals[0].members.find(entry => entry.path.endsWith('PROJECT.md'));
  assert.equal(notesKept, undefined, 'the user-owned file is never a member, so removal never touches it');
  const result = await apply(removal.preparation.prepared, approve(removal.reviewDigest), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  const after = readFileSync(agents, 'utf8');
  assert.ok(!after.includes('aih:shared'), 'only the blocks are removed');
  assert.equal(after, PERSON_TEXT, 'the file ends up exactly as the person had it outside the blocks');
  assert.ok(existsSync(join(root, 'ai-coding', 'PROJECT.md')), 'the user-owned file is never removed');
  assert.ok(!existsSync(join(root, 'ai-coding', 'RULE_ROUTER.md')), 'the managed file Core wrote is removed');
});

rmSync(scratch, { recursive: true, force: true });
console.log(JSON.stringify({ status: 'passed', checks }));
