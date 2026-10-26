import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { apply, listManagedSelections, prepare } from '../dist/core/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'aih-interrupted-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const sha256 = value => createHash('sha256').update(value).digest('hex');
const FILES = { 'SKILL.md': 'Take notes.\n', LICENSE: 'MIT\n', 'reference.md': 'Reference.\n' };
const literal = value => ({ literal: value });
const file = (id, name, requires, checks = []) => ({ id, purpose: `Write ${name}`, kind: 'file.write', scope: 'project',
  target: { root: 'project', segments: [literal('notes'), literal(name)] }, content: literal(FILES[name]), requires, checks });
/** A described selection of three files; `fail` makes the check after LICENSE fail, so Apply stops before reference.md. */
const policy = fail => ({ schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections: [{ id: 'notes', managementId: 'notes-managed',
  scope: 'project', configuration: {}, requires: [], recipe: { inline: { schema: 'urn:aihq:core:recipe:1.0.0', id: 'notes', description: 'Notes',
    inputs: {}, materials: [], targets: ['project'], prerequisites: [], operations: [file('skill', 'SKILL.md', []),
      file('licence', 'LICENSE', ['skill'], ['gate']), file('reference', 'reference.md', ['licence'])],
    checks: [{ id: 'gate', purpose: 'Gate', kind: 'process.exit', executable: { name: process.execPath }, args: [literal('-e'), literal(`process.exit(${fail ? 5 : 0})`)],
      cwd: { root: 'project', segments: [] }, env: {}, acceptedExitCodes: [0], timeoutMs: 20000, maxOutputBytes: 1024 }] } },
  item: { framework: 'f', itemId: 'notes', contentSha256: sha256('c'), behaviourSha256: sha256('b') }, tool: 'claude', name: 'Notes', kind: 'skill',
  origins: [{ reasonIncluded: 'chosen' }] }] });
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
async function install(project, fail = false) {
  const prepared = await prepare({ useCase: 'policy', policy: policy(fail), target: { project } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  return { prepared, result: await apply(prepared.prepared, approve(prepared.review), { logging: 'off' }) };
}
const state = () => join(process.env.HOME, '.aih', 'core');
const receiptPath = project => join(state(), 'ownership', `${sha256(project)}.json`);
const readReceipt = project => JSON.parse(readFileSync(receiptPath(project), 'utf8'));
const row = async project => (await listManagedSelections({ target: { project }, scope: 'project', format: 'urn:aihq:core:managed-inventory-result:1.1.0' }))
  .selections.find(entry => entry.managementId === 'notes-managed');
const project = name => { const path = join(scratch, name); mkdirSync(path); return realpathSync.native(path); };

test('a crash between a file effect and its custody is settled from the target: written members count, anything else does not', async () => {
  // The custody reference.md would publish, taken from a completed install of the same selection elsewhere.
  const reference = project('reference');
  assert.equal((await install(reference)).result.completion, 'complete');
  const owner = readReceipt(reference).members['notes/reference.md'];
  assert.ok(owner?.claims?.length);

  for (const [name, bytes, written] of [['written', FILES['reference.md'], true], ['absent', null, false], ['different', 'Mine.\n', false]]) {
    const target = project(name);
    const { result } = await install(target, true);
    assert.equal(result.completion, 'incomplete');
    // Plant what a crash right after reference.md's commit leaves: the write-ahead entry, and the target as found.
    const receipt = readReceipt(target);
    const id = Object.keys(receipt.items)[0];
    assert.equal(receipt.items[id].installState, 'interrupted');
    assert.equal(receipt.items[id].pending, undefined, 'a completed effect leaves no pending member');
    receipt.items[id].pending = [{ key: 'notes/reference.md', descriptor: owner.descriptor, owner }];
    writeFileSync(receiptPath(target), JSON.stringify(receipt));
    if (bytes !== null) writeFileSync(join(target, 'notes', 'reference.md'), bytes);

    const listed = await row(target);
    assert.equal(listed.installState, 'interrupted');
    assert.deepEqual(listed.members.map(member => basename(member.path)),
      written ? ['LICENSE', 'SKILL.md', 'reference.md'] : ['LICENSE', 'SKILL.md'], name);
    assert.ok(listed.members.every(member => member.fileState === 'matches'));

    const finish = await prepare({ useCase: 'policy', policy: policy(false), target: { project: target } }, { logging: 'off' });
    const effect = finish.review.operations.find(operation => operation.id === 'notes/reference').effects;
    assert.equal(effect, written ? 'already-satisfied' : bytes === null ? 'create-file' : 'conflict', name);
    if (bytes !== null && !written) {
      assert.equal(finish.status, 'partial');
      assert.equal(readFileSync(join(target, 'notes', 'reference.md'), 'utf8'), 'Mine.\n');
      continue;
    }
    const finished = await apply(finish.prepared, approve(finish.review), { logging: 'off' });
    assert.equal(finished.completion, 'complete', JSON.stringify(finished.diagnostics));
    const done = readReceipt(target);
    assert.deepEqual(Object.keys(done.members).sort(), ['notes/LICENSE', 'notes/SKILL.md', 'notes/reference.md']);
    assert.equal(done.items[id].installState, undefined);
    assert.equal(done.items[id].pending, undefined);
    assert.equal((await row(target)).installState, 'complete');
  }
});

test('a pending owner must belong to its item, or the receipt is not trusted', async () => {
  const target = project('foreign');
  await install(target, true);
  const receipt = readReceipt(target);
  const id = Object.keys(receipt.items)[0];
  const owner = { ...receipt.members['notes/SKILL.md'], claims: [{ managementId: 'other', scope: 'project', sets: [], requires: [] }] };
  receipt.items[id].pending = [{ key: 'notes/SKILL.md', descriptor: owner.descriptor, owner }];
  writeFileSync(receiptPath(target), JSON.stringify(receipt));
  const listed = await listManagedSelections({ target: { project: target }, scope: 'project', format: 'urn:aihq:core:managed-inventory-result:1.1.0' });
  assert.equal(listed.status, 'incomplete');
  assert.equal(listed.diagnostics[0].reason, 'ownership-unverifiable');
});

test('an undescribed selection keeps its earlier receipt format once complete', async () => {
  const target = project('undescribed');
  const { item: _item, tool: _tool, name: _name, kind: _kind, origins: _origins, ...bare } = policy(false).selections[0];
  const document = { ...policy(false), schema: 'urn:aihq:core:execution-policy:1.3.0', selections: [bare] };
  const prepared = await prepare({ useCase: 'policy', policy: document, target: { project: target } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal((await apply(prepared.prepared, approve(prepared.review), { logging: 'off' })).completion, 'complete');
  const receipt = readReceipt(target);
  assert.equal(receipt.items, undefined);
  assert.notEqual(receipt.schema, 'urn:aihq:core:ownership:1.6.0');
});

test('a lock left by a process that no longer runs on this host is reclaimed; any other lock is kept', async () => {
  const target = project('locks');
  const lock = join(state(), `lock-${sha256(target)}`);
  mkdirSync(state(), { recursive: true, mode: 0o700 });
  const ended = spawnSync(process.execPath, ['-e', '0']).pid;
  for (const [holder, reclaimed] of [[{ pid: ended, host: hostname() }, true], [{ pid: process.ppid, host: hostname() }, false],
    [{ pid: ended, host: `${hostname()}-elsewhere` }, false], [null, false]]) {
    rmSync(join(target, 'notes'), { recursive: true, force: true });
    mkdirSync(lock, { mode: 0o700 });
    if (holder) writeFileSync(join(lock, 'holder.json'), JSON.stringify(holder), { mode: 0o600 });
    const prepared = await prepare({ useCase: 'policy', policy: policy(false), target: { project: target } }, { logging: 'off' });
    const result = await apply(prepared.prepared, approve(prepared.review), { logging: 'off' });
    assert.equal(result.completion === 'complete', reclaimed, JSON.stringify([holder, result.completion, result.diagnostics]));
    assert.equal(existsSync(lock), !reclaimed, 'a reclaimed lock is released after the run; a kept lock stays');
    if (!reclaimed) { rmSync(join(lock, 'holder.json'), { force: true }); rmdirSync(lock); }
    else {
      const removal = await prepare({ useCase: 'policy', policy: { schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections: [],
        removals: [{ managementId: 'notes-managed', scope: 'project' }] }, target: { project: target } }, { logging: 'off' });
      assert.equal((await apply(removal.prepared, approve(removal.review), { logging: 'off' })).completion, 'complete');
    }
  }
});
