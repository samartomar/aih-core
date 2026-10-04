import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { contractSupport, repairIndex } from '@aihq/core/harness';
import { diagnose } from '@aihq/core/harness/runtime';
import { contractSupport as coreSupport } from '@aihq/core/contracts';

test('Harness declares exact supported formats and the installed public runtime entries', () => {
  assert.equal(contractSupport.schema, 'urn:aihq:package-support:1.0.0');
  assert.deepEqual(contractSupport.contracts, [
    { id: 'urn:aihq:harness:diagnostic:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/diagnostic/1.0.0.json' },
    { id: 'urn:aihq:harness:repair:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/repair/1.0.0.json' },
    { id: 'urn:aihq:harness:repair:1.1.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/repair/1.1.0.json' },
    { id: 'urn:aihq:harness:trust-capabilities:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/trust-capabilities/1.0.0.json' },
    { id: 'urn:aihq:report:snapshot:1.0.0', role: 'both',
      schemaExport: '@aihq/core/report/schema' },
    { id: 'urn:aihq:core:recipe:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/schemas/recipe/1.0.0.json' }
  ]);
  assert.deepEqual(contractSupport.entries, [
    { export: '@aihq/core/harness', runtime: 'portable' },
    { export: '@aihq/core/report', runtime: 'portable' },
    { export: '@aihq/core/report/render', runtime: 'portable' },
    { export: '@aihq/core/harness/runtime', runtime: 'node', nodeRange: '>=24.15.0 <25' }
  ]);
});

test('the common package-support schema validates both modules and all advertised schema exports resolve', async () => {
  const schema = (await import('@aihq/core/schemas/package-support/1.0.0.json', { with: { type: 'json' } })).default;
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, 'urn:aihq:package-support:1.0.0');
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  for (const declaration of [contractSupport, coreSupport]) {
    assert.equal(validate(declaration), true, JSON.stringify(validate.errors));
    for (const entry of declaration.contracts) {
      const resource = (await import(entry.schemaExport, { with: { type: 'json' } })).default;
      assert.equal(resource.$id, entry.id);
      assert.equal(resource.$schema, 'https://json-schema.org/draft/2020-12/schema');
    }
  }
  assert.deepEqual(contractSupport.package, coreSupport.package);
  for (const mutate of [
    declaration => { declaration.schema = 'urn:aihq:harness:support:1.0.0'; },
    declaration => { declaration.contracts[0] = 'urn:aihq:harness:diagnostic:1.0.0'; },
    declaration => { declaration.contracts[0].role = 'executes'; },
    declaration => { delete declaration.contracts[0].schemaExport; },
    declaration => { delete declaration.entries.find(entry => entry.export === '@aihq/core/harness/runtime').nodeRange; },
    declaration => { declaration.entries[0].runtime = 'automatic'; }
  ]) {
    const invalid = structuredClone(contractSupport); mutate(invalid);
    assert.equal(validate(invalid), false);
  }
});

test('callers can select the diagnostic schema for unchanged runtime results and reject invalid check outcomes', async () => {
  const entry = contractSupport.contracts.find(contract => contract.id === 'urn:aihq:harness:diagnostic:1.0.0');
  const schema = (await import(entry.schemaExport, { with: { type: 'json' } })).default;
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, entry.id);
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  const invalid = await diagnose({ requestId: 'bad', targets: ['unknown-target'] });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.diagnostics[0].code, 'INPUT_INVALID');
  const cancelled = await diagnose({ requestId: 'cancelled', targets: ['npm'] }, { signal: AbortSignal.abort() });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.checks[0].outcome, 'skipped');
  for (const result of [invalid, cancelled]) {
    assert.equal(Object.hasOwn(result, 'schema'), false);
    assert.equal(validate(result), true, JSON.stringify(validate.errors));
  }
  for (const mutate of [
    result => { result.checks[0].outcome = 'success'; },
    result => { result.checks[0].execute = 'callback'; },
    result => { result.limits.elapsedMs = -1; },
    result => { delete result.helper.version; },
    result => { result.schema = 'urn:aihq:harness:diagnostic:2.0.0'; }
  ]) {
    const malformed = structuredClone(cancelled); mutate(malformed);
    assert.equal(validate(malformed), false);
  }
});

test('the exported repair schema validates shipped definitions and refuses malformed execution metadata', async () => {
  const entry = contractSupport.contracts.find(contract => contract.id === 'urn:aihq:harness:repair:1.0.0');
  const schema = (await import(entry.schemaExport, { with: { type: 'json' } })).default;
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, entry.id);
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  for (const definition of repairIndex) assert.equal(validate(definition), true, JSON.stringify(validate.errors));
  for (const mutate of [
    definition => { definition.schema = 'urn:aihq:harness:repair:2.0.0'; },
    definition => { definition.inputs.caFile.required = 'yes'; },
    definition => { definition.variants[0].network = 'anywhere'; },
    definition => { definition.variants[0].callback = 'execute'; },
    definition => { definition.scope = 'system'; },
    definition => { delete definition.variants[0].recipeRef; }
  ]) {
    const invalid = structuredClone(repairIndex[0]); mutate(invalid);
    assert.equal(validate(invalid), false);
    assert.ok(validate.errors.length > 0);
  }
});
