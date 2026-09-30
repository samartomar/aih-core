import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { prepare, apply } from '../dist/core/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'aih-recipe-lifecycle-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });
const target = (root, name) => ({ root, segments: [{ literal: name }] });
const recipe = operation => ({ schema: 'urn:aihq:core:recipe:1.0.0', id: 'lifecycle', description: 'Lifecycle fixture',
  inputs: {}, materials: [], targets: [operation.scope], prerequisites: [], operations: [operation], checks: [] });
const policy = operation => ({ schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
  id: 'item', managementId: 'stable-item', scope: operation.scope, configuration: {}, requires: [], recipe: { inline: recipe(operation) }
}] });
const request = (project, operation, resolutions) => ({ useCase: 'policy', policy: policy(operation), target: { project },
  ...(resolutions ? { resolutions } : {}) });
const approve = prepared => ({ reviewDigest: prepared.review.reviewDigest, approved: true, origin: 'automation' });
const op = (kind, root, name, extra = {}) => ({ id: 'member', purpose: 'Manage one member', kind,
  scope: root === 'project' ? 'project' : 'user', target: target(root, name), requires: [], checks: [], ...extra });

test('managed removal keeps the original bytes in private recovery', async () => {
  const project = mkdtempSync(join(scratch, 'remove-'));
  const write = op('file.write', 'project', 'owned.txt', { content: { literal: 'original\n' } });
  const first = await prepare(request(project, write), { logging: 'off' });
  assert.equal(first.status, 'ready', JSON.stringify(first.diagnostics));
  { const result = await apply(first.prepared, approve(first), { logging: 'off' }); assert.equal(result.completion, 'complete', JSON.stringify(result)); }
  const remove = op('file.remove', 'project', 'owned.txt');
  const second = await prepare(request(project, remove), { logging: 'off' });
  assert.equal(second.review.operations[0].effects, 'remove-file', JSON.stringify(second.diagnostics));
  const result = await apply(second.prepared, approve(second), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result));
  assert.equal(existsSync(join(project, 'owned.txt')), false);
  const manifest = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.aih/core', result.recovery), 'utf8'));
  assert.equal(manifest.operations[0].root, realpathSync.native(project));
  assert.equal(readFileSync(join(process.env.USERPROFILE, '.aih/core', manifest.operations[0].snapshot), 'utf8'), 'original\n');
});

test('unowned removal stays a conflict even with a broad replacement choice', async () => {
  const project = mkdtempSync(join(scratch, 'unowned-'));
  const path = join(project, 'human.txt'); writeFileSync(path, 'human content');
  const remove = op('file.remove', 'project', 'human.txt');
  const resolution = [{ selectionId: 'item', operationId: 'member', choice: 'replace',
    observedSha256: createHash('sha256').update('human content').digest('hex') }];
  const prepared = await prepare(request(project, remove, resolution), { logging: 'off' });
  assert.equal(prepared.status, 'blocked');
  assert.equal(prepared.prepared, undefined);
  assert.equal(readFileSync(path, 'utf8'), 'human content');
});

test('userState resolves only inside the assigned managed-content child', async () => {
  const project = mkdtempSync(join(scratch, 'userstate-'));
  const write = op('file.write', 'userState', 'asset.txt', { content: { literal: 'managed asset' } });
  const prepared = await prepare(request(project, write), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const result = await apply(prepared.prepared, approve(prepared), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result));
  const assetPath = prepared.review.operations[0].details.target;
  assert.match(assetPath, /\.aih[\\/]core[\\/]content[\\/]/);
  assert.equal(readFileSync(assetPath, 'utf8'), 'managed asset');
});

test('unsupported existing TOML becomes an explicit edit conflict', async () => {
  const project = mkdtempSync(join(scratch, 'toml-conflict-'));
  writeFileSync(join(project, 'settings.toml'), '[client]\nmode = "a"\nmode = "b"\n');
  const edit = op('config.entries', 'project', 'settings.toml', { format: 'toml',
    entries: [{ path: ['client', 'mode'], action: 'set', value: { literal: 'c' } }] });
  const prepared = await prepare(request(project, edit), { logging: 'off' });
  assert.equal(prepared.status, 'blocked', JSON.stringify(prepared.diagnostics));
  assert.equal(prepared.review.operations[0].effects, 'conflict');
  assert.equal(prepared.diagnostics[0].code, 'STATE_CONFLICT');
  assert.equal(readFileSync(join(project, 'settings.toml'), 'utf8'), '[client]\nmode = "a"\nmode = "b"\n');
});

test('unavailable referenced material omits only its selection under explicit partial approval', async () => {
  const project = mkdtempSync(join(scratch, 'partial-material-'));
  const independent = op('file.write', 'project', 'independent.txt', { content: { literal: 'independent' } });
  const document = policy(independent);
  document.selections.unshift({ id: 'missing', managementId: 'missing', scope: 'project', configuration: {}, requires: [],
    recipe: { reference: { source: { kind: 'local', input: 'missing-root' }, path: 'recipe.json',
      sha256: '0'.repeat(64), byteLength: 1, materials: [] } } });
  const p = await prepare({ useCase: 'policy', policy: document, target: { project } },
    { logging: 'off', materialRoots: { 'missing-root': join(project, 'absent-source') } });
  assert.equal(p.status, 'partial', JSON.stringify(p.diagnostics));
  assert.equal(p.review.omissions[0].reason, 'local-root-unavailable');
  const withoutPartial = await apply(p.prepared, approve(p), { logging: 'off' });
  assert.equal(withoutPartial.completion, 'rejected');
  assert.equal(existsSync(join(project, 'independent.txt')), false);
  const result = await apply(p.prepared, { ...approve(p), allowPartial: true }, { logging: 'off' });
  assert.equal(result.completion, 'incomplete', JSON.stringify(result));
  assert.equal(result.diagnostics[0].reason, 'local-root-unavailable');
  assert.equal(readFileSync(join(project, 'independent.txt'), 'utf8'), 'independent');
});

test('Prepare rejects a multi-selection closure above the shared limit before reading sources', async () => {
  const project = mkdtempSync(join(scratch, 'aggregate-material-'));
  const members = Array.from({ length: 17 }, (_, index) => {
    const id = `payload-${String(index).padStart(2, '0')}`;
    return { id, path: `${id}.bin`, sha256: '0'.repeat(64), byteLength: 16 * 1024 * 1024 };
  });
  const reference = { source: { kind: 'local', input: 'absent' }, path: 'recipe.json',
    sha256: '0'.repeat(64), byteLength: 1, materials: members };
  const selections = ['first', 'second'].map(id => ({ id, managementId: id,
    scope: 'project', configuration: {}, requires: [], recipe: { reference } }));
  const p = await prepare({ useCase: 'policy', policy: {
    schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections
  }, target: { project } }, { logging: 'off' });
  assert.equal(p.status, 'invalid');
  assert.equal(p.diagnostics[0].reason, 'captured-byte-limit');
  assert.equal(p.prepared, undefined);
});

test('managed config entries update despite unrelated edits and renamed run identities', async () => {
  const project = mkdtempSync(join(scratch, 'entry-update-'));
  const edit = op('config.entries', 'project', 'settings.jsonc', { format: 'jsonc',
    entries: [{ path: ['mcpServers', 'selected'], action: 'set', value: { literal: { command: 'first' } } }] });
  const first = await prepare(request(project, edit), { logging: 'off' });
  { const result = await apply(first.prepared, approve(first), { logging: 'off' }); assert.equal(result.completion, 'complete', JSON.stringify(result)); }
  const path = join(project, 'settings.jsonc');
  writeFileSync(path, readFileSync(path, 'utf8').replace('{', '{\n  // human comment\n  "human": true,'));
  edit.id = 'renamed'; edit.entries[0].value.literal.command = 'second';
  const document = policy(edit); document.selections[0].id = 'renamed-selection';
  const next = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal(next.status, 'ready', JSON.stringify(next));
  assert.equal((await apply(next.prepared, approve(next), { logging: 'off' })).completion, 'complete');
  assert.match(readFileSync(path, 'utf8'), /human comment/);
  assert.match(readFileSync(path, 'utf8'), /"human": true/);
  assert.match(readFileSync(path, 'utf8'), /second/);
});

test('omitted management sets retain entries while explicit empty sets remove only selected members', async () => {
  const project = mkdtempSync(join(scratch, 'managed-set-'));
  writeFileSync(join(project, 'settings.jsonc'), '{\n // keep this\n "human": true\n}\n');
  const edit = op('config.entries', 'project', 'settings.jsonc', { format: 'jsonc',
    entries: [{ path: ['mcpServers', 'selected'], action: 'set', value: { literal: { command: 'owned' } } }] });
  const document = policy(edit); document.managedSelections = [{ id: 'tools', scope: 'project', members: ['stable-item'] }];
  const first = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal(first.status, 'ready', JSON.stringify(first));
  { const result = await apply(first.prepared, approve(first), { logging: 'off' }); assert.equal(result.completion, 'complete', JSON.stringify(result)); }
  const empty = { schema: document.schema, mode: 'vibe', selections: [] };
  const omitted = await prepare({ useCase: 'policy', policy: empty, target: { project } }, { logging: 'off' });
  assert.equal(omitted.review.operations.length, 0);
  assert.match(readFileSync(join(project, 'settings.jsonc'), 'utf8'), /owned/);
  empty.managedSelections = [{ id: 'tools', scope: 'project', members: [] }];
  const removal = await prepare({ useCase: 'policy', policy: empty, target: { project } }, { logging: 'off' });
  assert.equal(removal.status, 'ready', JSON.stringify(removal));
  assert.equal(removal.review.operations.length, 1);
  const result = await apply(removal.prepared, approve(removal), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result));
  const text = readFileSync(join(project, 'settings.jsonc'), 'utf8');
  assert.doesNotMatch(text, /owned/); assert.match(text, /keep this/); assert.match(text, /"human": true/);
  assert.ok(result.recovery);
});

test('disjoint entries share a destination and retained dependencies survive set removal', async () => {
  const project = mkdtempSync(join(scratch, 'shared-destination-'));
  const selection = (id, key, requires = []) => ({ id, managementId: id, scope: 'project', configuration: {}, requires,
    recipe: { inline: recipe(op('config.entries', 'project', 'settings.jsonc', { format: 'jsonc',
      entries: [{ path: ['mcpServers', key], action: 'set', value: { literal: { command: id } } }] })) } });
  const document = { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe',
    selections: [selection('shared', 'shared'), selection('alpha', 'alpha', ['shared']), selection('beta', 'beta', ['shared'])],
    managedSelections: [{ id: 'alpha-set', scope: 'project', members: ['alpha', 'shared'] }, { id: 'beta-set', scope: 'project', members: ['beta'] }] };
  const first = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal(first.status, 'ready', JSON.stringify(first));
  { const result = await apply(first.prepared, approve(first), { logging: 'off' }); assert.equal(result.completion, 'complete', JSON.stringify(result)); }
  const reduced = { schema: document.schema, mode: 'vibe', selections: [], managedSelections: [{ id: 'alpha-set', scope: 'project', members: [] }] };
  const next = await prepare({ useCase: 'policy', policy: reduced, target: { project } }, { logging: 'off' });
  assert.equal(next.status, 'ready', JSON.stringify(next));
  assert.equal((await apply(next.prepared, approve(next), { logging: 'off' })).completion, 'complete');
  let text = readFileSync(join(project, 'settings.jsonc'), 'utf8');
  assert.doesNotMatch(text, /"alpha"/); assert.match(text, /"beta"/); assert.match(text, /"shared"/);
  reduced.managedSelections.push({ id: 'beta-set', scope: 'project', members: [] });
  const final = await prepare({ useCase: 'policy', policy: reduced, target: { project } }, { logging: 'off' });
  assert.equal((await apply(final.prepared, approve(final), { logging: 'off' })).completion, 'complete');
  text = readFileSync(join(project, 'settings.jsonc'), 'utf8');
  assert.doesNotMatch(text, /"beta"|"shared"/);
});

test('recipe updates subtract disappeared members and preserve matching unowned files until reviewed adoption', async () => {
  const project = mkdtempSync(join(scratch, 'recipe-update-'));
  const firstOp = op('file.write', 'project', 'old.txt', { content: { literal: 'owned' } });
  const first = await prepare(request(project, firstOp), { logging: 'off' });
  { const result = await apply(first.prepared, approve(first), { logging: 'off' }); assert.equal(result.completion, 'complete', JSON.stringify(result)); }
  writeFileSync(join(project, 'new.txt'), 'matching');
  const newOp = op('file.write', 'project', 'new.txt', { content: { literal: 'matching' } });
  const next = await prepare(request(project, newOp), { logging: 'off' });
  assert.equal(next.review.operations.length, 2);
  assert.equal((await apply(next.prepared, approve(next), { logging: 'off' })).completion, 'complete');
  assert.equal(existsSync(join(project, 'old.txt')), false);
  const removePolicy = { schema: policy(newOp).schema, mode: 'vibe', selections: [], removals: [{ managementId: 'stable-item', scope: 'project' }] };
  const unownedRemoval = await prepare({ useCase: 'policy', policy: removePolicy, target: { project } }, { logging: 'off' });
  assert.equal(unownedRemoval.review.operations.length, 0);
  const adopt = await prepare(request(project, newOp, [{ selectionId: 'item', operationId: 'member', choice: 'adopt',
    observedSha256: createHash('sha256').update('matching').digest('hex') }]), { logging: 'off' });
  assert.equal((await apply(adopt.prepared, approve(adopt), { logging: 'off' })).completion, 'complete');
  const ownedRemoval = await prepare({ useCase: 'policy', policy: removePolicy, target: { project } }, { logging: 'off' });
  assert.equal(ownedRemoval.review.operations.length, 1);
  assert.equal((await apply(ownedRemoval.prepared, approve(ownedRemoval), { logging: 'off' })).completion, 'complete');
  assert.equal(existsSync(join(project, 'new.txt')), false);
});

test('shared member custody requires explicit adoption and protects retained owners', async () => {
  const project = mkdtempSync(join(scratch, 'shared-owner-'));
  const write = op('file.write', 'project', 'shared.txt', { content: { literal: 'shared bytes' } });
  const first = await prepare(request(project, write), { logging: 'off' });
  assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
  const document = policy(write); document.selections[0].id = 'second'; document.selections[0].managementId = 'second-owner';
  const matching = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal(matching.review.operations[0].ownership, 'unowned');
  assert.equal((await apply(matching.prepared, approve(matching), { logging: 'off' })).completion, 'complete');
  const adopt = await prepare({ useCase: 'policy', policy: document, target: { project }, resolutions: [{ selectionId: 'second',
    operationId: 'member', choice: 'adopt', observedSha256: createHash('sha256').update('shared bytes').digest('hex') }] }, { logging: 'off' });
  assert.equal((await apply(adopt.prepared, approve(adopt), { logging: 'off' })).completion, 'complete');
  write.content.literal = 'changed behind first owner';
  const conflict = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal(conflict.status, 'blocked');
  const remove = { schema: document.schema, mode: 'vibe', selections: [], removals: [{ managementId: 'stable-item', scope: 'project' }] };
  const releaseFirst = await prepare({ useCase: 'policy', policy: remove, target: { project } }, { logging: 'off' });
  assert.equal((await apply(releaseFirst.prepared, approve(releaseFirst), { logging: 'off' })).completion, 'complete');
  assert.equal(readFileSync(join(project, 'shared.txt'), 'utf8'), 'shared bytes');
  remove.removals = [{ managementId: 'second-owner', scope: 'project' }];
  const releaseFinal = await prepare({ useCase: 'policy', policy: remove, target: { project } }, { logging: 'off' });
  assert.equal((await apply(releaseFinal.prepared, approve(releaseFinal), { logging: 'off' })).completion, 'complete');
  assert.equal(existsSync(join(project, 'shared.txt')), false);
});

test('managed drift stays protected even when it matches a new desired value', async () => {
  const project = mkdtempSync(join(scratch, 'matching-drift-'));
  const write = op('file.write', 'project', 'owned.txt', { content: { literal: 'first' } });
  const first = await prepare(request(project, write), { logging: 'off' });
  assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
  writeFileSync(join(project, 'owned.txt'), 'human edit'); write.content.literal = 'human edit';
  const drift = await prepare(request(project, write), { logging: 'off' });
  assert.equal(drift.status, 'blocked');
  const exact = await prepare(request(project, write, [{ selectionId: 'item', operationId: 'member', choice: 'replace',
    observedSha256: createHash('sha256').update('human edit').digest('hex') }]), { logging: 'off' });
  assert.equal(exact.status, 'ready');
  assert.equal((await apply(exact.prepared, approve(exact), { logging: 'off' })).completion, 'complete');
  const removal = await prepare(request(project, op('file.remove', 'project', 'owned.txt')), { logging: 'off' });
  assert.equal(removal.status, 'ready');
});

test('user custody follows actual home and retained roots in other projects protect user dependencies', async () => {
  const project = mkdtempSync(join(scratch, 'user-anchor-'));
  const otherProject = mkdtempSync(join(scratch, 'other-user-anchor-'));
  const user = { id: 'user', managementId: 'user-dependency', scope: 'user', configuration: {}, requires: [],
    recipe: { inline: recipe(op('file.write', 'userState', 'asset.txt', { content: { literal: 'user asset' } })) } };
  const rootSelection = { id: 'root', managementId: 'root', scope: 'project', configuration: {}, requires: ['user'],
    recipe: { inline: recipe(op('file.write', 'project', 'root.txt', { content: { literal: 'root' } })) } };
  const document = { schema: policy(op('file.remove', 'project', 'unused')).schema, mode: 'vibe', selections: [user, rootSelection],
    managedSelections: [{ id: 'user-set', scope: 'user', members: ['user-dependency'] }] };
  const first = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  { const result = await apply(first.prepared, approve(first), { logging: 'off' }); assert.equal(result.completion, 'complete', JSON.stringify(result)); }
  const asset = first.review.operations.find(item => item.id === 'user/member').details.target;
  const same = await prepare({ useCase: 'policy', policy: { ...document, selections: [user] }, target: { project: otherProject } }, { logging: 'off' });
  assert.equal(same.review.operations[0].details.target, asset);
  assert.equal(same.review.operations[0].ownership, 'managed');
  const empty = { schema: document.schema, mode: 'vibe', selections: [], managedSelections: [{ id: 'user-set', scope: 'user', members: [] }] };
  const protectedRemoval = await prepare({ useCase: 'policy', policy: empty, target: { project: otherProject } }, { logging: 'off' });
  assert.equal(protectedRemoval.review.operations.length, 0);
  assert.equal((await apply(protectedRemoval.prepared, approve(protectedRemoval), { logging: 'off' })).completion, 'complete');
  assert.equal(readFileSync(asset, 'utf8'), 'user asset');
  const removeRoot = await prepare({ useCase: 'policy', policy: { schema: document.schema, mode: 'vibe', selections: [],
    removals: [{ managementId: 'root', scope: 'project' }] }, target: { project } }, { logging: 'off' });
  assert.equal((await apply(removeRoot.prepared, approve(removeRoot), { logging: 'off' })).completion, 'complete');
  const removeUser = await prepare({ useCase: 'policy', policy: empty, target: { project: otherProject } }, { logging: 'off' });
  assert.equal(removeUser.review.operations.length, 1);
  assert.equal((await apply(removeUser.prepared, approve(removeUser), { logging: 'off' })).completion, 'complete');
  assert.equal(existsSync(asset), false);
});

test('failed update checks preserve dependency custody and block dependent removal under partial approval', async () => {
  const project = mkdtempSync(join(scratch, 'failed-update-'));
  const dep = { id: 'dependency', managementId: 'dependency', scope: 'project', configuration: {}, requires: [],
    recipe: { inline: recipe(op('file.write', 'project', 'dependency.txt', { content: { literal: 'dependency' } })) } };
  const rootSelection = { id: 'root', managementId: 'root', scope: 'project', configuration: {}, requires: ['dependency'],
    recipe: { inline: recipe(op('file.write', 'project', 'root.txt', { content: { literal: 'old root' } })) } };
  const document = { schema: policy(op('file.remove', 'project', 'unused')).schema, mode: 'vibe', selections: [dep, rootSelection],
    managedSelections: [{ id: 'tools', scope: 'project', members: ['root', 'dependency'] }] };
  const first = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
  rootSelection.requires = []; rootSelection.recipe.inline.operations[0].content.literal = 'new root';
  rootSelection.recipe.inline.operations[0].checks = ['required'];
  rootSelection.recipe.inline.checks = [{ id: 'required', purpose: 'Fail update validation', kind: 'file.sha256',
    target: target('project', 'root.txt'), sha256: '0'.repeat(64) }];
  document.selections = [rootSelection]; document.managedSelections[0].members = ['root'];
  const update = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal(update.status, 'ready', JSON.stringify(update));
  const result = await apply(update.prepared, { ...approve(update), allowPartial: true }, { logging: 'off' });
  assert.equal(result.completion, 'incomplete');
  assert.equal(result.operations.find(item => item.id.startsWith('lifecycle/')).application, 'not-attempted');
  assert.equal(readFileSync(join(project, 'dependency.txt'), 'utf8'), 'dependency');
  const retry = await prepare({ useCase: 'policy', policy: { schema: document.schema, mode: 'vibe', selections: [],
    removals: [{ managementId: 'dependency', scope: 'project' }] }, target: { project } }, { logging: 'off' });
  assert.equal(retry.review.operations.length, 0);
  assert.ok(result.recovery);
});

test('committed human changes remain protected by current bytes rather than Git status', async () => {
  const project = mkdtempSync(join(scratch, 'committed-drift-'));
  const write = op('file.write', 'project', 'owned.txt', { content: { literal: 'managed' } });
  const first = await prepare(request(project, write), { logging: 'off' });
  assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
  writeFileSync(join(project, 'owned.txt'), 'committed human content');
  const git = args => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: project, encoding: 'utf8', windowsHide: true });
  git(['init', '--quiet']); git(['add', 'owned.txt']); git(['commit', '--quiet', '-m', 'fixture human edit']);
  assert.equal(git(['status', '--porcelain']), '');
  const removal = await prepare(request(project, op('file.remove', 'project', 'owned.txt')), { logging: 'off' });
  assert.equal(removal.status, 'blocked');
  assert.equal(readFileSync(join(project, 'owned.txt'), 'utf8'), 'committed human content');
});

test('cancellation leaves managed removal recoverable and requires fresh preparation', async () => {
  const project = mkdtempSync(join(scratch, 'cancel-removal-'));
  const write = op('file.write', 'project', 'owned.txt', { content: { literal: 'recoverable managed bytes' } });
  const first = await prepare(request(project, write), { logging: 'off' });
  assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
  const sentinel = join(project, 'started.txt');
  const pause = { id: 'pause', managementId: 'pause', scope: 'project', configuration: {}, requires: [], recipe: { inline: recipe({
    id: 'wait', purpose: 'Pause before cleanup', kind: 'process.run', scope: 'project', requires: [], checks: [],
    executable: { name: 'node' }, args: [{ literal: '-e' }, { literal: "require('node:fs').writeFileSync(process.env.AIH_SENTINEL,'started');setTimeout(()=>{},10000)" }],
    cwd: { root: 'project', segments: [] }, env: { AIH_SENTINEL: { literal: sentinel } }, timeoutMs: 20000, maxOutputBytes: 1024,
    acceptedExitCodes: [0], effects: ['Write fixture start marker and wait']
  }) } };
  const document = { schema: policy(write).schema, mode: 'vibe', selections: [pause], removals: [{ managementId: 'stable-item', scope: 'project' }] };
  const prepared = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  const controller = new AbortController();
  const pending = apply(prepared.prepared, approve(prepared), { logging: 'off', signal: controller.signal });
  for (let attempt = 0; attempt < 200 && !existsSync(sentinel); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(existsSync(sentinel), true); controller.abort();
  const result = await pending;
  assert.equal(result.completion, 'cancelled', JSON.stringify(result));
  assert.equal(result.operations.find(item => item.id.startsWith('lifecycle/')).application, 'not-attempted');
  assert.equal(readFileSync(join(project, 'owned.txt'), 'utf8'), 'recoverable managed bytes');
  const manifest = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.aih/core', result.recovery), 'utf8'));
  assert.equal(readFileSync(join(process.env.USERPROFILE, '.aih/core', manifest.operations[0].snapshot), 'utf8'), 'recoverable managed bytes');
  assert.equal((await apply(prepared.prepared, approve(prepared), { logging: 'off' })).completion, 'rejected');
  const fresh = await prepare(request(project, op('file.remove', 'project', 'owned.txt')), { logging: 'off' });
  assert.equal(fresh.review.operations[0].ownership, 'managed');
});

test('stale adoption and malformed custody cannot authorize managed effects', async () => {
  const project = mkdtempSync(join(scratch, 'stale-adopt-'));
  const write = op('file.write', 'project', 'owned.txt', { content: { literal: 'matching' } });
  writeFileSync(join(project, 'owned.txt'), 'matching');
  const adoption = await prepare(request(project, write, [{ selectionId: 'item', operationId: 'member', choice: 'adopt',
    observedSha256: createHash('sha256').update('matching').digest('hex') }]), { logging: 'off' });
  writeFileSync(join(project, 'owned.txt'), 'human changed');
  const stale = await apply(adoption.prepared, approve(adoption), { logging: 'off' });
  assert.equal(stale.completion, 'rejected'); assert.equal(stale.diagnostics[0].code, 'REVIEW_STALE');
  writeFileSync(join(project, 'owned.txt'), 'matching');
  const fresh = await prepare(request(project, write, [{ selectionId: 'item', operationId: 'member', choice: 'adopt',
    observedSha256: createHash('sha256').update('matching').digest('hex') }]), { logging: 'off' });
  assert.equal((await apply(fresh.prepared, approve(fresh), { logging: 'off' })).completion, 'complete');
  const receipt = join(process.env.USERPROFILE, '.aih/core/ownership', createHash('sha256').update(realpathSync.native(project)).digest('hex') + '.json');
  const record = JSON.parse(readFileSync(receipt, 'utf8'));
  Object.values(record.members)[0].descriptor.path = '../human.txt'; writeFileSync(receipt, JSON.stringify(record));
  const invalid = await prepare(request(project, op('file.remove', 'project', 'owned.txt')), { logging: 'off' });
  assert.equal(invalid.status, 'invalid'); assert.equal(invalid.prepared, undefined);
  assert.equal(readFileSync(join(project, 'owned.txt'), 'utf8'), 'matching');
});

test('TOML entries and text blocks retain neighboring edits during selected cleanup', async () => {
  const project = mkdtempSync(join(scratch, 'narrow-cleanup-'));
  writeFileSync(join(project, 'settings.toml'), '# human heading\n[client]\nother = "keep"\n');
  writeFileSync(join(project, 'NOTES.md'), 'Human introduction.\n');
  const entries = op('config.entries', 'project', 'settings.toml', { format: 'toml', entries: [{ path: ['client', 'managed'], action: 'set', value: { literal: 'owned' } }] });
  const block = op('text.block', 'project', 'NOTES.md', { blockId: 'managed', startMarker: '<!-- managed:start -->', endMarker: '<!-- managed:end -->', action: 'set', content: { literal: 'owned block' } });
  const document = policy(entries); block.id = 'block'; document.selections[0].recipe.inline.operations.push(block);
  const first = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal(first.status, 'ready', JSON.stringify(first));
  assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
  writeFileSync(join(project, 'settings.toml'), readFileSync(join(project, 'settings.toml'), 'utf8').replace('"keep"', '"human edit"'));
  writeFileSync(join(project, 'NOTES.md'), 'Human added introduction.\n' + readFileSync(join(project, 'NOTES.md'), 'utf8'));
  const remove = await prepare({ useCase: 'policy', policy: { schema: document.schema, mode: 'vibe', selections: [],
    removals: [{ managementId: 'stable-item', scope: 'project' }] }, target: { project } }, { logging: 'off' });
  assert.equal(remove.status, 'ready', JSON.stringify(remove));
  assert.equal((await apply(remove.prepared, approve(remove), { logging: 'off' })).completion, 'complete');
  assert.equal(readFileSync(join(project, 'settings.toml'), 'utf8'), '# human heading\n[client]\nother = "human edit"\n');
  assert.equal(readFileSync(join(project, 'NOTES.md'), 'utf8'), 'Human added introduction.\nHuman introduction.\n');
});

test('cancellation between cleanup removals advances only the completed member custody', { timeout: 30_000 }, async () => {
  const project = mkdtempSync(join(scratch, 'cancel-between-removals-'));
  const write = op('file.write', 'project', 'first.txt', { content: { literal: 'first bytes' } });
  const document = policy(write);
  document.selections[0].recipe.inline.operations.push({ ...structuredClone(write), id: 'second', target: target('project', 'second.txt'), content: { literal: 'second bytes' } });
  document.managedSelections = [{ id: 'tools', scope: 'project', members: ['stable-item'] }];
  const first = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
  const empty = { schema: document.schema, mode: 'vibe', selections: [], managedSelections: [{ id: 'tools', scope: 'project', members: [] }] };
  const prepared = await prepare({ useCase: 'policy', policy: empty, target: { project } }, { logging: 'off' });
  const controller = new AbortController(); let finished = false;
  const abortAfterFirst = () => {
    if (finished) return;
    if (!existsSync(join(project, 'first.txt'))) controller.abort(); else setImmediate(abortAfterFirst);
  };
  const pending = apply(prepared.prepared, approve(prepared), { logging: 'off', signal: controller.signal }); setImmediate(abortAfterFirst);
  let result; try { result = await pending; } finally { finished = true; }
  assert.equal(result.completion, 'cancelled', JSON.stringify(result));
  assert.deepEqual(result.operations.map(item => item.application), ['applied', 'not-attempted']);
  assert.equal(readFileSync(join(project, 'second.txt'), 'utf8'), 'second bytes');
  const manifest = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.aih/core', result.recovery), 'utf8'));
  assert.deepEqual(manifest.operations.map(item => readFileSync(join(process.env.USERPROFILE, '.aih/core', item.snapshot), 'utf8')), ['first bytes', 'second bytes']);
  assert.equal((await apply(prepared.prepared, approve(prepared), { logging: 'off' })).completion, 'rejected');
  const again = await prepare({ useCase: 'policy', policy: empty, target: { project } }, { logging: 'off' });
  assert.equal(again.review.operations.length, 1); assert.equal(again.review.operations[0].ownership, 'managed');
  assert.match(again.review.operations[0].details.target, /second\.txt$/);
  assert.equal((await apply(again.prepared, approve(again), { logging: 'off' })).completion, 'complete');
});

test('retained matching-unowned selection roots protect their owned dependencies without adopting bytes', async () => {
  const project = mkdtempSync(join(scratch, 'unowned-root-dependency-'));
  writeFileSync(join(project, 'root.txt'), 'unowned matching root');
  const dependency = { id: 'dependency', managementId: 'dependency', scope: 'project', configuration: {}, requires: [],
    recipe: { inline: recipe(op('file.write', 'project', 'dependency.txt', { content: { literal: 'owned dependency' } })) } };
  const rootSelection = { id: 'root', managementId: 'root', scope: 'project', configuration: {}, requires: ['dependency'],
    recipe: { inline: recipe(op('file.write', 'project', 'root.txt', { content: { literal: 'unowned matching root' } })) } };
  const document = { schema: policy(op('file.remove', 'project', 'unused')).schema, mode: 'vibe', selections: [dependency, rootSelection],
    managedSelections: [{ id: 'dependencies', scope: 'project', members: ['dependency'] }, { id: 'roots', scope: 'project', members: ['root'] }] };
  const first = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal(first.review.operations.find(item => item.id === 'root/member').ownership, 'unowned');
  assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
  const empty = { schema: document.schema, mode: 'vibe', selections: [], managedSelections: [{ id: 'dependencies', scope: 'project', members: [] }] };
  const retained = await prepare({ useCase: 'policy', policy: empty, target: { project } }, { logging: 'off' });
  assert.equal(retained.review.operations.length, 0);
  assert.equal((await apply(retained.prepared, approve(retained), { logging: 'off' })).completion, 'complete');
  assert.equal(readFileSync(join(project, 'dependency.txt'), 'utf8'), 'owned dependency');
  empty.managedSelections.push({ id: 'roots', scope: 'project', members: [] });
  const remove = await prepare({ useCase: 'policy', policy: empty, target: { project } }, { logging: 'off' });
  assert.equal((await apply(remove.prepared, approve(remove), { logging: 'off' })).completion, 'complete');
  assert.equal(existsSync(join(project, 'dependency.txt')), false);
  assert.equal(readFileSync(join(project, 'root.txt'), 'utf8'), 'unowned matching root');
});

test('cleanup preserves a managed block with an edited closing newline', async () => {
  const project = mkdtempSync(join(scratch, 'block-newline-drift-'));
  const block = op('text.block', 'project', 'notes.txt', { action: 'set', blockId: 'notes',
    startMarker: 'BEGIN-owned', endMarker: 'END-owned', content: { literal: 'owned' } });
  const document = policy(block);
  document.managedSelections = [{ id: 'notes', scope: 'project', members: ['stable-item'] }];
  const first = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
  const path = join(project, 'notes.txt');
  const edited = readFileSync(path, 'utf8').replace(/END-owned\n$/, 'END-owned\r\n');
  writeFileSync(path, edited);
  const empty = { schema: document.schema, mode: 'vibe', selections: [],
    managedSelections: [{ id: 'notes', scope: 'project', members: [] }] };
  const removal = await prepare({ useCase: 'policy', policy: empty, target: { project } }, { logging: 'off' });
  assert.equal(removal.status, 'blocked', JSON.stringify(removal.diagnostics));
  assert.equal(removal.review.operations[0].effects, 'conflict');
  assert.equal(readFileSync(path, 'utf8'), edited);
});

const chainPolicy = () => ({ schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe',
  selections: ['a', 'b', 'c'].map((id, index) => ({ id, managementId: id, scope: 'project', configuration: {},
    requires: index < 2 ? [['b'], ['c']][index] : [], recipe: { inline: recipe(op('file.write', 'project', `${id}.txt`, { content: { literal: id } })) } })),
  managedSelections: [{ id: 'chain', scope: 'project', members: ['a', 'b', 'c'] }] });

test('failed retaining-root update protects all transitive dependencies under partial cleanup', async () => {
  const project = mkdtempSync(join(scratch, 'transitive-update-')), document = chainPolicy();
  const initial = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal((await apply(initial.prepared, approve(initial), { logging: 'off' })).completion, 'complete');
  const rootSelection = document.selections[0]; rootSelection.requires = [];
  rootSelection.recipe.inline.operations[0].content.literal = 'updated a'; rootSelection.recipe.inline.operations[0].checks = ['required'];
  rootSelection.recipe.inline.checks = [{ id: 'required', purpose: 'Required update check', kind: 'file.sha256', target: target('project', 'a.txt'), sha256: '0'.repeat(64) }];
  document.selections = [rootSelection]; document.managedSelections[0].members = ['a'];
  const update = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  const result = await apply(update.prepared, { ...approve(update), allowPartial: true }, { logging: 'off' });
  assert.equal(result.completion, 'incomplete');
  assert.equal(readFileSync(join(project, 'b.txt'), 'utf8'), 'b');
  assert.equal(readFileSync(join(project, 'c.txt'), 'utf8'), 'c');
  assert.ok(result.operations.filter(item => item.id.startsWith('lifecycle/')).every(item => item.application === 'not-attempted'));
  const retry = await prepare({ useCase: 'policy', policy: { schema: document.schema, mode: 'vibe', selections: [], removals: [{ managementId: 'c', scope: 'project' }] }, target: { project } }, { logging: 'off' });
  assert.equal(retry.review.operations.length, 0);
});

test('blocked retaining-root removal preserves its transitive dependencies under partial cleanup', async () => {
  const project = mkdtempSync(join(scratch, 'transitive-remove-')), document = chainPolicy();
  const initial = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal((await apply(initial.prepared, approve(initial), { logging: 'off' })).completion, 'complete');
  writeFileSync(join(project, 'a.txt'), 'human edited a');
  const empty = { schema: document.schema, mode: 'vibe', selections: [], managedSelections: [{ id: 'chain', scope: 'project', members: [] }] };
  const cleanup = await prepare({ useCase: 'policy', policy: empty, target: { project } }, { logging: 'off' });
  assert.equal(cleanup.status, 'partial');
  const result = await apply(cleanup.prepared, { ...approve(cleanup), allowPartial: true }, { logging: 'off' });
  assert.equal(result.completion, 'incomplete');
  assert.equal(readFileSync(join(project, 'a.txt'), 'utf8'), 'human edited a');
  assert.equal(readFileSync(join(project, 'b.txt'), 'utf8'), 'b');
  assert.equal(readFileSync(join(project, 'c.txt'), 'utf8'), 'c');
  assert.ok(result.operations.every(item => item.application === 'not-attempted'));
});

test('distinct marker pairs cannot acquire overlapping nested block custody', async () => {
  const project = mkdtempSync(join(scratch, 'nested-block-custody-'));
  const innerText = '<!-- inner:start -->\ninner bytes\n<!-- inner:end -->\n';
  const outer = op('text.block', 'project', 'NOTES.md', { blockId: 'outer', startMarker: '<!-- outer:start -->',
    endMarker: '<!-- outer:end -->', action: 'set', content: { literal: innerText } });
  const first = await prepare(request(project, outer), { logging: 'off' });
  assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
  const inner = op('text.block', 'project', 'NOTES.md', { blockId: 'inner', startMarker: '<!-- inner:start -->',
    endMarker: '<!-- inner:end -->', action: 'set', content: { literal: 'inner bytes' } });
  const document = policy(inner); document.selections[0].id = 'inner'; document.selections[0].managementId = 'inner-owner';
  const before = readFileSync(join(project, 'NOTES.md'));
  const adopted = await prepare({ useCase: 'policy', policy: document, target: { project }, resolutions: [{ selectionId: 'inner',
    operationId: 'member', choice: 'adopt', observedSha256: createHash('sha256').update(before).digest('hex') }] }, { logging: 'off' });
  assert.equal(adopted.status, 'blocked', JSON.stringify(adopted));
  assert.equal(adopted.prepared, undefined);
  assert.deepEqual(readFileSync(join(project, 'NOTES.md')), before);
});


test('adjacent distinct marker blocks retain independent custody during cleanup', async () => {
  const project = mkdtempSync(join(scratch, 'adjacent-block-custody-'));
  const makeBlock = id => op('text.block', 'project', 'NOTES.md', { blockId: id, startMarker: `<!-- ${id}:start -->`,
    endMarker: `<!-- ${id}:end -->`, action: 'set', content: { literal: `${id} bytes` } });
  const first = await prepare(request(project, makeBlock('first')), { logging: 'off' });
  assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
  const secondDocument = policy(makeBlock('second')); secondDocument.selections[0].managementId = 'second-owner';
  const second = await prepare({ useCase: 'policy', policy: secondDocument, target: { project } }, { logging: 'off' });
  assert.equal(second.status, 'ready', JSON.stringify(second));
  assert.equal((await apply(second.prepared, approve(second), { logging: 'off' })).completion, 'complete');
  const cleanup = await prepare({ useCase: 'policy', policy: { schema: secondDocument.schema, mode: 'vibe', selections: [],
    removals: [{ managementId: 'stable-item', scope: 'project' }] }, target: { project } }, { logging: 'off' });
  assert.equal((await apply(cleanup.prepared, approve(cleanup), { logging: 'off' })).completion, 'complete');
  assert.equal(readFileSync(join(project, 'NOTES.md'), 'utf8'), '<!-- second:start -->\nsecond bytes\n<!-- second:end -->\n');
});

test('interrupted transitive cleanup publishes removed-root intent before dependent subtraction', { timeout: 60_000 }, async () => {
  const project = mkdtempSync(join(scratch, 'transitive-cancel-')), document = chainPolicy();
  const initial = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.equal((await apply(initial.prepared, approve(initial), { logging: 'off' })).completion, 'complete');
  const empty = { schema: document.schema, mode: 'vibe', selections: [], managedSelections: [{ id: 'chain', scope: 'project', members: [] }] };
  const cleanup = await prepare({ useCase: 'policy', policy: empty, target: { project } }, { logging: 'off' });
  const controller = new AbortController(); let finished = false;
  const abortAfterRoot = () => {
    if (finished) return;
    if (!existsSync(join(project, 'a.txt'))) controller.abort(); else setImmediate(abortAfterRoot);
  };
  const pending = apply(cleanup.prepared, approve(cleanup), { logging: 'off', signal: controller.signal }); setImmediate(abortAfterRoot);
  let result; try { result = await pending; } finally { finished = true; }
  assert.equal(result.completion, 'cancelled', JSON.stringify(result));
  assert.deepEqual(result.operations.map(item => item.application), ['applied', 'not-attempted', 'not-attempted']);
  assert.equal(readFileSync(join(project, 'b.txt'), 'utf8'), 'b'); assert.equal(readFileSync(join(project, 'c.txt'), 'utf8'), 'c');
  const manifest = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.aih/core', result.recovery), 'utf8'));
  assert.deepEqual(manifest.operations.map(item => readFileSync(join(process.env.USERPROFILE, '.aih/core', item.snapshot), 'utf8')), ['a', 'b', 'c']);
  assert.equal((await apply(cleanup.prepared, approve(cleanup), { logging: 'off' })).completion, 'rejected');
  const fresh = await prepare({ useCase: 'policy', policy: empty, target: { project } }, { logging: 'off' });
  assert.deepEqual(fresh.review.operations.map(item => item.details.target.split(/[\\/]/).at(-1)), ['b.txt', 'c.txt']);
  assert.equal((await apply(fresh.prepared, approve(fresh), { logging: 'off' })).completion, 'complete');
});


test('user state identity and retained custody use the canonical home across harmless path spellings', async () => {
  const canonicalHome = realpathSync.native(mkdtempSync(join(scratch, 'identity-home-'))), child = join(canonicalHome, 'identity-child'); mkdirSync(child);
  const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const project = mkdtempSync(join(scratch, 'canonical-user-home-'));
  try {
    process.env.HOME = child + '/..'; process.env.USERPROFILE = child + '/..';
    const document = policy(op('file.write', 'userState', 'asset.txt', { content: { literal: 'canonical user asset' } }));
    document.managedSelections = [{ id: 'user-assets', scope: 'user', members: ['stable-item'] }];
    const first = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
    assert.equal(first.status, 'ready', JSON.stringify(first));
    const key = createHash('sha256').update(`${canonicalHome}\0user\0stable-item`).digest('hex');
    assert.ok(first.review.operations[0].details.target.includes(key), first.review.operations[0].details.target);
    assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
    process.env.HOME = canonicalHome; process.env.USERPROFILE = canonicalHome;
    const repeat = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
    assert.equal(repeat.review.operations[0].details.target, first.review.operations[0].details.target);
    assert.equal(repeat.review.operations[0].ownership, 'managed');
    const empty = { schema: document.schema, mode: 'vibe', selections: [], managedSelections: [{ id: 'user-assets', scope: 'user', members: [] }] };
    const remove = await prepare({ useCase: 'policy', policy: empty, target: { project } }, { logging: 'off' });
    assert.equal(remove.review.operations.length, 1);
    assert.equal((await apply(remove.prepared, approve(remove), { logging: 'off' })).completion, 'complete');
    assert.equal(existsSync(first.review.operations[0].details.target), false);
  } finally { Object.assign(process.env, original); }
});
