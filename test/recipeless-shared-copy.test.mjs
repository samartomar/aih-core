// A supporting document required by several items without a folder of their own has one copy in the neutral notices
// folder. Core plans that copy once when it combines the document's renderings; a requirer with its own folder still
// gets its copy beside it. Real Catalog 1.7.0 ECC release document, no packed Catalog needed.
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

test('the neutral notices copy is planned once for every requirer without a folder, beside a skill once more', () => {
  const notices = item('ecc.notices');
  const requirers = ecc.items.filter(entry => ['agent', 'command'].includes(entry.kind)).slice(0, 3);
  const skill = ecc.items.find(entry => entry.kind === 'skill');
  assert.equal(requirers.length, 3);
  const rendered = renderSelectionRecipe({ tool: 'claude', binding, item: notices, scope: 'project', requiredBy: [...requirers, skill] });
  assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
  const targets = rendered.recipe.operations.map(operation => JSON.stringify(operation.target));
  assert.equal(new Set(targets).size, targets.length, 'no target is written twice');
  const files = notices.materials.length;
  const neutral = rendered.recipe.operations.filter(operation => operation.id.endsWith('-1'));
  const beside = rendered.recipe.operations.filter(operation => operation.id.endsWith('-4'));
  assert.ok(neutral.length > 0 && neutral.length <= files);
  assert.equal(beside.length, neutral.length, 'the skill keeps its own copy, with its own position');
  assert.equal(rendered.recipe.operations.length, neutral.length * 2, 'the second and third neutral renderings add nothing');
  assert.equal(rendered.recipe.checks.length, rendered.recipe.operations.flatMap(operation => operation.checks ?? []).length);
  // One requirer alone is rendered exactly as before.
  const single = renderSelectionRecipe({ tool: 'claude', binding, item: notices, scope: 'project', requiredBy: [requirers[0]] });
  assert.deepEqual(single.recipe.operations.map(operation => operation.id), neutral.map(operation => operation.id.replace(/-1$/, '')));
});
