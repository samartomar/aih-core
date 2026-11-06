// The engine's own path policy: every request kind refuses Git folders and 8.3 short names, and the review names the real target.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, prepare } from '../dist/core/engine-api.js';
import { changeRequest } from './fixtures/change-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-path-policy-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

let counter = 0;
function project() {
  const path = join(scratch, `p${counter++}`);
  mkdirSync(join(path, '.git', 'hooks'), { recursive: true }); mkdirSync(join(path, '.claude'));
  writeFileSync(join(path, '.claude', 'settings.json'), '{}\n');
  return path;
}
const writeTo = segments => ({ schema: 'urn:aihq:core:change:0.1.0', id: 'note', description: 'Write a note', inputs: {}, materials: [],
  targets: ['project'], prerequisites: [], operations: [{ id: 'w', purpose: 'Write a note', kind: 'file.write', scope: 'project',
    target: { root: 'project', segments: segments.map(literal => ({ literal })) }, content: { literal: 'note\n' }, requires: [], checks: [] }], checks: [] });

for (const [label, segments, landing] of [
  ['a Git folder', ['.git', 'x'], ['.git', 'x']],
  ['a Git folder in another case', ['.GIT', 'hooks', 'x'], ['.git', 'hooks', 'x']],
  ['a nested Git folder', ['sub', '.git', 'x'], ['sub', '.git', 'x']],
  ['a short-name alias of the Git folder', ['GIT~1', 'hooks', 'x'], ['.git', 'hooks', 'x']],
  ['a short-name alias of a settings folder', ['CLAUDE~1', 'settings.json'], ['.claude', 'settings.json']]
]) test(`a change request refuses ${label} and writes nothing`, async t => {
  const target = project();
  if (segments[0].includes('~') && !existsSync(join(target, segments[0]))) return t.skip('no 8.3 short names on this volume');
  const prepared = await prepare(changeRequest([{ managementId: 'note', change: writeTo(segments) }], { project: target }));
  assert.notEqual(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.handle, undefined);
  if (landing[0] === '.claude') assert.equal(JSON.stringify(prepared).includes('note\n'), false);
  else assert.equal(existsSync(join(target, ...landing)), false);
});

test('the review names the real folder an existing path resolves to', async () => {
  const target = project(); mkdirSync(join(target, 'Docs'));
  const prepared = await prepare(changeRequest([{ managementId: 'note', change: writeTo(['docs', 'note.md']) }], { project: target }));
  if (process.platform !== 'win32' && process.platform !== 'darwin') { assert.equal(prepared.status, 'ready'); return; }
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const step = prepared.review.steps.find(item => item.details?.target);
  assert.equal(step.details.target, join(target, 'Docs', 'note.md'));
  const run = await apply(prepared.handle, { approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
});
