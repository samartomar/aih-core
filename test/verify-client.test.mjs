// verifyClient and `aih verify-client` (contract 3, 4, 6, 14.1): the 0.1.0 native verification formats over the
// retained native verification. These checks run on whatever host executes them. They never launch a client session
// and never claim native loading evidence: an admitted host cell needs separately recorded real evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyClient } from '../dist/core/index.js';
import { schemas, validateFormat, refusalCodes } from '../dist/core/contracts.js';
import { nativeClientDefinitions, nativeVerificationDefinitions, validateNativeVerificationDefinition,
  validateNativeTestIdentity } from '../dist/harness/contracts.mjs';

const REQUEST = 'urn:aihq:core:native-verification-request:0.1.0';
const RESULT = 'urn:aihq:core:native-verification-result:0.1.0';
const NATIVE_FORMATS = ['native-verification-request', 'native-verification-result', 'native-verification-bundle',
  'native-verification-definition', 'native-test-identity'].map(name => `urn:aihq:core:${name}:0.1.0`);
const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));

const host = { os: process.platform, arch: process.arch,
  execution: process.platform === 'linux' && /microsoft/i.test(release()) ? 'wsl2' : 'native', osRelease: release() };
const hostDefinition = nativeClientDefinitions.find(definition => ['os', 'arch', 'execution', 'osRelease']
  .every(key => definition.platform[key] === host[key]));
// The refusal this host gets for claude-code without candidate smoke. An admitted host cell goes past refusal and needs a
// real client, identity and evidence, which these checks never fake.
const expectedClaude = !hostDefinition ? 'platform-unsupported' : hostDefinition.state === 'candidate' ? 'cell-not-admitted' : null;

function refused(result, code) {
  assert.equal(result.schema, RESULT);
  assert.equal(result.status, 'refused');
  assert.equal(result.code, code);
  assert.equal(typeof result.reason, 'string');
  assert.equal(result.completion, null);
  assert.equal(result.verdict, 'unverified');
  assert.deepEqual(result.sessions, []);
  assert.equal(result.cleanup.processes, 'not-created');
  assert.equal(result.cleanup.files, 'not-created');
  assert.deepEqual(validateFormat(result), { status: 'ok', schema: RESULT });
}

test('every native format has one 0.1.0 schema with a valid and an invalid fixture', () => {
  for (const id of NATIVE_FORMATS) {
    assert.ok(schemas[id], id);
    assert.deepEqual(validateFormat(schemas[id].fixtures.valid), { status: 'ok', schema: id });
    assert.equal(validateFormat(schemas[id].fixtures.invalid).status, 'invalid', id);
  }
  for (const code of ['client-unsupported', 'platform-unsupported', 'cell-not-admitted', 'tool-unknown'])
    assert.ok(refusalCodes.some(entry => entry.status === 'refused' && entry.code === code), code);
});

test('the bundled definitions are the retained ones under registry id claude-code, admission and evidence unchanged', () => {
  assert.equal(nativeClientDefinitions.length, nativeVerificationDefinitions.length);
  for (const [index, definition] of nativeClientDefinitions.entries()) {
    const retained = nativeVerificationDefinitions[index];
    assert.equal(definition.schema, 'urn:aihq:core:native-verification-definition:0.1.0');
    assert.equal(definition.client, 'claude-code');
    assert.equal(retained.client, 'claude');
    const { schema: _a, client: _b, ...rest } = definition; const { schema: _c, client: _d, ...retainedRest } = retained;
    assert.deepEqual(rest, retainedRest);
    assert.deepEqual(validateFormat(definition), { status: 'ok', schema: definition.schema });
    assert.deepEqual(validateNativeVerificationDefinition(definition).diagnostics, []);
  }
  const admitted = nativeClientDefinitions.filter(definition => definition.state === 'admitted');
  assert.deepEqual(admitted.map(definition => [definition.id, definition.evidenceSha256]),
    [['claude-linux-x64-wsl2-srt-2.1.285', 'a8c226d1c56764a6c773268186a79a3643e5a5d0afc2acd9f9708faa9de50947']]);
  assert.deepEqual(nativeClientDefinitions.filter(definition => definition.state === 'candidate').map(definition => definition.id),
    ['claude-win32-x64-2.1.285']);
  // The schema admits exactly the registered admitted definition: changing anything else about it is invalid.
  const widened = structuredClone(admitted[0]); widened.clientVersions = ['2.1.286'];
  assert.equal(validateFormat(widened).status, 'invalid');
  assert.equal(validateNativeVerificationDefinition(widened).valid, false);
  const promoted = { ...structuredClone(nativeClientDefinitions[0]), state: 'admitted', evidenceSha256: 'e'.repeat(64) };
  assert.equal(validateFormat(promoted).status, 'invalid');
  assert.equal(validateNativeVerificationDefinition(promoted).valid, false);
});

test('a 0.1.0 test identity names claude-code', () => {
  const identity = { schema: 'urn:aihq:core:native-test-identity:0.1.0', id: 'dedicated-test', client: 'claude-code',
    adapterId: 'claude-oauth-otel.v1', purpose: 'dedicated-native-test',
    expected: { accountUuid: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222' },
    credential: { path: 'oauth.json', sha256: 'a'.repeat(64), byteLength: 100 } };
  assert.deepEqual(validateFormat(identity), { status: 'ok', schema: identity.schema });
  assert.deepEqual(validateNativeTestIdentity(identity).diagnostics, []);
  assert.equal(validateNativeTestIdentity({ ...identity, client: 'claude' }).valid, false);
});

test('verifyClient refuses unknown tools and tools without a native definition, before any effect', async () => {
  refused(await verifyClient({ schema: REQUEST, client: 'not-a-tool' }), 'tool-unknown');
  // Documents carry registry ids; the old `claude` id is an alias for selection by name only.
  refused(await verifyClient({ schema: REQUEST, client: 'claude' }), 'tool-unknown');
  for (const client of ['codex', 'cursor', 'cursor-ide', 'dsh', 'gemini', 'zed']) {
    const result = await verifyClient({ schema: REQUEST, client });
    refused(result, 'client-unsupported');
    assert.equal(result.client.id, client);
  }
});

test('verifyClient reports this host\'s real status for claude-code without launching anything', async t => {
  if (!expectedClaude) return t.skip('This host is an admitted cell; its check needs a real client, identity and evidence.');
  const result = await verifyClient({ schema: REQUEST, client: 'claude-code' });
  refused(result, expectedClaude);
  assert.equal(result.client.id, 'claude-code');
  assert.equal(result.admission, 'admitted');
  assert.equal(result.platform.os, ['win32', 'linux', 'darwin'].includes(process.platform) ? process.platform : 'unsupported');
  assert.equal(result.stages.find(stage => stage.outcome !== 'passed').reason, expectedClaude);
});

test('verifyClient reports invalid requests with structured diagnostics', async () => {
  for (const request of [{ schema: REQUEST }, { schema: REQUEST, client: 'claude-code', extra: true },
    { schema: 'urn:aihq:core:native-verification-request:1.0.0', client: 'claude' }, 'not an object',
    { schema: REQUEST, client: 'claude-code', maxTurns: 1, maxEstimatedCostUsd: 1 }]) {
    const result = await verifyClient(request);
    assert.equal(result.schema, RESULT);
    assert.equal(result.status, 'invalid');
    assert.equal(result.completion, null);
    assert.ok(result.diagnostics.length >= 1);
    assert.deepEqual(result.stages, []);
    assert.deepEqual(validateFormat(result), { status: 'ok', schema: RESULT });
  }
  const controls = await verifyClient({ schema: REQUEST, client: 'claude-code' }, { budgetMs: 1 });
  assert.equal(controls.status, 'invalid');
});

function run(args, root) {
  return spawnSync(process.execPath, [cli, 'verify-client', ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, HOME: root, USERPROFILE: root }, windowsHide: true, timeout: 60_000 });
}
test('aih verify-client selects by id or alias and exits per 14.1', t => {
  const root = mkdtempSync(join(tmpdir(), 'aih-verify-client-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unknown = run(['not-a-tool', '--json'], root);
  assert.equal(unknown.status, 2, unknown.stderr);
  refused(JSON.parse(unknown.stdout), 'tool-unknown');
  const codex = run(['codex', '--json'], root);
  assert.equal(codex.status, 2);
  refused(JSON.parse(codex.stdout), 'client-unsupported');
  if (expectedClaude) for (const name of ['claude', 'claude-code']) {
    const output = run([name, '--json'], root);
    assert.equal(output.status, 2, output.stderr);
    const result = JSON.parse(output.stdout);
    refused(result, expectedClaude);
    assert.equal(result.client.id, 'claude-code');
  }
  const invalid = run(['claude-code', '--budget-ms=1', '--json'], root);
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).status, 'invalid');
  const configuration = join(root, 'request.json');
  writeFileSync(configuration, JSON.stringify({ schema: REQUEST, client: 'codex' }));
  const mismatch = run(['claude-code', '--configuration', configuration, '--json'], root);
  assert.equal(mismatch.status, 2);
  assert.equal(JSON.parse(mismatch.stdout).status, 'invalid');
  const human = run(['codex'], root);
  assert.equal(human.status, 2);
  assert.match(human.stdout, /refused/);
  assert.deepEqual(readdirSync(root).sort(), ['request.json']);
});
