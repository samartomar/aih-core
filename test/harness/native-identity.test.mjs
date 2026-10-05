import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureTestIdentity, stageCredential, validateClaudeOAuthFile } from '../../src/harness/native/identity.mjs';
import { createOwnedCell, removeOwnedCell } from '../../src/harness/native/cell.mjs';
import { nativeVerificationDefinitions } from '../../src/harness/native/contracts.mjs';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const expected = { accountUuid: ACCOUNT, organizationId: ORG };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const oauth = JSON.stringify({ claudeAiOauth: { accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token', expiresAt: 1893456000000, scopes: ['user:inference'] } });

// A provisioned root created inside an owned (hardened) cell, so permissions satisfy the owner-only rules.
function provision(t, { manifest = {}, credential = oauth, extra = false } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'aihq-ident-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const { cell } = createOwnedCell({ parent });
  const root = join(cell.credentials, 'provisioned');
  mkdirSync(root, { mode: 0o700 });
  const text = credential ?? oauth;
  const body = { schema: 'urn:aihq:harness:native-test-identity:1.0.0', id: 'dedicated-smoke', client: 'claude',
    adapterId: 'claude-oauth-otel.v1', purpose: 'dedicated-native-test', expected,
    credential: { path: 'oauth.json', sha256: sha(text), byteLength: Buffer.byteLength(text) }, ...manifest };
  const manifestText = JSON.stringify(body);
  if (credential !== null) writeFileSync(join(root, 'oauth.json'), credential, { mode: 0o600 });
  if (manifest !== null) writeFileSync(join(root, 'identity.json'), manifestText, { mode: 0o600 });
  if (extra) writeFileSync(join(root, 'other.txt'), 'x');
  if (process.platform === 'win32') {
    const system = join(process.env.SystemRoot, 'System32');
    const sid = /"(S-1-5-[0-9-]+)"/.exec(execFileSync(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true }).toString())[1];
    execFileSync(join(system, 'icacls.exe'), [root, '/setowner', `*${sid}`, '/t', '/q'], { windowsHide: true });
  }
  return { parent, cell, root, manifestSha256: sha(manifestText) };
}
const capture = (p, overrides = {}) => captureTestIdentity({ provisionedRoot: p.root, manifestSha256: p.manifestSha256, expected, ...overrides });

test('Claude OAuth file format is closed and bounded', () => {
  assert.equal(validateClaudeOAuthFile(Buffer.from(oauth)).valid, true);
  for (const bad of ['{', '[]', '{}', JSON.stringify({ claudeAiOauth: {} }),
    JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'b', expiresAt: 'soon' } }),
    JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'b', expiresAt: 1 }, extra: 1 }),
    '{"claudeAiOauth":{"accessToken":"a","refreshToken":"b","expiresAt":1},"claudeAiOauth":{}}'])
    assert.equal(validateClaudeOAuthFile(Buffer.from(bad)).valid, false, bad);
});

test('a valid provisioned root is captured once and staged into the cell home only', async t => {
  const p = provision(t);
  const captured = await capture(p);
  assert.equal(captured.status, 'captured');
  assert.equal(await captured.recheck(), true);
  const target = nativeVerificationDefinitions[0];
  const { cell } = createOwnedCell({ parent: p.parent });
  assert.deepEqual(stageCredential(cell, target, captured), { status: 'staged' });
  assert.deepEqual(readFileSync(join(cell.home, '.claude', '.credentials.json')), Buffer.from(oauth));
  assert.equal(existsSync(join(p.root, 'oauth.json')), true, 'the provisioned source stays in place');
  assert.deepEqual(stageCredential(cell, target, captured), { status: 'unavailable', reason: 'staging-unavailable' }, 'never restaged');
  assert.ok(!JSON.stringify({ ...captured, credential: undefined }).includes('fake-access-token'));
  removeOwnedCell(cell, { processesConfirmed: true });
});

test('missing binding is authentication-unavailable', async t => {
  const none = await captureTestIdentity({ provisionedRoot: join(tmpdir(), 'aihq-no-such-root'), manifestSha256: 'a'.repeat(64), expected });
  assert.deepEqual(none, { status: 'unavailable', reason: 'authentication-unavailable' });
  const noCredential = provision(t, { credential: null, manifest: {} });
  assert.deepEqual(await capture(noCredential), { status: 'unavailable', reason: 'authentication-unavailable' });
  assert.deepEqual(await captureTestIdentity({ provisionedRoot: 'relative', manifestSha256: 'a'.repeat(64), expected }),
    { status: 'unavailable', reason: 'authentication-unavailable' });
});

test('wrong pins, identity, hash, size, format or extra files are identity-binding-invalid', async t => {
  const invalid = { status: 'unavailable', reason: 'identity-binding-invalid' };
  const p = provision(t);
  assert.deepEqual(await capture(p, { manifestSha256: 'b'.repeat(64) }), invalid, 'manifest hash pin');
  assert.deepEqual(await capture(p, { expected: { accountUuid: '33333333-3333-4333-8333-333333333333', organizationId: ORG } }), invalid, 'account');
  assert.deepEqual(await capture(p, { expected: { accountUuid: ACCOUNT, organizationId: '44444444-4444-4444-8444-444444444444' } }), invalid, 'organization');
  const badHash = provision(t, { manifest: { credential: { path: 'oauth.json', sha256: 'c'.repeat(64), byteLength: Buffer.byteLength(oauth) } } });
  assert.deepEqual(await capture(badHash), invalid, 'credential hash');
  const badSize = provision(t, { manifest: { credential: { path: 'oauth.json', sha256: sha(oauth), byteLength: 5 } } });
  assert.deepEqual(await capture(badSize), invalid, 'credential size');
  const badFormat = provision(t, { credential: '{"nope":1}' });
  assert.deepEqual(await capture(badFormat), invalid, 'format');
  const extra = provision(t, { extra: true });
  assert.deepEqual(await capture(extra), invalid, 'extra file');
  const wrongClient = provision(t, { manifest: { client: 'codex' } });
  assert.deepEqual(await capture(wrongClient), invalid, 'manifest schema');
});

test('a changed source after capture fails the recheck', async t => {
  const p = provision(t);
  const captured = await capture(p);
  writeFileSync(join(p.root, 'oauth.json'), oauth.replace('fake-access', 'fake-other-'));
  assert.equal(await captured.recheck(), false);
});

test('a linked credential file is refused', async t => {
  const p = provision(t, { credential: null });
  writeFileSync(join(p.cell.scratch, 'real.json'), oauth);
  try { symlinkSync(join(p.cell.scratch, 'real.json'), join(p.root, 'oauth.json')); } catch { t.skip('links not permitted'); return; }
  const result = await capture(p);
  assert.equal(result.status, 'unavailable');
});

test('group- or world-readable files are refused on POSIX', { skip: process.platform === 'win32' && 'POSIX only' }, async t => {
  const p = provision(t);
  chmodSync(join(p.root, 'oauth.json'), 0o644);
  assert.deepEqual(await capture(p), { status: 'unavailable', reason: 'identity-binding-invalid' });
});
