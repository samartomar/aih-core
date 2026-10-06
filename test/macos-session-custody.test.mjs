import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macosCustodyParticipant, guardMacosSessionMember, readMacosCustody, readPendingMacos,
  sessionConfiguration, sessionTrustMatches } from '../dist/core/internal/macos-session-custody.js';
import { protectState, stateFiles, ownershipPath } from '../dist/core/internal/state.js';
import { sha256 } from '../dist/core/internal/host-files.js';
import { memberKey } from '../dist/core/internal/recipe-lifecycle.js';

test('a protected session participant can execute its own staged intent while an ordinary request is blocked', () => {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'aih-session-intent-')));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = root; process.env.USERPROFILE = root;
  try {
    protectState();
    const entry = { managementId: 'node-npm-trust', selectionId: 'trust', recipeIdentity: `sha256:${'a'.repeat(64)}`,
      bindingSha256: 'b'.repeat(64), appBindingSha256: 'c'.repeat(64), context: 'terminal', appliedAt: '2026-10-06T00:00:00Z',
      request: { schema: 'urn:aihq:core:repair-request:1.1.0', useCase: 'repair', route: 'file', network: 'off',
        repairs: [{ id: 'node-npm-ca', targets: ['node'], inputs: {} }], sources: { os: false, supplied: [{ id: 'team', file: '/fixture.pem' }] },
        macosSession: { context: 'terminal', applications: [] } },
      files: [{ operationId: 'node-config', pathKey: JSON.stringify({ home: root, segments: ['.zprofile'] }), sha256: 'd'.repeat(64) }],
      keys: [], profileIds: [] };
    const participant = macosCustodyParticipant(readMacosCustody(), entry, null, () => {});
    participant.stage('00000000-0000-4000-8000-000000000001', undefined);
    assert.equal(existsSync(join(root, '.aih/core/macos-session-pending.json')), true);
    assert.throws(() => readMacosCustody(), /session-recovery-required/);
    assert.doesNotThrow(() => guardMacosSessionMember(root, '.zprofile', true));
    assert.throws(() => guardMacosSessionMember(root, '.zprofile', false), /session-recovery-required/);
    assert.doesNotThrow(() => guardMacosSessionMember(root, 'unrelated/project.txt', false));
    const image = readMacosCustody(true), pending = readPendingMacos(image);
    assert.equal(pending.intent.managementId, entry.managementId);
    const original = readFileSync(join(root, '.aih/core/macos-session-pending.json'));
    assert.throws(() => macosCustodyParticipant(image, { ...entry, managementId: 'user-tools-trust' }, null, () => {}, [], pending), /session-recovery-required/);
    // Fresh reviewed work may reconcile only the original affected members.
    const bytes = Buffer.from('export NODE_EXTRA_CA_CERTS=fixture\n');
    writeFileSync(join(root, '.zprofile'), bytes);
    entry.files[0].sha256 = sha256(bytes);
    stateFiles().writeAtomic(ownershipPath(root), Buffer.from(JSON.stringify({ schema: 'urn:aihq:core:ownership:1.0.0', target: root,
      members: { [memberKey({ kind: 'file', path: '.zprofile' })]: {
        managementId: entry.managementId, recipeIdentity: entry.recipeIdentity, sha256: sha256(bytes), mode: 0o600 } } })), 0o600);
    const reconciled = macosCustodyParticipant(image, entry, null, () => {}, [], pending);
    reconciled.preflight([{ managementId: entry.managementId, root, path: '.zprofile', after: bytes,
      recipeIdentity: entry.recipeIdentity, review: { id: 'trust/node-config' } }]);
    reconciled.recheck();
    reconciled.stage('00000000-0000-4000-8000-000000000003', undefined);
    assert.deepEqual(readFileSync(join(root, '.aih/core/macos-session-pending.json')), original, 'retain original recovery evidence through reconciliation');
    reconciled.finish({ completion: 'complete', operations: [] });
    assert.equal(readMacosCustody().value.entries[0].files[0].sha256, sha256(bytes));
    assert.equal(existsSync(join(root, '.aih/core/macos-session-pending.json')), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test('session configuration preserves completed writes despite failed checks or cancellation', () => {
  const operations = [{ id: 'trust/node-config', application: 'applied', verification: { status: 'failed', reason: 'fixture' } },
    { id: 'trust/other-config', application: 'not-attempted', verification: { status: 'unverified', reason: 'cancelled' } }];
  assert.equal(sessionConfiguration(operations, ['trust/node-config', 'trust/other-config']), 'applied');
  assert.equal(sessionConfiguration([{ ...operations[0], effectsUncertain: true }], ['trust/node-config']), 'uncertain');
  assert.equal(sessionConfiguration([{ ...operations[0], id: 'trust/material' }], ['trust/node-config']), 'not-applied');
});

test('session verification requires joined trust material custody and rejects its pending journal', () => {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'aih-session-trust-')));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = root; process.env.USERPROFILE = root;
  try {
    protectState();
    const pathKey = JSON.stringify({ home: root, segments: ['trust.pem'] });
    const entry = { managementId: 'node-npm-trust', selectionId: 'trust', recipeIdentity: `sha256:${'a'.repeat(64)}`,
      files: [{ operationId: 'material', pathKey, sha256: 'b'.repeat(64) }] };
    assert.equal(sessionTrustMatches(entry), false);
    const trust = { schema: 'urn:aihq:core:trust-custody:1.0.0', entries: [{ managementId: entry.managementId,
      selectionId: entry.selectionId, operationId: 'material', pathKey, relativePath: 'trust.pem', format: 'pem',
      outputSha256: 'b'.repeat(64), recipeIdentity: entry.recipeIdentity, sourceSetSha256: 'c'.repeat(64), sources: [] }] };
    stateFiles().writeAtomic('trust-custody.json', Buffer.from(JSON.stringify(trust)), 0o600);
    assert.equal(sessionTrustMatches(entry), true);
    trust.entries[0].outputSha256 = 'd'.repeat(64);
    stateFiles().writeAtomic('trust-custody.json', Buffer.from(JSON.stringify(trust)), 0o600);
    assert.equal(sessionTrustMatches(entry), false);
    stateFiles().writeAtomic('trust-custody-pending.json', Buffer.from('{}'), 0o600);
    assert.throws(() => sessionTrustMatches(entry), /trust-custody-pending/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
