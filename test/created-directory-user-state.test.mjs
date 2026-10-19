import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { prepare, apply, prepareManagedRemoval } from '../dist/core/index.js';
import { policy } from './fixture.mjs';
import { sandbox, authorize } from './hook-group-fixture.mjs';

test('userState removes created descendants while preserving its Core-assigned content root', async () => {
  const s = sandbox('aih-directory-user-state-');
  try {
    const document = policy();
    const selection = document.selections[0]; selection.scope = 'user';
    selection.recipe.inline.targets = ['user'];
    const op = selection.recipe.inline.operations[0]; op.scope = 'user';
    op.target = { root: 'userState', segments: ['nested', 'TEAM.md'].map(literal => ({ literal })) };
    const setup = await prepare({ useCase: 'policy', policy: document, target: { project: s.project } }, { logging: 'off' });
    assert.equal(setup.status, 'ready', JSON.stringify(setup));
    const target = setup.review.operations[0].details.target;
    const contentRoot = dirname(dirname(target));
    assert.equal((await apply(setup.prepared, authorize(setup), { logging: 'off' })).completion, 'complete');
    const removal = await prepareManagedRemoval({ target: { project: s.project }, managementId: 'team-guidance',
      scope: 'user', mode: 'vibe' }, { logging: 'off' });
    assert.equal(removal.disposition, 'prepared', JSON.stringify(removal));
    const prepared = removal.preparation;
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    assert.equal((await apply(prepared.prepared, authorize(prepared), { logging: 'off' })).completion, 'complete');
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(dirname(target)), false);
    assert.equal(existsSync(contentRoot), true);
  } finally { s.dispose(); }
});
