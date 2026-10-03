import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { policy } from './fixture.mjs';
import fileStateSchema from '../dist/core/schemas/file-state-result/1.0.0.json' with { type: 'json' };

const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateResult = ajv.compile(fileStateSchema);

function snapshot(dir) {
  const entries = [];
  const walk = (current, prefix) => {
    const names = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1);
    for (const entry of names) {
      const full = join(current, entry.name); const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) entries.push([rel, 'link']);
      else if (stat.isDirectory()) { entries.push([rel, 'dir']); walk(full, rel); }
      else entries.push([rel, 'file', sha256(readFileSync(full))]);
    }
  };
  walk(dir, '');
  return entries;
}

function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, 'home'); mkdirSync(home);
  const project = join(root, 'project'); mkdirSync(project);
  const run = (args, env = {}, argv = [cli]) => spawnSync(process.execPath, [...argv, ...args], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: home, USERPROFILE: home, ...env } });
  const check = (args, env) => run(['check-files', ...args], env);
  return { root, home, project, run, check, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('check-files maps match, changed and absent to exit codes with the exact result object', () => {
  const { root, home, project, check, close } = fixture('aih-check-files-');
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(policy()));
  const beforeProject = snapshot(project); const beforeHome = snapshot(home);
  try {
    const absent = check([file, '--project', project, '--json']);
    assert.equal(absent.status, 1, absent.stdout + absent.stderr);
    const absentResult = JSON.parse(absent.stdout);
    assert.equal(validateResult(absentResult), true, JSON.stringify(validateResult.errors));
    assert.equal(absentResult.targets[0].outcome, 'absent');
    writeFileSync(join(project, 'TEAM.md'), "Read the project's contribution guide.\n");
    const match = check([file, '--project', project, '--json']);
    assert.equal(match.status, 0, match.stdout + match.stderr);
    const matchResult = JSON.parse(match.stdout);
    assert.equal(validateResult(matchResult), true, JSON.stringify(validateResult.errors));
    assert.equal(matchResult.status, 'complete');
    assert.equal(matchResult.fileState, 'match');
    assert.equal(matchResult.authority, 'not-evaluated');
    assert.deepEqual(Object.keys(matchResult), ['schema', 'package', 'status', 'fileState', 'authority',
      'targets', 'checks', 'notChecked', 'coverage', 'diagnostics', 'limits']);
    writeFileSync(join(project, 'TEAM.md'), 'edited');
    const changed = check([file, '--project', project, '--json']);
    assert.equal(changed.status, 1, changed.stdout + changed.stderr);
    assert.equal(JSON.parse(changed.stdout).fileState, 'changed');
    const pretty = check([file, '--project', project]);
    assert.equal(pretty.status, 1);
    assert.equal(JSON.parse(pretty.stdout).fileState, 'changed', 'default output is the same object, pretty-printed');
    // No writes, no state, no history: only the deliberate test edits remain.
    assert.deepEqual(snapshot(home), beforeHome);
    assert.equal(existsSync(join(home, '.aih')), false);
  } finally { close(); }
});

test('check-files rejects apply, authority, logging and unrelated options', () => {
  const { root, project, check, close } = fixture('aih-check-files-refuse-');
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(policy()));
  try {
    const cases = [
      [file, '--apply'], [file, '--yes'], [file, '--allow-partial'], [file, '--resolutions', file],
      [file, '--evidence'], [file, '--no-log'], [file, '--offline'], [file, '--inputs-file', file],
      [file, '--probe-configured-mcp'], [file, '--target', 'node'],
      [file, '--org-repository', 'o/r', '--org-path', 'p', '--org-ref', 'commit:abc'],
      [file, '--org-token-env', 'HOME'], [file, '--budget-ms', 'abc'], [file, '--budget-ms', ''],
      [file, '--budget-ms', '0'], [file, '--budget-ms', '60001'], [file, 'extra']
    ];
    for (const args of cases) {
      const result = check([...args, '--project', project]);
      assert.equal(result.status, 2, args.join(' '));
      const body = JSON.parse(result.stdout);
      assert.equal(body.diagnostics[0].code, 'INPUT_INVALID', args.join(' '));
    }
    const missing = check([join(root, 'missing.json')]);
    assert.equal(missing.status, 2);
    assert.equal(JSON.parse(missing.stdout).diagnostics[0].reason, 'cli-input');
  } finally { close(); }
});

test('check-files reports malformed and unsupported policies as invalid results', () => {
  const { root, project, check, close } = fixture('aih-check-files-invalid-');
  const file = join(root, 'policy.json');
  try {
    writeFileSync(file, '{bad');
    const malformed = check([file, '--project', project, '--json']);
    assert.equal(malformed.status, 2, malformed.stdout + malformed.stderr);
    const body = JSON.parse(malformed.stdout);
    assert.equal(validateResult(body), true, JSON.stringify(validateResult.errors));
    assert.equal(body.status, 'invalid');
    assert.equal(body.diagnostics[0].code, 'INPUT_INVALID');
    assert.equal(body.diagnostics[0].reason, 'strict-json');
    const unsupported = policy(); unsupported.schema = 'urn:aihq:core:execution-policy:99.0.0';
    writeFileSync(file, JSON.stringify(unsupported));
    const rejected = check([file, '--project', project, '--json']);
    assert.equal(rejected.status, 2);
    const unsupportedBody = JSON.parse(rejected.stdout);
    assert.equal(unsupportedBody.status, 'invalid');
    assert.equal(unsupportedBody.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
    assert.equal(unsupportedBody.diagnostics[0].encountered, 'urn:aihq:core:execution-policy:99.0.0');
    assert.equal(existsSync(join(project, 'TEAM.md')), false);
  } finally { close(); }
});

test('check-files binds only named environment private inputs and never prints their values', () => {
  const { root, project, check, close } = fixture('aih-check-files-private-');
  const document = policy(); const selection = document.selections[0];
  selection.id = 'team.guidance'; selection.configuration = {};
  selection.recipe.inline.inputs = { 'text.content': { type: 'string', required: true, sensitive: true } };
  selection.recipe.inline.operations[0].content = { input: 'text.content' };
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(document));
  const secret = 'fixture-cli-private-content';
  try {
    const missing = check([file, '--project', project, '--json']);
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.equal(JSON.parse(missing.stdout).targets[0].reason, 'input-unavailable');
    const matched = check([file, '--project', project, '--json',
      '--private-input', 'team%2Eguidance.text%2Econtent=AIHQ_TEST_CHECK_PRIVATE'],
      { AIHQ_TEST_CHECK_PRIVATE: secret, AIHQ_TEST_OTHER: 'not-read' });
    assert.equal(matched.status, 1, matched.stdout + matched.stderr);
    const result = JSON.parse(matched.stdout);
    assert.equal(result.targets[0].outcome, 'absent', 'the content resolved but the file is absent');
    assert.equal((matched.stdout + matched.stderr).includes(secret), false);
    assert.equal((matched.stdout + matched.stderr).includes(sha256(Buffer.from(secret))), false);
    const unset = check([file, '--project', project, '--private-input', 'team%2Eguidance.text%2Econtent=AIHQ_TEST_UNSET']);
    assert.equal(unset.status, 2);
  } finally { close(); }
});

test('check-files admits an explicitly mapped local material root', () => {
  const { root, project, check, close } = fixture('aih-check-files-material-');
  const source = join(root, 'source'); mkdirSync(source);
  const content = Buffer.from('referenced content\n');
  writeFileSync(join(project, 'TEAM.md'), content);
  const document = policy(); const selection = document.selections[0];
  const recipe = selection.recipe.inline;
  delete recipe.operations[0].content;
  recipe.operations[0].material = 'payload';
  recipe.materials = [{ id: 'payload', path: 'payload.txt', sha256: sha256(content), byteLength: content.length,
    source: { kind: 'local', input: 'selected' } }];
  writeFileSync(join(source, 'payload.txt'), content);
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(document));
  try {
    const unbound = check([file, '--project', project, '--json']);
    assert.equal(unbound.status, 1);
    assert.equal(JSON.parse(unbound.stdout).targets[0].reason, 'material-unavailable');
    const bound = check([file, '--project', project, '--json', '--material-root', `selected=${source}`]);
    assert.equal(bound.status, 0, bound.stdout + bound.stderr);
    assert.equal(JSON.parse(bound.stdout).fileState, 'match');
    const wrong = check([file, '--project', project, '--json', '--material-root', `selected=${join(root, 'missing')}`]);
    assert.equal(wrong.status, 1);
    assert.equal(JSON.parse(wrong.stdout).targets[0].reason, 'material-unavailable');
  } finally { close(); }
});

test('check-files performs no writes, child processes or network under a read-only permission model', () => {
  const { root, home, project, run, close } = fixture('aih-check-files-permission-');
  writeFileSync(join(project, 'TEAM.md'), "Read the project's contribution guide.\n");
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
    `dns.lookup = function (...args) { mark('dns.lookup'); return lookup.apply(this, args); };`,
    `const realFetch = globalThis.fetch;`,
    `globalThis.fetch = (...args) => { mark('fetch'); return realFetch(...args); };`
  ].join('\n'));
  const guarded = args => run(args, { AIH_TEST_NET_MARKER: marker },
    ['--permission', '--allow-fs-read=*', '--import', pathToFileURL(preload).href, cli]);
  try {
    const match = guarded(['check-files', file, '--project', project, '--json']);
    assert.equal(match.status, 0, `read-only permission model: ${match.stdout}${match.stderr}`);
    assert.equal(JSON.parse(match.stdout).fileState, 'match');
    assert.equal(existsSync(join(home, '.aih')), false);
    // An archive reference is unavailable without any fetch; Prepare is the positive control.
    const document = policy();
    document.selections[0].recipe = { reference: { source: { kind: 'archive',
      url: 'https://example.invalid/recipe.tar.gz', sha256: '2'.repeat(64), byteLength: 256 },
      path: 'recipe.json', sha256: '3'.repeat(64), byteLength: 512, materials: [] } };
    writeFileSync(file, JSON.stringify(document));
    const archived = guarded(['check-files', file, '--project', project, '--json']);
    assert.equal(archived.status, 1, archived.stdout + archived.stderr);
    const body = JSON.parse(archived.stdout);
    assert.deepEqual(body.notChecked, [{ kind: 'recipe', id: 'guidance', reason: 'remote-material-not-admitted' }]);
    assert.equal(existsSync(marker) ? readFileSync(marker, 'utf8') : '', '', 'check-files attempted no network');
    const control = run(['policy', file, '--project', project, '--no-log', '--json'], { AIH_TEST_NET_MARKER: marker },
      ['--import', pathToFileURL(preload).href, cli]);
    assert.equal(control.status, 1, control.stdout + control.stderr);
    assert.match(readFileSync(marker, 'utf8'), /fetch/, 'positive control: Prepare attempted the archive fetch');
  } finally { close(); }
});

test('check-files help is discoverable and budget-bounded', () => {
  const { root, project, run, check, close } = fixture('aih-check-files-help-');
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(policy()));
  try {
    for (const args of [['help', 'check-files'], ['check-files', '--help']]) {
      const help = run(args);
      assert.equal(help.status, 0, help.stdout + help.stderr);
      const lines = help.stdout.split('\n').filter(line => line.trimStart().startsWith('aih check-files'));
      assert.ok(lines.length >= 2, `usage plus example:\n${help.stdout}`);
    }
    const bounded = check([file, '--project', project, '--budget-ms', '60000', '--json']);
    assert.equal(bounded.status, 1, bounded.stdout + bounded.stderr);
    assert.equal(JSON.parse(bounded.stdout).limits.budgetMs, 60000);
  } finally { close(); }
});
