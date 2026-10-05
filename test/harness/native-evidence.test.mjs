import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { createEvidenceChannel, validateEvidenceFrame, evaluateServerEvidence }
  from '../../src/harness/native/evidence.mjs';
import { fixtureFiles, fixtureMarker, fixtureMarkerSha256 } from '../../src/harness/native/fixture-data.mjs';
import { bundledNativeFixtures } from '../../src/harness/native/contracts.mjs';

const spec = (() => {
  const { server, instructions } = bundledNativeFixtures[0];
  return { attestTool: 'aihq_attest_instruction', queryTool: server.queryTool, toolNames: server.toolNames,
    markerSha256: instructions[0].markerSha256, expectedResultSha256: server.expectedResultSha256 };
})();

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), 'aihq-native-ev-'));
  writeFileSync(join(dir, 'server.mjs'), fixtureFiles.server.text);
  return dir;
}

// A controlled peer provider stands in for the OS facility: it accepts the spawned fixture's PID.
const peerFor = child => ({
  peerIdentity: async (_socket, hello) => ({ status: 'observed', pid: hello.pid, birth: 'test-birth' }),
  isOwnedServer: identity => identity.pid === child.pid && identity.birth === 'test-birth'
});

async function session({ dir, channel, token, env = {} }) {
  // Controlled peers retain their directly held PID, so they pass the fixed absolute-entry
  // marker explicitly on every trampoline platform. The real Job tests exercise the unchanged
  // relative configuration and its absolute-entry child separately.
  const child = spawn(process.execPath, [join(dir, 'server.mjs'),
    ...(process.platform === 'win32' || process.platform === 'linux' ? ['--aihq-native-absolute-entry'] : [])], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    env: { ...process.env, AIHQ_NATIVE_EVIDENCE_CHANNEL: channel.endpoint,
      AIHQ_NATIVE_EVIDENCE_TOKEN: token ?? channel.token, ...env } });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const rpc = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const { value } = await lines.next();
    return JSON.parse(value);
  };
  const exit = once(child, 'exit');
  return { child, rpc, exit, end: () => child.stdin.end() };
}

test('a fixture session emits ordered authenticated frames that evaluate as proven', async () => {
  const dir = workdir();
  const holder = {};
  const channel = await createEvidenceChannel({ directory: dir, ...{ peerIdentity: async (...a) => holder.peer.peerIdentity(...a), isOwnedServer: i => holder.peer.isOwnedServer(i) } });
  const s = await session({ dir, channel });
  holder.peer = peerFor(s.child);
  try {
    assert.equal((await s.rpc(1, 'initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'aihq-native-fixture');
    const tools = (await s.rpc(2, 'tools/list')).result.tools.map(t => t.name);
    assert.deepEqual(tools, ['aihq_attest_instruction', 'aihq_graph_query']);
    const attest = await s.rpc(3, 'tools/call', { name: 'aihq_attest_instruction', arguments: { marker: fixtureMarker, challenge: channel.challenge } });
    assert.deepEqual(JSON.parse(attest.result.content[0].text), { markerSha256: fixtureMarkerSha256, challenge: channel.challenge });
    const query = await s.rpc(4, 'tools/call', { name: 'aihq_graph_query', arguments: { node: 'entry', challenge: channel.challenge } });
    assert.deepEqual(query.result, { content: [{ type: 'text', text: 'leaf' }], isError: false });
    s.end();
    await s.exit;
    const result = await channel.close();
    assert.equal(result.peer, 'authenticated');
    assert.equal(result.violation, null);
    assert.deepEqual(result.frames.map(f => [f.sequence, f.method, f.tool]), [
      [1, 'initialize', null], [2, 'tools/list', null],
      [3, 'tools/call', 'aihq_attest_instruction'], [4, 'tools/call', 'aihq_graph_query']]);
    const evaluation = evaluateServerEvidence(result.frames, spec);
    assert.equal(evaluation.discovery, 'complete');
    assert.equal(evaluation.attestation, 'attested');
    assert.equal(evaluation.ambiguousBeforeAttestation, false);
    assert.equal(evaluation.query, 'answered');
    if (process.platform !== 'win32') assert.equal(existsSync(channel.endpoint), false);
  } finally { s.child.kill(); rmSync(dir, { recursive: true, force: true }); }
});

test('a wrong channel token yields no frames and no peer', async () => {
  const dir = workdir();
  const channel = await createEvidenceChannel({ directory: dir, peerIdentity: async () => ({ status: 'unavailable' }), isOwnedServer: () => false });
  const s = await session({ dir, channel, token: 'f'.repeat(64) });
  const [code] = await s.exit;
  const result = await channel.close();
  assert.equal(code, 3);
  assert.equal(result.frames.length, 0);
  assert.notEqual(result.peer, 'authenticated');
  rmSync(dir, { recursive: true, force: true });
});

test('the OS peer facility is unavailable by default so the stream is refused', async () => {
  const dir = workdir();
  const channel = await createEvidenceChannel({ directory: dir });
  const s = await session({ dir, channel });
  const [code] = await s.exit;
  const result = await channel.close();
  assert.equal(code, 3);
  assert.equal(result.peer, 'unavailable');
  assert.equal(result.frames.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('a peer that is not the owned server is rejected', async () => {
  const dir = workdir();
  const channel = await createEvidenceChannel({ directory: dir,
    peerIdentity: async (_s, hello) => ({ status: 'observed', pid: hello.pid, birth: 'x' }), isOwnedServer: () => false });
  const s = await session({ dir, channel });
  const [code] = await s.exit;
  const result = await channel.close();
  assert.equal(code, 3);
  assert.equal(result.peer, 'rejected');
  rmSync(dir, { recursive: true, force: true });
});

test('a refused early query does not establish an alternate instruction read', async () => {
  const dir = workdir();
  const holder = {};
  const channel = await createEvidenceChannel({ directory: dir, peerIdentity: async (...a) => holder.peer.peerIdentity(...a), isOwnedServer: i => holder.peer.isOwnedServer(i) });
  const s = await session({ dir, channel });
  holder.peer = peerFor(s.child);
  try {
    await s.rpc(1, 'initialize', {});
    await s.rpc(2, 'tools/list');
    const early = await s.rpc(3, 'tools/call', { name: 'aihq_graph_query', arguments: { node: 'entry', challenge: channel.challenge } });
    assert.ok(early.error);
    await s.rpc(4, 'tools/call', { name: 'aihq_attest_instruction', arguments: { marker: fixtureMarker, challenge: channel.challenge } });
    s.end();
    await s.exit;
    const evaluation = evaluateServerEvidence((await channel.close()).frames, spec);
    assert.equal(evaluation.ambiguousBeforeAttestation, false);
    assert.equal(evaluation.query, 'refused');
  } finally { s.child.kill(); rmSync(dir, { recursive: true, force: true }); }
});

test('an answered read before attestation makes the instruction source ambiguous', () => {
  const frame = (sequence, tool, markerSha256 = null) => ({ version: 1, sequence, method: 'tools/call', tool,
    argumentsSha256: 'a'.repeat(64), resultSha256: spec.expectedResultSha256, challengeMatched: true, markerSha256 });
  const result = evaluateServerEvidence([frame(1, spec.queryTool), frame(2, spec.attestTool, spec.markerSha256)], spec);
  assert.equal(result.ambiguousBeforeAttestation, true);
});

test('wrong challenge and wrong marker are reported as mismatches, never as passes', async () => {
  const dir = workdir();
  const holder = {};
  const channel = await createEvidenceChannel({ directory: dir, peerIdentity: async (...a) => holder.peer.peerIdentity(...a), isOwnedServer: i => holder.peer.isOwnedServer(i) });
  const s = await session({ dir, channel });
  holder.peer = peerFor(s.child);
  try {
    await s.rpc(1, 'initialize', {});
    await s.rpc(2, 'tools/list');
    assert.ok((await s.rpc(3, 'tools/call', { name: 'aihq_attest_instruction', arguments: { marker: 'changed', challenge: channel.challenge } })).error);
    assert.ok((await s.rpc(4, 'tools/call', { name: 'aihq_graph_query', arguments: { node: 'entry', challenge: '0'.repeat(64) } })).error);
    s.end();
    await s.exit;
    const evaluation = evaluateServerEvidence((await channel.close()).frames, spec);
    assert.equal(evaluation.attestation, 'mismatch');
    assert.equal(evaluation.query, 'challenge-mismatch');
  } finally { s.child.kill(); rmSync(dir, { recursive: true, force: true }); }
});

test('without a verifier channel the fixture hides attestation and answers nothing', async () => {
  const dir = workdir();
  const env = { ...process.env };
  delete env.AIHQ_NATIVE_EVIDENCE_CHANNEL;
  delete env.AIHQ_NATIVE_EVIDENCE_TOKEN;
  const child = spawn(process.execPath, [join(dir, 'server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], env, windowsHide: true });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const rpc = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return JSON.parse((await lines.next()).value);
  };
  try {
    assert.deepEqual((await rpc(1, 'tools/list')).result.tools.map(t => t.name), ['aihq_graph_query']);
    assert.ok((await rpc(2, 'tools/call', { name: 'aihq_graph_query', arguments: { node: 'entry', challenge: '0'.repeat(64) } })).error);
    assert.ok((await rpc(3, 'tools/call', { name: 'aihq_attest_instruction', arguments: { marker: fixtureMarker, challenge: '0'.repeat(64) } })).error);
  } finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
});

test('frame validation is strict', () => {
  const frame = { version: 1, sequence: 1, method: 'tools/list', tool: null, argumentsSha256: null,
    resultSha256: null, challengeMatched: null, markerSha256: null };
  assert.equal(validateEvidenceFrame(frame, 0, spec.toolNames).valid, true);
  assert.equal(validateEvidenceFrame({ ...frame, sequence: 1 }, 1, spec.toolNames).valid, false); // not increasing
  assert.equal(validateEvidenceFrame({ ...frame, sequence: 0 }, 0, spec.toolNames).valid, false);
  assert.equal(validateEvidenceFrame({ ...frame, extra: 1 }, 0, spec.toolNames).valid, false);
  assert.equal(validateEvidenceFrame({ ...frame, method: 'tools/other' }, 0, spec.toolNames).valid, false);
  assert.equal(validateEvidenceFrame({ ...frame, tool: 'other_tool' }, 0, spec.toolNames).valid, false);
  assert.equal(validateEvidenceFrame({ ...frame, argumentsSha256: 'abc' }, 0, spec.toolNames).valid, false);
  assert.equal(validateEvidenceFrame({ ...frame, challengeMatched: 'yes' }, 0, spec.toolNames).valid, false);
  assert.equal(validateEvidenceFrame({ ...frame, version: 2 }, 0, spec.toolNames).valid, false);
});

test('a lookalike client cannot feed frames: forged, flooded or malformed streams violate', async () => {
  const dir = workdir();
  const channel = await createEvidenceChannel({ directory: dir,
    peerIdentity: async (_s, hello) => ({ status: 'observed', pid: hello.pid, birth: 'b' }), isOwnedServer: i => i.pid === 4242 });
  const flood = await new Promise((resolve, reject) => {
    const socket = net.connect(channel.endpoint, () => {
      socket.write(JSON.stringify({ version: 1, token: channel.token, pid: 4242 }) + '\n');
      const frames = [];
      for (let i = 1; i <= 600; i++) frames.push(JSON.stringify({ version: 1, sequence: i, method: 'tools/list', tool: null,
        argumentsSha256: null, resultSha256: null, challengeMatched: null, markerSha256: null }));
      socket.write(frames.join('\n') + '\n');
    });
    socket.on('error', () => {});
    socket.resume();
    socket.on('close', () => resolve(true));
    setTimeout(() => reject(new Error('flood not closed')), 5000).unref();
  });
  assert.equal(flood, true);
  const result = await channel.close();
  assert.equal(result.violation, 'limit-exceeded');
  assert.ok(result.frames.length <= 512);
  rmSync(dir, { recursive: true, force: true });
});

test('evaluation treats missing or incomplete records as unproven', () => {
  const none = evaluateServerEvidence([], spec);
  assert.equal(none.discovery, 'missing');
  assert.equal(none.attestation, 'missing');
  assert.equal(none.query, 'missing');
  const listOnly = evaluateServerEvidence([{ version: 1, sequence: 1, method: 'tools/list', tool: null, argumentsSha256: null,
    resultSha256: null, challengeMatched: null, markerSha256: null }], spec);
  assert.equal(listOnly.discovery, 'complete');
  assert.equal(listOnly.query, 'missing');
  const wrongResult = evaluateServerEvidence([
    { version: 1, sequence: 1, method: 'tools/call', tool: 'aihq_attest_instruction', argumentsSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), challengeMatched: true, markerSha256: fixtureMarkerSha256 },
    { version: 1, sequence: 2, method: 'tools/call', tool: 'aihq_graph_query', argumentsSha256: 'a'.repeat(64), resultSha256: 'c'.repeat(64), challengeMatched: true, markerSha256: null }], spec);
  assert.equal(wrongResult.query, 'result-mismatch');
});

// Linux-only: /proc resolution stands in for the fixed kernel peer facility. The claimed hello
// PID is resolved to the process's actual argv, parent and start time; the claim alone never
// establishes ownership. The fixed ELF facility keeps its own kernel-side checks.
const LINUX_TRAMPOLINE = { skip: process.platform === 'linux' ? false : 'Linux /proc peer observation only', timeout: 30_000 };
const procIdentity = pid => {
  const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { argv, ppid: Number(fields[1]), birth: fields[19] };
};

test('the nested Linux trampoline is the exact absolute entry and a claimed parent PID is not ownership', LINUX_TRAMPOLINE, async () => {
  const dir = realpathSync.native(workdir());
  const module = join(dir, 'server.mjs');
  const expectedArgv = [process.execPath, module, '--aihq-native-absolute-entry'];
  const identities = [];
  const channel = await createEvidenceChannel({ directory: dir,
    peerIdentity: async (_socket, hello) => {
      try {
        const observed = procIdentity(hello.pid);
        return { status: 'observed', pid: hello.pid, birth: observed.birth, argv: observed.argv, ppid: observed.ppid };
      } catch { return { status: 'unavailable' }; }
    },
    isOwnedServer: identity => {
      identities.push(identity);
      return Array.isArray(identity.argv) && identity.argv.length === expectedArgv.length &&
        identity.argv.every((value, index) => value === expectedArgv[index]);
    } });
  // The plain configured launch carries no marker; the fixture must re-exec once to the absolute entry.
  const child = spawn(process.execPath, [module], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    env: { ...process.env, AIHQ_NATIVE_EVIDENCE_CHANNEL: channel.endpoint, AIHQ_NATIVE_EVIDENCE_TOKEN: channel.token } });
  try {
    // A forged stream claiming the held launcher PID: the launcher's actual argv lacks the
    // absolute-entry marker, so the claim is refused ownership and closed before any frame.
    await new Promise((resolve, reject) => {
      const socket = net.connect(channel.endpoint, () =>
        socket.write(JSON.stringify({ version: 1, token: channel.token, pid: child.pid }) + '\n'));
      socket.on('error', () => {});
      socket.resume();
      socket.on('close', resolve);
      setTimeout(() => reject(new Error('the forged stream was not closed')), 10_000).unref();
    });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const rpc = async (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return JSON.parse((await lines.next()).value);
    };
    // Had the forged claim taken ownership, the real child would be refused, never receive the
    // challenge and never answer; completing this session proves the claim did not authenticate.
    assert.equal((await rpc(1, 'initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'aihq-native-fixture');
    await rpc(2, 'tools/list');
    await rpc(3, 'tools/call', { name: 'aihq_attest_instruction', arguments: { marker: fixtureMarker, challenge: channel.challenge } });
    const query = await rpc(4, 'tools/call', { name: 'aihq_graph_query', arguments: { node: 'entry', challenge: channel.challenge } });
    assert.deepEqual(query.result, { content: [{ type: 'text', text: 'leaf' }], isError: false });
    child.stdin.end();
    await once(child, 'exit');
    const result = await channel.close();
    assert.equal(result.peer, 'authenticated', JSON.stringify({ peer: result.peer, violation: result.violation }));
    assert.equal(result.violation, null);
    assert.equal(result.connections, 2, 'the forged stream and the one real stream');
    const owned = identities.filter(identity => Array.isArray(identity.argv) &&
      identity.argv.length === expectedArgv.length && identity.argv.every((value, index) => value === expectedArgv[index]));
    assert.equal(owned.length, 1);
    assert.notEqual(owned[0].pid, child.pid, 'the observed peer is the nested absolute-entry child, not the held launcher');
    assert.equal(owned[0].ppid, child.pid, 'the absolute-entry child is the immediate child of the launcher');
    assert.match(String(owned[0].birth), /^\d+$/, 'the birth identity comes from /proc, not from the claim');
    assert.ok(identities.some(identity => identity.pid === child.pid && !identity.argv.includes('--aihq-native-absolute-entry')),
      'the forged claim was observed and refused: the held launcher PID is not the exact entry');
    const evaluation = evaluateServerEvidence(result.frames, spec);
    assert.equal(evaluation.attestation, 'attested');
    assert.equal(evaluation.query, 'answered');
  } finally { child.kill(); await channel.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});