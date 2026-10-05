// Session-local in-memory OTLP HTTP/JSON logs listener for Claude's client-reported identity evidence.
// Evidence is client-reported, not provider-signed. Everything except counts and match flags is discarded.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { isRecord, parseStrictJson } from './canonical.mjs';
import { nativeBounds } from './contracts.mjs';

const EVENT_NAME = 'claude_code.api_request';

function attributesOf(record) {
  const map = new Map();
  if (!Array.isArray(record.attributes)) return map;
  for (const item of record.attributes) {
    if (!isRecord(item) || typeof item.key !== 'string' || !isRecord(item.value)) continue;
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
  let boundSession = sessionId;
  const state = { requests: 0, events: 0, bytes: 0, violation: false, cancelled: false, candidates: [], ignored: 0 };
  let startedMono = 0;
  let closed = false;

  const server = http.createServer((req, res) => {
    // Every reply closes the connection; the request body is never read after a rejection. A graceful
    // half-close lets the client read the status, then a short timer destroys any unread remainder.
    const reply = status => {
      if (res.headersSent || res.writableEnded) return;
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.setHeader('connection', 'close');
      res.end('{}', () => {
        req.socket.end();
        setTimeout(() => req.socket.destroy(), 200).unref();
      });
    };
    if (state.cancelled) { req.destroy(); return; }
    if (req.method !== 'POST') return reply(405);
    if (req.url !== '/v1/logs') return reply(404);
    const provided = Buffer.from(String(req.headers.authorization ?? ''));
    const wanted = Buffer.from(`Bearer ${token}`);
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return reply(401);
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json' || req.headers['content-encoding'] !== undefined) return reply(415);
    state.requests += 1;
    if (state.requests > nativeBounds.collectorRequests) { state.violation = true; return reply(429); }
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > nativeBounds.collectorRequestBytes) { state.violation = true; reply(413); return; }
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => reply(408), bodyTimeoutMs);
    req.on('error', () => clearTimeout(timer));
    req.on('data', chunk => {
      size += chunk.length;
      if (size > nativeBounds.collectorRequestBytes) { state.violation = true; clearTimeout(timer); reply(413); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (res.headersSent || res.writableEnded) return;
      state.bytes += size;
      if (state.bytes > nativeBounds.collectorBytes) { state.violation = true; return reply(429); }
      let parsed;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        parsed = parseStrictJson(text, nativeBounds.jsonDepth);
      } catch { return reply(400); }
      if (!isRecord(parsed)) return reply(400);
      const received = performance.now();
      for (const resource of Array.isArray(parsed.resourceLogs) ? parsed.resourceLogs : []) {
        for (const scope of isRecord(resource) && Array.isArray(resource.scopeLogs) ? resource.scopeLogs : []) {
          for (const record of isRecord(scope) && Array.isArray(scope.logRecords) ? scope.logRecords : []) {
            state.events += 1;
            if (state.events > nativeBounds.collectorEvents) { state.violation = true; continue; }
            if (state.violation || !isRecord(record)) continue;
            const attrs = attributesOf(record);
            const name = attrs.get('event.name');
            if (name !== EVENT_NAME) { state.ignored += 1; continue; }
            const request = attrs.get('request_id');
            if (!request || attrs.get('success') !== 'true') { state.ignored += 1; continue; }
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
    let matched = 0, duplicates = 0, ignored = state.ignored, conflict = false;
    const mine = boundSession === null ? [] : state.candidates.filter(candidate => candidate.session === boundSession);
    const wrongSession = state.candidates.length - mine.length;
    for (const candidate of mine) {
      const identityOk = candidate.account === expected.accountUuid && candidate.org === expected.organizationId;
      if (!identityOk) conflict = true;
      const key = candidate.request;
      if (seen.has(key)) {
        duplicates += 1;
        if (seen.get(key) !== `${candidate.account}/${candidate.org}`) conflict = true;
        continue;
      }
      seen.set(key, `${candidate.account}/${candidate.org}`);
      const inWindow = candidate.atMs !== null && candidate.atMs >= launchedAtMs - skew && candidate.atMs <= closedAtMs + skew &&
        candidate.received >= startedMono && candidate.received <= closeMono;
      if (!inWindow) { ignored += 1; continue; }
      if (identityOk) matched += 1;
    }
    return { matched, duplicates, ignored, conflict, wrongSession };
  };

  return {
    token, endpoint: '',
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      startedMono = performance.now();
      this.endpoint = `http://127.0.0.1:${server.address().port}`;
      return { endpoint: this.endpoint, token };
    },
    // Bind the observed native structured session ID before drain. Events for any other ID never count.
    bindSession(id) { boundSession = typeof id === 'string' ? id : null; },
    snapshot({ launchedAtMs, closedAtMs }) {
      const result = evaluate({ launchedAtMs, closedAtMs }, performance.now());
      return { outcome: 'unavailable', reason: state.violation ? 'limit-exceeded' : result.conflict ? 'identity-conflict' :
        result.matched === 0 && result.wrongSession > 0 ? 'identity-session-mismatch' : 'authentication-unavailable',
        counts: { requests: state.requests, events: Math.min(state.events, nativeBounds.collectorEvents),
          matched: result.matched, wrongSession: result.wrongSession, duplicates: result.duplicates, ignored: result.ignored }, bytes: state.bytes };
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
      return { outcome: reason === 'observed' ? 'passed' : 'unavailable', reason, counts, bytes: state.bytes };
    }
  };
}
