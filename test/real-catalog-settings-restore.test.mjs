// Removal through Core must leave .claude/settings.json exactly as it was before the Workbench install: absent when
// AIH created it and added only its own hook groups, and the person's exact bytes when it was already there.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { apply, prepareManagedRemoval } from '../dist/core/index.js';
import { sandbox } from './hook-group-fixture.mjs';
import { approve, assertVendoredRelease, fileTree, installReal } from './real-catalog-fixture.mjs';

const settings = s => join(s.project, '.claude', 'settings.json');
let live = [];
afterEach(() => { for (const s of live) s.dispose(); live = []; });
const open = () => { const s = sandbox('aih-real-settings-'); live.push(s); return s; };

async function removeAll(s, selections) {
  const result = await prepareManagedRemoval({ target: { project: s.project }, scope: 'project',
    removals: selections.map(selection => ({ managementId: selection.managementId })) }, { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  const run = await apply(result.preparation.prepared, approve({ reviewDigest: result.reviewDigest }), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  return run;
}

test('a settings.json AIH created for its hook groups goes with the last group', async () => {
  assertVendoredRelease();
  const s = open(), before = fileTree(s.project);
  const { selections } = await installReal(s);
  assert.equal(existsSync(settings(s)), true, 'Core created the settings file');
  assert.match(s.read('.claude/settings.json'), /"SessionStart"[\s\S]*"PreToolUse"/);
  await removeAll(s, selections);
  assert.equal(existsSync(settings(s)), false, 'the file Core created is removed, not left as empty containers');
  assert.deepEqual(fileTree(s.project), before, 'the project tree is exactly what it was before install');
});

test('a settings.json AIH created is removed even when the selection carries no item metadata', async () => {
  assertVendoredRelease();
  const s = open(), before = fileTree(s.project);
  const { selections } = await installReal(s, { described: false });
  assert.equal(existsSync(settings(s)), true, 'Core created the settings file');
  await removeAll(s, selections);
  assert.equal(existsSync(settings(s)), false);
  assert.deepEqual(fileTree(s.project), before);
});

test('a settings.json the person already had is restored to its exact pre-install bytes', async () => {
  assertVendoredRelease();
  const s = open();
  const original = '{\n  "theme": "dark",\n  "hooks": {\n    "PreToolUse": [\n      {\n        "matcher": "Bash",\n        "hooks": [{ "type": "command", "command": "echo mine" }]\n      }\n    ]\n  }\n}\n';
  s.write('.claude/settings.json', original);
  const before = fileTree(s.project);
  const { selections } = await installReal(s);
  assert.match(s.read('.claude/settings.json'), /"SessionStart"/);
  await removeAll(s, selections);
  assert.equal(s.read('.claude/settings.json'), original, 'exact bytes, including the person\'s own hook group');
  assert.deepEqual(fileTree(s.project), before);
});
