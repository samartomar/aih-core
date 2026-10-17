// Public-seam tests for the portable claim-set privacy rule: a shared string
// never carries a machine-local path. Imports resolve through the packed package
// self-reference after `node scripts/build.mjs`; no private function is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  CLAIMS_ACCEPTED_VERSIONS,
  CLAIMS_SCHEMA,
  CLAIMS_SCHEMA_1_1_0,
  ReportInputError,
  createReport,
  projectClaims,
  readClaimSet,
  validateClaimSet,
} from '@aihq/core/report';

const T1 = '2026-10-14T10:00:00Z';
const T2 = '2026-10-14T10:05:00Z';
const ref = (id, revision = 'r1') => ({ id, revision });

function claim(id, overrides = {}) {
  return {
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
    value: { amount: 'passed', unit: 'outcome' },
    method: { id: 'baseline', version: '2.0.0' },
    coverage: { state: 'complete', reason: 'every target observed' },
    authentication: { status: 'not-authenticated' },
    applicability: { state: 'current', reason: 'captured this session', inputs: [] },
    ...overrides,
  };
}

/** A valid set that exercises claims, a calculation and an action. */
const portableSet = (schema = CLAIMS_SCHEMA) => ({
  schema,
  claims: [claim('a'), claim('b')],
  calculations: [{
    id: 'score', method: 'configuration-check-score', version: '1.0.0', checkSet: { id: 'baseline', version: '2.0.0' },
    selected: [ref('a')], inapplicable: [],
  }],
  actions: [{
    id: 'act', category: 'blocker', reason: 'fix it', subjects: [{ kind: 'tool', id: 'node' }], evidence: [ref('a')],
    prerequisites: [], route: { kind: 'guidance', id: 'node-trust' },
  }],
});

const LOCAL_PATH_FORMS = [
  ['posix-absolute', '/srv/build/private/report.json'],
  ['posix-absolute', 'observed in /tmp'],
  ['posix-absolute', 'missing (/etc/hosts).'],
  ['posix-absolute', 'piped |/var/log/app'],
  ['posix-absolute', '--prefix=/opt/tool'],
  ['posix-absolute', '/data/app/config.json'],
  ['posix-absolute', '/x/.ssh/known_hosts'],
  ['windows-drive', String.raw`D:\work\project\config.json`],
  ['windows-drive', 'c:/tools/node'],
  ['unc', String.raw`\\fileserver\share\evidence.json`],
  ['unc', String.raw`\\?\C:\long\path`],
  ['home-relative', '~/project/settings.json'],
  ['home-relative', String.raw`~\AppData\config`],
  ['home-relative', '~builder/workspace'],
  ['file-url', 'file:///srv/evidence.json'],
  ['file-url', 'see FILE:/srv/evidence.json'],
  ['home-directory', 'src/Users/model.ts'],
  ['home-directory', 'https://example.com/home/user/report'],
];

/** One mutation per shared field, each naming the pointer its refusal reports. */
const PATH_FIELDS = [
  ['claimSet.claims[0].id', (set, value) => { set.claims[0].id = value; }],
  ['claimSet.claims[0].revision', (set, value) => { set.claims[0].revision = value; }],
  ['claimSet.claims[0].producer.id', (set, value) => { set.claims[0].producer.id = value; }],
  ['claimSet.claims[0].recordSchema', (set, value) => { set.claims[0].recordSchema = value; }],
  ['claimSet.claims[0].subject.kind', (set, value) => { set.claims[0].subject.kind = value; }],
  ['claimSet.claims[0].subject.id', (set, value) => { set.claims[0].subject.id = value; }],
  ['claimSet.claims[0].scope.targets[0]', (set, value) => { set.claims[0].scope.targets = [value]; }],
  ['claimSet.claims[0].sources[0].id', (set, value) => { set.claims[0].sources[0].id = value; }],
  ['claimSet.claims[0].sources[0].schema', (set, value) => { set.claims[0].sources[0].schema = value; }],
  ['claimSet.claims[0].observation', (set, value) => { set.claims[0].observation = value; }],
  ['claimSet.claims[0].measure', (set, value) => { set.claims[0].measure = value; }],
  ['claimSet.claims[0].value.amount', (set, value) => { set.claims[0].value = { amount: value, unit: 'path' }; }],
  ['claimSet.claims[0].value.unit', (set, value) => { set.claims[0].value = { amount: 1, unit: value }; }],
  ['claimSet.claims[0].unknownReason', (set, value) => {
    set.claims[0].kind = 'unknown';
    delete set.claims[0].value;
    set.claims[0].unknownReason = value;
  }],
  ['claimSet.claims[0].method.id', (set, value) => { set.claims[0].method.id = value; }],
  ['claimSet.claims[0].coverage.reason', (set, value) => { set.claims[0].coverage.reason = value; }],
  ['claimSet.claims[0].authentication.evidence[0].id', (set, value) => {
    set.claims[0].authentication = {
      status: 'authenticated', verifier: { id: 'verifier', version: '1.0.0' }, method: { id: 'bundle', version: '1.0.0' },
      verifiedAt: T2, evidence: [{ id: value, schema: 'urn:example:bundle:1.0.0', sha256: 'a'.repeat(64) }],
    };
  }],
  ['claimSet.claims[0].applicability.reason', (set, value) => { set.claims[0].applicability.reason = value; }],
  ['claimSet.claims[0].applicability.inputs[0].id', (set, value) => { set.claims[0].applicability.inputs = [ref(value)]; }],
  ['claimSet.calculations[0].id', (set, value) => { set.calculations[0].id = value; }],
  ['claimSet.calculations[0].inapplicable[0].reason', (set, value) => {
    set.calculations[0].inapplicable = [{ claim: ref('b'), reason: value }];
  }],
  ['claimSet.actions[0].id', (set, value) => { set.actions[0].id = value; }],
  ['claimSet.actions[0].reason', (set, value) => { set.actions[0].reason = value; }],
  ['claimSet.actions[0].subjects[0].id', (set, value) => { set.actions[0].subjects[0].id = value; }],
  ['claimSet.actions[0].prerequisites[0]', (set, value) => { set.actions[0].prerequisites = [value]; }],
  ['claimSet.actions[0].route.id', (set, value) => { set.actions[0].route.id = value; }],
];

test('every machine-local path form is refused with its form and pointer, never its value', () => {
  for (const [kind, value] of LOCAL_PATH_FORMS) {
    const set = portableSet();
    set.claims[0].subject.id = value;
    const result = validateClaimSet(set);
    assert.deepEqual(result, {
      valid: false, errors: [`claimSet.claims[0].subject.id: local-path: ${kind} path is not portable`],
    }, value);
    const original = JSON.stringify(set);
    const read = readClaimSet(original);
    assert.equal(read.status, 'rejected');
    assert.equal(read.code, 'INPUT_INVALID');
    assert.equal(read.schema, CLAIMS_SCHEMA);
    assert.equal(read.original, original);
    assert.deepEqual(read.errors, result.errors);
    assert.throws(() => projectClaims(set), (error) => error instanceof ReportInputError
      && error.code === 'INPUT_INVALID' && error.message === result.errors[0]);
  }
});

test('the rule covers every shared string field in claims 1.0.0 and 1.1.0', () => {
  for (const schema of CLAIMS_ACCEPTED_VERSIONS) {
    assert.deepEqual(validateClaimSet(portableSet(schema)), { valid: true, errors: [] });
    for (const [pointer, mutate] of PATH_FIELDS) {
      const set = portableSet(schema);
      mutate(set, '/srv/private/evidence.json');
      assert.deepEqual(validateClaimSet(set).errors, [`${pointer}: local-path: posix-absolute path is not portable`], pointer);
    }
  }
  const failed = claim('a', { measure: 'condition:native-use', value: { amount: 'failed', unit: 'outcome' } });
  const recurrence = {
    schema: CLAIMS_SCHEMA_1_1_0,
    claims: [failed],
    calculations: [{
      id: 'r', method: 'recurrence', version: '1.0.0', subject: { kind: 'machine', id: 'C:/hosts/one' },
      condition: 'condition:native-use', observations: [ref('a')],
    }],
  };
  assert.deepEqual(validateClaimSet(recurrence).errors,
    ['claimSet.calculations[0].subject.id: local-path: windows-drive path is not portable']);
  recurrence.calculations[0].subject.id = 'host-1';
  assert.equal(validateClaimSet(recurrence).valid, true);
});

test('digests, instants and enumerated values are format-checked, not path-checked', () => {
  const set = portableSet();
  set.claims[0].sources[0].sha256 = 'b'.repeat(64);
  set.claims[0].capturedAt = '2026-10-14T10:00:00+00:00';
  assert.deepEqual(validateClaimSet(set), { valid: true, errors: [] });
});

test('repository-relative paths, package names and non-file URLs stay portable', () => {
  for (const value of [
    'src/harness/report/claims.mjs', './config/settings.json', '../shared/policy.json', String.raw`docs\reporting\CONTRACT.md`,
    '@aihq/core', 'and/or', 'urn:aihq:report:claims:1.0.0', 'condition:native-use', 'tmp/output.json',
    'https://example.com/docs/report', 'ssh://git@example.com/org/repo.git', 'git+https://example.com/a/b',
    'http://localhost:8080/status', 'score 3/5', 'approximately ~5/10', 'a / b', 'profile:default',
    // `file:` in prose is not a file URL.
    'Config file: settings.json', 'see file:line 3',
    // JSON Pointers and routes are not paths.
    '/policy/selections/0', '/claims/0/subject', 'GET /api/v1/users', 'at /exports/./report', 'pointer: /a~1b/0',
    // Recorded as undetected forms in docs/reporting/CONTRACT.md.
    '//server/share', '$HOME/project', String.raw`%USERPROFILE%\project`,
  ]) {
    const set = portableSet();
    set.claims[0].subject.id = value;
    set.claims[0].coverage.reason = `observed ${value}`;
    set.actions[0].prerequisites = [value];
    assert.deepEqual(validateClaimSet(set), { valid: true, errors: [] }, value);
    assert.equal(readClaimSet(JSON.stringify(set)).status, 'supported', value);
  }
});

test('every absolute home path the snapshot projection masks is refused in a claim set', () => {
  const diagnostic = (detail) => ({
    requestId: 'privacy', helper: { name: '@aihq/core', version: '1.0.0' }, status: 'completed',
    tools: [], observations: [{ id: 'o', target: 't', detail }], checks: [], diagnostics: [], repairChoices: [],
    limits: { budgetMs: 1000, elapsedMs: 0, maxActiveProbes: 1 },
  });
  for (const value of [
    String.raw`c:\users\bob\project`, String.raw`C:\Users\Bob Smith\project`, 'C:/uSeRs/Jane Doe/project',
    String.raw`C:\Documents and Settings\bob`, '/home/alice/project', '/Users/Carol/work', 'Home /home/a differs',
    'src/Users/model.ts', 'https://example.com/home/user/report',
  ]) {
    const report = createReport({
      diagnostic: diagnostic(value), producer: { name: '@aihq/core', version: '1.0.0', revision: null },
      observedAt: '2026-10-14T10:00:00.000Z', acquisition: 'supplied',
    });
    assert.ok(report.observations[0].detail.includes('<homePath>'), value);
    const set = portableSet();
    set.claims[0].coverage.reason = value;
    assert.match(validateClaimSet(set).errors[0],
      /^claimSet\.claims\[0\]\.coverage\.reason: local-path: (?:windows-drive|posix-absolute|home-directory) path is not portable$/, value);
  }
});

test('the refusal is semantic: the claims JSON Schemas are unchanged and still accept the shape', async () => {
  for (const version of ['1.0.0', '1.1.0']) {
    const schema = (await import(`@aihq/core/report/schemas/claims/${version}.json`, { with: { type: 'json' } })).default;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const set = portableSet(`urn:aihq:report:claims:${version}`);
    set.claims[0].subject.id = '/srv/private/evidence.json';
    assert.equal(validate(set), true, JSON.stringify(validate.errors));
    assert.equal(validateClaimSet(set).valid, false);
  }
});
