import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose } from '@aihq/core/harness/runtime';
import { CLAIMS_SCHEMA, projectClaims } from '@aihq/core/report';
import { inspect, prepare, apply } from '../dist/core/index.js';
import { createRegistryCertificates, startRegistry, redirectRegistry, fakeNpmPath } from './fixtures/tls-registry.mjs';

const checkId = 'npm/tls/node/registry.npmjs.org';
const targets = process.platform === 'win32' ? ['npm'] : ['node', 'npm'];

async function fixture(run, hosts = []) {
  const root = mkdtempSync(join(tmpdir(), 'aih-persisted-tls-'));
  const previous = Object.fromEntries(['HOME', 'USERPROFILE', 'PATH', 'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'NPM_CONFIG_CAFILE', 'npm_config_cafile'].map(key => [key, process.env[key]]));
  let server; let restore;
  try {
    const home = join(root, 'home'); mkdirSync(home);
    process.env.HOME = home; process.env.USERPROFILE = home;
    process.env.PATH = fakeNpmPath(join(root, 'bin'));
    for (const key of ['NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NPM_CONFIG_CAFILE', 'npm_config_cafile']) delete process.env[key];
    const certificates = await createRegistryCertificates(hosts);
    server = await startRegistry(certificates); restore = redirectRegistry(server.port, hosts);
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

// ---- trust is the persisted trust alone, never this process's own start-time trust

const mcpHost = 'mcp.example.test';
const childScript = fileURLToPath(new URL('./fixtures/persisted-child.mjs', import.meta.url));

function mcpProject(root) {
  const project = join(root, 'project'); mkdirSync(project, { recursive: true });
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { remote: { url: `https://${mcpHost}/mcp` } } }));
  return project;
}
const mcpCheck = result => result.checks.find(check => check.id === 'mcp/tls/1');
const request = (project, configuration) => ({ targets: ['npm', 'claude'], probeConfiguredMcp: true, project, configuration });

/** The inspection runs in a child that started with the fixture CA in NODE_EXTRA_CA_CERTS (windowless, bounded). */
function inChild({ root, caFile, certificates, input }) {
  const run = spawnSync(process.execPath, [childScript, JSON.stringify({ certificates, hosts: [mcpHost], request: input })], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile }, encoding: 'utf8', windowsHide: true, timeout: 120_000, cwd: root });
  assert.equal(run.status, 0, `${run.stderr}${run.error ?? ''}`);
  const result = JSON.parse(run.stdout);
  assert.equal(result.extra, caFile);
  return result;
}
const outcomeOf = (result, id) => result.checks.find(check => check.id === id)?.outcome;

test('a process whose own extras include the CA does not satisfy a persisted check with nothing persisted', () => fixture(async ({ root, caFile, ...certificates }) => {
  const project = mcpProject(root);
  const common = { root, caFile, certificates };
  const control = inChild({ ...common, input: request(project, 'process') });
  assert.equal(outcomeOf(control, checkId), 'passed');
  assert.equal(outcomeOf(control, 'mcp/tls/1'), 'passed');
  const result = inChild({ ...common, input: request(project, 'persisted') });
  assert.equal(outcomeOf(result, checkId), 'failed');
  assert.equal(outcomeOf(result, 'mcp/tls/1'), 'failed');
  assert.deepEqual(result.persisted, { values: [] });
}, [mcpHost]));

test('removed managed blocks leave a start-time extra CA unused', () => fixture(async ({ root, home, caFile, ...certificates }) => {
  const project = mcpProject(root);
  await repair(caFile);
  rmSync(join(home, '.npmrc'));
  for (const name of ['.profile', '.zprofile']) rmSync(join(home, name), { force: true });
  const result = inChild({ root, caFile, certificates, input: request(project, 'persisted') });
  assert.equal(outcomeOf(result, checkId), 'failed');
  assert.equal(outcomeOf(result, 'mcp/tls/1'), 'failed');
  assert.ok(result.diagnostics.some(item => item.reason === 'persisted-removed'));
  assert.equal(result.status, 'incomplete');
}, [mcpHost]));

test('unreadable custody reports Node TLS checks unavailable instead of probing with any trust', () => fixture(async ({ root, home, caFile, ...certificates }) => {
  const project = mcpProject(root);
  await repair(caFile);
  const ownership = join(home, '.aih', 'core', 'ownership');
  for (const name of readdirSync(ownership)) writeFileSync(join(ownership, name), '{');
  const result = inChild({ root, caFile, certificates, input: request(project, 'persisted') });
  assert.equal(result.status, 'incomplete');
  assert.ok(result.diagnostics.some(item => item.code === 'PREREQUISITE_UNAVAILABLE' && item.reason === 'persisted-configuration-unavailable'));
  for (const id of [checkId, 'mcp/tls/1']) {
    const check = result.checks.find(item => item.id === id);
    assert.equal(check.outcome, 'unavailable', id);
    assert.equal(check.reason, 'persisted-configuration-unavailable');
  }
}, [mcpHost]));

test('a configured MCP origin follows the same persisted trust', () => fixture(async ({ root, caFile }) => {
  const project = mcpProject(root);
  assert.equal(mcpCheck(await inspect(request(project, 'persisted'))).outcome, 'failed');
  await repair(caFile);
  assert.equal(mcpCheck(await inspect(request(project, 'process'))).outcome, 'failed');
  const result = await inspect(request(project, 'persisted'));
  // Windows repair here persists only the npm cafile, so a new Node process still lacks the CA for other endpoints.
  assert.equal(mcpCheck(result).outcome, process.platform === 'win32' ? 'failed' : 'passed');
  assert.equal(outcomeOf(result, checkId), 'passed');
}, [mcpHost]));

test('a configured MCP origin is not verified by an unrelated persisted CA', () => fixture(async ({ root }) => {
  const project = mcpProject(root);
  const other = await createRegistryCertificates();
  const caFile = join(root, 'other.pem'); writeFileSync(caFile, other.caPem);
  await repair(caFile);
  assert.equal(mcpCheck(await inspect(request(project, 'persisted'))).outcome, 'failed');
}, [mcpHost]));

// ---- composition owned by the Harness

const diagnoseNpm = persistedTrust => diagnose({ requestId: 'composition', targets: ['npm'], persistedTrust });

test('npm cafile trust replaces the default roots while the Node side uses base plus Node extras', () => fixture(async ({ caPem }) => {
  const other = (await createRegistryCertificates()).caPem;
  const entry = (effect, ...certificates) => ({ effect, certificates });
  assert.equal(outcomeOf(await diagnoseNpm([entry('node', caPem)]), checkId), 'passed');
  // An applied cafile that lacks the CA does not borrow the Node extras.
  assert.equal(outcomeOf(await diagnoseNpm([entry('node', caPem), entry('npm', other)]), checkId), 'failed');
  assert.equal(outcomeOf(await diagnoseNpm([entry('node', other), entry('npm', caPem)]), checkId), 'passed');
  assert.equal(outcomeOf(await diagnoseNpm([]), checkId), 'failed');
}));

test('the base trust adds system roots only when a new process would enable them', () => fixture(async () => {
  const asked = [];
  const original = tls.getCACertificates;
  const environment = { NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA, NODE_OPTIONS: process.env.NODE_OPTIONS };
  tls.getCACertificates = type => { asked.push(type); return original.call(tls, 'bundled'); };
  try {
    for (const [name, value, system] of [['NODE_USE_SYSTEM_CA', undefined, false], ['NODE_USE_SYSTEM_CA', '0', false],
      ['NODE_USE_SYSTEM_CA', '1', true], ['NODE_OPTIONS', '--use-system-ca', true], ['NODE_OPTIONS', '--max-old-space-size=64 --use-system-ca', true],
      ['NODE_OPTIONS', '--max-old-space-size=64', false], ['NODE_OPTIONS', '--no-use-system-ca', false], ['NODE_OPTIONS', '--use-system-ca --no-use-system-ca', false],
      ['NODE_OPTIONS', '--no-use-system-ca --use-system-ca', true], ['NODE_OPTIONS', '"--use-system-ca"', true],
      ['NODE_OPTIONS', '"--use-system-ca" "--no-use-system-ca"', false], ['NODE_OPTIONS', '--title="--use-system-ca"', false],
      ['NODE_OPTIONS', '--use-system-"ca"', true], ['NODE_OPTIONS', '--title=x\t--use-system-ca', false]]) {
      for (const key of Object.keys(environment)) delete process.env[key];
      if (value !== undefined) process.env[name] = value;
      asked.length = 0;
      await diagnoseNpm([]);
      assert.equal(asked.includes('system'), system, `${name}=${value}`);
      assert.equal(asked.includes('default') || asked.includes('extra'), false);
    }
  } finally {
    tls.getCACertificates = original;
    for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}));

test('unavailable persisted trust reports Node TLS checks unavailable', () => fixture(async () => {
  const check = (await diagnoseNpm('unavailable')).checks.find(item => item.id === checkId);
  assert.equal(check.outcome, 'unavailable');
  assert.equal(check.reason, 'persisted-configuration-unavailable');
}));

// ---- the re-check as repair evidence, through the public claim projection

const instants = ['2026-10-14T10:00:00Z', '2026-10-14T10:05:00Z', '2026-10-14T10:10:00Z'];
const operation = 'node-npm-ca';
/** A measured claim in the claim-set format; the host maps an inspection check outcome to the claim's value. */
function evidence(id, measure, amount, unit, capturedAt) {
  return { id, revision: 'r1', producer: { id: 'host', version: '1.0.0' }, recordSchema: 'urn:example:record:1.0.0',
    subject: { kind: 'tool', id: 'npm' }, scope: { kind: 'machine', targets: ['host-1'] },
    sources: [{ id: `record-${id}`, schema: 'urn:example:record:1.0.0' }], observation: `event-${id}`, capturedAt,
    measure, kind: 'measured', value: { amount, unit }, coverage: { state: 'complete', reason: 'every target observed' },
    authentication: { status: 'not-authenticated' }, applicability: { state: 'current', reason: 'captured this session', inputs: [] } };
}
function classify(precheck, postcheck) {
  const claims = [evidence('pre', 'node-trust', precheck, 'outcome', instants[0]),
    evidence('rep', 'repair', operation, 'operation', instants[1]), evidence('post', 'node-trust', postcheck, 'outcome', instants[2])];
  const projection = projectClaims({ schema: CLAIMS_SCHEMA, claims, calculations: [{ id: 'repairs', method: 'verified-repair-count',
    version: '1.0.0', attempts: [{ operation, subject: { kind: 'tool', id: 'npm' }, condition: 'node-trust',
      precheck: { id: 'pre', revision: 'r1' }, repair: { id: 'rep', revision: 'r1' }, postcheck: { id: 'post', revision: 'r1' } }] }] });
  const [result] = projection.calculations;
  return { count: result.count, reason: result.attempts[0].reason };
}

test('a repair followed by the persisted re-check is verified by the claim projection', () => fixture(async ({ caFile }) => {
  const pre = outcomeOf(await inspect({ targets: ['npm'] }), checkId);
  assert.equal(pre, 'failed');
  await repair(caFile);
  const post = outcomeOf(await inspect({ targets: ['npm'], configuration: 'persisted' }), checkId);
  assert.deepEqual(classify(pre, post), { count: 1, reason: 'verified' });
}));

test('a repair with an unrelated CA is not verified by the claim projection', () => fixture(async ({ root }) => {
  const pre = outcomeOf(await inspect({ targets: ['npm'] }), checkId);
  const other = await createRegistryCertificates();
  const caFile = join(root, 'other.pem'); writeFileSync(caFile, other.caPem);
  await repair(caFile);
  const post = outcomeOf(await inspect({ targets: ['npm'], configuration: 'persisted' }), checkId);
  assert.deepEqual(classify(pre, post), { count: 0, reason: 'repair-not-verified' });
}));

test('a precheck that already passes is already healthy in the claim projection', () => fixture(async ({ root, caFile, ...certificates }) => {
  const input = { targets: ['npm'], configuration: 'process' };
  const pre = outcomeOf(inChild({ root, caFile, certificates, input }), checkId);
  assert.equal(pre, 'passed');
  await repair(caFile);
  const post = outcomeOf(await inspect({ targets: ['npm'], configuration: 'persisted' }), checkId);
  assert.deepEqual(classify(pre, post), { count: 0, reason: 'already-healthy' });
}));
