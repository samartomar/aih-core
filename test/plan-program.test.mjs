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
import { fakeState, installFakePrograms, installerStep, programEnvironment, programRequest, toolSetup, upstreamRepository } from './fixtures/program-fixture.mjs';

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
  assert.deepEqual(command.program.undo.argv, ['config', 'unset', 'auto_index']);
  assert.match(command.cantPromise, /can't/);
  assert.equal(fakeState(state, 'fake-tool').calls.length, 0, 'Prepare runs nothing');

  const run = conforms(await apply(prepared.handle, approve(prepared.review), controls));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  // The MCP item depends on its AI setup (C60): it runs after the setup's steps.
  assert.deepEqual(outcomes(run).map(row => row.slice(0, 3)), [[0, setup.id, 'applied'], [2, setup.id, 'applied'], [1, setup.mcpItem, 'applied']]);
  assert.deepEqual(byStep(run, 2).verification, { status: 'passed', reason: 'readback-matched' });
  const calls = fakeState(state, 'fake-tool').calls;
  assert.deepEqual(calls.map(call => call.argv), [['config', 'set', 'auto_index', 'false'], ['config', 'get', 'auto_index']]);
  assert.equal(calls[0].tokenSha256, createHash('sha256').update(secret).digest('hex'), 'the secret reached the command environment');
  assert.ok(existsSync(join(project, '.mcp.json')));
  for (const where of [join(home, '.aih', 'core')]) assert.ok(!treeHas(where, secret), 'no receipt or history holds the secret');

  const listed = conforms(await list({ target: { project }, scope: 'both' }));
  const entry = listed.entries.find(item => item.managementId === setup.id);
  assert.deepEqual(entry.programs.map(program => [program.op, program.argv, program.executable, program.undo.argv]),
    [['tool-command', ['config', 'set', 'auto_index', 'false'], setup.program, ['config', 'unset', 'auto_index']]]);
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

test('a readback that differs fails its step; the item and its MCP dependant stop, an unrelated item continues', async () => {
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
  assert.equal(byStep(run, 2).application, 'not-attempted', 'the MCP entry that starts the tool is not attempted');
  assert.equal(byStep(run, 1).application, 'applied', 'the unrelated skill is applied');
  assert.equal(existsSync(join(project, '.mcp.json')), false);
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

test('removal runs the saved reverse command and its readback; a reverse whose readback differs keeps the receipt', async () => {
  const project = fresh();
  const setup = toolSetup(server, { name: 'graph-d' });
  const prepared = await prepare(programRequest(project, { setups: [setup] }));
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  // The MCP item needs its AI setup (C60): it goes first, then the AI setup.
  const mcp = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: setup.mcpItem }] });
  assert.equal((await apply(mcp.handle, approve(mcp.review))).completion, 'complete');
  const removalRequest = { target: { project }, scope: 'user', removals: [{ managementId: setup.id }] };

  mode('unset-noop');
  const held = await prepareRemoval(removalRequest);
  assert.ok(held.review, JSON.stringify(held));
  conforms(held.review);
  const reverse = held.review.steps.find(step => step.op === 'tool-command');
  assert.equal(reverse.effect, 'run-program');
  assert.deepEqual(reverse.program.argv, ['config', 'unset', 'auto_index']);
  assert.match(reverse.program.executableSha256, /^[a-f0-9]{64}$/);
  const failed = conforms(await apply(held.handle, approve(held.review)));
  assert.equal(failed.completion, 'incomplete', JSON.stringify(failed));
  assert.ok(failed.steps.some(step => step.managementId === setup.id && step.verification.reason === 'readback-mismatch'), JSON.stringify(failed));
  assert.ok(existsSync(join(home, ...setup.folder.split('/'))), 'the AI setup stays while its undo is unconfirmed');

  mode('');
  const removal = await prepareRemoval(removalRequest);
  const run = conforms(await apply(removal.handle, approve(removal.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.ok(run.steps.some(step => step.verification.reason === 'readback-matched'));
  assert.deepEqual(fakeState(state, 'fake-tool').settings, {});
  assert.equal(existsSync(join(home, ...setup.folder.split('/'))), false, 'the AI setup folder goes with its last claim');
});

test('without a reverse command the review and removal say Core cannot undo the command', async () => {
  const project = fresh();
  const setup = toolSetup(server, { name: 'graph-e', reverse: false });
  const prepared = await prepare(programRequest(project, { setups: [setup] }));
  const step = prepared.review.steps.find(item => item.op === 'tool-command');
  assert.equal(step.program.undo, null);
  assert.match(step.program.cantRemove, /can't undo/);
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const mcp = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: setup.mcpItem }] });
  assert.equal((await apply(mcp.handle, approve(mcp.review))).completion, 'complete');
  const removal = await prepareRemoval({ target: { project }, scope: 'user', removals: [{ managementId: setup.id }] });
  const stated = removal.review.steps.find(item => item.op === 'tool-command');
  assert.equal(stated.effect, 'unchanged');
  assert.match(stated.cantPromise, /can't undo/);
  const run = conforms(await apply(removal.handle, approve(removal.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual(fakeState(state, 'fake-tool').settings, { auto_index: 'false' }, 'the setting stays: nothing undid it');
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
  assert.equal(listed.entries.find(entry => entry.managementId === setup.id).installState, 'interrupted');
  mode('');
  const again = await prepare(request);
  assert.equal(again.status, 'ready', JSON.stringify(again));
  const step = again.review.steps.find(item => item.op === 'tool-command');
  assert.equal(step.previous, 'interrupted');
  assert.match(step.cantPromise, /interrupted, so its effects are uncertain/);
  const finished = conforms(await apply(again.handle, approve(again.review)));
  assert.equal(finished.completion, 'complete', JSON.stringify(finished));
  assert.equal((await list({ target: { project }, scope: 'user' })).entries.find(entry => entry.managementId === setup.id).installState, 'complete');
});
