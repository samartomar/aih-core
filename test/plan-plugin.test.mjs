// Native plugin steps of a plan request through the built public entries, in a disposable home, against a controlled
// FAKE client executable (test/fixtures/fake-client.mjs). Producer documents are Core-side fixtures; nothing here is
// evidence about a real client's plugin commands, which stay a pending live check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, list, prepare, prepareRemoval } from '../dist/core/index.js';
import { validateFormat } from '../dist/core/contracts.js';
import { PRESENCE, pluginRequest } from './fixtures/plan-fixture.mjs';
import { fakeClientEnv, fakeClientState, installFakeClient } from './fixtures/fake-client.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-plugin-'));
const keys = ['HOME', 'USERPROFILE', 'PATH', 'FAKE_CLIENT_STATE', 'FAKE_CLIENT_MODE', 'NODE_OPTIONS'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let home, state, counter = 0;
const bin = join(scratch, 'bin');
before(() => { installFakeClient(bin, 'claude'); });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); });
/** A fresh disposable home and fake-client state for each test. */
function fresh(mode = '') {
  home = join(scratch, `home-${counter}`); state = join(scratch, `state-${counter++}`); mkdirSync(home);
  Object.assign(process.env, { HOME: home, USERPROFILE: home }, fakeClientEnv(bin, state, mode));
}
const mode = value => { process.env.FAKE_CLIENT_MODE = value; };
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const SPEC = 'superpowers@superpowers-marketplace';

test('a plugin step reviews its exact pinned commands, runs them after approval and keeps its undo facts in the receipt', async () => {
  fresh();
  const prepared = await prepare(pluginRequest(PRESENCE));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  const [step] = prepared.review.steps;
  assert.equal(step.op, 'plugin');
  assert.equal(step.managementId, 'superpowers');
  assert.equal(step.framework, 'superpowers');
  assert.deepEqual(step.contains, ['superpowers.skill.brainstorming', 'superpowers.skill.writing-plans']);
  assert.deepEqual(step.commands.map(command => command.argv), [
    ['claude', 'plugin', 'marketplace', 'add', 'https://github.com/obra/superpowers-marketplace', '--scope', 'user'],
    ['claude', 'plugin', 'install', SPEC, '--scope', 'user']]);
  for (const command of step.commands) {
    assert.match(command.executable, /claude(\.exe)?$/i);
    assert.match(command.executableSha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(step.undo, [['claude', 'plugin', 'uninstall', 'superpowers']]);
  assert.deepEqual([step.presenceCheck.argv, step.presenceCheck.expect], [['claude', 'plugin', 'list'], SPEC]);
  assert.match(step.presenceCheck.executableSha256, /^[a-f0-9]{64}$/);
  assert.match(step.sentence, /^Runs `claude plugin install superpowers@superpowers-marketplace --scope user`/);
  assert.match(step.cantPromise, /can't/i);
  assert.equal(step.effect, 'run-program');
  assert.deepEqual(fakeClientState(state, 'claude').calls, [], 'Prepare runs no client command');

  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual(run.steps.map(item => [item.step, item.application, item.verification.status, item.verification.reason]),
    [[0, 'applied', 'passed', 'present']]);
  assert.deepEqual(fakeClientState(state, 'claude').calls, [
    ['plugin', 'marketplace', 'add', 'https://github.com/obra/superpowers-marketplace', '--scope', 'user'],
    ['plugin', 'install', SPEC, '--scope', 'user'], ['plugin', 'list']]);

  const listed = conforms(await list({ target: {}, scope: 'user' }));
  const entry = listed.entries.find(row => row.managementId === 'superpowers');
  assert.ok(entry, JSON.stringify(listed));
  assert.deepEqual([entry.installState, entry.clis, entry.items], ['complete', ['claude-code'], ['superpowers']]);
  assert.deepEqual(entry.plugins, [{ step: 0, cli: 'claude-code', plugin: 'superpowers', commit: '5bf4e78011075bcfc0dc295f0724994cd123ee71',
    contains: ['superpowers.skill.brainstorming', 'superpowers.skill.writing-plans'],
    undo: [['claude', 'plugin', 'uninstall', 'superpowers']], presenceCheck: { argv: ['claude', 'plugin', 'list'], expect: SPEC } }]);
});

const install = async (verify, options) => {
  const prepared = await prepare(pluginRequest(verify, options));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  return conforms(await apply(prepared.handle, approve(prepared.review)));
};
const removal = request => prepareRemoval({ target: {}, scope: 'user', removals: [{ managementId: 'superpowers', ...request }] });

test('removal runs the uninstall command saved in the receipt and says "removed" only when the presence check says it is gone', async () => {
  fresh();
  await install(PRESENCE);
  const prepared = await removal();
  assert.equal(prepared.status, 'ok', JSON.stringify(prepared));
  assert.deepEqual(prepared.entries.map(entry => [entry.managementId, entry.disposition, entry.status]), [['superpowers', 'prepared', 'ready']]);
  conforms(prepared.review);
  const step = prepared.review.steps.find(item => item.op === 'plugin');
  assert.ok(step, JSON.stringify(prepared.review.steps));
  assert.deepEqual(step.commands.map(command => command.argv), [['claude', 'plugin', 'uninstall', 'superpowers']]);
  assert.match(step.commands[0].executableSha256, /^[a-f0-9]{64}$/);
  assert.equal(step.presenceCheck.expect, SPEC);
  assert.match(step.sentence, /^Runs `claude plugin uninstall superpowers`/);
  assert.match(step.cantPromise, /can't/i);
  const calls = fakeClientState(state, 'claude').calls.length;
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const removed = run.steps.find(item => item.step === step.step);
  assert.deepEqual([removed.application, removed.verification], ['applied', { status: 'passed', reason: 'absent' }]);
  assert.deepEqual(fakeClientState(state, 'claude').calls.slice(calls), [['plugin', 'uninstall', 'superpowers'], ['plugin', 'list']]);
  assert.deepEqual(fakeClientState(state, 'claude').plugins, []);
  assert.deepEqual((await list({ target: {}, scope: 'user' })).entries, []);
});

test('without a presence check, install and removal both stay unverified (no-presence-check); exit 0 proves nothing', async () => {
  fresh();
  const installed = await install('none');
  assert.deepEqual(installed.steps.map(item => [item.application, item.verification]),
    [['applied', { status: 'unverified', reason: 'no-presence-check' }]]);
  const prepared = await removal();
  const step = prepared.review.steps.find(item => item.op === 'plugin');
  assert.equal(step.presenceCheck, 'none');
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  const removed = run.steps.find(item => item.step === step.step);
  assert.deepEqual([removed.application, removed.verification], ['applied', { status: 'unverified', reason: 'no-presence-check' }]);
  assert.equal(fakeClientState(state, 'claude').calls.some(call => call[1] === 'list'), false, 'no listing stands in for a check');
});

test('a failed presence readback fails the step and the run, and a removal that still finds the plugin keeps the receipt', async () => {
  fresh('install-noop');
  const installed = await install(PRESENCE);
  assert.equal(installed.completion, 'incomplete', JSON.stringify(installed));
  assert.deepEqual(installed.steps.map(item => [item.application, item.verification]),
    [['applied', { status: 'failed', reason: 'readback-absent' }]]);
  // The command ran, so the receipt keeps its undo facts.
  assert.equal((await list({ target: {}, scope: 'user' })).entries[0].plugins[0].plugin, 'superpowers');
  mode('');
  await install(PRESENCE);
  mode('uninstall-noop');
  let prepared = await removal();
  let run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'incomplete');
  assert.deepEqual(run.steps.find(item => item.verification.reason !== 'not-attempted').verification, { status: 'failed', reason: 'readback-present' });
  assert.equal((await list({ target: {}, scope: 'user' })).entries.length, 1, 'the receipt stays for another try');
  // A presence check that cannot run proves nothing either way.
  mode('list-fail');
  prepared = await removal();
  run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'incomplete');
  assert.deepEqual(run.steps[0].verification, { status: 'failed', reason: 'check-exit-code' });
  assert.equal((await list({ target: {}, scope: 'user' })).entries.length, 1);
  // A failing removal command keeps the receipt and its undo facts.
  mode('uninstall-fail');
  prepared = await removal();
  run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.deepEqual([run.completion, run.steps[0].application], ['incomplete', 'failed']);
  assert.equal((await list({ target: {}, scope: 'user' })).entries.length, 1);
});

test('one item inside a plugin offers removal of the whole plugin, never a silent split', async () => {
  fresh();
  await install(PRESENCE);
  const calls = fakeClientState(state, 'claude').calls.length;
  const result = await removal({ item: 'superpowers.skill.brainstorming' });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.handle, undefined);
  assert.deepEqual(result.entries, [{ managementId: 'superpowers', item: 'superpowers.skill.brainstorming', disposition: 'unavailable',
    reason: 'plugin-indivisible', members: [], contains: ['superpowers.skill.brainstorming', 'superpowers.skill.writing-plans'],
    offers: [{ managementId: 'superpowers' }] }]);
  assert.equal(fakeClientState(state, 'claude').calls.length, calls, 'nothing ran');
  const other = await removal({ item: 'superpowers.skill.unknown' });
  assert.equal(other.entries[0].disposition, 'absent');
});

test('an interrupted plugin command is effectsUncertain, is shown again for fresh approval, and can be removed', async () => {
  fresh('install-hang');
  const prepared = await prepare(pluginRequest(PRESENCE));
  const controller = new AbortController();
  const started = join(state, 'claude.started');
  const watcher = setInterval(() => { if (existsSync(started)) controller.abort(); }, 50);
  const run = await apply(prepared.handle, approve(prepared.review), { signal: controller.signal });
  clearInterval(watcher);
  assert.equal(run.completion, 'cancelled', JSON.stringify(run));
  assert.equal(run.steps[0].effectsUncertain, true);
  const listed = await list({ target: {}, scope: 'user' });
  assert.deepEqual(listed.entries.map(row => [row.managementId, row.installState]), [['superpowers', 'interrupted']]);
  mode('');
  const again = await prepare(pluginRequest(PRESENCE));
  assert.equal(again.status, 'ready');
  assert.equal(again.review.steps[0].previous, 'interrupted');
  assert.match(again.review.steps[0].cantPromise, /interrupted/);
  const removed = await removal();
  assert.deepEqual(removed.entries.map(row => [row.managementId, row.disposition]), [['superpowers', 'prepared']]);
  const done = conforms(await apply(removed.handle, approve(removed.review)));
  assert.equal(done.completion, 'complete', JSON.stringify(done));
  assert.deepEqual((await list({ target: {}, scope: 'user' })).entries, []);
});

test('a plugin step Core cannot carry out exactly is refused before any effect', async () => {
  fresh();
  const cases = [
    ['no profile for the CLI', request => { request.profiles = []; }, 'profile-mismatch'],
    ['a different presence check than the profile', request => { request.plan.plan[0].verify = 'none'; }, 'profile-mismatch'],
    ['a command value the step does not give', request => { delete request.plan.plan[0].marketplaceName; }, 'plugin-command-unresolved'],
    ['no pinned install', request => { request.profiles[0].plugins.pin = 'drops-on-update'; }, 'plugin-command-unresolved'],
    ['a CLI this host cannot run', request => { for (const argv of request.profiles[0].plugins.install) argv[0] = 'not-installed-cli'; }, 'program-unavailable'],
    ['an unknown CLI', request => { request.plan.plan[0].cli = 'emacs'; }, 'tool-unknown'],
  ];
  for (const [name, change, code] of cases) {
    const request = pluginRequest(PRESENCE);
    change(request);
    const result = await prepare(request);
    assert.deepEqual([result.status, result.code], ['refused', code], `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.handle, undefined);
  }
  assert.deepEqual(fakeClientState(state, 'claude').calls, []);
});
