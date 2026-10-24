import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const select = (changes, extra = []) => JSON.parse(execFileSync(process.execPath,
  ['scripts/select-checks.mjs', '--changes', JSON.stringify(changes), ...extra], { encoding: 'utf8', windowsHide: true }));

test('documentation reports an explicit no-applicable-tests result', () => {
  const result = select([{ status: 'M', paths: ['docs/templates.md'] }]);
  assert.deepEqual(result.matrix, []);
  assert.equal(result.suite, 'none');
});

test('a selected failing test propagates a failed CI process', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-ci-failure-'));
  try {
    const file = join(root, 'failure.test.mjs');
    writeFileSync(file, "import {test} from 'node:test'; test('selected failure', () => {throw new Error('expected failure');});");
    const result = spawnSync(process.execPath, ['scripts/run-ci-tests.mjs', '--files', file],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...process.env, NODE_TEST_CONTEXT: '' } });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /selected failure/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the reporting status fails for selected failure or cancellation and accepts a truthful docs skip', () => {
  const check = env => spawnSync(process.execPath, ['scripts/check-ci-result.mjs'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, SELECT: 'success', PACKAGE: 'success',
      NATIVE: 'skipped', SUITE: 'report', NEED_NATIVE: 'false', ...env } });
  assert.equal(check({}).status, 0);
  assert.equal(check({ PACKAGE: 'failure' }).status, 1);
  assert.equal(check({ PACKAGE: 'cancelled' }).status, 1);
  assert.equal(check({ SELECT: 'failure' }).status, 1);
  assert.equal(check({ NEED_NATIVE: 'true', NATIVE: 'failure' }).status, 1);
  assert.equal(check({ SUITE: 'none', PACKAGE: 'skipped' }).status, 0);
  assert.equal(check({ SUITE: '', PACKAGE: 'skipped' }).status, 1);
});

test('platform facilities select only their affected OS while shared changes widen', () => {
  for (const [path, os] of [
    ['src/harness/native/linux/facility.c', 'ubuntu-latest'],
    ['src/harness/native/windows/facility.cs', 'windows-latest'],
    ['src/harness/macos-session-platform.mjs', 'macos-latest']
  ]) assert.deepEqual(select([{ status: 'M', paths: [path] }]).matrix, [{ os, node: '24' }]);
  for (const path of ['src/core/types.ts', 'src/harness/native/adapter.mjs', 'package-lock.json', '.github/workflows/checks.yml', 'new-runtime.xyz']) {
    const result = select([{ status: 'M', paths: [path] }]);
    assert.equal(result.suite, 'full', path);
    assert.equal(result.matrix.length, 4, path);
  }
});

test('explicit full and deleted/renamed/unknown changes cannot skip coverage', () => {
  assert.equal(select([{ status: 'M', paths: ['README.md'] }], ['--full']).matrix.length, 4);
  for (const row of [
    { status: 'D', paths: ['docs/templates.md'] },
    { status: 'R100', paths: ['src/core/types.ts', 'docs/old.md'] },
    { status: '?', paths: ['README.md'] }
  ]) assert.equal(select([row]).matrix.length, 4);
});

test('report-local changes select their affected consumers on Linux', () => {
  const result = select([{ status: 'M', paths: ['src/harness/report/data.mjs'] }]);
  assert.equal(result.suite, 'report');
  assert.deepEqual(result.matrix, [{ os: 'ubuntu-latest', node: '24' }]);
  assert.equal(result.nativeLinux, false);
});

test('added, modified or renamed documentation selects no suite', () => {
  for (const changes of [
    [{ status: 'A', paths: ['docs/agents/triage-labels.md'] }, { status: 'M', paths: ['AGENTS.md'] }],
    [{ status: 'R100', paths: ['docs/old.md', 'docs/new.md'] }]
  ]) {
    const result = select(changes);
    assert.equal(result.suite, 'none', JSON.stringify(changes));
    assert.deepEqual(result.matrix, []);
    assert.equal(result.reason, 'documentation-only');
  }
});

test('documentation with a platform facility selects that platform only', () => {
  const result = select([{ status: 'A', paths: ['docs/linux.md'] }, { status: 'M', paths: ['src/harness/native/linux/facility.c'] }]);
  assert.equal(result.suite, 'full');
  assert.deepEqual(result.matrix, [{ os: 'ubuntu-latest', node: '24' }]);
});

test('a full suite never comes with an empty matrix', () => {
  for (const changes of [
    [{ status: 'A', paths: ['docs/new.md'] }],
    [{ status: 'R100', paths: ['docs/old.md', 'docs/new.md'] }],
    [{ status: 'D', paths: ['docs/templates.md'] }],
    [{ status: 'A', paths: ['docs/new.md'] }, { status: 'D', paths: ['docs/old.md'] }]
  ]) {
    const result = select(changes);
    if (result.suite !== 'none') assert.notEqual(result.matrix.length, 0, JSON.stringify(changes));
  }
});
