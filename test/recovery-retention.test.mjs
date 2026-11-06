// Recovery data is kept only while something still needs it: a completed install drops its run's snapshots, and the
// removal that restores your original file drops the kept original, so your file's other values don't stay behind in
// Core's state. Through the built public entries in a disposable home and project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, prepare, prepareRemoval } from '../dist/core/engine-api.js';
import { changeRequest } from './fixtures/change-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-recovery-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home;
before(() => { home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const MARKER = 'SECRET-TOKEN-123';
const approve = (review, extra = {}) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...extra });
const files = dir => existsSync(dir) ? readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]) : [];
const setMode = { schema: 'urn:aihq:core:change:0.1.0', id: 'mode', description: 'Mode', inputs: {}, materials: [], targets: ['project'], prerequisites: [],
  operations: [{ id: 'set', purpose: 'Set mode', kind: 'config.entries', scope: 'project', format: 'json',
    target: { root: 'project', segments: [{ literal: 'settings.json' }] }, set: [{ path: ['mode'], value: 'b' }], requires: [], checks: [] }], checks: [] };

test('after a reviewed replace and its removal, none of your file\'s values stay in Core\'s state, and no recovery data is left', async () => {
  const project = join(scratch, 'project'); mkdirSync(project);
  const mine = JSON.stringify({ token: MARKER, mode: 'a' }, null, 2) + '\n';
  writeFileSync(join(project, 'settings.json'), mine);
  const request = changeRequest([{ managementId: 'mode', change: setMode }], { project });
  const blocked = await prepare(request);
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  const [conflict] = blocked.review.conflicts;
  const prepared = await prepare({ ...request, resolutions: [{ managementId: 'mode', step: conflict.step, choice: 'replace', observedSha256: conflict.observedSha256 }] });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  // A completed install keeps no snapshots of its own run.
  assert.equal(existsSync(join(home, '.aih', 'core', 'recovery', run.runId)), false);

  const removal = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: 'mode' }] });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  const removed = await apply(removal.handle, approve(removal.review));
  assert.equal(removed.completion, 'complete', JSON.stringify(removed));
  assert.equal(readFileSync(join(project, 'settings.json'), 'utf8'), mine);
  const state = join(home, '.aih', 'core');
  assert.deepEqual(files(state).filter(file => readFileSync(file, 'latin1').includes(MARKER)).map(file => file.slice(state.length)), []);
  assert.deepEqual(files(join(state, 'recovery')).map(file => file.slice(state.length)), []);
});

test('an incomplete install keeps its recovery data', async () => {
  const project = join(scratch, 'incomplete'); mkdirSync(project);
  const failing = { ...setMode, id: 'failing', operations: [{ ...setMode.operations[0], checks: ['gate'] }],
    checks: [{ id: 'gate', purpose: 'Gate', kind: 'process.exit', executable: { name: process.execPath }, args: [{ literal: '-e' }, { literal: 'process.exit(3)' }],
      cwd: { root: 'project', segments: [] }, env: {}, acceptedExitCodes: [0], timeoutMs: 20000, maxOutputBytes: 1024 }] };
  writeFileSync(join(project, 'other.json'), '{}\n');
  const prepared = await prepare(changeRequest([{ managementId: 'failing', change: failing }], { project }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.notEqual(run.completion, 'complete', JSON.stringify(run));
  assert.equal(existsSync(join(home, '.aih', 'core', 'recovery', run.runId)), true);

  // A week later: the interrupted run, which its receipt still names, keeps its snapshot; a failed run nothing names any
  // more, and one with no history at all, are swept by the next run.
  const recovery = join(home, '.aih', 'core', 'recovery');
  const unnamed = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  mkdirSync(join(home, '.aih', 'core', 'runs'), { recursive: true, mode: 0o700 });
  for (const id of unnamed) {
    mkdirSync(join(recovery, id), { mode: 0o700 }); writeFileSync(join(recovery, id, '0.bin'), MARKER, { mode: 0o600 });
  }
  writeFileSync(join(home, '.aih', 'core', 'runs', `${unnamed[0]}.json`), JSON.stringify({ completion: 'incomplete' }), { mode: 0o600 });
  const weekAgo = new Date(Date.now() - 8 * 86_400_000);
  for (const id of [run.runId, ...unnamed]) utimesSync(join(recovery, id), weekAgo, weekAgo);
  const later = join(scratch, 'later'); mkdirSync(later); writeFileSync(join(later, 'settings.json'), '{}\n');
  const next = await prepare(changeRequest([{ managementId: 'mode', change: setMode }], { project: later }));
  assert.equal((await apply(next.handle, approve(next.review))).completion, 'complete');
  assert.equal(existsSync(join(recovery, run.runId)), true, 'the interrupted run keeps its snapshot');
  for (const id of unnamed) assert.equal(existsSync(join(recovery, id)), false, `${id} is swept`);
});

test('a whole-file replace keeps your original only until the removal that restores it', async () => {
  const project = join(scratch, 'whole'); mkdirSync(project);
  const mine = JSON.stringify({ token: MARKER, mode: 'a' }) + '\n';
  writeFileSync(join(project, 'settings.json'), mine);
  const whole = { ...setMode, id: 'whole', operations: [{ id: 'w', purpose: 'Write', kind: 'file.write', scope: 'project',
    target: { root: 'project', segments: [{ literal: 'settings.json' }] }, content: { literal: '{"mode":"b"}\n' }, requires: [], checks: [] }] };
  const request = changeRequest([{ managementId: 'whole', change: whole }], { project });
  const blocked = await prepare(request);
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  const resolutions = blocked.review.conflicts.map(c => ({ managementId: 'whole', step: c.step, choice: 'replace', observedSha256: c.observedSha256 }));
  const prepared = await prepare({ ...request, resolutions });
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const originals = join(home, '.aih', 'core', 'recovery', 'originals');
  assert.ok(files(originals).some(file => readFileSync(file, 'latin1').includes(MARKER)), 'the original is kept while installed');
  const removal = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: 'whole' }] });
  assert.equal((await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.equal(readFileSync(join(project, 'settings.json'), 'utf8'), mine);
  assert.deepEqual(files(originals).filter(file => readFileSync(file, 'latin1').includes(MARKER)), [], 'the removal that restores it deletes it');
});

test('routine history keeps a bounded number of run records, dropping the oldest', async () => {
  const runs = join(home, '.aih', 'core', 'runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const old = new Date(Date.now() - 86_400_000);
  // Records as Core writes them (owner-only), except the oldest, which another tool left readable by others: one record
  // like that must not stop the rotation of the rest.
  for (let at = 0; at < 1000; at++) {
    const name = join(runs, `00000000-0000-4000-8000-${String(at).padStart(12, '0')}.json`);
    writeFileSync(name, '{}', { mode: at === 0 ? 0o644 : 0o600 }); chmodSync(name, at === 0 ? 0o644 : 0o600); utimesSync(name, old, old);
  }
  const project = join(scratch, 'history'); mkdirSync(project);
  writeFileSync(join(project, 'settings.json'), '{}\n');
  const prepared = await prepare(changeRequest([{ managementId: 'mode', change: setMode }], { project }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const names = readdirSync(runs);
  assert.ok(names.length <= 1000, `${names.length} run records`);
  assert.ok(names.includes(`${run.runId}.json`));
  assert.equal(names.includes('00000000-0000-4000-8000-000000000000.json'), false, 'the oldest goes first');
});

test('removing an incomplete install deletes its snapshots right away', async () => {
  const project = join(scratch, 'incomplete-removed'); mkdirSync(project);
  writeFileSync(join(project, 'settings.json'), JSON.stringify({ token: MARKER, mode: 'a' }) + '\n');
  const failing = { ...setMode, id: 'failing-removed', operations: [{ ...setMode.operations[0], checks: ['gate'] }],
    checks: [{ id: 'gate', purpose: 'Gate', kind: 'process.exit', executable: { name: process.execPath }, args: [{ literal: '-e' }, { literal: 'process.exit(3)' }],
      cwd: { root: 'project', segments: [] }, env: {}, acceptedExitCodes: [0], timeoutMs: 20000, maxOutputBytes: 1024 }] };
  const request = changeRequest([{ managementId: 'failing-removed', change: failing }], { project });
  const blocked = await prepare(request);
  const resolutions = (blocked.review?.conflicts ?? []).map(c => ({ managementId: 'failing-removed', step: c.step, choice: 'replace', observedSha256: c.observedSha256 }));
  const prepared = resolutions.length ? await prepare({ ...request, resolutions }) : blocked;
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.notEqual(run.completion, 'complete', JSON.stringify(run));
  const snapshots = join(home, '.aih', 'core', 'recovery', run.runId);
  assert.equal(existsSync(snapshots), true);
  const removal = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: 'failing-removed' }] });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  assert.equal((await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.equal(existsSync(snapshots), false, 'the removed install\'s snapshots go with it');
});

