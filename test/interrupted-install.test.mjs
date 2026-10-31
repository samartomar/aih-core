// Built-artifact coverage for what no public entry can reach deterministically: the instant between a file effect
// and its custody write. The packed consumer test proves the public behaviour; these tests plant that crash state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { apply, listManagedSelections, prepare, prepareManagedRemoval } from '../dist/core/index.js';
import { readReceipt as storedRecord, recordOf, receiptText } from './fixtures/ownership-receipt.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-interrupted-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const sha256 = value => createHash('sha256').update(value).digest('hex');
/** A receipt's member key for a file: Windows paths are case-insensitive, so Core keys them in lower case there. */
const keyOf = path => process.platform === 'win32' ? path.toLowerCase() : path;
const FILES = { 'SKILL.md': 'Take notes.\n', LICENSE: 'MIT\n', 'reference.md': 'Reference.\n' };
const literal = value => ({ literal: value });
const file = (id, name, requires, checks, root) => ({ id, purpose: `Write ${name}`, kind: 'file.write', scope: root === 'project' ? 'project' : 'user',
  target: { root, segments: [literal('notes'), literal(name)] }, content: literal(FILES[name]), requires, checks });
/**
 * A described selection of three files under `root` (`project`, or the user-scope Core content root `userState`);
 * `fail` makes the check after LICENSE fail, so Apply stops before reference.md.
 */
const policy = (fail, root = 'project') => ({ schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections: [{ id: 'notes', managementId: 'notes-managed',
  scope: root === 'project' ? 'project' : 'user', configuration: {}, requires: [], recipe: { inline: { schema: 'urn:aihq:core:recipe:1.0.0', id: 'notes', description: 'Notes',
    inputs: {}, materials: [], targets: [root === 'project' ? 'project' : 'user'], prerequisites: [], operations: [file('skill', 'SKILL.md', [], [], root),
      file('licence', 'LICENSE', ['skill'], ['gate'], root), file('reference', 'reference.md', ['licence'], [], root)],
    checks: [{ id: 'gate', purpose: 'Gate', kind: 'process.exit', executable: { name: process.execPath }, args: [literal('-e'), literal(`process.exit(${fail ? 5 : 0})`)],
      cwd: { root: 'project', segments: [] }, env: {}, acceptedExitCodes: [0], timeoutMs: 20000, maxOutputBytes: 1024 }] } },
  item: { framework: 'f', itemId: 'notes', contentSha256: sha256('c'), behaviourSha256: sha256('b') }, tool: 'claude', name: 'Notes', kind: 'skill',
  origins: [{ reasonIncluded: 'chosen' }] }] });
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
async function install(project, fail = false, root = 'project') {
  const prepared = await prepare({ useCase: 'policy', policy: policy(fail, root), target: { project } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  return { prepared, result: await apply(prepared.prepared, approve(prepared.review), { logging: 'off' }) };
}
const state = () => join(process.env.HOME, '.aih', 'core');
const receiptPath = project => join(state(), 'ownership', `${sha256(project)}.json`);
const readReceipt = project => storedRecord(receiptPath(project));
const row = async (project, scope = 'project') => (await listManagedSelections({ target: { project }, scope, format: 'urn:aihq:core:managed-inventory-result:1.1.0' }))
  .selections.find(entry => entry.managementId === 'notes-managed');
const identity = path => { const stats = lstatSync(path, { bigint: true }); return `${stats.dev}:${stats.ino}`; };
/** Plant what a crash right after reference.md's commit leaves: its write-ahead entry naming the published file. */
function plant(receiptFile, owner, fileIdentity) {
  const receipt = recordOf(readFileSync(receiptFile, 'utf8'));
  const id = Object.keys(receipt.items)[0];
  assert.equal(receipt.items[id].installState, 'interrupted');
  assert.equal(receipt.items[id].pending, undefined, 'a completed effect leaves no pending member');
  receipt.items[id].pending = [{ key: 'notes/reference.md', descriptor: owner.descriptor, owner, identity: fileIdentity }];
  writeFileSync(receiptFile, receiptText(receipt));
  return id;
}
const project = name => { const path = join(scratch, name); mkdirSync(path); return realpathSync.native(path); };

test('a crash between a file effect and its custody is settled from the target: written members count, anything else does not', async () => {
  // The custody reference.md would publish, taken from a completed install of the same selection elsewhere.
  const reference = project('reference');
  assert.equal((await install(reference)).result.completion, 'complete');
  const owner = readReceipt(reference).members['notes/reference.md'];
  assert.ok(owner?.claims?.length);

  // `written`: the effect published the file; `absent`: it never did; `different`: the person's bytes are there;
  // `copied`: the file was absent when first read and the person later wrote the same bytes, which never counts.
  for (const [name, bytes, written] of [['written', FILES['reference.md'], true], ['absent', null, false], ['different', 'Mine.\n', false],
    ['copied', FILES['reference.md'], false]]) {
    const target = project(name);
    const { result } = await install(target, true);
    assert.equal(result.completion, 'incomplete');
    const path = join(target, 'notes', 'reference.md');
    if (name === 'written') writeFileSync(path, bytes);
    const id = plant(receiptPath(target), owner, name === 'written' ? identity(path) : '1:1');
    if (name === 'copied') assert.deepEqual((await row(target)).members.map(member => basename(member.path)), ['LICENSE', 'SKILL.md']);
    if (bytes !== null && name !== 'written') writeFileSync(path, bytes);

    const listed = await row(target);
    assert.equal(listed.installState, 'interrupted');
    assert.deepEqual(listed.members.map(member => basename(member.path)),
      written ? ['LICENSE', 'SKILL.md', 'reference.md'] : ['LICENSE', 'SKILL.md'], name);
    assert.ok(listed.members.every(member => member.fileState === 'matches'));

    const finish = await prepare({ useCase: 'policy', policy: policy(false), target: { project: target } }, { logging: 'off' });
    const effect = finish.review.operations.find(operation => operation.id === 'notes/reference').effects;
    assert.equal(effect, written ? 'already-satisfied' : bytes === null ? 'create-file' : name === 'copied' ? 'already-satisfied' : 'conflict', name);
    if (name === 'different') {
      assert.equal(finish.status, 'partial');
      assert.equal(readFileSync(path, 'utf8'), 'Mine.\n');
      continue;
    }
    const finished = await apply(finish.prepared, approve(finish.review), { logging: 'off' });
    assert.equal(finished.completion, 'complete', JSON.stringify(finished.diagnostics));
    const done = readReceipt(target);
    // The person's copy stays theirs: matching unowned bytes are never adopted without a reviewed adoption.
    assert.deepEqual(Object.keys(done.members).sort(), (name === 'copied' ? ['notes/LICENSE', 'notes/SKILL.md'] : ['notes/LICENSE', 'notes/SKILL.md', 'notes/reference.md']).map(keyOf).sort());
    assert.equal(done.items[id].installState, undefined);
    assert.equal(done.items[id].pending, undefined);
    assert.equal((await row(target)).installState, 'complete');
  }
});

test('an interrupted user-scope install in Core content is found, settled, finished and removed', async () => {
  const target = project('user-scope');
  const ownership = join(state(), 'ownership');
  const before = new Set(existsSync(ownership) ? readdirSync(ownership) : []);
  const { result } = await install(target, true, 'userState');
  assert.equal(result.completion, 'incomplete');
  const receiptFile = readdirSync(ownership).filter(name => !before.has(name) && /^[a-f0-9]{64}\.json$/.test(name))
    .map(name => join(ownership, name)).find(file => recordOf(readFileSync(file, 'utf8')).items);
  const content = JSON.parse(readFileSync(receiptFile, 'utf8')).target;
  assert.match(content, /content[\\/][a-f0-9]{64}$/);
  const listed = await row(target, 'user');
  assert.deepEqual([listed.installState, listed.members.map(member => basename(member.path))], ['interrupted', ['LICENSE', 'SKILL.md']]);
  // A crash right after reference.md was published in the content root: its custody is SKILL.md's, for that file.
  const skill = recordOf(readFileSync(receiptFile, 'utf8')).members[keyOf('notes/SKILL.md')];
  const owner = { ...skill, sha256: sha256(FILES['reference.md']), descriptor: { ...skill.descriptor, path: 'notes/reference.md' } };
  const path = join(content, 'notes', 'reference.md');
  writeFileSync(path, FILES['reference.md'], { mode: 0o600 });
  plant(receiptFile, owner, identity(path));
  assert.deepEqual((await row(target, 'user')).members.map(member => [basename(member.path), member.fileState]),
    [['LICENSE', 'matches'], ['SKILL.md', 'matches'], ['reference.md', 'matches']]);
  const finish = await prepare({ useCase: 'policy', policy: policy(false, 'userState'), target: { project: target } }, { logging: 'off' });
  assert.equal(finish.review.operations.find(operation => operation.id === 'notes/reference').effects, 'already-satisfied');
  assert.equal((await apply(finish.prepared, approve(finish.review), { logging: 'off' })).completion, 'complete');
  assert.equal((await row(target, 'user')).installState, 'complete');
  const removal = await prepareManagedRemoval({ target: { project: target }, managementId: 'notes-managed', scope: 'user', mode: 'vibe' }, { logging: 'off' });
  assert.equal(removal.preparation.status, 'ready', JSON.stringify(removal.preparation.diagnostics));
  assert.equal((await apply(removal.preparation.prepared, approve(removal.preparation.review), { logging: 'off' })).completion, 'complete');
  assert.equal(await row(target, 'user'), undefined);
  for (const name of Object.keys(FILES)) assert.equal(existsSync(join(content, 'notes', name)), false, name);
});

test('a pending owner must belong to its item, or the receipt is not trusted', async () => {
  const target = project('foreign');
  await install(target, true);
  const receipt = readReceipt(target);
  const id = Object.keys(receipt.items)[0];
  const owner = { ...receipt.members[keyOf('notes/SKILL.md')], claims: [{ managementId: 'other', scope: 'project', sets: [], requires: [] }] };
  receipt.items[id].pending = [{ key: 'notes/SKILL.md', descriptor: owner.descriptor, owner }];
  writeFileSync(receiptPath(target), receiptText(receipt));
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
  // The last case: another reclaimer holds the guard, so this run neither waits for nor races it.
  for (const [holder, reclaimed, guarded] of [[{ pid: ended, host: hostname() }, true], [{ pid: process.ppid, host: hostname() }, false],
    [{ pid: ended, host: `${hostname()}-elsewhere` }, false], [null, false], [{ pid: ended, host: hostname() }, false, true]]) {
    rmSync(join(target, 'notes'), { recursive: true, force: true });
    mkdirSync(lock, { mode: 0o700 });
    if (guarded) mkdirSync(`${lock}.reclaim`, { mode: 0o700 });
    if (holder) writeFileSync(join(lock, 'holder.json'), JSON.stringify(holder), { mode: 0o600 });
    const prepared = await prepare({ useCase: 'policy', policy: policy(false), target: { project: target } }, { logging: 'off' });
    const result = await apply(prepared.prepared, approve(prepared.review), { logging: 'off' });
    assert.equal(result.completion === 'complete', reclaimed, JSON.stringify([holder, result.completion, result.diagnostics]));
    assert.equal(existsSync(lock), !reclaimed, 'a reclaimed lock is released after the run; a kept lock stays');
    if (guarded) rmdirSync(`${lock}.reclaim`);
    if (!reclaimed) { rmSync(join(lock, 'holder.json'), { force: true }); rmdirSync(lock); }
    else {
      const removal = await prepare({ useCase: 'policy', policy: { schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections: [],
        removals: [{ managementId: 'notes-managed', scope: 'project' }] }, target: { project: target } }, { logging: 'off' });
      assert.equal((await apply(removal.prepared, approve(removal.review), { logging: 'off' })).completion, 'complete');
    }
  }
});

test('the identity a write announces before publishing is the published file\'s', async () => {
  const { OwnedFileTransaction } = await import('../dist/core/internal/owned-file-transaction.js');
  const root = project('staged');
  const tx = new OwnedFileTransaction(root, { label: 'test', maxFileBytes: 1024, contentDirectoryMode: 0o700, stateDirectoryMode: 0o700,
    statePaths: new Set(), assertOwnedPath() {}, assertResolvedSegments() {} });
  for (const expect of [{ absent: true }, { sha256: sha256('one') }]) {
    const announced = [];
    tx.commit([{ action: 'write', path: 'file.txt', mode: 0o600, contents: Buffer.from(expect.absent ? 'one' : 'two'), expect,
      ...(expect.absent ? {} : { prior: Buffer.from('one') }) }],
      (path, staged) => { announced.push([path, staged, existsSync(join(root, 'file.txt')) && readFileSync(join(root, 'file.txt'), 'utf8')]); });
    assert.deepEqual(announced, [['file.txt', identity(join(root, 'file.txt')), expect.absent ? false : 'one']], 'announced before the destination changed');
  }
  // A throwing announcement leaves the destination untouched.
  assert.throws(() => tx.commit([{ action: 'write', path: 'file.txt', mode: 0o600, contents: Buffer.from('three'), expect: { sha256: sha256('two') }, prior: Buffer.from('two') }],
    () => { throw new Error('write-ahead failed'); }));
  assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'two');
  assert.deepEqual(readdirSync(root), ['file.txt']);
});

test('a run whose process ran is incomplete, not rejected, when a later step stops it', async () => {
  const target = project('process-then-stale');
  writeFileSync(join(target, 'kept.txt'), 'same\n');
  // The process changes a file the next, already-satisfied step reviewed, so that step finds its review stale.
  const document = { schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections: [{ id: 'run', managementId: 'run-managed', scope: 'project',
    configuration: {}, requires: [], recipe: { inline: { schema: 'urn:aihq:core:recipe:1.0.0', id: 'run', description: 'Run', inputs: {}, materials: [],
      targets: ['project'], prerequisites: [], checks: [], operations: [
        { id: 'touch', purpose: 'Change a file', kind: 'process.run', scope: 'project', requires: [], checks: [], executable: { name: process.execPath },
          args: [literal('-e'), literal("require('node:fs').writeFileSync('kept.txt', 'changed\\n')")], cwd: { root: 'project', segments: [] }, env: {},
          timeoutMs: 20000, maxOutputBytes: 1024, acceptedExitCodes: [0], effects: ['Changes kept.txt'] },
        { id: 'kept', purpose: 'Keep a file', kind: 'file.write', scope: 'project', requires: ['touch'], checks: [],
          target: { root: 'project', segments: [literal('kept.txt')] }, content: literal('same\n') }] } } }] };
  const prepared = await prepare({ useCase: 'policy', policy: document, target: { project: target } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal(prepared.review.operations.find(operation => operation.id === 'run/kept').effects, 'already-satisfied');
  const result = await apply(prepared.prepared, approve(prepared.review), { logging: 'off' });
  assert.equal(result.operations[0].application, 'applied');
  assert.equal(result.completion, 'incomplete', JSON.stringify(result.diagnostics));
  assert.equal(readFileSync(join(target, 'kept.txt'), 'utf8'), 'changed\n');
});
