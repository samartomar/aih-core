import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { publishNativeAdmission } from '../../src/harness/native/admission.mjs';
import * as admission from '../../src/harness/native/admission.mjs';

const emptyCollector = {
  requests: 0, accepted: 0,
  rejected: { auth: 0, method: 0, path: 0, contentType: 0, contentEncoding: 0, size: 0, parse: 0, other: 0 },
  contentTypes: { json: 0, protobuf: 0, other: 0, none: 0 }, contentEncodings: { none: 0, gzip: 0, other: 0 },
  events: 0, eventNames: { apiRequest: 0, apiError: 0, userPrompt: 0, assistantResponse: 0, toolResult: 0, toolDecision: 0, other: 0 },
  apiRequestRejected: { missingRequestId: 0, notSuccess: 0, missingSession: 0, wrongSession: 0,
    accountMissing: 0, accountDifferent: 0, organizationMissing: 0, organizationDifferent: 0, outsideWindow: 0 },
  identityByEvent: { accountPresent: 0, accountMatches: 0, organizationPresent: 0, organizationMatches: 0 }, firstMatchingEventIndex: null,
  ignored: 0, matched: 0,
  duplicates: 0, wrongSession: 0, conflict: false
};

test('session diagnostics publish an exact deeply frozen counts-only record with closed vocabularies', () => {
  assert.equal(typeof admission.publishNativeDiagnostics, 'function');
  const records = [], sink = value => records.push(value), stream = channel('aih.native.diagnostics.v1');
  stream.subscribe(sink);
  try {
    admission.publishNativeDiagnostics({ phase: 'version', index: 2, definition: 'claude-linux-x64-wsl2-srt-2.1.285',
      runSha256: 'a'.repeat(64), collector: { ...emptyCollector, requests: 5, accepted: 2, events: 2,
        rejected: { ...emptyCollector.rejected, auth: 1, contentType: 1, contentEncoding: 1, private: 'header-marker' },
        contentTypes: { json: 4, protobuf: 1, other: 0, none: 0 }, contentEncodings: { none: 4, gzip: 1, other: 0 },
        eventNames: { ...emptyCollector.eventNames, apiRequest: 1, userPrompt: 1, private: 'event-marker' },
        apiRequestRejected: { ...emptyCollector.apiRequestRejected, wrongSession: 1, accountMissing: 1, organizationDifferent: 1,
          identityMismatch: 9, private: 'reason-marker' },
        identityByEvent: { accountPresent: 2, accountMatches: 1, organizationPresent: 3, organizationMatches: 2, accountUuid: 'identity-marker' },
        firstMatchingEventIndex: 4,
        ignored: 1, matched: 1, secret: 'attribute-marker' },
      result: { resultSeen: true, resultIsError: true, resultSubtype: 'error_during_execution', text: 'result-marker' },
      token: 'token-marker' });
    assert.equal(records.length, 1);
    const record = records[0];
    assert.match(record.recordId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.deepEqual(record, {
      schema: 'aih.native.diagnostics.v1', event: 'native-session-diagnostics', recordId: record.recordId,
      runSha256: 'a'.repeat(64), phase: 'session', index: 2, definition: 'claude-linux-x64-wsl2-srt-2.1.285',
      collector: { ...emptyCollector, requests: 5, accepted: 2, events: 2,
        rejected: { auth: 1, method: 0, path: 0, contentType: 1, contentEncoding: 1, size: 0, parse: 0, other: 0 },
        contentTypes: { json: 4, protobuf: 1, other: 0, none: 0 }, contentEncodings: { none: 4, gzip: 1, other: 0 },
        eventNames: { ...emptyCollector.eventNames, apiRequest: 1, userPrompt: 1 },
        apiRequestRejected: { ...emptyCollector.apiRequestRejected, wrongSession: 1, accountMissing: 1, organizationDifferent: 1 },
        identityByEvent: { accountPresent: 2, accountMatches: 1, organizationPresent: 3, organizationMatches: 2 }, firstMatchingEventIndex: 4,
        ignored: 1, matched: 1 },
      proxy: null, forwarder: null, result: { seen: true, isError: true, subtype: 'error_during_execution', errorClass: 'none' }
    });
    const inspect = value => {
      assert.ok(Object.isFrozen(value));
      for (const nested of Object.values(value)) if (nested !== null && typeof nested === 'object') inspect(nested);
    };
    inspect(record);
    for (const secret of ['header-marker', 'attribute-marker', 'event-marker', 'reason-marker', 'result-marker', 'token-marker', 'identity-marker', 'identityMismatch'])
      assert.equal(JSON.stringify(record).includes(secret), false);

    admission.publishNativeDiagnostics({ index: 'secret', definition: 'secret', runSha256: 'secret',
      collector: { requests: 1000001, accepted: -1, events: Infinity, matched: 1.5, ignored: 'secret', conflict: 'true',
        rejected: { auth: Number.MAX_SAFE_INTEGER, parse: NaN },
        eventNames: { apiRequest: 1000001, apiError: -1, userPrompt: Number.MAX_SAFE_INTEGER,
          assistantResponse: Infinity, toolResult: 1.5, toolDecision: 4, other: 'secret' },
        apiRequestRejected: { missingRequestId: 1000001, notSuccess: -1, missingSession: Number.MAX_SAFE_INTEGER,
          wrongSession: NaN, accountMissing: 1.5, accountDifferent: 1000001, organizationMissing: -1, organizationDifferent: Infinity, outsideWindow: 3 },
        identityByEvent: { accountPresent: Number.MAX_SAFE_INTEGER, accountMatches: -1, organizationPresent: NaN, organizationMatches: 1.5 },
        firstMatchingEventIndex: Number.MAX_SAFE_INTEGER },
      result: { resultSeen: true, resultIsError: 'true', resultSubtype: 'secret' } });
    assert.deepEqual(records[1], {
      schema: 'aih.native.diagnostics.v1', event: 'native-session-diagnostics', recordId: records[1].recordId,
      runSha256: null, phase: 'session', index: 1, definition: null,
      collector: { ...emptyCollector, requests: 1000000, rejected: { ...emptyCollector.rejected, auth: 1000000 },
        eventNames: { ...emptyCollector.eventNames, apiRequest: 1000000, userPrompt: 1000000, toolDecision: 4 },
        apiRequestRejected: { ...emptyCollector.apiRequestRejected, missingRequestId: 1000000, missingSession: 1000000, accountDifferent: 1000000, outsideWindow: 3 },
        identityByEvent: { ...emptyCollector.identityByEvent, accountPresent: 1000000 }, firstMatchingEventIndex: 1000000 },
      proxy: null, forwarder: null, result: { seen: true, isError: null, subtype: 'other', errorClass: 'none' }
    });
    for (const subtype of ['success', 'error_max_turns', 'error_during_execution', 'other']) {
      admission.publishNativeDiagnostics({ result: { resultSeen: true, resultIsError: false, resultSubtype: subtype } });
      assert.deepEqual(records.at(-1).result, { seen: true, isError: false, subtype, errorClass: 'none' });
    }
    admission.publishNativeDiagnostics({ result: { resultSeen: true, resultIsError: null, resultSubtype: null } });
    assert.deepEqual(records.at(-1).result, { seen: true, isError: null, subtype: 'other', errorClass: 'none' });
    admission.publishNativeDiagnostics({});
    assert.deepEqual(records.at(-1).collector, emptyCollector);
    assert.deepEqual(records.at(-1).result, { seen: false, isError: null, subtype: 'none', errorClass: 'none' });
    for (const firstMatchingEventIndex of [undefined, null, 0, -1, 1.5, NaN, Infinity, 'identity-marker', Number.MAX_SAFE_INTEGER + 1]) {
      admission.publishNativeDiagnostics({ collector: { firstMatchingEventIndex } });
      assert.equal(records.at(-1).collector.firstMatchingEventIndex, null);
    }
    admission.publishNativeDiagnostics({ definition: 'claude-win32-x64-2.1.285' });
    assert.equal(records.at(-1).definition, 'claude-win32-x64-2.1.285');
  } finally { stream.unsubscribe(sink); }
});

test('session forwarder diagnostics are Linux-only, clamped, exact-key and frozen', () => {
  const records = [], sink = value => records.push(value), stream = channel('aih.native.diagnostics.v1');
  stream.subscribe(sink);
  try {
    const forwarder = { accepted: 1000001, connected: 2, refused: -1, capped: Infinity, payload: 'payload-marker' };
    admission.publishNativeDiagnostics({ definition: 'claude-linux-x64-wsl2-srt-2.1.285', forwarder });
    assert.deepEqual(records[0].forwarder, { accepted: 1000000, connected: 2, refused: 0, capped: 0 });
    assert.ok(Object.isFrozen(records[0].forwarder));
    assert.equal(JSON.stringify(records[0]).includes('payload-marker'), false);
    for (const definition of ['claude-win32-x64-2.1.285', 'darwin', undefined]) {
      admission.publishNativeDiagnostics({ definition, forwarder });
      assert.equal(records.at(-1).forwarder, null);
    }
    for (const forwarder of [undefined, null, 'payload-marker', []]) {
      admission.publishNativeDiagnostics({ definition: 'claude-linux-x64-wsl2-srt-2.1.285', forwarder });
      assert.equal(records.at(-1).forwarder, null);
    }
  } finally { stream.unsubscribe(sink); }
});

test('session diagnostics clamp and freeze proxy buckets and admit only closed provider error classes', () => {
  const records = [], sink = value => records.push(value), stream = channel('aih.native.diagnostics.v1');
  stream.subscribe(sink);
  try {
    admission.publishNativeDiagnostics({ proxy: { apiAnthropic: { allowed: 1000001, denied: 2, host: 'host-marker' },
      claudeAi: { allowed: -1, denied: 1.5 }, platformClaude: { allowed: Infinity, denied: NaN },
      consoleAnthropic: { allowed: 1, denied: 4 }, otherAnthropic: { allowed: 0, denied: 5 },
      collector: { allowed: 3, denied: 0 }, other: { allowed: 'host-marker', denied: Number.MAX_SAFE_INTEGER },
      'private-host.invalid': { allowed: 10 } }, result: { errorClass: 'authentication' } });
    assert.deepEqual(records[0].proxy, {
      apiAnthropic: { allowed: 1000000, denied: 2 }, claudeAi: { allowed: 0, denied: 0 },
      platformClaude: { allowed: 0, denied: 0 }, consoleAnthropic: { allowed: 1, denied: 4 },
      otherAnthropic: { allowed: 0, denied: 5 }, collector: { allowed: 3, denied: 0 }, other: { allowed: 0, denied: 1000000 }
    });
    assert.equal(records[0].result.errorClass, 'authentication', 'an assistant error may precede any result');
    assert.ok(Object.isFrozen(records[0].proxy));
    for (const pair of Object.values(records[0].proxy)) assert.ok(Object.isFrozen(pair));
    for (const marker of ['host-marker', 'private-host.invalid']) assert.equal(JSON.stringify(records[0]).includes(marker), false);
    for (const errorClass of ['none', 'authentication', 'forbidden', 'rate-limit', 'overloaded', 'network', 'other']) {
      admission.publishNativeDiagnostics({ result: { errorClass } });
      assert.equal(records.at(-1).result.errorClass, errorClass);
      assert.equal(records.at(-1).proxy, null);
    }
    for (const errorClass of ['secret-marker', null, 403, {}, undefined]) {
      admission.publishNativeDiagnostics({ proxy: 'secret-marker', result: { errorClass } });
      assert.equal(records.at(-1).result.errorClass, 'none');
      assert.equal(records.at(-1).proxy, null);
    }
  } finally { stream.unsubscribe(sink); }
});

test('session diagnostics do not read inputs or publish without a subscriber', () => {
  assert.equal(typeof admission.publishNativeDiagnostics, 'function');
  const stream = channel('aih.native.diagnostics.v1');
  assert.equal(stream.hasSubscribers, false);
  const original = stream.publish;
  stream.publish = () => { throw new Error('unexpected publication'); };
  try {
    const input = new Proxy({}, { get: () => { throw new Error('unexpected input read'); } });
    assert.doesNotThrow(() => admission.publishNativeDiagnostics(input));
  } finally { stream.publish = original; }
});

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
