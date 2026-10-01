// Bounded loopback demo server for the public consumer example.
// Serves only the explicit page/bundle and three endpoints; the browser never
// names target, material or file paths — those stay host-configured.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readInstalledRelease } from '@aihq/catalog/node';
import { createHost } from './host.js';

const MAX_BODY_BYTES = 1_000_000;
const browserDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'browser');
const staticFiles = new Map([
  ['/', ['page.html', 'text/html; charset=utf-8']],
  ['/page.html', ['page.html', 'text/html; charset=utf-8']],
  ['/app.bundle.js', ['app.bundle.js', 'text/javascript; charset=utf-8']]
]);

const send = (response, status, body, type = 'application/json; charset=utf-8') => {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // The installed portable Core/Catalog validators compile their shipped
    // schemas with Ajv at runtime. They require eval; report text never does.
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  response.end(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body));
};

async function readBoundedBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('request body too large');
      error.tooLarge = true;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startServer({ projectRoot, materialRoots, host, port = 0 } = {}) {
  const installed = await readInstalledRelease({
    root: dirname(fileURLToPath(import.meta.resolve('@aihq/catalog/package.json'))),
    sourceInput: 'catalog'
  });
  if (!installed.valid) {
    throw new Error(`installed catalog release invalid: ${JSON.stringify(installed.diagnostics)}`);
  }
  const releaseBytes = await readFile(
    fileURLToPath(import.meta.resolve('@aihq/catalog/release.json'))
  );
  const catalog = {
    sha256: installed.release.sha256,
    source: installed.source,
    bytesBase64: Buffer.from(releaseBytes).toString('base64')
  };
  const ownedHost = host ?? createHost({
    projectRoot,
    materialRoots: materialRoots ?? installed.materialRoots
  });

  const server = createServer((request, response) => {
    handle(request, response).catch(error => {
      if (!response.headersSent) send(response, 500, { error: 'internal' });
      response.end();
    });
  });

  async function handle(request, response) {
    const address = `127.0.0.1:${server.address().port}`;
    if (request.headers.host !== address) return send(response, 403, { error: 'foreign-host' });
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico' && request.method === 'GET') return send(response, 204, '');
    if (url.pathname === '/api/catalog') {
      if (request.method !== 'GET') return send(response, 405, { error: 'method-not-allowed' });
      return send(response, 200, catalog);
    }
    if (url.pathname === '/api/prepare' || url.pathname === '/api/apply') {
      if (request.method !== 'POST') return send(response, 405, { error: 'method-not-allowed' });
    } else {
      if (request.method !== 'GET') return send(response, 405, { error: 'method-not-allowed' });
      const staticFile = staticFiles.get(url.pathname);
      if (!staticFile) return send(response, 404, { error: 'not-found' });
      try {
        return send(response, 200, await readFile(join(browserDir, staticFile[0])), staticFile[1]);
      } catch {
        return send(response, 404, { error: 'not-found' });
      }
    }
    const origin = request.headers.origin;
    if (origin !== `http://${address}`) {
      return send(response, 403, { error: 'foreign-origin' });
    }
    if ((request.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') {
      return send(response, 415, { error: 'expected-json' });
    }
    let body;
    try {
      body = JSON.parse(await readBoundedBody(request));
    } catch (error) {
      return send(response, error.tooLarge ? 413 : 400, { error: error.tooLarge ? 'body-too-large' : 'invalid-json' });
    }
    if (url.pathname === '/api/prepare') {
      if (typeof body?.policyText !== 'string') return send(response, 400, { error: 'expected-policyText' });
      return send(response, 200, await ownedHost.prepareSession({ policyText: body.policyText }));
    }
    if (typeof body?.sessionId !== 'string' || typeof body?.reviewDigest !== 'string') {
      return send(response, 400, { error: 'expected-sessionId-and-reviewDigest' });
    }
    return send(response, 200, await ownedHost.applyApproved({
      sessionId: body.sessionId,
      reviewDigest: body.reviewDigest,
      origin: 'interactive'
    }));
  }

  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const boundPort = server.address().port;
  return {
    server,
    port: boundPort,
    origin: `http://127.0.0.1:${boundPort}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const projectRoot = process.env.AIH_CONSUMER_PROJECT;
  if (!projectRoot) {
    console.error('Set AIH_CONSUMER_PROJECT to an explicit disposable target directory.');
    process.exit(1);
  }
  const { origin } = await startServer({
    projectRoot,
    port: Number(process.env.AIH_CONSUMER_PORT ?? 4817)
  });
  console.log(`Public consumer example listening at ${origin} (loopback only)`);
}
