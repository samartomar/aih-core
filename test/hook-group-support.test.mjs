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
