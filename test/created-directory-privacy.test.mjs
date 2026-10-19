import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { prepare, apply } from '../dist/core/index.js';
import { policy } from './fixture.mjs';
import { sandbox, authorize } from './hook-group-fixture.mjs';

test('conditional cleanup redacts a sensitive directory input in an authored removal review', async () => {
  const s = sandbox('aih-directory-privacy-');
  try {
    const secret = 'private-directory-input';
    const controls = { logging: 'off', privateInputs: { guidance: { folder: secret } } };
    const document = policy();
    const recipe = document.selections[0].recipe.inline;
    recipe.inputs.folder = { type: 'string', required: true, sensitive: true, maxLength: 100 };
    const op = recipe.operations[0];
    op.target.segments = [{ input: 'folder' }, { literal: 'TEAM.md' }];
    const setup = await prepare({ useCase: 'policy', policy: document, target: { project: s.project } }, controls);
    assert.equal(setup.status, 'ready', JSON.stringify(setup));
    assert.equal((await apply(setup.prepared, authorize(setup), { logging: 'off' })).completion, 'complete');
    op.kind = 'file.remove'; delete op.content;
    const removal = await prepare({ useCase: 'policy', policy: document, target: { project: s.project } }, controls);
    assert.equal(removal.status, 'ready', JSON.stringify(removal));
    assert.equal(JSON.stringify(removal.review).includes(secret), false);
    assert.deepEqual(removal.review.operations[0].details.declaredEffects,
      ['Remove setup-created directory if empty: [REDACTED]']);
    assert.equal((await apply(removal.prepared, authorize(removal), { logging: 'off' })).completion, 'complete');
    assert.equal(existsSync(join(s.project, secret)), false);
  } finally { s.dispose(); }
});
