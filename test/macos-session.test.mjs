import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, apply, verifyMacosSession, prepareManagedRemoval, listManagedSelections } from '../dist/core/index.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePreparedWork13, validateRunResult13, validateMacosSessionCustody,
  validateMacosSessionVerificationResult } from '../dist/core/contracts.js';

const request = () => ({
  schema: 'urn:aihq:core:repair-request:1.1.0',
  useCase: 'repair', route: 'file', network: 'off',
  repairs: [{ id: 'node-npm-ca', targets: ['node'], inputs: {} }],
  sources: { os: false, supplied: [{ id: 'team', file: '/Users/aih-test/ca.pem' }] },
  macosSession: { context: 'terminal', applications: [] }
});

test('verification rejects caller process proof and preserves null identity', async () => {
  const result = await verifyMacosSession({ schema: 'urn:aihq:core:macos-session-verification-request:1.0.0',
    managementId: 'node-npm-trust', pid: 1234 }, { logging: 'off' });
  assert.equal(result.status, 'invalid');
  assert.equal(result.managementId, null);
  assert.equal(result.platform, null);
  assert.deepEqual(result.observations, []);
  assert.equal(validateMacosSessionVerificationResult(result).valid, true);
});

test('verification CLI rejects mutation options and an invalid management ID', () => {
  for (const args of [['--management-id', 'node-npm-trust', '--apply'], ['--management-id', '../wrong']]) {
    const result = spawnSync(process.execPath, ['dist/core/cli.js', 'verify-macos-session', ...args, '--no-log', '--json'],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'invalid');
  }
});

test('terminal session applies real configuration, retains custody without history, refuses drift and removes only its block', {
  skip: process.platform !== 'darwin'
}, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'aih-macos-session-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = join(root, 'home'), project = join(root, 'project'), file = join(root, 'ca.pem');
  mkdirSync(home); mkdirSync(project);
  writeFileSync(file, readFileSync(new URL('./fixtures/root-a.pem', import.meta.url)));
  writeFileSync(join(home, '.zprofile'), 'export AIHQ_UNRELATED=preserve\n');
  process.env.HOME = home; process.env.USERPROFILE = home;
  const selected = request(); selected.sources.supplied[0].file = file;
  const approval = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
  try {
    const prepared = await prepare(selected, { logging: 'off' });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    assert.equal(validatePreparedWork13(prepared.review).valid, true, JSON.stringify(validatePreparedWork13(prepared.review)));
    assert.equal(readFileSync(join(home, '.zprofile'), 'utf8'), 'export AIHQ_UNRELATED=preserve\n');
    const wrong = await apply(prepared.prepared, { ...approval(prepared), reviewDigest: '0'.repeat(64) }, { logging: 'off' });
    assert.equal(wrong.completion, 'rejected');
    const applied = await apply(prepared.prepared, approval(prepared), { logging: 'off' });
    assert.equal(applied.completion, 'complete', JSON.stringify(applied));
    assert.equal(validateRunResult13(applied).valid, true, JSON.stringify(validateRunResult13(applied)));
    assert.equal(applied.macosSession.configuration, 'applied');
    assert.equal(applied.macosSession.verification, 'skipped');
    const managedProfile = readFileSync(join(home, '.zprofile'), 'utf8');
    assert.match(managedProfile, /NODE_EXTRA_CA_CERTS/);
    assert.match(managedProfile, /AIHQ_UNRELATED=preserve/);
    const custody = JSON.parse(readFileSync(join(home, '.aih/core/macos-session-custody.json'), 'utf8'));
    assert.equal(validateMacosSessionCustody(custody).valid, true, JSON.stringify(validateMacosSessionCustody(custody)));
    assert.equal(custody.entries[0].managementId, 'node-npm-trust');
    assert.equal(existsSync(join(home, '.aih/core/history')), false);
    const legacyRequest = { ...selected, schema: 'urn:aihq:core:repair-request:1.0.0' };
    delete legacyRequest.macosSession;
    const legacy = await prepare(legacyRequest, { logging: 'off' });
    assert.notEqual(legacy.status, 'ready', JSON.stringify(legacy));
    assert.equal(readFileSync(join(home, '.zprofile'), 'utf8'), managedProfile);
    const staleRequest = structuredClone(selected);
    const stalePreparation = await prepare(staleRequest, { logging: 'off' });
    assert.equal(stalePreparation.status, 'ready', JSON.stringify(stalePreparation));
    let accessorCalls = 0;
    Object.defineProperty(staleRequest, 'network', { enumerable: true, get() { accessorCalls++; throw new Error(); } });
    const stale = await apply(stalePreparation.prepared, approval(stalePreparation), { logging: 'off' });
    assert.equal(stale.completion, 'rejected');
    assert.equal(stale.diagnostics[0].reason, 'review-stale');
    assert.equal(accessorCalls, 0);
    assert.equal(readFileSync(join(home, '.zprofile'), 'utf8'), managedProfile);
    const verified = await verifyMacosSession({ schema: 'urn:aihq:core:macos-session-verification-request:1.0.0',
      managementId: 'node-npm-trust' }, { logging: 'off' });
    assert.equal(verified.status, 'incomplete');
    assert.equal(verified.configuration, 'already-satisfied', JSON.stringify(verified));
    assert.equal(verified.verification, 'skipped');
    assert.equal(validateMacosSessionVerificationResult(verified).valid, true, JSON.stringify(validateMacosSessionVerificationResult(verified)));
    const rerun = await prepare(selected, { logging: 'off' });
    assert.equal(rerun.status, 'ready', JSON.stringify(rerun));
    const satisfied = await apply(rerun.prepared, approval(rerun), { logging: 'off' });
    assert.equal(satisfied.completion, 'complete', JSON.stringify(satisfied));
    assert.equal(satisfied.macosSession.configuration, 'already-satisfied');
    const inventory = await listManagedSelections({ target: { project }, scope: 'user' });
    assert.equal(inventory.status, 'complete', JSON.stringify(inventory));
    assert.ok(inventory.selections.some(row => row.managementId === 'node-npm-trust'));
    writeFileSync(join(home, '.zprofile'), managedProfile + 'export FOREIGN_CHANGE=keep\n');
    const drift = await verifyMacosSession({ schema: 'urn:aihq:core:macos-session-verification-request:1.0.0', managementId: 'node-npm-trust' }, { logging: 'off' });
    assert.equal(drift.reason, 'session-config-drift');
    const refused = await prepareManagedRemoval({ target: { project }, scope: 'user', mode: 'vibe', managementId: 'node-npm-trust' }, { logging: 'off' });
    assert.equal(refused.disposition, 'reconcile-required');
    writeFileSync(join(home, '.zprofile'), managedProfile);
    const removal = await prepareManagedRemoval({ target: { project }, scope: 'user', mode: 'vibe', managementId: 'node-npm-trust' }, { logging: 'off' });
    assert.equal(removal.disposition, 'prepared', JSON.stringify(removal));
    assert.equal(removal.preparation.review.schema, 'urn:aihq:core:prepared-work:1.3.0');
    const removed = await apply(removal.preparation.prepared, approval(removal.preparation), { logging: 'off' });
    assert.equal(removed.completion, 'complete', JSON.stringify(removed));
    assert.equal(validateRunResult13(removed).valid, true, JSON.stringify(validateRunResult13(removed)));
    assert.doesNotMatch(readFileSync(join(home, '.zprofile'), 'utf8'), /NODE_EXTRA_CA_CERTS/);
    assert.match(readFileSync(join(home, '.zprofile'), 'utf8'), /AIHQ_UNRELATED=preserve/);
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.aih/core/macos-session-custody.json'), 'utf8')).entries, []);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test('macOS session repair reports the unsupported host before capturing source files', {
  skip: process.platform === 'darwin'
}, async () => {
  const result = await prepare(request(), { logging: 'off' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.diagnostics[0]?.reason, 'session-platform-unsupported');
  assert.equal(result.review.schema, 'urn:aihq:core:prepared-work:1.3.0');
  assert.equal(validatePreparedWork13(result.review).valid, true, JSON.stringify(validatePreparedWork13(result.review)));
  assert.deepEqual(result.review.inputs.macosSession.applications, []);
  assert.deepEqual(result.review.operations, []);
});
