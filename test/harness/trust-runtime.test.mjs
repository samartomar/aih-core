import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustRepairIndex, trustCapabilities, validateRepairDefinition11, validateTrustCapabilities, contractSupport } from '../../dist/harness/contracts.mjs';
import { getTrustRecipe, getRepairRecipe } from '../../dist/harness/runtime.mjs';
import { verifyTrustAdmissionEvidence } from '../../dist/harness/trust.mjs';
import { fileURLToPath } from 'node:url';

const bindings = { materialId: 'generated-ca', materialPath: 'trust-material', outputSegments: ['.aih', 'exports', 'os-ca.pem'],
  sha256: 'a'.repeat(64), byteLength: 10 };

test('every 1.1 recipe reference resolves to its fixed implementation; native resolves only to unavailable', () => {
  for (const definition of trustRepairIndex) {
    assert.equal(validateRepairDefinition11(definition, { resolveRecipeRef: ref => getTrustRecipe(ref, bindings) !== undefined }).valid, true);
    for (const variant of definition.variants) {
      const resolved = getTrustRecipe(variant.recipeRef, bindings);
      if (variant.route === 'native') assert.deepEqual(resolved, { status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason: 'native-route-unsupported' });
      else if (variant.route === 'export') assert.equal(resolved.recipe.operations[0].id, 'write-ca');
      else assert.deepEqual(resolved.recipe, getRepairRecipe(variant.recipeRef));
    }
  }
  assert.equal(getTrustRecipe('unknown/ref'), undefined);
  assert.equal(getTrustRecipe('certificate-export/win32/declared', { ...bindings, sha256: 'bad' }).status, 'invalid');
  assert.equal(getTrustRecipe('certificate-export/win32/declared').status, 'invalid');
});

test('shipped format admission has verified records and the support manifest declares the produced Harness contracts', () => {
  assert.equal(validateTrustCapabilities(trustCapabilities, { package: contractSupport.package }).valid, true);
  assert.ok(trustCapabilities.cells.every(cell => cell.route === 'export' && cell.client === null));
  const checked = verifyTrustAdmissionEvidence({ packageRoot: fileURLToPath(new URL('../../', import.meta.url)), capabilities: trustCapabilities });
  assert.equal(checked.valid, true, JSON.stringify(checked.diagnostics));
  const ids = contractSupport.contracts.map(item => item.id);
  assert.ok(ids.includes('urn:aihq:harness:repair:1.1.0') && ids.includes('urn:aihq:harness:trust-capabilities:1.0.0'));
});
