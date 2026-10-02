import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePolicy, parseOrganizationPolicy, validateRecipe } from '../dist/core/contracts.js';
import { policy } from './fixture.mjs';
import { orgDocument } from './fixtures/github-org.mjs';

const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const tree = directory => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory()
    ? tree(join(directory, entry.name)).map(name => join(entry.name, name))
    : [entry.name]).sort();

function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, 'home'); mkdirSync(home);
  const spawn = (argv, env = {}) => spawnSync(process.execPath, argv, {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: home, USERPROFILE: home, ...env } });
  const run = (args, env = {}) => spawn([cli, ...args], env);
  return { root, home, spawn, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('CLI --version prints the installed package identity and refuses other input', () => {
  const { run, close } = fixture('aih-cli-version-');
  try {
    for (const flag of ['--version', '-V']) {
      const result = run([flag]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout, `@aihq/core ${version}\n`);
    }
    const structured = run(['--version', '--json']);
    assert.equal(structured.status, 0, structured.stdout + structured.stderr);
    assert.deepEqual(JSON.parse(structured.stdout), { name: '@aihq/core', version });
    const refused = run(['--version', 'inspect']);
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.equal(JSON.parse(refused.stdout).diagnostics[0].code, 'INPUT_INVALID');
  } finally { close(); }
});

test('CLI help lists every command and each command has usage with examples', () => {
  const { run, close } = fixture('aih-cli-help-');
  try {
    for (const args of [['--help'], ['-h'], ['help']]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      for (const command of ['inspect', 'policy', 'repair', 'validate'])
        assert.match(result.stdout, new RegExp(`\\b${command}\\b`), args.join(' '));
      assert.match(result.stdout, /--version/);
      assert.match(result.stdout, /--no-log/);
    }
    for (const [args, command] of [[['help', 'validate'], 'validate'], [['policy', '--help'], 'policy'], [['repair', '-h'], 'repair']]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const lines = result.stdout.split('\n').filter(line => line.trimStart().startsWith(`aih ${command}`));
      assert.ok(lines.length >= 2, `${args.join(' ')} must show the command's usage plus an example line:\n${result.stdout}`);
    }
    const refused = run(['help', 'nope']);
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.equal(JSON.parse(refused.stdout).diagnostics[0].code, 'INPUT_INVALID');
  } finally { close(); }
});

test('CLI validate reports each kind through the public validators', () => {
  const { root, run, close } = fixture('aih-cli-validate-');
  const kinds = [
    { kind: 'execution-policy', schema: 'urn:aihq:core:execution-policy:1.0.0',
      valid: policy(), invalid: { schema: 'urn:aihq:core:execution-policy:1.0.0' },
      diagnostics: text => parsePolicy(text).diagnostics },
    { kind: 'organization-policy', schema: 'urn:aihq:core:organization-policy:1.0.0',
      valid: orgDocument(), invalid: { schema: 'urn:aihq:core:organization-policy:1.0.0' },
      diagnostics: text => parseOrganizationPolicy(text).diagnostics },
    { kind: 'recipe', schema: 'urn:aihq:core:recipe:1.0.0',
      valid: policy().selections[0].recipe.inline, invalid: { schema: 'urn:aihq:core:recipe:1.0.0' },
      diagnostics: text => validateRecipe(JSON.parse(text)).diagnostics }
  ];
  try {
    for (const { kind, schema, valid, invalid, diagnostics } of kinds) {
      const file = join(root, `${kind}.json`);
      writeFileSync(file, JSON.stringify(valid));
      const accepted = run(['validate', kind, file]);
      assert.equal(accepted.status, 0, `${kind}: ${accepted.stdout}${accepted.stderr}`);
      assert.deepEqual(JSON.parse(accepted.stdout), { status: 'valid', kind, schema, diagnostics: [] });
      const invalidText = JSON.stringify(invalid);
      const expected = diagnostics(invalidText);
      assert.ok(expected.length > 0, `${kind} fixture must be invalid`);
      writeFileSync(file, invalidText);
      const rejected = run(['validate', kind, file]);
      assert.equal(rejected.status, 2, `${kind}: ${rejected.stdout}${rejected.stderr}`);
      const body = JSON.parse(rejected.stdout);
      assert.equal(body.status, 'invalid');
      assert.equal(body.kind, kind);
      assert.deepEqual(body.diagnostics, JSON.parse(JSON.stringify(expected)));
      writeFileSync(file, '{bad');
      const malformed = run(['validate', kind, file]);
      assert.equal(malformed.status, 2, `${kind}: ${malformed.stdout}${malformed.stderr}`);
      const failure = JSON.parse(malformed.stdout);
      assert.equal(failure.status, 'invalid');
      assert.equal(failure.diagnostics[0].code, 'INPUT_INVALID');
      assert.equal(failure.diagnostics[0].reason, 'strict-json');
    }
  } finally { close(); }
});

test('CLI validate refuses unknown kinds, missing files and unrelated options', () => {
  const { root, run, close } = fixture('aih-cli-validate-refusal-');
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(policy()));
  try {
    const cases = [
      ['validate', 'nope', file],
      ['validate', 'execution-policy', join(root, 'missing.json')],
      ['validate', 'execution-policy', file, 'extra'],
      ['validate', 'execution-policy', file, '--project', 'x'],
      ['validate', 'execution-policy', file, '--apply'],
      ['validate', 'execution-policy', file, '--no-log'],
      ['validate', 'execution-policy', file, '--offline']
    ];
    for (const args of cases) {
      const result = run(args);
      assert.equal(result.status, 2, args.join(' '));
      assert.equal(JSON.parse(result.stdout).diagnostics[0].code, 'INPUT_INVALID', args.join(' '));
    }
  } finally { close(); }
});

test('CLI version, help and validate leave no state and attempt no network', () => {
  const { root, home, spawn, close } = fixture('aih-cli-discovery-pure-');
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(policy()));
  const marker = join(root, 'network-attempts.log');
  const preload = join(root, 'no-network.mjs');
  writeFileSync(preload, [
    `import net from 'node:net';`,
    `import dns from 'node:dns';`,
    `import { appendFileSync } from 'node:fs';`,
    `const mark = label => appendFileSync(process.env.AIH_TEST_NET_MARKER, label + '\\n');`,
    `const connect = net.Socket.prototype.connect;`,
    `net.Socket.prototype.connect = function (...args) { mark('net.Socket.connect'); return connect.apply(this, args); };`,
    `const lookup = dns.lookup;`,
    `dns.lookup = function (...args) { mark('dns.lookup'); return lookup.apply(this, args); };`
  ].join('\n'));
  const pure = args => spawn(['--import', pathToFileURL(preload).href, cli, ...args], { AIH_TEST_NET_MARKER: marker });
  try {
    const organization = join(root, 'organization.json'); writeFileSync(organization, JSON.stringify(orgDocument()));
    const recipe = join(root, 'recipe.json'); writeFileSync(recipe, JSON.stringify(policy().selections[0].recipe.inline));
    const before = tree(root);
    for (const args of [['--version'], ['-V', '--json'], ['--help'], ['help', 'policy'], ['repair', '-h'],
      ['validate', 'execution-policy', file], ['validate', 'organization-policy', organization], ['validate', 'recipe', recipe]]) {
      const result = pure(args);
      assert.equal(result.status, 0, args.join(' ') + result.stdout + result.stderr);
    }
    assert.equal(existsSync(join(home, '.aih')), false);
    assert.equal(existsSync(marker) ? readFileSync(marker, 'utf8') : '', '');
    assert.deepEqual(tree(root), before);
  } finally { close(); }
});

test('CLI --no-log disables run history but preserves ownership and recovery records', () => {
  const { root, home, spawn, run, close } = fixture('aih-cli-no-log-');
  const project = join(root, 'project'); mkdirSync(project);
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(policy()));
  const state = name => { const path = join(home, '.aih', 'core', name); return existsSync(path) ? readdirSync(path) : []; };
  try {
    const applied = run(['policy', file, '--project', project, '--apply', '--yes', '--no-log', '--json']);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.completion, 'complete');
    assert.deepEqual(result.record, { status: 'disabled', reason: 'logging-off' });
    assert.equal(result.effectiveOptions.logging.value, 'off');
    assert.deepEqual(state('runs'), []);
    assert.ok(state('ownership').length > 0, 'ownership records remain');
    assert.ok(state('recovery').length > 0, 'recovery records remain');
    const loggedHome = join(root, 'logged-home'); mkdirSync(loggedHome);
    const loggedProject = join(root, 'logged-project'); mkdirSync(loggedProject);
    const logged = spawn([cli, 'policy', file, '--project', loggedProject, '--apply', '--yes', '--json'],
      { HOME: loggedHome, USERPROFILE: loggedHome });
    assert.equal(logged.status, 0, logged.stdout + logged.stderr);
    assert.ok(readdirSync(join(loggedHome, '.aih', 'core', 'runs')).some(name => name.endsWith('.json')));
    const preview = run(['policy', file, '--project', project, '--no-log']);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.deepEqual(state('runs'), []);
    for (const args of [['inspect', '--no-log'], ['validate', 'execution-policy', file, '--no-log']]) {
      const refused = run(args);
      assert.equal(refused.status, 2, args.join(' '));
      assert.equal(JSON.parse(refused.stdout).diagnostics[0].code, 'INPUT_INVALID');
    }
  } finally { close(); }
});

test('CLI repair --no-log disables run history for Prepare and Apply', () => {
  const { root, home, run, close } = fixture('aih-cli-repair-no-log-');
  const source = join(root, 'root.pem'); writeFileSync(source, readFileSync(new URL('./fixtures/root-a.pem', import.meta.url)));
  const inputs = join(root, 'repair-inputs.json'); writeFileSync(inputs, JSON.stringify({ 'node-npm-ca': { caFile: source } }));
  const runs = join(home, '.aih', 'core', 'runs');
  try {
    const args = ['repair', 'node-npm-ca', '--target', 'npm', '--inputs-file', inputs, '--offline', '--no-log', '--json'];
    const preview = run(args);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.deepEqual(JSON.parse(preview.stdout).record, { status: 'disabled', reason: 'logging-off' });
    const applied = run([...args, '--apply', '--yes']);
    const result = JSON.parse(applied.stdout);
    assert.ok(['complete', 'incomplete'].includes(result.completion), applied.stdout + applied.stderr);
    assert.deepEqual(result.record, { status: 'disabled', reason: 'logging-off' });
    assert.equal(result.effectiveOptions.logging.value, 'off');
    assert.ok(result.operations.some(operation => operation.application === 'applied'), applied.stdout);
    assert.equal(existsSync(runs) ? readdirSync(runs).length : 0, 0);
    for (const name of ['ownership', 'recovery'])
      assert.ok(readdirSync(join(home, '.aih', 'core', name)).length > 0, `${name} records remain`);
  } finally { close(); }
});
