import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../dist/harness/schemas/repair/1.2.0.json' with { type: 'json' };
import { macosRepairIndex, validateRepairDefinition12 } from '../../dist/harness/macos-session-definitions.mjs';

test('published repair12 schema compiles strictly and agrees with bundled definitions', () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  for (const definition of macosRepairIndex) {
    assert.equal(validate(definition), true, JSON.stringify(validate.errors));
    assert.equal(validateRepairDefinition12(definition).valid, true);
  }
  const otherPlatform = structuredClone(macosRepairIndex[0]);
  otherPlatform.variants.find(row => row.os !== 'darwin').sessionProfileIds = ['invented-profile'];
  assert.equal(validate(otherPlatform), false);
  assert.equal(validateRepairDefinition12(otherPlatform).valid, false);
});
