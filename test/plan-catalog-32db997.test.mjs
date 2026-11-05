// Real Catalog plans through Core (samartomar/aih-core#163): plans, content, profiles and render bytes recorded from the
// @aihq/catalog package built at samartomar/aih-catalog 32db997 (test/fixtures/catalog-32db997), prepared and applied
// through the built public entries in a disposable home and project, then removed. This is real producer output for that
// unreleased candidate; it shows Core carries out its shapes, not that any client loads the result. The AI clients on PATH
// are fakes (test/fixtures/fake-client.mjs and two version-printing scripts); no real client runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { apply, list, prepare, prepareRemoval } from '../dist/core/index.js';
import { validateFormat } from '../dist/core/contracts.js';
import { fakeClientEnv, fakeClientState, installFakeClient } from './fixtures/fake-client.mjs';
import { BYO_SECRET, byoControls, byoRequest, catalog, cbmRequest, recipeRequest, recorded, rulesRequest } from './fixtures/catalog-32db997/replay.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-catalog-32db997-'));
const keys = ['HOME', 'USERPROFILE', 'PATH', 'NODE_OPTIONS', 'FAKE_CLIENT_STATE', 'FAKE_CLIENT_MODE'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const bin = join(scratch, 'bin'), clients = join(scratch, 'clients');
let home;
// Two more fake CLIs the review asks for their versions (D110). The fake `opencode`, like many CLIs, creates its own
// config folder whenever it starts; the fake Cursor CLI (`cursor-agent`) prints a version.
function fakeCli(name, version, folder) {
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') writeFileSync(join(bin, `${name}.cmd`),
    `@echo off\r\n${folder ? `mkdir "%USERPROFILE%\\${folder.replaceAll('/', '\\')}" 2>nul\r\n` : ''}echo ${version}\r\n`);
  else { writeFileSync(join(bin, name), `#!/bin/sh\n${folder ? `mkdir -p "$HOME/${folder}"\n` : ''}echo ${version}\n`); chmodSync(join(bin, name), 0o755); }
}
before(() => {
  home = join(scratch, 'home'); mkdirSync(home);
  fakeCli('opencode', '1.19.5', '.config/opencode'); fakeCli('cursor-agent', '2026.10.1');
  // The fake `claude` and `codex` record the plugin commands Core runs.
  installFakeClient(bin, 'claude'); installFakeClient(bin, 'codex');
  const env = fakeClientEnv(bin, clients);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, ...env,
    PATH: [bin, dirname(process.execPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])].join(delimiter) });
});
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
    if (step.op === 'plugin') continue;
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
  if (step.op === 'plugin') continue;
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
  return removal;
}

for (const scope of ['user', 'project']) test(`the real bring-your-own ${scope} plan for nine clients installs, every file as Catalog planned, and removes`, async () => {
  const target = project();
  // The fake `opencode` makes `~/.config/opencode` when the review asks its version: that folder is the CLI's, never Core's.
  rmSync(join(home, '.config'), { recursive: true, force: true });
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
  assert.equal(existsSync(join(home, '.config', 'opencode')), true, 'removal keeps the folder the CLI made for itself');
});

test('a skill whose `$ARGUMENTS` the six clients sharing one project folder render differently is a truthful Catalog clash, which Core refuses unresolved', async () => {
  // Expected Catalog behaviour, not a gap: Kimi's profile substitutes `$ARGUMENTS` and the other five reword it, so the
  // renders for `.agents/skills/ship` disagree and Catalog reports the clash instead of picking one form.
  assert.deepEqual(recorded.byo.shipClashes.map(clash => [clash.path, clash.reason, clash.items, clash.clis]),
    [['.agents/skills/ship', 'different-content', ['my-skills.skill.ship'], ['antigravity', 'codex', 'copilot', 'cursor', 'dsh', 'kimi']]]);
  const request = byoRequest('project', project());
  request.plan.clashes = structuredClone(recorded.byo.shipClashes);
  assert.equal((await prepare(request, byoControls())).code, 'plan-unresolved');
});

test('on windows-x64, where the AI setup is not qualified, the real cbm plan places no MCP entry: nothing names an unplaced program', async () => {
  const request = cbmRequest(project());
  assert.deepEqual(request.plan.plan, []);
  assert.deepEqual([...new Set(request.plan.unavailable.map(entry => `${entry.item} ${entry.reason}`))].sort(),
    ['cbm.ai-setup.codebase-memory-mcp not-qualified', 'cbm.mcp.codebase-memory-mcp no-qualification', 'cbm.mcp.codebase-memory-mcp unsupported-kind']);
  assert.deepEqual(request.plan.unavailable.filter(entry => entry.reason === 'unsupported-kind').map(entry => entry.cli), ['dsh']);
  const prepared = await prepare(request, { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  assert.deepEqual(prepared.review.steps, []);
});

test('the qualified linux-x64 cbm plan carries settings commands with a restore Core reads, and rootPaths under its acquire step', () => {
  const steps = cbmRequest(project(), 'linux-x64').plan.plan;
  const [acquire] = steps.filter(step => step.op === 'acquire');
  const commands = steps.filter(step => step.op === 'tool-command');
  assert.equal(commands.length, 3);
  for (const step of commands) {
    assert.deepEqual(Object.keys(step).sort(), ['aiSetup', 'approval', 'argv', 'executable', 'qualification', 'readback', 'restore']
      .concat('op').sort());
    assert.deepEqual(step.restore.argv, [...step.argv.slice(0, -1), '<prior>'], 'restore sets the value back in place of the one set');
    assert.deepEqual(step.readback.argv, ['config', 'get', step.argv[2]]);
    assert.equal(step.executable.path, acquire.executable);
  }
  for (const merge of steps.filter(step => step.rootPaths)) for (const rootPath of merge.rootPaths) assert.ok(rootPath.path.startsWith(acquire.into));
});

test('Core lowers the real linux-x64 settings commands: the review shows the readback run first and the restore it plans', async () => {
  // Core-side change of the real plan: only its three tool-commands are kept (the acquire is not run on this host); on
  // Windows the executable path gains `.exe`, as Core runs only an `.exe`, `.com`, `.cmd` or `.bat` there.
  const request = cbmRequest(project(), 'linux-x64');
  request.plan.plan = request.plan.plan.filter(step => step.op === 'tool-command').map(step => process.platform === 'win32' ?
    { ...step, executable: { ...step.executable, path: `${step.executable.path}.exe` } } : step);
  const prepared = await prepare(request, { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  conforms(prepared.review);
  assert.deepEqual(prepared.review.steps.map(step => [step.op, step.program.prior, step.program.restore, step.program.undo]),
    request.plan.plan.map(step => ['tool-command', { argv: step.readback.argv }, { argv: step.restore.argv }, null]));
  assert.deepEqual(prepared.review.steps[0].program.restore.argv, ['config', 'set', 'watcher_enabled', '<prior>']);
});

test('an MCP entry naming an executable no acquire step places and Core never acquired is a plan problem (the P2-3 guard)', async () => {
  // Core-side change of the real linux-x64 plan: its acquire and settings commands dropped, leaving the MCP entries.
  const request = cbmRequest(project(), 'linux-x64');
  request.plan.plan = request.plan.plan.filter(step => step.op !== 'acquire' && step.op !== 'tool-command');
  const rooted = request.plan.plan.flatMap((step, index) => step.rootPaths ? [index] : []);
  assert.ok(rooted.length > 0);
  const refused = await prepare(request, { catalog });
  assert.equal(refused.status, 'invalid', JSON.stringify(refused).slice(0, 2000));
  assert.deepEqual(refused.problems.map(problem => [problem.path, problem.reason]), rooted.map(index => [`/plan/plan/${index}/rootPaths/0`, 'root-path-unplaced']));
  assert.match(refused.problems[0].message, new RegExp(`^Step ${rooted[0]} `));
});

test('an MCP entry naming an executable in a folder Core acquired gets its absolute path under the user root (Catalog rootPaths)', async () => {
  const target = project();
  const request = cbmRequest(target, 'linux-x64');
  // Core-side change as above, and a FIXTURE stand-in for an earlier install's acquired folder: Core's marker file in it.
  request.plan.plan = request.plan.plan.filter(step => step.op !== 'acquire' && step.op !== 'tool-command');
  const folder = join(home, ...request.plan.plan.find(step => step.rootPaths).rootPaths[0].path.split('/').slice(0, -1));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.aih-acquired'), 'Managed by AIH Core: cbm.ai-setup.codebase-memory-mcp 0.12.1 linux-x64\n');
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

test('a real plugin-route recipe plan installs Superpowers on Claude Code and Codex by marketplace name, proven, and removes', async () => {
  const target = project();
  const request = recipeRequest(target);
  assert.deepEqual(request.plan.plan.filter(step => step.op === 'plugin').map(step => [step.cli, step.marketplace, step.marketplaceName]),
    [['claude-code', 'https://github.com/obra/superpowers-marketplace', 'superpowers-marketplace'], ['codex', 'https://github.com/obra/superpowers', 'superpowers-dev']]);
  const prepared = await prepare(request, { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  conforms(prepared.review);
  const origin = { recipe: { ...request.plan.recipe }, data: { ...request.plan.data } };
  assert.deepEqual([prepared.review.origin, prepared.review.originNote], [origin, null]);
  const commit = request.plan.plan.find(step => step.op === 'plugin').commit;
  assert.deepEqual(prepared.review.steps.filter(step => step.op === 'plugin').map(step => step.commands.map(command => command.argv)), [
    [['claude', 'plugin', 'marketplace', 'add', 'https://github.com/obra/superpowers-marketplace', '--scope', 'user'],
      ['claude', 'plugin', 'install', 'superpowers@superpowers-marketplace', '--scope', 'user']],
    [['codex', 'plugin', 'marketplace', 'add', 'https://github.com/obra/superpowers', '--ref', commit], ['codex', 'plugin', 'add', 'superpowers@superpowers-dev']]]);
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  assert.deepEqual([fakeClientState(clients, 'claude').plugins, fakeClientState(clients, 'codex').plugins],
    [['superpowers@superpowers-marketplace'], ['superpowers@superpowers-dev']]);
  placed(request.plan, JSON.parse(JSON.stringify(request.files.map(file => ({ ...file, text: file.bytes.toString('utf8') })))), { user: home, project: target });
  const listed = conforms(await list({ target: { project: target }, scope: 'user' }));
  assert.ok(listed.entries.length > 0 && listed.entries.every(entry => JSON.stringify(entry.origin) === JSON.stringify(origin)), JSON.stringify(listed.entries.map(entry => entry.origin)));
  // A plan that differs from what Catalog reproduces records `chosen`, never blocking.
  const changed = recipeRequest(project());
  changed.recipeProof.choices = { extra: [] };
  const unproven = await prepare(changed, { catalog });
  assert.deepEqual([unproven.status, unproven.review?.origin, unproven.review?.originNote], ['ready', 'chosen', 'origin not proven']);
  await removeAll(target, 'user');
  assert.deepEqual([fakeClientState(clients, 'claude').plugins, fakeClientState(clients, 'codex').plugins], [[], []]);
  gone(request.plan, { user: home, project: target });
});

test('a plan-namespaced name reference is a warning; only a path reference is plan-unresolved', async () => {
  const reference = { kind: 'name', item: 'my-skills.skill.notes', file: 'skills/notes/SKILL.md', name: 'other:plan', clis: ['claude-code'] };
  const named = byoRequest('project', project());
  named.plan.references = [reference];
  const warned = await prepare(named, byoControls());
  assert.equal(warned.status, 'ready');
  assert.deepEqual(warned.review.warnings.filter(text => text.includes('other:plan')),
    ['`skills/notes/SKILL.md` of `my-skills.skill.notes` names `other:plan`, which this plan does not install: it works only where that plugin is installed for claude-code.']);
  const pathed = byoRequest('project', project());
  pathed.plan.references = [{ kind: 'path', item: 'my-skills.skill.notes', file: 'skills/notes/SKILL.md', path: 'docs/missing.md', clis: ['claude-code'] }];
  assert.equal((await prepare(pathed, byoControls())).code, 'plan-unresolved');
});

test('a rule placeholder is filled where the plan binds it: in its own file and in the shared AGENTS.md block', async () => {
  const target = project();
  const prepared = await prepare(rulesRequest('claude', target), { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review), { catalog })).completion, 'complete');
  assert.equal(readFileSync(join(target, '.claude', 'rules', 'team.md'), 'utf8'), '# Team\n\nAsk platform before changing the style.\n');
  // Catalog 32db997 binds the placeholder on Codex's `AGENTS.md` rule-block merge too.
  const sharedTarget = project();
  const shared = rulesRequest('shared', sharedTarget);
  const block = shared.plan.plan.find(step => step.op === 'merge');
  assert.deepEqual(block.inputs, [{ item: 'my-rules.rule.team', input: 'TEAM', at: { placeholder: '{{TEAM}}' } }]);
  const sharedPrepared = await prepare(shared, { catalog });
  assert.equal(sharedPrepared.status, 'ready', JSON.stringify(sharedPrepared).slice(0, 2000));
  assert.equal(conforms(await apply(sharedPrepared.handle, approve(sharedPrepared.review), { catalog })).completion, 'complete');
  const agents = readFileSync(join(sharedTarget, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('Ask platform before changing the style.') && !agents.includes('{{TEAM}}'), agents);
});
