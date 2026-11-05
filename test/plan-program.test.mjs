// Program steps of a plan request (contract 8.1, 12, C30, C60): `tool-command`, `upstream-installer` and
// `upstream-setup`, through the built public entries in a disposable home and project. The AI setup's artifact comes from
// a local HTTPS fixture server; every program is a `fake-tool.cjs` fake and the upstream repository is a local git
// repository (test/fixtures/program-fixture.mjs). These are Core-side fixtures: they prove no real tool or setup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { apply, list, prepare, prepareRemoval } from '../dist/core/index.js';
import { validateFormat } from '../dist/core/contracts.js';
import { artifactServer } from './fixtures/acquire-fixture.mjs';
import { fakeState, installFakePrograms, installerStep, programEnvironment, programRequest, seedToolSettings, toolSetup, upstreamRepository } from './fixtures/program-fixture.mjs';
import { recorded } from './fixtures/catalog-32db997/replay.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-program-'));
const keys = ['HOME', 'USERPROFILE', 'PATH', 'NODE_OPTIONS', 'FAKE_TOOL_STATE', 'FAKE_TOOL_MODE'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const bin = join(scratch, 'bin');
let server, home, state, counter = 0;
before(async () => {
  installFakePrograms(bin);
  server = await artifactServer();
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), server.caPem]);
});
after(async () => {
  await server?.close();
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});
/** A fresh disposable home, project and fake state. */
function fresh(mode = '') {
  home = join(scratch, `home-${counter}`); state = join(scratch, `state-${counter}`); mkdirSync(home);
  const project = join(scratch, `project-${counter++}`); mkdirSync(project);
  Object.assign(process.env, { HOME: home, USERPROFILE: home }, programEnvironment(bin, state, mode));
  return project;
}
const mode = value => { process.env.FAKE_TOOL_MODE = value; };
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const outcomes = run => run.steps.map(step => [step.step, step.managementId, step.application, step.verification.reason]);
const byStep = (run, index) => run.steps.find(step => step.step === index);

test('an acquired tool runs its input-bearing command, reads it back, and its MCP entry follows', async () => {
  const project = fresh();
  const setup = toolSetup(server, { name: 'graph-a', token: true });
  const request = programRequest(project, { setups: [setup] });
  const secret = 'tok-graph-a-1234567890';
  const controls = { privateInputs: { [setup.id]: { TOOL_TOKEN: secret } } };
  const prepared = await prepare(request, controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  assert.ok(!JSON.stringify(prepared.review).includes(secret), 'the review never shows the secret');
  const command = prepared.review.steps.find(step => step.op === 'tool-command');
  assert.equal(command.managementId, setup.id);
  assert.equal(command.effect, 'run-program');
  assert.deepEqual(command.program.argv, ['config', 'set', 'auto_index', 'false']);
  assert.equal(command.program.from, 'acquired');
  assert.equal(command.program.executableSha256, setup.qualification.observed.members[0].sha256);
  assert.deepEqual(command.program.env, [{ name: 'TOOL_TOKEN', value: '[REDACTED]' }]);
  assert.deepEqual(command.program.readback, { argv: ['config', 'get', 'auto_index'], expected: 'false' });
  // The readback runs first and its output is the prior value the restore puts back; the undo is known only then.
  assert.deepEqual([command.program.prior, command.program.restore, command.program.undo],
    [{ argv: ['config', 'get', 'auto_index'] }, { argv: ['config', 'set', 'auto_index', '<prior>'] }, null]);
  assert.match(command.sentence, /^Runs `config get auto_index` and keeps what it shows as the prior value, then runs /);
  assert.match(command.program.cantRemove, /^Removal runs `config set auto_index <prior>` with `<prior>` as the value/);
  assert.match(command.cantPromise, /can't/);
  assert.equal(fakeState(state, 'fake-tool').calls.length, 0, 'Prepare runs nothing');

  const run = conforms(await apply(prepared.handle, approve(prepared.review), controls));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  // Steps run in the plan's order (D92) across items: acquire, the MCP merge, then the tool-command.
  assert.deepEqual(outcomes(run).map(row => row.slice(0, 3)), [[0, setup.id, 'applied'], [1, setup.mcpItem, 'applied'], [2, setup.id, 'applied']]);
  assert.deepEqual(byStep(run, 2).verification, { status: 'passed', reason: 'readback-matched' });
  const calls = fakeState(state, 'fake-tool').calls;
  assert.deepEqual(calls.map(call => call.argv), [['config', 'get', 'auto_index'], ['config', 'set', 'auto_index', 'false'], ['config', 'get', 'auto_index']]);
  assert.equal(calls[1].tokenSha256, createHash('sha256').update(secret).digest('hex'), 'the secret reached the command environment');
  assert.ok(existsSync(join(project, '.mcp.json')));
  for (const where of [join(home, '.aih', 'core')]) assert.ok(!treeHas(where, secret), 'no receipt or history holds the secret');

  const listed = conforms(await list({ target: { project }, scope: 'both' }));
  const entry = listed.entries.find(item => item.managementId === setup.id);
  // The prior value (the fake prints `unset` for a key it never set) is filled into the restore and its readback.
  assert.deepEqual(entry.programs.map(program => [program.op, program.argv, program.executable, program.undo]),
    [['tool-command', ['config', 'set', 'auto_index', 'false'], setup.program,
      { argv: ['config', 'set', 'auto_index', 'unset'], readback: { argv: ['config', 'get', 'auto_index'], expected: 'unset' } }]]);
});

test('the tool-command keys are the ones Catalog 32db997 plans for a real AI setup (cbm on linux-x64)', () => {
  const real = recorded.cbm.plans['linux-x64'].plan.filter(step => step.op === 'tool-command');
  const fixture = toolSetup(server, { name: 'graph-keys' }).toolCommands;
  assert.ok(real.length > 0);
  for (const step of [...real, ...fixture]) assert.deepEqual(Object.keys(step).sort(), ['aiSetup', 'approval', 'argv', 'executable', 'op', 'qualification', 'readback', 'restore']);
  assert.deepEqual(Object.keys(real[0].restore), Object.keys(fixture[0].restore));
  for (const step of [...real, ...fixture]) assert.equal(step.restore.argv.filter(arg => arg === '<prior>').length, 1);
});

/** Whether any file under `dir` holds `text`. */
function treeHas(dir, text) {
  if (!existsSync(dir)) return false;
  const walk = path => {
    for (const name of readdirNames(path)) {
      const full = join(path, name);
      try { if (readFileSync(full).includes(text)) return true; } catch { if (walk(full)) return true; }
    }
    return false;
  };
  return walk(dir);
}
import { readdirSync } from 'node:fs';
const readdirNames = path => { try { return readdirSync(path); } catch { return []; } };

test('a readback that differs fails its step; the MCP merge that already ran stays applied and the run is incomplete', async () => {
  const project = fresh('readback-wrong');
  const setup = toolSetup(server, { name: 'graph-b' });
  const request = programRequest(project, { setups: [setup], skills: [{ name: 'notes', text: '# notes\n' }] });
  const prepared = await prepare(request);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.review.failureRule, 'A failed step stops the rest of its item and every item that depends on it; unrelated items continue.');
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'incomplete', JSON.stringify(run));
  const command = byStep(run, 3);
  assert.deepEqual([command.application, command.verification, command.reason, command.effectsUncertain],
    ['failed', { status: 'failed', reason: 'readback-mismatch' }, 'readback-mismatch', true]);
  // The merge (phase 4) ran before the tool-command (phase 7): it is reported applied, never reordered or rolled back.
  assert.equal(byStep(run, 2).application, 'applied');
  assert.equal(byStep(run, 1).application, 'applied', 'the unrelated skill is applied');
  assert.deepEqual(run.steps.map(step => step.step), [0, 1, 2, 3], 'the plan order');
  assert.ok(existsSync(join(project, '.mcp.json')));
  assert.ok(existsSync(join(project, '.claude', 'skills', 'notes', 'SKILL.md')));
});

test('a failed acquisition leaves its tool-command and its MCP consumer not attempted', async () => {
  const project = fresh();
  const setup = toolSetup(server, { name: 'graph-c' });
  // The served artifact no longer matches the qualification: the hash check fails at Apply.
  server.serve(`/${setup.acquire.distribution.file}`, Buffer.from('not the qualified archive'));
  const prepared = await prepare(programRequest(project, { setups: [setup], skills: [{ name: 'other', text: '# other\n' }] }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'incomplete');
  assert.equal(byStep(run, 0).application, 'failed');
  assert.deepEqual([byStep(run, 3).application, byStep(run, 2).application, byStep(run, 1).application], ['not-attempted', 'not-attempted', 'applied']);
  assert.equal(fakeState(state, 'fake-tool').calls.length, 0, 'the tool never ran');
});

/** Prepares `request` and returns the Apply arguments that approve its review. */
async function approved(request, controls) { const prepared = await prepare(request, controls); assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000)); return [prepared.handle, approve(prepared.review), controls]; }
/** Removes the MCP item first (it needs its AI setup, C60), then prepares the AI setup's removal. */
async function setupRemoval(project, setup) {
  const mcp = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: setup.mcpItem }] });
  assert.equal((await apply(mcp.handle, approve(mcp.review))).completion, 'complete');
  return () => prepareRemoval({ target: { project }, scope: 'user', removals: [{ managementId: setup.id }] });
}

test('removal runs the restore with the value read before install and checks the readback shows it; a mismatch or failure is reported and keeps the receipt', async () => {
  const project = fresh();
  seedToolSettings(state, { auto_index: 'true' });
  const setup = toolSetup(server, { name: 'graph-d' });
  const prepared = await prepare(programRequest(project, { setups: [setup] }));
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  assert.deepEqual(fakeState(state, 'fake-tool').settings, { auto_index: 'false' });
  const removal = await setupRemoval(project, setup);

  mode('set-noop');
  const held = await removal();
  assert.ok(held.review, JSON.stringify(held));
  conforms(held.review);
  const restore = held.review.steps.find(step => step.op === 'tool-command');
  assert.equal(restore.effect, 'run-program');
  assert.deepEqual([restore.program.argv, restore.program.readback], [['config', 'set', 'auto_index', 'true'], { argv: ['config', 'get', 'auto_index'], expected: 'true' }]);
  assert.equal(restore.sentence, 'Runs `config set auto_index true`, then checks that `config get auto_index` reads `true`');
  assert.match(restore.program.executableSha256, /^[a-f0-9]{64}$/);
  const mismatched = conforms(await apply(held.handle, approve(held.review)));
  assert.equal(mismatched.completion, 'incomplete', JSON.stringify(mismatched));
  assert.ok(mismatched.steps.some(step => step.managementId === setup.id && step.verification.reason === 'readback-mismatch'), JSON.stringify(mismatched));
  assert.ok(existsSync(join(home, ...setup.folder.split('/'))), 'the AI setup stays while its undo is unconfirmed');

  mode('set-fail');
  const failing = await removal();
  const failed = conforms(await apply(failing.handle, approve(failing.review)));
  assert.equal(failed.completion, 'incomplete', JSON.stringify(failed));
  assert.ok(failed.steps.some(step => step.managementId === setup.id && step.application === 'failed'), JSON.stringify(failed));
  assert.ok(existsSync(join(home, ...setup.folder.split('/'))), 'a failed restore keeps the AI setup and its receipt');

  mode('');
  const again = await removal();
  const run = conforms(await apply(again.handle, approve(again.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.ok(run.steps.some(step => step.verification.reason === 'readback-matched'));
  assert.deepEqual(fakeState(state, 'fake-tool').settings, { auto_index: 'true' }, 'the value from before install is back');
  assert.equal(existsSync(join(home, ...setup.folder.split('/'))), false, 'the AI setup folder goes with its last claim');
});

test('a prior value that cannot be read fails the step before the command runs', async () => {
  const project = fresh('get-fail');
  const setup = toolSetup(server, { name: 'graph-g' });
  const prepared = await prepare(programRequest(project, { setups: [setup] }));
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'incomplete', JSON.stringify(run));
  const command = byStep(run, 2);
  assert.deepEqual([command.application, command.reason, command.effectsUncertain ?? false, command.verification],
    ['failed', 'prior-unreadable', false, { status: 'failed', reason: 'prior-unreadable' }]);
  assert.deepEqual(fakeState(state, 'fake-tool').calls.map(call => call.argv), [['config', 'get', 'auto_index']], 'the command never ran');
});

test('installing the same command again keeps the first prior value, so removal still puts that one back', async () => {
  const project = fresh();
  seedToolSettings(state, { auto_index: 'true' });
  const setup = toolSetup(server, { name: 'graph-h' });
  const request = programRequest(project, { setups: [setup] });
  assert.equal((await apply(...await approved(request))).completion, 'complete');
  const again = await prepare(request);
  assert.equal(again.status, 'ready', JSON.stringify(again).slice(0, 2000));
  const step = again.review.steps.find(item => item.op === 'tool-command');
  assert.equal(step.program.prior, undefined, 'the readback is not run again');
  assert.deepEqual(step.program.undo, { argv: ['config', 'set', 'auto_index', 'true'], readback: { argv: ['config', 'get', 'auto_index'], expected: 'true' } });
  assert.match(step.sentence, /^Keeps the prior value `true` an earlier install read, then runs /);
  assert.equal(conforms(await apply(again.handle, approve(again.review))).completion, 'complete');
  const removal = await setupRemoval(project, setup);
  const prepared = await removal();
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  assert.deepEqual(fakeState(state, 'fake-tool').settings, { auto_index: 'true' });
});

test('a prior value holding a supplied secret is never recorded: removal says Core cannot restore it', async () => {
  const project = fresh();
  const secret = 'tok-graph-i-1234567890';
  seedToolSettings(state, { auto_index: secret });
  const setup = toolSetup(server, { name: 'graph-i', token: true });
  const controls = { privateInputs: { [setup.id]: { TOOL_TOKEN: secret } } };
  const prepared = await prepare(programRequest(project, { setups: [setup] }), controls);
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review), controls)).completion, 'complete');
  assert.ok(!treeHas(join(home, '.aih', 'core'), secret), 'no receipt or history holds the secret');
  const entry = (await list({ target: { project }, scope: 'user' })).entries.find(item => item.managementId === setup.id);
  assert.equal(entry.programs[0].undo, null);
  const removal = await (await setupRemoval(project, setup))();
  const stated = removal.review.steps.find(item => item.op === 'tool-command');
  assert.equal(stated.effect, 'unchanged');
  assert.match(stated.cantPromise, /can't undo .*no restore command with the value read before it/);
});

test('without a restore command the review and removal say Core cannot undo the command', async () => {
  const project = fresh();
  const setup = toolSetup(server, { name: 'graph-e', restore: false });
  const prepared = await prepare(programRequest(project, { setups: [setup] }));
  const step = prepared.review.steps.find(item => item.op === 'tool-command');
  assert.deepEqual([step.program.undo, step.program.prior, step.program.restore], [null, undefined, undefined]);
  assert.match(step.program.cantRemove, /can't undo .*names no restore command/);
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  assert.deepEqual(fakeState(state, 'fake-tool').calls.map(call => call.argv[1]), ['set', 'get'], 'no readback before the command');
  const removal = await (await setupRemoval(project, setup))();
  const stated = removal.review.steps.find(item => item.op === 'tool-command');
  assert.equal(stated.effect, 'unchanged');
  assert.match(stated.cantPromise, /can't undo/);
  const run = conforms(await apply(removal.handle, approve(removal.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual(fakeState(state, 'fake-tool').settings, { auto_index: 'false' }, 'the setting stays: nothing undid it');
});

test('a restore that is not `{ argv }` with `<prior>` once, as a whole argument, is invalid', async () => {
  for (const restore of [{ argv: ['config', 'set', 'auto_index'] }, { argv: ['config', 'set', 'auto_index', '<prior>', '<prior>'] },
    { argv: ['config', 'set', 'auto_index', 'x<prior>'] }, { argv: ['config', 'set', 'auto_index', '<prior>'], extra: true }]) {
    const project = fresh();
    const setup = toolSetup(server, { name: 'graph-j' });
    const request = programRequest(project, { setups: [setup] });
    request.plan.plan.find(step => step.op === 'tool-command').restore = restore;
    const refused = await prepare(request);
    assert.equal(refused.status, 'invalid', JSON.stringify(refused));
    assert.match(JSON.stringify(refused.problems), /restore/);
  }
});

test('an upstream installer runs its exact pinned argv, is managed: false, and removal says what Core cannot remove', async () => {
  const project = fresh();
  const installer = installerStep();
  const prepared = await prepare(programRequest(project, { installers: [installer] }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  const [step] = prepared.review.steps;
  assert.equal(step.op, 'upstream-installer');
  assert.deepEqual([step.program.managed, step.program.from, step.program.argv], [false, 'path', ['fake-installer', 'install', 'other-tool', '--yes']]);
  assert.match(step.program.executableSha256, /^[a-f0-9]{64}$/);
  assert.match(step.cantPromise, /managed: false/);
  assert.equal(existsSync(join(home, '.fake-installed')), false);
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.deepEqual(outcomes(run), [[0, installer.id, 'applied', 'command-effects-unknown']]);
  assert.equal(readFileSync(join(home, '.fake-installed'), 'utf8'), 'install other-tool --yes\n');
  const removal = await prepareRemoval({ target: { project }, scope: 'user', removals: [{ managementId: installer.id }] });
  assert.ok(removal.review, JSON.stringify(removal));
  assert.match(removal.review.steps.find(item => item.op === 'upstream-installer').cantPromise, /can't remove/);
  assert.equal(conforms(await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.ok(existsSync(join(home, '.fake-installed')), 'what the installer wrote stays');
  assert.equal((await list({ target: { project }, scope: 'user' })).entries.length, 0);
});

test('an installer this host cannot run is refused before any effect', async () => {
  const project = fresh();
  const installer = installerStep('missing-tool');
  installer.step.argv = ['no-such-installer', 'go'];
  const refused = await prepare(programRequest(project, { installers: [installer] }));
  assert.deepEqual([refused.status, refused.code, refused.step], ['refused', 'program-unavailable', 0]);
});

test('an upstream setup clones the exact commit, runs its command there, and removal takes the clone only', async () => {
  const project = fresh();
  const upstream = upstreamRepository(scratch, home);
  const prepared = await prepare(programRequest(project, { upstream: [upstream] }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  const [step] = prepared.review.steps;
  assert.equal(step.managementId, 'gstack');
  assert.deepEqual([step.program.clone.repository, step.program.clone.commit, step.program.needs], [upstream.step.repository, upstream.commit, ['bun>=1.4.2']]);
  assert.match(step.program.clone.gitSha256, /^[a-f0-9]{64}$/);
  assert.match(step.cantPromise, /can't/);
  const clone = join(home, '.claude', 'skills', 'gstack');
  assert.equal(existsSync(clone), false, 'Prepare clones nothing');
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual(outcomes(run), [[0, 'gstack', 'applied', 'command-effects-unknown']]);
  assert.equal(readFileSync(join(clone, 'README.md'), 'utf8').replaceAll('\r\n', '\n'), 'upstream setup fixture\n');
  assert.ok(existsSync(join(clone, 'built.txt')), 'the command ran inside the clone');
  const [call] = fakeState(state, 'fake-setup').calls;
  assert.deepEqual(call.argv, ['setup', '--host', 'claude']);
  const removal = await prepareRemoval({ target: { project }, scope: 'user', removals: [{ managementId: 'gstack' }] });
  assert.match(removal.review.steps.find(item => item.op === 'upstream-setup').cantPromise, /only its clone/);
  assert.equal(conforms(await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.equal(existsSync(clone), false, 'the clone goes');
  assert.ok(existsSync(join(home, '.fake-setup-outside')), 'what the command wrote elsewhere stays');
});

test('an upstream setup folder holding files Core did not clone is refused before any effect', async () => {
  const project = fresh();
  const upstream = upstreamRepository(scratch, home);
  mkdirSync(join(home, '.claude', 'skills', 'gstack'), { recursive: true });
  const refused = await prepare(programRequest(project, { upstream: [upstream] }));
  assert.deepEqual([refused.status, refused.code], ['refused', 'setup-folder-occupied']);
});

test('a cancelled command is effectsUncertain, leaves the install interrupted, and is shown again for fresh approval', async () => {
  const project = fresh('set-hang');
  const setup = toolSetup(server, { name: 'graph-f' });
  const request = programRequest(project, { setups: [setup] });
  const prepared = await prepare(request);
  const controller = new AbortController();
  const started = join(state, 'fake-tool.started');
  const watch = setInterval(() => { if (existsSync(started)) controller.abort(); }, 50);
  const run = conforms(await apply(prepared.handle, approve(prepared.review), { signal: controller.signal }));
  clearInterval(watch);
  assert.equal(run.completion, 'cancelled', JSON.stringify(run));
  assert.equal(byStep(run, 2).effectsUncertain, true, JSON.stringify(run));
  const listed = await list({ target: { project }, scope: 'user' });
  const interrupted = listed.entries.find(entry => entry.managementId === setup.id);
  assert.equal(interrupted.installState, 'interrupted');
  // The prior value was kept before the command started, so the interrupted install can still be restored.
  assert.deepEqual(interrupted.programs[0].undo, { argv: ['config', 'set', 'auto_index', 'unset'], readback: { argv: ['config', 'get', 'auto_index'], expected: 'unset' } });
  mode('');
  const again = await prepare(request);
  assert.equal(again.status, 'ready', JSON.stringify(again));
  const step = again.review.steps.find(item => item.op === 'tool-command');
  assert.equal(step.previous, 'interrupted');
  assert.deepEqual([step.program.prior, step.program.undo?.readback.expected], [undefined, 'unset'], 'the kept prior value is not read again');
  assert.match(step.cantPromise, /interrupted, so its effects are uncertain/);
  const finished = conforms(await apply(again.handle, approve(again.review)));
  assert.equal(finished.completion, 'complete', JSON.stringify(finished));
  assert.equal((await list({ target: { project }, scope: 'user' })).entries.find(entry => entry.managementId === setup.id).installState, 'complete');
});

for (const [label, value] of [['a NUL', 'a\u0000b'], ['an ANSI escape', '\u001b[31mred\u001b[0m']]) test(`a prior value holding ${label} is unreadable: the step fails before the command runs`, async () => {
  const project = fresh();
  seedToolSettings(state, { auto_index: value });
  const setup = toolSetup(server, { name: `graph-c${label.length}` });
  const prepared = await prepare(programRequest(project, { setups: [setup] }));
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.deepEqual([byStep(run, 2).application, byStep(run, 2).reason], ['failed', 'prior-unreadable']);
  assert.deepEqual(fakeState(state, 'fake-tool').calls.map(call => call.argv[1]), ['get'], 'the command never ran');
  // The receipt stays readable: nothing holding the control character was recorded.
  assert.ok(conforms(await list({ target: { project }, scope: 'user' })).entries.some(entry => entry.managementId === setup.id));
});

test('on Windows a prior value a command shim could not pass back fails the step before the command runs', { skip: process.platform !== 'win32' }, async () => {
  const project = fresh();
  seedToolSettings(state, { auto_index: '50%' });
  const setup = toolSetup(server, { name: 'graph-k', shim: true });
  const prepared = await prepare(programRequest(project, { setups: [setup] }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared).slice(0, 2000));
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.deepEqual([byStep(run, 2).application, byStep(run, 2).reason, byStep(run, 2).effectsUncertain ?? false], ['failed', 'prior-unrestorable', false]);
  assert.deepEqual(fakeState(state, 'fake-tool').calls.map(call => call.argv[1]), ['get'], 'the command never ran');
  assert.deepEqual(fakeState(state, 'fake-tool').settings, { auto_index: '50%' });
});

test('an empty prior value is restored as empty', async () => {
  const project = fresh();
  seedToolSettings(state, { auto_index: '' });
  const setup = toolSetup(server, { name: 'graph-l' });
  assert.equal((await apply(...await approved(programRequest(project, { setups: [setup] })))).completion, 'complete');
  const entry = (await list({ target: { project }, scope: 'user' })).entries.find(item => item.managementId === setup.id);
  assert.deepEqual(entry.programs[0].undo, { argv: ['config', 'set', 'auto_index', ''], readback: { argv: ['config', 'get', 'auto_index'], expected: '' } });
  const removal = await (await setupRemoval(project, setup))();
  assert.equal(conforms(await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.deepEqual(fakeState(state, 'fake-tool').settings, { auto_index: '' });
});

test('a prior value holding a secret bound anywhere in the plan is withheld, and reinstalling never reads it again', async () => {
  const project = fresh();
  const secret = 'tok-graph-m-1234567890';
  // The secret is bound to graph-m's commands only; graph-n's prior value holds it.
  seedToolSettings(state, { index_n: secret });
  const holder = toolSetup(server, { name: 'graph-m', token: true });
  const other = toolSetup(server, { name: 'graph-n', settings: [['index_n', 'false']] });
  const controls = { privateInputs: { [holder.id]: { TOOL_TOKEN: secret } } };
  const request = programRequest(project, { setups: [holder, other] });
  assert.equal((await apply(...await approved(request, controls))).completion, 'complete');
  assert.ok(!treeHas(join(home, '.aih', 'core'), secret), 'no receipt or history holds the secret');
  const program = () => (/** @type {any} */ (list({ target: { project }, scope: 'user' }))).then(listed => listed.entries.find(item => item.managementId === other.id).programs[0]);
  assert.deepEqual([(await program()).undo, (await program()).prior], [null, 'withheld']);
  // Reinstalling keeps the withheld record: the readback is not run again before the command.
  seedToolSettings(state, { index_n: 'plain' });
  const again = await prepare(request, controls);
  assert.equal(again.review.steps.find(step => step.managementId === other.id && step.op === 'tool-command').program.prior, undefined);
  assert.equal(conforms(await apply(again.handle, approve(again.review), controls)).completion, 'complete');
  assert.deepEqual(fakeState(state, 'fake-tool').calls.filter(call => call.argv[2] === 'index_n').map(call => call.argv[1]), ['set', 'get']);
  assert.deepEqual([(await program()).undo, (await program()).prior], [null, 'withheld']);
});
