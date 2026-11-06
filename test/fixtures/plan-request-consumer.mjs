// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Own-folder content through a plan request (urn:aihq:core:plan-request:0.1.0). The plan, content and profile
// documents and the `@aihq/catalog/node` package beside Core are Core-side FIXTURES (plan-fixture.mjs,
// catalog-node-fixture); they establish Core behaviour, not Catalog or client compatibility.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateFormat } from '@aihq/core/contracts';
import { apply, list, prepare, prepareRemoval } from '@aihq/core';
import { ownRequest, savedDocument } from './plan-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS = { notes: { 'SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nTake notes.\n', 'reference.md': 'Reference.\n' } };
const ID = 'local-my-skills.skill.notes';
const approve = (review, extra = {}) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...extra });
const conforms = value => { assert.deepEqual(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const listed = async target => conforms(await list({ target: { project: target }, scope: 'project' }));
const entry = async target => (await listed(target)).entries.find(row => row.managementId === ID);
function snapshot(folder) {
  const out = {};
  const walk = (dir, prefix) => { for (const item of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) walk(join(dir, item.name), rel); else out[rel] = readFileSync(join(dir, item.name), 'utf8');
  } };
  walk(folder, ''); return out;
}
function project(name) {
  const path = mkdtempSync(join(process.env.HOME, `${name}-`));
  writeFileSync(join(path, 'README.md'), 'mine\n');
  return path;
}
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

// Child mode: one install whose host process is killed after its Nth published file.
if (process.argv[2] === 'host') {
  const prepared = await prepare(ownRequest(process.argv[3], SKILLS));
  if (prepared.status !== 'ready') { console.log(JSON.stringify(prepared)); process.exit(3); }
  await apply(prepared.handle, approve(prepared.review));
  process.exit(4);
}

await check('own content for Claude, Codex and Kiro: frozen review, apply, list as chosen with data null, removal restores the project byte for byte', async () => {
  const target = project('own');
  const before = snapshot(target);
  const prepared = await prepare(ownRequest(target, SKILLS));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  assert.equal(JSON.stringify(prepared.review).includes('Take notes.'), false);
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(run.members.length, 6);
  assert.ok(run.members.every(member => member.check === 'present-matching'));
  for (const place of ['.claude/skills', '.agents/skills', '.kiro/skills'])
    assert.equal(readFileSync(join(target, place, 'notes/SKILL.md'), 'utf8'), SKILLS.notes['SKILL.md']);
  const row = await entry(target);
  assert.deepEqual([row.origin, row.data, row.clis, row.installState], ['chosen', null, ['claude-code', 'codex', 'kiro'], 'complete']);
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: ID }] });
  conforms(removal.review);
  assert.equal(conforms(await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.deepEqual(snapshot(target), before);
});

await check('a changed source is refused before any effect, and bytes changed after Prepare reject the review', async () => {
  const target = project('source');
  const before = snapshot(target);
  const request = ownRequest(target, SKILLS);
  request.files[0].bytes = Buffer.from('not what the plan names');
  const refused = await prepare(request);
  assert.deepEqual([refused.status, refused.code], ['refused', 'source-mismatch']);
  const later = ownRequest(target, SKILLS);
  const prepared = await prepare(later);
  later.files[1].bytes = Buffer.from('changed after review');
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.deepEqual([run.completion, run.code, run.changed], ['rejected', 'REVIEW_STALE', 'binding']);
  assert.deepEqual(snapshot(target), before);
});

await check('a target or receipt that changes after Prepare rejects the review without effects', async () => {
  const target = project('stale');
  const prepared = await prepare(ownRequest(target, SKILLS));
  mkdirSync(join(target, '.kiro/skills/notes'), { recursive: true });
  writeFileSync(join(target, '.kiro/skills/notes/SKILL.md'), 'mine first\n');
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.deepEqual([run.completion, run.code, run.changed], ['rejected', 'REVIEW_STALE', 'target-file']);
  assert.equal(existsSync(join(target, '.claude/skills/notes/SKILL.md')), false, 'nothing was written');
  rmSync(join(target, '.kiro'), { recursive: true });
  const installed = await prepare(ownRequest(target, SKILLS));
  assert.equal((await apply(installed.handle, approve(installed.review))).completion, 'complete');
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: ID }] });
  const other = await prepare(ownRequest(target, { other: { 'SKILL.md': 'Other.\n' } }));
  assert.equal((await apply(other.handle, approve(other.review))).completion, 'complete');
  const stale = conforms(await apply(removal.handle, approve(removal.review)));
  assert.deepEqual([stale.completion, stale.code], ['rejected', 'REVIEW_STALE']);
  assert.equal(existsSync(join(target, '.claude/skills/notes/SKILL.md')), true);
});

await check('cancellation before Prepare and before Apply reports cancelled and writes nothing', async () => {
  const target = project('cancel');
  const before = snapshot(target);
  const controller = new AbortController(); controller.abort();
  const refused = await prepare(ownRequest(target, SKILLS), { signal: controller.signal });
  assert.deepEqual([refused.status, refused.code], ['refused', 'cancelled']);
  const prepared = await prepare(ownRequest(target, SKILLS));
  assert.equal(conforms(await apply(prepared.handle, approve(prepared.review), { signal: controller.signal })).completion, 'cancelled');
  assert.deepEqual(snapshot(target), before);
});

await check('an install killed between two writes is found interrupted after a restart, with exactly the written member; a fresh review finishes it, removal removes what was written', async () => {
  const interrupt = target => {
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(join(here, 'kill-after-writes.mjs')).href, fileURLToPath(import.meta.url), 'host', target],
      { env: { ...process.env, AIH_KILL_UNDER: target, AIH_KILL_STATE: join(process.env.HOME, '.aih', 'core', 'ownership'), AIH_KILL_AFTER: '2' }, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    assert.ok(child.signal === 'SIGKILL' || process.platform === 'win32' && ![0, 3, 4].includes(child.status),
      `the host must die mid-Apply: ${child.status} ${child.signal} ${child.stdout} ${child.stderr}`);
  };
  const target = project('interrupted');
  interrupt(target);
  const row = await entry(target);
  assert.equal(row.installState, 'interrupted');
  assert.equal(row.members.length, 2, JSON.stringify(row.members));
  assert.ok(row.members.every(member => member.state === 'matching'));
  const finish = await prepare(ownRequest(target, SKILLS));
  assert.equal(finish.status, 'ready', JSON.stringify(finish));
  assert.equal(finish.review.steps.filter(step => step.effect === 'already-satisfied').length, 2);
  assert.equal(conforms(await apply(finish.handle, approve(finish.review))).completion, 'complete');
  assert.deepEqual([(await entry(target)).installState, (await entry(target)).members.length], ['complete', 6]);

  const removed = project('interrupted-removal');
  const before = snapshot(removed);
  interrupt(removed);
  assert.equal((await entry(removed)).installState, 'interrupted');
  const removal = await prepareRemoval({ target: { project: removed }, scope: 'project', removals: [{ managementId: ID }] });
  assert.equal(removal.entries[0].members.length, 2);
  assert.equal(conforms(await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.deepEqual(snapshot(removed), before);
  assert.equal(await entry(removed), undefined);
});

await check('the aih CLI installs from a saved request with --source, lists, and removes, with the contract exit codes', async () => {
  const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
  const aih = args => {
    const child = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return { code: child.status, result: JSON.parse(child.stdout.trim().split('\n').at(-1)) };
  };
  const target = project('cli');
  const before = snapshot(target);
  const source = mkdtempSync(join(process.env.HOME, 'source-'));
  const request = ownRequest(target, SKILLS);
  for (const file of request.files) { mkdirSync(dirname(join(source, file.sourcePath)), { recursive: true }); writeFileSync(join(source, file.sourcePath), file.bytes); }
  const saved = savedDocument(request);
  delete saved.target.project;
  const document = join(source, '..', 'plan-request.json');
  writeFileSync(document, JSON.stringify(saved));
  const noProject = aih(['install', document, '--json']);
  assert.deepEqual([noProject.code, noProject.result.status], [2, 'invalid'], 'the CLI never takes the project from the working folder');
  const missing = aih(['install', document, '--project', target, '--json']);
  assert.deepEqual([missing.code, missing.result.code], [2, 'source-missing']);
  const preview = aih(['install', document, '--project', target, '--source', `local-my-skills=${source}`, '--json']);
  assert.deepEqual([preview.code, preview.result.status, preview.result.handle], [0, 'ready', undefined], JSON.stringify(preview));
  assert.deepEqual(snapshot(target), before, 'a preview writes nothing');
  const installed = aih(['install', document, '--project', target, '--source', `local-my-skills=${source}`, '--apply', '--yes', '--json']);
  assert.deepEqual([installed.code, installed.result.completion], [0, 'complete'], JSON.stringify(installed));
  const inventory = aih(['list', '--project', target, '--scope', 'project', '--json']);
  assert.deepEqual([inventory.code, inventory.result.entries.map(row => [row.managementId, row.origin])], [0, [[ID, 'chosen']]]);
  const byCli = aih(['remove', ID, '--scope', 'project', '--project', target, '--cli', 'codex', '--json']);
  // The plan records each step's CLIs, so removal for one CLI is prepared (a preview: nothing changes yet).
  assert.deepEqual([byCli.code, byCli.result.status, byCli.result.entries[0].disposition], [0, 'ok', 'prepared'], JSON.stringify(byCli));
  const absent = aih(['remove', 'not-installed', '--scope', 'project', '--project', target, '--json']);
  assert.deepEqual([absent.code, absent.result.entries[0].disposition], [1, 'absent']);
  const removed = aih(['remove', ID, '--scope', 'project', '--project', target, '--apply', '--yes', '--json']);
  assert.deepEqual([removed.code, removed.result.completion], [0, 'complete'], JSON.stringify(removed));
  assert.deepEqual(snapshot(target), before);
});

console.log(JSON.stringify({ status: 'passed', checks }));
