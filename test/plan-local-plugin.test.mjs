// Local-plugin routes and switching off one plugin item, through the built public entries in a disposable home and
// project. Producer documents are Core-side fixtures (test/fixtures/plan-fixture.mjs) in Catalog's local-plugin shapes;
// the Codex plugin commands run against a controlled FAKE client. Nothing here is evidence about a real client.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, list, prepare, prepareRemoval } from '../dist/core/index.js';
import { validateFormat } from '../dist/core/contracts.js';
import { LOCAL_PLUGIN_MANIFEST, codexPluginRequest, localPluginRequest, pluginRequest } from './fixtures/plan-fixture.mjs';
import { fakeClientEnv, fakeClientState, installFakeClient } from './fixtures/fake-client.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-local-plugin-'));
const keys = ['HOME', 'USERPROFILE', 'PATH', 'FAKE_CLIENT_STATE', 'FAKE_CLIENT_MODE', 'NODE_OPTIONS'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let home, project, state, counter = 0;
const bin = join(scratch, 'bin');
before(() => { installFakeClient(bin, 'claude'); installFakeClient(bin, 'codex'); });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); });
function fresh() {
  home = join(scratch, `home-${counter}`); project = join(scratch, `project-${counter}`); state = join(scratch, `state-${counter++}`);
  mkdirSync(home); mkdirSync(project);
  Object.assign(process.env, { HOME: home, USERPROFILE: home }, fakeClientEnv(bin, state));
}
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const ITEMS = ['superpowers.skill.brainstorming', 'superpowers.skill.writing-plans'];
const FILES = ['.aihq/plugins/superpowers/.claude-plugin/marketplace.json', '.aihq/plugins/superpowers/skills/brainstorming/SKILL.md',
  '.aihq/plugins/superpowers/skills/writing-plans/SKILL.md'];

test('a local-plugin route is one indivisible install: its files and registration are grouped under the framework and removed whole', async () => {
  fresh();
  mkdirSync(join(project, '.claude'));
  const settings = '{\n  // my own settings\n  "theme": "dark"\n}\n';
  writeFileSync(join(project, '.claude/settings.json'), settings);
  const prepared = await prepare(localPluginRequest(project));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  const steps = prepared.review.steps;
  assert.equal(steps.length, 5);
  assert.ok(steps.every(step => step.managementId === 'superpowers' && step.framework === 'superpowers' && step.route === 'local-plugin'),
    JSON.stringify(steps));
  assert.deepEqual(steps[0].contains, ITEMS, 'the route\'s first step names what the plugin contains');
  assert.deepEqual(steps.filter(step => step.op === 'write').map(step => step.path), FILES);

  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(readFileSync(join(project, FILES[0]), 'utf8'), LOCAL_PLUGIN_MANIFEST);
  const written = readFileSync(join(project, '.claude/settings.json'), 'utf8');
  assert.match(written, /my own settings/);
  assert.match(written, /"superpowers@superpowers-marketplace": true/);

  const listed = conforms(await list({ target: { project }, scope: 'project' }));
  assert.deepEqual(listed.entries.map(entry => entry.managementId), ['superpowers'], 'one install, not one per file');
  assert.deepEqual(listed.entries[0].localPlugin, { contains: ITEMS, files: FILES });

  // One item inside it: the plugin can't be split, and Claude has no supported switch-off, so only the whole plugin is offered.
  const one = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: 'superpowers', item: ITEMS[0] }] });
  assert.deepEqual(one, { status: 'ok', entries: [{ managementId: 'superpowers', item: ITEMS[0], disposition: 'unavailable',
    reason: 'plugin-indivisible', members: [], contains: ITEMS, offers: [{ managementId: 'superpowers' }], choices: ['remove-plugin'] }] });
  const refused = await prepareRemoval({ target: { project }, scope: 'project',
    removals: [{ managementId: 'superpowers', item: ITEMS[0] }], resolutions: [{ managementId: 'superpowers', item: ITEMS[0], choice: 'switch-off' }] });
  assert.deepEqual([refused.status, refused.code], ['refused', 'switch-off-unsupported'], JSON.stringify(refused));

  const whole = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: 'superpowers' }] });
  assert.equal(whole.status, 'ok', JSON.stringify(whole));
  const removed = conforms(await apply(whole.handle, approve(whole.review)));
  assert.equal(removed.completion, 'complete', JSON.stringify(removed));
  for (const file of FILES) assert.equal(existsSync(join(project, file)), false, file);
  // The registration entries go and your own settings and comment stay. (The retained JSON entry editor leaves the empty
  // `enabledPlugins` / `extraKnownMarketplaces` objects it created; that is the engine's existing removal rule.)
  const left = readFileSync(join(project, '.claude/settings.json'), 'utf8');
  assert.ok(left.startsWith('{\n  // my own settings\n  "theme": "dark"'), left);
  assert.doesNotMatch(left, /superpowers/);
  assert.deepEqual((await list({ target: { project }, scope: 'project' })).entries, []);
});

test('without the route\'s contained-item metadata, Core lists the plugin files and never infers item membership', async () => {
  fresh();
  const prepared = await prepare(localPluginRequest(project, { contains: false }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.review.steps.some(step => step.contains !== undefined), false);
  conforms(await apply(prepared.handle, approve(prepared.review)));
  const listed = conforms(await list({ target: { project }, scope: 'project' }));
  assert.deepEqual(listed.entries[0].localPlugin, { contains: null, files: FILES });
  const one = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: 'superpowers', item: ITEMS[0] }] });
  assert.deepEqual(one.entries, [{ managementId: 'superpowers', item: ITEMS[0], disposition: 'unavailable', reason: 'plugin-indivisible',
    members: [], files: FILES, offers: [{ managementId: 'superpowers' }], choices: ['remove-plugin'] }]);
});

const NAME = 'superpowers:brainstorming';
const codexConfig = () => join(home, '.codex', 'config.toml');
const userRemoval = (removals, resolutions) => prepareRemoval({ target: {}, scope: 'user', removals, ...(resolutions ? { resolutions } : {}) });
const SWITCH_OFF = [{ managementId: 'superpowers', item: ITEMS[0], choice: 'switch-off' }];
async function installCodexPlugin() {
  const prepared = await prepare(codexPluginRequest());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
}

test('one Codex plugin skill is switched off by a marked [[skills.config]] block, read back, and switched on again byte for byte', async () => {
  fresh();
  await installCodexPlugin();
  mkdirSync(join(home, '.codex'));
  // Your own settings, including another skill's switch-off, stay byte for byte.
  const yours = '# my codex settings\r\nmodel = "o3"\r\n\r\n[[skills.config]]\r\nname = "other:skill"\r\nenabled = false\r\n\r\n[mcp_servers.github]\r\ncommand = "gh"\r\n';
  writeFileSync(codexConfig(), yours);

  const offered = await userRemoval([{ managementId: 'superpowers', item: ITEMS[0] }]);
  assert.deepEqual([offered.entries[0].reason, offered.entries[0].choices, offered.entries[0].offers],
    ['plugin-indivisible', ['remove-plugin', 'switch-off'], [{ managementId: 'superpowers' }]]);
  assert.equal(offered.handle, undefined);
  // Switching off is not a removal entry of its own: it is the resolution chosen for that entry, prepared again.
  const entryForm = await userRemoval([{ managementId: 'superpowers', item: ITEMS[0], switchOff: true }]);
  assert.equal(entryForm.status, 'invalid', JSON.stringify(entryForm));

  const prepared = await userRemoval([{ managementId: 'superpowers', item: ITEMS[0] }], SWITCH_OFF);
  assert.equal(prepared.status, 'ok', JSON.stringify(prepared));
  assert.deepEqual(prepared.entries.map(entry => [entry.managementId, entry.item, entry.disposition, entry.status]),
    [['superpowers', ITEMS[0], 'prepared', 'ready']]);
  conforms(prepared.review);
  const [step] = prepared.review.steps;
  assert.deepEqual([step.op, step.managementId, step.framework, step.cli, step.path, step.effect],
    ['switch-off', ITEMS[0], 'superpowers', 'codex', '.codex/config.toml', 'replace-file']);
  assert.equal(step.entry, `[[skills.config]]\r\nname = "${NAME}"\r\nenabled = false\r\n`, 'the block keeps the file\'s line endings');
  assert.equal(readFileSync(codexConfig(), 'utf8'), yours, 'Prepare writes nothing');
  const calls = fakeClientState(state, 'codex').calls.length;

  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual(run.steps.map(item => [item.application, item.verification]), [['applied', { status: 'passed', reason: 'readback-matched' }]]);
  const after = readFileSync(codexConfig(), 'utf8');
  assert.ok(after.startsWith(yours), 'every byte outside the block is kept');
  assert.equal(after.slice(yours.length), `# aih:begin superpowers/${ITEMS[0]}\r\n[[skills.config]]\r\nname = "${NAME}"\r\nenabled = false\r\n# aih:end superpowers/${ITEMS[0]}\r\n`);
  assert.equal(fakeClientState(state, 'codex').calls.length, calls, 'the plugin itself is not touched');

  const listed = conforms(await list({ target: {}, scope: 'user' }));
  assert.deepEqual(listed.entries.map(entry => entry.managementId).sort(), ['superpowers', ITEMS[0]].sort(), 'the framework install stays');
  assert.deepEqual(listed.entries.find(entry => entry.managementId === ITEMS[0]).switchOff,
    { framework: 'superpowers', item: ITEMS[0], cli: 'codex', name: NAME });
  const again = await userRemoval([{ managementId: 'superpowers', item: ITEMS[0] }]);
  assert.deepEqual([again.entries[0].choices, again.entries[0].offers], [['remove-plugin'], [{ managementId: 'superpowers' }, { managementId: ITEMS[0] }]],
    'once off, its removal is offered');

  const on = await userRemoval([{ managementId: ITEMS[0] }]);
  assert.equal(on.status, 'ok', JSON.stringify(on));
  const back = conforms(await apply(on.handle, approve(on.review)));
  assert.equal(back.completion, 'complete', JSON.stringify(back));
  assert.equal(readFileSync(codexConfig(), 'utf8'), yours, 'switching it on again leaves the file as it was');
  assert.deepEqual((await list({ target: {}, scope: 'user' })).entries.map(entry => entry.managementId), ['superpowers']);
});

test('your own unmarked entry for the skill, or two marked blocks for it, block the switch-off with skip only', async () => {
  fresh();
  await installCodexPlugin();
  mkdirSync(join(home, '.codex'));
  const unmarked = `[[skills.config]]\nname = "${NAME}"\nenabled = true\n`;
  writeFileSync(codexConfig(), unmarked);
  const request = [{ managementId: 'superpowers', item: ITEMS[0] }];
  let blocked = await userRemoval(request, SWITCH_OFF);
  assert.equal(blocked.status, 'ok', JSON.stringify(blocked));
  assert.equal(blocked.handle, undefined);
  assert.equal(blocked.entries[0].status, 'blocked');
  conforms(blocked.review);
  assert.deepEqual(blocked.review.conflicts.map(conflict => [conflict.code, conflict.reason, conflict.choices, conflict.existing]),
    [['STATE_CONFLICT', 'existing-content', ['skip'], unmarked]]);
  assert.equal(readFileSync(codexConfig(), 'utf8'), unmarked);

  const marked = `# aih:begin superpowers/${ITEMS[0]}\n[[skills.config]]\nname = "${NAME}"\nenabled = false\n# aih:end superpowers/${ITEMS[0]}\n`;
  writeFileSync(codexConfig(), marked + marked);
  blocked = await userRemoval(request, SWITCH_OFF);
  assert.equal(blocked.handle, undefined);
  assert.deepEqual(blocked.review.conflicts.map(conflict => [conflict.reason, conflict.choices]), [['existing-content', ['skip']]]);
  assert.equal(readFileSync(codexConfig(), 'utf8'), marked + marked);
});

test('a CLI without a supported switch-off gets no invented toggle, and removing the whole plugin also removes its switch-offs', async () => {
  fresh();
  const claude = await prepare(pluginRequest('none'));
  conforms(await apply(claude.handle, approve(claude.review)));
  const offered = await userRemoval([{ managementId: 'superpowers', item: ITEMS[0] }]);
  assert.deepEqual([offered.entries[0].choices, offered.entries[0].offers], [['remove-plugin'], [{ managementId: 'superpowers' }]]);
  const refused = await userRemoval([{ managementId: 'superpowers', item: ITEMS[0] }], SWITCH_OFF);
  assert.deepEqual([refused.status, refused.code], ['refused', 'switch-off-unsupported']);
  // Choosing the whole plugin for that entry prepares the plugin's removal; a resolution for no entry is invalid.
  const plugin = await userRemoval([{ managementId: 'superpowers', item: ITEMS[0] }], [{ managementId: 'superpowers', item: ITEMS[0], choice: 'remove-plugin' }]);
  assert.deepEqual([plugin.status, plugin.entries[0].managementId, plugin.entries[0].disposition, !!plugin.handle], ['ok', 'superpowers', 'prepared', true], JSON.stringify(plugin));
  const stray = await userRemoval([{ managementId: 'superpowers' }], SWITCH_OFF);
  assert.deepEqual([stray.status, stray.problems?.[0]?.reason], ['invalid', 'resolution-unknown']);
  assert.equal(existsSync(codexConfig()), false);

  fresh();
  await installCodexPlugin();
  const off = await userRemoval([{ managementId: 'superpowers', item: ITEMS[0] }], SWITCH_OFF);
  assert.equal(off.review.steps[0].effect, 'create-file');
  conforms(await apply(off.handle, approve(off.review)));
  const whole = await userRemoval([{ managementId: 'superpowers' }]);
  assert.deepEqual(whole.entries.map(entry => [entry.managementId, entry.disposition]), [['superpowers', 'prepared'], [ITEMS[0], 'prepared']]);
  const run = conforms(await apply(whole.handle, approve(whole.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(existsSync(codexConfig()), false, 'the file Core created goes with the last block');
  assert.deepEqual((await list({ target: {}, scope: 'user' })).entries, []);
});
