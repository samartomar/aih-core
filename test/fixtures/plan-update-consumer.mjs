// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Updates from explicit new requests (contract 12, journey 8). The plan, content and profile documents are Core-side
// FIXTURES (plan-fixture.mjs) in the accepted Catalog shapes, and `@aihq/catalog` beside Core is the Core-side reader
// FIXTURE; the links made here show Core's placement only, never that a real client loads them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFormat, refusalCodes } from '@aihq/core/contracts';
import { apply, list, prepare, prepareUpdate } from '@aihq/core';
import * as reader from '@aihq/catalog/reader';
import { linkRequest, ownRequest, renderRequest, savedDocument } from './plan-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.HOME;
const approve = (review, allowPartial) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...(allowPartial ? { allowPartial: true } : {}) });
const conforms = value => { assert.deepEqual(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const project = name => mkdtempSync(join(home, `${name}-`));
const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
const aih = args => {
  const child = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { code: child.status, result: JSON.parse(child.stdout.trim().split('\n').at(-1)) };
};
const catalog = { version: '0.0.0-core-fixture', renderStep: reader.renderStep, planRecipe: reader.planRecipe };
async function install(request, controls) {
  const prepared = await prepare(request, controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = conforms(await apply(prepared.handle, approve(prepared.review), controls));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
}
/** A request saved without bytes, plus its source folder for `--source`. */
function saved(request, folder) {
  for (const file of request.files) { mkdirSync(dirname(join(folder, file.sourcePath)), { recursive: true }); writeFileSync(join(folder, file.sourcePath), file.bytes); }
  const path = join(folder, '..', `${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(savedDocument(request)));
  return path;
}
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };
const ID = name => `local-my-skills.skill.${name}`;

await check('both update codes are published', async () => {
  for (const code of ['update-target-required', 'update-ambiguous']) assert.ok(refusalCodes.some(entry => entry.code === code), code);
});

await check('API: an own-content update adds, replaces and removes, keeps your edit, and goes stale on a later edit', async () => {
  const where = project('own');
  await install(ownRequest(where, { a: { 'SKILL.md': 'A1\n' }, b: { 'SKILL.md': 'B1\n' }, c: { 'SKILL.md': 'C1\n' } }, ['claude-code']));
  writeFileSync(join(where, '.claude/skills/c/SKILL.md'), 'yours\n');
  const next = ownRequest(where, { a: { 'SKILL.md': 'A2\n' }, c: { 'SKILL.md': 'C2\n' }, d: { 'SKILL.md': 'D1\n' } }, ['claude-code']);
  const request = { target: { project: where }, scope: 'project', updates: [{ managementIds: ['a', 'b', 'c'].map(ID), request: next }] };
  const result = await prepareUpdate(request);
  assert.equal(result.status, 'ok', JSON.stringify(result));
  conforms(result.review);
  assert.deepEqual(result.entries.map(entry => [entry.managementId.split('.').at(-1), entry.change, entry.status, entry.members.map(member => member.action)]),
    [['a', 'update', 'ready', ['replace']], ['b', 'remove', 'ready', ['remove']], ['c', 'update', 'partial', ['keep-changed']], ['d', 'add', 'ready', ['add']]]);
  // An edit after the review makes Apply stale; a fresh review then carries the update out.
  writeFileSync(join(where, '.claude/skills/a/SKILL.md'), 'late edit\n');
  const stale = conforms(await apply(result.handle, approve(result.review, true)));
  assert.deepEqual([stale.completion, stale.code, stale.changed], ['rejected', 'REVIEW_STALE', 'target-file']);
  writeFileSync(join(where, '.claude/skills/a/SKILL.md'), 'A1\n');
  const fresh = await prepareUpdate(request);
  const run = conforms(await apply(fresh.handle, approve(fresh.review, true)));
  assert.equal(run.completion, 'incomplete', 'your kept edit is left out');
  assert.equal(readFileSync(join(where, '.claude/skills/a/SKILL.md'), 'utf8'), 'A2\n');
  assert.equal(readFileSync(join(where, '.claude/skills/c/SKILL.md'), 'utf8'), 'yours\n');
  assert.equal(existsSync(join(where, '.claude/skills/b')), false);
  const listed = conforms(await list({ target: { project: where }, scope: 'project' }));
  assert.deepEqual(listed.entries.map(entry => entry.managementId).sort(), ['a', 'c', 'd'].map(ID));
});

await check('API: a proven recipe update finds its receipts, records the new origin after completing, and two origins are ambiguous', async () => {
  const where = project('recipe');
  const recipeAt = (skills, commit, data) => {
    const request = renderRequest(reader, where, skills, ['claude-code'], { recipe: true });
    const recipe = JSON.parse(request.recipeProof.recipeJson);
    recipe.data = { repository: 'samartomar/aih-catalog', commit: data };
    request.recipeProof.recipeJson = reader.canonical(recipe);
    request.plan = reader.planRecipe(recipe, request.contents, request.profiles, {}, { scope: 'project', source: { repository: 'https://github.com/example/notes-recipe', commit } });
    return request;
  };
  await install(recipeAt({ a: { 'SKILL.md': '---\nname: a\n---\nA1\n' }, b: { 'SKILL.md': '---\nname: b\n---\nB1\n' } }, '1'.repeat(40), 'd'.repeat(40)), { catalog });
  const next = recipeAt({ a: { 'SKILL.md': '---\nname: a\n---\nA2\n' } }, '2'.repeat(40), 'f'.repeat(40));
  const result = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ request: next }] }, { catalog });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.entries.find(entry => entry.change === 'remove').note, `removed in data commit ${'f'.repeat(40)}`);
  assert.equal(conforms(await apply(result.handle, approve(result.review), { catalog })).completion, 'complete');
  const [entry] = conforms(await list({ target: { project: where }, scope: 'project' })).entries;
  assert.deepEqual([entry.origin.recipe.commit, entry.data.commit], ['2'.repeat(40), 'f'.repeat(40)]);
  await install(recipeAt({ e: { 'SKILL.md': '---\nname: e\n---\nE1\n' } }, '3'.repeat(40), 'd'.repeat(40)), { catalog });
  const ambiguous = await prepareUpdate({ target: { project: where }, scope: 'project', updates: [{ request: next }] }, { catalog });
  assert.deepEqual([ambiguous.status, ambiguous.code], ['refused', 'update-ambiguous'], JSON.stringify(ambiguous));
});

await check('aih update: targets must be named; a moved version folder is relinked and the old one removed', async () => {
  const where = project('ecc');
  await install(linkRequest(where, ['claude-code', 'codex'], { version: 'v1' }));
  const file = saved(linkRequest(where, ['claude-code', 'codex'], { version: 'v2' }), join(mkdtempSync(join(home, 'src-')), 'ecc'));
  const folder = join(dirname(file), 'ecc');
  const unnamed = aih(['update', file, '--scope', 'user', '--project', where, '--source', `ecc=${folder}`, '--json']);
  assert.deepEqual([unnamed.code, unnamed.result.code], [2, 'update-target-required'], JSON.stringify(unnamed));
  const preview = aih(['update', file, '--scope', 'user', '--project', where, '--management-id', 'ecc.skill.plan', '--source', `ecc=${folder}`, '--json']);
  assert.deepEqual([preview.code, preview.result.status, preview.result.entries[0].status], [0, 'ok', 'ready'], JSON.stringify(preview));
  const applied = aih(['update', file, '--scope', 'user', '--project', where, '--management-id', 'ecc.skill.plan', '--source', `ecc=${folder}`, '--apply', '--yes', '--json']);
  assert.deepEqual([applied.code, applied.result.completion], [0, 'complete'], JSON.stringify(applied));
  const fresh = join(home, '.aihq/shared/ecc/skill/plan/v2');
  for (const place of ['.claude/skills/ecc-plan', '.agents/skills/ecc-plan']) {
    assert.ok(lstatSync(join(home, place)).isSymbolicLink(), place);
    assert.equal(resolve(join(home, place, '..'), readlinkSync(join(home, place))).replace(/[\\/]+$/, '').toLowerCase(), fresh.toLowerCase());
  }
  assert.ok(existsSync(join(fresh, 'SKILL.md')));
  assert.equal(existsSync(join(home, '.aihq/shared/ecc/skill/plan/v1')), false);
});

console.log(JSON.stringify({ status: 'passed', checks }));
