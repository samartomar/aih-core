// Real Catalog plans through Core (samartomar/aih-core#163): plans, content, profiles and render bytes recorded from the
// @aihq/catalog package built at samartomar/aih-catalog 6d9c544 (test/fixtures/catalog-6d9c544), prepared and applied
// through the built public entries in a disposable home and project, then removed. This is real producer output for that
// unreleased candidate; it shows Core carries out its shapes, not that any client loads the result.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { apply, list, prepare, prepareRemoval } from '../dist/core/index.js';
import { validateFormat } from '../dist/core/contracts.js';
import { BYO_SECRET, byoControls, byoRequest, catalog, cbmRequest, recipeRequest, recorded, rulesRequest } from './fixtures/catalog-6d9c544/replay.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-catalog-6d9c544-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };
let home;
// The only AI CLIs on PATH are fakes the review asks for their versions (D110); no real client runs. The fake `opencode`,
// like many CLIs, creates its own config folder whenever it starts; the fake Cursor CLI (`cursor-agent`) prints a version.
function fakeCli(bin, name, version, folder) {
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') writeFileSync(join(bin, `${name}.cmd`),
    `@echo off\r\n${folder ? `mkdir "%USERPROFILE%\\${folder.replaceAll('/', '\\')}" 2>nul\r\n` : ''}echo ${version}\r\n`);
  else { writeFileSync(join(bin, name), `#!/bin/sh\n${folder ? `mkdir -p "$HOME/${folder}"\n` : ''}echo ${version}\n`); chmodSync(join(bin, name), 0o755); }
}
before(() => { home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home;
  const bin = join(scratch, 'bin'); fakeCli(bin, 'opencode', '1.19.5', '.config/opencode'); fakeCli(bin, 'cursor-agent', '2026.10.1');
  process.env.PATH = [bin, dirname(process.execPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])].join(delimiter); });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
let counter = 0;
const project = () => { const path = join(scratch, `project-${counter++}`); mkdirSync(path); return path; };
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const rendered = step => {
  const entry = recorded.renders.find(candidate => candidate.step === JSON.stringify(sorted(step)));
  assert.equal(entry?.result.status, 'ok', `render of ${step.path ?? step.file}`);
  return Buffer.from(entry.result.base64, 'base64').toString('utf8');
};
const sourceText = (files, from) => files.find(file => file.sourceId === from.sourceId && file.sourcePath === from.sourcePath).text;

/** What a person sees on disk after Apply, for every step of the real plan. */
function placed(plan, files, roots) {
  for (const step of plan.plan) {
    const at = join(roots[step.root], step.path ?? step.file);
    if (step.op === 'link') { assert.ok(existsSync(join(at, 'SKILL.md')), `${step.path} links to its version folder`); continue; }
    const text = readFileSync(at, 'utf8');
    if (step.op === 'write') assert.equal(text, step.render ? rendered(step) : sourceText(files, step.from), step.path);
    else if (step.format === 'markdown') {
      const body = step.render ? rendered(step) : sourceText(files, step.from);
      assert.ok(text.includes(`<!-- aih:begin ${step.key} -->`) && text.includes(body.trimEnd()), `${step.file} holds the ${step.key} block`);
    }
  }
}
/**
 * After removal nothing the plan placed is left: files and links are gone, and each merged entry is out of its file. (A
 * JSON or TOML file the engine created stays, emptied of its entries: retained engine behaviour.)
 */
const gone = (plan, roots) => { for (const step of plan.plan) {
  const at = join(roots[step.root], step.path ?? step.file);
  if (step.op !== 'merge' || !existsSync(at)) { assert.equal(existsSync(at), false, `${step.path ?? step.file} is removed`); continue; }
  const text = readFileSync(at, 'utf8');
  if (step.format === 'json') {
    const segments = step.key.slice(1).split('/').map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
    let value = JSON.parse(text);
    for (const segment of segments) value = value && typeof value === 'object' ? value[segment] : undefined;
    assert.equal(value, undefined, `${step.file} no longer holds ${step.key}`);
  }
  else assert.equal(text.includes(step.format === 'markdown' ? `aih:begin ${step.key}` : step.key), false, `${step.file} holds nothing of ours`);
} };
async function removeAll(target, scope) {
  const entries = conforms(await list({ target: { project: target }, scope })).entries;
  const removal = await prepareRemoval({ target: { project: target }, scope, removals: entries.map(entry => ({ managementId: entry.managementId })) },
    byoControls());
  assert.equal(removal.status, 'ok', JSON.stringify(removal).slice(0, 2000));
  assert.equal(conforms(await apply(removal.handle, approve(removal.review), byoControls())).completion, 'complete');
}

for (const scope of ['user', 'project']) test(`the real bring-your-own ${scope} plan for nine clients installs, every file as Catalog planned, and removes`, async () => {
  const target = project();
  const request = byoRequest(scope, target);
  const prepared = await prepare(request, byoControls());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 3000));
  conforms(prepared.review);
  assert.equal(JSON.stringify(prepared.review).includes(BYO_SECRET), false, 'the review never shows the secret');
  // The Cursor profile lists the CLI and the IDE it was checked with; the CLI that answered is compared with its own entry.
  const cursor = prepared.review.versions.find(entry => entry.tool === 'cursor');
  assert.deepEqual([cursor.comparison, cursor.checkedWith?.app], ['older', 'cursor-agent'], JSON.stringify(cursor));
  const run = conforms(await apply(prepared.handle, approve(prepared.review), byoControls()));
  assert.equal(run.completion, 'complete', JSON.stringify(run).slice(0, 3000));
  const roots = { user: home, project: target };
  placed(request.plan, recorded.byo.files, roots);
  await removeAll(target, scope);
  gone(request.plan, roots);
});

test('an MCP entry naming an executable no acquire step places and Core never acquired is a plan problem (cbm on windows-x64)', async () => {
  // Catalog 6d9c544 on windows-x64: the AI setup is `not-qualified` (no acquire step), yet its MCP merges are planned.
  const request = cbmRequest(project());
  const rooted = request.plan.plan.flatMap((step, index) => step.rootPaths ? [index] : []);
  assert.ok(rooted.length > 0);
  const refused = await prepare(request, { catalog });
  assert.equal(refused.status, 'invalid', JSON.stringify(refused).slice(0, 2000));
  assert.deepEqual(refused.problems.map(problem => [problem.path, problem.reason]), rooted.map(index => [`/plan/plan/${index}/rootPaths/0`, 'root-path-unplaced']));
  assert.match(refused.problems[0].message, new RegExp(`^Step ${rooted[0]} `));
});

test('an MCP entry naming an executable in a folder Core acquired gets its absolute path under the user root (Catalog rootPaths)', async () => {
  const target = project();
  const request = cbmRequest(target);
  // A FIXTURE stand-in for an earlier install's acquired folder: Core's marker file in the folder the entry names.
  const folder = join(home, ...request.plan.plan.find(step => step.rootPaths).rootPaths[0].path.split('/').slice(0, -1));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.aih-acquired'), 'Managed by AIH Core: cbm.ai-setup.codebase-memory-mcp 0.12.1 windows-x64\n');
  const prepared = await prepare(request, { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 3000));
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const step = request.plan.plan.find(entry => entry.op === 'merge' && entry.format === 'json' && entry.clis.includes('claude-code'));
  const [rootPath] = step.rootPaths;
  const written = JSON.parse(readFileSync(join(target, step.file), 'utf8'));
  assert.equal(written.mcpServers['codebase-memory-mcp'].command, join(home, ...rootPath.path.split('/')));
  const toml = readFileSync(join(target, '.codex', 'config.toml'), 'utf8');
  assert.ok(toml.includes(JSON.stringify(join(home, ...rootPath.path.split('/')))), toml);
  rmSync(join(home, '.aihq'), { recursive: true, force: true });
});

test('a real local-plugin recipe plan over the Superpowers data is reproduced: its origin is proven, installed, listed and removed', async () => {
  const target = project();
  const request = recipeRequest(target);
  const prepared = await prepare(request, { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  const origin = { recipe: { ...request.plan.recipe }, data: { ...request.plan.data } };
  assert.deepEqual([prepared.review.origin, prepared.review.originNote], [origin, null]);
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  assert.ok(existsSync(join(target, '.aihq', 'plugins', 'superpowers', '.claude-plugin', 'plugin.json')));
  const listed = conforms(await list({ target: { project: target }, scope: 'project' }));
  assert.ok(listed.entries.length > 0 && listed.entries.every(entry => JSON.stringify(entry.origin) === JSON.stringify(origin)), JSON.stringify(listed.entries.map(entry => entry.origin)));
  // A plan that differs from what Catalog reproduces records `chosen`, never blocking.
  const changed = recipeRequest(project());
  changed.recipeProof.choices = { extra: [] };
  const unproven = await prepare(changed, { catalog });
  assert.deepEqual([unproven.status, unproven.review?.origin, unproven.review?.originNote], ['ready', 'chosen', 'origin not proven']);
  await removeAll(target, 'project');
  assert.equal(existsSync(join(target, '.aihq', 'plugins', 'superpowers')), false);
});

test('a plan-namespaced name reference is a warning; only a path reference is plan-unresolved', async () => {
  const reference = { kind: 'name', item: 'my-skills.skill.notes', file: 'skills/notes/SKILL.md', name: 'other:plan', clis: ['claude-code'] };
  const named = byoRequest('project', project());
  named.plan.references = [reference];
  assert.equal((await prepare(named, byoControls())).status, 'ready');
  const pathed = byoRequest('project', project());
  pathed.plan.references = [{ kind: 'path', item: 'my-skills.skill.notes', file: 'skills/notes/SKILL.md', path: 'docs/missing.md', clis: ['claude-code'] }];
  assert.equal((await prepare(pathed, byoControls())).code, 'plan-unresolved');
});

test('a rule placeholder is filled where the plan binds it; a Markdown block carrying it unbound is refused, never written with the marker', async () => {
  const target = project();
  const prepared = await prepare(rulesRequest('claude', target), { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review), { catalog })).completion, 'complete');
  assert.equal(readFileSync(join(target, '.claude', 'rules', 'team.md'), 'utf8'), '# Team\n\nAsk platform before changing the style.\n');
  // Catalog 6d9c544 binds the placeholder on the rule file but not on Codex's `AGENTS.md` rule-block merge.
  const shared = rulesRequest('shared', project());
  const block = shared.plan.plan.findIndex(step => step.op === 'merge');
  assert.equal(shared.plan.plan[block].inputs, undefined);
  assert.deepEqual(await prepare(shared, { catalog }), { status: 'refused', code: 'input-binding-missing', step: block, item: 'my-rules.rule.team',
    input: 'TEAM', reason: `Step ${block} places \`rules/team.md\` with the \`TEAM\` placeholder of \`my-rules.rule.team\` but marks no binding for it; replan with a Catalog that marks input places.` });
});
