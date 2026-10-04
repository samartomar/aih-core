// Public-seam tests for the experimental data interface.
// Imports resolve through the packed package self-reference `@aihq/core/report`
// after `node scripts/build.mjs`; no private function is reached directly.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SNAPSHOT_SCHEMA,
  DIAGNOSTIC_CONTRACT,
  createReport,
  validateSnapshot,
  importSnapshot,
  exportSnapshot,
  ReportInputError,
} from '@aihq/core/report';

/** A schema-valid @aihq/core diagnostic result; independent of this package. */
function validDiagnostic(overrides = {}) {
  return {
    requestId: 'req-0001',
    helper: { name: '@aihq/core', version: '1.0.0-dev.3' },
    status: 'completed',
    tools: [{ id: 'claude', label: 'Claude Code', state: 'runnable', selection: 'detected' }],
    observations: [{ id: 'claude/version', target: 'claude', detail: 'Runnable version command observed.' }],
    checks: [
      { id: 'claude/version', target: 'claude', outcome: 'passed', reason: 'version-ok', detail: 'exited 0' },
      { id: 'claude/tls/node/host', target: 'claude', outcome: 'unavailable', reason: 'deadline', detail: '' },
      { id: 'claude/tls/os/host', target: 'claude', outcome: 'skipped', reason: 'network-off', detail: '' },
      { id: 'node/version', target: 'node', outcome: 'failed', reason: 'version-exit', detail: 'exited 1' },
    ],
    diagnostics: [{ code: 'VERIFICATION_FAILED', reason: 'version-exit', message: 'A performed check did not pass.' }],
    repairChoices: [{ target: 'node', kind: 'manual-guidance', reason: 'version-exit', guidance: 'Inspect the installation.' }],
    limits: { budgetMs: 180000, elapsedMs: 42, maxActiveProbes: 2 },
    ...overrides,
  };
}

function validInput(overrides = {}) {
  return {
    diagnostic: validDiagnostic(),
    producer: { name: '@aihq/core', version: '1.0.0-dev.3', revision: '5b70f8e698a4ec1e346b9718ef0067b2c856a1c6' },
    observedAt: '2026-10-03T12:00:00.000Z',
    acquisition: 'supplied',
    ...overrides,
  };
}

test('createReport projects a supplied diagnostic into an experimental snapshot', () => {
  const report = createReport(validInput());

  assert.equal(report.schema, SNAPSHOT_SCHEMA);
  assert.equal(report.compatibility, 'experimental');
  assert.deepEqual(report.producer, {
    name: '@aihq/core',
    version: '1.0.0-dev.3',
    revision: '5b70f8e698a4ec1e346b9718ef0067b2c856a1c6',
    contract: DIAGNOSTIC_CONTRACT,
  });
  assert.deepEqual(report.capture, { observedAt: '2026-10-03T12:00:00.000Z', acquisition: 'supplied' });
  assert.deepEqual(report.evidence, {
    originalSha256: null,
    authentication: 'not-authenticated',
    structuralValidation: 'passed',
    projection: 'redacted',
  });
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.metrics, {
    budgetMs: 180000,
    elapsedMs: 42,
    maxActiveProbes: 2,
    counts: { passed: 1, failed: 1, unavailable: 1, skipped: 1 },
  });
  assert.equal(report.observations.length, 1);
  assert.equal(report.checks.length, 4);
  assert.equal(report.diagnostics.length, 1);
  // Legacy digest/HTML layout and producer bookkeeping never enter the report.
  assert.equal('requestId' in report, false);
  assert.equal('helper' in report, false);
  assert.equal('repairChoices' in report, false);
  assert.equal('html' in report, false);
});

function assertInvalidInput(build) {
  assert.throws(build, (error) => {
    assert.ok(error instanceof ReportInputError, `expected ReportInputError, got ${error?.name}`);
    assert.equal(error.code, 'INPUT_INVALID');
    return true;
  });
}

test('createReport rejects malformed producer diagnostics with INPUT_INVALID', () => {
  assertInvalidInput(() => createReport(validInput({ diagnostic: { ...validDiagnostic(), extra: true } })));
  assertInvalidInput(() => createReport(validInput({
    diagnostic: validDiagnostic({ checks: [{ id: 'a', target: 'a', outcome: 'maybe', reason: 'r', detail: '' }] }),
  })));
  assertInvalidInput(() => createReport(validInput({ acquisition: 'fresh' })));
  assertInvalidInput(() => createReport(validInput({ observedAt: '2026-10-03 12:00:00' })));
  assertInvalidInput(() => createReport(validInput({
    diagnostic: validDiagnostic({ limits: { budgetMs: 180001, elapsedMs: 0, maxActiveProbes: 2 } }),
  })));
});

test('createReport rejects getters, symbol keys and cyclic references', () => {
  const withGetter = validDiagnostic();
  Object.defineProperty(withGetter, 'status', { enumerable: true, get: () => 'completed' });
  assertInvalidInput(() => createReport(validInput({ diagnostic: withGetter })));

  const withSymbol = validDiagnostic();
  withSymbol[Symbol('hidden')] = 'value';
  assertInvalidInput(() => createReport(validInput({ diagnostic: withSymbol })));

  const cyclic = validDiagnostic();
  cyclic.observations[0].self = cyclic;
  assertInvalidInput(() => createReport(validInput({ diagnostic: cyclic })));
});

test('createReport rejects non-finite, oversized and over-deep JSON values', () => {
  assertInvalidInput(() => createReport(validInput({
    diagnostic: validDiagnostic({ limits: { budgetMs: 180000, elapsedMs: Number.POSITIVE_INFINITY, maxActiveProbes: 2 } }),
  })));
  const oversized = validDiagnostic();
  oversized.observations[0].detail = 'x'.repeat(2_000_000);
  assertInvalidInput(() => createReport(validInput({ diagnostic: oversized })));

  const deep = { detail: 'leaf' };
  let cursor = deep;
  for (let index = 0; index < 40; index++) cursor = cursor.next = { detail: 'x' };
  const nested = validDiagnostic();
  nested.observations[0].detail = deep;
  assertInvalidInput(() => createReport(validInput({ diagnostic: nested })));
});

test('createReport errors never echo raw caller values', () => {
  const secret = 'sk-ant-api03-SUPERSECRETVALUE0123456789';
  assert.throws(() => createReport(validInput({ observedAt: secret })), (error) => {
    assert.equal(error.code, 'INPUT_INVALID');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('createReport redacts explicit home paths and secret values without changing states', () => {
  const home = 'C:\\Users\\secret-user';
  const secret = 'hunter2-correct-horse';
  const diagnostic = validDiagnostic();
  diagnostic.tools[0].label = `Claude Code in ${home}`;
  diagnostic.tools[0].config = `${home}/.claude/settings.json`;
  diagnostic.observations[0].detail = `Read ${home}/notes.txt with ${secret}`;
  diagnostic.checks[0].detail = `TOKEN=${secret} under ${home.replace(/\\/g, '/')}`;
  diagnostic.diagnostics[0].message = `guidance for ${secret}`;
  const report = createReport(validInput({
    diagnostic,
    redaction: { homePaths: [home], secretValues: [secret] },
  }));

  const text = JSON.stringify(report);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(home), false);
  assert.equal(text.includes(home.replace(/\\/g, '/')), false);
  assert.ok(report.observations[0].detail.includes('<homePath>'));
  assert.ok(report.tools[0].config.includes('<homePath>'));
  // Meaningful states and outcomes are copied verbatim, never redacted away.
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.tools[0].state, 'runnable');
  assert.deepEqual(report.tools[0].selection, 'detected');
  assert.deepEqual(report.metrics.counts, { passed: 1, failed: 1, unavailable: 1, skipped: 1 });
});

test('createReport applies portable secret patterns and sensitive argument masking', () => {
  const diagnostic = validDiagnostic();
  const bearer = 'Bearer abcDEF1234567890._-token';
  const assignment = 'API_KEY=0123456789abcdef';
  const flag = '--token=0123456789abcdef';
  const providerKey = 'sk-ant-api03-abcdefghijklmnop0123';
  diagnostic.observations[0].detail = `${bearer} ${assignment} ${flag}`;
  diagnostic.checks[0].detail = providerKey;
  const report = createReport(validInput({ diagnostic }));

  const text = JSON.stringify(report);
  assert.equal(text.includes('abcDEF1234567890'), false);
  assert.equal(text.includes('0123456789abcdef'), false);
  assert.equal(text.includes(providerKey), false);
  assert.ok(text.includes('[REDACTED]'));
});

test('createReport leaves the caller input objects untouched', () => {
  const input = validInput({ redaction: { secretValues: ['hunter2-correct-horse'] } });
  input.diagnostic.observations[0].detail = 'value hunter2-correct-horse here';
  const before = structuredClone(input);
  createReport(input);
  assert.deepEqual(input, before);
});

test('validateSnapshot accepts its own output and rejects unknown fields or versions', () => {
  const report = createReport(validInput());
  assert.deepEqual(validateSnapshot(report), { valid: true, errors: [] });

  for (const tampered of [
    { ...report, unexpected: true },
    { ...report, schema: 'urn:aihq:report:snapshot:2.0.0' },
    { ...report, compatibility: 'stable' },
    { ...report, producer: { ...report.producer, contract: 'urn:aihq:harness:diagnostic:2.0.0' } },
    { ...report, metrics: { ...report.metrics, counts: { passed: 9, failed: 0, unavailable: 0, skipped: 0 } } },
  ]) {
    const result = validateSnapshot(tampered);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.every((entry) => typeof entry === 'string' && entry.length > 0));
  }

  const nestedUnknown = structuredClone(report);
  nestedUnknown.tools[0].extra = 'x';
  assert.equal(validateSnapshot(nestedUnknown).valid, false);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(validateSnapshot(cyclic).valid, false);
});

test('importSnapshot rejects malformed JSON and unsupported versions', () => {
  const report = createReport(validInput());
  const json = exportSnapshot(report);
  assert.deepEqual(importSnapshot(json), report);

  assert.throws(() => importSnapshot('{'), (error) => error.code === 'INPUT_INVALID');
  assert.throws(() => importSnapshot('42'), (error) => error.code === 'INPUT_INVALID');
  assert.throws(() => importSnapshot(''), (error) => error.code === 'INPUT_INVALID');
  assert.throws(
    () => importSnapshot(JSON.stringify({ ...report, schema: 'urn:aihq:report:snapshot:9.9.9' })),
    (error) => error.code === 'SCHEMA_UNSUPPORTED',
  );
  assert.throws(
    () => importSnapshot(JSON.stringify({ ...report, producer: { ...report.producer, contract: 'urn:aihq:harness:diagnostic:2.0.0' } })),
    (error) => error.code === 'SCHEMA_UNSUPPORTED',
  );
  assert.throws(
    () => importSnapshot(JSON.stringify({ ...report, extra: 1 })),
    (error) => error.code === 'INPUT_INVALID',
  );
});

test('exportSnapshot is deterministic, re-redacts, and round-trips through lossless JSON', () => {
  const report = createReport(validInput());
  const canonical = exportSnapshot(report);
  assert.equal(exportSnapshot(report), canonical);
  assert.equal(exportSnapshot(importSnapshot(canonical)), canonical);

  // Key order in the incoming document never changes the canonical export.
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(report).reverse()));
  assert.equal(exportSnapshot(importSnapshot(reordered)), canonical);

  const tampered = structuredClone(report);
  tampered.observations[0].detail = 'Bearer abcDEF1234567890.secret';
  const exported = exportSnapshot(tampered);
  assert.equal(exported.includes('abcDEF1234567890'), false);
  assert.equal(JSON.parse(exported).observations[0].detail.includes('[REDACTED]'), true);
});

test('redaction never corrupts JSON syntax for secrets with quotes, backslashes or newlines', () => {
  const nasty = 'pa"ss\\word\nline2';
  const diagnostic = validDiagnostic();
  diagnostic.observations[0].detail = `value ${nasty} end`;
  const report = createReport(validInput({ diagnostic, redaction: { secretValues: [nasty] } }));
  const json = exportSnapshot(report);

  assert.equal(json.includes('pa"ss'), false);
  const parsed = JSON.parse(json);
  assert.equal(parsed.observations[0].detail.includes('pa"ss'), false);
  assert.deepEqual(importSnapshot(json), parsed);
});

test('createReport separates measured zero, supplied evidence identity and structural-only validation', () => {
  const empty = validDiagnostic({ checks: [], observations: [], diagnostics: [], tools: [], repairChoices: [] });
  const report = createReport(validInput({
    diagnostic: empty,
    acquisition: 'newly-acquired',
    originalSha256: 'a'.repeat(64),
  }));

  // Measured zero is a real count, not missing data.
  assert.deepEqual(report.metrics.counts, { passed: 0, failed: 0, unavailable: 0, skipped: 0 });
  assert.equal(report.metrics.budgetMs, 180000);
  // The SHA names the raw evidence bytes the caller hashed; it is not authentication.
  assert.equal(report.evidence.originalSha256, 'a'.repeat(64));
  assert.equal(report.evidence.authentication, 'not-authenticated');
  assert.equal(report.evidence.structuralValidation, 'passed');
  assert.equal(report.capture.acquisition, 'newly-acquired');

  assertInvalidInput(() => createReport(validInput({ originalSha256: 'A'.repeat(64) })));
  assertInvalidInput(() => createReport(validInput({ originalSha256: 'a'.repeat(63) })));
  assertInvalidInput(() => createReport(validInput({ redaction: { unknown: [] } })));
  assertInvalidInput(() => createReport(validInput({ redaction: { homePaths: 'C:/Users/x' } })));
});

test('an unavailable producer revision remains null through JSON and rendering', async () => {
 const report=createReport(validInput({producer:{name:'@aihq/core',version:'1.0.0-dev.3',revision:null}}));
 assert.equal(report.producer.revision,null);
 assert.equal(importSnapshot(exportSnapshot(report)).producer.revision,null);
 const {renderReport}=await import('@aihq/core/report/render');
 const html=renderReport(report);
 assert.match(html,/Producer revision/); assert.match(html,/unavailable/);
 assert.doesNotMatch(html,/\(null\)/);
});


test('public reporting metadata respects advertised schema length limits', () => {
 assert.throws(()=>createReport(validInput({producer:{name:'@aihq/core',version:'1.0.0-dev.3',revision:'r'.repeat(129)}})),{code:'INPUT_INVALID'});
 const snapshot=createReport(validInput()); snapshot.producer.version='v'.repeat(129);
 assert.equal(validateSnapshot(snapshot).valid,false);
});


test('colon credentials and conventional remote homes are redacted through imported snapshots', async () => {
 const snapshot=createReport(validInput());
 snapshot.observations[0].detail='API_KEY: credential-fixture-one password: credential-fixture-two TOKEN: short /home/alice/project C:/Users/Bob/work /Users/Carol/work';
 const report=importSnapshot(JSON.stringify(snapshot));
 const json=exportSnapshot(report);
 for(const value of ['credential-fixture-one','credential-fixture-two','short','alice','Bob','Carol']) assert.ok(!json.includes(value),value);
 const {renderReport}=await import('@aihq/core/report/render'); const html=renderReport(report);
 assert.ok(!html.includes('credential-fixture-one')); assert.ok(!html.includes('alice'));
 assert.equal(report.evidence.authentication,'not-authenticated');
});
test('import applies explicit privacy context to nonstandard supplied home paths',()=>{
 const snapshot=createReport(validInput()); snapshot.observations[0].detail='/custom/private-root/project custom-secret-fixture';
 const report=importSnapshot(JSON.stringify(snapshot),{homePaths:['/custom/private-root'],secretValues:['custom-secret-fixture']});
 assert.equal(report.observations[0].detail,'<homePath>/project [REDACTED]');
});
test('ambiguous duplicate JSON keys are refused including escaped equivalent keys',()=>{
 const json=exportSnapshot(createReport(validInput()));
 for(const replacement of ['"status":"invalid","status":"completed"','"stat\\u0075s":"invalid","status":"completed"'])
  assert.throws(()=>importSnapshot(json.replace('"status":"completed"',replacement)),{code:'INPUT_INVALID'});
});


test('privacy projection also masks producer metadata and refuses expansion beyond schema limits',()=>{
 const input=validInput({producer:{name:'@aihq/core',version:'TOKEN: producer-secret-fixture',revision:'/home/private-user/revision'}});
 input.diagnostic.helper.version=input.producer.version;
 const report=createReport(input);
 assert.ok(!report.producer.version.includes('producer-secret-fixture'));
 assert.ok(!report.producer.revision.includes('private-user'));
 const expanded=validInput({producer:{name:'@aihq/core',version:'v'.repeat(128),revision:null},redaction:{secretValues:['v']}});
 expanded.diagnostic.helper.version=expanded.producer.version;
 assert.throws(()=>createReport(expanded),{code:'INPUT_INVALID'});
});

test('supplied Windows home paths mask case variations and complete spaced usernames', () => {
  const snapshot = createReport(validInput());
  snapshot.observations[0].detail = 'c:\\users\\bob\\project C:\\Users\\Bob Smith\\project C:/uSeRs/Jane Doe/project';
  const report = importSnapshot(JSON.stringify(snapshot));
  assert.equal(report.observations[0].detail, '<homePath>\\project <homePath>\\project <homePath>/project');
  assert.deepEqual(importSnapshot(exportSnapshot(report)), report);
});

test('JSON-style credential keys are masked in supplied diagnostic strings', () => {
  const snapshot = createReport(validInput());
  snapshot.observations[0].detail = 'settings: {"password": "fixture-private-value", "API_KEY": "short"}';
  const json = exportSnapshot(importSnapshot(JSON.stringify(snapshot)));
  assert.ok(!json.includes('fixture-private-value'));
  assert.ok(!json.includes('short'));
});
