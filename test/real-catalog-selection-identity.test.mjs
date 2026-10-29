// Core records the descriptive metadata a caller supplies on each execution-policy selection. This is the caller
// contract the Workbench must meet: item, tool, name, kind and origins all together, as execution-policy 1.4/1.5
// declares; Core derives framework from item.framework. No Core change is needed here.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { listManagedSelections } from '../dist/core/index.js';
import { sandbox } from './hook-group-fixture.mjs';
import { assertVendoredRelease, installReal } from './real-catalog-fixture.mjs';

let live = [];
afterEach(() => { for (const s of live) s.dispose(); live = []; });

test('apply records the real item, tool, name, kind and origins the caller passes', async () => {
  assertVendoredRelease();
  const s = sandbox('aih-real-identity-'); live.push(s);
  const { selections } = await installReal(s);
  const inventory = await listManagedSelections({ target: { project: s.project }, scope: 'project',
    format: 'urn:aihq:core:managed-inventory-result:1.1.0' });
  assert.equal(inventory.selections.length, selections.length);
  const rows = new Map(inventory.selections.map(row => [row.managementId, row]));
  for (const selection of selections) {
    const row = rows.get(selection.managementId);
    assert.ok(row, selection.managementId);
    assert.deepEqual({ name: row.name, kind: row.kind, framework: row.framework, item: row.item, tool: row.tool, origins: row.origins },
      { name: selection.name, kind: selection.kind, framework: selection.item.framework, item: selection.item, tool: selection.tool,
        origins: selection.origins }, selection.managementId);
    assert.equal(row.origins.length, 1, 'one inclusion origin is recorded, not an empty list');
  }
});
