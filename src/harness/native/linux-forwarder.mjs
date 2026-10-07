// Trusted in-namespace collector bridge. Built-ins only; the proxy retains all routing authority.
import http from 'node:http';
import net from 'node:net';
import { Transform } from 'node:stream';

export function proxyAuthorization(proxyUrl) {
  try {
    const url = new URL(proxyUrl);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '3128' ||
        !url.username || !url.password) return null;
    return `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`;
  } catch { return null; }
}

const bounded = (value, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;

// The internal test seam can only lower limits. Production always uses the fixed bounds.
export async function startCollectorForwarder({ collector, proxyUrl, limits = {} }) {
  let endpoint;
  try {
    // Reject alternate loopback spellings/hostnames, credentials and portless endpoints before URL normalization.
    if (typeof collector !== 'string' || !/^https?:\/\/127\.0\.0\.1:[1-9]\d*\/v1\/logs$/.test(collector)) return null;
    endpoint = new URL(collector);
  } catch { return null; }
  const port = Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80));
  const authorization = proxyAuthorization(proxyUrl);
  if (!authorization || port === 3128) return null;
  const authority = `127.0.0.1:${port}`;
  const maxActive = bounded(limits.maxActive, 32), maxTotal = bounded(limits.maxTotal, 256);
  const maxBytes = bounded(limits.maxBytes, 4 * 1024 * 1024), idleMs = bounded(limits.idleMs, 3000);
  const stats = { accepted: 0, connected: 0, refused: 0, capped: 0 };
  const increment = key => { stats[key] = Math.min(1000000, stats[key] + 1); };
  const snapshot = () => Object.freeze({ ...stats });
  const active = new Set();
  let closed = false, closing;
  const server = net.createServer({ allowHalfOpen: true }, client => {
    client.on('error', () => {});
    if (closed || active.size >= maxActive || stats.accepted >= maxTotal) {
      increment('capped'); client.destroy(); return;
    }
    increment('accepted'); client.pause();
    const sockets = new Set([client]);
    let request, done = false, established = false;
    const finish = reason => {
      if (done) return;
      done = true;
      if (reason) increment(reason);
      request?.destroy();
      for (const socket of sockets) socket.destroy();
      active.delete(finish);
    };
    active.add(finish);
    const track = socket => {
      sockets.add(socket);
      socket.on('error', () => finish(established ? null : 'refused'));
      socket.once('close', () => finish(established ? null : 'refused'));
      socket.setTimeout(idleMs, () => finish('capped'));
      if (done) socket.destroy();
    };
    track(client);
    request = http.request({ host: '127.0.0.1', port: 3128, method: 'CONNECT', path: authority, agent: false,
      maxHeaderSize: 8192, headers: { host: authority, 'proxy-authorization': authorization } });
    request.once('socket', track);
    request.once('error', () => finish('refused'));
    request.once('response', response => { response.destroy(); finish('refused'); });
    request.once('connect', (response, upstream, head) => {
      if (done || response.statusCode !== 200) { upstream.destroy(); finish('refused'); return; }
      established = true; increment('connected');
      upstream.allowHalfOpen = true;
      // Count lengths only. Stream backpressure bounds buffering; payload is never parsed or retained.
      const meter = () => {
        let bytes = 0;
        return new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxBytes) { finish('capped'); callback(); }
          else callback(null, chunk);
        } });
      };
      const outbound = meter(), inbound = meter();
      client.once('close', () => { outbound.destroy(); inbound.destroy(); });
      if (head.length) upstream.unshift(head);
      client.pipe(outbound).pipe(upstream); upstream.pipe(inbound).pipe(client);
      client.resume();
    });
    request.end();
  });
  server.on('error', () => { closed = true; for (const finish of active) finish('refused'); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port }, resolve); });
  } catch { server.close(); return null; }
  return {
    snapshot,
    close() {
      return closing ??= new Promise(resolve => {
        closed = true;
        for (const finish of active) finish(null);
        server.close(() => resolve(snapshot()));
      });
    }
  };
}
