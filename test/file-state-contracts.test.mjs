import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as contracts from '@aihq/core/contracts';
import accepted from '@aihq/core/fixtures/core/file-state-result/1.1.0/accept.json' with { type: 'json' };
import refused from '@aihq/core/fixtures/core/file-state-result/1.1.0/refuse.json' with { type: 'json' };

const schema = 'urn:aihq:core:file-state-result:1.1.0';

test('public file-state reader accepts stored 1.1 results and refuses the malformed fixture', () => {
  const before = structuredClone(accepted);
  assert.deepEqual(contracts.validateFileStateResult(accepted), { valid: true, schema, diagnostics: [] });
  assert.deepEqual(accepted, before);
  const invalid = contracts.validateFileStateResult(refused);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.diagnostics[0].code, 'INPUT_INVALID');
});

test('public file-state reader preserves exact schema refusal details', () => {
  for (const unsupported of ['urn:aihq:core:file-state-result:1.0.0', 'urn:aihq:core:file-state-result:2.0.0']) {
    const result = contracts.validateFileStateResult({ ...accepted, schema: unsupported });
    assert.equal(result.valid, false);
    assert.deepEqual(result.diagnostics, [{ code: 'SCHEMA_UNSUPPORTED', reason: 'schema-unsupported',
      message: 'This format is not supported.', path: '/schema', encountered: unsupported, supported: [schema] }]);
  }
});

test('public file-state reader reports unknown field pointers and requires selectionIds', () => {
  for (const [value, path] of [
    [{ ...accepted, 'extra/~': true }, '/extra~1~0'],
    [{ ...accepted, targets: [{ ...accepted.targets[0], 'extra/~': true }] }, '/targets/0/extra~1~0']
  ]) {
    const result = contracts.validateFileStateResult(value);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(d => d.code === 'INPUT_INVALID' && d.reason === 'unknown-field' && d.path === path));
  }
  const missing = structuredClone(accepted);
  delete missing.targets[0].selectionIds;
  assert.equal(contracts.validateFileStateResult(missing).valid, false);
});

test('public file-state reader rejects non-JSON data without invoking accessors', () => {
  let calls = 0;
  const accessor = { ...accepted, get status() { calls++; return 'complete'; } };
  const cyclic = { ...accepted }; cyclic.loop = cyclic;
  for (const value of [null, [], {}, accessor, cyclic, { ...accepted, limits: { ...accepted.limits, elapsedMs: NaN } }])
    assert.equal(contracts.validateFileStateResult(value).valid, false);
  assert.equal(calls, 0);
});

test('public file-state reader retains incomplete and invalid observation documents', () => {
  for (const name of ['complete', 'partial', 'invalid', 'unsupported']) {
    const value = JSON.parse(readFileSync(new URL(`./fixtures/file-state/${name}.json`, import.meta.url), 'utf8'));
    const result = contracts.validateFileStateResult(value);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  }
  const cancelled = { ...accepted, status: 'cancelled' };
  assert.equal(contracts.validateFileStateResult(cancelled).valid, true);
});
