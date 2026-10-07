import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startCollectorForwarder } from '../../src/harness/native/linux-forwarder.mjs';
import { runProbes } from '../../src/harness/native/linux-workload.mjs';

const listen = async (server, host, port = 0) => {
  server.listen(port, host); await once(server, 'listening'); return server.address().port;
};
const close = server => new Promise(resolve => server.close(resolve));

async function fixture(t, status = 200) {
  const sockets = new Set(), requests = [];
  const track = socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); };
  const collector = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { requests.push({ path: req.url, body }); res.end('collected'); });
  });
  collector.on('connection', track);
  // Distinct loopback addresses model the host and namespace sharing the same authority port.
  const port = await listen(collector, '127.0.0.2');
  const connects = [];
  const proxy = http.createServer((req, res) => {
    if (req.url === `http://127.0.0.1:${port}/aih-native-probe`) {
      res.setHeader('x-aih-native-probe', 'synthetic-probe'); res.end();
    } else { res.writeHead(403, { 'x-proxy-error': 'denied' }); res.end(); }
  }); proxy.on('connection', track);
  proxy.on('connect', (req, socket, head) => {
    connects.push({ target: req.url, auth: req.headers['proxy-authorization'] });
    if (status === null) { socket.resume(); socket.once('end', () => socket.destroy()); return; } // Controlled stalled handshake.
    if (status !== 200) { socket.end(`HTTP/1.1 ${status} Denied\r\n\r\n`); return; }
    const upstream = net.connect({ host: '127.0.0.2', port }); track(upstream);
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
  });
  await listen(proxy, '127.0.0.1', 3128);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await Promise.all([close(proxy), close(collector)]); });
  return { port, requests, connects, openSockets: () => sockets.size, proxyUrl: 'http://user%3Aname:p%40ss@localhost:3128' };
}

test('a direct collector POST crosses CONNECT with the proxy capability and exact counts only', async t => {
  const fx = await fixture(t);
  const forwarder = await startCollectorForwarder({ collector: `http://127.0.0.1:${fx.port}/v1/logs`, proxyUrl: fx.proxyUrl });
  t.after(() => forwarder.close());
  const body = await new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${fx.port}/v1/logs`, { method: 'POST', agent: false }, res => {
      let reply = ''; res.on('data', chunk => { reply += chunk; }); res.on('end', () => resolve(reply));
    });
    req.on('error', reject); req.end('synthetic logs');
  });
  assert.equal(body, 'collected');
  assert.deepEqual(fx.requests, [{ path: '/v1/logs', body: 'synthetic logs' }]);
  assert.deepEqual(fx.connects, [{ target: `127.0.0.1:${fx.port}`,
    auth: `Basic ${Buffer.from('user:name:p@ss').toString('base64')}` }]);
  assert.deepEqual(await forwarder.close(), { accepted: 1, connected: 1, refused: 0, capped: 0 });
});

const dial = async port => {
  const socket = net.connect({ host: '127.0.0.1', port }); socket.on('error', () => {});
  await once(socket, 'connect'); return socket;
};
const disconnected = socket => socket.destroyed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve));
const waitFor = async predicate => {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('forwarder did not reach the expected state');
};
const bridge = async (t, fx, limits) => {
  const forwarder = await startCollectorForwarder({ collector: `http://127.0.0.1:${fx.port}/v1/logs`, proxyUrl: fx.proxyUrl, limits });
  assert.ok(forwarder); t.after(() => forwarder.close()); return forwarder;
};

test('non-200 CONNECT is refused without sending a payload to the collector', async t => {
  const fx = await fixture(t, 403), forwarder = await bridge(t, fx);
  const client = await dial(fx.port); client.write('synthetic payload');
  await disconnected(client);
  assert.equal(fx.requests.length, 0);
  assert.deepEqual(await forwarder.close(), { accepted: 1, connected: 0, refused: 1, capped: 0 });
});

test('only the literal collector authority and fixed authenticated proxy can create a listener', async () => {
  for (const collector of ['http://localhost:4318/v1/logs', 'http://127.0.0.2:4318/v1/logs',
    'http://127.1:4318/v1/logs', 'http://[::1]:4318/v1/logs', 'http://unapproved.invalid:4318/v1/logs',
    'http://127.0.0.1:3128/v1/logs', 'http://127.0.0.1:4318/v1/logs?extra', 'invalid']) {
    assert.equal(await startCollectorForwarder({ collector, proxyUrl: 'http://u:p@localhost:3128' }), null);
  }
  for (const proxyUrl of ['http://u:p@unapproved.invalid:3128', 'http://localhost:3128',
    'http://u:p@localhost:3129', 'https://u:p@localhost:3128', 'http://u:%XX@localhost:3128']) {
    assert.equal(await startCollectorForwarder({ collector: 'http://127.0.0.1:4318/v1/logs', proxyUrl }), null);
  }
});

test('concurrent connections stop at 32 even when a test asks for a higher limit', async t => {
  const fx = await fixture(t), forwarder = await bridge(t, fx, { maxActive: 33 });
  const clients = [];
  t.after(() => clients.forEach(client => client.destroy()));
  for (let i = 0; i < 32; i += 1) clients.push(await dial(fx.port));
  await waitFor(() => forwarder.snapshot().connected === 32);
  const extra = await dial(fx.port); await disconnected(extra);
  assert.deepEqual(forwarder.snapshot(), { accepted: 32, connected: 32, refused: 0, capped: 1 });
  await forwarder.close();
  await Promise.all(clients.map(disconnected));
});

test('total connections stop at 256 even when a test asks for a higher limit', async t => {
  const fx = await fixture(t, 403), forwarder = await bridge(t, fx, { maxTotal: 257 });
  for (let i = 0; i < 257; i += 1) { const client = await dial(fx.port); await disconnected(client); }
  assert.equal(fx.connects.length, 256);
  assert.deepEqual(await forwarder.close(), { accepted: 256, connected: 0, refused: 256, capped: 1 });
});

test('each tunnel direction has its own byte cap', async t => {
  const fx = await fixture(t), forwarder = await bridge(t, fx, { maxBytes: 64 });
  const client = await dial(fx.port);
  await waitFor(() => forwarder.snapshot().connected === 1);
  client.write(Buffer.alloc(65)); await disconnected(client);
  assert.equal(fx.requests.length, 0);
  assert.deepEqual(await forwarder.close(), { accepted: 1, connected: 1, refused: 0, capped: 1 });
});

test('response bytes are capped independently of request bytes', async t => {
  const fx = await fixture(t), forwarder = await bridge(t, fx, { maxBytes: 64 });
  const client = await dial(fx.port);
  let bytes = 0; client.on('data', chunk => { bytes += chunk.length; });
  client.write('GET /v1/logs HTTP/1.0\r\n\r\n'); await disconnected(client);
  assert.equal(fx.requests.length, 1);
  assert.ok(bytes <= 64);
  assert.deepEqual(await forwarder.close(), { accepted: 1, connected: 1, refused: 0, capped: 1 });
});

test('idle tunnels expire and cleanup closes live client sockets without changing final counters', { timeout: 5000 }, async t => {
  const fx = await fixture(t), forwarder = await bridge(t, fx, { idleMs: 80 });
  const idle = await dial(fx.port); await disconnected(idle);
  assert.deepEqual(forwarder.snapshot(), { accepted: 1, connected: 1, refused: 0, capped: 1 });
  const live = await dial(fx.port);
  await waitFor(() => forwarder.snapshot().connected === 2);
  const stats = await forwarder.close(); await disconnected(live);
  await waitFor(() => fx.openSockets() === 0);
  assert.deepEqual(stats, { accepted: 2, connected: 2, refused: 0, capped: 1 });
  assert.deepEqual(await forwarder.close(), stats); assert.ok(Object.isFrozen(stats));
});

test('a stalled CONNECT handshake expires and cleanup destroys pending proxy sockets', { timeout: 5000 }, async t => {
  const fx = await fixture(t, null), forwarder = await bridge(t, fx, { idleMs: 80 });
  const idle = await dial(fx.port); idle.write('synthetic payload'); await disconnected(idle);
  assert.equal(fx.requests.length, 0);
  assert.deepEqual(forwarder.snapshot(), { accepted: 1, connected: 0, refused: 0, capped: 1 });
  const pending = await dial(fx.port);
  await waitFor(() => fx.connects.length === 2);
  assert.deepEqual(await forwarder.close(), { accepted: 2, connected: 0, refused: 0, capped: 1 });
  await disconnected(pending); await waitFor(() => fx.openSockets() === 0);
});

test('directLoopbackDenied probes a distinct canary port while the collector bridge is reachable', async t => {
  const fx = await fixture(t), forwarder = await bridge(t, fx);
  const canary = net.createServer(socket => socket.end());
  const canaryPort = await listen(canary, '127.0.0.1');
  t.after(() => close(canary));
  assert.notEqual(canaryPort, fx.port);
  const root = mkdtempSync(join(tmpdir(), 'aih-forwarder-probes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missing = join(root, 'missing');
  const plan = { collector: `http://127.0.0.1:${fx.port}/v1/logs`, execution: 'native',
    cell: { home: join(missing, 'home'), project: join(missing, 'project'), scratch: join(missing, 'scratch') }, selectedPaths: [],
    canaries: { port: canaryPort, pathname: join(missing, 'agent'), abstract: 'synthetic-absent-agent',
      files: { provisioner: missing, home: missing, sibling: missing, temporary: missing },
      writes: [join(missing, 'write')], hostPid: 999999 } };
  const previous = process.env.HTTP_PROXY; process.env.HTTP_PROXY = fx.proxyUrl;
  try {
    assert.equal((await runProbes(plan, 'synthetic-challenge', 'synthetic-probe')).directLoopbackDenied, false,
      'an accessible canary must prove access even though the collector listener is also live');
    await close(canary);
    const probes = await runProbes(plan, 'synthetic-challenge', 'synthetic-probe');
    assert.equal(probes.directLoopbackDenied, true,
      'a closed canary must prove denial even though the collector listener remains live');
    assert.equal(probes.collectorReachable, true);
    assert.equal(probes.proxyWrongPortDenied, true); assert.equal(probes.proxyUnapprovedDenied, true);
    assert.deepEqual(forwarder.snapshot(), { accepted: 0, connected: 0, refused: 0, capped: 0 },
      'probe requests still go directly through the proxy');
  } finally { if (previous === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previous; }
});
