import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getRepairRecipe, renderRepair } from '@aihq/harness/runtime';
import { repairIndex } from '@aihq/harness/contracts';
import { prepare, apply } from '../dist/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'aih-repair-'));
const home = join(scratch, 'home');
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const root = readFileSync(new URL('./fixtures/root-a.pem', import.meta.url));
const older = readFileSync(new URL('./fixtures/intermediate.pem', import.meta.url));
before(() => { mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });
const request = (file, targets = ['node']) => ({ useCase: 'repair', repairs: [{ id: 'node-npm-ca', targets, inputs: { caFile: file } }] });
const offlineNpm = file => ({ ...request(file, ['npm']), network: 'off' });
const authorize = result => ({ approved: true, origin: 'automation', reviewDigest: result.review.reviewDigest });

test('mixed validity rejects before writing managed trust or target config', async () => {
  const source = join(scratch, 'mixed.pem');
  writeFileSync(source, Buffer.concat([root, Buffer.from('-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----')]));
  const sentinel = join(home, '.npmrc'); writeFileSync(sentinel, 'registry=https://example.test/\n');
  const prepared = await prepare(request(source, ['node', 'npm']), { logging: 'off' });
  assert.equal(prepared.status, 'invalid');
  assert.equal(prepared.prepared, undefined);
  assert.ok(prepared.diagnostics.some(item => item.reason === 'block-label'));
  assert.equal(readFileSync(sentinel, 'utf8'), 'registry=https://example.test/\n');
  assert.equal(existsSync(join(home, '.aih')), false);
  rmSync(sentinel);
});

test('OS trust repair rejects an unknown endpoint selector before probes or effects', async () => {
  const result = await prepare({ useCase: 'repair', repairs: [{ id: 'node-os-trust', targets: ['node'],
    inputs: { originId: 'https://attacker.example.test' } }] }, { logging: 'off' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.prepared, undefined);
  assert.equal(result.diagnostics[0].reason, 'origin-invalid');
  assert.equal(existsSync(join(home, '.aih')), false);
});

test('OS trust repair refuses an insecure configured npm registry before network probes', async () => {
  const prior = process.env.NPM_CONFIG_REGISTRY;
  process.env.NPM_CONFIG_REGISTRY = 'http://127.0.0.1:9/';
  try {
    const result = await prepare({ useCase: 'repair', repairs: [{ id: 'node-os-trust', targets: ['node'],
      inputs: { originId: 'npm-registry' } }] }, { logging: 'off' });
    assert.equal(result.status, 'blocked');
    assert.equal(result.diagnostics[0].reason, 'config-invalid');
    assert.equal(existsSync(join(home, '.aih')), false);
  } finally {
    if (prior === undefined) delete process.env.NPM_CONFIG_REGISTRY;
    else process.env.NPM_CONFIG_REGISTRY = prior;
  }
});

test('CA rejection keeps byte offsets, assessment limits and export guidance across the public API', async () => {
  const source = join(scratch, 'bom-trailing.pem');
  writeFileSync(source, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), root, Buffer.from('unexpected')]));
  const rejected = await prepare(offlineNpm(source), { logging: 'off' });
  assert.equal(rejected.status, 'invalid');
  const issue = rejected.diagnostics.find(item => item.reason === 'pem-envelope');
  assert.equal(issue.offset, 3 + root.length);
  assert.equal(issue.assessedBlocks, 1);
  assert.equal(issue.assessmentLimit, 'structure');
  assert.match(issue.guidance, /CA-only PEM/);
  assert.equal(existsSync(join(home, '.aih')), false);
});

test('source change after review rejects before any import effect', async () => {
  const source = join(scratch, 'changing.pem'); writeFileSync(source, root);
  const prepared = await prepare(offlineNpm(source), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  writeFileSync(source, Buffer.concat([root, Buffer.from(' ')]));
  const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(result.completion, 'rejected');
  assert.equal(result.diagnostics[0].code, 'REVIEW_STALE');
  assert.equal(existsSync(join(home, '.aih')), false);
});

test('valid import creates stable material and reports offline npm verification', async () => {
  const source = join(scratch, 'valid.pem'); writeFileSync(source, root);
  const prepared = await prepare(offlineNpm(source), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.review.useCase, 'repair');
  assert.ok(prepared.review.operations.some(op => op.id === 'trust/material'));
  const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(result.completion, 'incomplete', JSON.stringify(result));
  assert.equal(result.useCase, 'repair');
  assert.ok(result.checks.some(check => check.id === 'trust/npm-behavior' && check.reason === 'offline'));
  const path = prepared.review.operations.find(op => op.id === 'trust/material').details.target;
  assert.match(readFileSync(path, 'utf8'), /BEGIN CERTIFICATE/);
  rmSync(source);
  assert.equal(existsSync(path), true);
});

test('repeat import preserves managed bytes and offline npm verification stays incomplete', async () => {
  const source = join(scratch, 'repeat.pem'); writeFileSync(source, root);
  const first = await prepare(offlineNpm(source), { logging: 'off' });
  assert.equal(first.status, 'ready', JSON.stringify(first));
  assert.equal(first.review.operations.find(op => op.id === 'trust/material').effects, 'already-satisfied');
  const previousBytes = readFileSync(first.review.operations.find(op => op.id === 'trust/material').details.target);
  assert.equal((await apply(first.prepared, authorize(first), { logging: 'off' })).completion, 'incomplete');
  assert.deepEqual(readFileSync(first.review.operations.find(op => op.id === 'trust/material').details.target), previousBytes);
  const offline = await prepare({ ...request(source, ['npm']), network: 'off' }, { logging: 'off' });
  assert.equal(offline.status, 'ready', JSON.stringify(offline));
  assert.ok(offline.review.observations.some(item => item.id === 'npm-behavior' && item.reason === 'skipped-offline'));
  const result = await apply(offline.prepared, authorize(offline), { logging: 'off' });
  assert.equal(result.completion, 'incomplete', JSON.stringify(result));
  assert.equal(result.operations.find(op => op.id === 'trust/npm-config').verification.reason, 'offline');
});

test('CLI and API reject the same mixed input without effects or raw key output', () => {
  const cliHome = join(scratch, 'cli-home'); mkdirSync(cliHome);
  const source = join(scratch, 'cli-mixed.pem');
  writeFileSync(source, Buffer.concat([root, Buffer.from('-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----')]));
  const input = join(scratch, 'repair-inputs.json');
  writeFileSync(input, JSON.stringify({ 'node-npm-ca': { caFile: source } }));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'repair', 'node-npm-ca', '--target', 'node',
    '--inputs-file', input, '--apply', '--yes', '--json'], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: cliHome, USERPROFILE: cliHome }
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).diagnostics[0].reason, 'block-label');
  assert.equal(result.stdout.includes('PRIVATE KEY'), false);
  assert.equal(existsSync(join(cliHome, '.aih', 'core', 'content')), false);
  const partial = spawnSync(process.execPath, [cli, 'repair', 'node-npm-ca', '--target', 'node',
    '--inputs-file', input, '--apply', '--yes', '--allow-partial', '--json'], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: cliHome, USERPROFILE: cliHome }
  });
  assert.equal(partial.status, 2);
  assert.equal(JSON.parse(partial.stdout).diagnostics[0].reason, 'block-label');
  assert.equal(existsSync(join(cliHome, '.aih', 'core', 'content')), false);
});

test('expiry between review and apply rejects before material creation', async () => {
  const scopedHome = join(scratch, 'expiry-home'); mkdirSync(scopedHome);
  process.env.HOME = scopedHome; process.env.USERPROFILE = scopedHome;
  const source = join(scratch, 'expiry.pem'); writeFileSync(source, root);
  const prepared = await prepare(offlineNpm(source), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const originalNow = Date.now;
  try {
    Date.now = () => Date.UTC(2036, 6, 22);
    const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
    assert.equal(result.completion, 'rejected');
    assert.equal(result.diagnostics[0].code, 'INPUT_INVALID');
    assert.equal(existsSync(join(scopedHome, '.aih')), false);
  } finally { Date.now = originalNow; process.env.HOME = home; process.env.USERPROFILE = home; }
});

test('changed npm target rejects before writing managed material', async () => {
  const scopedHome = join(scratch, 'target-home'); mkdirSync(scopedHome);
  process.env.HOME = scopedHome; process.env.USERPROFILE = scopedHome;
  try {
    const source = join(scratch, 'target.pem'); writeFileSync(source, root);
    const prepared = await prepare({ ...request(source, ['npm']), network: 'off' }, { logging: 'off' });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    const config = join(scopedHome, '.npmrc'); writeFileSync(config, 'cafile=other.pem\n');
    const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
    assert.equal(result.completion, 'rejected');
    assert.equal(result.diagnostics[0].code, 'REVIEW_STALE');
    assert.equal(readFileSync(config, 'utf8'), 'cafile=other.pem\n');
    assert.equal(existsSync(join(scopedHome, '.aih')), false);
  } finally { process.env.HOME = home; process.env.USERPROFILE = home; }
});

test('a later valid import preserves an expired managed CA', async () => {
  const scopedHome = join(scratch, 'old-ca-home'); mkdirSync(scopedHome);
  process.env.HOME = scopedHome; process.env.USERPROFILE = scopedHome;
  const originalNow = Date.now;
  try {
    const firstSource = join(scratch, 'old-ca.pem'); writeFileSync(firstSource, older);
    const first = await prepare(offlineNpm(firstSource), { logging: 'off' });
    assert.equal(first.status, 'ready', JSON.stringify(first));
    assert.equal((await apply(first.prepared, authorize(first), { logging: 'off' })).completion, 'incomplete');
    const bundle = first.review.operations.find(op => op.id === 'trust/material').details.target;
    const prior = readFileSync(bundle);
    Date.now = () => Date.UTC(2035, 0, 1);
    const nextSource = join(scratch, 'new-ca.pem'); writeFileSync(nextSource, root);
    const next = await prepare(offlineNpm(nextSource), { logging: 'off' });
    assert.equal(next.status, 'ready', JSON.stringify(next));
    assert.equal((await apply(next.prepared, authorize(next), { logging: 'off' })).completion, 'incomplete');
    assert.ok(readFileSync(bundle).subarray(0, prior.length).equals(prior));
  } finally { Date.now = originalNow; process.env.HOME = home; process.env.USERPROFILE = home; }
});

test('Windows persistence is reviewed and a failed step blocks its Node reference',
  { skip: process.platform !== 'win32' }, async () => {
  const scopedHome = join(scratch, 'persist-home'); mkdirSync(scopedHome);
  process.env.HOME = scopedHome; process.env.USERPROFILE = scopedHome;
  try {
    const digest = value => createHash('sha256').update(value).digest('hex');
    const key = digest(`${scopedHome}\0user\0node-npm-trust`);
    const bundlePath = join(scopedHome, '.aih', 'core', 'content', key, 'trust.pem');
    const bundle = root.toString();
    const variant = repairIndex[0].variants.find(item => item.os === 'win32' &&
      item.targets.length === 1 && item.targets[0] === 'node' && item.network === 'off');
    const bindings = renderRepair({ id: 'node-npm-ca', variantRef: variant.recipeRef,
      bundlePath, bundleSha256: digest(bundle), fingerprints: ['0'.repeat(64)] });
    assert.equal(bindings.status, 'completed');
    const recipe = getRepairRecipe(variant.recipeRef);
    const persist = recipe.operations.find(op => op.id === 'node-persist');
    assert.equal(persist.kind, 'process.run');
    assert.equal(persist.executable.name, process.execPath);
    assert.match(persist.args[1].literal, /setx\.exe/);
    assert.deepEqual([persist.args[0].literal, persist.args[2].input], ['-e', 'bundlePath']);
    assert.doesNotThrow(() => new Function(persist.args[1].literal));
    const userEnvCheck = recipe.checks.find(check => check.id === 'node-user-env');
    assert.doesNotThrow(() => new Function(userEnvCheck.args[1].literal));
    assert.deepEqual(recipe.operations.find(op => op.id === 'node-config').requires, ['node-persist']);
    persist.executable = { name: 'aih-deliberately-missing-setx-stub' };
    const p = await prepare({ useCase: 'policy', target: { project: scopedHome }, policy: {
      schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
        id: 'trust', managementId: 'node-npm-trust', scope: 'user', configuration: bindings.bindings,
        requires: [], recipe: { inline: recipe }
      }]
    } }, { logging: 'off', privateInputs: { trust: { bundle } } });
    assert.equal(p.status, 'partial', JSON.stringify(p));
    const result = await apply(p.prepared, { ...authorize(p), allowPartial: true }, { logging: 'off' });
    assert.equal(result.completion, 'incomplete');
    assert.equal(result.operations.find(op => op.id === 'trust/node-persist').application, 'not-attempted');
    assert.equal(result.operations.find(op => op.id === 'trust/node-config').reason, 'dependency-not-satisfied');
    assert.equal(existsSync(join(scopedHome, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')), false);
  } finally { process.env.HOME = home; process.env.USERPROFILE = home; }
});

test('hostile repair inputs and controls are rejected before getters, probes or history', async () => {
  const scopedHome = join(scratch, 'hostile-home'); mkdirSync(scopedHome);
  process.env.HOME = scopedHome; process.env.USERPROFILE = scopedHome;
  try {
    const source = join(scratch, 'hostile-valid.pem'); writeFileSync(source, root);
    let reads = 0;
    const hostileInputs = { get caFile() { reads++; throw new Error('getter-ran'); } };
    const badRequest = { useCase: 'repair', repairs: [{ id: 'node-npm-ca', targets: ['npm'], inputs: hostileInputs }] };
    const invalid = await prepare(badRequest);
    assert.equal(invalid.status, 'invalid'); assert.equal(reads, 0);
    const hostileControls = { get logging() { reads++; throw new Error('control-getter-ran'); } };
    const blocked = await prepare(offlineNpm(source), hostileControls);
    assert.equal(blocked.status, 'invalid'); assert.equal(reads, 0);
    assert.equal(existsSync(join(scopedHome, '.aih')), false);
    const ready = await prepare(offlineNpm(source), { logging: 'off' });
    assert.equal(ready.status, 'ready');
    const rejected = await apply(ready.prepared, authorize(ready), hostileControls);
    assert.equal(rejected.completion, 'rejected'); assert.equal(reads, 0);
    assert.equal(existsSync(join(scopedHome, '.aih', 'core', 'content')), false);
  } finally { process.env.HOME = home; process.env.USERPROFILE = home; }
});

test('npm TLS verification refuses inherited bypass and an HTTP registry', async () => {
  const source = join(scratch, 'bypass-root.pem'); writeFileSync(source, root);
  const cases = [
    ['NPM_CONFIG_STRICT_SSL', 'false'],
    ['NPM_CONFIG_REGISTRY', 'http://127.0.0.1:9/'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0']
  ];
  for (const [key, value] of cases) {
    const scopedHome = join(scratch, `bypass-${key}`); mkdirSync(scopedHome);
    const prior = process.env[key];
    process.env.HOME = scopedHome; process.env.USERPROFILE = scopedHome; process.env[key] = value;
    try {
      const prepared = await prepare(request(source, ['npm']), { logging: 'off' });
      assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
      const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
      assert.equal(result.completion, 'incomplete', `${key}: ${JSON.stringify(result)}`);
      assert.equal(result.checks.find(item => item.id === 'trust/npm-behavior').status, 'failed');
    } finally {
      if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
      process.env.HOME = home; process.env.USERPROFILE = home;
    }
  }
});
