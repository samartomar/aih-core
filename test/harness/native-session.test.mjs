import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { observeClaudeManagedSettings } from '../../src/harness/native/claude.mjs';
import { evaluateClaudeSession } from '../../src/harness/native/session.mjs';

const SID1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SID2 = '1f8fad5b-d9cb-469f-a165-70867728950e';
const RESULT = 'a'.repeat(64);

const stream = (extra = {}) => ({ status: 'ok', sessionId: SID1, sessionIdConsistent: true, serverStatus: 'connected',
  visibleSelectedTools: ['aihq_attest_instruction', 'aihq_graph_query'], toolsListed: true, builtinTools: [],
  attestationReturned: true, answerReturned: true, unselectedToolUses: [], ...extra });
const server = (extra = {}) => ({ channel: { peer: 'authenticated', violation: null },
  evaluation: { discovery: 'complete', attestation: 'attested', ambiguousBeforeAttestation: false, query: 'answered',
    queryResultSha256: RESULT, unrequestedCalls: 0 }, ...extra });
const input = (extra = {}) => ({ sessionIndex: 1, previousSessionId: null, stream: stream(),
  managed: { outcome: 'file-sources-clear' }, telemetry: { outcome: 'passed', reason: 'observed', counts: { matched: 1 } },
  server: server(), toolNames: ['aihq_attest_instruction', 'aihq_graph_query'],
  deniedBuiltins: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill'],
  isolationMechanism: 'none', ...extra });
const row = (result, id) => result.rows.find(r => r.id === id);
const pair = (result, id) => [row(result, id).outcome, row(result, id).reason];

test('a healthy hygiene session passes every observation row and leaves isolation unavailable', () => {
  const result = evaluateClaudeSession(input());
  assert.deepEqual(result.rows.map(r => r.id), ['session-freshness', 'loading-mode', 'tool-restrictions',
    'provider-authentication', 'tool-discovery', 'instruction-loading', 'read-only-query', 'isolation']);
  for (const id of ['session-freshness', 'loading-mode', 'provider-authentication', 'tool-discovery', 'instruction-loading', 'read-only-query'])
    assert.deepEqual(pair(result, id), ['passed', 'observed'], id);
  assert.deepEqual(pair(result, 'isolation'), ['unavailable', 'isolation-unobserved']);
  assert.equal(result.proceed, true, 'isolation unavailable alone permits session 2');
  assert.ok(result.rows.every(r => r.session === 1));
  assert.deepEqual(row(result, 'read-only-query').evidence, { kind: 'digest', sha256: RESULT });
});

test('the restriction row passes only when selected MCP tools are the entire offered set', () => {
  assert.deepEqual(pair(evaluateClaudeSession(input()), 'tool-restrictions'), ['passed', 'observed']);
  const offered = evaluateClaudeSession(input({ stream: stream({ builtinTools: ['Read', 'Bash'] }) }));
  assert.deepEqual(pair(offered, 'tool-restrictions'), ['unavailable', 'restriction-unobservable']);
  assert.equal(offered.proceed, false);
  for (const unselected of [{ builtinTools: ['FutureReadTool'] }, { unselectedTools: 1 }])
    assert.deepEqual(pair(evaluateClaudeSession(input({ stream: stream(unselected) })), 'tool-restrictions'), ['unavailable', 'restriction-unobservable']);
  const used = evaluateClaudeSession(input({ stream: stream({ unselectedToolUses: [{ name: 'Read', permitted: true, beforeAttestation: false }] }) }));
  assert.deepEqual(pair(used, 'tool-restrictions'), ['unavailable', 'restriction-unobservable']);
});

test('session freshness: unobservable, reused and distinct ids', () => {
  assert.deepEqual(pair(evaluateClaudeSession(input({ stream: stream({ sessionId: null }) })), 'session-freshness'), ['unavailable', 'session-identity-unobservable']);
  assert.deepEqual(pair(evaluateClaudeSession(input({ stream: stream({ sessionIdConsistent: false }) })), 'session-freshness'), ['unavailable', 'session-identity-unobservable']);
  const reused = evaluateClaudeSession(input({ sessionIndex: 2, previousSessionId: SID1 }));
  assert.deepEqual(pair(reused, 'session-freshness'), ['failed', 'session-not-fresh']);
  assert.equal(reused.proceed, false);
  const fresh = evaluateClaudeSession(input({ sessionIndex: 2, previousSessionId: SID2 }));
  assert.deepEqual(pair(fresh, 'session-freshness'), ['passed', 'observed']);
  assert.ok(fresh.rows.every(r => r.session === 2));
});

test('loading mode: absent server fails, failed server is unavailable, unknown stays unobservable', () => {
  assert.deepEqual(pair(evaluateClaudeSession(input({ stream: stream({ serverStatus: 'absent' }) })), 'loading-mode'), ['failed', 'configuration-not-loaded']);
  assert.deepEqual(pair(evaluateClaudeSession(input({ stream: stream({ serverStatus: 'failed' }) })), 'loading-mode'), ['unavailable', 'server-evidence-unavailable']);
  assert.deepEqual(pair(evaluateClaudeSession(input({ stream: stream({ serverStatus: null }) })), 'loading-mode'), ['unavailable', 'loading-mode-unobservable']);
});

test('a positively observed managed restriction takes precedence over an omitted server', () => {
  const result = evaluateClaudeSession(input({ managed: { outcome: 'restricted' }, stream: stream({ serverStatus: 'absent' }),
    telemetry: { outcome: 'unavailable', reason: 'authentication-unavailable', counts: { matched: 0 } },
    server: { channel: null, evaluation: { discovery: 'missing', attestation: 'missing', ambiguousBeforeAttestation: false, query: 'missing', queryResultSha256: null, unrequestedCalls: 0 } } }));
  assert.deepEqual(pair(result, 'loading-mode'), ['restricted', 'managed-restriction']);
  assert.deepEqual(pair(result, 'tool-restrictions'), ['restricted', 'managed-restriction']);
  assert.deepEqual(pair(result, 'provider-authentication'), ['restricted', 'managed-restriction']);
  assert.deepEqual(pair(result, 'read-only-query'), ['unavailable', 'not-run-after-restriction']);
  assert.equal(result.proceed, false);
  assert.deepEqual(pair(evaluateClaudeSession(input({ managed: { outcome: 'unreadable' } })), 'tool-restrictions'), ['unavailable', 'restriction-unobservable']);
});

test('managed marketplace and fast-mode key presence yields managed-restriction in both sessions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'aihq-session-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const key of ['CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL', 'CLAUDE_CODE_DISABLE_FAST_MODE'])
    for (const value of ['', '0', 'false', '1']) {
      writeFileSync(join(directory, 'managed-settings.json'), JSON.stringify({ env: { [key]: value } }));
      for (const sessionIndex of [1, 2]) {
        const result = evaluateClaudeSession(input({ sessionIndex, previousSessionId: SID2,
          managed: observeClaudeManagedSettings({ directory }), stream: stream({ serverStatus: 'absent' }), telemetry: null }));
        for (const id of ['loading-mode', 'tool-restrictions', 'provider-authentication'])
          assert.deepEqual(pair(result, id), ['restricted', 'managed-restriction'], `${key}/${value}/session-${sessionIndex}/${id}`);
        assert.equal(result.proceed, false);
      }
    }
});

test('identity telemetry reasons map without inventing loading defects', () => {
  for (const reason of ['authentication-unavailable', 'identity-session-mismatch', 'identity-conflict', 'limit-exceeded', 'cancelled']) {
    const result = evaluateClaudeSession(input({ telemetry: { outcome: 'unavailable', reason, counts: { matched: 0 } } }));
    assert.deepEqual(pair(result, 'provider-authentication'), ['unavailable', reason]);
    assert.equal(result.proceed, false);
  }
  assert.deepEqual(pair(evaluateClaudeSession(input({ telemetry: null })), 'provider-authentication'), ['unavailable', 'authentication-unavailable']);
});

test('missing server evidence leaves discovery, instructions and query unavailable', () => {
  const result = evaluateClaudeSession(input({ server: { channel: { peer: 'unavailable', violation: null },
    evaluation: { discovery: 'missing', attestation: 'missing', ambiguousBeforeAttestation: false, query: 'missing', queryResultSha256: null, unrequestedCalls: 0 } } }));
  for (const id of ['tool-discovery', 'instruction-loading', 'read-only-query'])
    assert.deepEqual(pair(result, id), ['unavailable', 'server-evidence-unavailable'], id);
  const flooded = evaluateClaudeSession(input({ server: { ...server(), channel: { peer: 'authenticated', violation: 'limit-exceeded' } } }));
  assert.deepEqual(pair(flooded, 'tool-discovery'), ['unavailable', 'limit-exceeded']);
});

test('discovery fails only when a complete listing lacks a selected tool', () => {
  const lacking = evaluateClaudeSession(input({ stream: stream({ visibleSelectedTools: ['aihq_graph_query'] }) }));
  assert.deepEqual(pair(lacking, 'tool-discovery'), ['failed', 'tools-not-discovered']);
  const unlisted = evaluateClaudeSession(input({ stream: stream({ toolsListed: false, visibleSelectedTools: [] }) }));
  assert.deepEqual(pair(unlisted, 'tool-discovery'), ['unavailable', 'server-evidence-unavailable']);
});

test('instruction loading needs server and client receipt and no earlier alternate access', () => {
  const noClient = evaluateClaudeSession(input({ stream: stream({ attestationReturned: false }) }));
  assert.deepEqual(pair(noClient, 'instruction-loading'), ['unavailable', 'instruction-attestation-unobservable']);
  const mismatch = evaluateClaudeSession(input({ server: server({ evaluation: { ...server().evaluation, attestation: 'mismatch' } }) }));
  assert.deepEqual(pair(mismatch, 'instruction-loading'), ['unavailable', 'instruction-attestation-mismatch']);
  const missing = evaluateClaudeSession(input({ server: server({ evaluation: { ...server().evaluation, attestation: 'missing' } }) }));
  assert.deepEqual(pair(missing, 'instruction-loading'), ['unavailable', 'instruction-attestation-unobservable']);
  const early = evaluateClaudeSession(input({ server: server({ evaluation: { ...server().evaluation, ambiguousBeforeAttestation: true } }) }));
  assert.deepEqual(pair(early, 'instruction-loading'), ['unavailable', 'instruction-source-ambiguous']);
  const read = evaluateClaudeSession(input({ stream: stream({ unselectedToolUses: [{ name: 'Read', permitted: true, beforeAttestation: true }] }) }));
  assert.deepEqual(pair(read, 'instruction-loading'), ['unavailable', 'instruction-source-ambiguous']);
  const denied = evaluateClaudeSession(input({ stream: stream({ unselectedToolUses: [{ name: 'Read', permitted: false, beforeAttestation: true }] }) }));
  assert.deepEqual(pair(denied, 'instruction-loading'), ['passed', 'observed'], 'a denied call alone is not ambiguity');
});

test('query outcomes: wrong challenge unavailable, wrong result failed, unrelayed answer unavailable', () => {
  const wrongChallenge = evaluateClaudeSession(input({ server: server({ evaluation: { ...server().evaluation, query: 'challenge-mismatch', queryResultSha256: null } }) }));
  assert.deepEqual(pair(wrongChallenge, 'read-only-query'), ['unavailable', 'query-challenge-mismatch']);
  const wrongResult = evaluateClaudeSession(input({ server: server({ evaluation: { ...server().evaluation, query: 'result-mismatch' } }) }));
  assert.deepEqual(pair(wrongResult, 'read-only-query'), ['failed', 'query-answer-mismatch']);
  const unrelayed = evaluateClaudeSession(input({ stream: stream({ answerReturned: false }) }));
  assert.deepEqual(pair(unrelayed, 'read-only-query'), ['unavailable', 'server-evidence-unavailable']);
  const contradicted = evaluateClaudeSession(input({ stream: stream({ answerReturned: false,
    answerSha256: '5038da95330ba16edb486954197e37eb777c3047327ca54df4199c35c5edc17a' }) }));
  assert.deepEqual(pair(contradicted, 'read-only-query'), ['failed', 'query-answer-mismatch']);
  const extra = evaluateClaudeSession(input({ server: server({ evaluation: { ...server().evaluation, unrequestedCalls: 1 } }) }));
  assert.deepEqual(pair(extra, 'read-only-query'), ['unavailable', 'restriction-unobservable']);
  const refused = evaluateClaudeSession(input({ server: server({ evaluation: { ...server().evaluation, query: 'refused', queryResultSha256: null } }) }));
  assert.deepEqual(pair(refused, 'read-only-query'), ['unavailable', 'server-evidence-unavailable']);
});

test('limit-exceeded and malformed client output never pass anything', () => {
  const limit = evaluateClaudeSession(input({ stream: stream({ status: 'limit-exceeded' }) }));
  for (const id of ['session-freshness', 'loading-mode', 'tool-restrictions', 'tool-discovery', 'instruction-loading', 'read-only-query'])
    assert.deepEqual(pair(limit, id), ['unavailable', 'limit-exceeded'], id);
  const malformed = evaluateClaudeSession(input({ stream: stream({ status: 'malformed' }) }));
  assert.ok(malformed.rows.every(r => r.outcome !== 'passed' || r.id === 'provider-authentication'));
  assert.equal(malformed.proceed, false);
});

test('client-native isolation is still unobserved without a registered observer result', () => {
  assert.deepEqual(pair(evaluateClaudeSession(input({ isolationMechanism: 'client-native' })), 'isolation'), ['unavailable', 'isolation-unobserved']);
});
