import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { publishNativeAdmission } from '../../src/harness/native/admission.mjs';
import * as admission from '../../src/harness/native/admission.mjs';

test('persistence diagnostics publish one bounded frozen counts/tokens-only record', () => {
  const records = [], stream = channel('aih.native.diagnostics.v1'), sink = value => records.push(value);
  stream.subscribe(sink);
  try {
    assert.equal(typeof admission.publishNativePersistenceDiagnostics, 'function');
    admission.publishNativePersistenceDiagnostics({ runSha256: 'a'.repeat(64), stage: 'before-session-2',
      class: 'unexpected-entry', items: Array.from({ length: 20 }, () => ({ root: 'home', depth: 2, kind: 'dir',
        token: 'todos', path: 'privacy-canary-path', contents: 'privacy-canary-value' })), truncated: false,
      inspectedDiagnosis: { reason: 'unknown-global-key', token: 'unknown-1', value: 'privacy-canary-value' } });
    const record = records[0];
    assert.deepEqual(Object.keys(record).sort(), ['class', 'event', 'inspectedDiagnosis', 'items', 'phase',
      'recordId', 'runSha256', 'schema', 'stage', 'truncated'].sort());
    assert.equal(record.event, 'native-persistence-diagnostics'); assert.equal(record.phase, 'persistence');
    assert.equal(record.stage, 'before-session-2'); assert.equal(record.class, 'unexpected-entry');
    assert.equal(record.runSha256, 'a'.repeat(64)); assert.match(record.recordId, /^[a-f0-9-]{36}$/);
    assert.equal(record.items.length, 16); assert.equal(record.truncated, true);
    assert.deepEqual(record.items[0], { root: 'home', depth: 2, kind: 'dir', token: 'todos' });
    assert.deepEqual(record.inspectedDiagnosis, { reason: 'unknown-global-key', token: 'unknown-1' });
    for (const value of [record, record.items, ...record.items, record.inspectedDiagnosis]) assert.ok(Object.isFrozen(value));
    assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 4096);
    assert.equal(JSON.stringify(record).includes('privacy-canary'), false);
  } finally { stream.unsubscribe(sink); }
});

test('persistence publisher rejects open classes and redacts non-dictionary tokens', () => {
  const records = [], stream = channel('aih.native.diagnostics.v1'), sink = value => records.push(value);
  stream.subscribe(sink);
  try {
    admission.publishNativePersistenceDiagnostics({ class: 'privacy-canary', stage: 'before-session-2' });
    admission.publishNativePersistenceDiagnostics({ class: 'limit', stage: 'privacy-canary' });
    assert.deepEqual(records, []);
    admission.publishNativePersistenceDiagnostics({ class: 'limit', stage: 'after-session-2', runSha256: 'privacy-canary',
      items: [{ root: 'privacy-canary', depth: 1000000, kind: 'privacy-canary', token: 'privacy-canary' }],
      inspectedDiagnosis: { reason: 'read-failure', token: 'privacy-canary', value: 'privacy-canary' } });
    assert.deepEqual(records[0].items, [{ root: 'home', depth: 64, kind: 'other', token: 'unknown-1' }]);
    assert.deepEqual(records[0].inspectedDiagnosis, { reason: 'read-failure', token: null });
    assert.equal(records[0].runSha256, null); assert.equal(records[0].truncated, true);
    assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
    admission.publishNativePersistenceDiagnostics({ class: 'pins', stage: 'before-session-2',
      items: [{ root: 'project', depth: 1, kind: 'file', token: 'unknown-999999' }],
      inspectedDiagnosis: { reason: 'privacy-canary', token: 'todos' } });
    assert.equal(records[1].items[0].token, 'unknown-999999'); assert.equal(records[1].inspectedDiagnosis, null);
    assert.equal(records[1].truncated, false);
    admission.publishNativePersistenceDiagnostics({ class: 'pins', stage: 'before-session-2',
      items: Array.from({ length: 16 }, () => ({ root: 'project', depth: 64, kind: 'other', token: 'hasClaudeMdExternalIncludesApproved' })) });
    assert.ok(Buffer.byteLength(JSON.stringify(records[2])) <= 4096);
  } finally { stream.unsubscribe(sink); }
});

test('persistence publisher does not inspect input without a subscriber', () => {
  const stream = channel('aih.native.diagnostics.v1'); assert.equal(stream.hasSubscribers, false);
  const input = new Proxy({}, { get() { throw Error('private input'); } });
  assert.doesNotThrow(() => admission.publishNativePersistenceDiagnostics(input));
});

test('authentication diagnostics use exact clamped counts and closed proof kinds in both channels', () => {
  const diagnostics = [], evidence = [];
  const ds = channel('aih.native.diagnostics.v1'), es = channel('aih.native.admission.v1');
  const d = record => diagnostics.push(record), e = record => evidence.push(record);
  ds.subscribe(d); es.subscribe(e);
  try {
    for (const authenticationProofKind of ['telemetry-identity', 'provisioning-bound-session', null, 'secret-marker']) {
      const input = { authenticationProofKind, collector: { authenticationProofKind, boundSessionEvents: 1000001,
        qualifyingSuccesses: { telemetryIdentity: 1000001, provisioningBound: -1, secret: 'secret-marker' },
        apiRequestIdentity: { accountAbsent: 1000001, organizationAbsent: 3, accountDifferent: 1.5,
          organizationDifferent: Infinity, invalidAttribute: 2, secret: 'secret-marker' } } };
      admission.publishNativeDiagnostics(input); admission.publishNativeAdmission(input);
      const record = diagnostics.at(-1).collector;
      const expected = authenticationProofKind === 'secret-marker' ? null : authenticationProofKind;
      assert.equal(record.authenticationProofKind, expected);
      assert.equal(evidence.at(-1).authenticationProofKind, expected);
      assert.equal(record.boundSessionEvents, 1000000);
      assert.deepEqual(record.qualifyingSuccesses, { telemetryIdentity: 1000000, provisioningBound: 0 });
      assert.deepEqual(record.apiRequestIdentity, { accountAbsent: 1000000, organizationAbsent: 3,
        accountDifferent: 0, organizationDifferent: 0, invalidAttribute: 2 });
      assert.ok(Object.isFrozen(record.qualifyingSuccesses));
      assert.ok(Object.isFrozen(record.apiRequestIdentity));
      assert.equal(JSON.stringify(diagnostics.at(-1)).includes('secret-marker'), false);
    }
  } finally { ds.unsubscribe(d); es.unsubscribe(e); }
});

const emptyCollector = {
  requests: 0, accepted: 0,
  rejected: { auth: 0, method: 0, path: 0, contentType: 0, contentEncoding: 0, size: 0, parse: 0, other: 0 },
  contentTypes: { json: 0, protobuf: 0, other: 0, none: 0 }, contentEncodings: { none: 0, gzip: 0, other: 0 },
  events: 0, eventNames: { apiRequest: 0, apiError: 0, userPrompt: 0, assistantResponse: 0, toolResult: 0, toolDecision: 0, other: 0 },
  apiRequestRejected: { missingRequestId: 0, notSuccess: 0, missingSession: 0, wrongSession: 0,
    outsideWindow: 0 },
  apiRequestIdentity: { accountAbsent: 0, organizationAbsent: 0, accountDifferent: 0, organizationDifferent: 0, invalidAttribute: 0 },
  qualifyingSuccesses: { telemetryIdentity: 0, provisioningBound: 0 }, boundSessionEvents: 0, authenticationProofKind: null,
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
        apiRequestRejected: { ...emptyCollector.apiRequestRejected, wrongSession: 1,
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
        apiRequestRejected: { ...emptyCollector.apiRequestRejected, wrongSession: 1 },
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
        apiRequestRejected: { ...emptyCollector.apiRequestRejected, missingRequestId: 1000000, missingSession: 1000000, outsideWindow: 3 },
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
