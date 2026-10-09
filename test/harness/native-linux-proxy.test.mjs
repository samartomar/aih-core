import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinuxProxyDiagnostics, observeLinuxProxyDiagnostics } from '../../src/harness/native/linux-proxy.mjs';
import { SandboxViolationStore } from '../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-violation-store.js';
import { logForDebugging } from '../../node_modules/@anthropic-ai/sandbox-runtime/dist/utils/debug.js';

test('trusted SRT decisions reduce every host to fixed buckets without retaining log text', () => {
  const counter = createLinuxProxyDiagnostics('http://127.0.0.1:43210/v1/logs');
  const hosts = ['api.anthropic.com:443', 'claude.ai:443', 'platform.claude.com:443',
    'console.anthropic.com:443', 'oauth.anthropic.com:443', '127.0.0.1:43210', 'unrelated.invalid:443'];
  for (const host of hosts) {
    counter.log(`[SandboxDebug] Allowed by config rule: ${host}`);
    counter.violation(`deny network-outbound ${host} (opaque secret-marker)`);
  }
  assert.deepEqual(counter.snapshot(), {
    apiAnthropic: { allowed: 1, denied: 1 }, claudeAi: { allowed: 1, denied: 1 },
    platformClaude: { allowed: 1, denied: 1 }, consoleAnthropic: { allowed: 1, denied: 1 },
    otherAnthropic: { allowed: 1, denied: 1 }, collector: { allowed: 1, denied: 1 }, other: { allowed: 1, denied: 1 }
  });
  counter.log('[SandboxDebug] unrelated log secret-marker');
  counter.violation('deny open /private/secret-marker');
  const snapshot = counter.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  for (const pair of Object.values(snapshot)) assert.ok(Object.isFrozen(pair));
  for (const text of [...hosts, 'secret-marker']) assert.equal(JSON.stringify(snapshot).includes(text), false);
  assert.equal(snapshot.other.allowed, 1);
  assert.equal(snapshot.other.denied, 1);
});

test('proxy buckets require exact collector authority and provider names, normalizing DNS case and final dot', () => {
  const counter = createLinuxProxyDiagnostics('http://127.0.0.1:43210/v1/logs');
  for (const host of ['API.ANTHROPIC.COM.:443', 'api.anthropic.com.evil.invalid:443',
    'evil-anthropic.com:443', '127.0.0.1:43211', '[::1]:43210']) {
    counter.log(`[SandboxDebug] Allowed by config rule: ${host}`);
  }
  counter.violation('deny network-outbound malformed host:443 (malformed host)');
  assert.equal(counter.snapshot().apiAnthropic.allowed, 1);
  assert.equal(counter.snapshot().collector.allowed, 0);
  assert.deepEqual(counter.snapshot().other, { allowed: 4, denied: 1 });
  counter.log('[SandboxDebug] Allowed by config rule: api.anthropic.com:443\nsecret-marker');
  assert.equal(counter.snapshot().apiAnthropic.allowed, 1);
});

test('runner monitoring consumes supported debug logs and violation-store notifications without emitting raw logs', () => {
  const store = new SandboxViolationStore();
  const originalError = console.error, originalWarn = console.warn, originalDebug = process.env.SRT_DEBUG;
  const observer = observeLinuxProxyDiagnostics(store, 'http://127.0.0.1:43210/v1/logs');
  try {
    assert.equal(process.env.SRT_DEBUG, '1');
    logForDebugging('Allowed by config rule: api.anthropic.com:443');
    logForDebugging('unrelated credential-marker');
    logForDebugging('unrelated credential-marker', { level: 'warn' });
    for (let i = 0; i < 102; i++) store.addViolation({ line: 'deny network-outbound console.anthropic.com:443 (denied)', timestamp: new Date() });
    store.clear();
    store.addViolation({ line: 'deny network-outbound toString:443 (denied)', timestamp: new Date() });
    assert.equal(observer.snapshot().apiAnthropic.allowed, 1);
    assert.equal(observer.snapshot().consoleAnthropic.denied, 102, 'notifications count decisions beyond the store tail');
    assert.equal(observer.snapshot().other.denied, 1);
  } finally { observer.stop(); }
  assert.equal(console.error, originalError);
  assert.equal(console.warn, originalWarn);
  assert.equal(process.env.SRT_DEBUG, originalDebug);
  store.addViolation({ line: 'deny network-outbound console.anthropic.com:443 (denied)', timestamp: new Date() });
  assert.equal(observer.snapshot().consoleAnthropic.denied, 102);
});

test('runner monitoring surfaces a fixed content-free signal for genuine non-debug SRT warnings and errors', () => {
  const store = new SandboxViolationStore();
  const emitted = [];
  const originalError = console.error, originalWarn = console.warn, originalDebug = process.env.SRT_DEBUG;
  try {
    const outer = (...args) => { emitted.push(args); };
    console.error = console.warn = outer;
    const observer = observeLinuxProxyDiagnostics(store, 'http://127.0.0.1:43210/v1/logs');
    // SRT pairs a direct console.warn with a [SandboxDebug]-prefixed duplicate; only the direct one is genuine.
    const raw = '[sandbox-runtime] WARNING: credentials.envVars entry "credential-marker" is left UNPROTECTED';
    console.warn(raw);
    logForDebugging(raw, { level: 'warn' });
    console.error(new Error('credential-marker failure'));
    logForDebugging('Allowed by config rule: api.anthropic.com:443');
    assert.equal(emitted.length, 1, 'one fixed signal, debug-prefixed lines stay silent');
    assert.deepEqual(emitted[0], ['sandbox-runtime or runner reported a warning or error; details withheld from the trusted runner.']);
    assert.doesNotMatch(JSON.stringify(emitted), /credential-marker|envVars/);
    assert.equal(observer.snapshot().apiAnthropic.allowed, 1, 'counting is unchanged');
    observer.stop();
    assert.equal(console.error, outer);
    assert.equal(console.warn, outer);
    assert.equal(process.env.SRT_DEBUG, originalDebug);
  } finally {
    console.error = originalError; console.warn = originalWarn;
    if (originalDebug === undefined) delete process.env.SRT_DEBUG; else process.env.SRT_DEBUG = originalDebug;
  }
});
