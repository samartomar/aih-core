import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

test('provider result errors are reduced to closed classes without retaining client text', () => {
  const cases = [
    ['authentication', '401 authentication failed secret-marker'],
    ['forbidden', '403 forbidden secret-marker'],
    ['rate-limit', '429 rate limit secret-marker'],
    ['overloaded', '529 overloaded secret-marker'],
    ['network', 'ECONNRESET fetch failed secret-marker'],
    ['other', 'unrecognized failure secret-marker']
  ];
  for (const [errorClass, text] of cases) {
    const observed = parse([{ ...done, is_error: true, result: text }]);
    assert.equal(observed.errorClass, errorClass);
    assert.equal(JSON.stringify(observed).includes('secret-marker'), false);
  }
  assert.equal(parse([done]).errorClass, 'none');
  assert.equal(parse([init()]).errorClass, 'none');
  assert.equal(parse([{ ...done, result: 'oauth network 403' }]).errorClass, 'none', 'successful prose is not an error');
});

test('assistant and system API errors use numeric status before text and survive a generic result', () => {
  for (const [status, errorClass] of [[401, 'authentication'], [403, 'forbidden'], [429, 'rate-limit'], [529, 'overloaded'], [500, 'other']]) {
    for (const type of ['assistant', 'system']) {
      const observed = parse([{ type, subtype: 'api_error', error: { status, message: 'opaque secret-marker' },
        message: { content: [{ type: 'text', text: 'opaque secret-marker' }] } },
      { ...done, is_error: true, errors: ['opaque secret-marker'] }]);
      assert.equal(observed.errorClass, errorClass);
      assert.equal(JSON.stringify(observed).includes('secret-marker'), false);
    }
  }
  for (const [text, errorClass] of [['Please run /login', 'authentication'], ['token has expired', 'authentication'],
    ['invalid x-api key', 'authentication'], ['ENOTFOUND', 'network'], ['socket hang up', 'network']]) {
    assert.equal(parse([{ type: 'assistant', error: 'api_error', message: { content: [{ type: 'text', text }] } },
      { ...done, is_error: true }]).errorClass, errorClass);
    assert.equal(parse([{ type: 'system', subtype: 'api_error', error: { message: text } }]).errorClass, errorClass);
    assert.equal(parse([{ ...done, is_error: true, errors: [text] }]).errorClass, errorClass);
  }
  assert.equal(parse([{ ...done, is_error: true, error: { status: 429, message: 'authentication network' } }]).errorClass, 'rate-limit');
  assert.equal(parse([{ ...done, is_error: true, status_code: 403 }]).errorClass, 'forbidden');
  assert.equal(parse([{ type: 'assistant', message: { content: [{ type: 'text', text: 'oauth forbidden network' }] } }, done]).errorClass, 'none');
  assert.equal(parse([{ type: 'system', subtype: 'init', error: 'network' }, done]).errorClass, 'none');
});

test('result presence distinguishes an absent result from one with no subtype or error flag', () => {
  const absent = parse([init()]);
  assert.equal(absent.resultSeen, false);
  const unknown = parse([init(), { type: 'result', session_id: SID }]);
  assert.equal(unknown.resultSeen, true);
  assert.equal(unknown.resultSubtype, null);
  assert.equal(unknown.resultIsError, null);
  const error = parse([init(), { ...done, subtype: 'error_during_execution', is_error: true }]);
  assert.equal(error.resultSeen, true);
  assert.equal(error.resultSubtype, 'error_during_execution');
  assert.equal(error.resultIsError, true);
});

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

test('snapshots retain complete records and do not consume an unfinished record', () => {
  const parser = createClaudeStreamParser(options);
  parser.push(line(init()) + '{"type":');
  const first = parser.snapshot();
  assert.equal(first.sessionId, SID);
  first.visibleSelectedTools.length = 0;
  assert.equal(parser.snapshot().visibleSelectedTools.length, 2);
  parser.push('"result","subtype":"success","is_error":false}\n');
  assert.equal(parser.finish().resultSubtype, 'success');
  assert.equal(parse([init({ tools: [...init().tools, 'mcp__other__read'] })]).unselectedTools, 1);
});

test('duplicate keys and extreme depth cannot yield client evidence or overflow the parser stack', () => {
  const duplicate = createClaudeStreamParser(options);
  duplicate.push('{"type":"system","type":"result"}\n');
  assert.equal(duplicate.finish().status, 'malformed');
  const deep = createClaudeStreamParser(options);
  assert.doesNotThrow(() => deep.push('['.repeat(20000) + '0' + ']'.repeat(20000) + '\n'));
  assert.equal(deep.finish().status, 'limit-exceeded');
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

test('selected query receipts retain a bounded digest that distinguishes absence and contradiction', () => {
  const missing = parse([init(), use('query-id', `${P}aihq_graph_query`, {}), done]);
  assert.equal(missing.answerSha256, null);
  const wrong = parse([init(), use('query-id', `${P}aihq_graph_query`, {}),
    result('query-id', [{ type: 'text', text: 'leaf2' }]), done]);
  assert.equal(wrong.answerReturned, false);
  assert.equal(wrong.answerSha256, '5038da95330ba16edb486954197e37eb777c3047327ca54df4199c35c5edc17a');
  assert.ok(!JSON.stringify(wrong).includes('leaf2'));
  const laterMatch = parse([init(), use('query-id', `${P}aihq_graph_query`, {}),
    result('query-id', [{ type: 'text', text: 'leaf2' }]), result('query-id', [{ type: 'text', text: 'leaf' }]), done]);
  assert.equal(laterMatch.answerSha256, wrong.answerSha256, 'a later matching receipt cannot erase an observed contradiction');
});

test('selected query results without text leave the client receipt unobserved', () => {
  for (const content of [[], [{ type: 'image', source: { type: 'base64', data: 'controlled' } }]]) {
    const records = [init(), use('query-id', `${P}aihq_graph_query`, {}), result('query-id', content)];
    const missing = parse([...records, done]);
    assert.equal(missing.answerSha256, null);
    assert.equal(missing.answerReturned, false);
    assert.equal(parse([...records, result('query-id', [{ type: 'text', text: 'leaf' }]), done]).answerReturned, true);
  }
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
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
  assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, 'http/json');
  assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'http://127.0.0.1:4318/v1/logs');
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

test('every platform uses the generic OTLP protocol with only the authoritative logs endpoint', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const env = buildClaudeEnvironment({ platform, hostEnv: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://unapproved' },
      homeDir: platform === 'win32' ? 'C:\\cell\\home' : '/cell/home', scratchDir: '/cell/scratch', runtimeDirs: [],
      telemetry: { endpoint: 'http://127.0.0.1:4318', token: 'synthetic' }, evidence: { endpoint: 'synthetic', token: 'synthetic' } });
    assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json', platform);
    assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, 'http/json', platform);
    assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'http://127.0.0.1:4318/v1/logs', platform);
    assert.equal(Object.hasOwn(env, 'OTEL_EXPORTER_OTLP_ENDPOINT'), false, platform);
  }
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
    // Windows applies env names case-insensitively, so a case variant of a fixed switch is still a restriction.
    for (const key of ['claude_code_disable_fast_mode', 'Claude_Code_Disable_Official_Marketplace_Autoinstall',
      'claude_code_disable_auto_memory']) {
      const caseDir = join(dir, `case-${key}`); mkdirSync(caseDir);
      writeFileSync(join(caseDir, 'managed-settings.json'), JSON.stringify({ env: { [key]: '0' } }));
      assert.equal(observeClaudeManagedSettings({ directory: caseDir }).outcome, 'restricted', key);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('auto-memory is disabled literally on every platform despite hostile host values', () => {
  for (const platform of ['win32', 'linux', 'darwin']) for (const value of ['0', 'false', '', '1']) {
    const env = buildClaudeEnvironment({ platform, hostEnv: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: value },
      homeDir: platform === 'win32' ? 'C:/cell/home' : '/cell/home', scratchDir: '/cell/scratch', runtimeDirs: [],
      telemetry: { endpoint: 'http://127.0.0.1:4318', token: 'synthetic' }, evidence: { endpoint: 'synthetic', token: 'synthetic' } });
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', `${platform}: ${value}`);
  }
});

test('both-session environments fix marketplace and fast-mode switches on every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin']) for (const value of ['0', 'false', '', '1', 'hostile']) {
    const sessions = [1, 2].map(() => buildClaudeEnvironment({ platform, hostEnv: {
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: value, CLAUDE_CODE_DISABLE_FAST_MODE: value,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://unapproved', CLAUDE_CODE_ENABLE_TELEMETRY: '0'
    }, homeDir: platform === 'win32' ? 'C:/cell/home' : '/cell/home', scratchDir: '/cell/scratch', runtimeDirs: [],
    telemetry: { endpoint: 'http://127.0.0.1:4318', token: 'synthetic' }, evidence: { endpoint: 'synthetic', token: 'synthetic' } }));
    assert.deepEqual(sessions[1], sessions[0], `${platform}: ${value}`);
    for (const env of sessions) {
      assert.equal(env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL, '1');
      assert.equal(env.CLAUDE_CODE_DISABLE_FAST_MODE, '1');
      assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
      assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
      assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'http://127.0.0.1:4318/v1/logs');
      assert.equal(Object.hasOwn(env, 'OTEL_EXPORTER_OTLP_ENDPOINT'), false);
    }
  }
});


test('all-platform managed observer refuses auto-memory policy without overriding it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aihq-managed-memory-'));
  try {
    for (const policy of [{ autoMemoryEnabled: true }, { autoMemoryEnabled: false },
      ...['0', 'false', '', '1'].map(value => ({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: value } }))]) {
      const file = join(dir, 'managed-settings.json');
      const bytes = JSON.stringify(policy); writeFileSync(file, bytes);
      assert.equal(observeClaudeManagedSettings({ directory: dir }).outcome, 'restricted');
      assert.equal(readFileSync(file, 'utf8'), bytes);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('all-platform managed switch presence wins over unreadable siblings without policy writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aihq-managed-switches-'));
  try {
    mkdirSync(join(dir, 'managed-settings.d'));
    writeFileSync(join(dir, 'managed-settings.d', 'broken.json'), '{broken');
    for (const platform of ['win32', 'linux', 'darwin'])
      for (const key of ['CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL', 'CLAUDE_CODE_DISABLE_FAST_MODE'])
        for (const value of ['', '0', 'false', '1', false, 0, null]) {
          const file = join(dir, 'managed-settings.json');
          const bytes = JSON.stringify({ env: { [key]: value }, unknownPolicy: {} });
          writeFileSync(file, bytes);
          assert.equal(observeClaudeManagedSettings({ platform, directory: dir }).outcome, 'restricted', `${platform}/${key}/${value}`);
          assert.equal(readFileSync(file, 'utf8'), bytes);
        }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
