// Real Catalog plans through Core (samartomar/aih-core#163): plans, content, profiles and render bytes recorded from the
// @aihq/catalog package built at samartomar/aih-catalog 26df4c0 (test/fixtures/catalog-26df4c0), prepared and applied
// through the built public entries in a disposable home and project, then removed. This is real producer output for that
// unreleased candidate; it shows Core carries out its shapes, not that any client loads the result. The AI clients on PATH
// are fakes (test/fixtures/fake-client.mjs and two version-printing scripts); no real client runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { apply, list, prepare, prepareRemoval } from '../dist/core/index.js';
import { validateFormat } from '../dist/core/contracts.js';
import { fakeClientEnv, fakeClientState, installFakeClient } from './fixtures/fake-client.mjs';
import { artifactServer, nativeSetup, setupRequest } from './fixtures/acquire-fixture.mjs';
import tls from 'node:tls';
import { BYO_SECRET, byoControls, byoRequest, catalog, cbmRequest, recipeRequest, recorded, rulesRequest } from './fixtures/catalog-26df4c0/replay.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-catalog-26df4c0-'));
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
let server;
before(async () => {
  server = await artifactServer();
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), server.caPem]);
  home = join(scratch, 'home'); mkdirSync(home);
  fakeCli('opencode', '1.19.5', '.config/opencode'); fakeCli('cursor-agent', '2026.10.1');
  // The fake `claude` and `codex` record the plugin commands Core runs.
  installFakeClient(bin, 'claude'); installFakeClient(bin, 'codex');
  const env = fakeClientEnv(bin, clients);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, ...env,
    PATH: [bin, dirname(process.execPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])].join(delimiter) });
});
after(async () => { await server?.close(); for (const [key, value] of Object.entries(previous)) {
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
 * config file the engine created goes with its last entry; one that was there before keeps everything else.)
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
/** A run's outcome without the steps that finished, so a failure names what stopped it. */
const unfinished = run => JSON.stringify({ ...run, steps: run.steps?.filter(step => !['applied', 'already-satisfied'].includes(step.application)) }).slice(0, 6000);
async function removeAll(target, scope) {
  const entries = conforms(await list({ target: { project: target }, scope })).entries;
  const removal = await prepareRemoval({ target: { project: target }, scope, removals: entries.map(entry => ({ managementId: entry.managementId })) },
    byoControls());
  assert.equal(removal.status, 'ok', JSON.stringify(removal).slice(0, 2000));
  const done = conforms(await apply(removal.handle, approve(removal.review), byoControls()));
  assert.equal(done.completion, 'complete', unfinished(done));
  return removal;
}

for (const scope of ['user']) test(`the real bring-your-own ${scope} plan for nine clients installs, every file as Catalog planned, and removes`, async () => {
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
  assert.equal(run.completion, 'complete', unfinished(run));
  const roots = { user: home, project: target };
  placed(request.plan, recorded.byo.files, roots);
  if (scope === 'project') {
    // Catalog 26df4c0's Cursor and OpenCode profiles declare their own environment reference for MCP env: their files
    // hold the reference, never the secret, as Claude Code's does; a client with none (Copilot) holds the value.
    const cursor = JSON.parse(readFileSync(join(target, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(cursor.mcpServers['exa-web-search'].env.EXA_API_KEY, '${env:EXA_API_KEY}');
    const opencode = JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'));
    assert.equal(opencode.mcp['exa-web-search'].environment.EXA_API_KEY, '{env:EXA_API_KEY}');
    const claude = JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8'));
    assert.equal(claude.mcpServers['exa-web-search'].env.EXA_API_KEY, '${EXA_API_KEY}');
    const copilot = JSON.parse(readFileSync(join(target, '.github', 'mcp.json'), 'utf8'));
    assert.equal(copilot.mcpServers['exa-web-search'].env.EXA_API_KEY, BYO_SECRET);
  }
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

/**
 * Acquisitions Core recorded earlier, so a plan that keeps only the real tool-commands or MCP entries runs programs Core
 * placed (a receipt, never a marker file alone, proves one): for each real acquire step, a Core-side FIXTURE native
 * archive for this host's cell holding that step's program, acquired through the public API from a local HTTPS server.
 * The plan's linux-x64 program paths are replaced by those folders' (the same paths on linux-x64, with `.exe` on Windows).
 */
async function acquiredEarlier(request, acquires = [recorded.cbm.plans['linux-x64'].plan.find(step => step.op === 'acquire')]) {
  const target = project();
  const setups = acquires.map(real => {
    const into = real.into.replace(/\/$/, '');
    const relative = real.executable.slice(into.length + 1);
    const member = process.platform === 'win32' ? `${relative}.exe` : relative;
    const setup = nativeSetup(server, { name: into.split('/')[2], version: real.version, id: real.aiSetup,
      members: { [member]: process.platform === 'win32' ? 'MZ fixture\n' : '#!/bin/sh\necho fixture\n', LICENSE: 'MIT\n' } });
    setup.step.executable = `${setup.folder}/${member}`;
    request.plan.plan = JSON.parse(JSON.stringify(request.plan.plan).split(`${into}/${relative}`).join(`${setup.folder}/${member}`));
    return setup;
  });
  const installed = await prepare({ ...setupRequest(target, setups), scope: 'user' });
  assert.equal(installed.status, 'ready', JSON.stringify(installed).slice(0, 1500));
  assert.equal((await apply(installed.handle, approve(installed.review))).completion, 'complete');
  earlier = { target, setups };
  return request;
}
let earlier;
/** Removes those acquisitions again through reviewed removals, so later tests see none. */
async function forgetEarlier() {
  if (!earlier) return;
  for (const setup of earlier.setups) {
    const removal = await prepareRemoval({ target: { project: earlier.target }, scope: 'user', removals: [{ managementId: setup.id }] });
    assert.ok(removal.handle, JSON.stringify(removal).slice(0, 1500));
    assert.equal((await apply(removal.handle, approve(removal.review))).completion, 'complete');
  }
  earlier = undefined;
}

test('Core lowers the real linux-x64 settings commands: the review shows the readback run first and the restore it plans', async () => {
  // Core-side change of the real plan: only its three tool-commands are kept (the acquire is not run on this host, and
  // an earlier acquisition's marker stands in for it); on Windows the executable path gains `.exe`, as Core runs only an
  // `.exe`, `.com`, `.cmd` or `.bat` there.
  const request = cbmRequest(project(), 'linux-x64');
  request.plan.plan = request.plan.plan.filter(step => step.op === 'tool-command');
  await acquiredEarlier(request);
  const prepared = await prepare(request, { catalog }).finally(forgetEarlier);
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
  // With no acquisition of its AI setup, the MCP item is bound to the server.json its content lists, whose bytes this
  // plan doesn't carry.
  const withheld = await prepare(request, { catalog });
  assert.deepEqual([withheld.status, withheld.code], ['refused', 'source-missing'], JSON.stringify(withheld).slice(0, 600));
  // Core-side change: the item's server.json listing dropped too, leaving only the program its entries name.
  for (const content of request.contents) for (const item of content.items ?? [])
    if (item.kind === 'mcp') item.files = item.files.filter(file => file.sourcePath.split('/').at(-1) !== 'server.json');
  const refused = await prepare(request, { catalog });
  assert.equal(refused.status, 'invalid', JSON.stringify(refused).slice(0, 2000));
  assert.deepEqual(refused.problems.map(problem => [problem.path, problem.reason]), rooted.map(index => [`/plan/plan/${index}/rootPaths/0`, 'root-path-unplaced']));
  assert.match(refused.problems[0].message, new RegExp(`^Step ${rooted[0]} `));
});

test('an MCP entry naming an executable in a folder Core acquired gets its absolute path under the user root (Catalog rootPaths)', async () => {
  const target = project();
  const request = cbmRequest(target, 'linux-x64');
  // Core-side change as above, and an earlier acquisition of the program the entries start (FIXTURE, see `acquiredEarlier`).
  request.plan.plan = request.plan.plan.filter(step => step.op !== 'acquire' && step.op !== 'tool-command');
  await acquiredEarlier(request);
  const prepared = await prepare(request, { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 3000));
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const step = request.plan.plan.find(entry => entry.op === 'merge' && entry.format === 'json' && entry.clis.includes('claude-code'));
  const [rootPath] = step.rootPaths;
  const written = JSON.parse(readFileSync(join(target, step.file), 'utf8'));
  assert.equal(written.mcpServers['codebase-memory-mcp'].command, join(home, ...rootPath.path.split('/')));
  const toml = readFileSync(join(target, '.codex', 'config.toml'), 'utf8');
  assert.ok(toml.includes(JSON.stringify(join(home, ...rootPath.path.split('/')))), toml);
  for (const managementId of [...new Set(request.plan.plan.map(entry => entry.item))]) {
    const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId }] });
    if (removal.handle) await apply(removal.handle, approve(removal.review));
  }
  await forgetEarlier();
  rmSync(join(home, '.aihq'), { recursive: true, force: true });
});

test('a real plugin-route recipe plan installs Superpowers on Claude Code from its pinned local marketplace and on Codex by name, proven, and removes', async () => {
  const target = project();
  const request = recipeRequest('superpowers', target);
  const commit = request.plan.plan.find(step => step.op === 'plugin').commit;
  // Catalog 26df4c0: Claude's marketplace is one the plan writes (pinned by commit), named `aihq-<framework>`.
  assert.deepEqual(request.plan.plan.filter(step => step.op === 'plugin').map(step => [step.cli, step.marketplace, step.marketplaceName, step.pin]),
    [['claude-code', { root: 'user', path: '.aihq/marketplaces/claude-code/superpowers' }, 'aihq-superpowers', undefined],
      ['codex', 'https://github.com/obra/superpowers', 'superpowers-dev', undefined]]);
  const marketplace = join(home, '.aihq', 'marketplaces', 'claude-code', 'superpowers');
  const prepared = await prepare(request, { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  conforms(prepared.review);
  const origin = { recipe: { ...request.plan.recipe }, data: { ...request.plan.data } };
  assert.deepEqual([prepared.review.origin, prepared.review.originNote], [origin, null]);
  assert.deepEqual(prepared.review.steps.filter(step => step.op === 'plugin').map(step => step.commands.map(command => command.argv)), [
    [['claude', 'plugin', 'marketplace', 'add', marketplace, '--scope', 'user'], ['claude', 'plugin', 'install', 'superpowers@aihq-superpowers', '--scope', 'user']],
    [['codex', 'plugin', 'marketplace', 'add', 'https://github.com/obra/superpowers', '--ref', commit], ['codex', 'plugin', 'add', 'superpowers@superpowers-dev']]]);
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  assert.deepEqual([fakeClientState(clients, 'claude').plugins, fakeClientState(clients, 'codex').plugins],
    [['superpowers@aihq-superpowers'], ['superpowers@superpowers-dev']]);
  // The marketplace file Catalog rendered was in place when Claude added the folder, and it pins the plugin's commit.
  const added = JSON.parse(fakeClientState(clients, 'claude').marketplaceFiles[marketplace]);
  assert.equal(added.name, 'aihq-superpowers');
  assert.ok(JSON.stringify(added).includes(commit), JSON.stringify(added));
  placed(request.plan, JSON.parse(JSON.stringify(request.files.map(file => ({ ...file, text: file.bytes.toString('utf8') })))), { user: home, project: target });
  const listed = conforms(await list({ target: { project: target }, scope: 'user' }));
  assert.ok(listed.entries.length > 0 && listed.entries.every(entry => JSON.stringify(entry.origin) === JSON.stringify(origin)), JSON.stringify(listed.entries.map(entry => entry.origin)));
  // A plan that differs from what Catalog reproduces records `chosen`, never blocking.
  const changed = recipeRequest('superpowers', project());
  changed.recipeProof.choices = { extra: [] };
  const unproven = await prepare(changed, { catalog });
  assert.deepEqual([unproven.status, unproven.review?.origin, unproven.review?.originNote], ['ready', 'chosen', 'origin not proven']);
  await removeAll(target, 'user');
  // Codex removes a plugin only by its marketplace-qualified name.
  assert.deepEqual(fakeClientState(clients, 'codex').calls.at(-1), ['plugin', 'remove', 'superpowers@superpowers-dev']);
  assert.deepEqual(fakeClientState(clients, 'claude').calls.at(-1), ['plugin', 'uninstall', 'superpowers']);
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
  // Catalog 26df4c0 binds the placeholder on Codex's `AGENTS.md` rule-block merge too.
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

test('a plugin step whose pin Catalog marks unverified says so in the review: Core cannot check the installed commit', async () => {
  // Core-side change of the real plan: no shipped profile leaves a pin unchecked now, so the Codex step is marked the way
  // Catalog marks a step whose install names no commit and writes no marketplace.
  const request = recipeRequest('superpowers', project());
  const at = request.plan.plan.findIndex(step => step.op === 'plugin' && step.cli === 'codex');
  request.plan.plan[at].pin = 'unverified';
  const prepared = await prepare(request, { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  conforms(prepared.review);
  const [claude, codex] = prepared.review.steps.filter(step => step.op === 'plugin');
  assert.deepEqual([claude.pin, codex.pin], [undefined, 'unverified']);
  assert.match(codex.cantPromise, /^The plan marks this pin unverified: the CLI may install another commit than 5bf4e78011075bcfc0dc295f0724994cd123ee71, and nothing checks the installed one\. /);
  assert.equal(claude.cantPromise.includes('unverified:'), false);
  // Any other pin value is not Catalog's shape.
  const bad = recipeRequest('superpowers', project());
  bad.plan.plan[at].pin = 'holds';
  const refused = await prepare(bad, { catalog });
  assert.deepEqual([refused.status, refused.problems?.map(problem => problem.path)], ['invalid', [`/plan/plan/${at}/pin`]]);
});

test('a settings command with no qualification (a recipe\'s replacement settings) is lowered and its review says no qualification ran it', async () => {
  // Core-side change of the real linux-x64 plan, as in the test above, with each command's qualification dropped: the
  // shape Catalog 26df4c0 plans for a recipe's own settings.
  const request = cbmRequest(project(), 'linux-x64');
  request.plan.plan = request.plan.plan.filter(step => step.op === 'tool-command').map(({ qualification, ...step }) => step);
  await acquiredEarlier(request);
  const prepared = await prepare(request, { catalog }).finally(forgetEarlier);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  conforms(prepared.review);
  for (const step of prepared.review.steps)
    assert.match(step.cantPromise, /No qualification ran this command: it is the recipe's own setting\./, step.cantPromise);
  // A qualification that is present is still checked.
  const wrong = cbmRequest(project(), 'linux-x64');
  wrong.plan.plan = wrong.plan.plan.filter(step => step.op === 'tool-command').map(step => ({ ...step, qualification: 'not-a-digest' }));
  assert.equal((await prepare(wrong, { catalog })).status, 'invalid');
});

test('Catalog\'s real EGM recipe plan installs at project scope (local plugins, bundle, Codex items), proven, and removes', async () => {
  const target = project();
  const request = recipeRequest('egm', target);
  assert.deepEqual([request.plan.status, request.plan.unavailable, request.plan.clashes], ['ok', [], []]);
  const prepared = await prepare(request, { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  conforms(prepared.review);
  assert.deepEqual([prepared.review.origin, prepared.review.originNote], [{ recipe: { ...request.plan.recipe }, data: { ...request.plan.data } }, null]);
  const run = conforms(await apply(prepared.handle, approve(prepared.review), { catalog }));
  assert.equal(run.completion, 'complete', JSON.stringify(run).slice(0, 2000));
  const files = request.files.map(file => ({ ...file, text: file.bytes.toString('utf8') }));
  placed(request.plan, files, { user: home, project: target });
  // Claude reads the local plugin from the marketplace the settings register.
  const settings = JSON.parse(readFileSync(join(target, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(settings).sort(), ['enabledPlugins', 'extraKnownMarketplaces']);
  assert.ok(existsSync(join(target, '.aihq', 'plugins', 'egm', 'LICENSE')), 'the upstream LICENSE lands with the plugin');
  await removeAll(target, 'project');
  gone(request.plan, { user: home, project: target });
});

test('Catalog\'s real tool-trio plan for linux-x64: refused on another cell; its MCP entries and notices install over acquired folders', async t => {
  const request = recipeRequest('trio', project());
  assert.deepEqual(request.plan.plan.filter(step => step.op === 'acquire').map(step => step.aiSetup),
    ['crg.ai-setup.code-review-graph', 'cbm.ai-setup.codebase-memory-mcp', 'serena.ai-setup.serena']);
  if (`${process.platform}-${process.arch}` !== 'linux-x64') {
    const refused = await prepare(request, { catalog });
    assert.deepEqual([refused.status, refused.code], ['refused', 'cell-mismatch']);
    // Each acquire step alone is that cell's well-formed step (its executable named as on linux-x64), refused only for the cell.
    for (const step of request.plan.plan.filter(entry => entry.op === 'acquire')) {
      const alone = recipeRequest('trio', project());
      alone.plan.plan = [step];
      const result = await prepare(alone, { catalog });
      assert.deepEqual([result.status, result.code, result.step], ['refused', 'cell-mismatch', 0], JSON.stringify(result).slice(0, 600));
    }
  } else t.diagnostic('on linux-x64 the acquire steps would download: not run here');
  // Core-side change: the acquire and settings steps dropped (they need the linux-x64 downloads), and earlier acquisitions of
  // the programs the entries start (FIXTURE, see `acquiredEarlier`).
  const target = project();
  const changed = recipeRequest('trio', target);
  const acquires = changed.plan.plan.filter(step => step.op === 'acquire');
  changed.plan.plan = changed.plan.plan.filter(step => step.op !== 'acquire' && step.op !== 'tool-command');
  await acquiredEarlier(changed, acquires);
  const prepared = await prepare(changed, { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  conforms(prepared.review);
  assert.deepEqual([prepared.review.origin, prepared.review.originNote], ['chosen', 'origin not proven']);
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review), { catalog })).completion, 'complete');
  const mcp = JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(mcp).sort(), ['code-review-graph', 'codebase-memory-mcp', 'serena']);
  for (const step of changed.plan.plan.filter(entry => entry.op === 'merge' && entry.file === '.mcp.json'))
    assert.equal(mcp[step.key.split('/').at(-1)].command, join(home, ...step.rootPaths[0].path.split('/')));
  assert.ok(existsSync(join(target, '.aihq', 'notices', 'serena', 'LICENSES', 'MIT.txt')));
  await removeAll(target, 'project');
  gone(changed.plan, { user: home, project: target });
  await forgetEarlier();
  rmSync(join(home, '.aihq', 'ai-setup'), { recursive: true, force: true });
});

test('an AI setup settings file Catalog places under .aihq/ai-setup/<name>/settings/ installs and removes like any write', async () => {
  // Core-side FIXTURE: Catalog's data names no settings file yet, so the real cbm content gains one AI-setup file and
  // the plan one write step of the shape Catalog 26df4c0 plans for it (`from.item` the AI setup, the user root).
  const target = project();
  const request = cbmRequest(target, 'linux-x64');
  const text = '{ "watcher": false }\n';
  const sha = createHash('sha256').update(text).digest('hex');
  const setup = request.contents[0].items.find(item => item.kind === 'ai-setup');
  setup.files = [{ sourceId: 'cbm', sourcePath: 'settings/config.json', sha256: sha, bytes: Buffer.byteLength(text), executable: false, role: 'content' }];
  const path = `.aihq/ai-setup/${setup.name}/settings/config.json`;
  request.plan.plan = [{ op: 'write', root: 'user', path, from: { item: setup.id, sourceId: 'cbm', sourcePath: 'settings/config.json', sha256: sha },
    executable: false, item: setup.id, clis: ['claude-code', 'codex'] }];
  request.files.push({ sourceId: 'cbm', sourcePath: 'settings/config.json', sha256: sha, bytes: Buffer.from(text) });
  const prepared = await prepare(request, { catalog });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  assert.equal(readFileSync(join(home, ...path.split('/')), 'utf8'), text);
  await removeAll(target, 'user');
  assert.equal(existsSync(join(home, ...path.split('/'))), false);
});
