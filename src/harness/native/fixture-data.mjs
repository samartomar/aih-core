// Node-side bundled mechanism fixture bytes. Template literals normalize CRLF to LF.
import { fixtureServerName, fixtureAttestTool, fixtureQueryTool, fixtureAnswer, fixtureMarker } from './fixture-metadata.mjs';
export { fixtureId, fixtureServerName, fixtureAttestTool, fixtureQueryTool, fixtureAnswer, fixtureMarker,
  fixtureMarkerSha256, fixtureResultText, fixturePins } from './fixture-metadata.mjs';
const server = String.raw`import net from 'node:net';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only the exact absolute-entry child opens the verification channel on Windows.
// The configuration's relative command remains unchanged between fresh sessions.
if (process.platform === 'win32' && process.env.AIHQ_NATIVE_EVIDENCE_CHANNEL &&
    process.argv[2] !== '--aihq-native-absolute-entry') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--aihq-native-absolute-entry'],
    { shell: false, windowsHide: true, stdio: 'inherit', env: process.env });
  child.once('error', () => process.exit(3));
  child.once('exit', code => process.exit(code ?? 3));
  await new Promise(() => {});
}

const MARKER_SHA256 = 'b72afeee5e166888b49f9144f12d6ed80e11a6f835064874527c23b35da2c233';
const ATTEST = 'aihq_attest_instruction';
const QUERY = 'aihq_graph_query';
const MAX_MESSAGES = 512;
const MAX_LINE = 262144;
const MAX_BYTES = 4194304;
const sha = value => createHash('sha256').update(value).digest('hex');
const canon = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canon).join(',') + ']'
  : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canon(value[key])).join(',') + '}';
const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

const channel = process.env.AIHQ_NATIVE_EVIDENCE_CHANNEL;
const token = process.env.AIHQ_NATIVE_EVIDENCE_TOKEN;
const verifying = typeof channel === 'string' && channel !== '' && typeof token === 'string' && token !== '';
let challenge = null;
let link = null;
let sequence = 0;
let attested = false;
let messages = 0;
let bytes = 0;

const ready = new Promise(resolve => {
  if (!verifying) return resolve();
  link = net.connect(channel);
  link.on('connect', () => link.write(JSON.stringify({ version: 1, token, pid: process.pid }) + '\n'));
  link.on('error', () => process.exit(3));
  link.on('close', () => { if (challenge === null) process.exit(3); });
  createInterface({ input: link }).once('line', line => {
    try {
      const message = JSON.parse(line);
      if (exactKeys(message, ['type', 'challenge']) && message.type === 'challenge' &&
          /^[0-9a-f]{64}$/.test(message.challenge)) { challenge = message.challenge; return resolve(); }
    } catch { /* fall through */ }
    process.exit(3);
  });
});

const emit = (method, tool, argumentsSha256, resultSha256, challengeMatched, markerSha256) => {
  if (!link || sequence >= MAX_MESSAGES) return;
  sequence += 1;
  link.write(JSON.stringify({ version: 1, sequence, method, tool, argumentsSha256, resultSha256,
    challengeMatched, markerSha256 }) + '\n');
};
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const fail = (id, code, text) => send({ jsonrpc: '2.0', id, error: { code, message: text } });
const textResult = text => ({ content: [{ type: 'text', text }], isError: false });

const tools = () => {
  const list = [{ name: QUERY, description: 'Read the fixture graph.',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, challenge: { type: 'string' } },
      required: ['node', 'challenge'], additionalProperties: false } }];
  if (link) list.unshift({ name: ATTEST, description: 'Attest the loaded project instruction.',
    inputSchema: { type: 'object', properties: { marker: { type: 'string' }, challenge: { type: 'string' } },
      required: ['marker', 'challenge'], additionalProperties: false } });
  return list;
};

const call = (id, params) => {
  const name = isRecord(params) ? params.name : undefined;
  const args = isRecord(params) ? params.arguments : undefined;
  const argsSha = isRecord(args) ? sha(canon(args)) : null;
  if (name === ATTEST && link && exactKeys(args, ['marker', 'challenge']) &&
      typeof args.marker === 'string' && typeof args.challenge === 'string') {
    const matched = args.challenge === challenge;
    if (matched && sha(args.marker) === MARKER_SHA256) {
      attested = true;
      const result = textResult(JSON.stringify({ markerSha256: MARKER_SHA256, challenge }));
      send({ jsonrpc: '2.0', id, result });
      return emit('tools/call', ATTEST, argsSha, sha(canon(result)), true, MARKER_SHA256);
    }
    fail(id, -32602, 'attestation rejected');
    return emit('tools/call', ATTEST, argsSha, null, matched, null);
  }
  if (name === QUERY && link && exactKeys(args, ['node', 'challenge']) && typeof args.challenge === 'string') {
    const matched = args.challenge === challenge;
    if (attested && matched && args.node === 'entry') {
      const result = textResult('leaf');
      send({ jsonrpc: '2.0', id, result });
      return emit('tools/call', QUERY, argsSha, sha(canon(result)), true, null);
    }
    fail(id, -32602, 'query rejected');
    return emit('tools/call', QUERY, argsSha, null, matched, null);
  }
  fail(id, -32602, 'call rejected');
  emit('tools/call', name === ATTEST || name === QUERY ? name : null, argsSha, null, null, null);
};

const handle = line => {
  let message;
  try { message = JSON.parse(line); } catch { return fail(null, -32700, 'parse error'); }
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (Object.hasOwn(message, 'id') && typeof message.id !== 'string' && !Number.isSafeInteger(message.id)))
    return fail(null, -32600, 'invalid request');
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: isRecord(params) && typeof params.protocolVersion === 'string'
      ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'aihq-native-fixture', version: '1' } } });
    return emit('initialize', null, null, null, null, null);
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: tools() } });
    return emit('tools/list', null, null, null, null, null);
  }
  if (method === 'tools/call') return call(id, params);
  fail(id, -32601, 'method not found');
};

let chain = ready;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  messages += 1;
  bytes += Buffer.byteLength(line) + 1;
  if (messages > MAX_MESSAGES || bytes > MAX_BYTES || line.length > MAX_LINE) process.exit(4);
  chain = chain.then(() => handle(line));
});
input.on('close', () => chain.then(() => {
  if (link) link.end();
  setTimeout(() => process.exit(0), 50);
}));
`;

const instruction = marker => `# AIHQ native verification fixture

This project is a disposable verification fixture. When asked to verify the session, do exactly this and nothing else:

1. Call the MCP tool \`${fixtureAttestTool}\` with \`marker\` set to \`${marker}\` and \`challenge\` set to the session challenge from the prompt.
2. Call the MCP tool \`${fixtureQueryTool}\` with \`node\` set to \`entry\` and \`challenge\` set to the session challenge.
3. Reply with the text returned by \`${fixtureQueryTool}\` and the \`markerSha256\` returned by attestation.
`;

const mcpConfig = JSON.stringify({ mcpServers: { [fixtureServerName]: {
  type: 'stdio', command: 'node', args: ['.aihq-native/server.mjs'] } } }, null, 2) + '\n';

const prefix = `mcp__${fixtureServerName}__`;
const guardrailSettings = JSON.stringify({
  permissions: {
    allow: [`${prefix}${fixtureAttestTool}`, `${prefix}${fixtureQueryTool}`],
    deny: ['Bash', 'BashOutput', 'KillShell', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
      'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill']
  },
  enabledMcpjsonServers: [fixtureServerName],
  enableAllProjectMcpServers: false
}, null, 2) + '\n';

// Staged text per cell root. Paths are cell-relative.
export const fixtureFiles = Object.freeze({
  instruction: Object.freeze({ root: 'project', path: 'CLAUDE.md', memberPath: 'package/harness/native/fixture/CLAUDE.md', text: instruction(fixtureMarker) }),
  mcpConfig: Object.freeze({ root: 'project', path: '.mcp.json', memberPath: 'package/harness/native/fixture/mcp.json', text: mcpConfig }),
  server: Object.freeze({ root: 'project', path: '.aihq-native/server.mjs', memberPath: 'package/harness/native/fixture/server.mjs', text: server }),
  guardrails: Object.freeze({ root: 'home', path: '.claude/settings.json', memberPath: 'package/harness/native/fixture/claude-settings.json', text: guardrailSettings })
});
