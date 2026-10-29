// Removal must check the disk it leaves, not rely on a Catalog check that a cleanup operation never had. Every
// cleanup operation reports "passed" from the member check, and each requested removal claims "removed".
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { apply, prepare, prepareManagedRemoval } from '../dist/core/index.js';
import { removalClaims } from '../dist/core/contracts.js';
import { sandbox } from './hook-group-fixture.mjs';
import { approve, assertVendoredRelease, controls, installReal } from './real-catalog-fixture.mjs';

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

// Run results before 1.4 carry no member checks, so their documented cleanup wording stands: a removal reports
// unverified / no-supplied-check and keeps its recovery data for the caller's own confirmation.
test('a removal under an older run-result identity keeps its documented verification and recovery data', async () => {
  assertVendoredRelease();
  const s = sandbox('aih-real-verified-old-'); live.push(s);
  const { selections } = await installReal(s);
  const prepared = await prepare({ useCase: 'policy', policy: { schema: 'urn:aihq:core:execution-policy:1.1.0', mode: 'vibe', selections: [],
    removals: selections.map(selection => ({ managementId: selection.managementId, scope: 'project' })) }, target: { project: s.project } }, controls());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const run = await apply(prepared.prepared, approve(prepared.review), controls());
  assert.equal(run.schema, 'urn:aihq:core:run-result:1.1.0');
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.equal(run.members, undefined);
  assert.deepEqual([...new Set(run.operations.map(operation => JSON.stringify(operation.verification)))],
    [JSON.stringify({ status: 'unverified', reason: 'no-supplied-check' })]);
  assert.ok(run.recovery, 'the result names its recovery data');
  const folder = join(s.home, '.aih', 'core', 'recovery', run.runId);
  assert.ok(existsSync(folder) && readdirSync(folder).includes('manifest.json'), 'the recovery data stays');
});
