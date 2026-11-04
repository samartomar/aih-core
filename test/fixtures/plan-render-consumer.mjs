// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Render steps and recipe-origin proofs through the Catalog installed beside Core. That `@aihq/catalog` package
// (catalog-node-fixture: `/node` readLocalSource, `/reader` renderStep, planRecipe, planInstall) and every producer
// document (plan-fixture.mjs) are Core-side FIXTURES at version 0.0.0-core-fixture; they establish Core behaviour, not
// Catalog or client compatibility.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFormat } from '@aihq/core/contracts';
import { apply, list, prepare, prepareRemoval } from '@aihq/core';
import * as reader from '@aihq/catalog/reader';
import { renderRequest, savedDocument } from './plan-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SKILL = '---\nname: notes\ndescription: Take notes\n---\nTake notes.\n';
const SKILLS = { notes: { 'SKILL.md': SKILL, 'reference.md': 'Reference.\n' } };
const RENDERED = '---\ndisable-model-invocation: true\nname: notes\ndescription: Take notes\n---\nTake notes.\n';
const ID = 'local-my-skills.skill.notes';
const VERSION = '0.0.0-core-fixture';
const PROFILES = [{ id: 'claude-code', version: 1 }, { id: 'codex', version: 1 }, { id: 'kiro', version: 1 }];
const controls = { catalog: { version: VERSION, renderStep: reader.renderStep, planRecipe: reader.planRecipe } };
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const entry = async target => conforms(await list({ target: { project: target }, scope: 'project' })).entries.find(row => row.managementId === ID);
function snapshot(folder) {
  const out = {};
  const walk = (dir, prefix) => { for (const item of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) walk(join(dir, item.name), rel); else out[rel] = readFileSync(join(dir, item.name), 'utf8');
  } };
  walk(folder, ''); return out;
}
function project(name) {
  const path = mkdtempSync(join(process.env.HOME, `${name}-`));
  writeFileSync(join(path, 'README.md'), 'mine\n');
  return path;
}
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

await check('rendered writes through the installed Catalog reader over your own file: reviewed replace, receipt names the Catalog and profiles, removal restores byte for byte', async () => {
  const target = project('render');
  mkdirSync(join(target, '.kiro/skills/notes'), { recursive: true });
  writeFileSync(join(target, '.kiro/skills/notes/SKILL.md'), 'my own kiro skill\n');
  const before = snapshot(target);
  const request = renderRequest(reader, target, SKILLS);
  const blocked = await prepare(request, controls);
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  const [conflict] = blocked.review.conflicts;
  const prepared = await prepare({ ...request, resolutions: [{ managementId: ID, step: conflict.step, choice: 'replace',
    observedSha256: conflict.observedSha256 }] }, controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  const run = conforms(await apply(prepared.handle, approve(prepared.review), controls));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  for (const place of ['.claude/skills', '.agents/skills', '.kiro/skills'])
    assert.equal(readFileSync(join(target, place, 'notes/SKILL.md'), 'utf8'), RENDERED, place);
  assert.equal(readFileSync(join(target, '.agents/skills/notes/agents/openai.yaml'), 'utf8'), 'policy:\n  allow_implicit_invocation: false\n');
  const row = await entry(target);
  assert.deepEqual([row.origin, row.catalog, row.profiles], ['chosen', VERSION, PROFILES]);
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: ID }] });
  assert.equal(conforms(await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.deepEqual(snapshot(target), before);
});

await check('a reproduced recipe plan records its origin; a hand-edited plan claiming it installs as chosen, origin not proven', async () => {
  const proven = project('proven');
  const request = renderRequest(reader, proven, SKILLS, undefined, { recipe: true });
  const prepared = await prepare(request, controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.deepEqual([prepared.review.origin.recipe, prepared.review.originNote], [request.plan.recipe, null]);
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  assert.deepEqual((await entry(proven)).origin, { recipe: request.plan.recipe, data: request.plan.data });
  const edited = renderRequest(reader, project('edited'), SKILLS, undefined, { recipe: true });
  edited.plan.plan = edited.plan.plan.filter(step => !step.path.startsWith('.kiro/'));
  const unproven = await prepare(edited, controls);
  assert.deepEqual([unproven.status, unproven.review.origin, unproven.review.originNote], ['ready', 'chosen', 'origin not proven']);
  const malformed = renderRequest(reader, project('malformed'), SKILLS, undefined, { recipe: true });
  malformed.recipeProof.recipeJson = '{not json';
  assert.equal((await prepare(malformed, controls)).status, 'invalid');
  const absent = await prepare(renderRequest(reader, project('absent'), SKILLS), {});
  assert.deepEqual([absent.status, absent.code], ['refused', 'catalog-required']);
});

await check('the aih CLI passes the Catalog installed beside it: a saved render request with a recipe proof installs with the proven origin, and removes', async () => {
  const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
  const aih = args => {
    const child = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return { code: child.status, result: JSON.parse(child.stdout.trim().split('\n').at(-1)) };
  };
  const target = project('cli');
  const before = snapshot(target);
  const source = mkdtempSync(join(process.env.HOME, 'source-'));
  const request = renderRequest(reader, target, SKILLS, undefined, { recipe: true });
  for (const file of request.files) { mkdirSync(dirname(join(source, file.sourcePath)), { recursive: true }); writeFileSync(join(source, file.sourcePath), file.bytes); }
  const saved = savedDocument(request);
  delete saved.target.project;
  const document = join(source, '..', 'render-request.json');
  writeFileSync(document, JSON.stringify(saved));
  const preview = aih(['install', document, '--project', target, '--source', `local-my-skills=${source}`, '--json']);
  assert.deepEqual([preview.code, preview.result.status, preview.result.review?.originNote], [0, 'ready', null], JSON.stringify(preview));
  assert.deepEqual(snapshot(target), before, 'a preview writes nothing');
  const installed = aih(['install', document, '--project', target, '--source', `local-my-skills=${source}`, '--apply', '--yes', '--json']);
  assert.deepEqual([installed.code, installed.result.completion], [0, 'complete'], JSON.stringify(installed));
  assert.equal(readFileSync(join(target, '.claude/skills/notes/SKILL.md'), 'utf8'), RENDERED);
  const inventory = aih(['list', '--project', target, '--scope', 'project', '--json']);
  const row = inventory.result.entries.find(item => item.managementId === ID);
  assert.deepEqual([inventory.code, row.origin.recipe.id, row.catalog], [0, 'notes-base', VERSION]);
  const removed = aih(['remove', ID, '--scope', 'project', '--project', target, '--apply', '--yes', '--json']);
  assert.deepEqual([removed.code, removed.result.completion], [0, 'complete'], JSON.stringify(removed));
  assert.deepEqual(snapshot(target), before);
});

console.log(JSON.stringify({ status: 'passed', checks }));
