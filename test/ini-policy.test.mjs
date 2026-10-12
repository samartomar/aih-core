import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepare, apply, prepareManagedRemoval, checkFileState } from '../dist/core/index.js';
import { validatePolicy, validateRecipe, validatePreparedWork14 } from '../dist/core/contracts.js';
import { sandbox, authorize } from './hook-group-fixture.mjs';

const document = (id = 'one', value = '/team.pem', key = 'cert') => ({
  schema: 'urn:aihq:core:execution-policy:1.2.0', mode: 'vibe', selections: [{
    id, managementId: id, scope: 'project', configuration: {}, requires: [], recipe: { inline: {
      schema: 'urn:aihq:core:recipe:1.2.0', id: 'ini-fixture', description: 'Bounded INI option',
      inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [], operations: [{
        id: 'config', purpose: 'Set selected INI option', kind: 'config.entries', format: 'ini', scope: 'project',
        target: { root: 'project', segments: [{ literal: 'settings.ini' }] }, requires: [], checks: [],
        entries: [{ path: ['global', key], action: 'set', value: { literal: value } }],
      }],
    } },
  }],
});
const request = (s, policy) => ({ useCase: 'policy', target: { project: s.project }, policy });
const removal = (s, id) => ({ target: { project: s.project }, managementId: id, scope: 'project', mode: 'vibe' });
async function install(s, policy, resolutions) {
  const p = await prepare({ ...request(s, policy), ...(resolutions ? { resolutions } : {}) }, { logging: 'off' });
  assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
  assert.equal(validatePreparedWork14(p.review).valid, true);
  const r = await apply(p.prepared, authorize(p), { logging: 'off' });
  assert.equal(r.completion, 'complete', JSON.stringify(r.diagnostics));
  assert.equal(r.schema, 'urn:aihq:core:run-result:1.1.0');
  return p;
}

test('INI recipes require new explicit versions; prior schemas keep refusing INI', () => {
  const policy = document(); const recipe = policy.selections[0].recipe.inline;
  assert.equal(validateRecipe(recipe).valid, true);
  assert.equal(validatePolicy(policy).valid, true);
  for (const version of ['1.0.0', '1.1.0']) {
    assert.equal(validateRecipe({ ...recipe, schema: `urn:aihq:core:recipe:${version}` }).valid, false);
    assert.equal(validatePolicy({ ...policy, schema: `urn:aihq:core:execution-policy:${version}` }).valid, false);
  }
});

for (const format of ['yaml', 'properties']) test(`${format} requires the new recipe and policy versions`, () => {
  const policy = document(); const recipe = policy.selections[0].recipe.inline;
  recipe.operations[0].format = format; recipe.operations[0].entries[0].path = ['store'];
  assert.equal(validateRecipe(recipe).valid, true);
  assert.equal(validatePolicy(policy).valid, true);
  for (const version of ['1.0.0', '1.1.0']) {
    assert.equal(validateRecipe({ ...recipe, schema: `urn:aihq:core:recipe:${version}` }).valid, false);
    assert.equal(validatePolicy({ ...policy, schema: `urn:aihq:core:execution-policy:${version}` }).valid, false);
  }
});

test('INI shared claims survive first removal; final removal preserves fresh neighboring edits', async () => {
  const s = sandbox('aih-ini-');
  try {
    const original = '; keep\n[global]\ntimeout=15\n[install]\nupgrade=true\n';
    s.write('settings.ini', original);
    await install(s, document());
    const receipt = join(s.home, '.aih', 'core', 'ownership', createHash('sha256').update(realpathSync.native(s.project)).digest('hex') + '.json');
    assert.equal(JSON.parse(readFileSync(receipt)).schema, 'urn:aihq:core:ownership:1.2.0');
    await install(s, document('two', '/team.pem', 'CERT'), [{ selectionId: 'two', operationId: 'config', choice: 'adopt', observedSha256: createHash('sha256').update(s.read('settings.ini')).digest('hex') }]);
    const changed = await prepare(request(s, document('two', '/different.pem')), { logging: 'off' });
    assert.equal(changed.status, 'blocked');
    assert.equal(changed.resolutionInputs.length, 0);
    const first = await prepareManagedRemoval(removal(s, 'one'), { logging: 'off' });
    assert.equal(first.preparation.status, 'ready');
    assert.equal((await apply(first.preparation.prepared, authorize(first.preparation), { logging: 'off' })).completion, 'complete');
    assert.match(s.read('settings.ini'), /cert=\/team.pem/);
    s.write('settings.ini', s.read('settings.ini').replace('timeout=15', 'timeout=15\nretries=4'));
    const final = await prepareManagedRemoval(removal(s, 'two'), { logging: 'off' });
    assert.equal(final.schema, 'urn:aihq:core:managed-removal-preparation:1.1.0');
    assert.equal(validatePreparedWork14(final.preparation.review).valid, true);
    assert.equal((await apply(final.preparation.prepared, authorize(final.preparation), { logging: 'off' })).completion, 'complete');
    assert.equal(s.read('settings.ini'), original.replace('timeout=15', 'timeout=15\nretries=4'));
    assert.equal(JSON.parse(readFileSync(receipt)).schema, 'urn:aihq:core:ownership:1.0.0');
  } finally { s.dispose(); }
});

test('INI owned drift and stale cleanup refuse effects, and old policies cannot synthesize INI reviews', async () => {
  const s = sandbox('aih-ini-drift-');
  try {
    await install(s, document());
    const oldPolicy = { schema: 'urn:aihq:core:execution-policy:1.1.0', mode: 'vibe', selections: [], removals: [{ managementId: 'one', scope: 'project' }] };
    const old = await prepare(request(s, oldPolicy), { logging: 'off' });
    assert.equal(old.status, 'invalid');
    assert.ok(old.diagnostics.some(d => d.reason === 'bounded-config-policy-version'));
    const p = await prepareManagedRemoval(removal(s, 'one'), { logging: 'off' });
    const changed = s.read('settings.ini').replace('/team.pem', '/other.pem');
    s.write('settings.ini', changed);
    const r = await apply(p.preparation.prepared, authorize(p.preparation), { logging: 'off' });
    assert.equal(r.completion, 'rejected');
    assert.equal(s.read('settings.ini'), changed);
    const fresh = await prepareManagedRemoval(removal(s, 'one'), { logging: 'off' });
    assert.equal(fresh.preparation.status, 'blocked');
    assert.ok(fresh.preparation.review.operations.some(o => o.effects === 'conflict'));
    assert.equal(s.read('settings.ini'), changed);
    const state = await checkFileState({ target: { project: s.project }, policy: document() });
    assert.equal(state.status, 'complete', JSON.stringify(state.diagnostics));
  } finally { s.dispose(); }
});
