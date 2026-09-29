import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, apply } from '../dist/index.js';
import { policy } from './fixture.mjs';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'aih-core-host-'));
const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => {
  const home = join(fixtureRoot, 'home'); mkdirSync(home);
  process.env.HOME = home; process.env.USERPROFILE = home;
});
after(() => {
  for (const [key, value] of Object.entries(originalHome)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});
function target() { return mkdtempSync(join(fixtureRoot, 'project-')); }
const authorize = p => ({ approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest });

test('a caller previews one file, approves that live work and receives applied but unverified', async () => {
  const project = target();
  const prepared = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready');
  assert.equal(existsSync(join(project, 'TEAM.md')), false);
  assert.equal(prepared.review.operations[0].details.content, "Read the project's contribution guide.\n");
  const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(result.completion, 'complete', JSON.stringify(result));
  assert.equal(result.operations[0].application, 'applied');
  assert.deepEqual(result.operations[0].verification, { status: 'unverified', reason: 'no-supplied-check' });
  assert.equal(readFileSync(join(project, 'TEAM.md'), 'utf8'), "Read the project's contribution guide.\n");
  assert.equal(result.authorization.origin, 'automation');
  assert.deepEqual(result.authorization.allowPartial, { value: false, origin: 'default' });
  assert.equal(result.record.status, 'disabled');
  assert.equal((await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' })).review.operations[0].ownership, 'managed');
});

test('missing approval, edited digest and serialized handles cannot authorize writes', async () => {
  const project = target();
  const p = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal((await apply(p.prepared, undefined, { logging: 'off' })).diagnostics[0].code, 'APPROVAL_REQUIRED');
  assert.equal((await apply(p.prepared, { ...authorize(p), reviewDigest: 'edited' }, { logging: 'off' })).diagnostics[0].code, 'REVIEW_STALE');
  assert.equal((await apply(JSON.parse(JSON.stringify(p.prepared)), authorize(p), { logging: 'off' })).diagnostics[0].code, 'REVIEW_STALE');
  assert.throws(() => { p.review.operations[0].details.content = 'changed'; }, TypeError);
  assert.equal(existsSync(join(project, 'TEAM.md')), false);
});

test('target drift and changed policy invalidate the reviewed work', async () => {
  for (const change of ['target', 'policy']) {
    const project = target(); const document = policy();
    const p = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
    if (change === 'target') writeFileSync(join(project, 'TEAM.md'), 'human content');
    else document.selections[0].configuration.text = 'edited after approval';
    const result = await apply(p.prepared, authorize(p), { logging: 'off' });
    assert.equal(result.completion, 'rejected');
    assert.equal(result.diagnostics[0].code, 'REVIEW_STALE');
    if (change === 'target') assert.equal(readFileSync(join(project, 'TEAM.md'), 'utf8'), 'human content');
    else assert.equal(existsSync(join(project, 'TEAM.md')), false);
  }
});

test('matching unowned content stays unowned and a different file stays a conflict', async () => {
  const project = target();
  writeFileSync(join(project, 'TEAM.md'), "Read the project's contribution guide.\n");
  const p = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal(p.review.operations[0].ownership, 'unowned');
  assert.equal((await apply(p.prepared, authorize(p), { logging: 'off' })).operations[0].application, 'already-satisfied');
  const again = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal(again.review.operations[0].ownership, 'unowned');
  writeFileSync(join(project, 'TEAM.md'), 'human edit');
  const conflict = await prepare({ useCase: 'policy', policy: policy(), target: { project } }, { logging: 'off' });
  assert.equal(conflict.status, 'blocked'); assert.equal(conflict.prepared, undefined);
});

test('private values never enter review digests as reusable hashes or completed history', async () => {
  const project = target(); const document = policy();
  document.selections[0].configuration = {};
  document.selections[0].recipe.inline.inputs.text.sensitive = true;
  const privateInputs = { guidance: { text: 'fixture-private-value' } };
  const p = await prepare({ useCase: 'policy', policy: document, target: { project } }, { privateInputs });
  assert.equal(p.status, 'ready'); assert.equal(p.record.status, 'written');
  assert.equal(JSON.stringify(p).includes('fixture-private-value'), false);
  const result = await apply(p.prepared, authorize(p));
  assert.equal(result.completion, 'complete'); assert.equal(result.record.status, 'written');
  assert.equal(readFileSync(join(project, 'TEAM.md'), 'utf8'), 'fixture-private-value');
  const record = readFileSync(join(process.env.USERPROFILE, '.aih/core', result.record.reference), 'utf8');
  assert.equal(record.includes('fixture-private-value'), false);
  assert.equal(JSON.parse(record).operations[0].application, 'applied');
  assert.equal((await apply(p.prepared, authorize(p), { logging: 'off' })).completion, 'rejected');
});

test('private inputs are declared data, and pre-cancelled or malformed work changes no target', async () => {
  const project = target(); const request = { useCase: 'policy', policy: policy(), target: { project } };
  assert.equal((await prepare(request, { logging: 'off', privateInputs: { guidance: { undeclared: 'secret' } } })).status, 'invalid');
  const controller = new AbortController(); controller.abort();
  assert.equal((await prepare(request, { logging: 'off', signal: controller.signal })).status, 'cancelled');
  const p = await prepare(request, { logging: 'off' });
  assert.equal((await apply(p.prepared, authorize(p), { logging: 'off', signal: controller.signal })).completion, 'cancelled');
  request.policy.selections[0].requires = ['guidance'];
  assert.equal((await prepare(request, { logging: 'off' })).status, 'invalid');
  assert.equal(existsSync(join(project, 'TEAM.md')), false);
});

test('replaced parent directories and linked target paths cannot reuse approval', async () => {
  const project = target(); const dir = join(project, 'docs'); mkdirSync(dir);
  const document = policy(); document.selections[0].recipe.inline.operations[0].target.segments.unshift({ literal: 'docs' });
  const p = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  renameSync(dir, join(project, 'old-docs')); mkdirSync(dir);
  assert.equal((await apply(p.prepared, authorize(p), { logging: 'off' })).diagnostics[0].code, 'REVIEW_STALE');
  rmSync(dir, { recursive: true });
  const external = target(); symlinkSync(external, dir, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'off' });
  assert.notEqual(linked.status, 'ready'); assert.equal(linked.prepared, undefined);
  assert.equal(existsSync(join(external, 'TEAM.md')), false);
});

test('history failures are reported without pretending already-satisfied work failed', async () => {
  const project = target(); writeFileSync(join(project, 'TEAM.md'), "Read the project's contribution guide.\n");
  const home = join(fixtureRoot, 'blocked-history-home'); mkdirSync(home);
  writeFileSync(join(home, '.aih'), 'not a directory');
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const p = await prepare({ useCase: 'policy', policy: policy(), target: { project } });
    assert.equal(p.status, 'ready'); assert.equal(p.record.status, 'failed');
    assert.ok(p.diagnostics.some(d => d.reason === 'record-write'));
    const result = await apply(p.prepared, authorize(p));
    assert.equal(result.completion, 'complete'); assert.equal(result.record.status, 'failed');
    assert.ok(result.diagnostics.some(d => d.reason === 'record-write'));
  } finally { Object.assign(process.env, previous); }
});
