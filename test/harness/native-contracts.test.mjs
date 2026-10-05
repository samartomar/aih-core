import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nativeClientIds, nativeBounds, nativeStageReasons, nativeVerificationDefinitions,
  validateNativeVerificationDefinition, validateNativeTestIdentity, bundledNativeFixtures
} from '../../src/harness/native/contracts.mjs';

const sha = char => char.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));
const claude = () => clone(nativeVerificationDefinitions.find(d => d.client === 'claude'));

test('portable metadata validators reject accessors and cyclic input without calling caller code', () => {
  let calls = 0;
  const definition = claude();
  const hostile = Object.defineProperty(definition, 'schema', { enumerable: true, get() { calls++; throw new Error('private'); } });
  assert.equal(validateNativeVerificationDefinition(hostile).valid, false);
  const hidden = claude();
  Object.defineProperty(hidden, 'unknown', { value: true });
  assert.equal(validateNativeVerificationDefinition(hidden).valid, false);
  const cycle = {}; cycle.self = cycle;
  for (const validate of [validateNativeVerificationDefinition, validateNativeTestIdentity]) {
    assert.equal(validate(cycle).valid, false);
  }
  assert.equal(calls, 0);
});

test('the eleven roster ids are preserved in order', () => {
  assert.deepEqual([...nativeClientIds], ['claude', 'codex', 'cursor', 'gemini', 'copilot',
    'windsurf', 'opencode', 'kimi', 'kiro', 'antigravity', 'zed']);
});

test('bounds match the contract', () => {
  assert.equal(nativeBounds.defaultBudgetMs, 180000);
  assert.equal(nativeBounds.minBudgetMs, 1000);
  assert.equal(nativeBounds.maxBudgetMs, 600000);
  assert.equal(nativeBounds.cleanupAllowanceMs, 10000);
  assert.equal(nativeBounds.collectorRequestBytes, 262144);
  assert.equal(nativeBounds.childOutputBytes, 2097152);
  assert.equal(nativeBounds.recorderMessages, 512);
});

test('stable reason table carries every contract token', () => {
  for (const reason of ['fixture-bytes-mismatch', 'material-path-unsafe', 'client-absent', 'version-unreadable',
    'client-unsupported', 'version-unsupported', 'platform-unsupported', 'cell-not-admitted',
    'transport-unsupported', 'configuration-channel-unsupported', 'authentication-channel-unsupported',
    'authentication-unavailable', 'identity-binding-invalid', 'session-launch-failed', 'executable-changed',
    'session-identity-unobservable', 'session-not-fresh', 'loading-mode-unobservable', 'configuration-not-loaded',
    'managed-restriction', 'guardrail-path-conflict', 'restriction-unobservable', 'identity-session-mismatch',
    'identity-conflict', 'tools-not-discovered', 'server-evidence-unavailable', 'instructions-not-loaded',
    'instruction-attestation-unobservable', 'instruction-attestation-mismatch', 'instruction-source-ambiguous',
    'query-challenge-mismatch', 'query-answer-mismatch', 'configuration-changed', 'isolation-unobserved',
    'isolation-violated', 'observed', 'cancelled', 'budget-exhausted', 'limit-exceeded', 'native-internal',
    'not-run-after-failure', 'not-run-after-restriction', 'not-run-after-unavailable',
    'termination-unresolved', 'cleanup-unresolved'])
    assert.ok(nativeStageReasons.includes(reason), reason);
});

test('the Claude candidate is exact, unadmitted and evidence-free', () => {
  const definition = claude();
  assert.equal(definition.state, 'candidate');
  assert.equal(definition.evidenceSha256, null);
  assert.deepEqual(definition.clientVersions, ['2.1.285']);
  assert.deepEqual(definition.sessionArgv, ['-p', '--verbose', '--output-format', 'stream-json']);
  assert.equal(definition.isolation.mechanism, 'none');
  assert.equal(validateNativeVerificationDefinition(definition).valid, true);
  assert.equal(nativeVerificationDefinitions.filter(d => d.state === 'admitted').length, 0);
});

test('definition validation rejects loose or unsafe descriptors', () => {
  const cases = {
    wildcard: d => { d.clientVersions = ['2.1.*']; },
    range: d => { d.clientVersions = ['^2.1.285']; },
    empty: d => { d.clientVersions = []; },
    unknownKey: d => { d.extra = 1; },
    admittedWithoutEvidence: d => { d.state = 'admitted'; },
    candidateWithEvidence: d => { d.evidenceSha256 = sha('a'); },
    bare: d => { d.sessionArgv = [...d.sessionArgv, '--bare']; },
    resume: d => { d.sessionArgv = [...d.sessionArgv, '--resume']; },
    mcpConfig: d => { d.sessionArgv = [...d.sessionArgv, '--mcp-config=x.json']; },
    settings: d => { d.sessionArgv = [...d.sessionArgv, '--settings', 'x.json']; },
    sessionId: d => { d.sessionArgv = [...d.sessionArgv, '--session-id', 'x']; },
    wslOnWindows: d => { d.platform.execution = 'wsl2'; },
    jobOnLinux: d => { d.platform.os = 'linux'; },
    groupOnWindows: d => { d.lifecycleId = 'posix-group.v1'; },
    noneWithObserver: d => { d.isolation = { mechanism: 'none', observerId: 'o', documentation: [] }; },
    nativeWithoutObserver: d => { d.isolation = { mechanism: 'client-native', observerId: null, documentation: ['https://example.com/x'] }; },
    nativeHttpDoc: d => { d.isolation = { mechanism: 'client-native', observerId: 'o', documentation: ['http://example.com/x'] }; },
    otherIdentity: d => { d.identityAdapterId = 'other.v1'; },
    guardrailHash: d => { d.guardrailsSha256 = sha('0'); },
    argvTooLong: d => { d.sessionArgv = Array.from({ length: 33 }, () => 'x'); },
    credentialTraversal: d => { d.credentialDestination.path = '../x'; },
    memberPath: d => { d.runtimeMembers[0].path = 'dist/x'; }
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const definition = claude();
    mutate(definition);
    assert.equal(validateNativeVerificationDefinition(definition).valid, false, name);
  }
  assert.equal(validateNativeVerificationDefinition('x').valid, false);
});

test('test identity validation accepts the closed manifest only', () => {
  const manifest = {
    schema: 'urn:aihq:harness:native-test-identity:1.0.0', id: 'dedicated-smoke', client: 'claude',
    adapterId: 'claude-oauth-otel.v1', purpose: 'dedicated-native-test',
    expected: { accountUuid: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222' },
    credential: { path: 'oauth.json', sha256: sha('d'), byteLength: 256 }
  };
  assert.equal(validateNativeTestIdentity(manifest).valid, true);
  const bad = {
    extra: m => { m.extra = 1; },
    client: m => { m.client = 'codex'; },
    purpose: m => { m.purpose = 'normal-login'; },
    upperUuid: m => { m.expected.accountUuid = 'AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; },
    credentialPath: m => { m.credential.path = '.credentials.json'; },
    size: m => { m.credential.byteLength = 65537; },
    zero: m => { m.credential.byteLength = 0; },
    hash: m => { m.credential.sha256 = 'abc'; }
  };
  for (const [name, mutate] of Object.entries(bad)) {
    const copy = clone(manifest);
    mutate(copy);
    assert.equal(validateNativeTestIdentity(copy).valid, false, name);
  }
});

test('the bundled fixture is Claude-only with exactly two tools', () => {
  assert.deepEqual(bundledNativeFixtures.map(f => f.client), ['claude']);
  const fixture = bundledNativeFixtures[0];
  assert.equal(fixture.id, 'aihq.native-fixture.v1');
  assert.deepEqual(fixture.server.toolNames, ['aihq_attest_instruction', 'aihq_graph_query']);
  assert.equal(fixture.server.queryTool, 'aihq_graph_query');
  assert.equal(fixture.server.observation, 'native');
  assert.deepEqual(fixture.instructions.map(i => i.evidence), ['marker']);
});
