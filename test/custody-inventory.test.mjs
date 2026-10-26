import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import runResultSchema from '../dist/core/schemas/run-result/1.4.0.json' with { type: 'json' };
import inventorySchema from '../dist/core/schemas/managed-inventory-result/1.1.0.json' with { type: 'json' };
import { apply, listManagedSelections, prepare } from '../dist/core/index.js';
import { deriveRecipeIdentity, runMemberClaims } from '../dist/core/contracts.js';

// Seam: the built package's public Prepare/Apply entry. Post-apply member checks
// in run result 1.4.0, in a disposable home and project.
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-custody-inventory-')));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const home = join(scratch, 'home');
before(() => { mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const sha = value => createHash('sha256').update(value).digest('hex');
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateRun = ajv.compile(runResultSchema);
const valid = result => assert.equal(validateRun(result), true, JSON.stringify(validateRun.errors));
const validateInventory = ajv.compile(inventorySchema);
const validInventory = result => assert.equal(validateInventory(result), true, JSON.stringify(validateInventory.errors));
const INVENTORY_11 = 'urn:aihq:core:managed-inventory-result:1.1.0';
const inventory = (root, extra = {}) => listManagedSelections({ target: { project: root }, scope: 'project', format: INVENTORY_11, ...extra });
const item = id => ({ framework: 'example-framework', itemId: id, contentSha256: sha(`${id}-content`), behaviourSha256: sha(`${id}-behaviour`) });
const op = (id, kind, extra) => ({ id, purpose: `Apply ${id}`, kind, scope: 'project', requires: [], checks: [], ...extra });
const recipe = (id, operations, inputs = {}) => ({ schema: 'urn:aihq:core:recipe:1.0.0', id, description: id, inputs, materials: [],
  targets: ['project'], prerequisites: [], checks: [], operations });
const selection = (id, operations, extra = {}) => ({ id, managementId: `${id}-managed`, scope: 'project', configuration: {}, requires: [],
  recipe: { inline: recipe(id, operations, extra.inputs) }, item: item(id), tool: 'claude', name: `Item ${id}`, kind: 'skill',
  origins: [{ reasonIncluded: 'chosen' }], ...extra.selection });
const policy = (selections, extra = {}) => ({ schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections, ...extra });
const approve = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
async function run(project, document, controls = {}, resolutions) {
  const prepared = await prepare({ useCase: 'policy', policy: document, target: { project }, ...(resolutions ? { resolutions } : {}) }, { logging: 'off', ...controls });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  return { prepared, result: await apply(prepared.prepared, approve(prepared), { logging: 'off', ...controls }) };
}
const project = name => realpathSync.native(mkdtempSync(join(scratch, `${name}-`)));
const wholeItem = (id = 'kit') => selection(id, [
  op('file', 'file.write', { target: { root: 'project', segments: [{ literal: 'KIT.md' }] }, content: { literal: 'kit\n' } }),
  op('entry', 'config.entries', { target: { root: 'project', segments: [{ literal: 'settings.json' }] }, format: 'json',
    entries: [{ path: ['kit', 'enabled'], action: 'set', value: { literal: true } }] }),
  op('block', 'text.block', { target: { root: 'project', segments: [{ literal: 'AGENTS.md' }] }, blockId: 'kit',
    startMarker: '<!-- aih:kit:start -->', endMarker: '<!-- aih:kit:end -->', action: 'set', content: { literal: 'Use the kit.\n' } })
]);

test('after Apply every touched member is checked directly: written and present-matching', async () => {
  const root = project('written');
  const { result } = await run(root, policy([wholeItem()]));
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  assert.equal(result.schema, 'urn:aihq:core:run-result:1.4.0');
  valid(result);
  assert.deepEqual(result.members.map(member => [member.operationId, member.kind, member.path, member.pointer ?? member.blockId ?? null, member.outcome, member.check]), [
    ['kit/file', 'file', join(root, 'KIT.md'), null, 'written', 'present-matching'],
    ['kit/entry', 'config-entry', join(root, 'settings.json'), '/kit/enabled', 'written', 'present-matching'],
    ['kit/block', 'text-block', join(root, 'AGENTS.md'), 'kit', 'written', 'present-matching']]);
  for (const member of result.members) {
    assert.equal(member.selectionId, 'kit'); assert.equal(member.managementId, 'kit-managed'); assert.equal(member.scope, 'project');
  }
  assert.equal(JSON.stringify(result.members).includes(sha('kit\n')), false, 'no member digests');
});

test('inventory 1.1 names each selection from receipts alone and reports member file states', async () => {
  const root = project('inventory');
  const origins = [{ reasonIncluded: 'chosen' }, { reasonIncluded: 'in-set', set: { framework: 'example-framework', setId: 'starter', setSha256: sha('starter') } },
    { reasonIncluded: 'required-by', requiredBy: { framework: 'example-framework', itemId: 'parent' } }];
  const kit = wholeItem(); kit.origins = origins;
  assert.equal((await run(root, policy([kit]))).result.completion, 'complete');
  const listed = await inventory(root);
  assert.equal(listed.schema, INVENTORY_11); assert.equal(listed.status, 'complete', JSON.stringify(listed.diagnostics));
  validInventory(listed);
  assert.equal(listed.selections.length, 1);
  const [entry] = listed.selections;
  assert.deepEqual({ ...entry, members: undefined }, { managementId: 'kit-managed', scope: 'project', custody: 'claim', memberCount: 3, sharedMemberCount: 0,
    name: 'Item kit', kind: 'skill', framework: 'example-framework', item: item('kit'), tool: 'claude', origins,
    updateState: 'unknown', approval: 'not-needed', installState: 'complete', members: undefined });
  assert.deepEqual(entry.members, [
    { kind: 'text-block', path: join(root, 'AGENTS.md'), blockId: 'kit', fileState: 'matches' },
    { kind: 'file', path: join(root, 'KIT.md'), fileState: 'matches' },
    { kind: 'config-entry', path: join(root, 'settings.json'), pointer: '/kit/enabled', fileState: 'matches' }], 'members in path order');
  assert.equal('policyState' in entry, false, 'Vibe has no policy state');

  writeFileSync(join(root, 'KIT.md'), 'my edit\n');
  writeFileSync(join(root, 'AGENTS.md'), readFileSync(join(root, 'AGENTS.md'), 'utf8').replace('Use the kit.', 'Use my kit.'));
  writeFileSync(join(root, 'settings.json'), '{}\n');
  const edited = (await inventory(root)).selections[0].members;
  assert.deepEqual(Object.fromEntries(edited.map(member => [member.kind, member.fileState])), { file: 'changed', 'text-block': 'block-changed', 'config-entry': 'missing' });
  writeFileSync(join(root, 'AGENTS.md'), 'mine only\n'); rmSync(join(root, 'KIT.md'));
  const removed = (await inventory(root)).selections[0].members;
  assert.deepEqual(Object.fromEntries(removed.map(member => [member.kind, member.fileState])), { file: 'missing', 'text-block': 'block-missing', 'config-entry': 'missing' });
  const legacy = await listManagedSelections({ target: { project: root }, scope: 'project' });
  assert.equal(legacy.schema, 'urn:aihq:core:managed-inventory-result:1.0.0', 'the default stays 1.0.0');
});

test('removal reports claim-removed members absent and restores a replaced value without exposing it', async () => {
  const root = project('restore');
  const USER_VALUE = 'user-owned-token-5f2e9c';
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ kit: { enabled: USER_VALUE }, other: 1 }, null, 2) + '\n');
  const kit = wholeItem();
  const first = await prepare({ useCase: 'policy', policy: policy([kit]), target: { project: root } }, { logging: 'off' });
  const conflict = first.review.operations.find(operation => operation.id === 'kit/entry');
  assert.equal(conflict.effects, 'conflict');
  const resolutions = [{ selectionId: 'kit', operationId: 'entry', choice: 'replace', observedSha256: sha(readFileSync(join(root, 'settings.json'))) }];
  const { prepared: installPrepared, result: installed } = await run(root, policy([kit]), { logging: 'on' }, resolutions);
  assert.equal(installed.completion, 'complete', JSON.stringify(installed.diagnostics));
  assert.deepEqual(installed.members.map(member => [member.kind, member.outcome, member.check]),
    [['file', 'written', 'present-matching'], ['config-entry', 'written', 'present-matching'], ['text-block', 'written', 'present-matching']]);
  assert.equal(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).kit.enabled, true);
  const listed = await inventory(root);

  const { prepared: removalPrepared, result: removed } = await run(root, policy([], { removals: [{ managementId: 'kit-managed', scope: 'project' }] }), { logging: 'on' });
  assert.equal(removed.completion, 'complete', JSON.stringify(removed.diagnostics));
  valid(removed);
  assert.deepEqual(removed.members.map(member => [member.kind, member.outcome, member.check]).sort(), [
    ['config-entry', 'restored', 'present-matching'], ['file', 'claim-removed', 'absent'], ['text-block', 'claim-removed', 'absent']]);
  assert.equal(removed.members.every(member => member.selectionId === null), true, 'generated cleanup has no selection');
  const restored = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
  assert.deepEqual(restored, { kit: { enabled: USER_VALUE }, other: 1 }, 'the person\'s value is back');
  assert.deepEqual((await inventory(root)).selections, []);

  // The protected restoration value never reaches a review, result, history record or inventory.
  const history = [installed, removed].map(result => readFileSync(join(home, '.aih', 'core', result.record.reference), 'utf8'));
  for (const output of [installPrepared.review, removalPrepared.review, installed, removed, listed, ...history])
    assert.equal(JSON.stringify(output).includes(USER_VALUE), false);
});

test('an incomplete run is never confirmed on disk, and inventory reports the install interrupted until it completes', async () => {
  const root = project('incomplete');
  const failing = wholeItem('partial');
  failing.recipe.inline.checks = [{ id: 'digest', kind: 'file.sha256', purpose: 'Check the kit file',
    target: { root: 'project', segments: [{ literal: 'KIT.md' }] }, sha256: sha('something else\n') }];
  failing.recipe.inline.operations[0].checks = ['digest'];
  const { result: partial } = await run(root, policy([failing]));
  assert.equal(partial.completion, 'incomplete');
  valid(partial);
  const written = partial.members.filter(member => member.outcome === 'written');
  assert.ok(written.length >= 1 && written.every(member => member.check === 'present-matching'), 'the written subset matches');
  assert.deepEqual(runMemberClaims(partial), { confirmedOnDisk: false, removed: false });
  const interrupted = (await inventory(root)).selections.find(entry => entry.managementId === 'partial-managed');
  assert.equal(interrupted.installState, 'interrupted');
  assert.equal(interrupted.name, 'Item partial', 'what it wrote stays named');

  const { result: finished } = await run(root, policy([wholeItem('partial')]));
  assert.equal(finished.completion, 'complete', JSON.stringify(finished.diagnostics));
  assert.deepEqual(runMemberClaims(finished), { confirmedOnDisk: true, removed: false });
  assert.equal((await inventory(root)).selections[0].installState, 'complete');

  const { result: removed } = await run(root, policy([], { removals: [{ managementId: 'partial-managed', scope: 'project' }] }));
  assert.deepEqual(runMemberClaims(removed), { confirmedOnDisk: false, removed: true });
  assert.deepEqual(runMemberClaims({ completion: 'complete' }), { confirmedOnDisk: false, removed: false }, 'no member checks support no claim');
});

test('inventory 1.1 derives update, policy and approval states only from supplied data, without a Catalog', async () => {
  const root = project('states');
  const server = selection('server', [op('file', 'file.write', { target: { root: 'project', segments: [{ literal: 'SERVER.md' }] }, content: { literal: 'server\n' } })],
    { selection: { kind: 'mcp-server', name: 'GitHub server' } });
  assert.equal((await run(root, policy([server]))).result.completion, 'complete');
  const states = async index => (await inventory(root, index === undefined ? {} : { index })).selections[0];
  const recorded = item('server');
  assert.equal((await states()).updateState, 'unknown', 'no index, no claim');
  assert.equal((await states({ offered: [recorded] })).updateState, 'current');
  assert.equal((await states({ offered: [{ ...recorded, contentSha256: sha('newer') }] })).updateState, 'update-available');
  const gone = await states({ offered: [] });
  assert.equal(gone.updateState, 'no-longer-offered');
  assert.equal(gone.name, 'GitHub server', 'a framework no longer offered still reads from receipts');
  assert.equal((await states({ offered: [recorded], superseded: [{ item: { framework: recorded.framework, itemId: 'server' },
    by: { framework: recorded.framework, itemId: 'server-2' } }] })).updateState, 'superseded');
  assert.equal((await states({ offered: [recorded], revoked: [{ framework: recorded.framework, itemId: 'server', contentSha256: recorded.contentSha256 }] })).updateState, 'revoked');
  assert.equal((await states({ offered: [recorded], revoked: [{ framework: recorded.framework, itemId: 'server', contentSha256: sha('other') }] })).updateState, 'current',
    'a revocation of another version does not apply');
  assert.equal((await states()).approval, 'needed', 'the binding names a permission step');
  const bad = await inventory(root, { index: { offered: [{ framework: 'x' }] } });
  assert.equal(bad.status, 'invalid'); validInventory(bad);

  const { value: { recipeIdentity } } = await deriveRecipeIdentity({ recipe: server.recipe.inline });
  const organization = obligation => ({ document: { schema: 'urn:aihq:core:organization-policy:1.1.0', id: 'org',
    selections: [{ selectionId: 'server', recipeIdentity, scopes: ['project'], inputs: {}, obligation }] } });
  for (const obligation of ['required', 'recommended', 'permitted', 'prohibited'])
    assert.equal((await inventory(root, { organization: organization(obligation) })).selections[0].policyState, obligation);
  const other = { document: { schema: 'urn:aihq:core:organization-policy:1.1.0', id: 'org', selections: [] } };
  const enterprise = await inventory(root, { organization: other });
  assert.equal(enterprise.selections[0].policyState, 'not-admitted'); validInventory(enterprise);
});

test('the custody migration keeps every existing claim, edge, selector, marker, mode, table and directory record', async () => {
  const root = project('migration');
  const legacyRecipe = (id, operations) => ({ ...recipe(id, operations), schema: 'urn:aihq:core:recipe:1.3.0' });
  const legacySelection = (id, operations, requires = []) => ({ id, managementId: `${id}-managed`, scope: 'project', configuration: {}, requires,
    recipe: { inline: legacyRecipe(id, operations) } });
  const group = { matcher: 'Bash', hooks: [{ type: 'command', command: 'hooks/guard.sh' }] };
  const selections = [
    legacySelection('guide', [op('file', 'file.write', { target: { root: 'project', segments: [{ literal: 'docs' }, { literal: 'deep' }, { literal: 'GUIDE.md' }] },
      content: { literal: 'guide\n' }, mode: 0o755 })]),
    legacySelection('guard', [op('hook', 'hook.group', { target: { root: 'project', segments: [{ literal: '.tool' }, { literal: 'settings.json' }] }, format: 'json',
      container: ['hooks', 'PreToolUse'], groupId: 'guard', selector: { path: ['hooks', 0, 'command'], value: 'hooks/guard.sh' }, action: 'set', group: { literal: group } })], ['guide']),
    legacySelection('tool', [op('entry', 'config.entries', { target: { root: 'project', segments: [{ literal: 'config.toml' }] }, format: 'toml',
      entries: [{ path: ['tool', 'enabled'], action: 'set', value: { literal: true } }] })]),
    legacySelection('notes', [op('block', 'text.block', { target: { root: 'project', segments: [{ literal: 'AGENTS.md' }] }, blockId: 'notes',
      startMarker: '<!-- aih:notes:start -->', endMarker: '<!-- aih:notes:end -->', action: 'set', content: { literal: 'Notes.\n' } })])];
  const bundle = [{ id: 'bundle', scope: 'project', members: ['guide-managed', 'guard-managed', 'tool-managed', 'notes-managed'] }];
  const older = { schema: 'urn:aihq:core:execution-policy:1.3.0', mode: 'vibe', selections, managedSelections: bundle };
  assert.equal((await run(root, older)).result.completion, 'complete');
  const receipt = join(home, '.aih', 'core', 'ownership', `${sha(root)}.json`);
  const before = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(before.schema, 'urn:aihq:core:ownership:1.5.0', 'directory evidence, a created table, a hook and a marker block');

  // Read through the migration: every claim appears as an unnamed 1.1 selection with typed members.
  const unnamed = await inventory(root);
  assert.equal(unnamed.status, 'complete'); validInventory(unnamed);
  assert.deepEqual(unnamed.selections.map(entry => [entry.managementId, entry.name, entry.item, entry.origins, entry.updateState, entry.approval,
    entry.members.map(member => [member.kind, member.fileState])]), [
    ['guard-managed', null, null, [], 'unknown', null, [['hook-group-member', 'matches']]],
    ['guide-managed', null, null, [], 'unknown', null, [['file', 'matches']]],
    ['notes-managed', null, null, [], 'unknown', null, [['text-block', 'matches']]],
    ['tool-managed', null, null, [], 'unknown', null, [['config-entry', 'matches']]]]);

  // Describing the same selections under policy 1.4 records item facts and changes nothing else.
  const described = selections.map(entry => ({ ...entry, item: item(entry.id), tool: 'claude', name: `Item ${entry.id}`, kind: entry.id === 'guard' ? 'hook' : 'skill',
    origins: [{ reasonIncluded: 'in-set', set: { framework: 'example-framework', setId: 'bundle', setSha256: sha('bundle') } }] }));
  const { result } = await run(root, { ...older, schema: 'urn:aihq:core:execution-policy:1.4.0', selections: described });
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  assert.equal(result.operations.every(operation => operation.application === 'already-satisfied'), true);
  const after = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(after.schema, 'urn:aihq:core:ownership:1.6.0');
  const { items, schema: _new, ...kept } = after; const { schema: _old, ...prior } = before;
  assert.deepEqual(kept, prior, 'members, claims, sets, requires, selectors, markers, modes, tables and directories are unchanged');
  assert.equal(Object.keys(items).length, 4);
  const named = await inventory(root);
  assert.deepEqual(named.selections.map(entry => [entry.managementId, entry.name, entry.origins[0].set.setId, entry.members.length]), [
    ['guard-managed', 'Item guard', 'bundle', 1], ['guide-managed', 'Item guide', 'bundle', 1], ['notes-managed', 'Item notes', 'bundle', 1], ['tool-managed', 'Item tool', 'bundle', 1]]);

  // Protected custody stays authoritative: the existing set and dependency removal still governs cleanup.
  const { result: removed } = await run(root, { ...older, schema: 'urn:aihq:core:execution-policy:1.4.0', selections: [], managedSelections: [{ id: 'bundle', scope: 'project', members: [] }] });
  assert.equal(removed.completion, 'complete', JSON.stringify(removed.diagnostics));
  assert.deepEqual(runMemberClaims(removed), { confirmedOnDisk: false, removed: true });
  assert.deepEqual(removed.members.map(member => [member.kind, member.outcome, member.check]).sort(), [
    ['config-entry', 'claim-removed', 'absent'], ['file', 'claim-removed', 'absent'], ['hook-group-member', 'claim-removed', 'absent'], ['text-block', 'claim-removed', 'absent']]);
  assert.deepEqual((await inventory(root)).selections, []);
});

test('restoration data survives while another claim still shares the entry, and is used by the last removal', async () => {
  const root = project('shared-restore');
  const USER_VALUE = 'shared-user-value-91ab';
  const settings = join(root, 'settings.json');
  writeFileSync(settings, JSON.stringify({ kit: { enabled: USER_VALUE } }) + '\n');
  const entry = id => selection(id, [op('entry', 'config.entries', { target: { root: 'project', segments: [{ literal: 'settings.json' }] }, format: 'json',
    entries: [{ path: ['kit', 'enabled'], action: 'set', value: { literal: true } }] })]);
  const resolutions = [{ selectionId: 'first', operationId: 'entry', choice: 'replace', observedSha256: sha(readFileSync(settings)) }];
  assert.equal((await run(root, policy([entry('first')]), {}, resolutions)).result.completion, 'complete');
  const adopt = [{ selectionId: 'second', operationId: 'entry', choice: 'adopt', observedSha256: sha(readFileSync(settings)) }];
  assert.equal((await run(root, policy([entry('first'), entry('second')]), {}, adopt)).result.completion, 'complete');
  assert.equal((await inventory(root)).selections.every(entry => entry.sharedMemberCount === 1), true, 'both claims share the entry');
  const { result: firstRemoved } = await run(root, policy([entry('second')], { removals: [{ managementId: 'first-managed', scope: 'project' }] }));
  assert.equal(firstRemoved.completion, 'complete', JSON.stringify(firstRemoved.diagnostics));
  assert.deepEqual(firstRemoved.members.filter(member => member.selectionId === null).map(member => [member.intent, member.outcome, member.check]),
    [['keep', 'kept', 'present-matching']], 'the shared entry stays for the other claim');
  assert.deepEqual(runMemberClaims(firstRemoved).removed, false);
  const { result: lastRemoved } = await run(root, policy([], { removals: [{ managementId: 'second-managed', scope: 'project' }] }));
  assert.deepEqual(lastRemoved.members.map(member => [member.intent, member.outcome, member.check]), [['remove', 'restored', 'present-matching']]);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { kit: { enabled: USER_VALUE } });
});

test('inventory 1.1 never publishes a private input value bound into a member path', async () => {
  const root = project('private-path');
  const SECRET = 'tok-path-secret-4d2a';
  const named = selection('vault', [op('file', 'file.write', { target: { root: 'project', segments: [{ literal: 'vault' }, { input: 'name' }] }, content: { literal: 'v\n' } })],
    { inputs: { name: { type: 'string', required: true, sensitive: true, maxLength: 64 } } });
  const { prepared, result } = await run(root, policy([named]), { privateInputs: { vault: { name: SECRET } } });
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  const listed = await inventory(root);
  assert.deepEqual(listed.selections[0].members.map(member => [member.path, member.fileState]), [[join(root, 'vault', '[REDACTED]'), 'matches']]);
  for (const output of [prepared.review, result, listed]) assert.equal(JSON.stringify(output).includes(SECRET), false);
});

test('a value the person deleted after a replace is not brought back by removal', async () => {
  for (const deleted of ['entry', 'file']) {
    const root = project(`deleted-${deleted}`);
    const settings = join(root, 'settings.json');
    writeFileSync(settings, JSON.stringify({ kit: { enabled: 'mine' }, other: 2 }) + '\n');
    const kit = selection('kit', [op('entry', 'config.entries', { target: { root: 'project', segments: [{ literal: 'settings.json' }] }, format: 'json',
      entries: [{ path: ['kit', 'enabled'], action: 'set', value: { literal: true } }] })]);
    const resolutions = [{ selectionId: 'kit', operationId: 'entry', choice: 'replace', observedSha256: sha(readFileSync(settings)) }];
    assert.equal((await run(root, policy([kit]), {}, resolutions)).result.completion, 'complete');
    if (deleted === 'entry') writeFileSync(settings, JSON.stringify({ other: 2 }) + '\n'); else rmSync(settings);
    const { result } = await run(root, policy([], { removals: [{ managementId: 'kit-managed', scope: 'project' }] }));
    assert.deepEqual(result.members.map(member => [member.intent, member.outcome, member.check]), [['remove', 'claim-removed', 'absent']], deleted);
    assert.equal(runMemberClaims(result).removed, true);
    if (deleted === 'entry') assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { other: 2 });
  }
});
