import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { policy } from './fixture.mjs';

const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));

test('managed CLI exposes bounded list and dedicated help without touching custody', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-managed-cli-'));
  const home = join(root, 'home'); const project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  const run = args => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: home, USERPROFILE: home }
  });
  try {
    const help = run(['help', 'managed', 'list']);
    assert.equal(help.status, 0, help.stdout + help.stderr);
    assert.match(help.stdout, /aih managed list/);
    for (const args of [['managed', '--help'], ['managed', 'help'], ['help', 'managed'],
      ['managed', 'list', '--help'], ['managed', 'remove', '--help'], ['help', 'managed', 'remove']]) {
      const shown = run(args);
      assert.equal(shown.status, 0, `${args.join(' ')}: ${shown.stdout}${shown.stderr}`);
      assert.match(shown.stdout, /aih managed/);
      assert.match(shown.stdout, /Examples:/);
    }
    const jsonHelp = run(['managed', 'help', '--json']);
    assert.equal(jsonHelp.status, 0, jsonHelp.stdout + jsonHelp.stderr);
    assert.match(jsonHelp.stdout, /aih managed/);
    const extraHelpFlag = run(['managed', 'help', '--help']);
    assert.equal(extraHelpFlag.status, 2, extraHelpFlag.stdout + extraHelpFlag.stderr);
    for (const args of [['bogus', '--help'], ['--help', '--project', project]]) {
      const shown = run(args);
      assert.equal(shown.status, 0, `${args.join(' ')}: ${shown.stdout}${shown.stderr}`);
      assert.match(shown.stdout, /aih inspect/);
    }
    for (const args of [['managed', 'help', '--scope', 'user'], ['managed', 'help', '--help'], ['managed', 'list', '--help', '--mode', 'vibe'],
      ['policy', '--help', '--scope', 'user']]) {
      const denied = run([...args, '--json']);
      assert.equal(denied.status, 2, `${args.join(' ')}: ${denied.stdout}${denied.stderr}`);
      assert.equal(JSON.parse(denied.stdout).diagnostics[0].reason, 'cli-options');
    }
    const listed = run(['managed', 'list', '--project', project, '--json']);
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    const result = JSON.parse(listed.stdout);
    assert.equal(result.schema, 'urn:aihq:core:managed-inventory-result:1.0.0');
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.selections, []);
    const budget = run(['managed', 'list', '--project', project, '--budget-ms', '1e2', '--json']);
    assert.equal(budget.status, 2, budget.stdout + budget.stderr);
    assert.equal(JSON.parse(budget.stdout).diagnostics[0].reason, 'budget-ms');
    const unrelated = run(['managed', 'list', '--mode', 'vibe', '--json']);
    assert.equal(unrelated.status, 2, unrelated.stdout + unrelated.stderr);
    assert.equal(JSON.parse(unrelated.stdout).diagnostics[0].reason, 'cli-options');
    const oldCommand = run(['policy', 'none.json', '--scope', 'user', '--json']);
    assert.equal(oldCommand.status, 2, oldCommand.stdout + oldCommand.stderr);
    assert.equal(JSON.parse(oldCommand.stdout).diagnostics[0].reason, 'cli-options');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('managed removal CLI reports an unresolved home as unavailable with exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-managed-missing-home-'));
  const project = join(root, 'project'); mkdirSync(project);
  const missingHome = join(root, 'missing-home');
  try {
    const result = spawnSync(process.execPath, [cli, 'managed', 'remove', 'team-guidance', '--scope', 'project',
      '--mode', 'vibe', '--project', project, '--json'], {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: missingHome, USERPROFILE: missingHome }
    });
    expectRemoval(result, 'unavailable', 1, ['ownership-unverifiable']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('managed removal CLI previews a handle-free review and applies only with approval', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-managed-remove-cli-'));
  const home = join(root, 'home'); const project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(policy()));
  const run = args => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: home, USERPROFILE: home }
  });
  const remove = ['managed', 'remove', 'team-guidance', '--scope', 'project', '--mode', 'vibe',
    '--project', project, '--json'];
  try {
    const installed = run(['policy', file, '--project', project, '--apply', '--yes', '--json']);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const preview = run(remove);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    const wrapper = JSON.parse(preview.stdout);
    assert.equal(wrapper.disposition, 'prepared');
    assert.equal(wrapper.preparation.review.schema, 'urn:aihq:core:prepared-work:1.1.0');
    assert.equal(Object.hasOwn(wrapper.preparation, 'prepared'), false);
    assert.deepEqual(wrapper.preparation.resolutionInputs, []);
    const withoutApproval = run([...remove, '--apply']);
    assert.equal(withoutApproval.status, 2, withoutApproval.stdout + withoutApproval.stderr);
    assert.equal(JSON.parse(withoutApproval.stdout).diagnostics[0].code, 'APPROVAL_REQUIRED');
    const applied = run([...remove, '--apply', '--yes']);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.equal(JSON.parse(applied.stdout).completion, 'complete');
    assert.equal(existsSync(join(project, 'TEAM.md')), false);
    const absent = run(remove);
    assert.equal(absent.status, 0, absent.stdout + absent.stderr);
    assert.equal(JSON.parse(absent.stdout).disposition, 'absent');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const readSchema = path => JSON.parse(readFileSync(fileURLToPath(new URL(`../dist/core/schemas/${path}`, import.meta.url)), 'utf8'));
const ajv = new Ajv2020({ strict: true });
for (const id of ['prepared-work/1.1.0', 'run-result/1.1.0']) ajv.addSchema(readSchema(`${id}.json`));
const validateInventory = ajv.compile(readSchema('managed-inventory-result/1.0.0.json'));
const validateRemoval = ajv.compile(readSchema('managed-removal-preparation/1.0.0.json'));
const sha = value => createHash('sha256').update(value).digest('hex');

/** A disposable home and project with the standard selection (or a supplied policy) installed through the CLI. */
function world(document = policy()) {
  const root = mkdtempSync(join(tmpdir(), 'aih-managed-matrix-'));
  const home = join(root, 'home'); const project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  const run = args => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 40_000, env: { ...process.env, HOME: home, USERPROFILE: home } });
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(document));
  const installed = run(['policy', file, '--project', project, '--apply', '--yes', '--json']);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const receipt = join(home, '.aih', 'core', 'ownership', `${sha(realpathSync.native(project))}.json`);
  const rewrite = change => { const value = JSON.parse(readFileSync(receipt, 'utf8')); change(value); writeFileSync(receipt, JSON.stringify(value)); };
  const remove = (id, extra = []) => run(['managed', 'remove', id, '--scope', 'project', '--mode', 'vibe', '--project', project, '--json', ...extra]);
  return { root, home, project, run, receipt, rewrite, remove, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
const parse = result => { assert.ok(result.stdout.trim(), `no JSON on stdout: ${result.stderr}`); return JSON.parse(result.stdout); };
function expectRemoval(result, disposition, status, reasons) {
  const wrapper = parse(result);
  assert.equal(result.status, status, result.stdout + result.stderr);
  assert.equal(wrapper.disposition, disposition);
  assert.equal(validateRemoval(wrapper), true, JSON.stringify(validateRemoval.errors));
  assert.equal(Object.hasOwn(wrapper.preparation ?? {}, 'prepared'), false, 'no serialized live handle');
  assert.equal(result.stdout.includes('"prepared":'), false);
  if (reasons) assert.deepEqual(wrapper.diagnostics.map(item => item.reason), reasons);
  return wrapper;
}

test('managed CLI cancellation exits 130 with schema-valid wrappers', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-managed-cancel-'));
  const home = join(root, 'home'); const project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  const preload = new URL('./fixtures/signal-on-register.mjs', import.meta.url).href;
  const run = args => spawnSync(process.execPath, ['--import', preload, cli, ...args], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: home, USERPROFILE: home }
  });
  try {
    const listed = run(['managed', 'list', '--project', project, '--scope', 'both', '--json']);
    assert.equal(listed.status, 130, listed.stdout + listed.stderr);
    const inventory = parse(listed);
    assert.equal(inventory.status, 'cancelled');
    assert.equal(validateInventory(inventory), true, JSON.stringify(validateInventory.errors));
    const removed = run(['managed', 'remove', 'team-guidance', '--project', project,
      '--scope', 'project', '--mode', 'vibe', '--json']);
    expectRemoval(removed, 'cancelled', 130, ['cancelled']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('managed list JSON validates against its schema with the complete, incomplete and invalid exit codes', () => {
  const w = world();
  try {
    const listed = w.run(['managed', 'list', '--project', w.project, '--scope', 'project', '--json']);
    const result = parse(listed);
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    assert.equal(validateInventory(result), true, JSON.stringify(validateInventory.errors));
    assert.deepEqual(result.selections, [{ managementId: 'team-guidance', scope: 'project', custody: 'claim', memberCount: 1, sharedMemberCount: 0 }]);
    for (const args of [['--scope', 'sideways'], ['--budget-ms', '0'], ['--budget-ms', '120001'], ['--budget-ms', '1.5'], ['--budget-ms', 'abc'], ['--budget-ms=-5'], ['--budget-ms', '-5']]) {
      const bad = w.run(['managed', 'list', '--project', w.project, ...args, '--json']);
      const body = parse(bad);
      assert.equal(bad.status, 2, `${args.join(' ')}: ${bad.stdout}${bad.stderr}`);
      assert.equal(body.status, 'invalid');
      assert.equal(validateInventory(body), true, JSON.stringify(validateInventory.errors));
      assert.equal(body.diagnostics[0].reason, args[0] === '--scope' ? 'request-shape' : 'budget-ms', args.join(' '));
    }
    writeFileSync(w.receipt, '{ not json');
    const broken = w.run(['managed', 'list', '--project', w.project, '--json']);
    const body = parse(broken);
    assert.equal(broken.status, 1, broken.stdout + broken.stderr);
    assert.equal(body.status, 'incomplete');
    assert.equal(body.diagnostics[0].reason, 'ownership-unverifiable');
    assert.equal(validateInventory(body), true, JSON.stringify(validateInventory.errors));
  } finally { w.dispose(); }
});

test('managed remove JSON follows the disposition and exit matrix and never serializes a handle', () => {
  const w = world();
  try {
    expectRemoval(w.remove('nothing-here'), 'absent', 0, []);
    const noScope = w.run(['managed', 'remove', 'team-guidance', '--mode', 'vibe', '--project', w.project, '--json']);
    expectRemoval(noScope, 'invalid', 2, ['request-shape']);
    // Edited content: a prepared wrapper around a blocked inner review exits 1, and --apply stays a no-op.
    writeFileSync(join(w.project, 'TEAM.md'), 'Edited by hand.\n');
    const blocked = expectRemoval(w.remove('team-guidance'), 'prepared', 1);
    assert.equal(blocked.preparation.status, 'blocked');
    expectRemoval(w.remove('team-guidance', ['--apply', '--yes']), 'prepared', 1);
    assert.equal(readFileSync(join(w.project, 'TEAM.md'), 'utf8'), 'Edited by hand.\n');
    const original = readFileSync(w.receipt);
    w.rewrite(value => { delete value.selections; for (const member of Object.values(value.members)) { delete member.claims; delete member.descriptor; } });
    expectRemoval(w.remove('team-guidance'), 'reconcile-required', 1, ['legacy-reconcile']);
    writeFileSync(w.receipt, '{ not json');
    expectRemoval(w.remove('team-guidance'), 'unavailable', 1, ['ownership-unverifiable']);
    writeFileSync(w.receipt, original);
    writeFileSync(join(w.project, 'TEAM.md'), "Read the project's contribution guide.\n");
    const ready = expectRemoval(w.remove('team-guidance'), 'prepared', 0);
    assert.equal(ready.preparation.status, 'ready');
    const applied = w.remove('team-guidance', ['--apply', '--yes']);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.equal(parse(applied).completion, 'complete');
  } finally { w.dispose(); }
});

test('managed remove reports a retained dependency (1) and an Enterprise metadata-only refusal (2) without Apply', () => {
  const base = policy().selections[0];
  const named = (id, file, extra = {}) => {
    const copy = structuredClone(base); copy.id = id; copy.managementId = id; Object.assign(copy, extra);
    copy.recipe.inline.operations[0].target.segments = [{ literal: file }]; return copy;
  };
  const document = policy(); document.selections = [named('base-item', 'BASE.md'), named('top-item', 'TOP.md', { requires: ['base-item'] })];
  const w = world(document);
  try {
    expectRemoval(w.remove('base-item', ['--apply', '--yes']), 'retained', 1, ['dependency-retained']);
    assert.equal(existsSync(join(w.project, 'BASE.md')), true);
    // A zero-member claim: Vibe may prepare it; Enterprise is denied before any organization source is read.
    w.rewrite(value => {
      value.members = {};
      const anchor = realpathSync.native(w.project);
      value.selections = { [`project:${sha(process.platform === 'win32' ? anchor.toLowerCase() : anchor)}:solo`]:
        { managementId: 'solo', scope: 'project', sets: [], requires: [] } };
    });
    expectRemoval(w.remove('solo'), 'prepared', 0);
    const enterprise = w.run(['managed', 'remove', 'solo', '--scope', 'project', '--mode', 'enterprise', '--project', w.project,
      '--org-repository', 'Example-Org/Org-Policy', '--org-path', 'policy/org.json', '--org-ref', `commit:${'a'.repeat(40)}`, '--apply', '--yes', '--json']);
    const wrapper = expectRemoval(enterprise, 'unavailable', 2, ['metadata-only-removal']);
    assert.equal(wrapper.diagnostics[0].code, 'AUTHORITY_DENIED');
  } finally { w.dispose(); }
});

test('managed subcommands reject unrelated flags with cli-options and unknown flags with cli-input', () => {
  const w = world();
  try {
    const reason = args => {
      const result = w.run([...args, '--json']);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
      return parse(result).diagnostics[0].reason;
    };
    const remove = (...extra) => ['managed', 'remove', 'team-guidance', '--scope', 'project', '--mode', 'vibe', ...extra];
    for (const extra of [['--apply'], ['--yes'], ['--allow-partial'], ['--no-log'], ['--mode', 'vibe'], ['--org-repository', 'o/r'],
      ['--org-path', 'p'], ['--org-ref', 'branch:main'], ['--org-token-env', 'X']])
      assert.equal(reason(['managed', 'list', ...extra]), 'cli-options', `list ${extra[0]}`);
    for (const extra of [['--budget-ms', '5'], ['--private-input', 'a.b=X'], ['--material-root', 'a=/x'], ['--resolutions', 'r.json'],
      ['--inputs-file', 'i.json'], ['--target', 'npm'], ['--offline'], ['--probe-configured-mcp'], ['--support-markdown', 's.md'], ['--evidence']])
      assert.equal(reason(remove(...extra)), 'cli-options', `remove ${extra[0]}`);
    // Organization flags need Enterprise mode; --yes and --allow-partial need --apply.
    assert.equal(reason(remove('--org-repository', 'o/r')), 'cli-options');
    assert.equal(reason(remove('--yes')), 'cli-options');
    assert.equal(reason(remove('--allow-partial')), 'cli-options');
    assert.equal(reason(['managed', 'remove', '--scope', 'project', '--mode', 'vibe']), 'cli-options', 'the management ID positional is required');
    assert.equal(reason(['managed', 'list', '--bogus']), 'cli-input');
    assert.equal(reason(remove('--bogus')), 'cli-input');
    for (const args of [['help', 'managed', '--scope', 'user'], ['help', 'managed', 'list', '--mode', 'vibe'], ['managed', '--help', '--scope', 'user'],
      ['managed', 'remove', '--help', '--mode', 'vibe'], ['help', 'policy', '--scope', 'user'], ['policy', '--help', '--scope', 'user'],
      ['inspect', '--mode', 'vibe'], ['--version', '--scope', 'user'], ['policy', 'p.json', '--scope', 'user']])
      assert.equal(reason(args), 'cli-options', args.join(' '));
  } finally { w.dispose(); }
});
