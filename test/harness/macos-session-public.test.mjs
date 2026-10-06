import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMacosSessionLaunchAgent, observeMacosGuiSession, observeMacosApplication } from '../../src/harness/macos-session-public.mjs';

test('public session boundary rejects accessors and proxies without invoking caller code', async () => {
  let calls = 0;
  const getter = { get key() { calls++; return 'NODE_EXTRA_CA_CERTS'; } };
  assert.equal(renderMacosSessionLaunchAgent(getter).status, 'invalid');
  const proxy = new Proxy({}, { getPrototypeOf() { calls++; throw new Error(); } });
  assert.equal(renderMacosSessionLaunchAgent({ desired: proxy }).status, 'invalid');
  assert.equal((await observeMacosApplication(getter)).status, 'unavailable');
  assert.equal((await observeMacosGuiSession({ get signal() { calls++; return undefined; } })).status, 'unavailable');
  assert.equal(calls, 0);
});

test('public observers do not accept a caller host adapter', { skip: process.platform === 'darwin' }, async () => {
  let calls = 0;
  const result = await observeMacosGuiSession({}, { platform: 'darwin', uid() { calls++; return 502; }, run() { calls++; } });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'session-platform-unsupported');
  assert.equal(calls, 0);
});
