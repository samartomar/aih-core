import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepare, apply } from '../dist/index.js';

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
  assert.equal((await apply(first.prepared, approve(first), { logging: 'off' })).completion, 'complete');
  const remove = op('file.remove', 'project', 'owned.txt');
  const second = await prepare(request(project, remove), { logging: 'off' });
  assert.equal(second.review.operations[0].effects, 'remove-file', JSON.stringify(second.diagnostics));
  const result = await apply(second.prepared, approve(second), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result));
  assert.equal(existsSync(join(project, 'owned.txt')), false);
  const manifest = JSON.parse(readFileSync(join(process.env.USERPROFILE, '.aih/core', result.recovery), 'utf8'));
  assert.equal(manifest.operations[0].root, project);
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
