// Session-local in-memory OTLP HTTP/JSON logs listener for Claude's client-reported identity evidence.
// Evidence is client-reported, not provider-signed. Everything except counts and match flags is discarded.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { isRecord, parseStrictJson } from './canonical.mjs';
import { nativeBounds } from './contracts.mjs';

const eventBuckets = new Map([['api_request', 'apiRequest'], ['api_error', 'apiError'], ['user_prompt', 'userPrompt'],
  ['assistant_response', 'assistantResponse'], ['tool_result', 'toolResult'], ['tool_decision', 'toolDecision']]);
const eventBucket = name => typeof name === 'string'
  ? eventBuckets.get(name.startsWith('claude_code.') ? name.slice('claude_code.'.length) : name) ?? 'other' : 'other';
const increment = (counts, key) => { counts[key] = Math.min(1000000, counts[key] + 1); };

function attributesOf(record) {
  const map = new Map();
  if (!Array.isArray(record.attributes)) return map;
  for (const item of record.attributes) {
    if (!isRecord(item) || typeof item.key !== 'string') continue;
    // An unsupported value is still a present success flag and must fail closed.
    if (item.key === 'success') map.set(item.key, null);
    if (!isRecord(item.value)) continue;
    const { stringValue, intValue, boolValue } = item.value;
    if (typeof stringValue === 'string') map.set(item.key, stringValue);
    else if (typeof intValue === 'string' || typeof intValue === 'number') map.set(item.key, String(intValue));
    else if (typeof boolValue === 'boolean') map.set(item.key, String(boolValue));
  }
  return map;
}

function eventMs(record) {
  const nano = record.timeUnixNano ?? record.observedTimeUnixNano;
  if (typeof nano !== 'string' || !/^\d{1,20}$/.test(nano)) return null;
  return Number(BigInt(nano) / 1000000n);
}

export function createClaudeCollector({ sessionId = null, expected, bodyTimeoutMs = nativeBounds.collectorBodyTimeoutMs }) {
  const token = randomBytes(32).toString('hex');
  const probeToken = randomBytes(32).toString('hex');
  let boundSession = sessionId;
  const state = { requests: 0, events: 0, bytes: 0, violation: false, cancelled: false, candidates: [], ignored: 0 };
  const stats = { requests: 0, accepted: 0,
    rejected: { auth: 0, method: 0, path: 0, contentType: 0, contentEncoding: 0, size: 0, parse: 0, other: 0 },
    contentTypes: { json: 0, protobuf: 0, other: 0, none: 0 }, contentEncodings: { none: 0, gzip: 0, other: 0 },
    events: 0, eventNames: { apiRequest: 0, apiError: 0, userPrompt: 0, assistantResponse: 0, toolResult: 0, toolDecision: 0, other: 0 },
    apiRequestRejected: { missingRequestId: 0, notSuccess: 0, missingSession: 0, wrongSession: 0, identityMismatch: 0, outsideWindow: 0 }, ignored: 0 };
  let startedMono = 0;
  let closed = false;

  const server = http.createServer((req, res) => {
    const probe = req.method === 'GET' && req.url === '/aih-native-probe';
    // Every reply closes the connection; the request body is never read after a rejection. A graceful
    // half-close lets the client read the status, then a short timer destroys any unread remainder.
    const reply = (status, reason = 'other') => {
      if (res.headersSent || res.writableEnded) return;
      if (!probe) {
        if (status === 200) increment(stats, 'accepted');
        else increment(stats.rejected, reason);
      }
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.setHeader('connection', 'close');
      res.end('{}', () => {
        req.socket.end();
        setTimeout(() => req.socket.destroy(), 200).unref();
      });
    };
    if (state.cancelled) { req.destroy(); return; }
    // A separate, non-telemetry challenge proves the sandbox's exact allowed route. It cannot
    // submit identity evidence and is never included in snapshots or final collector results.
    if (probe) {
      const provided = Buffer.from(String(req.headers.authorization ?? ''));
      const wanted = Buffer.from(`Bearer ${probeToken}`);
      if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return reply(401);
      res.setHeader('x-aih-native-probe', probeToken);
      return reply(200);
    }
    increment(stats, 'requests');
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    increment(stats.contentTypes, type === 'application/json' ? 'json' : type === 'application/x-protobuf' ? 'protobuf' : type === '' ? 'none' : 'other');
    increment(stats.contentEncodings, req.headers['content-encoding'] === undefined ? 'none' : req.headers['content-encoding'] === 'gzip' ? 'gzip' : 'other');
    if (req.method !== 'POST') return reply(405, 'method');
    if (req.url !== '/v1/logs') return reply(404, 'path');
    const provided = Buffer.from(String(req.headers.authorization ?? ''));
    const wanted = Buffer.from(`Bearer ${token}`);
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return reply(401, 'auth');
    if (type !== 'application/json') return reply(415, 'contentType');
    if (req.headers['content-encoding'] !== undefined) return reply(415, 'contentEncoding');
    state.requests += 1;
    if (state.requests > nativeBounds.collectorRequests) { state.violation = true; return reply(429); }
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > nativeBounds.collectorRequestBytes) { state.violation = true; reply(413, 'size'); return; }
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => reply(408), bodyTimeoutMs);
    req.on('error', () => clearTimeout(timer));
    req.on('data', chunk => {
      size += chunk.length;
      if (size > nativeBounds.collectorRequestBytes) { state.violation = true; clearTimeout(timer); reply(413, 'size'); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (res.headersSent || res.writableEnded) return;
      state.bytes += size;
      if (state.bytes > nativeBounds.collectorBytes) { state.violation = true; return reply(429, 'size'); }
      let parsed;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        parsed = parseStrictJson(text, nativeBounds.jsonDepth);
      } catch { return reply(400, 'parse'); }
      if (!isRecord(parsed)) return reply(400, 'parse');
      const received = performance.now();
      for (const resource of Array.isArray(parsed.resourceLogs) ? parsed.resourceLogs : []) {
        for (const scope of isRecord(resource) && Array.isArray(resource.scopeLogs) ? resource.scopeLogs : []) {
          for (const record of isRecord(scope) && Array.isArray(scope.logRecords) ? scope.logRecords : []) {
            increment(stats, 'events');
            const attrs = isRecord(record) ? attributesOf(record) : new Map();
            const bucket = eventBucket(attrs.get('event.name'));
            increment(stats.eventNames, bucket);
            state.events += 1;
            if (state.events > nativeBounds.collectorEvents) { state.violation = true; increment(stats, 'ignored'); continue; }
            if (state.violation || !isRecord(record)) { increment(stats, 'ignored'); continue; }
            if (bucket !== 'apiRequest') { state.ignored += 1; continue; }
            const request = attrs.get('request_id');
            if (!request) { increment(stats.apiRequestRejected, 'missingRequestId'); state.ignored += 1; continue; }
            if (attrs.has('success') && attrs.get('success') !== 'true') {
              increment(stats.apiRequestRejected, 'notSuccess'); state.ignored += 1; continue;
            }
            // The native session ID is only known after the client's init record, so binding is deferred.
            state.candidates.push({ session: attrs.get('session.id') ?? null, request, account: attrs.get('user.account_uuid') ?? null,
              org: attrs.get('organization.id') ?? null, atMs: eventMs(record), received });
          }
        }
      }
      reply(200);
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = Math.max(bodyTimeoutMs, 1000);

  const shut = async () => {
    if (closed) return;
    closed = true;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  };

  const evaluate = ({ launchedAtMs, closedAtMs }, closeMono) => {
    const skew = nativeBounds.telemetrySkewMs;
    const seen = new Map();
    const apiRequestRejected = { ...stats.apiRequestRejected };
    let matched = 0, duplicates = 0, ignored = state.ignored, conflict = false;
    const mine = boundSession === null ? [] : state.candidates.filter(candidate => candidate.session === boundSession);
    const wrongSession = state.candidates.length - mine.length;
    for (const candidate of state.candidates) {
      if (boundSession === null || candidate.session !== boundSession)
        increment(apiRequestRejected, candidate.session ? 'wrongSession' : 'missingSession');
    }
    for (const candidate of mine) {
      const identityOk = candidate.account === expected.accountUuid && candidate.org === expected.organizationId;
      if (!identityOk) { conflict = true; increment(apiRequestRejected, 'identityMismatch'); }
      const key = candidate.request;
      if (seen.has(key)) {
        duplicates += 1;
        if (seen.get(key) !== `${candidate.account}/${candidate.org}`) conflict = true;
        continue;
      }
      seen.set(key, `${candidate.account}/${candidate.org}`);
      const inWindow = candidate.atMs !== null && candidate.atMs >= launchedAtMs - skew && candidate.atMs <= closedAtMs + skew &&
        candidate.received >= startedMono && candidate.received <= closeMono;
      if (!inWindow) { increment(apiRequestRejected, 'outsideWindow'); ignored += 1; continue; }
      if (identityOk) matched += 1;
    }
    return { matched, duplicates, ignored, conflict, wrongSession, apiRequestRejected };
  };
  const diagnostics = result => ({ requests: stats.requests, accepted: stats.accepted, rejected: { ...stats.rejected },
    contentTypes: { ...stats.contentTypes }, contentEncodings: { ...stats.contentEncodings }, events: stats.events,
    eventNames: { ...stats.eventNames }, apiRequestRejected: { ...result.apiRequestRejected },
    ignored: Math.min(1000000, stats.ignored + result.ignored),
    matched: result.matched, duplicates: result.duplicates, wrongSession: result.wrongSession, conflict: result.conflict });

  return {
    token, endpoint: '',
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      startedMono = performance.now();
      this.endpoint = `http://127.0.0.1:${server.address().port}`;
      return { endpoint: this.endpoint, token, probeToken };
    },
    // Bind the observed native structured session ID before drain. Events for any other ID never count.
    bindSession(id) { boundSession = typeof id === 'string' ? id : null; },
    snapshot({ launchedAtMs, closedAtMs }) {
      const result = evaluate({ launchedAtMs, closedAtMs }, performance.now());
      return { outcome: 'unavailable', reason: state.violation ? 'limit-exceeded' : result.conflict ? 'identity-conflict' :
        result.matched === 0 && result.wrongSession > 0 ? 'identity-session-mismatch' : 'authentication-unavailable',
        counts: { requests: state.requests, events: Math.min(state.events, nativeBounds.collectorEvents),
          matched: result.matched, wrongSession: result.wrongSession, duplicates: result.duplicates, ignored: result.ignored }, bytes: state.bytes,
        stats: diagnostics(result) };
    },
    async cancel() { state.cancelled = true; await shut(); },
    async drain({ launchedAtMs, closedAtMs, timeoutMs = nativeBounds.telemetryDrainMs }) {
      const deadline = performance.now() + timeoutMs;
      while (!state.cancelled && !state.violation && performance.now() < deadline) {
        if (evaluate({ launchedAtMs, closedAtMs }, performance.now()).matched > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - performance.now()))));
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const wasCancelled = state.cancelled;
      await shut();
      const closeMono = performance.now();
      const result = evaluate({ launchedAtMs, closedAtMs }, closeMono);
      const counts = { requests: state.requests, events: Math.min(state.events, nativeBounds.collectorEvents),
        matched: result.matched, wrongSession: result.wrongSession, duplicates: result.duplicates, ignored: result.ignored };
      let reason = 'observed';
      if (wasCancelled) reason = 'cancelled';
      else if (state.violation) reason = 'limit-exceeded';
      else if (result.conflict) reason = 'identity-conflict';
      else if (result.matched === 0) reason = result.wrongSession > 0 ? 'identity-session-mismatch' : 'authentication-unavailable';
      return { outcome: reason === 'observed' ? 'passed' : 'unavailable', reason, counts, bytes: state.bytes, stats: diagnostics(result) };
    }
  };
}
