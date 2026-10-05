import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { publishNativeAdmission } from '../../src/harness/native/admission.mjs';

test('admission instrumentation retains only fixed proof fields and counts', () => {
  const records = [], sink = value => records.push(value), stream = channel('aih.native.admission.v1');
  stream.subscribe(sink);
  try {
    publishNativeAdmission({ phase: 'session', index: 1, definition: 'claude-linux-x64-wsl2-srt-2.1.285',
      vendorTreeSha256: 'a'.repeat(64), innerArgv: ['claude', '--tools', ''], outerArgv: ['node', '/private/runner', '/private/plan'],
      isolation: { baseSha256: 'b'.repeat(64), profileSha256: 'c'.repeat(64), compared: true, authenticated: true,
        clientBound: true, serverBound: true, namespaceSeparated: true, argumentsClean: true, argumentsInspected: 42,
        ended: true, outcome: 'observed', probes: { outsideReadDenied: true }, secret: 'credential-marker' },
      restrictions: { listedBuiltins: 1, listedUnselected: 2, unrequestedCalls: 0, unsafeCount: 'tool-marker' },
      cleanupConfirmed: true, identity: 'identity-marker' });
    assert.equal(records.length, 1);
    const result = records[0];
    assert.equal(result.isolation.baseSha256, 'b'.repeat(64));
    assert.equal(result.isolation.profileSha256, 'c'.repeat(64));
    assert.equal(result.isolation.compared, true);
    assert.equal(result.restrictions.listedUnselected, 2);
    assert.match(result.outerArgvSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.acceptedLimitation, 'vendor-local-proxy-capability-in-argv');
    for (const privateValue of ['credential-marker', 'identity-marker', 'tool-marker', '/private/'])
      assert.equal(JSON.stringify(result).includes(privateValue), false);
    assert.ok(Object.isFrozen(result.isolation));
    assert.ok(Object.isFrozen(result));
  } finally { stream.unsubscribe(sink); }
});

test('admission instrumentation turns missing and malformed proof fields into absence', () => {
  const records = [], sink = value => records.push(value), stream = channel('aih.native.admission.v1');
  stream.subscribe(sink);
  try {
    publishNativeAdmission({ phase: 'version', definition: 'untrusted-name', isolation: { baseSha256: 'secret', outcome: 'secret',
      argumentsInspected: Infinity, probes: { outsideReadDenied: 'secret' } }, restrictions: { listedBuiltins: -1 } });
    assert.equal(records[0].definition, null);
    assert.equal(records[0].isolation.baseSha256, null);
    assert.equal(records[0].isolation.argumentsInspected, 0);
    assert.equal(records[0].isolation.outcome, 'unobservable');
    assert.equal(records[0].isolation.probes.outsideReadDenied, null);
    assert.equal(JSON.stringify(records[0]).includes('secret'), false);
  } finally { stream.unsubscribe(sink); }
});
