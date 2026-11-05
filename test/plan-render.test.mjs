// Render steps and recipe-origin proofs (contract 3 Controls, 8.1 `write` with `render`, 8.2) through the built public
// entries, in a disposable home and project. The Catalog reader passed in `controls.catalog` and every producer document
// are Core-side FIXTURES (test/fixtures/catalog-node-fixture/reader.mjs, plan-fixture.mjs), not Catalog output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { apply, list, prepare, prepareRemoval } from '../dist/core/index.js';
import { validateFormat } from '../dist/core/contracts.js';
import * as reader from './fixtures/catalog-node-fixture/reader.mjs';
import { renderRequest } from './fixtures/plan-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-render-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const SKILL = '---\nname: notes\ndescription: Take notes\n---\nTake notes.\n';
const SKILLS = { notes: { 'SKILL.md': SKILL, 'reference.md': 'Reference.\n' } };
const ID = 'local-my-skills.skill.notes';
const RENDERED = '---\ndisable-model-invocation: true\nname: notes\ndescription: Take notes\n---\nTake notes.\n';
const OPENAI_YAML = 'policy:\n  allow_implicit_invocation: false\n';
const catalog = (extra = {}) => ({ catalog: { version: reader.FIXTURE_VERSION, renderStep: reader.renderStep, planRecipe: reader.planRecipe, ...extra } });
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
let counter = 0;
function project() {
  const path = join(scratch, `project-${counter++}`);
  mkdirSync(path); writeFileSync(join(path, 'README.md'), 'mine\n');
  return path;
}
function snapshot(folder) {
  const out = {};
  const walk = (dir, prefix) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(join(dir, entry.name), rel); else out[rel] = readFileSync(join(dir, entry.name), 'utf8');
  } };
  walk(folder, ''); return out;
}
const entryOf = async target => (await list({ target: { project: target }, scope: 'project' })).entries.find(row => row.managementId === ID);

test('render steps are carried out through the caller\'s Catalog, record its version and the profiles, and removal restores the disk', async () => {
  const target = project();
  const before = snapshot(target);
  const prepared = await prepare(renderRequest(reader, target, SKILLS), catalog());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  assert.ok(prepared.review.steps.some(step => step.path === '.agents/skills/notes/agents/openai.yaml'));
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  for (const place of ['.claude/skills', '.agents/skills', '.kiro/skills']) {
    assert.equal(readFileSync(join(target, place, 'notes/SKILL.md'), 'utf8'), RENDERED, place);
    assert.equal(readFileSync(join(target, place, 'notes/reference.md'), 'utf8'), 'Reference.\n', place);
  }
  assert.equal(readFileSync(join(target, '.agents/skills/notes/agents/openai.yaml'), 'utf8'), OPENAI_YAML);
  const row = await entryOf(target);
  assert.deepEqual([row.origin, row.catalog, row.profiles],
    ['chosen', reader.FIXTURE_VERSION, [{ id: 'claude-code', version: 1 }, { id: 'codex', version: 1 }, { id: 'kiro', version: 1 }]]);
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: ID }] });
  assert.equal((await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.deepEqual(snapshot(target), before);
});

test('a render is refused before any effect when its Catalog is absent or its sources or profile versions differ', async () => {
  const target = project();
  const before = snapshot(target);
  const SKILL_STEP = request => request.plan.plan.findIndex(step => step.render?.name === 'skill-user-only');
  const cases = [
    ['no Catalog', request => request, {}, { status: 'refused', code: 'catalog-required' }],
    ['a Catalog without renderStep', request => request, { catalog: { version: reader.FIXTURE_VERSION } }, { status: 'refused', code: 'catalog-required' }],
    ['source bytes differ', request => { request.files.find(file => file.sourcePath === 'notes/SKILL.md').bytes = Buffer.from('other'); },
      catalog(), { status: 'refused', code: 'source-mismatch' }],
    ['the step\'s source sha256 differs from the content', request => { request.plan.plan[SKILL_STEP(request)].from.sha256 = '0'.repeat(64); },
      catalog(), { status: 'refused', code: 'source-mismatch' }],
    ['a supplied profile at another version', request => { request.profiles.find(entry => entry.id === 'kiro').version = 2; },
      catalog(), { status: 'refused', code: 'profile-mismatch' }],
    ['a render profile not supplied', request => { request.plan.plan[SKILL_STEP(request)].render.profile = 'copilot'; },
      catalog(), { status: 'refused', code: 'profile-mismatch' }],
    ['the Catalog itself refuses a profile', request => request,
      catalog({ renderStep: () => ({ status: 'refused', code: 'profile-mismatch', reason: 'planned with another version' }) }),
      { status: 'refused', code: 'profile-mismatch' }],
    ['a render with no profile version', request => { delete request.plan.plan[SKILL_STEP(request)].render.version; }, catalog(), { status: 'invalid' }],
    ['the Catalog returns bytes that differ from its sha256', request => request,
      catalog({ renderStep: () => ({ status: 'ok', bytes: new Uint8Array([1]), sha256: '0'.repeat(64) }) }), { status: 'invalid' }],
    ['the Catalog throws', request => request, catalog({ renderStep: () => { throw new Error('boom'); } }), { status: 'invalid' }],
  ];
  for (const [name, change, controls, expected] of cases) {
    const request = renderRequest(reader, target, SKILLS);
    change(request);
    const result = await prepare(request, controls);
    for (const [field, value] of Object.entries(expected)) assert.equal(result[field], value, `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.handle, undefined, name);
    if (expected.status === 'refused') { assert.equal(typeof result.step, 'number', name); assert.match(result.reason, /\S/, name); }
  }
  assert.deepEqual(snapshot(target), before, 'no target effect before a refusal');
});

test('a rendered write over your own file is blocked, replaced after a reviewed choice, and removal writes your bytes back', async () => {
  const target = project();
  mkdirSync(join(target, '.claude/skills/notes'), { recursive: true });
  writeFileSync(join(target, '.claude/skills/notes/SKILL.md'), 'my own skill\n');
  const before = snapshot(target);
  const request = renderRequest(reader, target, SKILLS);
  const blocked = await prepare(request, catalog());
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  const [conflict] = blocked.review.conflicts;
  assert.deepEqual([conflict.target, conflict.choices.includes('replace')], ['.claude/skills/notes/SKILL.md', true]);
  const ready = await prepare({ ...request, resolutions: [{ managementId: ID, step: conflict.step, choice: 'replace', observedSha256: conflict.observedSha256 }] }, catalog());
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.equal((await apply(ready.handle, approve(ready.review))).completion, 'complete');
  assert.equal(readFileSync(join(target, '.claude/skills/notes/SKILL.md'), 'utf8'), RENDERED);
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: ID }] });
  assert.equal((await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.deepEqual(snapshot(target), before);
});

test('a recipe origin is recorded only when Core reproduces the plan byte for byte through the caller\'s planRecipe', async () => {
  const PROVEN = { recipe: { id: 'notes-base', sha256: renderRequest(reader, '/x', SKILLS, undefined, { recipe: true }).plan.recipe.sha256,
    repository: 'https://github.com/example/notes-recipe', commit: 'e'.repeat(40) },
    data: { repository: 'samartomar/aih-catalog', commit: 'd'.repeat(40) } };
  const outcome = async (change, controls = catalog()) => {
    const target = project();
    const request = renderRequest(reader, target, SKILLS, undefined, { recipe: true });
    change(request);
    return { target, request, prepared: await prepare(request, controls) };
  };
  // A matching proof records the origin in the review and the receipt.
  const { target, prepared } = await outcome(() => {});
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  assert.deepEqual([prepared.review.origin, prepared.review.originNote], [PROVEN, null]);
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const row = await entryOf(target);
  assert.deepEqual([row.origin, row.data], [PROVEN, PROVEN.data]);
  conforms(await list({ target: { project: target }, scope: 'project' }));

  // No proof, recipe bytes that differ from the plan's sha256, or a plan edited after planning: installed as chosen.
  const unproven = [
    ['no proof', request => { delete request.recipeProof; }],
    ['other recipe bytes', request => { request.recipeProof.recipeJson = request.recipeProof.recipeJson.replace('notes-base', 'notes-else'); }],
    ['a hand-edited plan claiming the recipe', request => { request.plan.plan = request.plan.plan.filter(step => !step.path.startsWith('.kiro/')); }],
    ['other choices than the plan was made with', request => { request.recipeProof.choices = { extras: [] }; }],
  ];
  for (const [name, change] of unproven) {
    const { prepared: result } = await outcome(change);
    assert.equal(result.status, 'ready', `${name}: ${JSON.stringify(result)}`);
    assert.deepEqual([result.review.origin, result.review.originNote], ['chosen', 'origin not proven'], name);
  }
  // A planInstall plan, even with a proof, is always chosen.
  const chosen = await prepare({ ...renderRequest(reader, project(), SKILLS), recipeProof: renderRequest(reader, '/x', SKILLS, undefined, { recipe: true }).recipeProof }, catalog());
  assert.deepEqual([chosen.status, chosen.review.origin, chosen.review.originNote], ['ready', 'chosen', null]);

  // A malformed proof is invalid; a proof without a Catalog that can reproduce it is catalog-required.
  for (const [name, change] of [
    ['proof missing its recipe', request => { delete request.recipeProof.recipeJson; }],
    ['recipe text that is not JSON', request => { request.recipeProof.recipeJson = '{not json'; }],
    ['options naming the scope Core sets', request => { request.recipeProof.options = { scope: 'user' }; }],
  ]) assert.equal((await outcome(change)).prepared.status, 'invalid', name);
  const required = (await outcome(() => {}, { catalog: { version: reader.FIXTURE_VERSION, renderStep: reader.renderStep } })).prepared;
  assert.deepEqual([required.status, required.code], ['refused', 'catalog-required']);
});

test('a rendered write whose `from` names no item reads a source notice by its source id, as a plain write does', async () => {
  const target = project();
  const request = renderRequest(reader, target, SKILLS, ['claude-code']);
  const notice = Buffer.from('---\nname: notice\n---\nA notice.\n');
  const source = request.contents[0].sources[0];
  source.notices.push({ sourcePath: 'NOTICE.md', sha256: createHash('sha256').update(notice).digest('hex') });
  request.files.push({ sourceId: source.id, sourcePath: 'NOTICE.md', sha256: source.notices[0].sha256, bytes: notice });
  const step = request.plan.plan.find(entry => entry.render?.name === 'skill-user-only');
  step.from = { sourceId: source.id, sourcePath: 'NOTICE.md', sha256: source.notices[0].sha256 };
  const prepared = await prepare(request, catalog());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal((await apply(prepared.handle, approve(prepared.review), catalog())).completion, 'complete');
  assert.equal(readFileSync(join(target, step.path), 'utf8'), '---\ndisable-model-invocation: true\nname: notice\n---\nA notice.\n');
});
