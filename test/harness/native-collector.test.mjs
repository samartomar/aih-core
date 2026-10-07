import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { createClaudeCollector } from '../../src/harness/native/collector.mjs';

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '1f8fad5b-d9cb-469f-a165-70867728950e';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'someone@example.com';
const expected = { accountUuid: ACCOUNT, organizationId: ORG };
const emptyEventNames = { apiRequest: 0, apiError: 0, userPrompt: 0, assistantResponse: 0, toolResult: 0, toolDecision: 0, other: 0 };
const emptyApiRequestRejected = { missingRequestId: 0, notSuccess: 0, missingSession: 0, wrongSession: 0, identityMismatch: 0, outsideWindow: 0 };

const attr = (key, value) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } });
const event = ({ name = 'api_request', session = SID, request = 'req_1', account = ACCOUNT, org = ORG, at = Date.now() } = {}) => ({
  timeUnixNano: String(BigInt(at) * 1000000n),
  attributes: [attr('event.name', name), attr('session.id', session), attr('request_id', request),
    attr('user.account_uuid', account), attr('organization.id', org), attr('user.email', EMAIL), attr('model', 'secret-model')]
});
const body = (...events) => JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: events }] }] });

function post(collector, { path = '/v1/logs', method = 'POST', headers = {}, payload = body(event()), auth = true } = {}) {
  const url = new URL(collector.endpoint);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path, method, headers: {
      'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${collector.token}` } : {}), ...headers } },
    res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(payload);
  });
}
const times = () => ({ launchedAtMs: Date.now() - 5000, closedAtMs: Date.now() + 5000 });
const make = (options = {}) => createClaudeCollector({ sessionId: SID, expected, ...options });

test('diagnostics count HTTP rejection reasons and ignored and matched events without retaining content', async t => {
  const c = make();
  await c.start();
  t.after(() => c.cancel());
  assert.equal(await post(c, { auth: false }), 401);
  assert.equal(await post(c, { headers: { 'content-encoding': 'gzip' } }), 415);
  assert.equal(await post(c, { headers: { 'content-type': 'application/x-protobuf' } }), 415);
  assert.equal(await post(c, { payload: body(event({ name: 'claude_code.tool_result' })) }), 200);
  assert.equal(await post(c), 200);
  const result = await c.drain({ ...times(), timeoutMs: 0 });
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.counts, { requests: 2, events: 2, matched: 1, wrongSession: 0, duplicates: 0, ignored: 1 });
  assert.deepEqual(result.stats, {
    requests: 5, accepted: 2,
    rejected: { auth: 1, method: 0, path: 0, contentType: 1, contentEncoding: 1, size: 0, parse: 0, other: 0 },
    contentTypes: { json: 4, protobuf: 1, other: 0, none: 0 }, contentEncodings: { none: 4, gzip: 1, other: 0 },
    events: 2, eventNames: { ...emptyEventNames, apiRequest: 1, toolResult: 1 },
    apiRequestRejected: emptyApiRequestRejected, ignored: 1, matched: 1,
    duplicates: 0, wrongSession: 0, conflict: false
  });
  assert.deepEqual(c.snapshot(times()).stats, result.stats);
  for (const secret of [EMAIL, ACCOUNT, ORG, 'secret-model', c.token, 'req_1', 'claude_code.tool_result'])
    assert.equal(JSON.stringify(result.stats).includes(secret), false);
});

test('diagnostics classify api_error and unknown events while preserving ignored-success evidence', async t => {
  const c = make(); await c.start(); t.after(() => c.cancel());
  const failed = event({ request: 'failed' }); failed.attributes.push(attr('success', 'false'));
  assert.equal(await post(c, { payload: body(event({ name: 'claude_code.api_error' }),
    event({ name: 'client-private-name' }), failed, null) }), 200);
  const result = await c.drain({ ...times(), timeoutMs: 0 });
  assert.equal(result.reason, 'authentication-unavailable');
  assert.deepEqual(result.stats.eventNames, { ...emptyEventNames, apiRequest: 1, apiError: 1, other: 2 });
  assert.deepEqual(result.stats.apiRequestRejected, { ...emptyApiRequestRejected, notSuccess: 1 });
  assert.equal(result.stats.ignored, 4);
  assert.equal(result.stats.matched, 0);
  assert.equal(JSON.stringify(result.stats).includes('client-private-name'), false);
});

test('the isolated reachability probe uses a separate token and cannot establish identity', async () => {
  const c = make(); const started = await c.start();
  try {
    assert.match(started.probeToken, /^[a-f0-9]{64}$/);
    assert.notEqual(started.probeToken, c.token);
    assert.equal(await post(c, { method: 'GET', path: '/aih-native-probe', payload: '' }), 401);
    assert.equal(await post(c, { method: 'GET', path: '/aih-native-probe', payload: '',
      headers: { authorization: 'Bearer ' + started.probeToken } }), 200);
    const result = c.snapshot(times());
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.counts.events, 0);
    assert.equal(result.counts.requests, 0);
    assert.equal(result.stats.requests, 0);
    assert.equal(result.stats.accepted, 0);
    assert.equal(result.stats.rejected.auth, 0);
    assert.equal(JSON.stringify(result).includes(started.probeToken), false);
  } finally { await c.cancel(); }
});

test('a matched api_request event proves identity and retains no content', async () => {
  const c = make();
  await c.start();
  assert.match(c.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await post(c), 200);
  const result = await c.drain({ ...times(), timeoutMs: 500 });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.reason, 'observed');
  assert.deepEqual(result.counts, { requests: 1, events: 1, matched: 1, wrongSession: 0, duplicates: 0, ignored: 0 });
  const text = JSON.stringify(result);
  for (const secret of [EMAIL, ACCOUNT, ORG, 'secret-model', c.token, 'req_1']) assert.ok(!text.includes(secret), secret);
});

test('unauthorized, wrong-type, compressed and misrouted requests never count', async () => {
  const c = make();
  await c.start();
  assert.equal(await post(c, { auth: false }), 401);
  assert.equal(await post(c, { headers: { authorization: `Bearer ${'0'.repeat(64)}` } }), 401);
  assert.equal(await post(c, { headers: { 'content-type': 'text/plain' } }), 415);
  assert.equal(await post(c, { headers: { 'content-encoding': 'gzip' } }), 415);
  assert.equal(await post(c, { method: 'GET' }), 405);
  assert.equal(await post(c, { path: '/v1/metrics' }), 404);
  assert.equal(await post(c, { path: '/v1/logs?x=1' }), 404);
  const result = await c.drain({ ...times(), timeoutMs: 50 });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.reason, 'authentication-unavailable');
  assert.equal(result.counts.events, 0);
  assert.deepEqual(result.stats.rejected, { auth: 2, method: 1, path: 2, contentType: 1, contentEncoding: 1, size: 0, parse: 0, other: 0 });
});

test('deep, duplicate-key and malformed UTF-8 bodies are rejected without crashing the collector', async () => {
  const c = make();
  await c.start();
  try {
    for (const payload of [
      '{"nested":' + '['.repeat(20000) + '0' + ']'.repeat(20000) + '}',
      '{"resourceLogs":[],"resourceLogs":[]}',
      Buffer.from([0xff])
    ]) assert.equal(await post(c, { payload }), 400);
    assert.equal(await post(c), 200, 'the listener still handles a valid bounded event');
    const result = await c.drain({ ...times(), timeoutMs: 50 });
    assert.equal(result.reason, 'observed');
    assert.equal(result.counts.events, 1);
    assert.equal(result.stats.rejected.parse, 3);
  } finally { await c.cancel(); }
});

test('events for another session are mismatched evidence, not authentication', async () => {
  const c = make();
  await c.start();
  await post(c, { payload: body(event({ session: OTHER })) });
  const result = await c.drain({ ...times(), timeoutMs: 50 });
  assert.equal(result.reason, 'identity-session-mismatch');
  assert.equal(result.counts.wrongSession, 1);
  assert.equal(result.stats.wrongSession, 1);
  assert.deepEqual(result.stats.apiRequestRejected, { ...emptyApiRequestRejected, wrongSession: 1 });
});

test('a wrong-session event beside a match does not become an immediate identity negative', async () => {
  const c = make();
  await c.start();
  try {
    await post(c, { payload: body(event(), event({ session: OTHER, request: 'other-session' })) });
    const partial = c.snapshot(times());
    assert.equal(partial.outcome, 'unavailable');
    assert.equal(partial.reason, 'authentication-unavailable', 'positive authentication still needs final drain');
    assert.equal(partial.counts.matched, 1);
    assert.equal(partial.counts.wrongSession, 1);
    const final = await c.drain({ ...times(), timeoutMs: 50 });
    assert.equal(final.outcome, 'passed');
    assert.equal(final.reason, 'observed');
  } finally { await c.cancel(); }
});

test('a wrong account or organization conflicts even beside a good event', async () => {
  for (const bad of [{ account: '33333333-3333-4333-8333-333333333333' }, { org: '44444444-4444-4444-8444-444444444444' }]) {
    const c = make();
    await c.start();
    await post(c, { payload: body(event({ request: 'a' }), event({ request: 'b', ...bad })) });
    const result = await c.drain({ ...times(), timeoutMs: 50 });
    assert.equal(result.reason, 'identity-conflict');
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.stats.conflict, true);
    assert.deepEqual(result.stats.apiRequestRejected, { ...emptyApiRequestRejected, identityMismatch: 1 });
  }
});

test('identical duplicates count once and conflicting duplicates invalidate', async () => {
  const c = make();
  await c.start();
  await post(c, { payload: body(event(), event()) });
  const ok = await c.drain({ ...times(), timeoutMs: 50 });
  assert.equal(ok.outcome, 'passed');
  assert.equal(ok.counts.matched, 1);
  assert.equal(ok.counts.duplicates, 1);
  assert.equal(ok.stats.duplicates, 1);
  assert.deepEqual(ok.stats.apiRequestRejected, emptyApiRequestRejected);
  const d = make();
  await d.start();
  await post(d, { payload: body(event(), event({ account: '33333333-3333-4333-8333-333333333333' })) });
  const conflict = await d.drain({ ...times(), timeoutMs: 50 });
  assert.equal(conflict.reason, 'identity-conflict');
  assert.deepEqual(conflict.stats.apiRequestRejected, { ...emptyApiRequestRejected, identityMismatch: 1 });
});

test('only api_request events inside the launch-to-close window count', async () => {
  const c = make();
  await c.start();
  await post(c, { payload: body(event({ name: 'claude_code.tool_result', request: 'x' }), event({ request: 'late', at: Date.now() + 60000 }),
    event({ request: 'early', at: Date.now() - 60000 })) });
  const result = await c.drain({ ...times(), timeoutMs: 50 });
  assert.equal(result.reason, 'authentication-unavailable');
  assert.equal(result.counts.matched, 0);
  assert.equal(result.counts.ignored, 3);
  assert.equal(result.stats.ignored, 3);
  assert.deepEqual(result.stats.eventNames, { ...emptyEventNames, apiRequest: 2, toolResult: 1 });
  assert.deepEqual(result.stats.apiRequestRejected, { ...emptyApiRequestRejected, outsideWindow: 2 });
});

test('body-text names and other attributes cannot establish identity', async () => {
  const c = make(); await c.start();
  const fallback = event({ request: 'body' });
  fallback.attributes = fallback.attributes.filter(value => value.key !== 'event.name');
  fallback.body = { stringValue: 'claude_code.api_request' };
  const alias = event({ name: 'api-request', request: 'alias' });
  alias.attributes.push(attr('name', 'api_request'));
  await post(c, { payload: body(fallback, alias) });
  assert.equal(c.snapshot(times()).outcome, 'unavailable');
  assert.equal((await c.drain({ ...times(), timeoutMs: 0 })).reason, 'authentication-unavailable');
});

test('a snapshot preserves a known identity conflict and cannot finalize affirmative authentication', async () => {
  const c = make(); await c.start(); await post(c);
  assert.equal(c.snapshot(times()).outcome, 'unavailable');
  await post(c, { payload: body(event({ account: '33333333-3333-4333-8333-333333333333' })) });
  assert.equal(c.snapshot(times()).reason, 'identity-conflict');
  await c.cancel();
});

test('an event without a request id or with a non-success flag is ignored', async () => {
  const c = make();
  await c.start();
  const noRequest = event(); noRequest.attributes = noRequest.attributes.filter(a => a.key !== 'request_id');
  const failed = event({ request: 'f' }); failed.attributes.push(attr('success', 'false'));
  await post(c, { payload: body(noRequest, failed) });
  const result = await c.drain({ ...times(), timeoutMs: 50 });
  assert.equal(result.reason, 'authentication-unavailable');
  assert.deepEqual(result.stats.apiRequestRejected, { ...emptyApiRequestRejected, missingRequestId: 1, notSuccess: 1 });
});

test('bare and qualified documented event names share closed diagnostic buckets', async t => {
  const c = make(); await c.start(); t.after(() => c.cancel());
  const names = ['api_request', 'api_error', 'user_prompt', 'assistant_response', 'tool_result', 'tool_decision'];
  const events = names.flatMap(name => [event({ name, request: name }), event({ name: 'claude_code.' + name, request: name + '-prefixed' })]);
  await post(c, { payload: body(...events) });
  const result = await c.drain({ ...times(), timeoutMs: 0 });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.counts.matched, 2);
  assert.deepEqual(result.stats.eventNames, { apiRequest: 2, apiError: 2, userPrompt: 2, assistantResponse: 2, toolResult: 2, toolDecision: 2, other: 0 });
  assert.deepEqual(result.stats.apiRequestRejected, emptyApiRequestRejected);
  assert.equal(result.stats.ignored, 10);
});

test('an explicit true success flag remains accepted', async t => {
  const c = make(); await c.start(); t.after(() => c.cancel());
  const successful = event(); successful.attributes.push(attr('success', 'true'));
  await post(c, { payload: body(successful) });
  const result = await c.drain({ ...times(), timeoutMs: 0 });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.counts.matched, 1);
});

test('every present success value other than true is ignored, including unsupported OTLP values', async t => {
  const c = make(); await c.start(); t.after(() => c.cancel());
  const values = [{ stringValue: 'false' }, { stringValue: '' }, { stringValue: 'TRUE' }, { intValue: '1' },
    { boolValue: false }, { doubleValue: 1 }, { arrayValue: { values: [] } }, {}, null];
  const events = values.map((value, index) => {
    const record = event({ request: 'not-success-' + index });
    record.attributes.push({ key: 'success', value });
    return record;
  });
  await post(c, { payload: body(...events) });
  const result = await c.drain({ ...times(), timeoutMs: 0 });
  assert.equal(result.reason, 'authentication-unavailable');
  assert.equal(result.counts.matched, 0);
  assert.equal(result.counts.ignored, 9);
  assert.deepEqual(result.stats.apiRequestRejected, { ...emptyApiRequestRejected, notSuccess: 9 });
});

test('missing and empty session attributes stay wrong-session evidence with distinct diagnostics', async t => {
  const c = make({ sessionId: null }); await c.start(); t.after(() => c.cancel());
  const missing = event({ request: 'missing' }); missing.attributes = missing.attributes.filter(a => a.key !== 'session.id');
  await post(c, { payload: body(missing, event({ session: '', request: 'empty' }), event({ session: OTHER })) });
  c.bindSession(SID);
  const partial = c.snapshot(times());
  assert.equal(partial.reason, 'identity-session-mismatch');
  assert.equal(partial.counts.wrongSession, 3);
  assert.deepEqual(partial.stats.apiRequestRejected, { ...emptyApiRequestRejected, missingSession: 2, wrongSession: 1 });
  assert.deepEqual(c.snapshot(times()).stats, partial.stats);
  const final = await c.drain({ ...times(), timeoutMs: 0 });
  assert.deepEqual(final.stats, partial.stats);
});

test('identity conflicts outside the window retain both rejection diagnostics', async t => {
  const c = make(); await c.start(); t.after(() => c.cancel());
  await post(c, { payload: body(event({ account: 'wrong-account', at: Date.now() - 60000 })) });
  const result = await c.drain({ ...times(), timeoutMs: 0 });
  assert.equal(result.reason, 'identity-conflict');
  assert.deepEqual(result.stats.apiRequestRejected, { ...emptyApiRequestRejected, identityMismatch: 1, outsideWindow: 1 });
});

test('request ID rejection precedes success and unbound candidates are reevaluated after binding', async t => {
  const c = make({ sessionId: null }); await c.start(); t.after(() => c.cancel());
  const invalid = event({ request: '' }); invalid.attributes.push(attr('success', 'false'));
  await post(c, { payload: body(invalid, event()) });
  const before = c.snapshot(times());
  assert.equal(before.counts.matched, 0);
  assert.deepEqual(before.stats.apiRequestRejected, { ...emptyApiRequestRejected, missingRequestId: 1, wrongSession: 1 });
  c.bindSession(SID);
  const result = await c.drain({ ...times(), timeoutMs: 0 });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.counts.matched, 1);
  assert.deepEqual(result.stats.apiRequestRejected, { ...emptyApiRequestRejected, missingRequestId: 1 });
});

test('request, event and size caps stop acceptance as limit-exceeded', async () => {
  const many = make();
  await many.start();
  const statuses = [];
  for (let i = 0; i < 65; i++) statuses.push(await post(many, { payload: body(event({ request: `r${i}` })) }));
  assert.equal(statuses.at(-1), 429);
  const requestLimit = await many.drain({ ...times(), timeoutMs: 50 });
  assert.equal(requestLimit.reason, 'limit-exceeded');
  assert.equal(requestLimit.stats.requests, 65);
  assert.equal(requestLimit.stats.rejected.other, 1);

  const big = make();
  await big.start();
  assert.equal(await post(big, { payload: 'x'.repeat(262145) }), 413);
  const sizeLimit = await big.drain({ ...times(), timeoutMs: 50 });
  assert.equal(sizeLimit.reason, 'limit-exceeded');
  assert.equal(sizeLimit.stats.rejected.size, 1);

  const events = make();
  await events.start();
  const lots = Array.from({ length: 513 }, (_, i) => event({ request: `e${i}` }));
  assert.equal(await post(events, { payload: body(...lots.slice(0, 256)) }), 200);
  assert.equal(await post(events, { payload: body(...lots.slice(256)) }), 200);
  const eventLimit = await events.drain({ ...times(), timeoutMs: 50 });
  assert.equal(eventLimit.reason, 'limit-exceeded');
  assert.equal(eventLimit.counts.events, 512);
  assert.equal(eventLimit.stats.events, 513);
  assert.equal(eventLimit.stats.ignored, 1);
});

test('a stalled body is cut off by the body timeout', async () => {
  const c = make({ bodyTimeoutMs: 150 });
  await c.start();
  const url = new URL(c.endpoint);
  const closed = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(`POST /v1/logs HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${c.token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    });
    socket.resume();
    socket.on('error', () => {});
    socket.on('close', () => resolve(true));
    setTimeout(() => reject(new Error('not closed')), 3000).unref();
  });
  assert.equal(closed, true);
  const result = await c.drain({ ...times(), timeoutMs: 50 });
  assert.equal(result.counts.events, 0);
  assert.equal(result.stats.rejected.other, 1);
});

test('cancel stops acceptance immediately and leaves authentication unavailable', async () => {
  const c = make();
  await c.start();
  await c.cancel();
  await assert.rejects(post(c));
  const result = await c.drain({ ...times(), timeoutMs: 50 });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.reason, 'cancelled');
});

test('the listener is closed after drain', async () => {
  const c = make();
  await c.start();
  await c.drain({ ...times(), timeoutMs: 20 });
  await assert.rejects(post(c));
});
