import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClaudeStreamParser, buildClaudeEnvironment, claudePrompt, observeClaudeManagedSettings, claudeSessionsAreFresh }
  from '../../src/harness/native/claude.mjs';
import { fixtureMarkerSha256 } from '../../src/harness/native/fixture-data.mjs';

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CHALLENGE = 'c'.repeat(64);
const options = { serverName: 'aihq-native-fixture', attestTool: 'aihq_attest_instruction', queryTool: 'aihq_graph_query',
  expectedAnswer: 'leaf', markerSha256: fixtureMarkerSha256, challenge: CHALLENGE };
const P = 'mcp__aihq-native-fixture__';
const line = value => JSON.stringify(value) + '\n';
const init = (extra = {}) => ({ type: 'system', subtype: 'init', session_id: SID, permissionMode: 'default',
  tools: [`${P}aihq_attest_instruction`, `${P}aihq_graph_query`], mcp_servers: [{ name: 'aihq-native-fixture', status: 'connected' }], ...extra });
const use = (id, name, input) => ({ type: 'assistant', session_id: SID, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, isError = false) => ({ type: 'user', session_id: SID, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const done = { type: 'result', subtype: 'success', is_error: false, result: 'leaf', session_id: SID };
const healthy = () => [
  init(),
  use('t1', `${P}aihq_attest_instruction`, { marker: 'x', challenge: CHALLENGE }),
  result('t1', [{ type: 'text', text: JSON.stringify({ markerSha256: fixtureMarkerSha256, challenge: CHALLENGE }) }]),
  use('t2', `${P}aihq_graph_query`, { node: 'entry', challenge: CHALLENGE }),
  result('t2', [{ type: 'text', text: 'leaf' }]),
  done
];
const parse = (records, extra = options) => {
  const parser = createClaudeStreamParser(extra);
  parser.push(Buffer.from(records.map(line).join('')));
  return parser.finish();
};

test('a healthy stream yields session id, discovery, attestation and answer evidence', () => {
  const o = parse(healthy());
  assert.equal(o.status, 'ok');
  assert.equal(o.sessionId, SID);
  assert.equal(o.sessionIdConsistent, true);
  assert.equal(o.serverStatus, 'connected');
  assert.deepEqual(o.visibleSelectedTools, ['aihq_attest_instruction', 'aihq_graph_query']);
  assert.equal(o.attestationReturned, true);
  assert.equal(o.answerReturned, true);
  assert.equal(o.resultSubtype, 'success');
  assert.deepEqual(o.unselectedToolUses, []);
});

test('chunk boundaries do not change the parse', () => {
  const bytes = Buffer.from(healthy().map(line).join(''));
  const parser = createClaudeStreamParser(options);
  for (let i = 0; i < bytes.length; i += 7) parser.push(bytes.subarray(i, i + 7));
  assert.equal(parser.finish().answerReturned, true);
});

test('an invalid or missing session id is unobservable and a changed id is inconsistent', () => {
  assert.equal(parse([init({ session_id: 'not a uuid' }), done]).sessionId, null);
  assert.equal(parse([{ ...init(), session_id: undefined }, done]).sessionId, null);
  const changed = parse([init(), { ...done, session_id: '1f8fad5b-d9cb-469f-a165-70867728950e' }]);
  assert.equal(changed.sessionIdConsistent, false);
});

test('a missing server is reported and a wrong answer or wrong marker echo is not accepted', () => {
  assert.equal(parse([init({ mcp_servers: [] }), done]).serverStatus, 'absent');
  assert.equal(parse([init({ tools: [] }), done]).visibleSelectedTools.length, 0);
  const wrong = healthy();
  wrong[4] = result('t2', [{ type: 'text', text: 'leaf2' }]);
  wrong[2] = result('t1', [{ type: 'text', text: JSON.stringify({ markerSha256: 'a'.repeat(64), challenge: CHALLENGE }) }]);
  const o = parse(wrong);
  assert.equal(o.answerReturned, false);
  assert.equal(o.attestationReturned, false);
});

test('answers only count when returned by the selected tool for its call', () => {
  const spoof = [init(), use('t9', 'Read', { file_path: 'x' }), result('t9', [{ type: 'text', text: 'leaf' }]), done];
  const o = parse(spoof);
  assert.equal(o.answerReturned, false);
  assert.deepEqual(o.unselectedToolUses, [{ name: 'Read', permitted: true, beforeAttestation: true }]);
});

test('denied built-in attempts are recorded as denied, not as permitted reads', () => {
  const o = parse([init(), use('t1', 'Bash', { command: 'x' }), result('t1', 'denied', true), done]);
  assert.deepEqual(o.unselectedToolUses, [{ name: 'Bash', permitted: false, beforeAttestation: true }]);
});

test('malformed, oversized and over-deep records stop the parse', () => {
  assert.equal(parse([init()], options).status, 'ok');
  const p1 = createClaudeStreamParser(options); p1.push('not json\n');
  assert.equal(p1.finish().status, 'malformed');
  const p2 = createClaudeStreamParser({ ...options, maxRecordBytes: 100 }); p2.push(line({ type: 'x', pad: 'y'.repeat(500) }));
  assert.equal(p2.finish().status, 'limit-exceeded');
  let deep = {}; for (let i = 0; i < 20; i++) deep = { a: deep };
  const p3 = createClaudeStreamParser(options); p3.push(line(deep));
  assert.equal(p3.finish().status, 'limit-exceeded');
  const p4 = createClaudeStreamParser({ ...options, maxBytes: 50 }); p4.push(line(init()));
  assert.equal(p4.finish().status, 'limit-exceeded');
});

test('session freshness needs two distinct observed ids', () => {
  assert.equal(claudeSessionsAreFresh(SID, '1f8fad5b-d9cb-469f-a165-70867728950e'), true);
  assert.equal(claudeSessionsAreFresh(SID, SID), false);
  assert.equal(claudeSessionsAreFresh(SID, null), false);
});

test('the prompt names the challenge but never the marker or answer', () => {
  const prompt = claudePrompt(CHALLENGE);
  assert.ok(prompt.includes(CHALLENGE));
  assert.ok(!prompt.includes('fde7a948'));
  assert.ok(!prompt.includes('leaf'));
});

test('the environment is built from scratch with fixed telemetry and no inherited secrets', () => {
  const host = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-secret', CLAUDE_CODE_OAUTH_TOKEN: 'tok', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://evil',
    HTTPS_PROXY: 'http://user:pw@proxy', SSH_AUTH_SOCK: '/agent', AWS_ACCESS_KEY_ID: 'a', LANG: 'en_US.UTF-8', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\real' };
  const env = buildClaudeEnvironment({ platform: 'win32', hostEnv: host, homeDir: 'C:\\cell\\home', scratchDir: 'C:\\cell\\scratch',
    runtimeDirs: ['C:\\runtime'], telemetry: { endpoint: 'http://127.0.0.1:4318', token: 't'.repeat(64) },
    evidence: { endpoint: '\\\\.\\pipe\\x', token: 'e'.repeat(64) } });
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'HTTPS_PROXY', 'SSH_AUTH_SOCK', 'AWS_ACCESS_KEY_ID'])
    assert.equal(name in env, false, name);
  assert.equal(env.USERPROFILE, 'C:\\cell\\home');
  assert.equal(env.HOME, 'C:\\cell\\home');
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(env.OTEL_LOGS_EXPORTER, 'otlp');
  assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, 'http/json');
  assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'http://127.0.0.1:4318');
  assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS, `Authorization=Bearer ${'t'.repeat(64)}`);
  assert.equal(env.OTEL_LOGS_EXPORT_INTERVAL, '1000');
  assert.equal(env.OTEL_METRICS_EXPORTER, 'none');
  assert.equal(env.OTEL_TRACES_EXPORTER, 'none');
  for (const name of ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_TOOL_DETAILS', 'OTEL_LOG_TOOL_CONTENT', 'OTEL_LOG_RAW_API_BODIES', 'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA'])
    assert.equal(env[name], '0', name);
  assert.equal(env.AIHQ_NATIVE_EVIDENCE_CHANNEL, '\\\\.\\pipe\\x');
  assert.equal(env.AIHQ_NATIVE_EVIDENCE_TOKEN, 'e'.repeat(64));
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.PATH, 'C:\\runtime');
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
});

test('managed settings that redirect telemetry or MCP are a positive restriction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aihq-managed-'));
  try {
    assert.equal(observeClaudeManagedSettings({ directory: join(dir, 'absent') }).outcome, 'file-sources-clear');
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'managed-settings.json'), JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x' } }));
    assert.equal(observeClaudeManagedSettings({ directory: join(dir, 'a') }).outcome, 'restricted');
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'b', 'managed-settings.json'), JSON.stringify({ allowManagedMcpServersOnly: true }));
    assert.equal(observeClaudeManagedSettings({ directory: join(dir, 'b') }).outcome, 'restricted');
    mkdirSync(join(dir, 'c'));
    writeFileSync(join(dir, 'c', 'managed-settings.json'), JSON.stringify({ theme: 'dark' }));
    assert.equal(observeClaudeManagedSettings({ directory: join(dir, 'c') }).outcome, 'file-sources-clear');
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'managed-settings.json'), '{not json');
    assert.equal(observeClaudeManagedSettings({ directory: join(dir, 'd') }).outcome, 'unreadable');
    mkdirSync(join(dir, 'e'));
    writeFileSync(join(dir, 'e', 'managed-mcp.json'), '{}');
    assert.equal(observeClaudeManagedSettings({ directory: join(dir, 'e') }).outcome, 'restricted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
