import assert from 'node:assert/strict';
import test from 'node:test';
import { observeNativePlatform, selectNativeCell, matchClientVersion, parseClaudeVersionOutput } from '../../src/harness/native/select.mjs';
import { nativeClientIds, nativeVerificationDefinitions } from '../../src/harness/native/contracts.mjs';

const win = { os: 'win32', arch: 'x64', osRelease: '10.0.26200', execution: 'native' };
const linux = { os: 'linux', arch: 'x64', osRelease: '6.8.0', execution: 'native' };

test('platform observation names OS, arch, release and WSL2 execution', () => {
  assert.deepEqual(observeNativePlatform({ platform: 'win32', arch: 'x64', release: '10.0.26200' }), win);
  assert.deepEqual(observeNativePlatform({ platform: 'linux', arch: 'arm64', release: '5.15.0-microsoft-standard-WSL2' }),
    { os: 'linux', arch: 'arm64', osRelease: '5.15.0-microsoft-standard-WSL2', execution: 'wsl2' });
  assert.deepEqual(observeNativePlatform({ platform: 'freebsd', arch: 'x64', release: '14' }),
    { os: 'unsupported', arch: 'x64', osRelease: '14', execution: 'native' });
});

test('every roster client except Claude is client-unsupported, retaining all eleven ids', async () => {
  assert.equal(nativeClientIds.length, 11);
  for (const client of nativeClientIds.filter(id => id !== 'claude'))
    assert.deepEqual(await selectNativeCell({ client, admission: 'candidate-smoke', platform: win }), { outcome: 'unsupported', reason: 'client-unsupported' });
});

test('a normal admitted call never selects a candidate', async () => {
  assert.deepEqual(await selectNativeCell({ client: 'claude', admission: 'admitted', platform: win }), { outcome: 'unsupported', reason: 'cell-not-admitted' });
});

test('a platform that does not match the descriptor is platform-unsupported', async () => {
  assert.deepEqual(await selectNativeCell({ client: 'claude', admission: 'candidate-smoke', platform: linux }), { outcome: 'unsupported', reason: 'platform-unsupported' });
  assert.deepEqual(await selectNativeCell({ client: 'claude', admission: 'candidate-smoke', platform: { ...win, osRelease: '10.0.1' } }), { outcome: 'unsupported', reason: 'platform-unsupported' });
  assert.deepEqual(await selectNativeCell({ client: 'claude', admission: 'candidate-smoke', platform: { ...win, arch: 'arm64' } }), { outcome: 'unsupported', reason: 'platform-unsupported' });
});

test('the Windows candidate awaits the actual bounded platform probe', async () => {
  const result = await selectNativeCell({ client: 'claude', admission: 'candidate-smoke', platform: win });
  if (process.platform === 'win32' && process.arch === 'x64') assert.equal(result.outcome, 'selected');
  else assert.deepEqual(result, { outcome: 'unsupported', reason: 'platform-unsupported', missing: 'windows-job.v1' });
});

test('a matching platform with an available lifecycle selects the descriptor and its identity', async () => {
  const definition = { ...nativeVerificationDefinitions[0], platform: linux, lifecycleId: 'posix-group.v1' };
  const result = await selectNativeCell({ client: 'claude', admission: 'candidate-smoke', platform: linux, definitions: [definition] });
  assert.equal(result.outcome, 'selected');
  assert.equal(result.definition.id, definition.id);
  assert.match(result.adapter.sha256, /^[0-9a-f]{64}$/);
  const admitted = { ...definition, state: 'admitted', evidenceSha256: 'e'.repeat(64) };
  assert.equal((await selectNativeCell({ client: 'claude', admission: 'admitted', platform: linux, definitions: [admitted] })).outcome, 'selected');
});

test('client versions match exactly: no ranges, no inherited upgrades', () => {
  const definition = nativeVerificationDefinitions[0];
  assert.deepEqual(matchClientVersion(definition, '2.1.285'), { outcome: 'matched' });
  for (const other of ['2.1.286', '2.1.28', '2.1.2850', '3.0.0'])
    assert.deepEqual(matchClientVersion(definition, other), { outcome: 'unsupported', reason: 'version-unsupported' });
  assert.deepEqual(matchClientVersion(definition, null), { outcome: 'unavailable', reason: 'version-unreadable' });
});

test('Claude version output parsing is strict and bounded', () => {
  assert.equal(parseClaudeVersionOutput('2.1.285 (Claude Code)\n'), '2.1.285');
  assert.equal(parseClaudeVersionOutput('2.1.285'), '2.1.285');
  for (const bad of ['', 'Claude 2.1.285', '2.1', 'x'.repeat(300), '2.1.285 (Claude Code)\nextra', null])
    assert.equal(parseClaudeVersionOutput(bad), null, String(bad).slice(0, 20));
});
