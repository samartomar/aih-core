import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macosCustodyParticipant, guardMacosSessionMember, readMacosCustody } from '../dist/core/internal/macos-session-custody.js';
import { protectState } from '../dist/core/internal/state.js';

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
        macosSession: { context: 'terminal', applications: [] } }, files: [], keys: [], profileIds: [] };
    const participant = macosCustodyParticipant(readMacosCustody(), entry, null, () => {});
    participant.stage('00000000-0000-4000-8000-000000000001', undefined);
    assert.equal(existsSync(join(root, '.aih/core/macos-session-pending.json')), true);
    assert.throws(() => readMacosCustody(), /session-recovery-required/);
    assert.doesNotThrow(() => guardMacosSessionMember(root, '.zprofile', true));
    assert.throws(() => guardMacosSessionMember(root, '.zprofile', false), /session-recovery-required/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
