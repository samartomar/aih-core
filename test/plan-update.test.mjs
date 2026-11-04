// Updates from explicit new requests (contract 12, C39, C52, C58; journey 8) through the built public entries in a
// disposable home and projects. Producer documents are Core-side fixtures (test/fixtures/plan-fixture.mjs and the
// `@aihq/catalog/reader` FIXTURE), not Catalog output; the junctions made here prove Core's placement only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { apply, list, prepare, prepareUpdate } from '../dist/core/index.js';
import { linkRequest, mergeRequest, ownRequest, renderRequest } from './fixtures/plan-fixture.mjs';
import { changeRequest, projectSetting } from './fixtures/change-fixture.mjs';
import * as reader from './fixtures/catalog-node-fixture/reader.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-update-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home;
before(() => { home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const approve = (review, allowPartial) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...(allowPartial ? { allowPartial: true } : {}) });
let counter = 0;
const project = () => { const path = join(scratch, `project-${counter++}`); mkdirSync(path); return path; };
const catalog = { version: reader.FIXTURE_VERSION, renderStep: reader.renderStep, planRecipe: reader.planRecipe };
async function install(request, controls) {
  const prepared = await prepare(request, controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = await apply(prepared.handle, approve(prepared.review), controls);
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  return run;
}
const ID = name => `local-my-skills.skill.${name}`;
const entryOf = (result, name) => result.entries.find(entry => entry.managementId === ID(name));
const actions = entry => entry.members.map(member => [member.path.replaceAll('\\', '/').split('/').slice(-3).join('/'), member.action]);

test('an own-content update adds, replaces and removes members, keeps your edit, and names its targets', async () => {
  const where = project();
  const v1 = { a: { 'SKILL.md': 'A1\n' }, b: { 'SKILL.md': 'B1\n', 'notes.md': 'Notes\n' }, c: { 'SKILL.md': 'C1\n' }, e: { 'SKILL.md': 'E1\n' } };
  await install(ownRequest(where, v1, ['claude-code']));
  writeFileSync(join(where, '.claude/skills/c/SKILL.md'), 'C, as you edited it\n');
  const v2 = ownRequest(where, { a: { 'SKILL.md': 'A2\n' }, b: { 'SKILL.md': 'B1\n' }, c: { 'SKILL.md': 'C2\n' }, d: { 'SKILL.md': 'D1\n' } }, ['claude-code']);

  // An unproven plan names the receipts it replaces (C52); a plan item installed here but not named is refused too.
  const unnamed = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ request: v2 }] });
  assert.equal(unnamed.status, 'refused'); assert.equal(unnamed.code, 'update-target-required', JSON.stringify(unnamed));
  const partly = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ managementIds: [ID('a')], request: v2 }] });
  assert.equal(partly.code, 'update-target-required'); assert.match(partly.reason, /skill\.b/);

  const targets = ['a', 'b', 'c', 'e', 'z'].map(ID);
  const result = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ managementIds: targets, request: v2 }] });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.review.request, 'update');
  assert.deepEqual(result.entries.map(entry => [entry.managementId, entry.disposition, entry.change ?? null, entry.status ?? null]), [
    [ID('a'), 'prepared', 'update', 'ready'], [ID('b'), 'prepared', 'update', 'ready'], [ID('c'), 'prepared', 'update', 'partial'],
    [ID('d'), 'prepared', 'add', 'ready'], [ID('e'), 'prepared', 'remove', 'ready'], [ID('z'), 'absent', null, null]]);
  assert.deepEqual(actions(entryOf(result, 'a')), [['skills/a/SKILL.md', 'replace']]);
  assert.deepEqual(actions(entryOf(result, 'b')), [['skills/b/SKILL.md', 'unchanged'], ['skills/b/notes.md', 'remove']]);
  assert.deepEqual(actions(entryOf(result, 'c')), [['skills/c/SKILL.md', 'keep-changed']]);
  assert.deepEqual(actions(entryOf(result, 'd')), [['skills/d/SKILL.md', 'add']]);
  assert.deepEqual(actions(entryOf(result, 'e')), [['skills/e/SKILL.md', 'remove']]);
  assert.equal(entryOf(result, 'e').note, 'removed from the plan');
  const kept = result.review.conflicts.find(conflict => conflict.managementId === ID('c'));
  assert.equal(kept.reason, 'managed-content-changed'); assert.deepEqual(kept.choices, [], 'your edit is never replaceable');
  assert.ok(result.review.steps.some(step => step.op === 'remove' && step.path === '.claude/skills/e/SKILL.md' && step.effect === 'remove-file'), JSON.stringify(result.review.steps));

  // Leaving your edit out needs explicit partial approval.
  const refused = await apply(result.handle, approve(result.review));
  assert.equal(refused.completion, 'rejected');
  const again = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ managementIds: targets, request: v2 }] });
  const run = await apply(again.handle, approve(again.review, true));
  assert.equal(run.completion, 'incomplete', 'the kept edit is left out');
  const read = path => readFileSync(join(where, '.claude/skills', path), 'utf8');
  assert.equal(read('a/SKILL.md'), 'A2\n'); assert.equal(read('b/SKILL.md'), 'B1\n'); assert.equal(read('d/SKILL.md'), 'D1\n');
  assert.equal(read('c/SKILL.md'), 'C, as you edited it\n', 'your edit is kept');
  assert.equal(existsSync(join(where, '.claude/skills/b/notes.md')), false);
  assert.equal(existsSync(join(where, '.claude/skills/e')), false, 'the dropped item and the folder Core made for it go');
  const listed = await list({ target: { project: where }, scope: 'project' });
  assert.deepEqual(listed.entries.map(entry => entry.managementId).sort(), ['a', 'b', 'c', 'd'].map(ID));
  assert.equal(listed.entries.find(entry => entry.managementId === ID('c')).members[0].state, 'changed-by-you');
});

test('a review goes stale when a member it replaces changes before Apply', async () => {
  const where = project();
  await install(ownRequest(where, { a: { 'SKILL.md': 'A1\n' } }, ['claude-code']));
  const result = await prepareUpdate({ target: { project: where }, scope: 'project',
    updates: [{ managementIds: [ID('a')], request: ownRequest(where, { a: { 'SKILL.md': 'A2\n' } }, ['claude-code']) }] });
  assert.equal(result.entries[0].status, 'ready');
  writeFileSync(join(where, '.claude/skills/a/SKILL.md'), 'edited after the review\n');
  const run = await apply(result.handle, approve(result.review));
  assert.equal(run.completion, 'rejected'); assert.equal(run.code, 'REVIEW_STALE'); assert.equal(run.changed, 'target-file');
  assert.equal(readFileSync(join(where, '.claude/skills/a/SKILL.md'), 'utf8'), 'edited after the review\n');
});

/** A recipe plan made by the reader FIXTURE at a recipe source commit and data commit. */
function recipeUpdate(where, skills, commit, data) {
  const request = renderRequest(reader, where, skills, ['claude-code'], { recipe: true });
  const recipe = JSON.parse(request.recipeProof.recipeJson);
  recipe.data = { repository: 'samartomar/aih-catalog', commit: data };
  request.recipeProof.recipeJson = reader.canonical(recipe);
  request.plan = reader.planRecipe(recipe, request.contents, request.profiles, {}, { scope: 'project',
    source: { repository: 'https://github.com/example/notes-recipe', commit } });
  return request;
}

test('a proven recipe origin finds its receipts by recipe id and repository; the new data is recorded once the update completes', async () => {
  const where = project();
  await install(recipeUpdate(where, { a: { 'SKILL.md': '---\nname: a\n---\nA1\n' }, b: { 'SKILL.md': '---\nname: b\n---\nB1\n' } }, '1'.repeat(40), 'd'.repeat(40)), { catalog });
  const before = (await list({ target: { project: where }, scope: 'project' })).entries;
  assert.equal(before[0].origin.recipe.commit, '1'.repeat(40));
  const next = recipeUpdate(where, { a: { 'SKILL.md': '---\nname: a\n---\nA2\n' } }, '2'.repeat(40), 'f'.repeat(40));
  const result = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ request: next }] }, { catalog });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.review.originNote, null);
  assert.deepEqual(result.entries.map(entry => [entry.managementId.split('.').at(-1), entry.change]), [['a', 'update'], ['b', 'remove']]);
  const dropped = result.entries[1];
  assert.equal(dropped.note, `removed in data commit ${'f'.repeat(40)}`);
  assert.equal(result.entries[0].from.origin.recipe.commit, '1'.repeat(40));
  assert.equal(result.entries[0].to.origin.recipe.commit, '2'.repeat(40));
  const run = await apply(result.handle, approve(result.review), { catalog });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const after = (await list({ target: { project: where }, scope: 'project' })).entries;
  assert.deepEqual(after.map(entry => [entry.managementId.split('.').at(-1), entry.origin.recipe.commit, entry.data.commit]),
    [['a', '2'.repeat(40), 'f'.repeat(40)]]);
  assert.match(readFileSync(join(where, '.claude/skills/a/SKILL.md'), 'utf8'), /A2/);
  assert.equal(existsSync(join(where, '.claude/skills/b')), false);
});

test('an update that leaves a member out (your edit) records the new data only for work it carried out completely', async () => {
  const where = project();
  await install(recipeUpdate(where, { a: { 'SKILL.md': '---\nname: a\n---\nA1\n' } }, '1'.repeat(40), 'd'.repeat(40)), { catalog });
  const next = recipeUpdate(where, { a: { 'SKILL.md': '---\nname: a\n---\nA2\n' } }, '2'.repeat(40), 'f'.repeat(40));
  // A stale review records nothing.
  const result = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ request: next }] }, { catalog });
  writeFileSync(join(where, '.claude/skills/a/SKILL.md'), 'edited\n');
  assert.equal((await apply(result.handle, approve(result.review), { catalog })).completion, 'rejected');
  const kept = (await list({ target: { project: where }, scope: 'project' })).entries[0];
  assert.equal(kept.origin.recipe.commit, '1'.repeat(40)); assert.equal(kept.data.commit, 'd'.repeat(40));
});

test('two installs here with different origins of one recipe are ambiguous', async () => {
  const where = project();
  await install(recipeUpdate(where, { a: { 'SKILL.md': '---\nname: a\n---\nA1\n' } }, '1'.repeat(40), 'd'.repeat(40)), { catalog });
  await install(recipeUpdate(where, { b: { 'SKILL.md': '---\nname: b\n---\nB1\n' } }, '3'.repeat(40), 'd'.repeat(40)), { catalog });
  const next = recipeUpdate(where, { a: { 'SKILL.md': '---\nname: a\n---\nA2\n' } }, '2'.repeat(40), 'f'.repeat(40));
  const result = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ request: next }] }, { catalog });
  assert.equal(result.status, 'refused'); assert.equal(result.code, 'update-ambiguous', JSON.stringify(result));
  assert.match(result.reason, /1{40}/); assert.match(result.reason, /3{40}/);
});

/** User-scope link tests each start from their own home: links at one place are shared by every project. */
const freshHome = () => { home = join(scratch, `home-${counter++}`); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; };
const isLink = path => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
const target = path => resolve(join(path, '..'), readlinkSync(path)).replace(/[\\/]+$/, '');

test('a moved version folder is written, its links repointed, and the old folder removed once no claim holds it', async () => {
  freshHome();
  const where = project();
  await install(linkRequest(where, ['claude-code', 'codex'], { version: 'v1' }));
  const old = join(home, '.aihq/shared/ecc/skill/plan/v1');
  assert.ok(existsSync(join(old, 'SKILL.md')));
  const result = await prepareUpdate({ target: { project: where }, scope: 'user',
    updates: [{ managementIds: ['ecc.skill.plan'], request: linkRequest(where, ['claude-code', 'codex'], { version: 'v2' }) }] });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.entries[0].status, 'ready', JSON.stringify(result.entries));
  const run = await apply(result.handle, approve(result.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const fresh = join(home, '.aihq/shared/ecc/skill/plan/v2');
  assert.ok(existsSync(join(fresh, 'SKILL.md')));
  for (const place of ['.claude/skills/ecc-plan', '.agents/skills/ecc-plan']) {
    assert.ok(isLink(join(home, place)), place);
    assert.equal(target(join(home, place)).toLowerCase(), fresh.toLowerCase(), `${place} points at the new version`);
  }
  assert.equal(existsSync(old), false, 'the old version folder goes with its last claim');
  const listed = (await list({ target: { project: where }, scope: 'user' })).entries[0];
  assert.ok(listed.members.filter(member => member.kind === 'link').every(member => member.state === 'matching'), JSON.stringify(listed));
});

test('a moved version folder you edited keeps your old file', async () => {
  freshHome();
  const where = project();
  await install(linkRequest(where, ['claude-code', 'codex'], { version: 'v1' }));
  const old = join(home, '.aihq/shared/ecc/skill/plan/v1');
  writeFileSync(join(old, 'notes/usage.md'), 'my notes\n');
  const result = await prepareUpdate({ target: { project: where }, scope: 'user',
    updates: [{ managementIds: ['ecc.skill.plan'], request: linkRequest(where, ['claude-code', 'codex'], { version: 'v2' }) }] });
  const members = result.entries[0].members.filter(member => member.path.includes('v1'));
  assert.ok(members.some(member => member.path.endsWith('usage.md') && member.action === 'keep-changed'), JSON.stringify(members));
  const run = await apply(result.handle, approve(result.review, result.entries[0].status === 'partial'));
  assert.notEqual(run.completion, 'rejected', JSON.stringify(run));
  assert.equal(readFileSync(join(old, 'notes/usage.md'), 'utf8'), 'my notes\n');
  assert.equal(existsSync(join(old, 'SKILL.md')), false, 'the unchanged old file goes');
});

test('a change update replaces its entry and removes a named change the request no longer holds', async () => {
  const where = project();
  const config = join(where, '.team', 'settings.json');
  const setting = (id, value) => ({ managementId: id, change: projectSetting(id, id, value) });
  await install(changeRequest([setting('approval', 'on-request'), setting('sandbox', 'read-only')], { project: where }));
  assert.match(readFileSync(config, 'utf8'), /"approval": "on-request"/);
  const result = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ managementIds: ['approval', 'sandbox'],
    request: changeRequest([setting('approval', 'never')], { project: where }) }] });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.deepEqual(result.entries.map(entry => [entry.managementId, entry.change, entry.status]), [['approval', 'update', 'ready'], ['sandbox', 'remove', 'ready']]);
  const run = await apply(result.handle, approve(result.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const text = readFileSync(config, 'utf8');
  assert.match(text, /"approval": "never"/); assert.doesNotMatch(text, /sandbox/);
  const unnamed = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ request: changeRequest([setting('approval', 'never')], { project: where }) }] });
  assert.equal(unnamed.code, 'update-target-required');
});

test('an update request is checked as a whole first', async () => {
  const where = project();
  const request = ownRequest(where, { a: { 'SKILL.md': 'A\n' } }, ['claude-code']);
  const two = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ managementIds: [ID('a')], request }, { managementIds: [ID('a')], request }] });
  assert.equal(two.status, 'invalid');
  const elsewhere = await prepareUpdate({ target: { project: project() }, scope: 'project', updates: [{ managementIds: [ID('a')], request }] });
  assert.equal(elsewhere.status, 'invalid'); assert.equal(elsewhere.problems[0].reason, 'update-place');
});

const SHARED_ITEM = 'local-my-setup.mcp.docs';
const sharedMerge = (command, clis = ['claude-code', 'codex']) => ({ item: SHARED_ITEM, root: 'user', file: '.aih-test/mcp.json', format: 'json',
  key: '/mcpServers/docs', entry: { command }, clis });

test('a member two CLI claims share is replaced once for both, and both claims keep it', async () => {
  freshHome();
  const where = project();
  const file = join(home, '.aih-test/mcp.json');
  await install(mergeRequest(where, [sharedMerge('docs-v1')], { scope: 'user' }));
  const result = await prepareUpdate({ target: { project: where }, scope: 'user',
    updates: [{ managementIds: [SHARED_ITEM], request: mergeRequest(where, [sharedMerge('docs-v2')], { scope: 'user' }) }] });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.entries[0].status, 'ready', JSON.stringify(result.entries));
  assert.deepEqual(result.entries[0].members.map(member => member.action), ['replace']);
  const run = await apply(result.handle, approve(result.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).mcpServers.docs, { command: 'docs-v2' });
  const listed = (await list({ target: { project: where }, scope: 'user' })).entries.find(entry => entry.managementId === SHARED_ITEM);
  assert.deepEqual(listed.claims.map(claim => claim.cli), ['claude-code', 'codex']);
  assert.deepEqual(listed.members.map(member => member.state), ['matching']);
});

test('a dropped member another project still claims is kept for it', async () => {
  freshHome();
  const one = project(), two = project();
  const file = join(home, '.aih-test/mcp.json');
  await install(mergeRequest(one, [sharedMerge('docs', ['codex'])], { scope: 'user' }));
  await install(mergeRequest(two, [sharedMerge('docs', ['codex'])], { scope: 'user' }));
  // Project one's new plan no longer holds the shared item; it names the receipt it drops.
  const other = { item: 'local-my-setup.mcp.notes', root: 'user', file: '.aih-test/notes.json', format: 'json', key: '/notes', entry: true, clis: ['codex'] };
  const result = await prepareUpdate({ target: { project: one }, scope: 'user',
    updates: [{ managementIds: [SHARED_ITEM], request: mergeRequest(one, [other], { scope: 'user' }) }] });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  const dropped = result.entries.find(entry => entry.managementId === SHARED_ITEM);
  assert.equal(dropped.change, 'remove');
  assert.deepEqual(dropped.members.map(member => [member.action, member.reason]), [['keep-shared', 'another-selection']]);
  const run = await apply(result.handle, approve(result.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).mcpServers.docs, { command: 'docs' }, 'project two still claims it');
  const listed = (await list({ target: { project: two }, scope: 'user' })).entries.find(entry => entry.managementId === SHARED_ITEM);
  assert.equal(listed.claims.length, 1);
});

test('an AI setup moved to a new version is acquired into its new folder before the old folder goes', async () => {
  freshHome();
  const tls = await import('node:tls');
  const { artifactServer, nativeSetup, setupRequest } = await import('./fixtures/acquire-fixture.mjs');
  const server = await artifactServer();
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), server.caPem]);
  try {
    const where = project();
    const v1 = nativeSetup(server, { name: 'memory-mcp', version: '0.12.1' });
    await install(setupRequest(where, [v1]));
    assert.ok(existsSync(join(home, v1.folder, 'memory-mcp')));
    const v2 = nativeSetup(server, { name: 'memory-mcp', version: '0.13.0', members: { 'memory-mcp': '#!/bin/sh\necho memory 13\n', LICENSE: 'MIT\n' } });
    const result = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ managementIds: [v1.id], request: setupRequest(where, [v2]) }] });
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.deepEqual(result.entries.map(entry => [entry.managementId, entry.change, entry.status]), [[v1.id, 'update', 'ready']]);
    const run = await apply(result.handle, approve(result.review));
    assert.equal(run.completion, 'complete', JSON.stringify(run));
    assert.equal(readFileSync(join(home, v2.folder, 'memory-mcp'), 'utf8'), '#!/bin/sh\necho memory 13\n');
    assert.equal(existsSync(join(home, v1.folder)), false, 'the old version folder goes once no claim holds it');
  } finally { await server.close(); }
});
