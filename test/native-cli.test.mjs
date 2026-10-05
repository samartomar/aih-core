import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
const requestSchema = 'urn:aihq:core:native-verification-request:1.0.0';
const resultSchema = 'urn:aihq:core:native-verification-result:1.0.0';
function run(args, root) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, HOME: root, USERPROFILE: root }, windowsHide: true, timeout: 20_000 });
}
function invalid(output) {
  assert.equal(output.status, 2, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.schema, resultSchema);
  assert.equal(result.status, 'invalid');
  assert.equal(result.verdict, 'unverified');
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.stages, []);
  assert.equal(result.cleanup.files, 'not-created');
  assert.equal(result.security.sandbox.level, 'not-started');
  return result;
}
test('verify-client help describes explicit bounded native verification', () => {
  const output = run(['verify-client', '--help'], tmpdir());
  assert.equal(output.status, 0);
  assert.match(output.stdout, /aih verify-client <client-id>/);
  assert.match(output.stdout, /--host-bindings/);
  assert.match(output.stdout, /--candidate-smoke/);
});
test('native CLI rejects duplicate, unknown and effect flags with full safe results', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-native-cli-'));
  try {
    for (const flags of [['--json', '--json'], ['--budget-ms=1000', '--budget-ms=1000'],
      ['--apply'], ['--yes'], ['--no-log'], ['--resolutions=anything'], ['--unknown'],
      ['--sandbox-root=relative'], ['--budget-ms=999'], ['--budget-ms=600001'],
      ['--budget-ms=1e3'], ['--budget-ms=-1'], ['--candidate-smoke=false']])
      invalid(run(['verify-client', 'claude', ...flags, ...(flags.includes('--json') ? [] : ['--json'])], root));
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('native CLI parses explicit strict JSON files and never exposes host bindings', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-native-cli-'));
  try {
    const configuration = join(root, 'request.json'), bindings = join(root, 'host.json');
    for (const text of ['{"schema":"' + requestSchema + '","client":"claude","client":"claude"}',
      JSON.stringify({ schema: requestSchema, client: 'codex' }),
      JSON.stringify({ schema: requestSchema, client: 'claude', unexpected: true })]) {
      writeFileSync(configuration, text);
      invalid(run(['verify-client', 'claude', '--configuration', 'request.json', '--json'], root));
    }
    writeFileSync(configuration, Buffer.from([0xff]));
    invalid(run(['verify-client', 'claude', '--configuration', 'request.json', '--json'], root));
    writeFileSync(configuration, JSON.stringify({ schema: requestSchema, client: 'claude' }));
    writeFileSync(bindings, '{"token":"SECRET-MUST-NOT-LEAK"}');
    const output = run(['verify-client', 'claude', '--configuration', 'request.json', '--host-bindings', 'host.json', '--json'], root);
    invalid(output);
    assert.ok(!output.stdout.includes('SECRET-MUST-NOT-LEAK'));
    assert.ok(!output.stdout.includes(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('all selected clients return nonpassing unadmitted outcomes without starting sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-native-cli-'));
  try {
    for (const client of ['claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'opencode', 'kimi', 'kiro', 'antigravity', 'zed']) {
      const output = run(['verify-client', client, '--json'], root);
      assert.equal(output.status, 1, output.stderr);
      const result = JSON.parse(output.stdout);
      assert.equal(result.schema, resultSchema);
      assert.equal(result.client.id, client);
      assert.equal(result.admission, 'admitted');
      assert.equal(result.verdict, 'unverified');
      assert.equal(result.limits.sessionsStarted, 0);
      assert.deepEqual(result.sessions, []);
      assert.equal(result.authority, 'not-evaluated');
    }
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
