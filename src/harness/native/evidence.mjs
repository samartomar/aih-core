// Per-session authenticated observation channel, strict frame validation and server-evidence evaluation.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { SHA256_RE, hasExactKeys, isSafeInteger, parseStrictJson } from './canonical.mjs';
import { nativeBounds } from './contracts.mjs';

const FRAME_KEYS = ['version', 'sequence', 'method', 'tool', 'argumentsSha256', 'resultSha256', 'challengeMatched', 'markerSha256'];
const METHODS = ['initialize', 'tools/list', 'tools/call'];
const HEX256 = /^[0-9a-f]{64}$/;

// The OS peer-identity facility. Node exposes neither SO_PEERCRED nor GetNamedPipeClientProcessId,
// so no honest implementation exists here: this returns unavailable and the stream is refused.
export const osPeerIdentity = async () => ({ status: 'unavailable' });

export function validateEvidenceFrame(frame, lastSequence, toolNames) {
  const nullableSha = value => value === null || (typeof value === 'string' && SHA256_RE.test(value));
  const valid = hasExactKeys(frame, FRAME_KEYS) && frame.version === 1 &&
    isSafeInteger(frame.sequence, 1, Number.MAX_SAFE_INTEGER) && frame.sequence > lastSequence &&
    METHODS.includes(frame.method) && (frame.tool === null || toolNames.includes(frame.tool)) &&
    nullableSha(frame.argumentsSha256) && nullableSha(frame.resultSha256) && nullableSha(frame.markerSha256) &&
    (frame.challengeMatched === null || typeof frame.challengeMatched === 'boolean') &&
    (frame.method === 'tools/call' || [frame.tool, frame.argumentsSha256, frame.resultSha256, frame.challengeMatched, frame.markerSha256].every(value => value === null)) &&
    (frame.markerSha256 === null || frame.tool === 'aihq_attest_instruction');
  return { valid };
}

export async function createEvidenceChannel({ directory, peerIdentity = osPeerIdentity, isOwnedServer = () => false,
  toolNames = ['aihq_attest_instruction', 'aihq_graph_query'], plan = null }) {
  const token = randomBytes(32).toString('hex');
  const challenge = randomBytes(32).toString('hex');
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\aihq-native-${randomBytes(16).toString('hex')}`
    : join(directory, `ev-${randomBytes(8).toString('hex')}.sock`);
  const state = { frames: [], bytes: 0, connections: 0, rejectedFrames: 0, peer: 'none', violation: null, authenticated: null };
  const sockets = new Set();
  const tokenBuffer = Buffer.from(token);

  const violate = reason => { state.violation ??= reason; for (const socket of sockets) socket.destroy(); };
  const server = net.createServer(socket => {
    state.connections += 1;
    if (state.connections > nativeBounds.channelTotal || sockets.size >= nativeBounds.channelConcurrent) {
      state.violation ??= 'limit-exceeded'; socket.destroy(); return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let phase = 'hello';
    let last = 0;
    let busy = false;
    const queue = [];
    const reject = status => { if (state.peer !== 'authenticated') state.peer = status; socket.destroy(); };
    const handleLine = async line => {
      if (phase === 'hello') {
        let hello;
        try { hello = parseStrictJson(line, nativeBounds.frameDepth); } catch { return reject('rejected'); }
        const provided = Buffer.from(typeof hello?.token === 'string' ? hello.token : '');
        if (!hasExactKeys(hello, ['version', 'token', 'pid']) || hello.version !== 1 ||
            !isSafeInteger(hello.pid, 1, Number.MAX_SAFE_INTEGER) ||
            provided.length !== tokenBuffer.length || !timingSafeEqual(provided, tokenBuffer)) return reject('rejected');
        if (state.authenticated) return reject('rejected'); // one stream per session
        let identity;
        try { identity = await peerIdentity(socket, hello); } catch { identity = { status: 'unavailable' }; }
        if (identity?.status !== 'observed') return reject('unavailable');
        if (identity.pid !== hello.pid || !isOwnedServer(identity)) return reject('rejected');
        state.authenticated = identity; state.peer = 'authenticated'; phase = 'frames';
        socket.write(JSON.stringify(plan === null ? { type: 'challenge', challenge } : { type: 'challenge', challenge, plan }) + '\n');
        return;
      }
      let frame;
      try { frame = parseStrictJson(line, nativeBounds.frameDepth); } catch { state.rejectedFrames += 1; return violate('frame-invalid'); }
      if (state.frames.length >= nativeBounds.frames) return violate('limit-exceeded');
      if (!validateEvidenceFrame(frame, last, toolNames).valid) { state.rejectedFrames += 1; return violate('frame-invalid'); }
      last = frame.sequence;
      state.frames.push(frame);
    };
    const pump = async () => {
      if (busy) return;
      busy = true;
      while (queue.length && !state.violation) await handleLine(queue.shift());
      busy = false;
    };
    socket.on('data', chunk => {
      state.bytes += chunk.length;
      if (state.bytes > nativeBounds.recorderBytes) return violate('limit-exceeded');
      buffer = Buffer.concat([buffer, chunk]);
      let index;
      while ((index = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, index);
        buffer = buffer.subarray(index + 1);
        if (line.length > nativeBounds.frameBytes || queue.length >= nativeBounds.frames) return violate('frame-invalid');
        try { queue.push(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line)); }
        catch { return violate('frame-invalid'); }
      }
      if (buffer.length > nativeBounds.frameBytes) return violate('frame-invalid');
      pump();
    });
    socket.on('end', () => { if (buffer.length) violate('frame-invalid'); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  if (process.platform !== 'win32') {
    try { chmodSync(endpoint, 0o600); }
    catch { await new Promise(resolve => server.close(resolve)); rmSync(endpoint, { force: true }); throw new Error('channel-protection-unavailable'); }
  }

  return {
    endpoint, token, challenge,
    snapshot() { return { frames: state.frames.map(value => ({ ...value })), bytes: state.bytes, connections: state.connections,
      rejectedFrames: state.rejectedFrames, peer: state.peer, violation: state.violation }; },
    async close() {
      for (const socket of sockets) socket.end();
      await new Promise(resolve => setTimeout(resolve, 20)); // drain already-received data only
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      if (process.platform !== 'win32') rmSync(endpoint, { force: true });
      return { frames: state.frames.slice(), bytes: state.bytes, connections: state.connections,
        rejectedFrames: state.rejectedFrames, peer: state.peer, violation: state.violation };
    }
  };
}

// Production entry: only the OS peer facility may authenticate the helper process.
export const startEvidenceChannel = ({ directory, isOwnedServer, plan = null }) => {
  if (process.platform === 'win32') throw new Error('channel-protection-unavailable');
  return createEvidenceChannel({ directory, peerIdentity: osPeerIdentity, isOwnedServer, plan });
};

// Evaluate server-side frames. Every missing or inconsistent record stays unproven.
export function evaluateServerEvidence(frames, { attestTool, queryTool, markerSha256, expectedResultSha256 }) {
  const calls = frames.filter(frame => frame.method === 'tools/call');
  const attestFrames = calls.filter(frame => frame.tool === attestTool);
  const attestedFrame = attestFrames.find(frame => frame.resultSha256 !== null && frame.challengeMatched === true &&
    (markerSha256 === null || frame.markerSha256 === markerSha256));
  let attestation = 'missing';
  if (markerSha256 === null) attestation = 'not-required';
  else if (attestedFrame) attestation = 'attested';
  else if (attestFrames.length) attestation = 'mismatch';
  // Ambiguity is judged against an accepted attestation: access before it could have supplied the
  // instruction by another route. With no accepted attestation the attestation outcome governs.
  const ambiguousBeforeAttestation = attestedFrame !== undefined &&
    calls.some(frame => frame.tool !== attestTool && frame.resultSha256 !== null && frame.sequence < attestedFrame.sequence);
  const queries = calls.filter(frame => frame.tool === queryTool);
  const answered = queries.find(frame => frame.resultSha256 !== null && frame.challengeMatched === true);
  let query = 'missing';
  if (answered) query = answered.resultSha256 === expectedResultSha256 ? 'answered' : 'result-mismatch';
  else if (queries.some(frame => frame.challengeMatched === false)) query = 'challenge-mismatch';
  else if (queries.length) query = 'refused';
  return {
    initialize: frames.some(frame => frame.method === 'initialize'),
    discovery: frames.some(frame => frame.method === 'tools/list') ? 'complete' : 'missing',
    attestation, ambiguousBeforeAttestation, query,
    queryResultSha256: answered ? answered.resultSha256 : null,
    unrequestedCalls: calls.filter(frame => frame.tool !== attestTool && frame.tool !== queryTool).length,
    rejectedCalls: calls.filter(frame => frame.resultSha256 === null).length,
    rejectedQueryCalls: queries.filter(frame => frame.resultSha256 === null).length
  };
}
