import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { contractSupport, nativeClientIds, repairIndex, targets } from '@aihq/core/harness';
import { diagnose } from '@aihq/core/harness/runtime';
import { contractSupport as coreSupport, validateOrganizationTarget } from '@aihq/core/contracts';
import organizationTargetSchema from '@aihq/core/schemas/organization-target/1.0.0.json' with { type: 'json' };

test('Harness declares exact supported formats and the installed public runtime entries', () => {
  assert.equal(contractSupport.schema, 'urn:aihq:package-support:1.1.0');
  assert.deepEqual(contractSupport.contracts.map(({id,role,schemaExport})=>({id,role,schemaExport})), [
    { id: 'urn:aihq:harness:diagnostic:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/diagnostic/1.0.0.json' },
    { id: 'urn:aihq:harness:repair:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/repair/1.0.0.json' },
    { id: 'urn:aihq:harness:repair:1.1.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/repair/1.1.0.json' },
    { id: 'urn:aihq:harness:repair:1.2.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/repair/1.2.0.json' },
    { id: 'urn:aihq:harness:macos-session-profiles:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/macos-session-profiles/1.0.0.json' },
    { id: 'urn:aihq:harness:trust-capabilities:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/trust-capabilities/1.0.0.json' },
    { id: 'urn:aihq:harness:tool-registry:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/harness/schemas/tool-registry/1.0.0.json' },
    { id: 'urn:aihq:report:snapshot:1.0.0', role: 'both',
      schemaExport: '@aihq/core/report/schema' },
    { id: 'urn:aihq:report:claims:1.0.0', role: 'accepts',
      schemaExport: '@aihq/core/report/schemas/claims/1.0.0.json' },
    { id: 'urn:aihq:report:claims:1.1.0', role: 'accepts',
      schemaExport: '@aihq/core/report/schemas/claims/1.1.0.json' },
    { id: 'urn:aihq:core:recipe:1.0.0', role: 'produces',
      schemaExport: '@aihq/core/schemas/recipe/1.0.0.json' },
    { id: 'urn:aihq:harness:native-verification-definition:1.0.0', role: 'both',
      schemaExport: '@aihq/core/harness/schemas/native-verification-definition/1.0.0.json' },
    { id: 'urn:aihq:harness:native-verification-definition:1.1.0', role: 'both',
      schemaExport: '@aihq/core/harness/schemas/native-verification-definition/1.1.0.json' },
    { id: 'urn:aihq:harness:native-test-identity:1.0.0', role: 'accepts',
      schemaExport: '@aihq/core/harness/schemas/native-test-identity/1.0.0.json' }
  ]);
  assert.deepEqual(contractSupport.entries, [
    { export: '@aihq/core/harness', runtime: 'portable' },
    { export: '@aihq/core/report', runtime: 'portable' },
    { export: '@aihq/core/harness/runtime', runtime: 'node', nodeRange: '>=24.15.0 <25' }
  ]);
});

test('the common package-support schema validates both modules and all advertised schema exports resolve', async () => {
  const schema = (await import('@aihq/core/schemas/package-support/1.1.0.json', { with: { type: 'json' } })).default;
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, 'urn:aihq:package-support:1.1.0');
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

test('each target declares the executables it covers, starting with its detection binaries', () => {
  const owners = new Map();
  for (const target of targets) {
    assert.ok(Object.isFrozen(target.executables), target.id);
    assert.deepEqual(target.executables.slice(0, target.binaries.length), [...target.binaries], target.id);
    for (const name of target.executables) {
      assert.match(name, /^[a-z][a-z0-9-]*$/, target.id);
      assert.equal(owners.get(name), undefined, `${name} is covered by ${owners.get(name)} and ${target.id}`);
      owners.set(name, target.id);
    }
  }
  // npx ships with npm and reads npm's configuration; it is not an npm detection signal.
  const executables = id => targets.find(target => target.id === id).executables;
  assert.deepEqual(executables('npm'), ['npm', 'npx']);
  assert.deepEqual(targets.find(target => target.id === 'npm').binaries, ['npm']);
  assert.deepEqual(executables('node'), ['node']);
  assert.deepEqual(executables('python'), ['python3', 'python']);
  assert.deepEqual(executables('pip'), ['pip', 'pip3']);
  assert.deepEqual(executables('git'), ['git']);
  assert.equal(owners.get('npx'), 'npm');
  assert.equal(owners.get('fdfind'), 'fd');
  for (const repair of repairIndex) for (const id of repair.targets)
    if (targets.some(target => target.id === id)) assert.ok(executables(id).length > 0, id);
});

test('nativeClientIds is the frozen supported AI client list and matches organization-target clients', () => {
  assert.ok(Object.isFrozen(nativeClientIds));
  assert.ok(nativeClientIds.length > 0);
  assert.equal(new Set(nativeClientIds).size, nativeClientIds.length);
  const target = client => ({ schema: 'urn:aihq:core:organization-target:1.0.0', client });
  for (const id of nativeClientIds) {
    assert.match(id, /^[a-z][a-z0-9-]{0,63}$/);
    assert.equal(validateOrganizationTarget(target(id)).valid, true, id);
  }
  assert.equal(validateOrganizationTarget(target('unknown')).valid, false);
  assert.deepEqual([...nativeClientIds], organizationTargetSchema.properties.client.enum);
});
