import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy, validatePolicy, validateRecipe, contractSupport } from '../dist/contracts.js';
import { policy } from './fixture.mjs';

test('an outside author round-trips the documented Vibe file without inserting defaults', () => {
  const document = policy();
  assert.deepEqual(parsePolicy(JSON.stringify(document)), {
    valid: true, schema: document.schema, document, diagnostics: []
  });
  assert.equal(validatePolicy(document).valid, true);
  assert.equal(validateRecipe(document.selections[0].recipe.inline).valid, true);
  assert.equal(contractSupport.entries.find(e => e.export === '@aihq/core/contracts').runtime, 'portable');
});

test('strict parsing rejects ambiguous bytes and numbers before a host can act', () => {
  const text = JSON.stringify(policy());
  const invalid = [
    text.replace('"mode":"vibe"', '"mode":"vibe","mo\\u0064e":"vibe"'),
    text + '{}', '\ufeff' + text,
    text.replace('65536', '9007199254740992'),
    text.replace('65536', '65536.000000000001'),
    text.replace('65536', '1e-9999'),
    text.replace('65536', '-0'),
    text.replace('guidance-file', 'e\u0301'),
    text.replace('guidance-file', '\\ud800'),
    text.replace('guidance-file', '\ud800'),
    ' '.repeat(1_000_001) + text
  ];
  for (const candidate of invalid) assert.equal(parsePolicy(candidate).valid, false);
  const tooLarge = policy();
  tooLarge.metadata = { text: 'x'.repeat(1_000_001) };
  assert.equal(validatePolicy(tooLarge).valid, false);
  let called = false;
  const accessor = policy();
  Object.defineProperty(accessor, 'hidden', { get() { called = true; return true; } });
  assert.equal(validatePolicy(accessor).valid, false);
  assert.equal(called, false);
  const cyclic = policy(); cyclic.metadata = { cyclic };
  assert.equal(validatePolicy(cyclic).valid, false);
});

test('authors get structured diagnostics for unsupported formats, dependencies and bindings', () => {
  const future = policy(); future.schema = 'urn:aihq:core:execution-policy:2.0.0';
  assert.equal(validatePolicy(future).diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
  for (const mutate of [
    p => { p.approved = true; },
    p => { p.selections[0].requires = ['missing']; },
    p => { p.selections[0].requires = ['guidance']; },
    p => { p.selections.push(structuredClone(p.selections[0])); },
    p => { p.selections[0].configuration.undeclared = true; },
    p => { p.selections[0].configuration.text = false; },
    p => { p.selections[0].recipe.inline.operations[0].content.input = 'missing'; },
    p => { p.selections[0].recipe.inline.operations[0].requires = ['write']; },
    p => { p.selections[0].recipe.inline.inputs.text.default = false; },
    p => { p.selections[0].recipe.inline.inputs.text.sensitive = true; },
    p => { p.selections[0].recipe.inline.inputs.text.minimum = 1; },
    p => { p.selections[0].recipe.inline.inputs.text.minLength = 100000; }
  ]) {
    const candidate = policy(); mutate(candidate);
    assert.equal(validatePolicy(candidate).valid, false, mutate.toString());
  }
});
