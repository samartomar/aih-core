// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Native plugin steps of a plan request against a controlled FAKE client (fake-client.mjs). The plan and profile
// documents are Core-side FIXTURES (plan-fixture.mjs); nothing here is evidence about a real client.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFormat } from '@aihq/core/contracts';
import { apply, list, prepare, prepareRemoval } from '@aihq/core';
import { PRESENCE, pluginRequest } from './plan-fixture.mjs';
import { fakeClientEnv, fakeClientState, installFakeClient } from './fake-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, 'fake-bin');
installFakeClient(bin, 'claude');
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const SPEC = 'superpowers@superpowers-marketplace';
const user = () => list({ target: {}, scope: 'user' });
let state;
/** A fresh fake-client state; the disposable home is the test's. */
const fresh = (mode = '') => { state = mkdtempSync(join(here, 'client-')); Object.assign(process.env, fakeClientEnv(bin, state, mode)); };
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

await check('the API reviews the exact plugin commands, installs, lists the undo facts and removes with a verified readback', async () => {
  fresh();
  const prepared = await prepare(pluginRequest(PRESENCE));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  assert.deepEqual(prepared.review.steps[0].commands.map(command => command.argv.join(' ')),
    ['claude plugin marketplace add https://github.com/obra/superpowers-marketplace --scope user', `claude plugin install ${SPEC} --scope user`]);
  const events = [];
  const run = conforms(await apply(prepared.handle, approve(prepared.review), { onProgress: event => events.push(event) }));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual(run.steps[0].verification, { status: 'passed', reason: 'present' });
  assert.deepEqual(events.map(event => [event.step, event.operation, event.phase]), [[0, 'step-0-0', 'start'], [0, 'step-0-0', 'finish'],
    [0, 'step-0-1', 'start'], [0, 'step-0-1', 'finish'], [0, 'presence-check', 'start'], [0, 'presence-check', 'finish']]);
  const entry = conforms(await user()).entries[0];
  assert.deepEqual(entry.plugins[0].undo, [['claude', 'plugin', 'uninstall', 'superpowers']]);
  const removal = await prepareRemoval({ target: {}, scope: 'user', removals: [{ managementId: 'superpowers' }] });
  conforms(removal.review);
  const removed = conforms(await apply(removal.handle, approve(removal.review)));
  assert.equal(removed.completion, 'complete', JSON.stringify(removed));
  assert.deepEqual(removed.steps[0].verification, { status: 'passed', reason: 'absent' });
  assert.deepEqual(fakeClientState(state, 'claude').plugins, []);
  assert.deepEqual((await user()).entries, []);
});

await check('without a presence check install and removal stay unverified (no-presence-check)', async () => {
  fresh();
  const prepared = await prepare(pluginRequest('none'));
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.deepEqual(run.steps[0].verification, { status: 'unverified', reason: 'no-presence-check' });
  const removal = await prepareRemoval({ target: {}, scope: 'user', removals: [{ managementId: 'superpowers' }] });
  const removed = conforms(await apply(removal.handle, approve(removal.review)));
  assert.deepEqual(removed.steps[0].verification, { status: 'unverified', reason: 'no-presence-check' });
});

await check('the aih CLI installs a plugin plan, refuses to split it by item, and removes it, with the contract exit codes', async () => {
  fresh();
  const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
  const aih = args => {
    const child = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return { code: child.status, result: JSON.parse(child.stdout.trim().split('\n').at(-1)), stderr: child.stderr };
  };
  const document = join(here, 'plugin-request.json');
  writeFileSync(document, JSON.stringify(pluginRequest(PRESENCE)));
  const preview = aih(['install', document, '--json']);
  assert.deepEqual([preview.code, preview.result.status], [0, 'ready'], JSON.stringify(preview));
  assert.deepEqual(fakeClientState(state, 'claude').calls, [], 'a preview runs nothing');
  const installed = aih(['install', document, '--apply', '--yes', '--json']);
  assert.deepEqual([installed.code, installed.result.completion], [0, 'complete'], JSON.stringify(installed));
  assert.match(installed.stderr, /"progress"/);
  const inventory = aih(['list', '--scope', 'user', '--json']);
  assert.equal(inventory.result.entries[0].plugins[0].plugin, 'superpowers');
  const one = aih(['remove', 'superpowers', '--scope', 'user', '--item', 'superpowers.skill.brainstorming', '--apply', '--yes', '--json']);
  assert.deepEqual([one.code, one.result.entries[0].reason, one.result.entries[0].offers], [1, 'plugin-indivisible', [{ managementId: 'superpowers' }]]);
  assert.deepEqual(fakeClientState(state, 'claude').plugins, [SPEC], 'nothing was split or removed');
  const removed = aih(['remove', 'superpowers', '--scope', 'user', '--apply', '--yes', '--json']);
  assert.deepEqual([removed.code, removed.result.completion], [0, 'complete'], JSON.stringify(removed));
  assert.deepEqual(fakeClientState(state, 'claude').plugins, []);
});

await check('a failed readback makes the install incomplete (exit 1) and keeps the receipt for removal', async () => {
  fresh('install-noop');
  const prepared = await prepare(pluginRequest(PRESENCE));
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.deepEqual([run.completion, run.steps[0].verification.reason], ['incomplete', 'readback-absent']);
  assert.equal((await user()).entries.length, 1);
  process.env.FAKE_CLIENT_MODE = '';
  const removal = await prepareRemoval({ target: {}, scope: 'user', removals: [{ managementId: 'superpowers' }] });
  assert.equal(conforms(await apply(removal.handle, approve(removal.review))).completion, 'complete');
});

console.log(JSON.stringify({ status: 'passed', checks }));
