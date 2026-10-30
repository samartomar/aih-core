// On Windows each state protection check runs PowerShell to read the real ACL, which costs a fraction of a second.
// Apply checks the protected state once per state path it newly meets, not once per effect: an Apply that writes many
// files starts the same small number of checks as one that writes a few.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, prepare } from '../dist/core/index.js';
import { stateProtectionCounts } from '../dist/core/internal/state.js';
import { sandbox } from './hook-group-fixture.mjs';

const fileSelection = (id, file, text) => ({ id, managementId: id, scope: 'project', configuration: {}, requires: [],
  recipe: { inline: { schema: 'urn:aihq:core:recipe:1.3.0', id, description: id, inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [],
    operations: [{ id: 'write', purpose: 'Write', kind: 'file.write', scope: 'project', target: { root: 'project', segments: [{ literal: file }] },
      content: { literal: text }, requires: [], checks: [] }] } } });
const policy = (count, version) => ({ schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe',
  selections: Array.from({ length: count }, (_, index) => fileSelection(`file-${index}`, `file-${index}.md`, `${index} v${version}\n`)) });

/** The ACL checks an Apply of `count` single-file selections starts, and those of a second Apply that replaces them all. */
async function aclChecksForApply(count) {
  const s = sandbox('aih-state-scale-');
  try {
    const checks = [];
    for (const version of [1, 2]) {
      const prepared = await prepare({ useCase: 'policy', policy: policy(count, version), target: { project: s.project } }, { logging: 'off' });
      assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
      if (version === 2) assert.ok(prepared.review.operations.every(op => op.effects === 'replace-file'), JSON.stringify(prepared.review.operations.map(op => op.effects)));
      const before = stateProtectionCounts.aclChecks;
      const run = await apply(prepared.prepared, { reviewDigest: prepared.review.reviewDigest, approved: true, origin: 'automation' }, { logging: 'off' });
      assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
      checks.push(stateProtectionCounts.aclChecks - before);
    }
    return { install: checks[0], replace: checks[1] };
  } finally { s.dispose(); }
}

test('Apply starts a bounded number of Windows ACL checks, however many files it writes or replaces', { skip: process.platform !== 'win32' }, async () => {
  const few = await aclChecksForApply(2), many = await aclChecksForApply(40);
  console.log(`ACL checks per Apply: ${JSON.stringify(few)} for 2 files, ${JSON.stringify(many)} for 40 files`);
  assert.deepEqual(many, few, 'the checks do not grow with the number of effects');
  assert.ok(many.install <= 4 && many.replace <= 4, `an Apply starts at most 4 ACL checks (${JSON.stringify(many)})`);
});
