import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { policy } from './fixture.mjs';

const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));

function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, 'home'); mkdirSync(home);
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: home, USERPROFILE: home, ...env } });
  return { root, home, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** Compare two inspect JSON documents ignoring the volatile elapsed time. */
function sameInspection(a, b) {
  const normalize = text => {
    const parsed = JSON.parse(text);
    delete parsed.limits.elapsedMs;
    return parsed;
  };
  assert.deepEqual(normalize(a), normalize(b));
}

/** Deep-compare two results ignoring per-invocation identity fields. */
function sameResult(a, b) {
  const scrub = value => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['runId', 'reviewDigest', 'reference'].includes(key))
        .map(([key, entry]) => [key, scrub(entry)]));
    }
    return value;
  };
  assert.deepEqual(scrub(JSON.parse(a)), scrub(JSON.parse(b)));
}

test('inspect without the flag writes no report and keeps stdout and stderr unchanged', () => {
  const { root, run, close } = fixture('aih-cli-support-none-');
  try {
    const result = run(['inspect', '--offline', '--target', 'node', '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    JSON.parse(result.stdout);
    assert.equal(readdirSync(root).filter(name => name.endsWith('.md')).length, 0);
  } finally { close(); }
});

test('JSON inspect with the flag writes the report and adds exactly one receipt line on stderr', () => {
  const { root, run, close } = fixture('aih-cli-support-inspect-');
  const target = join(root, 'report.md');
  try {
    const baseline = run(['inspect', '--offline', '--target', 'node', '--json']);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    const reported = run(['inspect', '--offline', '--target', 'node', '--json', '--support-markdown', target]);
    assert.equal(reported.status, 0, reported.stdout + reported.stderr);
    sameInspection(reported.stdout, baseline.stdout);
    assert.equal(reported.stderr, `Support report written: ${join(realpathSync.native(root), 'report.md')}\n`);
    assert.ok(readFileSync(target, 'utf8').length > 0);
  } finally { close(); }
});

test('an existing destination leaves bytes untouched and turns a successful exit into 1', () => {
  const { root, run, close } = fixture('aih-cli-support-exists-');
  const target = join(root, 'report.md');
  try {
    writeFileSync(target, 'keep me\n');
    const baseline = run(['inspect', '--offline', '--target', 'node', '--json']);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    const reported = run(['inspect', '--offline', '--target', 'node', '--json', '--support-markdown', target]);
    assert.equal(reported.status, 1, reported.stdout + reported.stderr);
    sameInspection(reported.stdout, baseline.stdout);
    assert.equal(reported.stderr, 'Support report not written: exists\n');
    assert.equal(readFileSync(target, 'utf8'), 'keep me\n');
  } finally { close(); }
});

test('a nonzero operation exit is preserved when the export also fails', () => {
  const { root, run, close } = fixture('aih-cli-support-exit-');
  const project = join(root, 'project'); mkdirSync(project);
  try {
    // A reviewed replacement of existing unowned bytes blocks without an exact resolution.
    writeFileSync(join(project, 'settings.jsonc'), '{\n  "mode": "old"\n}\n');
    const document = policy(); const operation = document.selections[0].recipe.inline.operations[0];
    operation.kind = 'config.entries'; operation.target.segments = [{ literal: 'settings.jsonc' }];
    delete operation.content; operation.format = 'jsonc';
    operation.entries = [{ path: ['mode'], action: 'set', value: { literal: 'new' } }];
    const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(document));
    const baseline = run(['policy', file, '--project', project, '--json']);
    assert.equal(baseline.status, 1, baseline.stdout + baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).status, 'blocked');
    const target = join(root, 'missing-directory', 'report.md');
    const reported = run(['policy', file, '--project', project, '--json', '--support-markdown', target]);
    assert.equal(reported.status, 1, reported.stdout + reported.stderr);
    sameResult(reported.stdout, baseline.stdout);
    assert.match(reported.stderr, /^Support report not written: /);
    assert.equal(existsSync(join(root, 'missing-directory')), false);
  } finally { close(); }
});

test('option and parser rejection with the flag writes no report', () => {
  const { root, run, close } = fixture('aih-cli-support-refused-');
  const target = join(root, 'report.md');
  const file = join(root, 'policy.json');
  try {
    writeFileSync(file, JSON.stringify(policy()));
    for (const args of [
      ['inspect', '--apply', '--support-markdown', target, '--json'],
      ['validate', 'execution-policy', file, '--support-markdown', target],
      ['--version', '--support-markdown', target],
      ['help', 'inspect', '--support-markdown', target]
    ]) {
      const result = run(args);
      assert.equal(result.status, 2, args.join(' ') + result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).diagnostics[0].code, 'INPUT_INVALID', args.join(' '));
      assert.equal(existsSync(target), false, args.join(' '));
      assert.equal(result.stderr, 'Support report not written: input-rejected\n', args.join(' '));
    }
  } finally { close(); }
});

test('policy preview and apply export the prepare and run result respectively', () => {
  const { root, run, close } = fixture('aih-cli-support-policy-');
  const project = join(root, 'project'); mkdirSync(project);
  const file = join(root, 'policy.json');
  try {
    writeFileSync(file, JSON.stringify(policy()));
    const previewTarget = join(root, 'preview.md');
    const preview = run(['policy', file, '--project', project, '--json', '--support-markdown', previewTarget]);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(JSON.parse(preview.stdout).status, 'ready');
    assert.equal(preview.stderr, `Support report written: ${join(realpathSync.native(root), 'preview.md')}\n`);
    assert.match(readFileSync(previewTarget, 'utf8'), /\bprepare\b/i);
    const appliedTarget = join(root, 'applied.md');
    const applied = run(['policy', file, '--project', project, '--json', '--apply', '--yes', '--support-markdown', appliedTarget]);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.equal(JSON.parse(applied.stdout).completion, 'complete');
    assert.equal(applied.stderr, `Support report written: ${join(realpathSync.native(root), 'applied.md')}\n`);
    assert.match(readFileSync(appliedTarget, 'utf8'), /\brun\b/i);
  } finally { close(); }
});

test('repair prepare-only exports the prepare result with its repair context', () => {
  const { root, run, close } = fixture('aih-cli-support-repair-');
  const source = join(root, 'root.pem');
  const inputs = join(root, 'repair-inputs.json');
  const target = join(root, 'repair.md');
  try {
    writeFileSync(source, readFileSync(new URL('./fixtures/root-a.pem', import.meta.url)));
    writeFileSync(inputs, JSON.stringify({ 'node-npm-ca': { caFile: source } }));
    const preview = run(['repair', 'node-npm-ca', '--target', 'npm', '--inputs-file', inputs,
      '--offline', '--no-log', '--json', '--support-markdown', target]);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(JSON.parse(preview.stdout).status, 'ready');
    assert.equal(preview.stderr, `Support report written: ${join(realpathSync.native(root), 'repair.md')}\n`);
    assert.match(readFileSync(target, 'utf8'), /\bprepare\b/i);
  } finally { close(); }
});

test('non-JSON inspect prints human next actions on stderr only when guidance exists; JSON never does', () => {
  const { root, run, close } = fixture('aih-cli-support-prose-');
  const emptyPath = join(root, 'empty-path'); mkdirSync(emptyPath);
  try {
    // With an empty PATH a requested PATH-resolved helper is missing, so guidance exists (node always resolves to the running executable).
    const human = run(['inspect', '--offline', '--target', 'jq'], { PATH: emptyPath });
    assert.match(human.stderr, /Next actions:/, human.stdout + human.stderr);
    const structured = run(['inspect', '--offline', '--target', 'jq', '--json'], { PATH: emptyPath });
    assert.equal(structured.stderr.includes('Next actions:'), false, structured.stderr);
  } finally { close(); }
});
