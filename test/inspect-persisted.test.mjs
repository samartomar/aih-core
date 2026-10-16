import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getRepairRecipe, renderRepair, diagnose, persistedConfigurationMembers } from '@aihq/core/harness/runtime';
import { repairIndex } from '@aihq/core/harness';
import { prepare, apply, inspect } from '../dist/core/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'aih-persisted-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const root = readFileSync(new URL('./fixtures/root-a.pem', import.meta.url));
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});
before(() => { process.env.HOME = scratch; process.env.USERPROFILE = scratch; });

const digest = value => createHash('sha256').update(value).digest('hex');
const authorize = result => ({ approved: true, origin: 'automation', reviewDigest: result.review.reviewDigest });
const profileSegments = process.platform === 'win32' ? ['Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'] :
  process.platform === 'darwin' ? ['.zprofile'] : ['.profile'];
const profilePath = home => join(home, ...profileSegments);
const nodeBlock = { start: '# BEGIN AIHQ NODE CA', end: '# END AIHQ NODE CA' };
const npmBlock = { start: '# BEGIN AIHQ NPM CA', end: '# END AIHQ NPM CA' };
const blockPattern = ({ start, end }) => new RegExp(`${start}\\r?\\n[\\s\\S]*?${end}\\r?\\n?`);
const freshHome = label => {
  const dir = join(scratch, label); mkdirSync(dir, { recursive: true });
  process.env.HOME = dir; process.env.USERPROFILE = dir;
  return realpathSync.native(dir);
};
const persisted = request => inspect({ targets: ['npm'], network: 'off', ...request, configuration: 'persisted' });

/**
 * Real repair route; Windows persists Node through the policy route without its registry step. That selection
 * must declare both blocks, or the policy route would reconcile the repair's npm block away.
 */
async function repairedHome(label) {
  const home = freshHome(label);
  const source = join(scratch, `${label}.pem`); writeFileSync(source, root);
  const targets = process.platform === 'win32' ? ['npm'] : ['node', 'npm'];
  const prepared = await prepare({ useCase: 'repair', repairs: [{ id: 'node-npm-ca', targets, inputs: { caFile: source } }],
    network: 'off' }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const materialPath = prepared.review.operations.find(op => op.id === 'trust/material').details.target;
  assert.equal((await apply(prepared.prepared, authorize(prepared), { logging: 'off' })).completion, 'incomplete');
  if (process.platform === 'win32') {
    const bundle = readFileSync(materialPath, 'utf8');
    const fingerprints = (bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [])
      .map(pem => new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase());
    const variant = repairIndex[0].variants.find(item => item.os === 'win32' && item.targets.length === 2 &&
      item.network === 'off');
    const rendered = renderRepair({ id: 'node-npm-ca', variantRef: variant.recipeRef, bundlePath: materialPath,
      bundleSha256: digest(bundle), fingerprints });
    assert.equal(rendered.status, 'completed');
    const recipe = getRepairRecipe(variant.recipeRef);
    recipe.operations = recipe.operations.filter(op => op.id !== 'node-persist');
    recipe.checks = recipe.checks.filter(check => check.id !== 'node-user-env');
    recipe.operations.find(op => op.id === 'node-config').requires = ['material'];
    const node = await prepare({ useCase: 'policy', target: { project: home }, policy: {
      schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
        id: 'trust', managementId: 'node-npm-trust', scope: 'user', configuration: rendered.bindings,
        requires: [], recipe: { inline: recipe } }] } }, { logging: 'off', privateInputs: { trust: { bundle } } });
    assert.ok(['ready', 'partial'].includes(node.status), JSON.stringify(node));
    await apply(node.prepared, { ...authorize(node), allowPartial: true }, { logging: 'off' });
  }
  assert.match(readFileSync(profilePath(home), 'utf8'), /AIHQ NODE CA/);
  return { home, materialPath, profile: profilePath(home), npmrc: join(home, '.npmrc') };
}
const tree = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? [`${path}/`, ...tree(path)] : [`${path}:${statSync(path).mtimeMs}:${statSync(path).size}`];
}).sort();
const byId = (result, id) => result.persisted.values.find(value => value.id === id);
const conflicts = result => result.diagnostics.filter(item => item.code === 'STATE_CONFLICT').map(item => item.reason).sort();

test('the Harness descriptors name the managed blocks for this platform', () => {
  const members = persistedConfigurationMembers();
  assert.deepEqual(members.map(item => item.id), ['node-extra-ca-certs', 'npm-cafile']);
  const [node, npm] = members;
  assert.equal(node.repair, 'node-npm-ca'); assert.equal(node.managementId, 'node-npm-trust');
  assert.equal(node.materialName, 'trust.pem'); assert.equal(node.effect, 'node');
  assert.deepEqual(node.member, { path: profileSegments.join('/'), kind: 'block', blockId: 'node-ca',
    startMarker: nodeBlock.start, endMarker: nodeBlock.end });
  assert.deepEqual(npm.member, { path: '.npmrc', kind: 'block', blockId: 'npm-ca',
    startMarker: npmBlock.start, endMarker: npmBlock.end });
  assert.equal(npm.content('/x/trust.pem'), 'cafile=/x/trust.pem');
  assert.equal(node.content("/x/it's.pem"), process.platform === 'win32' ? "$env:NODE_EXTRA_CA_CERTS = '/x/it''s.pem'" :
    "export NODE_EXTRA_CA_CERTS='/x/it'\\''s.pem'");
  assert.throws(() => { node.member.path = 'elsewhere'; });
});

test('persisted configuration reports applied Core-managed values with their material', async () => {
  const { home, materialPath, profile } = await repairedHome('applied');
  const result = await persisted();
  assert.deepEqual(result.effectiveOptions.configuration, { value: 'persisted', origin: 'explicit' });
  assert.equal(result.persisted.values.length, 2);
  const material = readFileSync(materialPath);
  const count = (material.toString().match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
  assert.ok(count >= 1);
  for (const value of result.persisted.values) {
    assert.equal(value.state, 'applied', JSON.stringify(value));
    assert.equal(value.repair, 'node-npm-ca'); assert.equal(value.managementId, 'node-npm-trust');
    assert.equal(value.value, materialPath);
    assert.equal(value.certificates, count);
    assert.equal(value.materialSha256, digest(material));
  }
  assert.deepEqual(byId(result, 'node-extra-ca-certs').member,
    { path: profileSegments.join('/'), blockId: 'node-ca' });
  assert.deepEqual(byId(result, 'npm-cafile').member, { path: '.npmrc', blockId: 'npm-ca' });
  assert.deepEqual(conflicts(result), []);
  // A line outside the managed block never changes or joins the result.
  writeFileSync(profile, `export NODE_EXTRA_CA_CERTS=/elsewhere\n${readFileSync(profile, 'utf8')}`);
  const again = await persisted();
  assert.deepEqual(again.persisted.values.map(item => item.state), ['applied', 'applied']);
  assert.ok(materialPath.startsWith(join(home, '.aih', 'core', 'content')));
});

test('default and process configuration have no persisted result', async () => {
  freshHome('process');
  const fallback = await inspect({ targets: ['npm'], network: 'off' });
  assert.deepEqual(fallback.effectiveOptions.configuration, { value: 'process', origin: 'default' });
  assert.equal(Object.hasOwn(fallback, 'persisted'), false);
  const explicit = await inspect({ targets: ['npm'], network: 'off', configuration: 'process' });
  assert.deepEqual(explicit.effectiveOptions.configuration, { value: 'process', origin: 'explicit' });
  assert.equal(Object.hasOwn(explicit, 'persisted'), false);
});

test('unrelated profile and npm configuration is never read as persisted trust', async () => {
  const home = freshHome('unrelated');
  mkdirSync(dirname(profilePath(home)), { recursive: true });
  writeFileSync(profilePath(home), 'export NODE_EXTRA_CA_CERTS=/elsewhere\n');
  writeFileSync(join(home, '.npmrc'), 'cafile=/elsewhere/ca.pem\n');
  const before = tree(home);
  const result = await persisted();
  assert.deepEqual(tree(home), before);
  assert.deepEqual(result.persisted, { values: [] });
  assert.deepEqual(conflicts(result), []);
  assert.equal(existsSync(join(home, '.aih')), false);
});

test('a path edited inside the managed block is modified and not applied', async () => {
  const { profile } = await repairedHome('edited');
  const text = readFileSync(profile, 'utf8');
  assert.ok(text.includes('trust.pem'));
  writeFileSync(profile, text.replace('trust.pem', 'other.pem'));
  const result = await persisted();
  const node = byId(result, 'node-extra-ca-certs');
  assert.equal(node.state, 'modified');
  for (const key of ['value', 'certificates', 'materialSha256']) assert.equal(Object.hasOwn(node, key), false);
  assert.equal(byId(result, 'npm-cafile').state, 'applied');
  assert.deepEqual(conflicts(result), ['persisted-modified']);
  assert.equal(result.status, 'incomplete');
});

test('a deleted managed block is removed and not applied', async () => {
  const { profile, npmrc } = await repairedHome('removed');
  writeFileSync(profile, readFileSync(profile, 'utf8').replace(blockPattern(nodeBlock), ''));
  rmSync(npmrc);
  const result = await persisted();
  assert.deepEqual(result.persisted.values.map(item => [item.id, item.state]),
    [['node-extra-ca-certs', 'removed'], ['npm-cafile', 'removed']]);
  assert.deepEqual(conflicts(result), ['persisted-removed', 'persisted-removed']);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.persisted.values.some(item => item.state === 'applied'), false);
});

test('changed material bytes make both values modified', async () => {
  const { materialPath } = await repairedHome('material');
  writeFileSync(materialPath, Buffer.concat([readFileSync(materialPath), Buffer.from('\n# changed\n')]));
  const result = await persisted();
  assert.deepEqual(result.persisted.values.map(item => item.state), ['modified', 'modified']);
  assert.deepEqual(conflicts(result), ['persisted-modified', 'persisted-modified']);
  assert.equal(result.status, 'incomplete');
});

test('deleted material is removed and not applied', async () => {
  const { materialPath } = await repairedHome('material-gone');
  rmSync(materialPath);
  const result = await persisted();
  assert.deepEqual(result.persisted.values.map(item => item.state), ['removed', 'removed']);
  assert.equal(result.status, 'incomplete');
});

test('hand-written markers without Core custody are unowned', async () => {
  const home = freshHome('unowned');
  mkdirSync(dirname(profilePath(home)), { recursive: true });
  const material = join(home, 'trust.pem'); writeFileSync(material, root);
  const assignment = process.platform === 'win32' ? `$env:NODE_EXTRA_CA_CERTS = '${material}'` :
    `export NODE_EXTRA_CA_CERTS='${material}'`;
  writeFileSync(profilePath(home), `${nodeBlock.start}\n${assignment}\n${nodeBlock.end}\n`);
  writeFileSync(join(home, '.npmrc'), `${npmBlock.start}\ncafile=${material}\n${npmBlock.end}\n`);
  const before = tree(home);
  const result = await persisted();
  assert.deepEqual(tree(home), before);
  assert.deepEqual(result.persisted.values.map(item => item.state), ['unowned', 'unowned']);
  for (const value of result.persisted.values) assert.equal(Object.hasOwn(value, 'value'), false);
  assert.deepEqual(conflicts(result), ['persisted-unowned', 'persisted-unowned']);
  assert.equal(result.status, 'incomplete');
  assert.equal(existsSync(join(home, '.aih')), false);
});

test('inspection of persisted configuration never writes state or history', async () => {
  const { home } = await repairedHome('read-only');
  const snapshot = tree(join(home, '.aih'));
  await persisted(); await persisted();
  assert.deepEqual(tree(join(home, '.aih')), snapshot);
});

test('an invalid configuration option is refused', async () => {
  freshHome('invalid');
  for (const configuration of ['bogus', 1, null, {}, ['persisted']]) {
    const result = await inspect({ network: 'off', configuration });
    assert.equal(result.status, 'invalid');
    assert.equal(result.diagnostics[0].reason, 'configuration');
    assert.deepEqual(result.effectiveOptions.configuration, { value: 'process', origin: 'default' });
    assert.equal(Object.hasOwn(result, 'persisted'), false);
  }
});

test('a line ending elsewhere in the file does not make an unchanged managed block modified', async () => {
  const { profile, npmrc } = await repairedHome('mixed-endings');
  for (const file of [profile, npmrc]) {
    const text = readFileSync(file, 'utf8');
    const other = text.includes('\r\n') ? '\n' : '\r\n';
    writeFileSync(file, `# unrelated${other}${text}`);
  }
  const result = await persisted();
  assert.deepEqual(result.persisted.values.map(item => item.state), ['applied', 'applied']);
  assert.deepEqual(conflicts(result), []);
  // A genuinely edited block stays modified however the surrounding lines end.
  const text = readFileSync(profile, 'utf8');
  writeFileSync(profile, text.replace('trust.pem', 'other.pem'));
  assert.deepEqual(byId(await persisted(), 'node-extra-ca-certs').state, 'modified');
  writeFileSync(npmrc, readFileSync(npmrc, 'utf8').replace('trust.pem', 'other.pem'));
  assert.deepEqual(byId(await persisted(), 'npm-cafile').state, 'modified');
});

test('diagnose refuses malformed persisted trust', async () => {
  freshHome('diagnose');
  const pem = root.toString();
  const base = { requestId: 'persisted-trust', targets: ['npm'], network: 'off' };
  const entry = (effect, ...certificates) => ({ effect, certificates });
  const many = Array.from({ length: 1025 }, () => pem);
  const big = Array.from({ length: 300 }, () => 'a'.repeat(65536));
  const bad = ['x', 1, null, {}, { node: [pem] }, [1], [null], [{}], [entry('node')].concat([{ effect: 'node' }]),
    [{ certificates: [pem] }], [{ effect: 'node', certificates: [pem], extra: [] }], [entry('other', pem)],
    [entry('node', 1)], [entry('npm', 'not a certificate')], [entry('node', pem + 'x'.repeat(70000))],
    [entry('node', ...many)], [entry('node', pem), entry('npm', ...many)], [entry('node', ...big)],
    Array.from({ length: 17 }, () => entry('node')), Object.create([entry('node', pem)]),
    [{ __proto__: { effect: 'node', certificates: [pem] } }], [{ effect: 'node', certificates: Object.create([pem]) }]];
  for (const persistedTrust of bad) {
    const result = await diagnose({ ...base, persistedTrust });
    assert.equal(result.status, 'invalid', JSON.stringify(persistedTrust)?.slice(0, 80));
    assert.equal(result.diagnostics[0].reason, 'persisted-trust');
  }
  for (const persistedTrust of [[], [entry('node')], [entry('node', pem), entry('npm', pem)], 'unavailable']) {
    const result = await diagnose({ ...base, persistedTrust });
    assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
  }
});
