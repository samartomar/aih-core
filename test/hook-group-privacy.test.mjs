import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { prepare } from '../dist/core/index.js';
import { SETTINGS, request, sandbox } from './hook-group-fixture.mjs';
import { compact, groupsOf, guard, neighbor, prep, run } from './hook-group-harness.mjs';
import { getGuidance, renderSupportMarkdown } from '../dist/core/support.js';

const filesUnder = root => readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesUnder(join(root, entry.name)) : [join(root, entry.name)]);

test('an edited group holding a secret or a large local value never reaches the review, history, state or guidance', async () => {
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    await run(s, guard());
    const secret = 'Bearer-ghp_observed-local-secret-5521';
    const large = 'L'.repeat(200_000);
    s.write(SETTINGS, s.read(SETTINGS).replace('"matcher":"Bash"', `"matcher":"${secret}","blob":"${large}"`));
    // Logging stays on so Core's routine history record is written for this Prepare.
    const blocked = await prepare(request(s.project, guard()), { logging: 'on' });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.record.status, 'written');
    assert.equal(blocked.review.conflicts[0].reason, 'owned-hook-edited');
    const op = blocked.review.operations[0];
    assert.match(op.details.hookGroup.memberBeforeSha256, /^[a-f0-9]{64}$/);
    const serialized = [JSON.stringify(blocked), JSON.stringify(getGuidance({ kind: 'prepare', result: blocked }, { platform: 'linux' })),
      renderSupportMarkdown({ kind: 'prepare', result: blocked }, { platform: 'linux' }).markdown];
    for (const text of serialized) { assert.equal(text.includes(secret), false); assert.equal(text.includes('LLLLLLLL'), false); }
    for (const file of filesUnder(join(s.home, '.aih'))) {
      if (statSync(file).size > 5_000_000) continue;
      const bytes = readFileSync(file, 'utf8');
      assert.equal(bytes.includes(secret) || bytes.includes('LLLLLLLL'), false, `${file} must not carry observed group bytes`);
    }
    assert.equal(groupsOf(s).length, 2, 'Prepare changed nothing');
  } finally { s.dispose(); }
});

test('the authored desired group appears in the review but never in the history record', async () => {
  const s = sandbox();
  try {
    const prepared = await prepare(request(s.project, guard()), { logging: 'on' });
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.review.operations[0].details.hookGroup.desiredGroup.hooks[0].command, 'hooks/guard-a.sh');
    const history = filesUnder(join(s.home, '.aih', 'core', 'runs')).map(file => readFileSync(file, 'utf8')).join('\n');
    assert.equal(history.includes('hooks/guard-a.sh'), false);
    assert.ok(history.includes('"hookGroup"'));
  } finally { s.dispose(); }
});
