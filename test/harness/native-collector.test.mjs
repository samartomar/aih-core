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

const attr = (key, value) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } });
const event = ({ name = 'claude_code.api_request', session = SID, request = 'req_1', account = ACCOUNT, org = ORG, at = Date.now() } = {}) => ({
  timeUnixNano: String(BigInt(at) * 1000000n),
  attributes: [attr('event.name', name), attr('success', 'true'), attr('session.id', session), attr('request_id', request),
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
  } finally { await c.cancel(); }
});

test('events for another session are mismatched evidence, not authentication', async () => {
  const c = make();
  await c.start();
  await post(c, { payload: body(event({ session: OTHER })) });
  const result = await c.drain({ ...times(), timeoutMs: 50 });
  assert.equal(result.reason, 'identity-session-mismatch');
  assert.equal(result.counts.wrongSession, 1);
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
  const d = make();
  await d.start();
  await post(d, { payload: body(event(), event({ account: '33333333-3333-4333-8333-333333333333' })) });
  assert.equal((await d.drain({ ...times(), timeoutMs: 50 })).reason, 'identity-conflict');
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
});

test('aliases, body-text names and events without affirmative success cannot establish identity', async () => {
  const c = make(); await c.start();
  const fallback = event({ request: 'body' });
  fallback.attributes = fallback.attributes.filter(value => value.key !== 'event.name');
  fallback.body = { stringValue: 'claude_code.api_request' };
  const unknown = event({ request: 'unknown' });
  unknown.attributes = unknown.attributes.filter(value => value.key !== 'success');
  await post(c, { payload: body(event({ name: 'api_request' }), fallback, unknown) });
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
  assert.equal((await c.drain({ ...times(), timeoutMs: 50 })).reason, 'authentication-unavailable');
});

test('request, event and size caps stop acceptance as limit-exceeded', async () => {
  const many = make();
  await many.start();
  const statuses = [];
  for (let i = 0; i < 65; i++) statuses.push(await post(many, { payload: body(event({ request: `r${i}` })) }));
  assert.equal(statuses.at(-1), 429);
  assert.equal((await many.drain({ ...times(), timeoutMs: 50 })).reason, 'limit-exceeded');

  const big = make();
  await big.start();
  assert.equal(await post(big, { payload: 'x'.repeat(262145) }), 413);
  assert.equal((await big.drain({ ...times(), timeoutMs: 50 })).reason, 'limit-exceeded');

  const events = make();
  await events.start();
  const lots = Array.from({ length: 513 }, (_, i) => event({ request: `e${i}` }));
  await post(events, { payload: body(...lots) });
  assert.equal((await events.drain({ ...times(), timeoutMs: 50 })).reason, 'limit-exceeded');
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
  assert.equal((await c.drain({ ...times(), timeoutMs: 50 })).counts.events, 0);
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
