// A notices document required by several items has one copy in the neutral notices folder, whichever items require
// it, skills with a folder of their own included. Core plans that copy once when it combines the document's renderings,
// and the combined recipe is the one a single requirer renders. Real Catalog 1.7.0 ECC release document, no packed
// Catalog needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSelectionRecipe } from '../dist/core/internal/recipeless.js';
import { toolBindings } from '../dist/harness/contracts.mjs';
import { catalogRoot } from './real-catalog-fixture.mjs';

const ecc = JSON.parse(readFileSync(join(catalogRoot, 'release-ecc.content.json'), 'utf8'));
const item = id => ecc.items.find(entry => entry.id === id);
const binding = toolBindings.find(entry => entry.tool === 'claude');

test('the neutral notices copy is planned once for every requirer, a skill included', () => {
  const notices = item('ecc.notices');
  const requirers = ecc.items.filter(entry => ['agent', 'command'].includes(entry.kind)).slice(0, 3);
  const skill = ecc.items.find(entry => entry.kind === 'skill');
  assert.equal(requirers.length, 3);
  const rendered = renderSelectionRecipe({ tool: 'claude', binding, item: notices, scope: 'project', requiredBy: [...requirers, skill] });
  assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
  const targets = rendered.recipe.operations.map(operation => operation.target.segments.map(segment => segment.literal).join('/'));
  assert.equal(new Set(targets).size, targets.length, 'no target is written twice');
  assert.ok(targets.length > 0 && targets.every(path => path.startsWith('.aih/notices/ecc/ecc.notices/')), targets.join(' '));
  assert.equal(rendered.recipe.checks.length, rendered.recipe.operations.flatMap(operation => operation.checks ?? []).length);
  // One requirer alone renders the same recipe.
  const single = renderSelectionRecipe({ tool: 'claude', binding, item: notices, scope: 'project', requiredBy: [requirers[0]] });
  assert.deepEqual(single.recipe, rendered.recipe);
});
