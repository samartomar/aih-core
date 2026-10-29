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
