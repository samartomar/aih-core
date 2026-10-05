// Bundled stdio recorder bytes (aihq.stdio-recorder.v1). Pure data: importing performs no host effects.
// The recorder is a standalone Node-builtins-only program staged by the verifier or referenced by the
// ordinary production configuration. Edits change its digest and need a new pin and Core version.
export const recorderId = 'aihq.stdio-recorder.v1';
export const recorderAttestTool = 'aihq_attest_instruction';
export const recorderRelativePath = '.aihq-native/recorder.mjs';
export const recorderMemberPath = 'package/harness/native/recorder/recorder.mjs';

// Exit codes: 0 normal, 2 usage, 3 verifier channel/plan failure, 4 bound exceeded, 5 protocol violation,
// 6 upstream spawn failure. No raw message, argument, result or stderr content is ever retained.
export const recorderSource = String.raw`import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const CHANNEL_ENV = 'AIHQ_NATIVE_EVIDENCE_CHANNEL';
const TOKEN_ENV = 'AIHQ_NATIVE_EVIDENCE_TOKEN';
const MAX_LINE = 262144;
const MAX_MESSAGES = 512;
const MAX_BYTES = 4194304;
const MAX_PENDING = 64;
const MAX_DEPTH = 16;
const HANDSHAKE_MS = 5000;
const STOP_MS = 1000;
const HEX = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

const sha = value => createHash('sha256').update(value).digest('hex');
const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

function canon(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canon(value[key])).join(',') + '}';
}
const digest = value => { try { return sha(canon(value)); } catch { return null; } };

// Strict JSON: duplicate keys, BOM, trailing data and excess depth are rejected.
function parse(text) {
  if (text.charCodeAt(0) === 0xfeff) throw new SyntaxError('json');
  let index = 0;
  const fail = () => { throw new SyntaxError('json'); };
  const space = () => { while (index < text.length && ' \t\r\n'.includes(text[index])) index++; };
  const string = () => {
    const start = index++;
    while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
    if (text[index] !== '"') fail();
    index++;
    try { return JSON.parse(text.slice(start, index)); } catch { return fail(); }
  };
  const value = depth => {
    if (depth > MAX_DEPTH) fail();
    space();
    const c = text[index];
    if (c === '{') {
      index++;
      const out = Object.create(null);
      space();
      if (text[index] === '}') { index++; return {}; }
      for (;;) {
        space();
        if (text[index] !== '"') fail();
        const key = string();
        if (Object.hasOwn(out, key)) fail();
        space();
        if (text[index++] !== ':') fail();
        out[key] = value(depth + 1);
        space();
        if (text[index] === ',') { index++; continue; }
        if (text[index++] === '}') return { ...out };
        fail();
      }
    }
    if (c === '[') {
      index++;
      const out = [];
      space();
      if (text[index] === ']') { index++; return out; }
      for (;;) {
        out.push(value(depth + 1));
        space();
        if (text[index] === ',') { index++; continue; }
        if (text[index++] === ']') return out;
        fail();
      }
    }
    if (c === '"') return string();
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index, index + 64));
    if (!match) fail();
    index += match[0].length;
    return JSON.parse(match[0]);
  };
  const result = value(1);
  space();
  if (index !== text.length) fail();
  return result;
}

const validId = id => (typeof id === 'string' && id.length > 0 && id.length <= 256) || Number.isSafeInteger(id);
const idKey = id => (typeof id === 'string' ? 's:' + id : 'n:' + id);
function classify(message) {
  if (!isRecord(message) || message.jsonrpc !== '2.0') return null;
  const hasId = Object.hasOwn(message, 'id');
  if (hasId && !validId(message.id)) return null;
  if (Object.hasOwn(message, 'method')) {
    if (typeof message.method !== 'string') return null;
    return hasId ? 'request' : 'notification';
  }
  if (hasId && Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error')) return 'response';
  return null;
}

function validatePlan(plan) {
  if (!exactKeys(plan, ['attestTool', 'markers', 'queryTool', 'queryArguments', 'challengeField', 'toolNames'])) return null;
  const { attestTool, markers, queryTool, queryArguments, challengeField, toolNames } = plan;
  const list = (value, test, max) => Array.isArray(value) && value.length <= max && value.every(test) &&
    new Set(value).size === value.length;
  if (!list(toolNames, item => typeof item === 'string' && NAME.test(item), 16) || toolNames.length < 1) return null;
  if (!list(markers, item => typeof item === 'string' && HEX.test(item), 16)) return null;
  if (typeof queryTool !== 'string' || !toolNames.includes(queryTool)) return null;
  if (!isRecord(queryArguments) || digest(queryArguments) === null) return null;
  if (challengeField !== null && (typeof challengeField !== 'string' || !NAME.test(challengeField) ||
      Object.hasOwn(queryArguments, challengeField))) return null;
  if (markers.length > 0) {
    if (typeof attestTool !== 'string' || !toolNames.includes(attestTool) || attestTool === queryTool) return null;
  } else if (attestTool !== null) return null;
  return plan;
}

const args = process.argv.slice(2);
const command = args[0] === '--' ? args.slice(1) : [];
if (command.length === 0) process.exit(2);

const channelPath = process.env[CHANNEL_ENV];
const channelToken = process.env[TOKEN_ENV];
const verifying = typeof channelPath === 'string' && channelPath !== '' &&
  typeof channelToken === 'string' && channelToken !== '';
const upstreamEnv = { ...process.env };
delete upstreamEnv[CHANNEL_ENV];
delete upstreamEnv[TOKEN_ENV];
if (verifying) {
  delete upstreamEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  delete upstreamEnv.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
}

const pending = new Map();
const serverPending = new Set();
const attested = new Set();
let plan = null;
let challenge = null;
let link = null;
let handshakeTimer = null;
let linkClosing = false;
let exiting = false;
let stopping = false;
let sequence = 0;
let messages = 0;
let bytes = 0;
let queries = 0;

let upstream;
try {
  upstream = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env: upstreamEnv, windowsHide: true });
} catch { process.exit(6); }
const alive = () => upstream.pid !== undefined && upstream.exitCode === null && upstream.signalCode === null;

// Close both directions, stop the upstream and leave only after it and the evidence link are gone.
function finish(code) {
  if (exiting) return;
  exiting = true;
  clearTimeout(handshakeTimer);
  linkClosing = true;
  for (const stream of [process.stdin, upstream.stdin, upstream.stdout]) {
    try { stream.destroy(); } catch { /* already closed */ }
  }
  const waits = [];
  if (link) {
    const done = link.destroyed ? null : new Promise(resolve => { link.once('close', resolve); setTimeout(resolve, 200).unref(); });
    try { link.end(); } catch { /* already closed */ }
    if (done) waits.push(done);
  }
  if (alive()) {
    waits.push(new Promise(resolve => {
      upstream.once('exit', resolve);
      try { upstream.kill(); } catch { /* gone */ }
      setTimeout(() => { try { upstream.kill('SIGKILL'); } catch { /* gone */ } }, STOP_MS).unref();
      setTimeout(resolve, STOP_MS * 2).unref();
    }));
  }
  Promise.all(waits).then(() => {
    const go = () => process.exit(code);
    try { process.stdout.write('', go); } catch { go(); }
    setTimeout(go, 500);
  });
}

function write(stream, text, source) {
  if (exiting || !stream || stream.destroyed || stream.writableEnded) return;
  if (!stream.write(text + '\n') && source) { source.pause(); stream.once('drain', () => source.resume()); }
}
const toUpstream = text => write(upstream.stdin, text, process.stdin);
const toClient = text => write(process.stdout, text, upstream.stdout);
const refuse = (id, code, message) => toClient(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));

function emit(method, tool, argumentsSha256, resultSha256, challengeMatched, markerSha256) {
  if (!link || sequence >= MAX_MESSAGES) return;
  sequence += 1;
  link.write(JSON.stringify({ version: 1, sequence, method, tool, argumentsSha256, resultSha256,
    challengeMatched, markerSha256 }) + '\n');
}

function count(size) {
  if (!verifying) return true;
  messages += 1;
  bytes += size;
  if (messages > MAX_MESSAGES || bytes > MAX_BYTES) { finish(4); return false; }
  return true;
}

function lineReader(onLine) {
  let buffer = Buffer.alloc(0);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      let index;
      while (!exiting && (index = buffer.indexOf(10)) >= 0) {
        let line = buffer.subarray(0, index);
        buffer = buffer.subarray(index + 1);
        if (line.length > 0 && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
        if (line.length > MAX_LINE) return finish(4);
        if (line.length === 0) return finish(5);
        let text;
        try { text = decoder.decode(line); } catch { return finish(5); }
        onLine(text, line.length + 1);
      }
      if (!exiting && buffer.length > MAX_LINE) finish(4);
    },
    end() { if (buffer.length > 0) { finish(5); return false; } return true; }
  };
}

const attestDescriptor = () => ({ name: plan.attestTool, description: 'Attest the loaded project instruction.',
  inputSchema: { type: 'object', properties: { marker: { type: 'string' }, challenge: { type: 'string' } },
    required: ['marker', 'challenge'], additionalProperties: false } });

function queryShape(callArguments) {
  if (!isRecord(callArguments)) return { ok: false, matched: null };
  const field = plan.challengeField;
  if (field === null) return { ok: digest(callArguments) === digest(plan.queryArguments), matched: null };
  if (!Object.hasOwn(callArguments, field) || typeof callArguments[field] !== 'string') return { ok: false, matched: null };
  const rest = { ...callArguments };
  delete rest[field];
  if (digest(rest) !== digest(plan.queryArguments)) return { ok: false, matched: null };
  const matched = callArguments[field] === challenge;
  return { ok: matched, matched };
}

function attest(id, callArguments, argsSha, tool) {
  const shaped = exactKeys(callArguments, ['marker', 'challenge']) && typeof callArguments.marker === 'string' &&
    typeof callArguments.challenge === 'string';
  const matched = shaped ? callArguments.challenge === challenge : null;
  const hash = shaped ? sha(callArguments.marker) : null;
  if (matched === true && plan.markers.includes(hash)) {
    attested.add(hash);
    const result = { content: [{ type: 'text', text: JSON.stringify({ markerSha256: hash, challenge }) }], isError: false };
    toClient(JSON.stringify({ jsonrpc: '2.0', id, result }));
    return emit('tools/call', tool, argsSha, digest(result), true, hash);
  }
  refuse(id, -32602, 'attestation rejected');
  emit('tools/call', tool, argsSha, null, matched, null);
}

function verifyCall(message, text, key) {
  const { id, params } = message;
  const name = isRecord(params) && typeof params.name === 'string' ? params.name : null;
  const callArguments = isRecord(params) ? params.arguments : undefined;
  const argsSha = isRecord(callArguments) ? digest(callArguments) : null;
  const tool = name !== null && plan.toolNames.includes(name) ? name : null;
  const deny = matched => { refuse(id, -32602, 'call not permitted'); emit('tools/call', tool, argsSha, null, matched, null); };
  if (!isRecord(params) || !Object.keys(params).every(item => item === 'name' || item === 'arguments' || item === '_meta')) return deny(null);
  if (plan.attestTool !== null && name === plan.attestTool) return attest(id, callArguments, argsSha, tool);
  if (name !== plan.queryTool) return deny(null);
  if (plan.markers.length > 0 && attested.size < plan.markers.length) return deny(null);
  const shape = queryShape(callArguments);
  if (!shape.ok) return deny(shape.matched);
  if (queries >= 1) return deny(shape.matched);
  queries += 1;
  const entry = { kind: 'query', clientId: id, tool, argsSha, challenged: plan.challengeField === null };
  if (entry.challenged) {
    pending.set('s:' + challenge, entry);
    return toUpstream(JSON.stringify({ ...message, id: challenge }));
  }
  pending.set(key, entry);
  toUpstream(text);
}

function verifyRequest(message, text, key) {
  const { id, method, params } = message;
  if (method === 'initialize' || method === 'ping' || method === 'tools/list') {
    const kind = method === 'initialize' ? 'init' : method === 'tools/list' ? 'list' : 'other';
    pending.set(key, { kind, clientId: id, paged: kind === 'list' && isRecord(params) && params.cursor !== undefined });
    return toUpstream(text);
  }
  if (method === 'tools/call') return verifyCall(message, text, key);
  refuse(id, -32601, 'method not permitted');
}

function fromClient(text, size) {
  if (exiting || !count(size)) return;
  let message;
  try { message = parse(text); } catch { return finish(5); }
  const kind = classify(message);
  if (kind === null) return finish(5);
  if (kind === 'notification') return toUpstream(text);
  if (kind === 'response') {
    if (!serverPending.delete(idKey(message.id))) return finish(5);
    return toUpstream(text);
  }
  const key = idKey(message.id);
  if (pending.has(key) || (verifying && message.id === challenge)) return finish(5);
  if (pending.size >= MAX_PENDING) return finish(4);
  if (!verifying) { pending.set(key, { kind: 'other' }); return toUpstream(text); }
  verifyRequest(message, text, key);
}

// A response that cannot be correlated to the challenged query is recorded as a challenge mismatch.
function uncorrelated() {
  for (const [key, entry] of pending) {
    if (entry.kind === 'query' && entry.challenged) {
      pending.delete(key);
      emit('tools/call', entry.tool, entry.argsSha, null, false, null);
      return;
    }
  }
}

function respond(entry, message, text) {
  const hasResult = Object.hasOwn(message, 'result');
  if (!verifying || entry.kind === 'other') return toClient(text);
  if (entry.kind === 'init') {
    toClient(text);
    if (hasResult) emit('initialize', null, null, null, null, null);
    return;
  }
  if (entry.kind === 'list') {
    if (!hasResult) return toClient(text);
    const result = message.result;
    if (!isRecord(result) || !Array.isArray(result.tools)) return finish(5);
    if (plan.attestTool !== null && result.tools.some(tool => isRecord(tool) && tool.name === plan.attestTool)) return finish(5);
    if (plan.attestTool !== null && !entry.paged) {
      toClient(JSON.stringify({ ...message, result: { ...result, tools: [...result.tools, attestDescriptor()] } }));
    } else toClient(text);
    return emit('tools/list', null, null, null, null, null);
  }
  toClient(entry.challenged ? JSON.stringify({ ...message, id: entry.clientId }) : text);
  emit('tools/call', entry.tool, entry.argsSha, hasResult ? digest(message.result) : null, true, null);
}

function fromUpstream(text, size) {
  if (exiting || !count(size)) return;
  let message;
  try { message = parse(text); } catch { return finish(5); }
  const kind = classify(message);
  if (kind === null) return finish(5);
  if (kind === 'notification') return toClient(text);
  if (kind === 'request') {
    if (verifying && message.method !== 'ping') {
      return toUpstream(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not permitted' } }));
    }
    const key = idKey(message.id);
    if (serverPending.has(key) || serverPending.size >= MAX_PENDING) return finish(5);
    serverPending.add(key);
    return toClient(text);
  }
  const key = idKey(message.id);
  const entry = pending.get(key);
  if (!entry) { if (verifying) uncorrelated(); return finish(5); }
  pending.delete(key);
  respond(entry, message, text);
}

function startClient() {
  const reader = lineReader(fromClient);
  process.stdin.on('data', chunk => reader.push(chunk));
  process.stdin.on('error', () => finish(0));
  process.stdin.on('end', () => {
    if (!reader.end()) return;
    stopping = true;
    try { upstream.stdin.end(); } catch { /* already closed */ }
    setTimeout(() => { if (!exiting && alive()) { try { upstream.kill(); } catch { /* gone */ } } }, STOP_MS).unref();
  });
}

upstream.on('error', () => finish(6));
upstream.on('close', code => finish(stopping || exiting ? 0 : (code ?? 1)));
upstream.stdin?.on('error', () => {});
process.stdout.on('error', () => finish(0));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => finish(0));
const upstreamReader = lineReader(fromUpstream);
upstream.stdout?.on('data', chunk => upstreamReader.push(chunk));
upstream.stdout?.on('end', () => { upstreamReader.end(); });

if (!verifying) {
  // Without verifier instrumentation this is an ordinary byte-transparent stdio proxy.
  upstream.stdout.removeAllListeners('data');
  upstream.stdout.removeAllListeners('end');
  process.stdin.pipe(upstream.stdin);
  upstream.stdout.pipe(process.stdout);
  process.stdin.on('end', () => { stopping = true; finish(0); });
  process.stdin.on('error', () => finish(0));
}
else {
  link = net.connect(channelPath);
  handshakeTimer = setTimeout(() => finish(3), HANDSHAKE_MS);
  link.on('connect', () => link.write(JSON.stringify({ version: 1, token: channelToken, pid: process.pid }) + '\n'));
  link.on('error', () => finish(3));
  link.on('close', () => { if (!linkClosing) finish(3); });
  let hello = Buffer.alloc(0);
  link.on('data', chunk => {
    if (challenge !== null || exiting) return;
    hello = Buffer.concat([hello, chunk]);
    if (hello.length > 65536) return finish(3);
    const end = hello.indexOf(10);
    if (end < 0) return;
    let message;
    try { message = parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(hello.subarray(0, end))); }
    catch { return finish(3); }
    const accepted = exactKeys(message, ['type', 'challenge', 'plan']) && message.type === 'challenge' &&
      typeof message.challenge === 'string' && HEX.test(message.challenge) ? validatePlan(message.plan) : null;
    if (accepted === null) return finish(3);
    plan = accepted;
    challenge = message.challenge;
    clearTimeout(handshakeTimer);
    startClient();
  });
}
`;
