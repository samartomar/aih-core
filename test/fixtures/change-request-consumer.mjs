// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Authored changes through a change request (urn:aihq:core:change-request:0.1.0): a settings edit, a grouped
// reconciliation, dependency retention, an exact command and restoration. Changes are hand-written test documents.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveChangeIdentity, schemas, validateChange, validateFormat } from '@aihq/core/contracts';
import { apply, list, prepare, prepareRemoval } from '@aihq/core';
import { changeRequest, codexApproval, commandChange, projectSetting, teamFile } from './change-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { const read = validateFormat(value); assert.equal(read.status, 'ok', JSON.stringify(read)); return value; };
const project = name => { const path = mkdtempSync(join(process.env.HOME, `${name}-`)); writeFileSync(join(path, 'README.md'), 'mine\n'); return path; };
const aih = (args, env = {}) => {
  const run = spawnSync(process.execPath, [bin, ...args, '--json'], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000 });
  return { code: run.status, result: JSON.parse(run.stdout.trim().split('\n').at(-1)), stderr: run.stderr };
};
async function applied(request) {
  const prepared = await prepare(request);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = conforms(await apply(prepared.handle, approve(conforms(prepared.review))));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  return { prepared, run };
}
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

await check('the change formats ship one schema each, read portably, with a canonical identity', async () => {
  for (const id of ['urn:aihq:core:change:0.1.0', 'urn:aihq:core:change-request:0.1.0']) {
    assert.equal(validateFormat(schemas[id].fixtures.valid).status, 'ok');
    assert.equal(validateFormat(schemas[id].fixtures.invalid).status, 'invalid');
  }
  assert.equal(validateChange(codexApproval()).status, 'ok');
  assert.match((await deriveChangeIdentity({ change: codexApproval() })).changeIdentity, /^sha256:[a-f0-9]{64}$/);
  const file = join(process.env.HOME, 'change.json'); writeFileSync(file, JSON.stringify(codexApproval()));
  const read = aih(['validate', 'change', file]);
  assert.deepEqual([read.code, read.result.status], [0, 'ok']);
});

await check('a settings edit through `aih change` lands in ~/.codex/config.toml, and removal restores it byte for byte', async () => {
  const codex = join(process.env.HOME, '.codex'); mkdirSync(codex, { recursive: true });
  const original = '# mine\nmodel = "o3"\n';
  writeFileSync(join(codex, 'config.toml'), original);
  const file = join(process.env.HOME, 'settings-request.json');
  writeFileSync(file, JSON.stringify(changeRequest([{ managementId: 'codex-approval-on-request', change: codexApproval() }], { scope: 'user' })));
  const preview = aih(['change', file]);
  assert.deepEqual([preview.code, preview.result.status, preview.result.review.request], [0, 'ready', 'change']);
  const run = aih(['change', file, '--apply', '--yes']);
  assert.deepEqual([run.code, run.result.completion], [0, 'complete'], JSON.stringify(run.result));
  assert.match(readFileSync(join(codex, 'config.toml'), 'utf8'), /approval_policy = "on-request"/);
  const listed = aih(['list', '--scope', 'user']);
  assert.ok(listed.result.entries.some(entry => entry.managementId === 'codex-approval-on-request'));
  const removed = aih(['remove', 'codex-approval-on-request', '--scope', 'user', '--apply', '--yes']);
  assert.deepEqual([removed.code, removed.result.completion], [0, 'complete'], JSON.stringify(removed.result));
  assert.equal(readFileSync(join(codex, 'config.toml'), 'utf8'), original);
});

await check('a named group proposes removal of an omitted member, and an empty group removes the rest; unrelated content remains', async () => {
  const target = project('group');
  writeFileSync(join(target, 'NOTES.md'), 'unrelated\n');
  const guide = { managementId: 'team-guide', change: teamFile('team-guide', 'TEAM.md'), inputs: { text: 'Guide.\n' } };
  const style = { managementId: 'team-style', change: teamFile('team-style', 'STYLE.md'), inputs: { text: 'Style.\n' } };
  await applied(changeRequest([guide, style], { project: target, groups: [{ id: 'team', members: ['team-guide', 'team-style'] }] }));
  const next = await prepare(changeRequest([guide], { project: target, groups: [{ id: 'team', members: ['team-guide'] }] }));
  assert.deepEqual(next.review.steps.filter(step => step.effect === 'remove-file').map(step => [step.managementId, step.path]), [['team-style', 'STYLE.md']]);
  conforms(await apply(next.handle, approve(next.review)));
  assert.deepEqual([existsSync(join(target, 'STYLE.md')), existsSync(join(target, 'TEAM.md'))], [false, true]);
  const empty = await prepare(changeRequest([], { project: target, groups: [{ id: 'team', members: [] }] }));
  conforms(await apply(empty.handle, approve(empty.review)));
  assert.equal(existsSync(join(target, 'TEAM.md')), false);
  assert.equal(readFileSync(join(target, 'NOTES.md'), 'utf8'), 'unrelated\n');
  assert.deepEqual(conforms(await list({ target: { project: target }, scope: 'project' })).entries, []);
});

await check('a required change is retained while its dependant stays installed', async () => {
  const target = project('requires');
  await applied(changeRequest([{ managementId: 'base-setting', change: projectSetting('base-setting', 'base', 'on') },
    { managementId: 'guide', change: teamFile('guide', 'GUIDE.md'), inputs: { text: 'Uses base.\n' }, requires: ['base-setting'] }], { project: target }));
  const held = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: 'base-setting' }] });
  assert.deepEqual(held.entries.map(entry => entry.disposition), ['retained']);
  const removed = aih(['remove', 'guide', 'base-setting', '--scope', 'project', '--project', target, '--apply', '--yes']);
  assert.deepEqual([removed.code, removed.result.completion], [0, 'complete'], JSON.stringify(removed.result));
  assert.equal(existsSync(join(target, 'GUIDE.md')), false);
});

await check('an exact command is shown in full before it runs, and a failed one is reported as uncertain', async () => {
  const target = project('command');
  const script = 'require("fs").writeFileSync("command-output.txt", process.env.AIH_EXAMPLE)';
  const file = join(target, '..', 'command-request.json');
  writeFileSync(file, JSON.stringify(changeRequest([{ managementId: 'touch', change: commandChange('touch', ['-e', script]) }], { project: target })));
  const preview = aih(['change', file]);
  const [step] = conforms(preview.result.review).steps;
  assert.deepEqual([step.op, step.effect, step.details.executable, step.details.args, step.details.cwd, step.details.env, step.details.acceptedExitCodes],
    ['process.run', 'opaque-process', process.execPath, [JSON.stringify('-e'), JSON.stringify(script)], target, { AIH_EXAMPLE: '"set"' }, [0]]);
  const run = aih(['change', file, '--apply', '--yes']);
  assert.deepEqual([run.code, run.result.completion], [0, 'complete']);
  assert.equal(readFileSync(join(target, 'command-output.txt'), 'utf8'), 'set');
  writeFileSync(file, JSON.stringify(changeRequest([{ managementId: 'fail', change: commandChange('fail', ['-e', 'process.exit(3)']) }], { project: target })));
  const failed = aih(['change', file, '--apply', '--yes']);
  assert.deepEqual([failed.code, failed.result.completion, failed.result.steps[0].effectsUncertain], [1, 'incomplete', true]);
});

await check('a reviewed replace of your file keeps your original, and removal writes it back', async () => {
  const target = project('restore');
  writeFileSync(join(target, 'TEAM.md'), 'my own notes\n');
  const request = changeRequest([{ managementId: 'team-guide', change: teamFile('team-guide', 'TEAM.md'), inputs: { text: 'Shared.\n' } }], { project: target });
  const blocked = await prepare(request);
  assert.equal(blocked.status, 'blocked');
  const [conflict] = conforms(blocked.review).conflicts;
  await applied({ ...request, resolutions: [{ managementId: 'team-guide', step: conflict.step, choice: 'replace', observedSha256: conflict.observedSha256 }] });
  assert.equal(readFileSync(join(target, 'TEAM.md'), 'utf8'), 'Shared.\n');
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: 'team-guide' }] });
  assert.equal(conforms(await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.equal(readFileSync(join(target, 'TEAM.md'), 'utf8'), 'my own notes\n');
});

console.log(JSON.stringify({ status: 'passed', checks }));
