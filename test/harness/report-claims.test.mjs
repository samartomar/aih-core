// Public-seam tests for normalized claim sets. Imports resolve through the
// packed package self-reference after `node scripts/build.mjs`; no private
// function is reached directly. Expected values are worked by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  CALCULATION_METHODS,
  CLAIMS_ACCEPTED_VERSIONS,
  CLAIMS_PROJECTION_SCHEMA,
  CLAIMS_SCHEMA,
  ReportInputError,
  projectClaims,
  readClaimSet,
  validateClaimSet,
} from '@aihq/core/report';
import { contractSupport } from '@aihq/core/harness';

const T1 = '2026-10-14T10:00:00Z';
const T2 = '2026-10-14T10:05:00.250Z';
const T3 = '2026-10-14T10:10:00+00:00';
// Admission rejects shared references, so every fixture object is built fresh.
const subject = () => ({ kind: 'tool', id: 'node' });
const OUTCOME = (amount) => ({ amount, unit: 'outcome' });
const ref = (id, revision = 'r1') => ({ id, revision });

/** A valid measured configuration-check claim; an `undefined` override removes the field. */
function claim(id, overrides = {}) {
  const base = {
    id,
    revision: 'r1',
    producer: { id: 'scanner', version: '1.0.0' },
    recordSchema: 'urn:example:record:1.0.0',
    subject: { kind: 'machine', id: 'host-1' },
    scope: { kind: 'machine', targets: ['host-1'] },
    sources: [{ id: `record-${id}`, schema: 'urn:example:record:1.0.0' }],
    observation: `event-${id}`,
    capturedAt: T1,
    measure: 'configuration-check',
    kind: 'measured',
    value: OUTCOME('passed'),
    method: { id: 'baseline', version: '2.0.0' },
    coverage: { state: 'complete', reason: 'every target observed' },
    authentication: { status: 'not-authenticated' },
    applicability: { state: 'current', reason: 'captured this session', inputs: [] },
  };
  const merged = { ...base, ...overrides };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged;
}

const claimSet = (claims, extra = {}) => ({ schema: CLAIMS_SCHEMA, claims, ...extra });
const checkSet = () => ({ id: 'baseline', version: '2.0.0' });
const scoreRequest = (id, selected, inapplicable = []) => ({
  id, method: 'configuration-check-score', version: '1.0.0', checkSet: checkSet(),
  selected: selected.map((value) => ref(value)), inapplicable,
});
const calculationOf = (projection, id) => projection.calculations.find((entry) => entry.id === id);

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('the accepted versions, calculation methods and schema export are advertised', async () => {
  assert.deepEqual(CLAIMS_ACCEPTED_VERSIONS, ['urn:aihq:report:claims:1.0.0']);
  assert.equal(Object.isFrozen(CLAIMS_ACCEPTED_VERSIONS), true);
  assert.equal(CLAIMS_SCHEMA, 'urn:aihq:report:claims:1.0.0');
  assert.equal(CLAIMS_PROJECTION_SCHEMA, 'urn:aihq:report:claims-projection:1.0.0');
  assert.deepEqual(CALCULATION_METHODS, [
    { id: 'configuration-check-score', version: '1.0.0' },
    { id: 'verified-repair-count', version: '1.0.0' },
    { id: 'context-change', version: '1.0.0' },
  ]);
  assert.equal(Object.isFrozen(CALCULATION_METHODS), true);
  assert.deepEqual(
    contractSupport.contracts.find((entry) => entry.id === CLAIMS_SCHEMA),
    { id: CLAIMS_SCHEMA, role: 'accepts', schemaExport: '@aihq/core/report/schemas/claims/1.0.0.json' },
  );
  const schema = (await import('@aihq/core/report/schemas/claims/1.0.0.json', { with: { type: 'json' } })).default;
  assert.equal(schema.$id, 'urn:aihq:report:claims:1.0.0');
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('the JSON Schema accepts a valid claim set and rejects structural violations', async () => {
  const schema = (await import('@aihq/core/report/schemas/claims/1.0.0.json', { with: { type: 'json' } })).default;
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  const valid = claimSet([
    claim('a'),
    claim('b', { kind: 'unknown', value: undefined, unknownReason: 'probe unavailable' }),
    claim('c', { kind: 'estimated', value: { amount: 120, unit: 'tokens' } }),
  ], {
    calculations: [scoreRequest('score', ['a'])],
    actions: [{ id: 'act', category: 'blocker', reason: 'fix it', subjects: [subject()], evidence: [ref('a')],
      prerequisites: [], route: { kind: 'guidance', id: 'node-trust' } }],
  });
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  assert.equal(validateClaimSet(valid).valid, true);
  for (const mutate of [
    (set) => { set.claims[1].value = OUTCOME('passed'); },
    (set) => { delete set.claims[1].unknownReason; },
    (set) => { delete set.claims[2].method; },
    (set) => { set.claims[0].unexpected = true; },
    (set) => { set.claims[0].authentication = { status: 'authenticated' }; },
    (set) => { set.claims[0].scope.targets = []; },
    (set) => { set.claims[0].capturedAt = '2026-10-14T10:00:00'; },
    (set) => { set.schema = 'urn:aihq:report:claims:2.0.0'; },
  ]) {
    const broken = structuredClone(valid);
    mutate(broken);
    assert.equal(validate(broken), false);
    assert.equal(validateClaimSet(broken).valid, false);
  }
});

test('an unsupported schema is explicitly rejected with the exact original preserved', () => {
  const original = '{ "schema": "urn:aihq:report:claims:2.0.0",\n  "claims": [] }';
  const result = readClaimSet(original);
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'SCHEMA_UNSUPPORTED');
  assert.equal(result.schema, 'urn:aihq:report:claims:2.0.0');
  assert.equal(result.original, original);
  assert.deepEqual(result.errors, ['claimSet.schema: unsupported version']);

  assert.throws(() => projectClaims({ schema: 'urn:aihq:report:claims:2.0.0', claims: [] }),
    (error) => error instanceof ReportInputError && error.code === 'SCHEMA_UNSUPPORTED');
});

test('missing schema, unknown fields, duplicate keys and malformed JSON are INPUT_INVALID with the original kept', () => {
  const cases = [
    ['{"claims":[]}', null],
    ['{"schema":7,"claims":[]}', null],
    [`{"schema":"${CLAIMS_SCHEMA}","claims":[],"extra":true}`, CLAIMS_SCHEMA],
    [`{"schema":"${CLAIMS_SCHEMA}","claims":[],"claims":[]}`, CLAIMS_SCHEMA],
    [`{"schema":"${CLAIMS_SCHEMA}","claims":[`, null],
    ['[]', null],
    ['', null],
  ];
  for (const [original, schema] of cases) {
    const result = readClaimSet(original);
    assert.equal(result.status, 'rejected', original);
    assert.equal(result.code, 'INPUT_INVALID', original);
    assert.equal(result.schema, schema, original);
    assert.equal(result.original, original);
    assert.equal(result.errors.length, 1);
  }
  const unknownField = readClaimSet(JSON.stringify(claimSet([claim('a', { surprise: 1 })])));
  assert.equal(unknownField.code, 'INPUT_INVALID');
  assert.match(unknownField.errors[0], /^claimSet\.claims\[0\]: expected object/);
  assert.equal(readClaimSet(JSON.stringify(claimSet([claim('a')]))).status, 'supported');
});

test('oversized JSON is rejected, not truncated', () => {
  const original = JSON.stringify(claimSet([claim('a', { measure: 'x'.repeat(2_200_000) })]));
  const result = readClaimSet(original);
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'INPUT_INVALID');
  assert.equal(result.original, original);
});

test('validateClaimSet and readClaimSet never throw for malformed values', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const value of [undefined, null, 7, 'text', [], cyclic, { schema: CLAIMS_SCHEMA }, new Map(), () => 1]) {
    const result = validateClaimSet(value);
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
  }
  assert.equal(readClaimSet(undefined).status, 'rejected');
  assert.equal(readClaimSet(undefined).original, '');
});

test('instants must be real UTC calendar instants with an explicit offset', () => {
  for (const capturedAt of [
    '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-14T24:00:00Z', '2026-10-14T10:60:00Z',
    '2026-10-14T10:00:00', '2026-10-14T10:00:00+02:00', '2026-10-14 10:00:00Z', '2026-10-14', 'yesterday',
  ]) {
    assert.equal(validateClaimSet(claimSet([claim('a', { capturedAt })])).valid, false, capturedAt);
  }
  for (const capturedAt of ['2024-02-29T00:00:00Z', '2026-10-14T23:59:59.999Z', '2026-10-14T10:00:00+00:00']) {
    assert.equal(validateClaimSet(claimSet([claim('a', { capturedAt })])).valid, true, capturedAt);
  }
});

test('authenticated or verification-failed claims require complete verifier provenance', () => {
  const provenance = {
    verifier: { id: 'sigstore-verify', version: '4.1.2' },
    method: { id: 'bundle', version: '1.0.0' },
    verifiedAt: T2,
    evidence: [{ id: 'bundle-1', schema: 'urn:example:bundle:1.0.0', sha256: 'a'.repeat(64) }],
  };
  for (const status of ['authenticated', 'verification-failed']) {
    assert.equal(validateClaimSet(claimSet([claim('a', { authentication: { status } })])).valid, false);
    for (const missing of Object.keys(provenance)) {
      const partial = { status, ...provenance };
      delete partial[missing];
      assert.equal(validateClaimSet(claimSet([claim('a', { authentication: partial })])).valid, false, missing);
    }
    assert.equal(validateClaimSet(claimSet([
      claim('a', { authentication: { status, ...provenance, evidence: [] } })])).valid, false);
    const projection = projectClaims(claimSet([claim('a', { authentication: { status, ...provenance } })]));
    assert.deepEqual(projection.claims[0].authentication, { status, ...provenance });
  }
  assert.equal(validateClaimSet(claimSet([
    claim('a', { authentication: { status: 'not-authenticated', verifier: provenance.verifier } })])).valid, false);
});

test('projection never promotes or changes authentication', () => {
  const projection = projectClaims(claimSet([
    claim('a'),
    claim('b', { coverage: { state: 'complete', reason: 'every target observed' } }),
  ]));
  assert.deepEqual(projection.claims.map((entry) => entry.authentication),
    [{ status: 'not-authenticated' }, { status: 'not-authenticated' }]);
  // Coverage, applicability and authentication stay separate, uncombined fields.
  assert.deepEqual(projection.claims[0].coverage, { state: 'complete', reason: 'every target observed' });
  assert.deepEqual(projection.claims[0].applicability,
    { state: 'current', reason: 'captured this session', inputs: [] });
});

test('unknown claims need a reason, carry no value, and never default to zero', () => {
  assert.equal(validateClaimSet(claimSet([
    claim('a', { kind: 'unknown', unknownReason: 'probe unavailable' })])).valid, false);
  assert.equal(validateClaimSet(claimSet([
    claim('a', { kind: 'unknown', value: undefined })])).valid, false);
  assert.equal(validateClaimSet(claimSet([
    claim('a', { kind: 'unknown', value: undefined, unknownReason: '' })])).valid, false);
  assert.equal(validateClaimSet(claimSet([
    claim('a', { unknownReason: 'not unknown' })])).valid, false);
  assert.equal(validateClaimSet(claimSet([claim('a', { value: undefined })])).valid, false);
  assert.equal(validateClaimSet(claimSet([claim('a', { kind: 'estimated', method: undefined })])).valid, false);

  const projection = projectClaims(claimSet([
    claim('a', { kind: 'unknown', value: undefined, unknownReason: 'probe unavailable' }),
  ]));
  const [projected] = projection.claims;
  assert.equal('value' in projected, false);
  assert.equal(projected.unknownReason, 'probe unavailable');
  assert.equal(projected.kind, 'unknown');
});

test('claim identity: identical repeats are one claim, differing repeats are invalid', () => {
  const same = projectClaims(claimSet([claim('a'), claim('a')]));
  assert.equal(same.claims.length, 1);
  const reordered = claim('a');
  const permuted = Object.fromEntries(Object.entries(reordered).reverse());
  assert.equal(projectClaims(claimSet([claim('a'), permuted])).claims.length, 1);
  const different = validateClaimSet(claimSet([claim('a'), claim('a', { measure: 'other' })]));
  assert.equal(different.valid, false);
  assert.equal(different.errors[0], 'claimSet.claims[1]: claim identity repeats with different content');
  // A new revision is a separate claim.
  assert.equal(projectClaims(claimSet([claim('a'), claim('a', { revision: 'r2', measure: 'other' })])).claims.length, 2);
});

test('scope is exact: targets are required, unique and never imply all', () => {
  for (const scope of [
    { kind: 'machine', targets: [] },
    { kind: 'machine', targets: ['a', 'a'] },
    { kind: 'everything', targets: ['a'] },
    { kind: 'machine' },
    { kind: 'machine', targets: ['a'], all: true },
  ]) {
    assert.equal(validateClaimSet(claimSet([claim('a', { scope })])).valid, false);
  }
  assert.equal(validateClaimSet(claimSet([claim('a', { sources: [] })])).valid, false);
  assert.equal(validateClaimSet(claimSet([
    claim('a', { sources: [{ id: 's', schema: 'x', sha256: 'ABC' }] })])).valid, false);
});

test('the score counts unknown checks in the denominator', () => {
  const claims = [
    claim('p1'), claim('p2'),
    claim('f1', { value: OUTCOME('failed') }),
    claim('u1', { kind: 'unknown', value: undefined, unknownReason: 'probe unavailable' }),
  ];
  const projection = projectClaims(claimSet(claims, {
    calculations: [scoreRequest('score', ['p1', 'p2', 'f1', 'u1'])],
  }));
  const result = calculationOf(projection, 'score');
  assert.equal(result.status, 'available');
  assert.equal(result.reason, null);
  assert.deepEqual(result.counts, { passed: 2, failed: 1, unknown: 1, inapplicable: 0 });
  assert.equal(result.numerator, 2);
  assert.equal(result.denominator, 4);
  assert.equal(result.score, 50);
  assert.deepEqual(result.checkSet, checkSet());
  assert.deepEqual(result.failed, [ref('f1')]);
  assert.deepEqual(result.method, { id: 'configuration-check-score', version: '1.0.0' });
  assert.deepEqual(result.inputs, [ref('f1'), ref('p1'), ref('p2'), ref('u1')]);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.deduplication, { status: 'established', unidentified: [] });
});

test('unidentified observations are not asserted as a deduplicated score', () => {
  const claims = [
    claim('p1'),
    claim('n-pass', { observation: null }),
    claim('n-fail', { observation: null, value: OUTCOME('failed') }),
    claim('n-out', { observation: null }),
  ];
  const projection = projectClaims(claimSet(claims, {
    calculations: [scoreRequest('score', ['p1', 'n-pass', 'n-fail'], [{ claim: ref('n-out'), reason: 'not installed' }])],
  }));
  const result = calculationOf(projection, 'score');
  assert.deepEqual(result.counts, { passed: 2, failed: 1, unknown: 0, inapplicable: 1 });
  assert.equal(result.score, (2 * 100) / 3);
  assert.deepEqual(result.deduplication, {
    status: 'not-established', unidentified: [ref('n-fail'), ref('n-out'), ref('n-pass')],
  });
});

test('zero applicable checks makes the score unavailable, never zero', () => {
  const claims = [claim('n1'), claim('n2')];
  const projection = projectClaims(claimSet(claims, {
    calculations: [
      scoreRequest('empty', []),
      scoreRequest('all-excluded', [], [
        { claim: ref('n2'), reason: 'not installed' },
        { claim: ref('n1'), reason: 'platform mismatch' },
      ]),
    ],
  }));
  const empty = calculationOf(projection, 'empty');
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.score, null);
  assert.equal(empty.reason, 'no-applicable-checks');
  assert.deepEqual(empty.counts, { passed: 0, failed: 0, unknown: 0, inapplicable: 0 });
  const excluded = calculationOf(projection, 'all-excluded');
  assert.equal(excluded.status, 'unavailable');
  assert.equal(excluded.score, null);
  assert.deepEqual(excluded.counts, { passed: 0, failed: 0, unknown: 0, inapplicable: 2 });
  assert.deepEqual(excluded.excluded, [
    { claim: ref('n1'), reason: 'platform mismatch' },
    { claim: ref('n2'), reason: 'not installed' },
  ]);
});

test('a failed check is listed even when the score is high', () => {
  const claims = [];
  for (let index = 1; index <= 19; index += 1) claims.push(claim(`c${String(index).padStart(2, '0')}`));
  claims.push(claim('c20', { value: OUTCOME('failed') }));
  const selected = claims.map((entry) => entry.id);
  const projection = projectClaims(claimSet(claims, { calculations: [scoreRequest('score', selected)] }));
  const result = calculationOf(projection, 'score');
  assert.equal(result.score, 95);
  assert.deepEqual(result.counts, { passed: 19, failed: 1, unknown: 0, inapplicable: 0 });
  assert.deepEqual(result.failed, [ref('c20')]);
});

test('inapplicable claims are excluded with their reason and cannot also be selected', () => {
  const claims = [claim('p1'), claim('f1', { value: OUTCOME('failed') }), claim('x1')];
  const projection = projectClaims(claimSet(claims, {
    calculations: [scoreRequest('score', ['p1', 'f1'], [{ claim: ref('x1'), reason: 'not installed' }])],
  }));
  const result = calculationOf(projection, 'score');
  assert.equal(result.score, 50);
  assert.deepEqual(result.counts, { passed: 1, failed: 1, unknown: 0, inapplicable: 1 });
  assert.deepEqual(result.excluded, [{ claim: ref('x1'), reason: 'not installed' }]);

  const both = validateClaimSet(claimSet(claims, {
    calculations: [scoreRequest('score', ['p1', 'x1'], [{ claim: ref('x1'), reason: 'not installed' }])],
  }));
  assert.equal(both.valid, false);
  assert.equal(both.errors[0], 'claimSet.calculations[0].inapplicable[0].claim: an inapplicable claim must not also be selected');
});

test('score selections must be checks of the named set with a pass/fail outcome', () => {
  const cases = [
    claim('wrong-measure', { measure: 'other' }),
    claim('wrong-method', { method: { id: 'baseline', version: '9.9.9' } }),
    claim('no-method', { method: undefined }),
    claim('wrong-outcome', { value: { amount: 5, unit: 'bytes' } }),
  ];
  for (const bad of cases) {
    const result = validateClaimSet(claimSet([bad], { calculations: [scoreRequest('score', [bad.id])] }));
    assert.equal(result.valid, false, bad.id);
    assert.match(result.errors[0], /^claimSet\.calculations\[0\]\.selected\[0\]: /);
  }
});

test('a duplicate imported event is counted once in the score', () => {
  // A re-imported event repeats the same content, including its source record.
  const failed = () => ({
    value: OUTCOME('failed'), observation: 'evt-shared',
    sources: [{ id: 'record-shared', schema: 'urn:example:record:1.0.0' }],
  });
  const claims = [
    claim('a-first', failed()),
    claim('a-second', { ...failed(), revision: 'r9' }),
    claim('z-pass'),
  ];
  const projection = projectClaims(claimSet(claims, {
    calculations: [{ ...scoreRequest('score', []), selected: [ref('a-first'), ref('a-second', 'r9'), ref('z-pass')] }],
  }));
  assert.deepEqual(projection.observations.duplicates, [{
    producer: 'scanner', observation: 'evt-shared', claim: ref('a-first'), merged: [ref('a-second', 'r9')], imports: 2,
  }]);
  assert.deepEqual(projection.observations.conflicts, []);
  assert.deepEqual(projection.claims.map((entry) => [entry.id, entry.dedup]), [
    ['a-first', { status: 'canonical', canonical: ref('a-first') }],
    ['a-second', { status: 'duplicate', canonical: ref('a-first') }],
    ['z-pass', { status: 'unique', canonical: null }],
  ]);
  const result = calculationOf(projection, 'score');
  assert.deepEqual(result.counts, { passed: 1, failed: 1, unknown: 0, inapplicable: 0 });
  assert.equal(result.score, 50);
  assert.deepEqual(result.failed, [ref('a-first')]);
});

test('conflicting observations keep every claim and are listed', () => {
  const claims = [
    claim('x-pass', { observation: 'evt-9' }),
    claim('x-fail', { observation: 'evt-9', value: OUTCOME('failed') }),
    claim('y-none', { observation: null }),
    claim('y-none-too', { observation: null }),
  ];
  const projection = projectClaims(claimSet(claims));
  assert.deepEqual(projection.claims.map((entry) => entry.id), ['x-fail', 'x-pass', 'y-none', 'y-none-too']);
  assert.deepEqual(projection.observations.conflicts, [{
    producer: 'scanner', observation: 'evt-9', claims: [ref('x-fail'), ref('x-pass')],
    reason: 'same-observation-different-content',
  }]);
  assert.deepEqual(projection.observations.duplicates, []);
  assert.deepEqual(projection.observations.unidentified, [ref('y-none'), ref('y-none-too')]);
  assert.deepEqual(projection.claims.map((entry) => entry.dedup.status),
    ['conflict', 'conflict', 'unidentified', 'unidentified']);
  assert.deepEqual(projection.claims.map((entry) => entry.dedup.canonical), [null, null, null, null]);
});

test('a conflicted observation counts once, as unknown, in a score', () => {
  const claims = [
    claim('x-pass', { observation: 'evt-9' }),
    claim('x-fail', { observation: 'evt-9', value: OUTCOME('failed') }),
    claim('ok'),
  ];
  const projection = projectClaims(claimSet(claims, {
    calculations: [scoreRequest('score', ['x-pass', 'x-fail', 'ok'])],
  }));
  const result = calculationOf(projection, 'score');
  assert.deepEqual(result.counts, { passed: 1, failed: 0, unknown: 1, inapplicable: 0 });
  assert.equal(result.score, 50);
  // The aggregate counts the conflict once as unknown, but the failed member stays prominent.
  assert.deepEqual(result.failed, [ref('x-fail')]);
  assert.deepEqual(result.conflicts, [ref('x-fail'), ref('x-pass')]);
  assert.equal(projection.claims.length, 3);
});

test('the same observation id from different producers is not a duplicate', () => {
  const projection = projectClaims(claimSet([
    claim('a', { observation: 'evt-1' }),
    claim('b', { observation: 'evt-1', producer: { id: 'other-scanner', version: '1.0.0' } }),
  ]));
  assert.deepEqual(projection.observations.duplicates, []);
  assert.deepEqual(projection.observations.conflicts, []);
  assert.deepEqual(projection.claims.map((entry) => entry.dedup.status), ['unique', 'unique']);
});

// ---- verified repair count

const COND = 'node-trust';
const OPERATION = 'node-npm-ca';
const check = (id, amount, capturedAt, extra = {}) => claim(id, {
  subject: subject(), measure: COND, value: OUTCOME(amount), capturedAt, method: undefined, ...extra,
});
const repairClaim = (id, capturedAt, measure = 'repair', extra = {}) => claim(id, {
  subject: subject(), measure, value: { amount: OPERATION, unit: 'operation' }, capturedAt, method: undefined, ...extra,
});
const attempt = (precheck, repair, postcheck, extra = {}) => ({
  operation: OPERATION, subject: subject(), condition: COND,
  precheck: precheck === null ? null : ref(precheck),
  repair: repair === null ? null : ref(repair),
  postcheck: postcheck === null ? null : ref(postcheck),
  ...extra,
});
const repairRequest = (attempts) => ({ id: 'repairs', method: 'verified-repair-count', version: '1.0.0', attempts });

function repairOutcome(claims, attempts) {
  const projection = projectClaims(claimSet(claims, { calculations: [repairRequest(attempts)] }));
  return calculationOf(projection, 'repairs');
}

test('one verified attempt counts as one repair', () => {
  const result = repairOutcome([
    check('pre', 'failed', T1), repairClaim('rep', T2), check('post', 'passed', T3),
  ], [attempt('pre', 'rep', 'post')]);
  assert.equal(result.status, 'available');
  assert.equal(result.count, 1);
  assert.deepEqual(result.attempts, [{
    operation: OPERATION, subject: subject(), condition: COND,
    precheck: ref('pre'), repair: ref('rep'), postcheck: ref('post'), counted: true, reason: 'verified',
  }]);
  assert.deepEqual(result.method, { id: 'verified-repair-count', version: '1.0.0' });
  assert.deepEqual(result.inputs, [ref('post'), ref('pre'), ref('rep')]);
  assert.deepEqual(result.deduplication, { status: 'established', unidentified: [] });
});

test('a repair over unidentified observations is counted but not asserted as deduplicated', () => {
  const result = repairOutcome([
    check('pre', 'failed', T1, { observation: null }), repairClaim('rep', T2), check('post', 'passed', T3),
  ], [attempt('pre', 'rep', 'post')]);
  assert.equal(result.count, 1);
  assert.deepEqual(result.deduplication, { status: 'not-established', unidentified: [ref('pre')] });
});

test('conflicting precheck or postcheck evidence never earns a verified repair', () => {
  const claims = [
    check('pre-fail', 'failed', T1, { observation: 'evt-pre' }),
    check('pre-pass', 'passed', T1, { observation: 'evt-pre' }),
    check('pre', 'failed', T1),
    repairClaim('rep', T2),
    check('post-pass', 'passed', T3, { observation: 'evt-post' }),
    check('post-fail', 'failed', T3, { observation: 'evt-post' }),
    check('post', 'passed', T3),
  ];
  const cases = [
    [attempt('pre-fail', 'rep', 'post'), 'conflicting-evidence'],
    [attempt('pre-pass', 'rep', 'post'), 'conflicting-evidence'],
    [attempt('pre', 'rep', 'post-pass'), 'conflicting-evidence'],
    [attempt('pre', 'rep', 'post'), 'verified'],
  ];
  const result = repairOutcome(claims, cases.map(([entry]) => entry));
  assert.deepEqual(result.attempts.map((entry) => [entry.reason, entry.counted]),
    cases.map(([, reason]) => [reason, reason === 'verified']));
  assert.equal(result.count, 1);
});

test('cases that are not a verified repair earn no win and say why', () => {
  const pre = check('pre', 'failed', T1);
  const healthy = check('healthy', 'passed', T1);
  const unknownPre = check('unknown-pre', 'passed', T1, {
    kind: 'unknown', value: undefined, unknownReason: 'probe unavailable' });
  const rep = repairClaim('rep', T2);
  const external = repairClaim('external', T2, 'external-repair');
  const postPass = check('post-pass', 'passed', T3);
  const postFail = check('post-fail', 'failed', T3);
  const postUnknown = check('post-unknown', 'passed', T3, {
    kind: 'unknown', value: undefined, unknownReason: 'probe unavailable' });
  const claims = [pre, healthy, unknownPre, rep, external, postPass, postFail, postUnknown];
  const cases = [
    [attempt('unknown-pre', 'rep', 'post-pass'), 'unknown-precondition'],
    [attempt(null, 'rep', 'post-pass'), 'unknown-precondition'],
    [attempt('healthy', 'rep', 'post-pass'), 'already-healthy'],
    [attempt('pre', 'external', 'post-pass'), 'external-repair'],
    [attempt('pre', null, 'post-pass'), 'unknown-cause'],
    [attempt('pre', 'rep', null), 'applied-unverified'],
    [attempt('pre', 'rep', 'post-unknown'), 'applied-unverified'],
    [attempt('pre', 'rep', 'post-fail'), 'repair-not-verified'],
    [attempt('pre', null, 'post-fail'), 'no-recovery'],
    [attempt('pre', null, null), 'no-recovery'],
    [attempt('pre', null, 'post-unknown'), 'no-recovery'],
  ];
  const result = repairOutcome(claims, cases.map(([entry]) => entry));
  assert.equal(result.count, 0);
  assert.deepEqual(result.attempts.map((entry) => [entry.reason, entry.counted]),
    cases.map(([, reason]) => [reason, false]));
});

test('uncorrelated attempts are never counted', () => {
  const pre = check('pre', 'failed', T1);
  const rep = repairClaim('rep', T2);
  const post = check('post', 'passed', T3);
  const otherSubject = check('other-subject', 'passed', T3, { subject: { kind: 'tool', id: 'npm' } });
  const otherCondition = check('other-condition', 'passed', T3, { measure: 'something-else' });
  const otherOperation = repairClaim('other-operation', T2, 'repair', {
    value: { amount: 'different-operation', unit: 'operation' } });
  const late = repairClaim('late', '2026-10-14T10:20:00Z');
  const sameInstant = check('same-instant', 'passed', T2);
  const claims = [pre, rep, post, otherSubject, otherCondition, otherOperation, late, sameInstant];
  const result = repairOutcome(claims, [
    attempt('pre', 'rep', 'other-subject'),
    attempt('pre', 'rep', 'other-condition'),
    attempt('pre', 'other-operation', 'post'),
    attempt('pre', 'late', 'post'),
    attempt('pre', 'rep', 'same-instant'),
    attempt('pre', 'rep', 'post', { subject: { kind: 'tool', id: 'npm' } }),
  ]);
  assert.equal(result.count, 0);
  assert.deepEqual(result.attempts.map((entry) => entry.reason), Array(6).fill('uncorrelated'));
});

test('a duplicated imported failure counts one verified repair, and a later pass never erases it', () => {
  const claims = [
    check('pre-a', 'failed', T1, { observation: 'evt-failure', sources: [{ id: 'import-1', schema: 'x' }] }),
    check('pre-b', 'failed', T1, { observation: 'evt-failure', sources: [{ id: 'import-1', schema: 'x' }] }),
    repairClaim('rep', T2),
    check('post', 'passed', T3),
  ];
  const result = repairOutcome(claims, [attempt('pre-a', 'rep', 'post'), attempt('pre-b', 'rep', 'post')]);
  assert.equal(result.count, 1);
  assert.deepEqual(result.attempts.map((entry) => [entry.reason, entry.counted]),
    [['verified', true], ['verified', true]]);

  // Two distinct failures, each repaired and verified, count twice.
  const second = [
    check('pre-1', 'failed', T1), repairClaim('rep-1', T2), check('post-1', 'passed', T3),
    check('pre-2', 'failed', '2026-10-14T11:00:00Z'),
    repairClaim('rep-2', '2026-10-14T11:05:00Z'),
    check('post-2', 'passed', '2026-10-14T11:10:00Z'),
  ];
  assert.equal(repairOutcome(second, [
    attempt('pre-1', 'rep-1', 'post-1'), attempt('pre-2', 'rep-2', 'post-2'),
  ]).count, 2);
});

test('a repair request without attempts counts zero without inventing one', () => {
  const result = repairOutcome([claim('a')], []);
  assert.equal(result.status, 'available');
  assert.equal(result.count, 0);
  assert.deepEqual(result.attempts, []);
  assert.deepEqual(result.inputs, []);
});

// ---- context change

const sizeClaim = (id, amount, extra = {}) => claim(id, {
  measure: 'context-bytes', value: { amount, unit: 'bytes' }, method: undefined, ...extra,
});
const changeRequest = (id, before, after) => ({
  id, method: 'context-change', version: '1.0.0', before: ref(before), after: ref(after),
});
const change = (claims, before = 'before', after = 'after') => calculationOf(
  projectClaims(claimSet(claims, { calculations: [changeRequest('change', before, after)] })), 'change');

test('a measured byte change reports the difference and percentage', () => {
  const result = change([sizeClaim('before', 1000), sizeClaim('after', 750)]);
  assert.equal(result.status, 'available');
  assert.equal(result.reason, null);
  assert.equal(result.before, 1000);
  assert.equal(result.after, 750);
  assert.equal(result.unit, 'bytes');
  assert.equal(result.absoluteDifference, 250);
  assert.equal(result.direction, 'decrease');
  assert.equal(result.percentage, 25);
  assert.equal('percentageReason' in result, false);
  assert.deepEqual(result.inputs, [ref('after'), ref('before')]);

  const grown = change([sizeClaim('before', 800), sizeClaim('after', 1000)]);
  assert.equal(grown.direction, 'increase');
  assert.equal(grown.absoluteDifference, 200);
  assert.equal(grown.percentage, -25);
  const same = change([sizeClaim('before', 5), sizeClaim('after', 5)]);
  assert.equal(same.direction, 'unchanged');
  assert.equal(same.absoluteDifference, 0);
  assert.equal(same.percentage, 0);
});

test('a zero baseline has an absolute difference but no percentage', () => {
  const result = change([sizeClaim('before', 0), sizeClaim('after', 100)]);
  assert.equal(result.status, 'available');
  assert.equal(result.absoluteDifference, 100);
  assert.equal(result.direction, 'increase');
  assert.equal(result.percentage, null);
  assert.equal(result.percentageReason, 'zero-baseline');
});

test('estimates compare only with an identical method', () => {
  const estimate = (id, amount, method) => sizeClaim(id, amount, {
    kind: 'estimated', value: { amount, unit: 'tokens' }, method });
  const tokenizer = () => ({ id: 'tokenizer', version: '1.0.0' });
  const ok = change([estimate('before', 200, tokenizer()), estimate('after', 150, tokenizer())]);
  assert.equal(ok.status, 'available');
  assert.equal(ok.unit, 'tokens');
  assert.equal(ok.absoluteDifference, 50);
  assert.equal(ok.percentage, 25);
  const differing = change([estimate('before', 200, tokenizer()),
    estimate('after', 150, { id: 'tokenizer', version: '2.0.0' })]);
  assert.equal(differing.status, 'unavailable');
  assert.equal(differing.reason, 'incomparable-method');
  assert.equal('absoluteDifference' in differing, false);
});

test('incomparable claims are unavailable with an explicit reason', () => {
  const method = { id: 'tokenizer', version: '1.0.0' };
  const cases = [
    ['incomparable-kind', sizeClaim('before', 100),
      sizeClaim('after', 100, { kind: 'estimated', method })],
    ['incomparable-unit', sizeClaim('before', 100),
      sizeClaim('after', 100, { value: { amount: 100, unit: 'tokens' } })],
    ['incomparable-measure', sizeClaim('before', 100), sizeClaim('after', 100, { measure: 'other' })],
    ['unknown-value', sizeClaim('before', 100),
      sizeClaim('after', 0, { kind: 'unknown', value: undefined, unknownReason: 'not measured' })],
    ['unsupported-unit', sizeClaim('before', 3, { value: { amount: 3, unit: 'lines' } }),
      sizeClaim('after', 2, { value: { amount: 2, unit: 'lines' } })],
    ['unsupported-kind', sizeClaim('before', 100, { kind: 'declared' }),
      sizeClaim('after', 90, { kind: 'declared' })],
    ['invalid-amount', sizeClaim('before', 100), sizeClaim('after', -5)],
    ['invalid-amount', sizeClaim('before', 'large'), sizeClaim('after', 5)],
  ];
  for (const [reason, before, after] of cases) {
    const result = change([before, after]);
    assert.equal(result.status, 'unavailable', reason);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.method, { id: 'context-change', version: '1.0.0' });
    assert.equal('percentage' in result, false);
  }
});

// ---- references, actions, determinism

test('calculation and action references must resolve and use a supported method', () => {
  const claims = [claim('a')];
  const unsupported = validateClaimSet(claimSet(claims, {
    calculations: [{ id: 'risk', method: 'global-risk-score', version: '1.0.0' }],
  }));
  assert.equal(unsupported.valid, false);
  assert.match(unsupported.errors[0], /^claimSet\.calculations\[0\]\.method: /);
  const version = validateClaimSet(claimSet(claims, {
    calculations: [{ ...scoreRequest('score', ['a']), version: '2.0.0' }],
  }));
  assert.equal(version.valid, false);
  assert.match(version.errors[0], /^claimSet\.calculations\[0\]\.method: /);

  const unresolved = validateClaimSet(claimSet(claims, { calculations: [scoreRequest('score', ['missing'])] }));
  assert.equal(unresolved.valid, false);
  assert.equal(unresolved.errors[0], 'claimSet.calculations[0].selected[0]: does not resolve to a claim in the set');
  const revision = validateClaimSet(claimSet(claims, {
    calculations: [{ ...changeRequest('c', 'a', 'a'), after: { id: 'a', revision: 'r9' } }],
  }));
  assert.equal(revision.errors[0], 'claimSet.calculations[0].after: does not resolve to a claim in the set');
  const action = { id: 'act', category: 'blocker', reason: 'fix', subjects: [subject()],
    evidence: [ref('missing')], prerequisites: [], route: { kind: 'guidance', id: 'g' } };
  assert.equal(validateClaimSet(claimSet(claims, { actions: [action] })).errors[0],
    'claimSet.actions[0].evidence[0]: does not resolve to a claim in the set');
  assert.equal(validateClaimSet(claimSet(claims, {
    calculations: [scoreRequest('same', ['a']), scoreRequest('same', ['a'])] })).valid, false);
});

test('actions are ordered by category then id in code-unit order', () => {
  const action = (id, category) => ({
    id, category, reason: `reason for ${id}`, subjects: [subject()], evidence: [ref('a')],
    prerequisites: ['network access'], route: { kind: 'operation', id: 'node-npm-ca' },
  });
  const projection = projectClaims(claimSet([claim('a')], {
    actions: [
      action('b-optional', 'optional-improvement'),
      action('alpha', 'blocker'),
      action('m-unknown', 'important-unknown'),
      action('Zeta', 'blocker'),
      action('c-urgent', 'urgent-review'),
    ],
  }));
  assert.deepEqual(projection.actions.map((entry) => [entry.id, entry.order.rank, entry.order.category]), [
    ['Zeta', 1, 'blocker'],
    ['alpha', 2, 'blocker'],
    ['c-urgent', 3, 'urgent-review'],
    ['m-unknown', 4, 'important-unknown'],
    ['b-optional', 5, 'optional-improvement'],
  ]);
  for (const entry of projection.actions) {
    assert.equal(entry.order.tie, 'id');
    assert.equal(typeof entry.order.reason, 'string');
    assert.ok(entry.order.reason.length > 0);
    assert.equal(entry.reason, `reason for ${entry.id}`);
  }
  assert.equal(projection.actions[0].order.reason, projection.actions[1].order.reason);
  assert.notEqual(projection.actions[0].order.reason, projection.actions[2].order.reason);
  assert.deepEqual(projection.actions[0].route, { kind: 'operation', id: 'node-npm-ca' });
});

test('projection is deterministic, order-independent for claims and does not mutate its input', () => {
  const claims = [
    claim('b', { observation: 'evt-1' }),
    claim('a', { observation: 'evt-1', revision: 'r2' }),
    claim('c', { value: OUTCOME('failed') }),
    claim('d', { observation: null }),
  ];
  const input = claimSet(claims, {
    calculations: [{
      ...scoreRequest('score', []),
      selected: [ref('a', 'r2'), ref('b'), ref('c'), ref('d')],
    }],
    actions: [{ id: 'act', category: 'urgent-review', reason: 'check', subjects: [subject()],
      evidence: [ref('c')], prerequisites: [], route: { kind: 'guidance', id: 'g' } }],
  });
  const snapshot = JSON.stringify(input);
  deepFreeze(input);
  const first = projectClaims(input);
  const second = projectClaims(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(first.schema, CLAIMS_PROJECTION_SCHEMA);
  assert.deepEqual(first.source, { schema: CLAIMS_SCHEMA });
  assert.deepEqual(first.claims.map((entry) => [entry.id, entry.revision]),
    [['a', 'r2'], ['b', 'r1'], ['c', 'r1'], ['d', 'r1']]);

  const shuffled = JSON.stringify(projectClaims({
    ...input, claims: [claims[3], claims[1], claims[0], claims[2]],
  }));
  assert.equal(shuffled, JSON.stringify(first));

  // The read path returns a plain copy that projects identically.
  const read = readClaimSet(snapshot);
  assert.equal(read.status, 'supported');
  assert.equal(JSON.stringify(projectClaims(read.claimSet)), JSON.stringify(first));
});

test('claim fields keep a fixed key order in the projection', () => {
  const [projected] = projectClaims(claimSet([claim('a', { method: undefined })])).claims;
  assert.deepEqual(Object.keys(projected), [
    'id', 'revision', 'producer', 'recordSchema', 'subject', 'scope', 'sources', 'observation',
    'capturedAt', 'measure', 'kind', 'value', 'coverage', 'authentication', 'applicability', 'dedup',
  ]);
});

test('the claim set carries no global or combined risk score', () => {
  const projection = projectClaims(claimSet([claim('a')], { calculations: [scoreRequest('score', ['a'])] }));
  assert.deepEqual(Object.keys(projection), ['schema', 'source', 'claims', 'observations', 'calculations', 'actions']);
  assert.equal(JSON.stringify(projection).includes('risk'), false);
});

test('the filled examples read, project to their committed projections and match worked values', async () => {
  const directory = new URL('../../examples/reporting/claims/', import.meta.url);
  const load = (name) => readFile(new URL(name, directory), 'utf8');
  const schema = (await import('@aihq/core/report/schemas/claims/1.0.0.json', { with: { type: 'json' } })).default;
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  const byId = (projection) => Object.fromEntries(projection.calculations.map((entry) => [entry.id, entry]));
  const project = async (name) => {
    const text = await load(`${name}.input.json`);
    const parsed = JSON.parse(text);
    assert.equal(validate(parsed), true, JSON.stringify(validate.errors));
    const read = readClaimSet(text);
    assert.equal(read.status, 'supported');
    assert.deepEqual(read.claimSet, parsed);
    const projection = projectClaims(read.claimSet);
    const committed = await load(`${name}.projection.json`);
    assert.deepEqual(projection, JSON.parse(committed));
    assert.equal(`${JSON.stringify(projection, null, 2)}\n`, committed);
    return projection;
  };

  const checksProjection = await project('checks');
  const checks = byId(checksProjection);
  const unknownScore = checks['score-unknown-in-denominator'];
  assert.equal(unknownScore.status, 'available');
  assert.equal(unknownScore.score, 50);
  assert.deepEqual(unknownScore.counts, { passed: 2, failed: 1, unknown: 1, inapplicable: 1 });
  assert.deepEqual(unknownScore.failed, [{ id: 'check-git-sslcainfo', revision: '1' }]);
  assert.equal(checks['score-zero-applicable'].status, 'unavailable');
  assert.equal(checks['score-zero-applicable'].score, null);
  assert.equal(checks['score-high-with-failure'].score, 95);
  assert.deepEqual(checks['score-high-with-failure'].failed, [{ id: 'check-high-20', revision: '1' }]);
  assert.deepEqual(checksProjection.observations.conflicts.map((entry) => entry.claims.map((value) => value.id)),
    [['check-java-truststore-a', 'check-java-truststore-b']]);
  assert.deepEqual(checksProjection.claims.filter((entry) => entry.id.startsWith('check-java-truststore')).map((entry) => entry.dedup.status),
    ['conflict', 'conflict']);
  assert.deepEqual(checksProjection.actions.map((entry) => entry.id),
    ['a-repair-tool-20', 'repair-git-trust', 'review-java-truststore-conflict', 'recheck-pip', 'add-cargo']);

  const repairsProjection = await project('repairs');
  const repairs = byId(repairsProjection)['verified-repairs'];
  assert.equal(repairs.count, 1);
  assert.deepEqual(repairs.attempts.map((entry) => entry.reason),
    ['verified', 'verified', 'already-healthy', 'unknown-cause', 'external-repair', 'applied-unverified']);
  assert.deepEqual(repairs.attempts.map((entry) => entry.counted), [true, true, false, false, false, false]);

  // The examples carry no unidentified observation, so every aggregate is deduplicated.
  const aggregates = [...checksProjection.calculations, ...repairsProjection.calculations]
    .filter((entry) => entry.deduplication !== undefined);
  assert.equal(aggregates.length, 4);
  assert.deepEqual(aggregates.map((entry) => entry.deduplication), Array(4).fill({ status: 'established', unidentified: [] }));

  const context = byId(await project('context'));
  assert.deepEqual([context['bytes-reduction'].before, context['bytes-reduction'].after, context['bytes-reduction'].unit,
    context['bytes-reduction'].absoluteDifference, context['bytes-reduction'].percentage, context['bytes-reduction'].direction],
  [1000, 750, 'bytes', 250, 25, 'decrease']);
  assert.deepEqual([context['zero-baseline'].absoluteDifference, context['zero-baseline'].percentage,
    context['zero-baseline'].percentageReason, context['zero-baseline'].direction], [1200, null, 'zero-baseline', 'increase']);
  assert.deepEqual([context['same-method-estimate'].unit, context['same-method-estimate'].absoluteDifference,
    context['same-method-estimate'].percentage], ['tokens', 100, 25]);
  assert.equal(context['estimate-vs-observed'].status, 'unavailable');
  assert.equal(context['estimate-vs-observed'].reason, 'incomparable-kind');

  const original = await load('unsupported.input.json');
  const rejected = readClaimSet(original);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.code, 'SCHEMA_UNSUPPORTED');
  assert.equal(rejected.original, original);
  assert.equal(validate(JSON.parse(original)), false);
});
