// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the bins only.
// verifyClient and `aih verify-client` with their 0.1.0 formats, the bundled definitions and the Linux observer bin.
// Nothing here launches a client or claims native loading: every check is a refusal or invalid result this host really
// gets, and an admitted host cell (Linux x64 WSL2 with the recorded release) is reported as needing real evidence.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyClient } from '@aihq/core';
import { refusalCodes, schemas, validateFormat } from '@aihq/core/contracts';
import { nativeClientDefinitions, toolRegistry, validateNativeTestIdentity, validateNativeVerificationDefinition } from '@aihq/core/harness';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'aih-verify-client-'));
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };
const installed = join(here, 'node_modules', '@aihq', 'core');
const cli = join(installed, 'dist', 'core', 'cli.js');
const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home;
const aih = args => {
  const child = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  return { code: child.status, result: child.stdout.trim() ? JSON.parse(child.stdout) : undefined, stderr: child.stderr };
};
const REQUEST = 'urn:aihq:core:native-verification-request:0.1.0';
const RESULT = 'urn:aihq:core:native-verification-result:0.1.0';
const host = { os: process.platform, arch: process.arch,
  execution: process.platform === 'linux' && /microsoft/i.test(release()) ? 'wsl2' : 'native', osRelease: release() };
const hostDefinition = nativeClientDefinitions.find(definition => ['os', 'arch', 'execution', 'osRelease'].every(key => definition.platform[key] === host[key]));
const claudeRefusal = !hostDefinition ? 'platform-unsupported' : hostDefinition.state === 'candidate' ? 'cell-not-admitted' : null;
const refused = (result, code) => {
  assert.equal(result.schema, RESULT); assert.equal(result.status, 'refused'); assert.equal(result.code, code);
  assert.equal(result.completion, null); assert.equal(result.verdict, 'unverified'); assert.deepEqual(result.sessions, []);
  assert.equal(result.cleanup.processes, 'not-created'); assert.equal(result.cleanup.files, 'not-created');
  assert.deepEqual(validateFormat(result), { status: 'ok', schema: RESULT });
};

await check('each native format ships one 0.1.0 schema whose fixtures read ok and invalid', () => {
  for (const name of ['native-verification-request', 'native-verification-result', 'native-verification-bundle',
    'native-verification-definition', 'native-test-identity']) {
    const id = `urn:aihq:core:${name}:0.1.0`;
    assert.deepEqual(validateFormat(schemas[id].fixtures.valid), { status: 'ok', schema: id });
    assert.equal(validateFormat(schemas[id].fixtures.invalid).status, 'invalid');
  }
  for (const code of ['tool-unknown', 'client-unsupported', 'platform-unsupported', 'cell-not-admitted'])
    assert.ok(refusalCodes.some(entry => entry.code === code && entry.status === 'refused'), code);
  assert.equal(validateNativeTestIdentity(schemas['urn:aihq:core:native-test-identity:0.1.0'].fixtures.valid).valid, true);
});

await check('the packaged definitions are the two Claude Code 2.1.285 cells, one admitted with its recorded evidence', () => {
  assert.deepEqual(nativeClientDefinitions.map(definition => [definition.id, definition.client, definition.state, definition.clientVersions, definition.evidenceSha256]), [
    ['claude-win32-x64-2.1.285', 'claude-code', 'candidate', ['2.1.285'], null],
    ['claude-linux-x64-wsl2-srt-2.1.285', 'claude-code', 'admitted', ['2.1.285'], 'a8c226d1c56764a6c773268186a79a3643e5a5d0afc2acd9f9708faa9de50947']]);
  for (const definition of nativeClientDefinitions) {
    assert.deepEqual(validateFormat(JSON.parse(JSON.stringify(definition))), { status: 'ok', schema: definition.schema });
    assert.equal(validateNativeVerificationDefinition(definition).valid, true);
  }
  // Admission is not widened by a document: another version of the admitted cell is invalid.
  const widened = { ...JSON.parse(JSON.stringify(nativeClientDefinitions[1])), clientVersions: ['2.1.286'] };
  assert.equal(validateFormat(widened).status, 'invalid');
  assert.equal(validateNativeVerificationDefinition(widened).valid, false);
});

await check('the Linux x64 observer bin ships as the fixed facility, an observer and not a sandbox', () => {
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.bin, { aih: 'dist/core/cli.js', 'aih-linux-facility': 'dist/harness/native/linux/facility' });
  assert.ok(lstatSync(join(installed, manifest.bin['aih-linux-facility'])).isFile());
  const record = JSON.parse(readFileSync(join(installed, 'dist/harness/native/linux/build-record.json'), 'utf8'));
  assert.equal(JSON.stringify(record).includes('sandbox'), false, 'the facility record never names itself a sandbox');
  const admitted = nativeClientDefinitions.find(definition => definition.state === 'admitted');
  assert.deepEqual([admitted.isolation.mechanism, admitted.isolation.observerId], ['vendor-runtime', 'anthropic-srt-linux.v1']);
});

await check('verifyClient refuses unknown tools, tools without a definition and this host cell, launching nothing', async () => {
  refused(await verifyClient({ schema: REQUEST, client: 'no-such-tool' }), 'tool-unknown');
  for (const tool of toolRegistry.tools.filter(entry => entry.id !== 'claude-code'))
    refused(await verifyClient({ schema: REQUEST, client: tool.id }), 'client-unsupported');
  if (claudeRefusal) {
    const result = await verifyClient({ schema: REQUEST, client: 'claude-code' });
    refused(result, claudeRefusal);
    assert.equal(result.client.id, 'claude-code');
  }
  assert.deepEqual(readdirSync(home), []);
});

await check('verifyClient reports an invalid request or control with structured diagnostics', async () => {
  for (const [request, controls] of [[{ schema: REQUEST, client: 'claude-code', extra: 1 }], [{ schema: REQUEST, client: 'claude-code' }, { budgetMs: 1 }],
    [{ schema: 'urn:aihq:core:native-verification-request:1.0.0', client: 'claude' }]]) {
    const result = await verifyClient(request, controls);
    assert.equal(result.status, 'invalid'); assert.equal(result.completion, null); assert.ok(result.diagnostics.length);
    assert.deepEqual(validateFormat(result), { status: 'ok', schema: RESULT });
  }
});

await check('aih verify-client takes a registry id or alias and exits 2 for refusals and invalid input', () => {
  const unknown = aih(['verify-client', 'no-such-tool', '--json']);
  assert.equal(unknown.code, 2); refused(unknown.result, 'tool-unknown');
  if (claudeRefusal) for (const name of ['claude', 'claude-code']) {
    const output = aih(['verify-client', name, '--json']);
    assert.equal(output.code, 2, output.stderr); refused(output.result, claudeRefusal); assert.equal(output.result.client.id, 'claude-code');
  }
  const invalid = aih(['verify-client', 'claude-code', '--max-turns=1', '--json']);
  assert.equal(invalid.code, 2); assert.equal(invalid.result.status, 'invalid');
  assert.equal(existsSync(join(home, '.aih')), false);
});

process.stdout.write(JSON.stringify({ status: 'passed', checks, ...(claudeRefusal ? {} : { claudeCode: 'admitted host cell: needs real evidence, not checked here' }) }) + '\n');
