// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// A local-plugin route and a one-item Codex switch-off. The plan and profile documents are Core-side FIXTURES
// (plan-fixture.mjs); the Codex plugin commands run against a controlled FAKE client (fake-client.mjs). Nothing here
// is evidence about a real client.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFormat } from '@aihq/core/contracts';
import { apply, list, prepare, prepareRemoval } from '@aihq/core';
import { codexPluginRequest, localPluginRequest } from './plan-fixture.mjs';
import { fakeClientEnv, installFakeClient } from './fake-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, 'fake-bin');
installFakeClient(bin, 'codex');
Object.assign(process.env, fakeClientEnv(bin, mkdtempSync(join(here, 'client-'))));
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const ITEM = 'superpowers.skill.brainstorming';
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

await check('the API installs a local plugin as one install, offers only whole removal for one item, and removes it whole', async () => {
  const project = mkdtempSync(join(here, 'project-'));
  const prepared = await prepare(localPluginRequest(project));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  assert.ok(prepared.review.steps.every(step => step.managementId === 'superpowers' && step.route === 'local-plugin'));
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const listed = conforms(await list({ target: { project }, scope: 'project' }));
  assert.deepEqual(listed.entries.map(entry => [entry.managementId, entry.localPlugin.contains.length, entry.localPlugin.files.length]),
    [['superpowers', 2, 3]]);
  const one = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: 'superpowers', item: ITEM }] });
  assert.deepEqual([one.entries[0].reason, one.entries[0].offers], ['plugin-indivisible', [{ managementId: 'superpowers' }]]);
  const whole = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: 'superpowers' }] });
  assert.equal(conforms(await apply(whole.handle, approve(whole.review))).completion, 'complete');
  assert.equal(existsSync(join(project, '.aihq/plugins/superpowers/skills/brainstorming/SKILL.md')), false);
  assert.deepEqual((await list({ target: { project }, scope: 'project' })).entries, []);
});

await check('the aih CLI switches one Codex plugin skill off and on again, keeping every byte around the block', async () => {
  const prepared = await prepare(codexPluginRequest());
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
  const aih = args => {
    const child = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return { code: child.status, result: JSON.parse(child.stdout.trim().split('\n').at(-1)), stderr: child.stderr };
  };
  const config = join(homedir(), '.codex', 'config.toml');
  mkdirSync(dirname(config), { recursive: true });
  const yours = 'model = "o3"\n\n[mcp_servers.github]\ncommand = "gh"\n';
  writeFileSync(config, yours);
  const offered = aih(['remove', 'superpowers', '--scope', 'user', '--item', ITEM, '--json']);
  assert.deepEqual([offered.result.entries[0].choices, offered.result.entries[0].offers], [['remove-plugin', 'switch-off'], [{ managementId: 'superpowers' }]]);
  // The choice is a resolution for that entry, passed to a second preparation (`--resolutions`).
  const resolutions = join(here, 'switch-off.json');
  writeFileSync(resolutions, JSON.stringify({ resolutions: [{ managementId: 'superpowers', item: ITEM, choice: 'switch-off' }] }));
  const off = aih(['remove', 'superpowers', '--scope', 'user', '--item', ITEM, '--resolutions', resolutions, '--apply', '--yes', '--json']);
  assert.deepEqual([off.code, off.result.completion, off.result.steps[0].verification.reason], [0, 'complete', 'readback-matched'], JSON.stringify(off));
  const after = readFileSync(config, 'utf8');
  assert.ok(after.startsWith(yours));
  assert.match(after.slice(yours.length), /^# aih:begin superpowers\/superpowers\.skill\.brainstorming\n\[\[skills\.config\]\]\nname = "superpowers:brainstorming"\nenabled = false\n# aih:end /);
  const inventory = aih(['list', '--scope', 'user', '--json']);
  const switchId = `superpowers.switch-off.${ITEM}`;
  assert.deepEqual(inventory.result.entries.map(entry => entry.managementId).sort(), ['superpowers', switchId]);
  const usage = aih(['remove', 'superpowers', '--scope', 'user', '--switch-off', '--json']);
  assert.deepEqual([usage.code, usage.result.code], [2, 'usage'], 'there is no switch-off flag');
  const on = aih(['remove', switchId, '--scope', 'user', '--apply', '--yes', '--json']);
  assert.deepEqual([on.code, on.result.completion], [0, 'complete'], JSON.stringify(on));
  assert.equal(readFileSync(config, 'utf8'), yours);
});

console.log(JSON.stringify({ status: 'passed', checks }));
