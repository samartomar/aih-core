// The `aih` router (contract 22): the contract's commands only, version and help without state, and `validate` for the
// 0.1.0 kinds. Each command module has its own journey tests (install, change, list, remove, update, repair, export-ca,
// inspect, check-files, verify-client, report).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemas } from '../dist/core/contracts.js';

const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const COMMANDS = ['install', 'change', 'list', 'remove', 'update', 'repair', 'export-ca', 'inspect', 'check-files', 'verify-client', 'report', 'validate'];
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'aih-cli-')), home = join(root, 'home');
  mkdirSync(home);
  const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home, NODE_TEST_CONTEXT: undefined }, ...options });
  return { root, home, run, dispose: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }) };
}

test('--version prints the installed package identity, as text or JSON, and refuses other input', () => {
  const s = sandbox();
  try {
    assert.deepEqual([s.run(['--version']).stdout, s.run(['-V']).stdout], [`@aihq/core ${version}\n`, `@aihq/core ${version}\n`]);
    assert.deepEqual(JSON.parse(s.run(['--version', '--json']).stdout), { name: '@aihq/core', version });
    assert.equal(s.run(['--version', 'extra']).status, 2);
    assert.deepEqual(readdirSync(s.home), []);
  } finally { s.dispose(); }
});

test('help lists exactly the contract commands, and a retired command is a usage refusal', () => {
  const s = sandbox();
  try {
    for (const args of [[], ['help'], ['--help'], ['repair', '--help']]) {
      const result = s.run(args);
      assert.equal(result.status, 0, args.join(' '));
      const listed = [...result.stdout.matchAll(/^aih ([a-z-]+)\b/gm)].map(match => match[1]).filter(name => !name.startsWith('-') && name !== 'help');
      assert.deepEqual(listed, COMMANDS);
    }
    const own = s.run(['install', '--help']);
    assert.equal(own.status, 0);
    assert.match(own.stdout, /^aih install <plan-request.json>/);
    for (const retired of ['policy', 'managed', 'verify-macos-session', 'nope']) {
      const result = s.run([retired, '--json']);
      assert.equal(result.status, 2, retired);
      assert.deepEqual(JSON.parse(result.stdout), { status: 'refused', code: 'usage', reason: `\`${retired}\` is not an aih command.` });
    }
    assert.deepEqual(readdirSync(s.home), []);
  } finally { s.dispose(); }
});

test('validate reads each 0.1.0 kind: ok, invalid or unsupported-version, with exit codes 0 and 2', () => {
  const s = sandbox();
  try {
    const kinds = { change: 'urn:aihq:core:change:0.1.0', 'change-request': 'urn:aihq:core:change-request:0.1.0',
      organization: 'urn:aihq:core:organization:0.1.0', 'plan-request': 'urn:aihq:core:plan-request:0.1.0' };
    for (const [kind, id] of Object.entries(kinds)) {
      const valid = join(s.root, `${kind}.json`), invalid = join(s.root, `${kind}-invalid.json`), older = join(s.root, `${kind}-older.json`);
      writeFileSync(valid, JSON.stringify(schemas[id].fixtures.valid));
      writeFileSync(invalid, JSON.stringify(schemas[id].fixtures.invalid));
      writeFileSync(older, JSON.stringify({ ...schemas[id].fixtures.valid, schema: id.replace(':0.1.0', ':1.0.0') }));
      const ok = s.run(['validate', kind, valid, '--json']);
      assert.equal(ok.status, 0, kind + ok.stdout);
      assert.equal(JSON.parse(ok.stdout).status, 'ok');
      const bad = s.run(['validate', kind, invalid, '--json']);
      assert.equal(bad.status, 2, kind);
      assert.equal(JSON.parse(bad.stdout).status, 'invalid');
      const unsupported = s.run(['validate', kind, older, '--json']);
      assert.equal(unsupported.status, 2, kind);
      assert.equal(JSON.parse(unsupported.stdout).status, 'unsupported-version', kind);
    }
    for (const args of [['validate', 'execution-policy', join(s.root, 'change.json')], ['validate', 'change'], ['validate', 'change', join(s.root, 'missing.json')]]) {
      const result = s.run([...args, '--json']);
      assert.equal(result.status, 2, args.join(' '));
      assert.equal(JSON.parse(result.stdout).status, 'refused');
    }
    assert.deepEqual(readdirSync(s.home), []);
  } finally { s.dispose(); }
});
