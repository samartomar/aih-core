// Runs inside a disposable consumer with the packed @aihq/core installed; public entries only.
// Interrupted installs: a pending receipt before the first effect, `installState: interrupted` with the members actually
// written (also after the process is killed and restarted), and a reviewed finish or removal through the ordinary path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { removalClaims, runMemberClaims } from '@aihq/core/contracts';
import { apply, listManagedSelections, prepare, prepareManagedRemoval } from '@aihq/core';

const require = createRequire(import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const INVENTORY_11 = 'urn:aihq:core:managed-inventory-result:1.1.0';
const REMOVAL_12 = 'urn:aihq:core:managed-removal-preparation:1.2.0';
const FILES = { 'SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nTake notes.\n', LICENSE: 'MIT for notes\n', 'reference.md': 'Reference for notes.\n' };

const literal = value => ({ literal: value });
const file = (id, name, requires, checks = []) => ({ id, purpose: `Write ${name}`, kind: 'file.write', scope: 'project',
  target: { root: 'project', segments: [literal('skills'), literal('notes'), literal(name)] }, content: literal(FILES[name]), requires, checks });
// A guarded step that acts only while its sentinel exists, and consumes it: the first run is interrupted, a finish is not.
const guarded = (action, env, sentinel) => ({ executable: { name: process.execPath }, args: [literal('--input-type=module'), literal('-e'), literal(
  `import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
   if (existsSync(process.env.AIH_SENTINEL)) { unlinkSync(process.env.AIH_SENTINEL); ${action} }`)],
  cwd: { root: 'project', segments: [] }, env: Object.fromEntries(Object.entries({ ...env, AIH_SENTINEL: sentinel }).map(([key, value]) => [key, literal(value)])),
  timeoutMs: 60000, maxOutputBytes: 4096, acceptedExitCodes: [0] });
const kill = 'process.kill(Number(process.env.AIH_HOST_PID), "SIGKILL"); await new Promise(resolve => setTimeout(resolve, 60000));';

/**
 * One skill selection: a probe step first (it can read the inventory while Apply runs), then three files in order.
 * `crash` chooses where the host process dies: `probe` before any file, `licence` in the check after LICENSE,
 * `fail` makes that check fail instead so Apply stops gracefully.
 */
function document(work, crash, hostPid = 0) {
  const probe = join(work, 'probe.json');
  const env = { AIH_HOST_PID: String(hostPid), AIH_PROBE: probe, AIH_CORE: import.meta.resolve('@aihq/core'),
    AIH_PROJECT: join(work, 'project'), HOME: process.env.HOME, USERPROFILE: process.env.HOME };
  const probeAction = `const { listManagedSelections } = await import(process.env.AIH_CORE);
    writeFileSync(process.env.AIH_PROBE, JSON.stringify(await listManagedSelections({ target: { project: process.env.AIH_PROJECT }, scope: 'project',
      format: 'urn:aihq:core:managed-inventory-result:1.1.0' })));${crash === 'probe' ? kill : ''}`;
  const gate = crash === 'fail' ? 'process.exit(5);' : crash === 'licence' ? kill : '';
  const recipe = { schema: 'urn:aihq:core:recipe:1.0.0', id: 'notes', description: 'Notes skill', inputs: {}, materials: [], targets: ['project'],
    prerequisites: [], checks: [{ id: 'gate', purpose: 'Gate after the licence', kind: 'process.exit', ...guarded(gate, env, join(work, 'gate-sentinel')) }],
    operations: [
      { id: 'probe', purpose: 'Probe the inventory before any file', kind: 'process.run', scope: 'project', requires: [], checks: [],
        ...guarded(probeAction, env, join(work, 'probe-sentinel')), effects: ['Writes an inventory probe outside the project'] },
      file('skill', 'SKILL.md', ['probe']), file('licence', 'LICENSE', ['skill'], ['gate']), file('reference', 'reference.md', ['licence'])] };
  return { schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections: [{ id: 'notes', managementId: 'notes-managed', scope: 'project',
    configuration: {}, requires: [], recipe: { inline: recipe },
    item: { framework: 'example-framework', itemId: 'notes', contentSha256: sha256('content'), behaviourSha256: sha256('behaviour') },
    tool: 'claude', name: 'Notes', kind: 'skill', origins: [{ reasonIncluded: 'chosen' }] }] };
}
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });

// Child mode: install with a step that kills this very process.
if (process.argv[2] === 'host') {
  const [, , , work, crash] = process.argv;
  const prepared = await prepare({ useCase: 'policy', policy: document(work, crash, process.pid), target: { project: join(work, 'project') } }, { logging: 'on' });
  if (prepared.status !== 'ready') { console.log(JSON.stringify(prepared.diagnostics)); process.exit(3); }
  writeFileSync(join(work, crash === 'probe' ? 'probe-sentinel' : 'gate-sentinel'), 'armed');
  const result = await apply(prepared.prepared, approve(prepared.review), { logging: 'on' });
  console.log(JSON.stringify(result.completion));
  process.exit(4);
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const id of ['prepared-work/1.0.0', 'prepared-work/1.1.0', 'prepared-work/1.4.0', 'prepared-work/1.5.0', 'prepared-work/1.6.0', 'run-result/1.0.0', 'run-result/1.1.0', 'run-result/1.4.0',
  'managed-inventory-result/1.1.0', 'managed-removal-preparation/1.0.0', 'managed-removal-preparation/1.2.0'])
  ajv.addSchema(JSON.parse(readFileSync(require.resolve(`@aihq/core/schemas/${id}.json`))));
const projection = value => value?.preparation?.prepared ? { ...value, preparation: (({ prepared: _handle, ...rest }) => rest)(value.preparation) } : value;
const conforms = (value, id) => {
  const validate = ajv.getSchema(id);
  assert.equal(validate(plain(projection(value))), true, `${id}: ${JSON.stringify(validate.errors)}`);
  return value;
};
const outputs = [];
const keep = value => { outputs.push(value); return value; };
const inventory = async project => conforms(keep(await listManagedSelections({ target: { project }, scope: 'project', format: INVENTORY_11 })), INVENTORY_11);
const rowOf = (listed, managementId = 'notes-managed') => listed.selections.find(row => row.managementId === managementId);
const names = row => row.members.map(member => [basename(member.path), member.fileState]);
const prepareFor = async (work, crash = 'none') => keep(await prepare({ useCase: 'policy', policy: document(work, crash), target: { project: join(work, 'project') } }, { logging: 'on' }));
const run = async prepared => keep(conforms(await apply(prepared.prepared, approve(prepared.review), { logging: 'on' }), 'urn:aihq:core:run-result:1.4.0'));
const effects = review => Object.fromEntries(review.operations.map(operation => [operation.id, operation.effects]));
const skillFile = (work, name) => join(work, 'project', 'skills', 'notes', name);
function workspace(prefix) {
  const work = mkdtempSync(join(process.env.HOME, `${prefix}-`));
  mkdirSync(join(work, 'project'));
  return work;
}
/** Install in a separate host process that a step kills; the next call is a restart. */
function interrupt(work, crash) {
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'host', work, crash],
    { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(child.signal ?? (process.platform === 'win32' && child.status !== 0 && child.status !== 3 && child.status !== 4 ? 'SIGKILL' : null), 'SIGKILL',
    `the host must die mid-Apply: ${child.status} ${child.stdout} ${child.stderr}`);
  assert.equal(existsSync(join(work, crash === 'probe' ? 'probe-sentinel' : 'gate-sentinel')), false, 'the killing step ran');
}
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

await check('the pending receipt exists before the first effect: the inventory reads interrupted with no member while Apply runs', async () => {
  const work = workspace('probe');
  interrupt(work, 'probe');
  const probed = conforms(JSON.parse(readFileSync(join(work, 'probe.json'), 'utf8')), INVENTORY_11);
  assert.equal(probed.status, 'complete', JSON.stringify(probed.diagnostics));
  const row = rowOf(probed);
  assert.ok(row, 'the selection is listed before any of its files is written');
  assert.deepEqual([row.installState, row.name, row.kind, row.members.length, row.custody], ['interrupted', 'Notes', 'skill', 0, 'claim']);
  assert.equal(existsSync(skillFile(work, 'SKILL.md')), false, 'the probe ran before the first file');
  // After the restart nothing was written, and the interrupted install is still found; its reviewed removal clears it.
  const listed = await inventory(join(work, 'project'));
  assert.deepEqual([rowOf(listed).installState, rowOf(listed).members], ['interrupted', []]);
  const removal = conforms(keep(await prepareManagedRemoval({ target: { project: join(work, 'project') }, scope: 'project',
    removals: [{ managementId: 'notes-managed' }] }, { logging: 'on' })), REMOVAL_12);
  assert.equal(removal.disposition, 'prepared', JSON.stringify(removal));
  assert.equal(removal.preparation.status, 'ready', JSON.stringify(removal.preparation.diagnostics));
  assert.deepEqual(removal.removals[0].members, []);
  const removed = await run(removal.preparation);
  assert.equal(removed.completion, 'complete', JSON.stringify(removed.diagnostics));
  assert.equal(removalClaims(removal, removed).removals[0].claim, 'removed');
  assert.equal(rowOf(await inventory(join(work, 'project'))), undefined, 'a removed interrupted install is no longer listed');
});

await check('after a kill and restart the inventory lists exactly the members written, and a reviewed finish completes it', async () => {
  const work = workspace('finish');
  interrupt(work, 'licence');
  const listed = await inventory(join(work, 'project'));
  assert.equal(listed.status, 'complete', JSON.stringify(listed.diagnostics));
  const row = rowOf(listed);
  assert.equal(row.installState, 'interrupted');
  assert.deepEqual(names(row), [['LICENSE', 'matches'], ['SKILL.md', 'matches']], 'only written members, never the intended reference.md');
  assert.equal(existsSync(skillFile(work, 'reference.md')), false);
  // The finish is a fresh review of the same selection: written members are already in place and owned.
  const finish = await prepareFor(work);
  assert.equal(finish.status, 'ready', JSON.stringify(finish.diagnostics));
  assert.deepEqual(effects(finish.review), { 'notes/probe': 'opaque-process', 'notes/skill': 'already-satisfied', 'notes/licence': 'already-satisfied',
    'notes/reference': 'create-file' });
  const finished = await run(finish);
  assert.equal(finished.completion, 'complete', JSON.stringify(finished.diagnostics));
  assert.equal(runMemberClaims(finished).confirmedOnDisk, true);
  const done = rowOf(await inventory(join(work, 'project')));
  assert.equal(done.installState, 'complete');
  assert.deepEqual(names(done), [['LICENSE', 'matches'], ['SKILL.md', 'matches'], ['reference.md', 'matches']]);
  // A finished install removes completely.
  const removal = conforms(keep(await prepareManagedRemoval({ target: { project: join(work, 'project') }, scope: 'project',
    removals: [{ managementId: 'notes-managed' }] }, { logging: 'on' })), REMOVAL_12);
  const removed = await run(removal.preparation);
  assert.equal(removalClaims(removal, removed).removals[0].claim, 'removed');
  for (const name of Object.keys(FILES)) assert.equal(existsSync(skillFile(work, name)), false, name);
});

await check('a reviewed finish keeps a local edit as a conflict instead of overwriting it', async () => {
  const work = workspace('edit-finish');
  interrupt(work, 'licence');
  writeFileSync(skillFile(work, 'SKILL.md'), 'My own notes.\n');
  const listed = rowOf(await inventory(join(work, 'project')));
  assert.deepEqual(names(listed), [['LICENSE', 'matches'], ['SKILL.md', 'changed']]);
  const finish = await prepareFor(work);
  assert.equal(finish.status, 'partial', JSON.stringify(finish.diagnostics));
  assert.deepEqual(finish.review.conflicts.map(item => [item.reason, item.path]), [['existing-content', 'skills/notes/SKILL.md']]);
  assert.equal(effects(finish.review)['notes/skill'], 'conflict');
  const refused = keep(await apply(finish.prepared, approve(finish.review), { logging: 'on' }));
  assert.deepEqual([refused.completion, refused.diagnostics[0]?.reason], ['rejected', 'partial-approval-required']);
  assert.equal(readFileSync(skillFile(work, 'SKILL.md'), 'utf8'), 'My own notes.\n');
  assert.equal(rowOf(await inventory(join(work, 'project'))).installState, 'interrupted');
});

await check('a reviewed removal of an interrupted install removes what was written and keeps a changed member with its licence', async () => {
  const work = workspace('removal');
  interrupt(work, 'licence');
  const clean = workspace('removal-clean');
  interrupt(clean, 'licence');
  // Unchanged: everything written is removed and the claim is confirmed.
  const removal = conforms(keep(await prepareManagedRemoval({ target: { project: join(clean, 'project') }, scope: 'project',
    removals: [{ managementId: 'notes-managed' }] }, { logging: 'on' })), REMOVAL_12);
  assert.equal(removal.preparation.status, 'ready', JSON.stringify(removal.preparation.diagnostics));
  assert.deepEqual(removal.removals[0].members.map(member => [basename(member.path), member.action]).sort(), [['LICENSE', 'remove'], ['SKILL.md', 'remove']]);
  const removed = await run(removal.preparation);
  assert.equal(removalClaims(removal, removed).removals[0].claim, 'removed');
  assert.equal(rowOf(await inventory(join(clean, 'project'))), undefined);
  assert.equal(existsSync(skillFile(clean, 'SKILL.md')), false);
  // Changed: the edit stays with its licence; the install remains interrupted and listed.
  writeFileSync(skillFile(work, 'SKILL.md'), 'My own notes.\n');
  const partial = conforms(keep(await prepareManagedRemoval({ target: { project: join(work, 'project') }, scope: 'project',
    removals: [{ managementId: 'notes-managed' }] }, { logging: 'on' })), REMOVAL_12);
  assert.deepEqual(partial.removals[0].members.map(member => [basename(member.path), member.action]).sort(),
    [['LICENSE', 'keep-required'], ['SKILL.md', 'keep-changed']]);
  const kept = await run(partial.preparation);
  assert.equal(removalClaims(partial, kept).removals[0].claim, 'partly-removed');
  assert.equal(readFileSync(skillFile(work, 'SKILL.md'), 'utf8'), 'My own notes.\n');
  const row = rowOf(await inventory(join(work, 'project')));
  assert.deepEqual([row.installState, names(row)], ['interrupted', [['LICENSE', 'matches'], ['SKILL.md', 'changed']]]);
});

await check('a gracefully stopped install is interrupted, never confirmed on disk, and its consumed review cannot be applied again', async () => {
  const work = workspace('graceful');
  const prepared = await prepareFor(work, 'fail');
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  writeFileSync(join(work, 'gate-sentinel'), 'armed');
  const result = await run(prepared);
  assert.equal(result.completion, 'incomplete');
  const written = result.members.filter(member => member.intent === 'write' && member.outcome === 'written');
  assert.deepEqual(written.map(member => [basename(member.path), member.check]).sort(), [['LICENSE', 'present-matching'], ['SKILL.md', 'present-matching']]);
  assert.equal(runMemberClaims(result).confirmedOnDisk, false, 'a matching written subset never confirms an interrupted run');
  assert.equal(runMemberClaims({ ...result, members: written }).confirmedOnDisk, false);
  const row = rowOf(await inventory(join(work, 'project')));
  assert.deepEqual([row.installState, names(row)], ['interrupted', [['LICENSE', 'matches'], ['SKILL.md', 'matches']]]);
  const again = keep(await apply(prepared.prepared, approve(prepared.review), { logging: 'on' }));
  assert.deepEqual([again.completion, again.diagnostics[0]?.reason], ['rejected', 'handle-unavailable']);
  const finished = await run(await prepareFor(work));
  assert.equal(finished.completion, 'complete', JSON.stringify(finished.diagnostics));
  assert.equal(rowOf(await inventory(join(work, 'project'))).installState, 'complete');
  // Repeating the finished install changes nothing and stays complete.
  const repeat = await run(await prepareFor(work));
  assert.equal(repeat.completion, 'complete');
  assert.ok(repeat.operations.filter(operation => operation.id !== 'notes/probe').every(operation => operation.application === 'already-satisfied'));
});

await check('no inventory, also while interrupted, carries a member digest or the item content', async () => {
  const listed = outputs.filter(output => output?.schema === INVENTORY_11);
  assert.ok(listed.some(output => output.selections.some(row => row.installState === 'interrupted')));
  const text = JSON.stringify(listed);
  for (const content of Object.values(FILES)) {
    assert.equal(text.includes(sha256(content)), false);
    assert.equal(text.includes(JSON.stringify(content).slice(1, -1)), false);
  }
});

console.log(JSON.stringify({ status: 'passed', checks }));
