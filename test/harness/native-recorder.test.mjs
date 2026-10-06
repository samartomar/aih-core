import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../../src/harness/native/canonical.mjs';
import { bundledNativeFixtures } from '../../src/harness/native/contracts.mjs';
import { createEvidenceChannel, evaluateServerEvidence } from '../../src/harness/native/evidence.mjs';
import { fixtureMarker, fixtureMarkerSha256 } from '../../src/harness/native/fixture-data.mjs';
import { recorderCommand, recorderId, recorderMaterial, recorderPlan } from '../../src/harness/native/recorder.mjs';

const ATTEST = 'aihq_attest_instruction';
const QUERY = 'aihq_graph_query';
const RESULT = { content: [{ type: 'text', text: 'leaf' }], isError: false };
const spec = { attestTool: ATTEST, queryTool: QUERY, markerSha256: fixtureMarkerSha256,
  expectedResultSha256: sha256Hex(canonicalJson(RESULT)) };
const plan = (over = {}) => ({ attestTool: ATTEST, markers: [fixtureMarkerSha256], queryTool: QUERY,
  queryArguments: { node: 'entry' }, challengeField: 'challenge', toolNames: [ATTEST, QUERY], ...over });

// Controlled upstream: records what it actually receives so tests can prove what was (not) forwarded.
const MOCK = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.env.MOCK_MODE ?? '';
const note = entry => appendFileSync(process.env.MOCK_LOG, JSON.stringify(entry) + '\\n');
note({ boot: process.pid, leaked: Boolean(process.env.AIHQ_NATIVE_EVIDENCE_TOKEN || process.env.AIHQ_NATIVE_EVIDENCE_CHANNEL), telemetry: Boolean(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS) });
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
if (mode === 'linger') setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  note({ method: message.method ?? 'response', id: message.id ?? null, params: message.params ?? null });
  if (message.id === undefined || message.method === undefined) return;
  const result = body => send({ jsonrpc: '2.0', id: message.id, result: body });
  if (message.method === 'initialize') return result({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } });
  if (message.method === 'ping') return result({});
  if (message.method === 'tools/list') return result({ tools: [{ name: 'aihq_graph_query', description: 'q', inputSchema: { type: 'object' } }] });
  if (message.method === 'tools/call') {
    const body = { content: [{ type: 'text', text: 'leaf' }], isError: false };
    if (mode === 'wrong-id') return send({ jsonrpc: '2.0', id: 'other', result: body });
    return result(body);
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'nope' } });
});
`;

function setup(mode = '') {
  const dir = mkdtempSync(join(tmpdir(), 'aihq-recorder-'));
  writeFileSync(join(dir, 'recorder.mjs'), recorderMaterial().bytes);
  writeFileSync(join(dir, 'mock.mjs'), MOCK);
  return { dir, log: join(dir, 'mock.log'), mode };
}
const entries = ctx => (existsSync(ctx.log) ? readFileSync(ctx.log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function assertUpstreamGone(ctx) {
  const pid = entries(ctx).find(entry => entry.boot !== undefined)?.boot;
  if (pid === undefined) return;
  for (let i = 0; i < 60 && alive(pid); i += 1) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(alive(pid), false, 'upstream process must be gone');
}

async function run(ctx, { verify = null, env = {} } = {}) {
  const holder = {};
  let channel = null;
  if (verify) {
    channel = await createEvidenceChannel({ directory: ctx.dir, plan: verify.plan,
      ...(verify.peer === 'os' ? {} : { peerIdentity: async (_socket, hello) => ({ status: 'observed', pid: hello.pid, birth: 'test-birth' }) }),
      isOwnedServer: identity => identity.pid === holder.child.pid && identity.birth === 'test-birth' });
  }
  const childEnv = { ...process.env, MOCK_LOG: ctx.log, MOCK_MODE: ctx.mode, ...env };
  delete childEnv.AIHQ_NATIVE_EVIDENCE_CHANNEL;
  delete childEnv.AIHQ_NATIVE_EVIDENCE_TOKEN;
  Object.assign(childEnv, env);
  if (channel) {
    childEnv.AIHQ_NATIVE_EVIDENCE_CHANNEL = channel.endpoint;
    childEnv.AIHQ_NATIVE_EVIDENCE_TOKEN = verify.token ?? channel.token;
  }
  // This controlled peer fixture launches the absolute entry directly so its held
  // process remains the observed peer, passing the fixed marker explicitly on every
  // trampoline platform; native Job tests cover the relative wrapper.
  const child = spawn(process.execPath, [join(ctx.dir, 'recorder.mjs'),
    ...(channel && (process.platform === 'win32' || process.platform === 'linux') ? ['--aihq-native-absolute-entry'] : []),
    '--', process.execPath, join(ctx.dir, 'mock.mjs')],
    { stdio: ['pipe', 'pipe', 'ignore'], env: childEnv, windowsHide: true });
  holder.child = child;
  child.stdin.on('error', () => {});
  const reader = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exit = once(child, 'exit');
  const send = message => child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  const rpc = async (id, method, params) => {
    send({ jsonrpc: '2.0', id, method, params });
    const { value } = await reader.next();
    return { line: value, message: value ? JSON.parse(value) : null };
  };
  const closed = { value: null };
  return { child, channel, rpc, send, exit,
    end: () => child.stdin.end(),
    async done() { const [code] = await exit; closed.value ??= channel ? await channel.close() : null; return { code, result: closed.value }; },
    async dispose() { child.kill(); if (channel && closed.value === null) await channel.close(); } };
}

const call = (r, id, name, args) => r.rpc(id, 'tools/call', { name, arguments: args });

test('ordinary mode preserves whitespace and CRLF exactly', async () => {
  const ctx = setup();
  writeFileSync(join(ctx.dir, 'mock.mjs'), 'process.stdin.pipe(process.stdout);');
  const r = await run(ctx);
  const bytes = Buffer.from(' { "jsonrpc": "2.0", "id": 1, "method": "ping" }\r\n');
  try {
    const data = once(r.child.stdout, 'data');
    r.child.stdin.write(bytes);
    const [observed] = await data;
    assert.deepEqual(observed, bytes);
    r.end();
    assert.equal((await r.done()).code, 0);
  } finally { await r.dispose(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('ordinary use forwards bytes unchanged, adds nothing and withholds verification variables', async () => {
  const ctx = setup();
  const r = await run(ctx, { env: { AIHQ_NATIVE_EVIDENCE_TOKEN: 'a'.repeat(64) } });
  try {
    assert.equal((await r.rpc(1, 'initialize', { protocolVersion: '2025-06-18' })).message.id, 1);
    const list = await r.rpc('abc', 'tools/list');
    assert.equal(list.message.id, 'abc');
    assert.deepEqual(list.message.result.tools.map(tool => tool.name), [QUERY]);
    const query = await call(r, 3, QUERY, { node: 'entry' });
    assert.equal(query.line, JSON.stringify({ jsonrpc: '2.0', id: 3, result: RESULT }));
    const seen = entries(ctx);
    assert.equal(seen[0].leaked, false);
    assert.deepEqual(seen.find(entry => entry.method === 'tools/call').params.arguments, { node: 'entry' });
    r.end();
    assert.equal((await r.done()).code, 0);
    await assertUpstreamGone(ctx);
  } finally { await r.dispose(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('verification in argument mode attests, forwards the one pinned query and emits only digests', async () => {
  const ctx = setup();
  const r = await run(ctx, { verify: { plan: plan() }, env: {
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:1', OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'Authorization=Bearer client-only' } });
  try {
    await r.rpc(1, 'initialize', {});
    const list = await r.rpc(2, 'tools/list');
    assert.deepEqual(list.message.result.tools.map(tool => tool.name), [QUERY, ATTEST]);
    const attest = await call(r, 3, ATTEST, { marker: fixtureMarker, challenge: r.channel.challenge });
    assert.deepEqual(JSON.parse(attest.message.result.content[0].text), { markerSha256: fixtureMarkerSha256, challenge: r.channel.challenge });
    const query = await call(r, 4, QUERY, { node: 'entry', challenge: r.channel.challenge });
    assert.deepEqual(query.message.result, RESULT);
    r.end();
    const { code, result } = await r.done();
    assert.equal(code, 0);
    assert.equal(result.peer, 'authenticated');
    assert.equal(result.violation, null);
    assert.deepEqual(result.frames.map(f => [f.sequence, f.method, f.tool]), [
      [1, 'initialize', null], [2, 'tools/list', null], [3, 'tools/call', ATTEST], [4, 'tools/call', QUERY]]);
    const evaluation = evaluateServerEvidence(result.frames, spec);
    assert.equal(evaluation.discovery, 'complete');
    assert.equal(evaluation.attestation, 'attested');
    assert.equal(evaluation.ambiguousBeforeAttestation, false);
    assert.equal(evaluation.query, 'answered');
    const text = JSON.stringify(result.frames);
    for (const secret of [r.channel.challenge, fixtureMarker, 'entry', 'leaf']) assert.ok(!text.includes(secret), secret);
    const seen = entries(ctx);
    assert.equal(seen[0].leaked, false);
    assert.equal(seen[0].telemetry, false);
    assert.equal(seen.filter(entry => entry.method === 'tools/call').length, 1);
    await assertUpstreamGone(ctx);
  } finally { await r.dispose(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('rpc-id mode sends the challenge as the outbound id and restores the original id', async () => {
  const ctx = setup();
  const r = await run(ctx, { verify: { plan: plan({ challengeField: null }) } });
  try {
    await r.rpc(1, 'initialize', {});
    await r.rpc(2, 'tools/list');
    await call(r, 3, ATTEST, { marker: fixtureMarker, challenge: r.channel.challenge });
    const query = await call(r, 7, QUERY, { node: 'entry' });
    assert.equal(query.message.id, 7);
    assert.deepEqual(query.message.result, RESULT);
    const forwarded = entries(ctx).find(entry => entry.method === 'tools/call');
    assert.equal(forwarded.id, r.channel.challenge);
    assert.deepEqual(forwarded.params.arguments, { node: 'entry' });
    r.end();
    const { code, result } = await r.done();
    assert.equal(code, 0);
    const evaluation = evaluateServerEvidence(result.frames, spec);
    assert.equal(evaluation.query, 'answered');
    assert.equal(evaluation.queryResultSha256, spec.expectedResultSha256);
  } finally { await r.dispose(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('out-of-policy requests are refused, never forwarded, and the query runs once', async () => {
  const ctx = setup();
  const r = await run(ctx, { verify: { plan: plan() } });
  const challenge = () => r.channel.challenge;
  try {
    await r.rpc(1, 'initialize', {});
    await r.rpc(2, 'tools/list');
    assert.ok((await call(r, 3, QUERY, { node: 'entry', challenge: challenge() })).message.error, 'query before attestation');
    assert.ok((await call(r, 4, ATTEST, { marker: '0'.repeat(64), challenge: challenge() })).message.error, 'wrong marker');
    assert.ok((await call(r, 5, ATTEST, { marker: fixtureMarker, challenge: 'f'.repeat(64) })).message.error, 'wrong challenge');
    assert.ok((await call(r, 6, ATTEST, { marker: fixtureMarker, challenge: challenge() })).message.result);
    assert.ok((await call(r, 7, QUERY, { node: 'leaf', challenge: challenge() })).message.error, 'altered arguments');
    assert.ok((await call(r, 8, QUERY, { node: 'entry', challenge: 'e'.repeat(64) })).message.error, 'wrong challenge');
    assert.ok((await call(r, 9, 'rm', { path: '/' })).message.error, 'unrequested tool');
    assert.equal((await r.rpc(10, 'resources/read', { uri: 'file:///x' })).message.error.code, -32601);
    assert.deepEqual((await call(r, 11, QUERY, { node: 'entry', challenge: challenge() })).message.result, RESULT);
    assert.ok((await call(r, 12, QUERY, { node: 'entry', challenge: challenge() })).message.error, 'second query');
    r.end();
    const { code, result } = await r.done();
    assert.equal(code, 0);
    const seen = entries(ctx).filter(entry => entry.method !== undefined);
    assert.equal(seen.filter(entry => entry.method === 'tools/call').length, 1);
    assert.ok(!seen.some(entry => entry.method === 'resources/read'));
    assert.ok(result.frames.some(f => f.tool === QUERY && f.challengeMatched === false), 'wrong challenge recorded');
    const evaluation = evaluateServerEvidence(result.frames, spec);
    assert.equal(evaluation.attestation, 'attested');
    assert.equal(evaluation.query, 'answered');
    assert.equal(evaluation.unrequestedCalls, 1);
  } finally { await r.dispose(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('an uncorrelated response to the challenged query is a mismatch and closes both sides', async () => {
  const ctx = setup('wrong-id');
  const r = await run(ctx, { verify: { plan: plan({ challengeField: null }) } });
  try {
    await r.rpc(1, 'initialize', {});
    await r.rpc(2, 'tools/list');
    await call(r, 3, ATTEST, { marker: fixtureMarker, challenge: r.channel.challenge });
    r.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: QUERY, arguments: { node: 'entry' } } });
    const { code, result } = await r.done();
    assert.equal(code, 5);
    const last = result.frames.at(-1);
    assert.equal(last.challengeMatched, false);
    assert.equal(last.resultSha256, null);
    assert.equal(evaluateServerEvidence(result.frames, spec).query, 'challenge-mismatch');
    await assertUpstreamGone(ctx);
  } finally { await r.dispose(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

for (const [name, line, wanted] of [
  ['invalid json', 'not json', 5],
  ['array batch', '[]', 5],
  ['null id', '{"jsonrpc":"2.0","id":null,"method":"ping"}', 5],
  ['duplicate key', '{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}', 5],
  ['wrong version', '{"jsonrpc":"1.0","id":1,"method":"ping"}', 5],
  ['unsolicited response', '{"jsonrpc":"2.0","id":9,"result":{}}', 5],
  ['blank line', '', 5],
  ['excess depth', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: JSON.parse('['.repeat(16) + '0' + ']'.repeat(16)) }), 5],
  ['oversized line', 'x'.repeat(262145), 4]
]) {
  test(`malformed framing (${name}) closes both directions`, async () => {
    const ctx = setup('linger');
    const r = await run(ctx, { verify: { plan: plan() } });
    try {
      r.send(line);
      const { code } = await r.done();
      assert.equal(code, wanted);
      await assertUpstreamGone(ctx);
    } finally { await r.dispose(); rmSync(ctx.dir, { recursive: true, force: true }); }
  });
}

test('a duplicate in-flight id and a client id equal to the challenge are violations', async () => {
  const ctx = setup();
  const r = await run(ctx, { verify: { plan: plan() } });
  try {
    await r.rpc(1, 'initialize', {});
    r.send({ jsonrpc: '2.0', id: r.channel.challenge, method: 'ping' });
    assert.equal((await r.done()).code, 5);
  } finally { await r.dispose(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('the message bound is enforced in verification only', async () => {
  const ctx = setup();
  const r = await run(ctx, { verify: { plan: plan() } });
  try {
    for (let id = 1; id <= 520; id += 1) r.send({ jsonrpc: '2.0', id, method: 'ping' });
    assert.equal((await r.done()).code, 4);
    await assertUpstreamGone(ctx);
  } finally { await r.dispose(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('a wrong token, an unavailable peer identity or an invalid plan yield no frames and no forwarding', async () => {
  for (const verify of [{ plan: plan(), token: 'f'.repeat(64) }, { plan: plan(), peer: 'os' }, { plan: { ...plan(), extra: 1 } }]) {
    const ctx = setup('linger');
    const r = await run(ctx, { verify });
    try {
      r.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const { code, result } = await r.done();
      assert.equal(code, 3);
      assert.equal(result.frames.length, 0);
      assert.ok(!entries(ctx).some(entry => entry.method !== undefined), 'nothing forwarded');
      await assertUpstreamGone(ctx);
    } finally { await r.dispose(); rmSync(ctx.dir, { recursive: true, force: true }); }
  }
});

test('stopping closes a lingering upstream', async () => {
  const ctx = setup('linger');
  const r = await run(ctx);
  try {
    await r.rpc(1, 'initialize', {});
    r.end();
    assert.equal((await r.done()).code, 0);
    await assertUpstreamGone(ctx);
  } finally { await r.dispose(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('plan derivation, material integrity and the standalone Node-builtins-only source', () => {
  const fixture = bundledNativeFixtures[0];
  assert.deepEqual(recorderPlan({ server: fixture.server, instructions: fixture.instructions }), plan({ toolNames: [...fixture.server.toolNames] }));
  assert.equal(recorderPlan({ server: { ...fixture.server, queryTool: 'missing' }, instructions: fixture.instructions }), null);
  const material = recorderMaterial();
  assert.equal(material.byteLength, material.bytes.length);
  assert.equal(material.sha256, createHash('sha256').update(material.bytes).digest('hex'));
  assert.equal(recorderId, 'aihq.stdio-recorder.v1');
  const text = material.bytes.toString('utf8');
  const specifiers = [...text.matchAll(/from '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(specifiers.sort(), ['node:child_process', 'node:crypto', 'node:net', 'node:url']);
  assert.deepEqual(recorderCommand({ command: 'node', args: ['server.mjs'] }),
    { command: 'node', args: ['.aihq-native/recorder.mjs', '--', 'node', 'server.mjs'] });
});

// Linux-only: /proc resolution stands in for the fixed kernel peer facility; the claimed hello
// PID is resolved to the process's actual argv, parent and start time, never trusted by itself.
test('the nested Linux trampoline keeps the exact fixed remainder and the marker never reaches the upstream',
  { skip: process.platform === 'linux' ? false : 'Linux /proc peer observation only', timeout: 30_000 }, async () => {
  const ctx = setup();
  ctx.dir = realpathSync.native(ctx.dir);
  const recorderPath = join(ctx.dir, 'recorder.mjs');
  const mockPath = join(ctx.dir, 'mock.mjs');
  const expectedArgv = [process.execPath, recorderPath, '--aihq-native-absolute-entry', '--', process.execPath, mockPath];
  const identities = [];
  const channel = await createEvidenceChannel({ directory: ctx.dir, plan: plan(),
    peerIdentity: async (_socket, hello) => {
      try {
        const argv = readFileSync(`/proc/${hello.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        const stat = readFileSync(`/proc/${hello.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return { status: 'observed', pid: hello.pid, birth: fields[19], argv, ppid: Number(fields[1]) };
      } catch { return { status: 'unavailable' }; }
    },
    isOwnedServer: identity => {
      identities.push(identity);
      return Array.isArray(identity.argv) && identity.argv.length === expectedArgv.length &&
        identity.argv.every((value, index) => value === expectedArgv[index]);
    } });
  // The ordinary configured command line has no marker; the recorder must re-exec once to the
  // exact absolute entry with the declared remainder, and the nested child is the observed peer.
  const child = spawn(process.execPath, [recorderPath, '--', process.execPath, mockPath], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    env: { ...process.env, MOCK_LOG: ctx.log, MOCK_MODE: ctx.mode,
      AIHQ_NATIVE_EVIDENCE_CHANNEL: channel.endpoint, AIHQ_NATIVE_EVIDENCE_TOKEN: channel.token } });
  try {
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const rpc = async (id, method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return JSON.parse((await lines.next()).value);
    };
    await rpc(1, 'initialize', {});
    await rpc(2, 'tools/list');
    const attest = await rpc(3, 'tools/call', { name: ATTEST, arguments: { marker: fixtureMarker, challenge: channel.challenge } });
    assert.deepEqual(JSON.parse(attest.result.content[0].text), { markerSha256: fixtureMarkerSha256, challenge: channel.challenge });
    const query = await rpc(4, 'tools/call', { name: QUERY, arguments: { node: 'entry', challenge: channel.challenge } });
    assert.deepEqual(query.result, RESULT);
    child.stdin.end();
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    const result = await channel.close();
    assert.equal(result.peer, 'authenticated', JSON.stringify({ peer: result.peer, violation: result.violation }));
    assert.equal(result.violation, null);
    assert.equal(identities.length, 1);
    assert.deepEqual(identities[0].argv, expectedArgv);
    assert.notEqual(identities[0].pid, child.pid, 'the observed peer is the nested absolute-entry child, not the held launcher');
    assert.equal(identities[0].ppid, child.pid, 'the absolute-entry child is the immediate child of the launcher');
    const evaluation = evaluateServerEvidence(result.frames, spec);
    assert.equal(evaluation.attestation, 'attested');
    assert.equal(evaluation.query, 'answered');
    // The upstream saw the declared command and query only: the private marker was spliced out
    // and the verifier variables never reached it.
    const seen = entries(ctx);
    assert.equal(seen[0].leaked, false);
    assert.deepEqual(seen.find(entry => entry.method === 'tools/call').params.arguments, { node: 'entry', challenge: channel.challenge });
    await assertUpstreamGone(ctx);
  } finally { child.kill(); await channel.close().catch(() => {}); rmSync(ctx.dir, { recursive: true, force: true }); }
});
