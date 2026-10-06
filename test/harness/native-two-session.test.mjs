// Controlled synthetic client: exercises the staged fixture, authenticated channel, collector, parser and
// session evaluation across two fresh processes. It is a mechanism fixture, never native admission.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEvidenceChannel } from '../../src/harness/native/evidence.mjs';
import { createClaudeCollector } from '../../src/harness/native/collector.mjs';
import { buildClaudeEnvironment, claudePrompt, createClaudeStreamParser, observeClaudeManagedSettings } from '../../src/harness/native/claude.mjs';
import { evaluateClaudeSession } from '../../src/harness/native/session.mjs';
import { createOwnedCell, observeCellConfiguration, removeOwnedCell, stageCellFiles } from '../../src/harness/native/cell.mjs';
import { claudeDeniedBuiltins, claudeStreamOptions, resolveBundledFixture, serverEvidenceSpec } from '../../src/harness/native/runtime.mjs';
import { evaluateServerEvidence } from '../../src/harness/native/evidence.mjs';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const FIRST = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SECOND = '1f8fad5b-d9cb-469f-a165-70867728950e';

// Plays the client's part: loads the staged instruction and MCP config, drives the server, reports
// stream-json and one OTLP log event. `mode` injects the negative cases.
const CLIENT = String.raw`
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import http from 'node:http';
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const challenge = /Session challenge: ([0-9a-f]{64})/.exec(prompt)[1];
const mode = process.env.FAKE_MODE || 'healthy';
const session = process.env.FAKE_SESSION;
const marker = /marker. set to .([0-9a-f]{64})./.exec(readFileSync('CLAUDE.md', 'utf8'))[1];
const config = JSON.parse(readFileSync('.mcp.json', 'utf8')).mcpServers['aihq-native-fixture'];
const server = spawn(process.execPath, config.args, { env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
let id = 0;
const rpc = async (method, params) => {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
  return JSON.parse((await lines.next()).value);
};
await rpc('initialize', { protocolVersion: '2025-06-18' });
const listed = (await rpc('tools/list')).result.tools.map(t => 'mcp__aihq-native-fixture__' + t.name);
const P = 'mcp__aihq-native-fixture__';
out({ type: 'system', subtype: 'init', session_id: session, permissionMode: 'default', tools: listed,
  mcp_servers: [{ name: 'aihq-native-fixture', status: 'connected' }] });
const call = async (toolUseId, name, args) => {
  out({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: toolUseId, name: P + name, input: args }] } });
  const reply = await rpc('tools/call', { name, arguments: args });
  const text = reply.result ? reply.result.content[0].text : 'error';
  out({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: Boolean(reply.error), content: [{ type: 'text', text }] }] } });
};
if (mode === 'query-first') await call('t0', 'aihq_graph_query', { node: 'entry', challenge });
await call('t1', 'aihq_attest_instruction', { marker: mode === 'wrong-marker' ? 'changed' : marker, challenge });
await call('t2', 'aihq_graph_query', { node: 'entry', challenge: mode === 'wrong-challenge' ? '0'.repeat(64) : challenge });
out({ type: 'result', subtype: 'success', is_error: false, result: 'leaf', session_id: session });
server.stdin.end();
const header = process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS.replace('Authorization=', '');
const attr = (key, value) => ({ key, value: { stringValue: value } });
const event = { timeUnixNano: String(BigInt(Date.now()) * 1000000n), attributes: [attr('event.name', 'claude_code.api_request'), attr('success', 'true'),
  attr('session.id', mode === 'wrong-session' ? '2f8fad5b-d9cb-469f-a165-70867728950e' : session), attr('request_id', 'req_' + session),
  attr('user.account_uuid', process.env.FAKE_ACCOUNT), attr('organization.id', process.env.FAKE_ORG)] };
if (mode !== 'no-telemetry') {
  await new Promise(resolve => {
    const req = http.request(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, { method: 'POST',
      headers: { authorization: header, 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end(JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [event] }] }] }));
  });
}
`;

function setup(t) {
  // Darwin's default temp path plus the cell can exceed its Unix socket path limit.
  const parent = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'aihq-two-'));
  const { cell } = createOwnedCell({ parent });
  t.after(() => { removeOwnedCell(cell, { processesConfirmed: true }); rmSync(parent, { recursive: true, force: true }); });
  const resolved = resolveBundledFixture('claude');
  assert.deepEqual(stageCellFiles(cell, resolved.files), { status: 'staged' });
  const clientFile = join(cell.scratch, 'client.mjs');
  writeFileSync(clientFile, CLIENT);
  const expectation = { outputPaths: resolved.outputPaths, guardrailPaths: resolved.guardrailPaths,
    outputTreeSha256: resolved.outputTreeSha256, guardrailsSha256: resolved.guardrailsSha256 };
  return { cell, resolved, clientFile, expectation };
}

async function session({ cell, resolved, clientFile, index, previousSessionId, fakeSession, mode = 'healthy', expectedIdentity = { accountUuid: ACCOUNT, organizationId: ORG } }) {
  const holder = {};
  const channel = await createEvidenceChannel({ directory: cell.observation,
    peerIdentity: async (_s, hello) => ({ status: 'observed', pid: hello.pid, birth: 'controlled' }), isOwnedServer: () => true });
  const collector = createClaudeCollector({ expected: expectedIdentity });
  const telemetry = await collector.start();
  const env = buildClaudeEnvironment({ platform: process.platform, hostEnv: process.env, homeDir: cell.home, scratchDir: cell.scratch,
    runtimeDirs: [], telemetry, evidence: { endpoint: channel.endpoint, token: channel.token } });
  const launchedAtMs = Date.now();
  const child = spawn(process.execPath, [clientFile], { cwd: cell.project, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...env, FAKE_MODE: mode, FAKE_SESSION: fakeSession, FAKE_ACCOUNT: ACCOUNT, FAKE_ORG: ORG } });
  const parser = createClaudeStreamParser(claudeStreamOptions(resolved, channel.challenge));
  child.stdout.on('data', chunk => parser.push(chunk));
  child.stdin.end(claudePrompt(channel.challenge));
  await once(child, 'exit');
  const stream = parser.finish();
  collector.bindSession(stream.sessionId);
  const drained = await collector.drain({ launchedAtMs, closedAtMs: Date.now(), timeoutMs: 300 });
  const channelResult = await channel.close();
  const evaluation = evaluateServerEvidence(channelResult.frames, serverEvidenceSpec(resolved));
  holder.result = evaluateClaudeSession({ sessionIndex: index, previousSessionId, stream, managed: { outcome: 'file-sources-clear' },
    telemetry: drained, server: { channel: channelResult, evaluation }, toolNames: resolved.server.toolNames, deniedBuiltins: claudeDeniedBuiltins });
  return { ...holder.result, stream, drained, channelResult, challenge: channel.challenge };
}

const pair = (result, id) => { const r = result.rows.find(row => row.id === id); return [r.outcome, r.reason]; };

test('two fresh sessions over one staged cell pass every observation row; isolation stays unavailable', async t => {
  const fx = setup(t);
  const first = await session({ ...fx, index: 1, previousSessionId: null, fakeSession: FIRST });
  assert.equal(first.proceed, true, JSON.stringify(first.rows));
  assert.equal(observeCellConfiguration(fx.cell, fx.expectation).status, 'unchanged');
  const second = await session({ ...fx, index: 2, previousSessionId: first.stream.sessionId, fakeSession: SECOND });
  assert.equal(second.proceed, true, JSON.stringify(second.rows));
  assert.notEqual(first.challenge, second.challenge, 'a fresh challenge per session');
  assert.equal(observeCellConfiguration(fx.cell, fx.expectation).status, 'unchanged');
  for (const r of [first, second]) {
    for (const row of r.rows.filter(entry => entry.id !== 'isolation')) assert.deepEqual([row.outcome, row.reason], ['passed', 'observed'], row.id);
    assert.deepEqual(pair(r, 'isolation'), ['unavailable', 'isolation-unobserved']);
  }
  assert.equal(second.rows[0].session, 2);
});

test('a reused client session id fails freshness even in a new process', async t => {
  const fx = setup(t);
  const first = await session({ ...fx, index: 1, previousSessionId: null, fakeSession: FIRST });
  const second = await session({ ...fx, index: 2, previousSessionId: first.stream.sessionId, fakeSession: FIRST });
  assert.deepEqual(pair(second, 'session-freshness'), ['failed', 'session-not-fresh']);
  assert.equal(second.proceed, false);
});

test('telemetry for another session or a missing report is unavailable authentication, not a loading defect', async t => {
  const fx = setup(t);
  const wrong = await session({ ...fx, index: 1, previousSessionId: null, fakeSession: FIRST, mode: 'wrong-session' });
  assert.deepEqual(pair(wrong, 'provider-authentication'), ['unavailable', 'identity-session-mismatch']);
  const none = await session({ ...fx, index: 1, previousSessionId: null, fakeSession: SECOND, mode: 'no-telemetry' });
  assert.deepEqual(pair(none, 'provider-authentication'), ['unavailable', 'authentication-unavailable']);
  assert.deepEqual(pair(none, 'read-only-query'), ['passed', 'observed']);
  const conflict = await session({ ...fx, index: 1, previousSessionId: null, fakeSession: FIRST,
    expectedIdentity: { accountUuid: '33333333-3333-4333-8333-333333333333', organizationId: ORG } });
  assert.deepEqual(pair(conflict, 'provider-authentication'), ['unavailable', 'identity-conflict']);
});

test('negative controls: wrong marker, wrong challenge and query before attestation cannot pass', async t => {
  const fx = setup(t);
  const marker = await session({ ...fx, index: 1, previousSessionId: null, fakeSession: FIRST, mode: 'wrong-marker' });
  assert.deepEqual(pair(marker, 'instruction-loading'), ['unavailable', 'instruction-attestation-mismatch']);
  const challenge = await session({ ...fx, index: 1, previousSessionId: null, fakeSession: SECOND, mode: 'wrong-challenge' });
  assert.deepEqual(pair(challenge, 'read-only-query'), ['unavailable', 'query-challenge-mismatch']);
  const early = await session({ ...fx, index: 1, previousSessionId: null, fakeSession: FIRST, mode: 'query-first' });
  assert.deepEqual(pair(early, 'instruction-loading'), ['passed', 'observed']);
  assert.deepEqual(pair(early, 'read-only-query'), ['unavailable', 'restriction-unobservable']);
  assert.equal(early.proceed, false);
});

test('a client that rewrites staged configuration is configuration-changed', async t => {
  const fx = setup(t);
  await session({ ...fx, index: 1, previousSessionId: null, fakeSession: FIRST });
  writeFileSync(join(fx.cell.project, 'CLAUDE.md'), 'rewritten');
  assert.equal(observeCellConfiguration(fx.cell, fx.expectation).status, 'changed');
});

test('the managed-settings observation is independent of the synthetic client', () => {
  assert.ok(['restricted', 'file-sources-clear', 'unreadable'].includes(observeClaudeManagedSettings().outcome));
});
