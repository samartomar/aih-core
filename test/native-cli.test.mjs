import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolRegistry } from '../dist/harness/contracts.mjs';

const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
const requestSchema = 'urn:aihq:core:native-verification-request:0.1.0';
const resultSchema = 'urn:aihq:core:native-verification-result:0.1.0';
function run(args, root) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, HOME: root, USERPROFILE: root }, windowsHide: true, timeout: 20_000 });
}
function invalid(output) {
  assert.equal(output.status, 2, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.schema, resultSchema);
  assert.equal(result.status, 'invalid');
  assert.equal(result.completion, null);
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
  assert.match(output.stdout, /aih verify-client <tool>/);
  assert.match(output.stdout, /--host-bindings/);
  assert.match(output.stdout, /--candidate-smoke/);
  assert.match(output.stdout, /--max-turns/);
  assert.match(output.stdout, /--max-estimated-cost-usd/);
});
test('native CLI rejects duplicate, unknown and effect flags with full safe results', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-native-cli-'));
  try {
    for (const flags of [['--json', '--json'], ['--budget-ms=1000', '--budget-ms=1000'],
      ['--apply'], ['--yes'], ['--no-log'], ['--resolutions=anything'], ['--unknown'],
      ['--sandbox-root=relative'], ['--budget-ms=999'], ['--budget-ms=600001'],
      ['--budget-ms=1e3'], ['--budget-ms=-1'], ['--candidate-smoke=false'],
      ['--max-turns=2'], ['--max-estimated-cost-usd=1'], ['--max-turns=1','--max-estimated-cost-usd=1'],
      ['--max-turns=2','--max-estimated-cost-usd=0'], ['--max-turns=2','--max-estimated-cost-usd=NaN'],
      ['--max-turns=2','--max-estimated-cost-usd=-1'], ['--max-turns=2','--max-turns=2','--max-estimated-cost-usd=1']])
      invalid(run(['verify-client', 'claude-code', ...flags, ...(flags.includes('--json') ? [] : ['--json'])], root));
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('native CLI parses explicit strict JSON files and never exposes host bindings', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-native-cli-'));
  try {
    const configuration = join(root, 'request.json'), bindings = join(root, 'host.json');
    for (const text of ['{"schema":"' + requestSchema + '","client":"claude-code","client":"claude-code"}',
      JSON.stringify({ schema: requestSchema, client: 'codex' }),
      JSON.stringify({ schema: requestSchema, client: 'claude', unexpected: true }),
      JSON.stringify({ schema: requestSchema, client: 'claude-code', unexpected: true })]) {
      writeFileSync(configuration, text);
      invalid(run(['verify-client', 'claude-code', '--configuration', 'request.json', '--json'], root));
    }
    writeFileSync(configuration, Buffer.from([0xff]));
    invalid(run(['verify-client', 'claude-code', '--configuration', 'request.json', '--json'], root));
    writeFileSync(configuration, JSON.stringify({ schema: requestSchema, client: 'claude-code' }));
    writeFileSync(bindings, '{"token":"SECRET-MUST-NOT-LEAK"}');
    const output = run(['verify-client', 'claude-code', '--configuration', 'request.json', '--host-bindings', 'host.json', '--json'], root);
    invalid(output);
    assert.ok(!output.stdout.includes('SECRET-MUST-NOT-LEAK'));
    assert.ok(!output.stdout.includes(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('every registry tool returns its real refusal without starting sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-native-cli-'));
  try {
    for (const tool of toolRegistry.tools) for (const name of [tool.id, ...tool.aliases]) {
      const output = run(['verify-client', name, '--json'], root);
      assert.equal(output.status, 2, output.stderr);
      const result = JSON.parse(output.stdout);
      assert.equal(result.schema, resultSchema);
      assert.equal(result.status, 'refused');
      assert.equal(result.client.id, tool.id);
      // Only claude-code has definitions; which refusal it gets depends on this host's cell.
      if (tool.id === 'claude-code') assert.ok(['platform-unsupported', 'cell-not-admitted'].includes(result.code), result.code);
      else assert.equal(result.code, 'client-unsupported');
      assert.equal(result.admission, 'admitted');
      assert.equal(result.verdict, 'unverified');
      assert.equal(result.limits.sessionsStarted, 0);
      assert.deepEqual(result.sessions, []);
      assert.equal(result.authority, 'not-evaluated');
    }
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
