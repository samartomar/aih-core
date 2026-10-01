import test from 'node:test';
import assert from 'node:assert/strict';
import { getItem } from '@aihq/catalog/reader';
import { installedRelease } from './helpers.mjs';
import {
  authorPolicy, catalogItems, exportPolicy, policyOrigins, reopenPolicy, requiredItems
} from '../src/authoring.js';

const hasDefaultedInput = item => Object.values(item.inputs).some(spec => spec.default !== undefined);

async function setup() {
  const { release, source } = await installedRelease();
  const items = catalogItems(release);
  const dependent = items.find(item => hasDefaultedInput(item) && item.dependencies.requires.length > 0);
  const standalone = items.find(item => hasDefaultedInput(item) && item.dependencies.requires.length === 0);
  assert.ok(dependent, 'catalog supplies an item with a defaulted input and required items');
  assert.ok(standalone, 'catalog supplies an item with a defaulted input and no required items');
  return { release, source, dependent, standalone };
}

test('authored policy round-trips through export/reopen preserving explicit values and dependency mapping', async () => {
  const { release, source, dependent } = await setup();
  const [inputName] = Object.entries(dependent.inputs).find(([, spec]) => spec.default !== undefined);
  const closure = requiredItems(release, dependent.id);
  assert.equal(closure.valid, true, JSON.stringify(closure.diagnostics));
  const selections = [
    { id: 'main', managementId: 'main-management', scope: dependent.scopes[0], itemId: dependent.id,
      configuration: { [inputName]: '.custom-agent' } },
    ...closure.itemIds.filter(itemId => itemId !== dependent.id).map(itemId => {
      const found = getItem(release, itemId);
      assert.ok(found.found);
      return { id: `dep-${itemId}`, managementId: `dep-${itemId}-management`, scope: found.item.scopes[0],
        itemId, configuration: {} };
    })
  ];
  const authored = authorPolicy({ release, mode: 'vibe', materialSource: source, selections });
  assert.equal(authored.valid, true, JSON.stringify(authored.diagnostics));

  const reopened = reopenPolicy(exportPolicy(authored.policy));
  assert.equal(reopened.valid, true, JSON.stringify(reopened.diagnostics));
  const main = reopened.document.selections.find(selection => selection.id === 'main');
  assert.equal(main.configuration[inputName], '.custom-agent');
  const expectedRequires = dependent.dependencies.requires.map(ref => `dep-${ref.itemId}`);
  assert.deepEqual([...main.requires].sort(), [...expectedRequires].sort());
});

test('omitted defaulted input stays omitted on reopen and reports default origin', async () => {
  const { release, source, standalone } = await setup();
  const [inputName] = Object.entries(standalone.inputs).find(([, spec]) => spec.default !== undefined);
  const authored = authorPolicy({ release, mode: 'vibe', materialSource: source, selections: [
    { id: 'solo', managementId: 'solo-management', scope: standalone.scopes[0], itemId: standalone.id,
      configuration: {} }
  ] });
  assert.equal(authored.valid, true, JSON.stringify(authored.diagnostics));

  const reopened = reopenPolicy(exportPolicy(authored.policy));
  assert.equal(reopened.valid, true, JSON.stringify(reopened.diagnostics));
  const solo = reopened.document.selections.find(selection => selection.id === 'solo');
  assert.equal(Object.hasOwn(solo.configuration, inputName), false);

  const origins = policyOrigins(release, reopened.document);
  assert.equal(origins.valid, true, JSON.stringify(origins.diagnostics));
  assert.equal(origins.bySelectionId.solo[inputName], 'default');
});

test('explicit input reports explicit origin after reopen', async () => {
  const { release, source, standalone } = await setup();
  const [inputName] = Object.entries(standalone.inputs).find(([, spec]) => spec.default !== undefined);
  const authored = authorPolicy({ release, mode: 'vibe', materialSource: source, selections: [
    { id: 'solo', managementId: 'solo-management', scope: standalone.scopes[0], itemId: standalone.id,
      configuration: { [inputName]: '.other-agent' } }
  ] });
  assert.equal(authored.valid, true, JSON.stringify(authored.diagnostics));

  const reopened = reopenPolicy(exportPolicy(authored.policy));
  assert.equal(reopened.valid, true, JSON.stringify(reopened.diagnostics));
  const origins = policyOrigins(release, reopened.document);
  assert.equal(origins.bySelectionId.solo[inputName], 'explicit');
});

test('authoring without a required item fails with blocking diagnostics instead of silent selection', async () => {
  const { release, source, dependent } = await setup();
  const authored = authorPolicy({ release, mode: 'vibe', materialSource: source, selections: [
    { id: 'main', managementId: 'main-management', scope: dependent.scopes[0], itemId: dependent.id,
      configuration: {} }
  ] });
  assert.equal(authored.valid, false);
  assert.ok(authored.diagnostics.some(diagnostic => diagnostic.blocking));
});

test('reopening an unsupported policy generation reports encountered and supported contract ids', () => {
  const reopened = reopenPolicy(JSON.stringify({
    schema: 'urn:aihq:core:execution-policy:9.9.9', mode: 'vibe', selections: []
  }));
  assert.equal(reopened.valid, false);
  const diagnostic = reopened.diagnostics.find(entry => entry.code === 'SCHEMA_UNSUPPORTED');
  assert.ok(diagnostic, JSON.stringify(reopened.diagnostics));
  assert.equal(diagnostic.encountered, 'urn:aihq:core:execution-policy:9.9.9');
  assert.deepEqual(diagnostic.supported, ['urn:aihq:core:execution-policy:1.0.0']);
});
