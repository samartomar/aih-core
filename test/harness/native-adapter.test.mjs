import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import * as installed from '../../src/harness/native/runtime.mjs';

// This controlled helper seam never launches a client or authenticates a peer.
// It checks when the adapter considers already-received proof complete.
async function session(t, { query = 'answered', receipt = false, realParser = false } = {}) {
  const controller = new AbortController();
  const telemetry = { outcome: 'unavailable', reason: 'authentication-unavailable',
    counts: { events: 0, matched: 0 }, bytes: 0 };
  let terminationCount = 0;
  const stdout = new PassThrough();
  let exit;
  const exited = new Promise(resolve => { exit = resolve; });
  const stream = { status: 'complete', sessionId: 'controlled-session', sessionIdConsistent: true,
    serverStatus: 'connected', toolsListed: true, visibleSelectedTools: ['attest', 'query'],
    builtinTools: [], unselectedTools: 0, unselectedToolUses: [], attestationReturned: true,
    answerReturned: receipt, answerSha256: receipt ? installed.sha256('leaf') : null };
  const evidence = { peer: 'authenticated', violation: null, frames: [], bytes: 0 };
  const module = { ...installed,
    observeClaudeManagedSettings: () => ({ outcome: 'clear' }),
    createClaudeCollector: () => ({ start: async () => ({ endpoint: 'controlled', token: 'controlled' }),
      bindSession() {}, snapshot: () => telemetry, drain: async () => telemetry, cancel: async () => {} }),
    startEvidenceChannel: async () => ({ endpoint: 'controlled', token: 'controlled', challenge: 'a'.repeat(64),
      snapshot: () => evidence, close: async () => evidence }),
    createClaudeStreamParser: realParser ? installed.createClaudeStreamParser : () => ({ push() {}, snapshot: () => ({ ...stream }), finish: () => ({ ...stream }) }),
    buildClaudeEnvironment: () => ({}),
    evaluateServerEvidence: () => ({ initialize: true, discovery: 'complete', attestation: 'missing',
      ambiguousBeforeAttestation: false, query, queryResultSha256: query === 'result-mismatch' ? 'b'.repeat(64) : 'c'.repeat(64),
      rejectedQueryCalls: 0, unrequestedCalls: 0 }),
    startLifecycle: async () => ({ status: 'started', handle: { pid: 1234,
      stdin: new PassThrough(), stdout, stderr: new PassThrough(),
      exited, terminate: async () => { terminationCount++;
        return { processes: 'confirmed', survivors: [] }; } } }) };
  const runtime = installed.createNativeRuntime(module, { readPinned() { throw Error('unused'); },
    Stop: class extends Error { constructor(reason) { super(reason); this.reason = reason; } } });
  runtime.nativeCapabilities = () => ({ lifecycle: true, peerIdentity: true, credentialChannel: true });
  runtime.nativeServerEvidenceAvailable = () => true;
  const definition = { client: 'claude', parserId: 'claude-stream-json.v1', identityAdapterId: 'claude-oauth-otel.v1',
    platform: { os: 'linux' }, lifecycleId: 'controlled', sessionArgv: [] };
  const handle = await runtime.startNativeSession({ definition, index: 1, signal: controller.signal,
    deadline: performance.now() + 5000, prompt: 'controlled', challenge: 'a'.repeat(64), environment: {},
    pin: { executable: process.execPath, runtime: [] }, identity: { expected: {} },
    cell: { observations: 'controlled', home: 'controlled', scratch: 'controlled', project: 'controlled' },
    material: { server: { name: 'controlled', evidenceAdapterId: 'controlled', toolNames: ['attest', 'query'],
      queryTool: 'query', expectedAnswer: 'leaf', expectedResultSha256: 'c'.repeat(64) },
      instructions: [{ evidence: 'marker', markerSha256: 'd'.repeat(64) }] } });
  assert.equal(typeof handle.snapshot, 'function');
  t.after(async () => { controller.abort(); await handle.observations;
    await handle.cleanup({ deadline: performance.now() + 1000, graceMs: 0 }); });
  return { handle, telemetry, stream, stdout, exit, controller, terminationCount: () => terminationCount };
}

test('partial adapter leaves a correct query response unfinished until the client receipt', async t => {
  const { handle } = await session(t);
  const observation = handle.snapshot();
  assert.equal(observation.query.resultSha256, 'c'.repeat(64));
  assert.equal(observation.query.answerSha256, null);
  assert.equal(observation.completed.includes('read-only-query'), false);
});

test('partial adapter preserves an actual server-result contradiction before the client receipt', async t => {
  const { handle } = await session(t, { query: 'result-mismatch' });
  const observation = handle.snapshot();
  assert.equal(observation.query.resultSha256, 'b'.repeat(64));
  assert.equal(observation.query.answerSha256, null);
  assert.equal(observation.completed.includes('read-only-query'), true);
});

test('partial adapter completes a query only after the response and client receipt', async t => {
  const { handle } = await session(t, { receipt: true });
  assert.equal(handle.snapshot().completed.includes('read-only-query'), true);
});

test('real parser leaves a textless query receipt unavailable through cancellation', async t => {
  const { handle, stdout, controller } = await session(t, { realParser: true });
  stdout.write(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'query-id', name: 'mcp__controlled__query' }
  ] } }) + '\n');
  stdout.write(JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'query-id', is_error: false, content: [] }
  ] } }) + '\n');
  assert.equal(handle.snapshot().query.answerSha256, null);
  assert.equal(handle.snapshot().completed.includes('read-only-query'), false);
  controller.abort();
  const final = await handle.observations;
  assert.equal(final.query.answerSha256, null);
  assert.equal(final.completed.includes('read-only-query'), false);
});

test('adapter stops promptly on known identity conflict while retaining received query proof', async t => {
  const { handle, telemetry, terminationCount } = await session(t, { query: 'result-mismatch' });
  telemetry.reason = 'identity-conflict';
  const observation = await Promise.race([handle.observations,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('identity stop was not prompt')), 1000);
      timer.unref(); })]);
  assert.equal(terminationCount(), 1);
  assert.equal(observation.failure.reason, 'identity-conflict');
  assert.equal(observation.authentication, 'conflict');
  assert.equal(observation.completed.includes('provider-authentication'), true);
  assert.equal(observation.completed.includes('read-only-query'), true);
});

test('adapter stops promptly on collector overflow and retains its limit reason', async t => {
  const { handle, telemetry, terminationCount } = await session(t);
  telemetry.reason = 'limit-exceeded';
  const observation = await Promise.race([handle.observations,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('collector overflow did not stop')), 1000);
      timer.unref(); })]);
  assert.equal(terminationCount(), 1);
  assert.equal(observation.failure.reason, 'limit-exceeded');
  assert.equal(observation.authentication, 'limited');
  assert.equal(observation.completed.includes('provider-authentication'), true);
});

for (const interruption of [false, true]) test('real parser preserves a wrong selected query receipt through ' + (interruption ? 'cancellation' : 'completion'), async t => {
  const { handle, stdout, exit, controller } = await session(t, { realParser: true });
  const sessionId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  for (const message of [
    { type: 'system', subtype: 'init', session_id: sessionId, tools: ['mcp__controlled__query'],
      mcp_servers: [{ name: 'controlled', status: 'connected' }] },
    { type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'query-id', name: 'mcp__controlled__query' }] } },
    { type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'query-id', is_error: false,
      content: [{ type: 'text', text: 'leaf2' }] }] } },
  ]) stdout.write(JSON.stringify(message) + '\n');
  const partial = handle.snapshot();
  assert.equal(partial.query.resultSha256, 'c'.repeat(64));
  assert.equal(partial.query.answerSha256, '5038da95330ba16edb486954197e37eb777c3047327ca54df4199c35c5edc17a');
  assert.equal(partial.completed.includes('read-only-query'), true, 'an actual receipt is complete even when it contradicts the expected answer');
  if (interruption) controller.abort(); else exit({ code: 0 });
  const observations = await handle.observations;
  assert.equal(observations.query.answerSha256, partial.query.answerSha256);
  assert.equal(observations.failure?.reason, interruption ? 'cancelled' : undefined);
});

test('wrong-session-only telemetry remains provisional while a matching event can still arrive', async t => {
  const { handle, telemetry, exit, terminationCount } = await session(t);
  telemetry.reason = 'identity-session-mismatch';
  const partial = handle.snapshot();
  assert.equal(partial.completed.includes('provider-authentication'), false);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(terminationCount(), 0, 'wrong-session-only evidence is finalized by drain');
  telemetry.outcome = 'passed'; telemetry.reason = 'observed'; telemetry.counts.matched = 1;
  exit({ code: 0 });
  const final = await handle.observations;
  assert.equal(final.authentication, 'matched');
  assert.equal(final.failure, undefined);
});
