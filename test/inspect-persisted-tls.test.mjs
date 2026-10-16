import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect, prepare, apply } from '../dist/core/index.js';
import { createRegistryCertificates, startRegistry, redirectRegistry, fakeNpmPath } from './fixtures/tls-registry.mjs';

const checkId = 'npm/tls/node/registry.npmjs.org';
const targets = process.platform === 'win32' ? ['npm'] : ['node', 'npm'];

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'aih-persisted-tls-'));
  const previous = Object.fromEntries(['HOME', 'USERPROFILE', 'PATH', 'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'NPM_CONFIG_CAFILE', 'npm_config_cafile'].map(key => [key, process.env[key]]));
  let server; let restore;
  try {
    const home = join(root, 'home'); mkdirSync(home);
    process.env.HOME = home; process.env.USERPROFILE = home;
    process.env.PATH = fakeNpmPath(join(root, 'bin'));
    for (const key of ['NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NPM_CONFIG_CAFILE', 'npm_config_cafile']) delete process.env[key];
    const certificates = await createRegistryCertificates();
    server = await startRegistry(certificates); restore = redirectRegistry(server.port);
    const caFile = join(root, 'ca.pem'); writeFileSync(caFile, certificates.caPem);
    await run({ root, home, caFile, ...certificates });
  } finally {
    restore?.();
    try { await server?.close(); } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function nodeCheck(result, outcome) {
  assert.notEqual(result.status, 'invalid', JSON.stringify(result.diagnostics));
  const check = result.checks.find(item => item.id === checkId);
  assert.ok(check, JSON.stringify(result));
  assert.equal(check.outcome, outcome);
  if (outcome === 'failed') assert.equal(check.reason, 'certificate-chain');
}

async function repair(caFile, selected = targets) {
  const prepared = await prepare({ useCase: 'repair', repairs: [{ id: 'node-npm-ca', targets: selected,
    inputs: { caFile } }], network: 'off' }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const result = await apply(prepared.prepared, { approved: true, origin: 'automation',
    reviewDigest: prepared.review.reviewDigest }, { logging: 'off' });
  assert.equal(result.completion, 'incomplete', JSON.stringify(result));
  assert.equal(result.checks.find(check => check.id === 'trust/material-digest').status, 'passed');
  return prepared.review.operations.find(operation => operation.id === 'trust/material').details.target;
}

function appliedValues(result, home, material, selected) {
  assert.deepEqual(result.effectiveOptions.configuration, { value: 'persisted', origin: 'explicit' });
  const expected = selected.includes('node') ? ['node-extra-ca-certs'] : [];
  if (selected.includes('npm')) expected.push('npm-cafile');
  assert.deepEqual(result.persisted.values.map(value => value.id).sort(), expected.sort());
  for (const value of result.persisted.values) {
    assert.equal(value.repair, 'node-npm-ca');
    assert.equal(value.managementId, 'node-npm-trust');
    assert.equal(value.state, 'applied');
    assert.equal(value.value, material);
    assert.ok(value.certificates >= 1);
    assert.equal(value.materialSha256, createHash('sha256').update(readFileSync(material)).digest('hex'));
    assert.deepEqual({ path: resolve(realpathSync.native(home), value.member.path), blockId: value.member.blockId }, value.id === 'npm-cafile' ?
      { path: join(realpathSync.native(home), '.npmrc'), blockId: 'npm-ca' } :
      { path: join(realpathSync.native(home), process.platform === 'darwin' ? '.zprofile' : '.profile'), blockId: 'node-ca' });
  }
}

test('registry fixture rejects process trust and authorizes its CA through the redirect', () => fixture(async ({ caPem }) => {
  const result = await inspect({ targets: ['npm'] });
  nodeCheck(result, 'failed');
  assert.equal(Object.hasOwn(result, 'persisted'), false);
  await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: 'registry.npmjs.org', port: 443, servername: 'registry.npmjs.org',
      rejectUnauthorized: true, ca: [caPem] }, () => {
      try { assert.equal(socket.authorized, true); socket.destroy(); resolve(); } catch (error) { socket.destroy(); reject(error); }
    });
    socket.setTimeout(5000, () => socket.destroy(new Error('TLS fixture timed out')));
    socket.once('error', reject);
  });
}));

test('persisted inspection before repair reports the same certificate-chain failure', () => fixture(async () => {
  const result = await inspect({ targets: ['npm'], configuration: 'persisted' });
  nodeCheck(result, 'failed');
  assert.deepEqual(result.persisted.values, []);
  assert.deepEqual(result.effectiveOptions.configuration, { value: 'persisted', origin: 'explicit' });
}));

test('persisted inspection verifies repaired npm trust while process trust stays unchanged', () => fixture(async ({ home, caFile }) => {
  const material = await repair(caFile);
  const current = await inspect({ targets: ['npm'] });
  nodeCheck(current, 'failed');
  assert.equal(Object.hasOwn(current, 'persisted'), false);
  const result = await inspect({ targets: ['npm'], configuration: 'persisted' });
  nodeCheck(result, 'passed');
  appliedValues(result, home, material, targets);
  const explicit = await inspect({ targets: ['npm'], configuration: 'process' });
  nodeCheck(explicit, 'failed');
  assert.equal(Object.hasOwn(explicit, 'persisted'), false);
}));

test('persisted inspection verifies Node trust without npm repair', { skip: process.platform === 'win32' }, () => fixture(async ({ home, caFile }) => {
  const material = await repair(caFile, ['node']);
  const result = await inspect({ targets: ['npm'], configuration: 'persisted' });
  nodeCheck(result, 'passed');
  appliedValues(result, home, material, ['node']);
}));

test('persisted inspection does not verify repair with an unrelated CA', () => fixture(async ({ root, home }) => {
  const other = await createRegistryCertificates();
  const caFile = join(root, 'other.pem'); writeFileSync(caFile, other.caPem);
  const material = await repair(caFile);
  const result = await inspect({ targets: ['npm'], configuration: 'persisted' });
  nodeCheck(result, 'failed');
  appliedValues(result, home, material, targets);
}));

test('persisted inspection ignores ordinary unmanaged trust assignments', () => fixture(async ({ home, caFile }) => {
  for (const profile of ['.profile', '.zprofile']) writeFileSync(join(home, profile), `export NODE_EXTRA_CA_CERTS='${caFile}'\n`);
  writeFileSync(join(home, '.npmrc'), `cafile=${caFile}\n`);
  const result = await inspect({ targets: ['npm'], configuration: 'persisted' });
  nodeCheck(result, 'failed');
  assert.deepEqual(result.persisted.values, []);
}));
