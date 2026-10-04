import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePreparedWork12 } from '../dist/core/contracts.js';

const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aih-trust-cli-'));
  const home = join(root, 'home'); mkdirSync(home);
  return { root, home, document: (name, value) => {
    const path = join(root, name); writeFileSync(path, JSON.stringify(value)); return path;
  }, run: args => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8', timeout: 30_000, windowsHide: true
  }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('export-ca help describes standalone format and home-relative output without observing user state', () => {
  const f = fixture();
  try {
    const result = f.run(['help', 'export-ca']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /export-ca/);
    assert.match(result.stdout, /pem\|pkcs7-der/);
    assert.match(result.stdout, /user-home-relative/);
    assert.equal(existsSync(join(f.home, '.aih')), false);
  } finally { f.cleanup(); }
});

test('export-ca refuses repair, policy and partial options before observing state', () => {
  const f = fixture();
  try {
    for (const option of [['--target', 'node'], ['--allow-partial'], ['--project', f.root],
      ['--format', 'cer'], ['--support-markdown', 'report.md'], ['--yes']]) {
      const result = f.run(['export-ca', ...option, '--json']);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).diagnostics[0].code, 'INPUT_INVALID');
    }
    assert.equal(existsSync(join(f.home, '.aih')), false);
  } finally { f.cleanup(); }
});

test('CLI input schemas have exact identities and reject extra source controls', () => {
  const f = fixture();
  try {
    for (const [document, code, reason] of [
      [{ schema: 'urn:aihq:core:certificate-export-inputs:2.0.0', sources: { os: true, supplied: [] } }, 'SCHEMA_UNSUPPORTED', 'schema-unsupported'],
      [{ schema: 'urn:aihq:core:certificate-export-inputs:1.0.0', sources: { os: false, supplied: [] }, policy: {} }, 'INPUT_INVALID', 'unknown-field'],
      [{ schema: 'urn:aihq:core:certificate-export-inputs:1.0.0', sources: { os: true, supplied: [], command: 'arbitrary' } }, 'INPUT_INVALID', 'unknown-field']
    ]) {
      const input = f.document('inputs.json', document);
      const result = f.run(['export-ca', '--inputs-file', input, '--json', '--no-log']);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).diagnostics[0].code, code);
      assert.equal(JSON.parse(result.stdout).diagnostics[0].reason, reason);
    }
  } finally { f.cleanup(); }
});

test('versioned repair input documents share portable source and member diagnostics', () => {
  const f = fixture();
  try {
    for (const [document, reason] of [
      [{ schema: 'urn:aihq:core:repair-inputs:1.0.0', route: 'native', repairs: { 'node-npm-ca': {} }, extra: true }, 'unknown-field'],
      [{ schema: 'urn:aihq:core:repair-inputs:1.0.0', route: 'native', repairs: { 'node-npm-ca': {} }, sources: { os: true, supplied: [] } }, 'invalid-source-selection']
    ]) {
      const input = f.document('invalid-native.json', document);
      const result = f.run(['repair', 'node-npm-ca', '--target', 'node', '--inputs-file', input, '--json', '--no-log']);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).diagnostics[0].reason, reason);
    }
    assert.equal(existsSync(join(f.home, '.aih')), false);
  } finally { f.cleanup(); }
});

test('versioned repair resolves supplied files relative to the input document and returns a full 1.2 review', () => {
  const f = fixture();
  try {
    const inputDir = join(f.root, 'documents'); mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'corporate.pem'), readFileSync(new URL('./fixtures/root-a.pem', import.meta.url)));
    const input = f.document('documents/inputs.json', { schema: 'urn:aihq:core:repair-inputs:1.0.0', route: 'file',
      repairs: { 'node-npm-ca': {} }, sources: { os: false, supplied: [{ id: 'corporate', file: 'corporate.pem' }] } });
    const result = f.run(['repair', 'node-npm-ca', '--target', 'npm', '--inputs-file', input, '--offline', '--no-log', '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const preparation = JSON.parse(result.stdout);
    assert.equal(preparation.status, 'ready');
    assert.equal(preparation.review.schema, 'urn:aihq:core:prepared-work:1.2.0');
    const checked = validatePreparedWork12(preparation.review);
    assert.equal(checked.valid, true, JSON.stringify(checked.diagnostics));
    assert.equal(preparation.review.inputs.trust.sources.find(source => source.id === 'supplied:corporate').completeness, 'complete');
    assert.equal(preparation.review.inputs.trust.targets[0].verification.status, 'skipped');
    assert.equal(existsSync(join(f.home, '.npmrc')), false);
    assert.deepEqual(preparation.resolutionInputs, []);
    assert.equal(Object.hasOwn(preparation, 'prepared'), false);
  } finally { f.cleanup(); }
});

test('versioned native repair reports unavailable through its full 1.2 contract', () => {
  const f = fixture();
  try {
    const input = f.document('native.json', { schema: 'urn:aihq:core:repair-inputs:1.0.0', route: 'native', repairs: { 'node-npm-ca': {} } });
    const result = f.run(['repair', 'node-npm-ca', '--target', 'node', '--inputs-file', input, '--offline', '--no-log', '--json']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const preparation = JSON.parse(result.stdout);
    assert.equal(preparation.status, 'blocked');
    assert.equal(preparation.review.inputs.trust.targets[0].admission, 'unavailable');
    assert.equal(validatePreparedWork12(preparation.review).valid, true, JSON.stringify(preparation));
    assert.deepEqual(preparation.resolutionInputs, []);
    assert.equal(existsSync(join(f.home, '.npmrc')), false);
  } finally { f.cleanup(); }
});
