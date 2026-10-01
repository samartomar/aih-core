import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { disposableHome, disposableProject, inlinePolicyText, installedRelease } from './helpers.mjs';
import { startServer } from '../src/server.js';

disposableHome();

async function runningServer() {
  const project = disposableProject();
  const { origin, close } = await startServer({ projectRoot: project, port: 0 });
  return { project, origin, close };
}

test('serves the page and the verified catalog release bytes from loopback only', async () => {
  const { origin, close } = await runningServer();
  try {
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);

    const catalog = await fetch(`${origin}/api/catalog`);
    assert.equal(catalog.status, 200);
    const body = await catalog.json();
    const { release } = await installedRelease();
    assert.equal(body.sha256, release.sha256);
    assert.deepEqual(body.source, { kind: 'local', input: 'catalog' });
    assert.ok(body.bytesBase64.length > 0);
  } finally {
    await close();
  }
});

test('prepare/apply flow works over HTTP with the digest-bound approval', async () => {
  const { project, origin, close } = await runningServer();
  try {
    const prepared = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ policyText: inlinePolicyText() })
    }).then(response => response.json());
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    assert.equal(typeof prepared.sessionId, 'string');

    const rejected = await fetch(`${origin}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ sessionId: prepared.sessionId, reviewDigest: '0'.repeat(64) })
    }).then(response => response.json());
    assert.equal(rejected.status, 'rejected');

    const applied = await fetch(`${origin}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ sessionId: prepared.sessionId, reviewDigest: prepared.review.reviewDigest })
    }).then(response => response.json());
    assert.equal(applied.completion, 'complete', JSON.stringify(applied.diagnostics));
    assert.equal(readFileSync(join(project, 'TEAM.md'), 'utf8'), 'Read the public consumer example notes.\n');
  } finally {
    await close();
  }
});

test('POSTs from a foreign origin are refused', async () => {
  const { origin, close } = await runningServer();
  try {
    const response = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ policyText: inlinePolicyText() })
    });
    assert.equal(response.status, 403);
  } finally {
    await close();
  }
});

test('a matching foreign Host and Origin cannot authorize a loopback request', async () => {
  const { origin, close } = await runningServer();
  try {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}/api/prepare`, { method: 'POST', headers: {
        host: 'attacker.example', origin: 'http://attacker.example', 'content-type': 'application/json',
      } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject);
      request.end(JSON.stringify({ policyText: inlinePolicyText() }));
    });
    assert.equal(status, 403);
  } finally { await close(); }
});

for (const suppliedOrigin of [undefined, 'null', 'malformed-origin']) {
  test(`POST requires an exact browser origin: ${String(suppliedOrigin)}`, async () => {
    const { origin, close } = await runningServer();
    try {
      const response = await fetch(`${origin}/api/prepare`, { method: 'POST', headers: {
        'content-type': 'application/json', ...(suppliedOrigin === undefined ? {} : { origin: suppliedOrigin }),
      }, body: JSON.stringify({ policyText: inlinePolicyText() }) });
      assert.equal(response.status, 403);
    } finally { await close(); }
  });
}

test('oversized request bodies are refused', async () => {
  const { origin, close } = await runningServer();
  try {
    const response = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ policyText: 'x'.repeat(1_100_000) })
    });
    assert.equal(response.status, 413);
  } finally {
    await close();
  }
});

test('unknown paths and wrong methods are refused', async () => {
  const { origin, close } = await runningServer();
  try {
    assert.equal((await fetch(`${origin}/../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${origin}/node_modules/@aihq/core/package.json`)).status, 404);
    assert.equal((await fetch(`${origin}/api/prepare`)).status, 405);
  } finally {
    await close();
  }
});
