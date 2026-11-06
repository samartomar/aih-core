import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as harness from '@aihq/core/harness';
import { diagnose } from '@aihq/core/harness/runtime';
import { schemas, validateFormat } from '@aihq/core/contracts';
import diagnosticSchema from '../dist/harness/schemas/diagnostic/1.0.0.json' with { type: 'json' };

const { repairIndex, targets } = harness;

test('the portable Harness entry publishes its data in the 0.1.0 formats, and nothing retired', () => {
  for (const value of [...repairIndex, harness.trustCapabilities, harness.toolRegistry, harness.signerRecords, harness.macosSessionProfiles])
    assert.equal(validateFormat(value).status, 'ok', value.schema);
  assert.deepEqual(repairIndex.map(item => item.id), ['node-npm-ca', 'node-os-trust', 'user-tools-ca', 'jvm-ca']);
  assert.equal(harness.trustCapabilities.schema, 'urn:aihq:core:trust-capabilities:0.1.0');
  for (const retired of ['contractSupport', 'nativeClientIds', 'nativeVerificationDefinitions', 'toolBindings', 'renderDelivery', 'checkCompatibility',
    'verificationKeys', 'verificationPublishers', 'helperMetadata', 'macosRepairIndex', 'trustRepairIndex', 'selectTrustCell', 'selectRepairDefinition'])
    assert.equal(Object.hasOwn(harness, retired), false, retired);
  assert.ok(Object.isFrozen(repairIndex) && repairIndex.every(Object.isFrozen));
});

test('callers can select the diagnostic schema for unchanged runtime results and reject invalid check outcomes', async () => {
  // The diagnostic result has no published format (contract 4); its shape schema stays internal to the package.
  const schema = diagnosticSchema;
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
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

test('the published repair format validates shipped definitions and refuses malformed execution metadata', async () => {
  const schema = schemas['urn:aihq:core:repair:0.1.0'].schema;
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.ok(repairIndex.every(definition => definition.schema === schema.$id && definition.managementId === definition.id));
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  for (const definition of repairIndex) assert.equal(validate(definition), true, JSON.stringify(validate.errors));
  for (const mutate of [
    definition => { definition.schema = 'urn:aihq:core:repair:2.0.0'; },
    definition => { definition.inputs.caFile.required = 'yes'; },
    definition => { definition.variants[0].network = 'anywhere'; },
    definition => { definition.variants[0].callback = 'execute'; },
    definition => { definition.scope = 'system'; },
    definition => { delete definition.variants[0].recipeRef; }
  ]) {
    const invalid = JSON.parse(JSON.stringify(repairIndex[0])); mutate(invalid);
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
