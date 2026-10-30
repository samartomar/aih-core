// Recovery snapshots exist only so a failed or partial removal can be inspected. A successful, verified removal
// removes its own run folder; a removal that keeps an edited member leaves it for the person.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { apply, prepareManagedRemoval } from '../dist/core/index.js';
import { sandbox } from './hook-group-fixture.mjs';
import { approve, assertVendoredRelease, installReal } from './real-catalog-fixture.mjs';

const recovery = s => join(s.home, '.aih', 'core', 'recovery');
const recoveryFiles = (s, runId) => { const dir = join(recovery(s), runId); return existsSync(dir) ? readdirSync(dir) : []; };
let live = [];
afterEach(() => { for (const s of live) s.dispose(); live = []; });
const open = () => { const s = sandbox('aih-real-recovery-'); live.push(s); return s; };

async function removeAll(s, selections) {
  const result = await prepareManagedRemoval({ target: { project: s.project }, scope: 'project',
    removals: selections.map(selection => ({ managementId: selection.managementId })) }, { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  const run = await apply(result.preparation.prepared, approve({ reviewDigest: result.reviewDigest }), { logging: 'off' });
  return { result, run };
}

test('a successful removal deletes the recovery snapshots of its own run', async () => {
  assertVendoredRelease();
  const s = open(), { selections, run: installed } = await installReal(s);
  assert.ok(recoveryFiles(s, installed.runId).some(name => name.endsWith('.bin')), 'the install kept its recovery bytes');
  const { result, run } = await removeAll(s, selections);
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.deepEqual(recoveryFiles(s, run.runId), [], 'the verified removal leaves no recovery data');
});

test('a removal that keeps an edited hook group keeps its recovery snapshots', async () => {
  assertVendoredRelease();
  const s = open(), { selections } = await installReal(s);
  const settings = s.read('.claude/settings.json');
  s.write('.claude/settings.json', settings.replace('"type": "command"', '"type":  "command"'));
  const { result, run } = await removeAll(s, selections);
  const files = recoveryFiles(s, run.runId);
  assert.ok(files.includes('manifest.json'), 'the partial removal keeps its manifest');
  assert.ok(files.some(name => name.endsWith('.bin')), 'the partial removal keeps the original bytes it may need');
  assert.ok(Array.isArray(result.removals) && result.removals.some(entry => entry.members.some(member => member.action === 'keep-changed')),
    JSON.stringify(result.removals?.map(entry => [entry.managementId, entry.members.map(member => member.action)])));
});

test('a removal whose member is changed again before the check fails it and keeps its recovery data', async () => {
  assertVendoredRelease();
  const s = open(), { selections } = await installReal(s);
  const skill = '.claude/skills/verification-before-completion/SKILL.md';
  const result = await prepareManagedRemoval({ target: { project: s.project }, scope: 'project',
    removals: selections.map(selection => ({ managementId: selection.managementId })) }, { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  // Apply yields to the host between operations; once the skill's removal has landed, something else writes the
  // path again with other bytes, before the run checks what it left.
  let rewritten = false, applying = true;
  const watch = () => {
    if (!applying) return;
    if (!rewritten && !existsSync(join(s.project, skill))) { s.write(skill, 'written by someone else\n'); rewritten = true; }
    setImmediate(watch);
  };
  setImmediate(watch);
  const run = await apply(result.preparation.prepared, approve({ reviewDigest: result.reviewDigest }), { logging: 'off' })
    .finally(() => { applying = false; });
  assert.equal(rewritten, true, 'the path was written again during Apply');
  const member = run.members.find(entry => entry.path.replaceAll('\\', '/').endsWith(skill));
  assert.equal(member.check, 'present-different', JSON.stringify(member));
  const operation = run.operations.find(entry => entry.id === member.operationId);
  assert.deepEqual(operation.verification, { status: 'failed', reason: 'member-changed' });
  assert.equal(run.completion, 'incomplete');
  assert.ok(run.recovery, 'the result still names its recovery data');
  const files = recoveryFiles(s, run.runId);
  assert.ok(files.includes('manifest.json'), 'the failed removal keeps its manifest');
  assert.ok(files.some(name => name.endsWith('.bin')), 'the failed removal keeps the original bytes it may need');
});
