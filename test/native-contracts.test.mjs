// Focused contract checks for the portable native-verification schemas and validators.
// The installed module and schema files are the artifacts under test; no client runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  validateNativeVerificationRequest, validateNativeVerificationResult, validateNativeVerificationBundle,
} from '../dist/core/native-contracts.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const treeEntries = tree => tree.map(({ root, path, member }) => ({ root, path, sha256: member.sha256, byteLength: member.byteLength }))
  .sort((left, right) => left.root < right.root ? -1 : left.root > right.root ? 1
    : left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
const treeDigest = tree => sha(canonical(treeEntries(tree)));
const member = (path, text) => ({ path, sha256: sha(text), byteLength: Buffer.byteLength(text) });
const REQUEST_ID = 'urn:aihq:core:native-verification-request:1.0.0';
const RESULT_ID = 'urn:aihq:core:native-verification-result:1.0.0';
const BUNDLE_ID = 'urn:aihq:core:native-verification-bundle:1.0.0';
const DEFINITION_ID = 'urn:aihq:harness:native-verification-definition:1.0.0';
const IDENTITY_ID = 'urn:aihq:harness:native-test-identity:1.0.0';

function suppliedBundle() {
  const instruction = member('package/project/INSTRUCTIONS.md', 'Initial project instruction.\n');
  const outputTree = [{ root: 'project', path: 'INSTRUCTIONS.md', member: instruction }];
  return {
    schema: BUNDLE_ID, id: 'catalog.claude.graph.v1', client: 'claude', adapterId: 'claude-stream-json.v1',
    scope: 'test-configuration', package: { name: '@aihq/catalog', version: '1.0.0' },
    release: member('package/release.json', '{}'),
    selection: { itemId: 'graph.item.v1', itemSha256: sha('item'), recipe: member('package/recipe.json', '{}'),
      inputs: { node: 'entry', depth: 2, enabled: true } },
    startingTree: [], startingTreeSha256: treeDigest([]),
    outputTree, outputTreeSha256: treeDigest(outputTree),
    instructions: [{ root: 'project', path: 'INSTRUCTIONS.md', sha256: instruction.sha256,
      evidence: 'marker', markerSha256: sha('marker') }],
    server: { name: 'aihq-graph', transport: 'stdio', runtime: [member('package/server.mjs', '// server\n')],
      evidenceAdapterId: 'aihq.stdio-recorder.v1', observation: 'recorder',
      recorder: member('package/recorder.mjs', '// recorder\n'),
      toolNames: ['aihq_graph_query', 'aihq_attest_instruction'], queryTool: 'aihq_graph_query',
      queryArguments: { node: 'entry' }, challenge: { mode: 'argument', field: 'challenge' },
      expectedResultSha256: sha('result'), expectedAnswer: 'leaf' },
  };
}

function session(index) {
  const stage = (id, outcome, reason, evidence = { kind: 'none' }) =>
    ({ id, session: index, outcome, reason, evidence });
  return { index, process: { pid: 4000 + index, clientSessionId: `session-${index}` },
    launchArgvDigest: sha('argv'), stagedConfigurationDigest: sha('staged'), challengeSha256: sha('challenge'),
    stages: [stage('session-freshness', 'passed', 'observed', { kind: 'match', matched: true }),
      stage('cleanup', 'passed', 'observed')] };
}

function observedResult() {
  return {
    schema: RESULT_ID, package: { name: '@aihq/core', version: '1.0.0-dev.7' },
    status: 'complete', verdict: 'verified', proofScope: 'test-configuration', admission: 'candidate-smoke',
    client: { id: 'claude', observedVersion: '2.1.285' },
    adapter: { id: 'claude-win32-x64-2.1.285', sha256: sha('adapter') },
    platform: { os: 'win32', arch: 'x64', osRelease: '10.0.26200', execution: 'native' },
    content: { bundleId: 'catalog.claude.graph.v1', manifestSha256: sha('manifest'),
      archiveSha256: sha('archive'), outputTreeSha256: sha('output'),
      guardrailsSha256: sha('guardrails'), stagedConfigurationDigest: sha('staged') },
    sessions: [session(1), session(2)],
    stages: [{ id: 'fixture-integrity', session: null, outcome: 'passed', reason: 'observed',
      evidence: { kind: 'digest', sha256: sha('manifest') } },
    { id: 'cleanup', session: null, outcome: 'passed', reason: 'observed', evidence: { kind: 'none' } }],
    security: { sandbox: { level: 'observed-os-boundary', mechanism: 'windows-job.v1', reason: 'observed' },
      hostSecretIsolation: { outcome: 'passed', reason: 'observed' } },
    authority: 'not-evaluated', survivingProcesses: [],
    cleanup: { processes: 'confirmed', files: 'removed', retainedCell: null },
    diagnostics: [], limits: { budgetMs: 180000, elapsedMs: 1200, sessionsStarted: 2, stagesCompleted: 6,
      observedBytes: 0, telemetryEvents: 2, rpcMessages: 4, evidenceTruncated: false },
  };
}

function invalidResult() {
  const result = observedResult();
  return { ...result, status: 'invalid', verdict: 'unverified', proofScope: 'none', adapter: null, content: null,
    sessions: [], stages: [], survivingProcesses: [],
    security: { sandbox: { level: 'not-started', mechanism: null, reason: 'not-started' },
      hostSecretIsolation: { outcome: 'unavailable', reason: 'isolation-unobserved' } },
    cleanup: { processes: 'not-created', files: 'not-created', retainedCell: null },
    limits: { ...result.limits, sessionsStarted: 0, stagesCompleted: 0 } };
}

test('request validation accepts only closed bundled/supplied shapes with stable reasons', () => {
  const bundled = { schema: REQUEST_ID, client: 'claude' };
  assert.equal(validateNativeVerificationRequest(bundled).valid, true);
  assert.equal(validateNativeVerificationRequest({ ...bundled, configuration: { kind: 'bundled', id: 'aihq.native-fixture.v1' } }).valid, true);
  assert.equal(validateNativeVerificationRequest({ ...bundled, configuration: { kind: 'supplied', input: 'catalog',
    bundleId: 'catalog.claude.graph.v1', manifestSha256: sha('x') } }).valid, true);
  for (const value of [{}, { ...bundled, client: 'unknown' }, { ...bundled, command: 'run' },
    { ...bundled, configuration: { kind: 'bundled', id: 'other' } },
    { ...bundled, configuration: { kind: 'supplied', input: 'catalog', bundleId: 'x' } }])
    assert.equal(validateNativeVerificationRequest(value).valid, false, JSON.stringify(value));
  const unknown = validateNativeVerificationRequest({ schema: 'urn:aihq:core:native-verification-request:9.9.9', client: 'claude' });
  assert.equal(unknown.valid, false);
  assert.equal(unknown.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
  assert.equal(unknown.diagnostics[0].reason, 'schema-id');
  const client = validateNativeVerificationRequest({ ...bundled, client: 'unknown' });
  assert.equal(client.diagnostics[0].code, 'INPUT_INVALID');
  assert.equal(client.diagnostics[0].reason, 'client-id');
  assert.equal(validateNativeVerificationRequest({ ...bundled, extra: 1 }).diagnostics[0].reason, 'request-field');
  assert.equal(validateNativeVerificationRequest(bundled).schema, REQUEST_ID);
});

test('request validation refuses accessors, cycles and non-finite numbers without caller code', () => {
  let calls = 0;
  const accessor = Object.defineProperty({ schema: REQUEST_ID }, 'client',
    { enumerable: true, get() { calls += 1; throw new Error('private'); } });
  const cycle = { ...{ schema: REQUEST_ID, client: 'claude' } };
  cycle.configuration = cycle;
  for (const value of [accessor, cycle, { schema: REQUEST_ID, client: 'claude', extra: Number.NaN }]) {
    const result = validateNativeVerificationRequest(value);
    assert.equal(result.valid, false);
    assert.equal(result.diagnostics[0].reason, 'strict-json');
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
  assert.equal(calls, 0);
});

test('bundle validation pins trees, instructions, tagged choices and safe paths', () => {
  const bundle = suppliedBundle();
  const accepted = validateNativeVerificationBundle(bundle);
  assert.equal(accepted.valid, true, JSON.stringify(accepted.diagnostics));
  assert.equal(accepted.schema, BUNDLE_ID);
  assert.equal(validateNativeVerificationBundle({}).valid, false);
  assert.equal(validateNativeVerificationBundle({ schema: 'urn:aihq:core:native-verification-bundle:2.0.0' })
    .diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
  assert.equal(validateNativeVerificationBundle({ ...bundle, startingTreeSha256: sha('wrong') }).valid, false);
  assert.equal(validateNativeVerificationBundle({ ...bundle, outputTreeSha256: sha('wrong') }).valid, false);
  assert.equal(validateNativeVerificationBundle({ ...bundle,
    instructions: [{ ...bundle.instructions[0], sha256: sha('other') }] }).valid, false);
  const nativeInstruction = { root: 'project', path: 'INSTRUCTIONS.md', sha256: bundle.instructions[0].sha256, evidence: 'native' };
  assert.equal(validateNativeVerificationBundle({ ...bundle, instructions: [nativeInstruction] }).valid, true);
  assert.equal(validateNativeVerificationBundle({ ...bundle,
    instructions: [{ ...nativeInstruction, markerSha256: sha('m') }] }).valid, false);
  assert.equal(validateNativeVerificationBundle({ ...bundle,
    instructions: [{ ...nativeInstruction, evidence: 'marker' }] }).valid, false);
  assert.equal(validateNativeVerificationBundle({ ...bundle,
    server: { ...bundle.server, observation: 'native' } }).valid, false);
  const { recorder, ...withoutRecorder } = bundle.server;
  assert.equal(validateNativeVerificationBundle({ ...bundle, server: withoutRecorder }).valid, false);
  assert.equal(validateNativeVerificationBundle({ ...bundle,
    server: { ...bundle.server, queryTool: 'aihq_other' } }).valid, false);
  assert.equal(validateNativeVerificationBundle({ ...bundle,
    release: { ...bundle.release, path: 'package/../escape' } }).valid, false);
  const unsafeTree = [{ root: 'home', path: '../escape', member: member('package/x', 'x') }];
  assert.equal(validateNativeVerificationBundle({ ...bundle,
    startingTree: unsafeTree, startingTreeSha256: treeDigest(unsafeTree) }).valid, false);
});

test('bundle validation rejects duplicated or overlapping output paths', () => {
  const bundle = suppliedBundle();
  const parent = { root: 'project', path: 'config', member: member('package/config/a', 'a') };
  const child = { root: 'project', path: 'config/child', member: member('package/config/b', 'b') };
  const outputTree = [...bundle.outputTree, parent, child];
  assert.equal(validateNativeVerificationBundle({ ...bundle, outputTree,
    outputTreeSha256: treeDigest(outputTree) }).valid, false);
});

test('result validation is bounded and consistent with aggregation', () => {
  const result = observedResult();
  const accepted = validateNativeVerificationResult(result);
  assert.equal(accepted.valid, true, JSON.stringify(accepted.diagnostics));
  assert.equal(accepted.schema, RESULT_ID);
  assert.equal(validateNativeVerificationResult({}).valid, false);
  assert.equal(validateNativeVerificationResult({ schema: 'urn:aihq:core:native-verification-result:2.0.0' })
    .diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
  assert.equal(validateNativeVerificationResult(invalidResult()).valid, true);
  assert.equal(validateNativeVerificationResult({ ...invalidResult(), proofScope: 'test-configuration' }).valid, false);
  assert.equal(validateNativeVerificationResult({ ...invalidResult(), stages: [result.stages[0]] }).valid, false);
  assert.equal(validateNativeVerificationResult({ ...result,
    limits: { ...result.limits, budgetMs: 999 } }).valid, false);
  assert.equal(validateNativeVerificationResult({ ...result,
    cleanup: { processes: 'unresolved', files: 'retained', retainedCell: `aih-native-${'a'.repeat(32)}` } }).valid, false);
  assert.equal(validateNativeVerificationResult({ ...result,
    stages: [{ ...result.stages[0], evidence: { kind: 'digest' } }] }).valid, false);
  assert.equal(validateNativeVerificationResult({ ...result,
    stages: [{ ...result.stages[0], reason: 'not-a-contract-token' }] }).valid, false);
  assert.equal(validateNativeVerificationResult({ ...result,
    sessions: [session(1), { ...session(2), stages: [{ id: 'isolation', session: 2, outcome: 'unavailable',
      reason: 'isolation-unobserved', evidence: { kind: 'none' } }] }] }).valid, false);
});

test('the five published schema files compile standalone and mirror the validators', () => {
  const schemas = [
    [REQUEST_ID, '../dist/core/schemas/native-verification-request/1.0.0.json'],
    [RESULT_ID, '../dist/core/schemas/native-verification-result/1.0.0.json'],
    [BUNDLE_ID, '../dist/core/schemas/native-verification-bundle/1.0.0.json'],
    [DEFINITION_ID, '../dist/harness/schemas/native-verification-definition/1.0.0.json'],
    [IDENTITY_ID, '../dist/harness/schemas/native-test-identity/1.0.0.json'],
  ];
  const ajv = new Ajv2020({ strict: true });
  for (const [id, relative] of schemas) {
    const schema = JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
    assert.equal(schema.$id, id, relative);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', relative);
    ajv.addSchema(schema);
  }
  const request = { schema: REQUEST_ID, client: 'claude' };
  assert.equal(ajv.validate(REQUEST_ID, request), true, JSON.stringify(ajv.errors));
  assert.equal(ajv.validate(REQUEST_ID, { ...request, command: 'untrusted' }), false);
  assert.equal(ajv.validate(BUNDLE_ID, suppliedBundle()), true, JSON.stringify(ajv.errors));
  assert.equal(ajv.validate(RESULT_ID, observedResult()), true, JSON.stringify(ajv.errors));
  assert.equal(validateNativeVerificationBundle(suppliedBundle()).valid, true);
  assert.equal(validateNativeVerificationResult(observedResult()).valid, true);
  const identity = { schema: IDENTITY_ID, id: 'dedicated-test', client: 'claude',
    adapterId: 'claude-oauth-otel.v1', purpose: 'dedicated-native-test',
    expected: { accountUuid: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222' },
    credential: { path: 'oauth.json', sha256: 'a'.repeat(64), byteLength: 100 } };
  assert.equal(ajv.validate(IDENTITY_ID, identity), true, JSON.stringify(ajv.errors));
  assert.equal(ajv.validate(IDENTITY_ID, { ...identity, credential: { ...identity.credential, path: 'arbitrary.json' } }), false);
  assert.equal(ajv.validate(DEFINITION_ID, { schema: DEFINITION_ID }), false);
  const definition = {
    schema: DEFINITION_ID, id: 'claude-win32-x64-2.1.285', client: 'claude', state: 'candidate',
    platform: { os: 'win32', arch: 'x64', execution: 'native', osRelease: '10.0.26200' },
    clientVersions: ['2.1.285'], executableNames: ['claude.exe'],
    runtimeMembers: [member('package/harness/native/fixture/server.mjs', '// server\n')],
    versionArgv: ['--version'], sessionArgv: ['-p', '--verbose', '--output-format', 'stream-json'],
    parserId: 'claude-stream-json.v1', identityAdapterId: 'claude-oauth-otel.v1',
    credentialDestination: { root: 'home', path: '.claude/.credentials.json' },
    guardrails: [{ root: 'home', path: '.claude/settings.json',
      member: member('package/harness/native/fixture/claude-settings.json', '{}') }],
    guardrailsSha256: sha('guardrails'), lifecycleId: 'windows-job.v1',
    isolation: { mechanism: 'none', observerId: null, documentation: [] }, evidenceSha256: null,
  };
  assert.equal(ajv.validate(DEFINITION_ID, definition), true, JSON.stringify(ajv.errors));
  assert.equal(ajv.validate(DEFINITION_ID, { ...definition, state: 'admitted' }), false);
  assert.equal(ajv.validate(DEFINITION_ID, { ...definition,
    sessionArgv: [...definition.sessionArgv, '--bare'] }), false);
  assert.equal(ajv.validate(DEFINITION_ID, { ...definition,
    platform: { ...definition.platform, execution: 'wsl2' } }), false);
});

test('portable contracts import no Node built-in', () => {
  const source = readFileSync(new URL('../dist/core/native-contracts.js', import.meta.url), 'utf8');
  assert.equal(/(?:from|import)\s*\(?\s*["']node:/.test(source), false);
});
