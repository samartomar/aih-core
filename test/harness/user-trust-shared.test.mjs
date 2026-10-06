import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getTrustFileIntegration } from '../../src/harness/trust-definitions.mjs';
import { renderUserToolsTrustFileRepair, prepareUserToolsRepair, userToolsRecipe } from '../../src/harness/user-trust.mjs';
import { userToolsRepair } from '../../src/harness/user-trust-definitions.mjs';

const environmentKeys = ['APPDATA', 'XDG_CONFIG_HOME', 'CARGO_HOME', 'CONDARC', 'GIT_CONFIG_GLOBAL',
  'PIP_CERT', 'PIP_CONFIG_FILE', 'WIN_PD_OVERRIDE_APPDATA', 'WIN_PD_OVERRIDE_LOCAL_APPDATA',
  'PIP_USER', 'PIP_SITE', 'PIP_GLOBAL',
  'GIT_SSL_CAINFO', 'CARGO_HTTP_CAINFO', 'CARGO_HTTP_SSL_VERIFY', 'PIP_TRUSTED_HOST', 'GIT_SSL_NO_VERIFY', 'CONDA_SSL_VERIFY',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'];
const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
before(() => { for (const key of environmentKeys) delete process.env[key]; });
after(() => { for (const [key, value] of Object.entries(savedEnvironment)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} });

const ca = readFileSync(new URL('./fixtures/root-a.pem', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = { status: 'unavailable', code: 'PREREQUISITE_UNAVAILABLE', reason: 'file-route-unsupported' };
const variantRef = (targets, network = 'off') => `user-tools-ca/${process.platform}/${targets.join('+')}/${network}`;
const shared = (targets, extra = {}) => renderUserToolsTrustFileRepair({
  id: 'user-tools-ca', variantRef: variantRef(targets), targets, offline: true,
  bundlePath: '/x/ca.pem', bundleSha256: 'a'.repeat(64), fingerprints: ['b'.repeat(64)],
  configSnapshots: {}, executablePaths: {}, ...extra });

test('shared file integration admits every existing user-tool target subset as PEM with the Node-bundled partition', () => {
  const roster = userToolsRepair.targets;
  assert.deepEqual(roster, ['python', 'pip', 'git', 'cargo', 'conda']);
  for (let bits = 1; bits < 32; bits++) {
    const targets = roster.filter((_, bit) => bits & (1 << bit));
    assert.deepEqual(getTrustFileIntegration('user-tools-ca', targets),
      { status: 'supported', format: 'pem', includeNodeBundled: true }, JSON.stringify(targets));
  }
});

test('shared file integration retains node/npm behavior and rejects invalid or unsupported selections', () => {
  assert.deepEqual(getTrustFileIntegration('node-npm-ca', ['node']), { status: 'supported', format: 'pem', includeNodeBundled: false });
  assert.deepEqual(getTrustFileIntegration('node-npm-ca', ['npm']), { status: 'supported', format: 'pem', includeNodeBundled: true });
  assert.deepEqual(getTrustFileIntegration('node-npm-ca', ['node', 'npm']), { status: 'supported', format: 'pem', includeNodeBundled: true });
  for (const [id, targets] of [['user-tools-ca', []], ['user-tools-ca', ['git', 'git']], ['user-tools-ca', ['node']],
    ['user-tools-ca', ['gradle']], ['user-tools-ca', ['pip', 'unknown']], ['user-tools-ca', 'git'], ['user-tools-ca', undefined],
    ['jvm-ca', ['python']], ['certificate-export', []], ['unknown', ['git']], ['__proto__', ['git']]])
    assert.deepEqual(getTrustFileIntegration(id, targets), unavailable, `${id} ${JSON.stringify(targets)}`);
});

test('shared file route renders the same client bindings as the legacy supplied-file repair for the same trust set', () => {
  const targets = ['pip', 'git', 'conda'];
  const configSnapshots = {
    'pip-config': Buffer.from('[global]\nindex-url=https://r.example/simple\n'),
    'git-config': Buffer.from('[user]\nname = Developer\n'),
    'conda-config': Buffer.from('channels:\n  - defaults\n') };
  const legacy = prepareUserToolsRepair({ id: 'user-tools-ca', variantRef: variantRef(targets), targets,
    files: { caFile: ca }, configSnapshots, managedPath: '/x/ca.pem', offline: true });
  assert.equal(legacy.status, 'completed', JSON.stringify(legacy.diagnostics));
  const result = renderUserToolsTrustFileRepair({ id: 'user-tools-ca', variantRef: variantRef(targets), targets,
    offline: true, bundlePath: '/x/ca.pem', bundleSha256: digest(legacy.bundle),
    fingerprints: legacy.fingerprints, configSnapshots, executablePaths: {} });
  assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
  assert.deepEqual(result.bindings, legacy.bindings);
  assert.deepEqual(result.privateBindings, legacy.privateBindings);
  assert.equal(result.bundle, undefined, 'serialized material bytes stay with the caller');
  assert.equal(Object.hasOwn(result, 'existing'), false);
});

test('shared file route binds the complete source-set fingerprints into Python verification', () => {
  const result = shared(['python', 'pip'], { fingerprints: ['c'.repeat(64), 'b'.repeat(64)] });
  assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
  assert.equal(result.bindings.fingerprintCsv, ['c'.repeat(64), 'b'.repeat(64)].join(','));
});

test('shared Python recipe accepts the complete set beyond the legacy supplied-file limit', () => {
  const fingerprints = Array.from({ length: 300 }, (_, index) => index.toString(16).padStart(64, '0'));
  const result = shared(['python'], { fingerprints });
  assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
  assert.equal(result.bindings.fingerprintCsv, fingerprints.join(','));
  assert.ok(result.recipe.inputs.fingerprintCsv.maxLength >= result.bindings.fingerprintCsv.length);
  const variant = userToolsRepair.variants.find(v => v.recipeRef === variantRef(['python']));
  assert.equal(userToolsRecipe(variant).inputs.fingerprintCsv.maxLength, 16640, 'legacy contract unchanged');
});

test('declared Python verification blocks an oversized complete set before returning a recipe', () => {
  const fingerprints = Array.from({ length: 401 }, (_, index) => index.toString(16).padStart(64, '0'));
  const result = shared(['python'], { variantRef: variantRef(['python'], 'declared'), offline: false, fingerprints });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.diagnostics.map(d => [d.code, d.reason]), [['SOURCE_LIMIT', 'source-limit']]);
  assert.equal(result.recipe, undefined); assert.equal(result.bindings, undefined);
});

test('shared file route preserves the existing actual-client environment and config checks', () => {
  try {
    process.env.PIP_CONFIG_FILE = join(homedir(), 'other-pip.conf');
    const redirected = shared(['pip']);
    assert.equal(redirected.status, 'blocked');
    assert.equal(redirected.diagnostics[0].reason, 'user-config-location-unsupported');
  } finally { delete process.env.PIP_CONFIG_FILE; }
  try {
    process.env.CARGO_HTTP_SSL_VERIFY = 'false';
    const bypass = shared(['cargo']);
    assert.equal(bypass.status, 'blocked');
    assert.equal(bypass.diagnostics[0].reason, 'trust-bypass-environment');
  } finally { delete process.env.CARGO_HTTP_SSL_VERIFY; }
  try {
    process.env.GIT_SSL_CAINFO = '/other/ca.pem';
    const override = shared(['git']);
    assert.equal(override.status, 'blocked');
    assert.equal(override.diagnostics[0].reason, 'trust-override-environment');
    process.env.GIT_SSL_CAINFO = '/x/ca.pem';
    assert.equal(shared(['git']).status, 'completed');
  } finally { delete process.env.GIT_SSL_CAINFO; }
  const declared = renderUserToolsTrustFileRepair({
    id: 'user-tools-ca', variantRef: variantRef(['pip'], 'declared'), targets: ['pip'], offline: false,
    bundlePath: '/x/ca.pem', bundleSha256: 'a'.repeat(64), fingerprints: ['b'.repeat(64)],
    configSnapshots: {}, executablePaths: { pipExecutable: process.execPath } });
  assert.equal(declared.status, 'completed', JSON.stringify(declared.diagnostics));
  try {
    process.env.PIP_TRUSTED_HOST = 'pypi.org';
    const bypassed = renderUserToolsTrustFileRepair({
      id: 'user-tools-ca', variantRef: variantRef(['pip'], 'declared'), targets: ['pip'], offline: false,
      bundlePath: '/x/ca.pem', bundleSha256: 'a'.repeat(64), fingerprints: ['b'.repeat(64)],
      configSnapshots: {}, executablePaths: { pipExecutable: process.execPath } });
    assert.equal(bypassed.status, 'blocked');
    assert.equal(bypassed.diagnostics[0].reason, 'trust-bypass-environment');
  } finally { delete process.env.PIP_TRUSTED_HOST; }
});

test('shared file route rejects legacy supplied-file fields, prior output and mismatched selections', () => {
  for (const extra of [{ files: { caFile: ca } }, { existing: Buffer.from(ca) }, { caFile: ca }, { validateOnly: true }]) {
    const result = shared(['git'], extra);
    assert.equal(result.status, 'invalid', JSON.stringify(Object.keys(extra)));
    assert.equal(result.diagnostics[0].reason, 'repair-input');
    assert.equal(result.bindings, undefined);
  }
  assert.equal(shared(['git', 'pip'], { variantRef: variantRef(['git']) }).diagnostics[0].reason, 'repair-input');
  assert.equal(shared(['git'], { id: 'node-npm-ca' }).diagnostics[0].reason, 'repair-input');
  assert.equal(shared(['git'], { offline: false }).diagnostics[0].reason, 'repair-input');
  assert.equal(shared(['git'], { bundleSha256: 'not-a-digest' }).diagnostics[0].reason, 'repair-input');
  assert.equal(shared(['git'], { fingerprints: [] }).diagnostics[0].reason, 'repair-input');
  assert.equal(shared(['git'], { bundlePath: 'relative/ca.pem' }).diagnostics[0].reason, 'repair-input');
});

test('shared file route still refuses ambiguous or bypassing user configuration', () => {
  const ambiguous = shared(['pip'], { configSnapshots: { 'pip-config': Buffer.from('[global]\ncert=/one\ncert=/two\n') } });
  assert.equal(ambiguous.status, 'invalid');
  assert.equal(ambiguous.diagnostics[0].reason, 'config-ambiguous');
  const bypass = shared(['git'], { configSnapshots: { 'git-config': Buffer.from('[http]\nsslVerify = false\n') } });
  assert.equal(bypass.status, 'blocked');
  assert.equal(bypass.diagnostics[0].reason, 'trust-bypass-config');
});
