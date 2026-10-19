import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { prepare, apply, prepareManagedRemoval } from '../dist/core/index.js';
import { policy } from './fixture.mjs';
import { sandbox, authorize } from './hook-group-fixture.mjs';

for (const name of ['__proto__', 'constructor']) test(`created ${name} directories keep their cleanup evidence`, async () => {
  const s = sandbox('aih-directory-name-');
  try {
    const document = policy();
    document.selections[0].recipe.inline.operations[0].target.segments =
      [name, 'nested', 'TEAM.md'].map(literal => ({ literal }));
    const setup = await prepare({ useCase: 'policy', policy: document, target: { project: s.project } }, { logging: 'off' });
    assert.equal(setup.status, 'ready', JSON.stringify(setup));
    assert.equal((await apply(setup.prepared, authorize(setup), { logging: 'off' })).completion, 'complete');
    const removal = await prepareManagedRemoval({ target: { project: s.project }, managementId: 'team-guidance',
      scope: 'project', mode: 'vibe' }, { logging: 'off' });
    assert.equal(removal.disposition, 'prepared', JSON.stringify(removal));
    const prepared = removal.preparation;
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    assert.equal((await apply(prepared.prepared, authorize(prepared), { logging: 'off' })).completion, 'complete');
    assert.equal(existsSync(join(s.project, name)), false);
  } finally { s.dispose(); }
});
