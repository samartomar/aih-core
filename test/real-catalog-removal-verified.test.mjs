// Removal must check the disk it leaves, not rely on a Catalog check that a cleanup operation never had. Every
// cleanup operation reports "passed" from the member check, and each requested removal claims "removed".
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { apply, prepareManagedRemoval } from '../dist/core/index.js';
import { removalClaims } from '../dist/core/contracts.js';
import { sandbox } from './hook-group-fixture.mjs';
import { approve, assertVendoredRelease, installReal } from './real-catalog-fixture.mjs';

let live = [];
afterEach(() => { for (const s of live) s.dispose(); live = []; });

test('every cleanup operation of a complete removal is verified on disk', async () => {
  assertVendoredRelease();
  const s = sandbox('aih-real-verified-'); live.push(s);
  const { selections } = await installReal(s);
  const result = await prepareManagedRemoval({ target: { project: s.project }, scope: 'project',
    removals: selections.map(selection => ({ managementId: selection.managementId })) }, { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  const run = await apply(result.preparation.prepared, approve({ reviewDigest: result.reviewDigest }), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.ok(run.operations.length > 0);
  assert.deepEqual([...new Set(run.operations.map(operation => operation.verification.status))], ['passed']);
  assert.deepEqual([...new Set(run.operations.map(operation => operation.verification.reason))], ['member-checked']);
  const removed = run.members.filter(member => member.intent !== 'write');
  assert.ok(removed.length > 0);
  assert.ok(removed.every(member => member.check === 'absent' || member.check === 'present-matching'), JSON.stringify(removed.filter(member => !['absent', 'present-matching'].includes(member.check))));
  assert.deepEqual(removalClaims(result, run).removals.map(entry => entry.claim), selections.map(() => 'removed'));
});
