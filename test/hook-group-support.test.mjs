import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGuidance, renderSupportMarkdown } from '../dist/core/support.js';
import { apply } from '../dist/core/index.js';
import { SETTINGS, authorize, groupOf, hookOp, hookSelection, policy11, sandbox } from './hook-group-fixture.mjs';
import { compact, controls, guard, neighbor, only, prep, run } from './hook-group-harness.mjs';

const options = { platform: 'linux' };

test('support reads a 1.1 hook-group review and gives safe recovery guidance without observed bytes', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    await run(s, guard());
    s.write(SETTINGS, s.read(SETTINGS).replace('"matcher":"Bash"', '"matcher":"Local-secret-matcher-77"'));
    const blocked = await prep(s, guard());
    assert.equal(only(blocked).kind, 'hook.group');
    const guidance = getGuidance({ kind: 'prepare', result: blocked }, options);
    assert.equal(guidance.status, 'complete', JSON.stringify(guidance.diagnostics));
    const hook = guidance.items.filter(item => item.id === 'hook-group-conflict');
    assert.equal(hook.length, 1);
    assert.deepEqual([hook[0].reason, hook[0].audience, hook[0].evidenceIds], ['owned-hook-edited', 'developer', ['/review/operations/0']]);
    assert.match(hook[0].steps.join(' '), /reviewed replace/);
    assert.equal(guidance.items.some(item => item.id === 'diagnostic-review'), false, 'no generic duplicate for the same conflict');
    const markdown = renderSupportMarkdown({ kind: 'prepare', result: blocked }, options);
    assert.equal(markdown.status, 'rendered');
    assert.match(markdown.markdown, /hook group/i);
    for (const text of [JSON.stringify(guidance), markdown.markdown]) assert.equal(text.includes('Local-secret-matcher'), false);
  } finally { s.dispose(); }
});

test('support accepts 1.1 run results, including cleanup-only runs, and still reports unknown identities as unsupported', async () => {
  const s = sandbox();
  try {
    const ran = await run(s, guard());
    assert.equal(getGuidance({ kind: 'run', result: ran.result }, options).status, 'complete');
    assert.equal(renderSupportMarkdown({ kind: 'run', result: ran.result }, options).status, 'rendered');
    const cleanup = { schema: 'urn:aihq:core:execution-policy:1.1.0', mode: 'vibe', selections: [], removals: [{ managementId: 'guard-a', scope: 'project' }] };
    const prepared = await prep(s, cleanup);
    const result = await apply(prepared.prepared, authorize(prepared), controls);
    assert.equal(result.schema, 'urn:aihq:core:run-result:1.1.0');
    assert.equal(getGuidance({ kind: 'run', result }, options).status, 'complete');
    assert.equal(getGuidance({ kind: 'prepare', result: prepared }, options).status, 'complete');
    for (const [kind, mutate] of [['run', value => { value.schema = 'urn:aihq:core:run-result:1.2.0'; return value; }],
      ['prepare', value => { value.review = { ...value.review, schema: 'urn:aihq:core:prepared-work:1.2.0' }; return value; }]]) {
      const input = { kind, result: mutate(structuredClone(kind === 'run' ? result : { ...prepared, prepared: undefined })) };
      const unsupported = getGuidance(input, options);
      assert.equal(unsupported.status, 'invalid');
      assert.equal(unsupported.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
    }
  } finally { s.dispose(); }
});

test('support keeps generic guidance for a non-hook conflict that shares a reason with a hook conflict', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a'), groupOf('guard-a', { matcher: 'Other' })]));
    s.write('TEAM.md', 'user-authored\n');
    const teamOnly = hookSelection('team', [{ id: 'write', purpose: 'Write team guidance', kind: 'file.write', scope: 'project', requires: [], checks: [],
      target: { root: 'project', segments: [{ literal: 'TEAM.md' }] }, content: { literal: 'managed\n' } }]);
    const hookOnly = guard();
    const generic = getGuidance({ kind: 'prepare', result: await prep(s, policy11([teamOnly])) }, options);
    const control = generic.items.filter(item => item.id === 'diagnostic-review').length;
    assert.ok(control > 0, 'the control: a lone file conflict gets generic guidance');
    const both = await prep(s, policy11([...hookOnly.selections, teamOnly]));
    assert.deepEqual(both.review.conflicts.map(item => item.reason).sort(), ['existing-content', 'existing-content']);
    const guidance = getGuidance({ kind: 'prepare', result: both }, options);
    assert.equal(guidance.items.filter(item => item.id === 'hook-group-conflict').length, 1);
    const kept = guidance.items.filter(item => item.id === 'diagnostic-review');
    assert.equal(kept.length, control, 'the TEAM.md conflict keeps exactly the generic guidance it has alone');
  } finally { s.dispose(); }
});

test('guidance for a structurally unreadable target names the real problem, never the comment-adjacency text', async () => {
  const s = sandbox();
  try {
    const cases = [
      ['duplicate-json-key', '{"hooks":{"PreToolUse":[]},"hooks":{"PreToolUse":[]}}', /key/i],
      ['unsupported-json-syntax', '{"hooks":{"PreToolUse":[}}', /syntax/i],
      ['hook-edit-unsafe', '{"hooks":{"PreToolUse":{}}}', /array/i]
    ];
    for (const [reason, text, expected] of cases) {
      s.write(SETTINGS, text);
      const blocked = await prep(s, guard());
      assert.equal(blocked.review.conflicts[0].reason, reason);
      assert.match(blocked.review.conflicts[0].message, /guard-a/, 'the group is attributed');
      const steps = getGuidance({ kind: 'prepare', result: blocked }, options).items.find(item => item.id === 'hook-group-conflict').steps.join(' ');
      assert.match(steps, expected, reason);
      assert.equal(/adjacent/i.test(steps), reason === 'hook-edit-unsafe', reason);
      assert.equal(blocked.review.conflicts[0].guidance.includes('adjacent'), reason === 'hook-edit-unsafe', reason);
    }
  } finally { s.dispose(); }
});
