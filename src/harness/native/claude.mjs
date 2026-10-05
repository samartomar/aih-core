// Claude Code adapter pieces: stream-json parser, fixed environment, prompt and managed-settings observation.
// Message shapes follow Claude's public headless/monitoring documentation and are unverified against a
// native run: the descriptor stays a candidate until an evidence-bound change says otherwise.
import { closeSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { posix, win32, join } from 'node:path';
import { canonicalJson, isRecord, parseStrictJson } from './canonical.mjs';
import { nativeBounds } from './contracts.mjs';
import { sha256 } from './digest.mjs';

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const textOf = content => typeof content === 'string' ? [content]
  : Array.isArray(content) ? content.filter(b => isRecord(b) && b.type === 'text' && typeof b.text === 'string').map(b => b.text) : [];

export function createClaudeStreamParser({ serverName, attestTool, queryTool, expectedAnswer, markerSha256, challenge,
  maxBytes = nativeBounds.childOutputBytes, maxRecordBytes = nativeBounds.childRecordBytes }) {
  const prefix = `mcp__${serverName}__`;
  const expectedAnswerSha256 = sha256(expectedAnswer);
  const state = { status: 'ok', bytes: 0, records: 0, sessionId: null, ids: new Set(), initSeen: false,
    serverStatus: null, visible: [], permissionMode: null, attestationReturned: false, answerReturned: false, answerSha256: null,
    resultSubtype: null, resultIsError: null, unselected: [], toolsListed: false, builtin: [], unselectedTools: 0 };
  const calls = new Map();
  let pending = '';
  const stop = status => { if (state.status === 'ok') state.status = status; };

  const record = value => {
    state.records += 1;
    if (typeof value.session_id === 'string') state.ids.add(value.session_id);
    if (value.type === 'system' && value.subtype === 'init') {
      state.initSeen = true;
      state.sessionId = typeof value.session_id === 'string' && SESSION_RE.test(value.session_id) ? value.session_id : null;
      if (typeof value.permissionMode === 'string') state.permissionMode = value.permissionMode.slice(0, 64);
      if (Array.isArray(value.mcp_servers)) {
        const entry = value.mcp_servers.find(item => isRecord(item) && item.name === serverName);
        state.serverStatus = entry ? (typeof entry.status === 'string' ? entry.status.slice(0, 64) : 'unknown') : 'absent';
      }
      if (Array.isArray(value.tools)) {
        const names = new Set(value.tools.filter(tool => typeof tool === 'string'));
        state.toolsListed = true;
        state.visible = [attestTool, queryTool].filter(tool => names.has(prefix + tool));
        state.unselectedTools = [...names].filter(name => name !== prefix + attestTool && name !== prefix + queryTool).length;
        state.builtin = [...names].filter(name => !name.startsWith('mcp__')).slice(0, 64).map(name => name.slice(0, 64));
      }
    } else if (value.type === 'assistant' && isRecord(value.message) && Array.isArray(value.message.content)) {
      for (const block of value.message.content) {
        if (!isRecord(block) || block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue;
        if (block.name === prefix + attestTool) calls.set(block.id, { role: 'attest' });
        else if (block.name === prefix + queryTool) calls.set(block.id, { role: 'query' });
        else {
          const entry = { name: block.name.slice(0, 128), permitted: false, beforeAttestation: !state.attestationReturned };
          state.unselected.push(entry);
          calls.set(block.id, { role: 'other', entry });
        }
      }
    } else if (value.type === 'user' && isRecord(value.message) && Array.isArray(value.message.content)) {
      for (const block of value.message.content) {
        if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        const ok = block.is_error !== true;
        const texts = textOf(block.content);
        if (call.role === 'other') call.entry.permitted = ok;
        else if (call.role === 'attest' && ok && texts.length === 1) {
          try {
            const parsed = parseStrictJson(texts[0], nativeBounds.jsonDepth);
            if (isRecord(parsed) && Object.keys(parsed).length === 2 && parsed.markerSha256 === markerSha256 &&
                parsed.challenge === challenge) state.attestationReturned = true;
          } catch { /* not the attestation object */ }
        } else if (call.role === 'query' && ok) {
          const matched = texts.some(text => text === expectedAnswer);
          const digest = sha256(matched ? expectedAnswer : texts.length === 1 ? texts[0] : canonicalJson(texts));
          // Retain only a bounded digest. A later matching receipt cannot erase a contradiction.
          if (state.answerSha256 === null || digest !== expectedAnswerSha256) state.answerSha256 = digest;
          state.answerReturned = state.answerSha256 === expectedAnswerSha256;
        }
      }
    } else if (value.type === 'result') {
      state.resultSubtype = typeof value.subtype === 'string' ? value.subtype.slice(0, 64) : null;
      state.resultIsError = typeof value.is_error === 'boolean' ? value.is_error : null;
    }
  };

  const line = text => {
    if (text.trim() === '' || state.status !== 'ok') return;
    if (Buffer.byteLength(text) > maxRecordBytes) return stop('limit-exceeded');
    let value;
    try { value = parseStrictJson(text, nativeBounds.jsonDepth); } catch (error) { return stop(error.message === 'strict-json-depth' ? 'limit-exceeded' : 'malformed'); }
    if (!isRecord(value)) return stop('malformed');
    record(value);
  };

  const snapshot = () => ({ status: state.status, bytes: state.bytes, records: state.records, sessionId: state.sessionId,
    sessionIdConsistent: state.initSeen && state.sessionId !== null && [...state.ids].every(id => id === state.sessionId),
    serverStatus: state.serverStatus, visibleSelectedTools: state.visible.slice(), toolsListed: state.toolsListed,
    builtinTools: state.builtin.slice(), unselectedTools: state.unselectedTools, permissionMode: state.permissionMode,
    attestationReturned: state.attestationReturned, answerReturned: state.answerReturned, answerSha256: state.answerSha256,
    resultSubtype: state.resultSubtype, resultIsError: state.resultIsError, unselectedToolUses: state.unselected.map(value => ({ ...value })) });
  return {
    snapshot,
    push(chunk) {
      if (state.status !== 'ok') return;
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      state.bytes += Buffer.byteLength(text);
      if (state.bytes > maxBytes) return stop('limit-exceeded');
      pending += text;
      let index;
      while ((index = pending.indexOf('\n')) >= 0 && state.status === 'ok') {
        const complete = pending.slice(0, index);
        pending = pending.slice(index + 1);
        line(complete);
      }
      if (Buffer.byteLength(pending) > maxRecordBytes) stop('limit-exceeded');
    },
    finish() {
      if (pending.trim() !== '') line(pending);
      pending = '';
      return snapshot();
    }
  };
}

export const claudeSessionsAreFresh = (first, second) =>
  typeof first === 'string' && typeof second === 'string' && SESSION_RE.test(first) && SESSION_RE.test(second) && first !== second;

// Prompt travels on stdin. It names the session challenge only: no marker, no expected answer.
export const claudePrompt = challenge =>
  `Verify this project session. Session challenge: ${challenge}. Follow the project instruction exactly, then reply with the results.`;

const ESSENTIALS = {
  win32: ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'],
  posix: ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM']
};

// Build the child environment from nothing. Only OS essentials and locale come from the host.
export function buildClaudeEnvironment({ platform, hostEnv, homeDir, scratchDir, runtimeDirs, telemetry, evidence }) {
  const path = platform === 'win32' ? win32 : posix;
  const env = {};
  for (const name of ESSENTIALS[platform === 'win32' ? 'win32' : 'posix'])
    if (typeof hostEnv[name] === 'string' && hostEnv[name] !== '') env[name] = hostEnv[name];
  const temp = path.join(scratchDir, 'tmp');
  Object.assign(env, {
    PATH: runtimeDirs.join(platform === 'win32' ? ';' : ':'),
    HOME: homeDir, USERPROFILE: homeDir,
    APPDATA: path.join(homeDir, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(homeDir, '.config'), XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    XDG_CACHE_HOME: path.join(homeDir, '.cache'), XDG_STATE_HOME: path.join(homeDir, '.local', 'state'),
    TEMP: temp, TMP: temp, TMPDIR: temp,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: telemetry.endpoint,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer ${telemetry.token}`,
    OTEL_LOGS_EXPORT_INTERVAL: '1000', OTEL_METRICS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'none',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '0', OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_TOOL_DETAILS: '0',
    OTEL_LOG_TOOL_CONTENT: '0', OTEL_LOG_RAW_API_BODIES: '0',
    AIHQ_NATIVE_EVIDENCE_CHANNEL: evidence.endpoint, AIHQ_NATIVE_EVIDENCE_TOKEN: evidence.token
  });
  return env;
}

const MANAGED_DIRECTORY = { win32: 'C:\\Program Files\\ClaudeCode', darwin: '/Library/Application Support/ClaudeCode', linux: '/etc/claude-code' };
const RESTRICTING_KEYS = ['otelHeadersHelper', 'allowManagedMcpServersOnly', 'allowedMcpServers', 'deniedMcpServers', 'managedMcpServers'];
const MAX_MANAGED_BYTES = 65536;

function readBounded(file) {
  let fd;
  try { fd = openSync(file, 'r'); } catch (error) { return error.code === 'ENOENT' ? { absent: true } : { unreadable: true }; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_MANAGED_BYTES) return { unreadable: true };
    const buffer = Buffer.alloc(stat.size);
    readSync(fd, buffer, 0, stat.size, 0);
    return { text: buffer.toString('utf8') };
  } catch { return { unreadable: true }; } finally { closeSync(fd); }
}

// Observe file-based managed policy only. Registry/MDM/server-managed sources are not readable here, so
// `file-sources-clear` is never proof that no restriction exists.
export function observeClaudeManagedSettings({ platform = process.platform, directory = MANAGED_DIRECTORY[platform] } = {}) {
  const limitations = ['registry-mdm-and-server-managed-sources-unobserved'];
  if (!directory) return { outcome: 'unreadable', limitations };
  let restricted = false, unreadable = false;
  const files = [join(directory, 'managed-settings.json')];
  try {
    for (const name of readdirSync(join(directory, 'managed-settings.d')).sort())
      if (name.endsWith('.json')) files.push(join(directory, 'managed-settings.d', name));
  } catch (error) { if (error.code !== 'ENOENT') unreadable = true; }
  for (const file of files) {
    const read = readBounded(file);
    if (read.absent) continue;
    if (read.unreadable) { unreadable = true; continue; }
    let value;
    try { value = JSON.parse(read.text); } catch { unreadable = true; continue; }
    if (!isRecord(value)) { unreadable = true; continue; }
    if (RESTRICTING_KEYS.some(key => Object.hasOwn(value, key))) restricted = true;
    if (isRecord(value.env) && Object.keys(value.env).some(key => /^(OTEL_|CLAUDE_CODE_ENABLE_TELEMETRY|CLAUDE_CODE_ENHANCED)/.test(key))) restricted = true;
  }
  const mcp = readBounded(join(directory, 'managed-mcp.json'));
  if (mcp.unreadable) unreadable = true; else if (!mcp.absent) restricted = true;
  if (restricted) return { outcome: 'restricted', limitations };
  return { outcome: unreadable ? 'unreadable' : 'file-sources-clear', limitations };
}
