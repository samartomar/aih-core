import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { repairIndex } from '@aihq/core/harness';
import { prepare, apply } from '../dist/core/index.js';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'aih-user-trust-')));
const home = join(scratch, 'home');
const bin = join(scratch, 'bin');
const root = readFileSync(new URL('./fixtures/root-a.pem', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH,
  APPDATA: process.env.APPDATA };
const envOverrides = ['GIT_CONFIG_GLOBAL', 'GIT_SSL_NO_VERIFY', 'GIT_SSL_CAINFO', 'PIP_CERT', 'PIP_TRUSTED_HOST',
  'PIP_CONFIG_FILE', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'CONDARC', 'CONDA_SSL_VERIFY', 'CARGO_HOME',
  'CARGO_HTTP_CAINFO', 'CARGO_HTTP_SSL_VERIFY', 'XDG_CONFIG_HOME'];
const savedOverrides = Object.fromEntries(envOverrides.map(key => [key, process.env[key]]));
const appData = join(home, 'AppData', 'Roaming');
before(() => {
  mkdirSync(home); mkdirSync(bin);
  process.env.HOME = home; process.env.USERPROFILE = home;
  if (process.platform === 'win32') process.env.APPDATA = appData;
  for (const key of envOverrides) delete process.env[key];
});
beforeEach(() => {
  for (const path of [home, bin]) {
    assert.equal(dirname(realpathSync(path)), scratch);
    rmSync(path, { recursive: true });
    mkdirSync(path);
  }
  // A normal Windows user profile already has its Roaming directory. The
  // state-protection PowerShell process may initialize it in an empty fixture.
  if (process.platform === 'win32') mkdirSync(appData, { recursive: true });
});
after(() => {
  for (const [key, value] of Object.entries({ ...previous, ...savedOverrides })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const definition = repairIndex.find(item => item.id === 'user-tools-ca');
const variantFor = (targets, network = 'off') => definition.variants.find(item =>
  item.os === process.platform && item.architectures.includes(process.arch) && item.network === network &&
  item.targets.length === targets.length && item.targets.every(target => targets.includes(target)));
const configPath = (targets, operationId) => join(home,
  ...variantFor(targets).configFiles.find(file => file.operationId === operationId).target.segments.map(slot => slot.literal));
const pipConfig = (...targets) => configPath(['pip', ...targets], 'pip-config');
const request = (file, targets, network = 'off') => ({ useCase: 'repair', repairs: [{ id: 'user-tools-ca', targets,
  inputs: { caFile: file } }], ...(network === 'off' ? { network: 'off' } : {}) });
const authorize = (result, extra = {}) => ({ approved: true, origin: 'automation', reviewDigest: result.review.reviewDigest, ...extra });
const withPath = async (fn) => {
  process.env.PATH = bin;
  try { return await fn(); } finally { process.env.PATH = previous.PATH; }
};
const fixtureTool = name => {
  if (process.platform === 'win32') {
    const exe = join(bin, `${name}.exe`);
    if (!existsSync(exe)) copyFileSync(process.execPath, exe);
    return;
  }
  const script = join(bin, name);
  writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
};
const source = name => { const path = join(scratch, name); writeFileSync(path, root); return path; };

test('review shows exact pip effects and writes nothing before authorization', () => withPath(async () => {
  fixtureTool('pip');
  const prepared = await prepare(request(source('review.pem'), ['pip']), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const operation = prepared.review.operations.find(item => item.id === 'trust/pip-config');
  assert.equal(operation.effects, 'create-file');
  assert.equal(operation.details.content, '[REDACTED]');
  assert.ok(operation.details.target.endsWith(process.platform === 'win32' ? 'pip.ini' : 'pip.conf'));
  assert.equal(JSON.stringify(prepared.review).includes('use-feature'), false);
  assert.equal(prepared.review.inputs.package.name, '@aihq/core');
  assert.ok(prepared.review.observations.some(item => item.id === 'harness-helper' && /^sha256:[a-f0-9]{64}$/.test(item.reason)));
  assert.ok(prepared.review.observations.some(item => item.id === 'pip-behavior' && item.reason === 'skipped-offline'));
  assert.equal(existsSync(pipConfig()), false);
  assert.equal(existsSync(join(home, '.aih')), false);
}));

test('authorized offline pip repair writes preserved config and reports verification unavailable', () => withPath(async () => {
  fixtureTool('pip');
  const config = pipConfig();
  mkdirSync(join(config, '..'), { recursive: true });
  writeFileSync(config, '[global]\nindex-url=https://r.example/simple\n');
  const prepared = await prepare(request(source('apply.pem'), ['pip']), { logging: 'off' });
  assert.equal(prepared.status, 'partial', JSON.stringify(prepared.diagnostics));
  assert.ok(prepared.diagnostics.some(item => item.code === 'STATE_CONFLICT'));
  const stale = await prepare({ ...request(source('apply.pem'), ['pip']),
    resolutions: [{ selectionId: 'trust', operationId: 'pip-config', choice: 'replace', observedSha256: sha256('different') }] },
    { logging: 'off' });
  assert.equal(stale.status, 'invalid');
  assert.equal(stale.diagnostics[0].reason, 'resolution-stale');
  const reviewed = await prepare({ ...request(source('apply.pem'), ['pip']), resolutions: [{ selectionId: 'trust',
    operationId: 'pip-config', choice: 'replace', observedSha256: sha256(readFileSync(config)) }] }, { logging: 'off' });
  assert.equal(reviewed.status, 'ready', JSON.stringify(reviewed.diagnostics));
  const result = await apply(reviewed.prepared, authorize(reviewed), { logging: 'off' });
  assert.equal(result.completion, 'incomplete', JSON.stringify(result.diagnostics));
  assert.equal(result.operations.find(item => item.id === 'trust/material').application, 'applied');
  assert.equal(result.checks.find(item => item.id === 'trust/material-digest').status, 'passed');
  const written = readFileSync(config, 'utf8');
  assert.match(written, /index-url=https:\/\/r\.example\/simple/);
  assert.match(written, /cert\s*=/);
  const verification = result.operations.find(item => item.id === 'trust/pip-config').verification;
  assert.deepEqual(verification, { status: 'unavailable', reason: 'offline' });
  assert.ok(result.checks.some(item => item.id === 'trust/pip-behavior' && item.status === 'skipped' && item.reason === 'offline'));
  assert.ok(result.diagnostics.some(item => item.code === 'VERIFICATION_UNAVAILABLE' && item.reason === 'offline'));
  const repeat = await prepare(request(source('apply.pem'), ['pip']), { logging: 'off' });
  assert.equal(repeat.status, 'ready', JSON.stringify(repeat.diagnostics));
  assert.equal(repeat.review.operations.find(item => item.id === 'trust/pip-config').effects, 'already-satisfied');
  assert.equal(repeat.review.operations.find(item => item.id === 'trust/material').effects, 'already-satisfied');
  const again = await apply(repeat.prepared, authorize(repeat), { logging: 'off' });
  assert.equal(again.completion, 'incomplete');
  assert.equal(readFileSync(config, 'utf8'), written);
}));

test('missing selected tool stays unavailable, needs explicit partial and writes no tool config', () => withPath(async () => {
  const prepared = await prepare(request(source('missing.pem'), ['git']), { logging: 'off' });
  assert.equal(prepared.status, 'partial', JSON.stringify(prepared.diagnostics));
  assert.ok(prepared.diagnostics.some(item => item.code === 'PREREQUISITE_UNAVAILABLE'));
  assert.ok(prepared.review.operations.filter(item => item.id.startsWith('trust/git-'))
    .every(item => item.effects === 'unavailable'));
  const refused = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(refused.completion, 'rejected');
  assert.ok(refused.diagnostics.some(item => item.code === 'APPROVAL_REQUIRED' && item.reason === 'partial-approval-required'));
  const retry = await prepare(request(source('missing.pem'), ['git']), { logging: 'off' });
  assert.equal(retry.status, 'partial', JSON.stringify(retry.diagnostics));
  const result = await apply(retry.prepared, authorize(retry, { allowPartial: true }), { logging: 'off' });
  assert.equal(result.completion, 'incomplete');
  assert.equal(result.operations.find(item => item.id === 'trust/git-config').application, 'not-attempted');
  assert.equal(result.operations.find(item => item.id === 'trust/git-ready').reason, 'unavailable');
  assert.equal(result.authorization.allowPartial.value, true);
  assert.equal(existsSync(join(home, '.gitconfig')), false);
}));

test('missing Git blocks only the Cargo branch while reviewed pip work completes', () => withPath(async () => {
  fixtureTool('pip'); fixtureTool('cargo');
  const prepared = await prepare(request(source('cargo.pem'), ['pip', 'cargo']), { logging: 'off' });
  assert.equal(prepared.status, 'partial', JSON.stringify(prepared.diagnostics));
  assert.ok(prepared.review.operations.filter(item => item.id.startsWith('trust/cargo-'))
    .every(item => item.effects === 'unavailable'));
  const result = await apply(prepared.prepared, authorize(prepared, { allowPartial: true }), { logging: 'off' });
  assert.equal(result.completion, 'incomplete', JSON.stringify(result.diagnostics));
  assert.ok(['applied', 'already-satisfied'].includes(result.operations.find(item => item.id === 'trust/pip-config').application));
  assert.equal(result.operations.find(item => item.id === 'trust/cargo-config').application, 'not-attempted');
  assert.match(readFileSync(pipConfig('cargo'), 'utf8'), /cert\s*=/);
  assert.equal(existsSync(join(home, '.cargo', 'config.toml')), false);
}));

test('Cargo legacy config blocks preparation without effects', () => withPath(async () => {
  fixtureTool('cargo'); fixtureTool('git');
  mkdirSync(join(home, '.cargo'));
  const legacy = join(home, '.cargo', 'config');
  writeFileSync(legacy, '');
  const input = request(source('cargo-precedence.pem'), ['cargo']);
  const inactive = await prepare(input, { logging: 'off' });
  assert.equal(inactive.status, 'blocked', JSON.stringify(inactive.diagnostics));
  assert.ok(inactive.diagnostics.some(item => item.code === 'PREREQUISITE_UNAVAILABLE' && item.reason === 'cargo-legacy-config'));
  assert.equal(existsSync(join(home, '.aih')), false);
  assert.equal(existsSync(join(home, '.cargo', 'config.toml')), false);
}));

test('Cargo inherited TLS bypass blocks preparation without effects', () => withPath(async () => {
  fixtureTool('cargo'); fixtureTool('git');
  const input = request(source('cargo-bypass.pem'), ['cargo']);
  process.env.CARGO_HTTP_SSL_VERIFY = 'false';
  try {
    const bypass = await prepare(input, { logging: 'off' });
    assert.equal(bypass.status, 'blocked', JSON.stringify(bypass.diagnostics));
    assert.ok(bypass.diagnostics.some(item => item.reason === 'trust-bypass-environment'));
    assert.equal(existsSync(join(home, '.aih')), false);
  } finally { delete process.env.CARGO_HTTP_SSL_VERIFY; }
}));

test('Cargo legacy config created after review rejects before any effect', () => withPath(async () => {
  fixtureTool('cargo'); fixtureTool('git');
  const prepared = await prepare(request(source('cargo-stale-precedence.pem'), ['cargo']), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.ok(prepared.review.observations.some(item => item.id === 'cargo-legacy-config'));
  mkdirSync(join(home, '.cargo'));
  writeFileSync(join(home, '.cargo', 'config'), '[net]\nretry = 0\n');
  const applied = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(applied.completion, 'rejected');
  assert.ok(applied.diagnostics.some(item => item.code === 'REVIEW_STALE'));
  assert.equal(existsSync(join(home, '.cargo', 'config.toml')), false);
  assert.equal(existsSync(join(home, '.aih', 'core', 'content')), false);
}));

test('Cargo required absence survives its authorized config directory creation', () => withPath(async () => {
  fixtureTool('cargo'); fixtureTool('git');
  const prepared = await prepare(request(source('cargo-absent-parent.pem'), ['cargo']), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const applied = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(applied.operations.find(item => item.id === 'trust/cargo-config').application, 'applied', JSON.stringify(applied));
  assert.equal(applied.completion, 'incomplete');
  assert.equal(existsSync(join(home, '.cargo', 'config')), false);
  assert.match(readFileSync(join(home, '.cargo', 'config.toml'), 'utf8'), /cainfo/);
}));

test('a substitute executable never yields verified success', () => withPath(async () => {
  fixtureTool('git');
  const prepared = await prepare(request(source('substitute.pem'), ['git'], 'declared'), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  const operation = result.operations.find(item => item.id === 'trust/git-config');
  assert.equal(operation.application, 'applied');
  assert.notEqual(operation.verification.status, 'passed');
  assert.equal(result.completion, 'incomplete');
}));

test('all selected config rewrites finish, retain private neighbors and repeat idempotently', () => withPath(async () => {
  const targets = ['pip', 'git', 'cargo', 'conda'];
  for (const id of targets) fixtureTool(id);
  const secret = 'private-credential-sentinel';
  const initial = { 'pip-config': '[global]\ntimeout=15\n',
    'git-config': `[credential]\n\thelper = ${secret}\n`,
    'cargo-config': '[net]\nretry = 0\n', 'conda-config': 'channels:\n  - defaults\n' };
  const files = variantFor(targets).configFiles.map(file => ({ id: file.operationId,
    path: configPath(targets, file.operationId) }));
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, initial[file.id]);
  }
  const input = request(source('all-configs.pem'), targets);
  const preview = await prepare(input, { logging: 'off' });
  assert.equal(preview.status, 'partial');
  const resolutions = files.map(file => ({ selectionId: 'trust', operationId: file.id,
    choice: 'replace', observedSha256: sha256(readFileSync(file.path)) }));
  const prepared = await prepare({ ...input, resolutions }, { logging: 'on' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal(JSON.stringify(prepared).includes(secret), false);
  assert.equal(prepared.record.status, 'written');
  assert.equal(readFileSync(join(home, '.aih', 'core', prepared.record.reference), 'utf8').includes(secret), false);
  const applied = await apply(prepared.prepared, authorize(prepared), { logging: 'on' });
  assert.equal(applied.completion, 'incomplete', JSON.stringify(applied.diagnostics));
  for (const file of files) {
    assert.equal(applied.operations.find(item => item.id === `trust/${file.id}`).application, 'applied', file.id);
    assert.equal(applied.operations.find(item => item.id === `trust/${file.id}`).verification.reason, 'offline');
  }
  assert.ok(readFileSync(join(home, '.gitconfig'), 'utf8').includes(secret));
  assert.equal(JSON.stringify(applied).includes(secret), false);
  assert.equal(applied.record.status, 'written');
  assert.equal(readFileSync(join(home, '.aih', 'core', applied.record.reference), 'utf8').includes(secret), false);
  const after = files.map(file => readFileSync(file.path));
  const repeated = await prepare(input, { logging: 'off' });
  assert.equal(repeated.status, 'ready', JSON.stringify(repeated.diagnostics));
  const reapplied = await apply(repeated.prepared, authorize(repeated), { logging: 'off' });
  assert.equal(reapplied.completion, 'incomplete');
  for (let i = 0; i < files.length; i++) assert.deepEqual(readFileSync(files[i].path), after[i]);
}));

test('changed or new user configuration after review rejects before any effect', () => withPath(async () => {
  fixtureTool('pip');
  const config = pipConfig();
  const prepared = await prepare(request(source('stale-config.pem'), ['pip']), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  mkdirSync(join(config, '..'), { recursive: true });
  writeFileSync(config, '[global]\nindex-url=https://late.example/simple\n');
  const created = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(created.completion, 'rejected');
  assert.equal(created.diagnostics[0].code, 'REVIEW_STALE');
  const second = await prepare(request(source('stale-config.pem'), ['pip']), { logging: 'off' });
  assert.equal(second.status, 'partial');
  assert.ok(second.diagnostics.some(item => item.code === 'STATE_CONFLICT'));
  writeFileSync(config, '[global]\nindex-url=https://edited.example/simple\n');
  const changed = await apply(second.prepared, authorize(second), { logging: 'off' });
  assert.equal(changed.completion, 'rejected');
  assert.equal(changed.diagnostics[0].code, 'REVIEW_STALE');
  assert.equal(readFileSync(config, 'utf8'), '[global]\nindex-url=https://edited.example/simple\n');
  rmSync(config);
}));

test('changed supplied CA or reviewed executable rejects before any effect', () => withPath(async () => {
  fixtureTool('pip');
  const file = source('stale-source.pem');
  const prepared = await prepare(request(file, ['pip'], 'declared'), { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  writeFileSync(file, Buffer.concat([root, Buffer.from(' ')]));
  const changed = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
  assert.equal(changed.completion, 'rejected');
  assert.equal(changed.diagnostics[0].code, 'REVIEW_STALE');
  const again = await prepare(request(source('stale-executable.pem'), ['pip'], 'declared'), { logging: 'off' });
  assert.equal(again.status, 'ready', JSON.stringify(again.diagnostics));
  const fixture = join(bin, process.platform === 'win32' ? 'pip.exe' : 'pip');
  rmSync(fixture, { force: true });
  writeFileSync(fixture, process.platform === 'win32' ? 'not an executable image' : '#!/bin/sh\nexit 1\n',
    process.platform === 'win32' ? {} : { mode: 0o755 });
  const swapped = await apply(again.prepared, authorize(again), { logging: 'off' });
  assert.equal(swapped.completion, 'rejected');
  assert.equal(swapped.diagnostics[0].code, 'REVIEW_STALE');
  rmSync(fixture, { force: true });
  fixtureTool('pip');
  assert.equal(existsSync(pipConfig()), false);
}));

test('mixed CA input rejects the whole import without effects through user-tools-ca', () => {
  const scoped = join(scratch, 'mixed-home'); mkdirSync(scoped);
  const scopedHome = process.env.HOME; const scopedProfile = process.env.USERPROFILE; const scopedAppData = process.env.APPDATA;
  process.env.HOME = scoped; process.env.USERPROFILE = scoped;
  if (process.platform === 'win32') process.env.APPDATA = join(scoped, 'AppData', 'Roaming');
  const file = join(scratch, 'mixed.pem');
  writeFileSync(file, Buffer.concat([root, Buffer.from('-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----')]));
  return withPath(async () => {
    fixtureTool('pip');
    try {
      const prepared = await prepare(request(file, ['pip']), { logging: 'off' });
      assert.equal(prepared.status, 'invalid');
      assert.equal(prepared.prepared, undefined);
      assert.ok(prepared.diagnostics.some(item => item.reason === 'block-label'));
      assert.equal(JSON.stringify(prepared).includes('YWJj'), false);
      const pipIni = join(scoped, ...variantFor(['pip']).configFiles.find(item => item.operationId === 'pip-config')
        .target.segments.map(slot => slot.literal));
      assert.equal(existsSync(pipIni), false);
      assert.equal(existsSync(join(scoped, '.aih')), false);
    } finally {
      process.env.HOME = scopedHome; process.env.USERPROFILE = scopedProfile;
      if (scopedAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = scopedAppData;
    }
  });
});

test('CLI previews and applies user-tools-ca with a temp home and fixture PATH', () => {
  const cliHome = join(scratch, 'cli-home'); mkdirSync(cliHome);
  const file = join(scratch, 'cli-ca.pem'); writeFileSync(file, root);
  const inputs = join(scratch, 'cli-inputs.json');
  writeFileSync(inputs, JSON.stringify({ 'user-tools-ca': { caFile: file } }));
  const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
  const env = { ...process.env, HOME: cliHome, USERPROFILE: cliHome, PATH: bin };
  if (process.platform === 'win32') env.APPDATA = join(cliHome, 'AppData', 'Roaming');
  for (const key of envOverrides) delete env[key];
  fixtureTool('git');
  const run = flags => spawnSync(process.execPath, [cli, 'repair', 'user-tools-ca', '--target', 'git',
    '--inputs-file', inputs, '--offline', '--json', ...flags], { encoding: 'utf8', timeout: 30_000, env });
  const denied = run(['--target', 'node']);
  assert.equal(denied.status, 2);
  const preview = run([]);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(JSON.parse(preview.stdout).status, 'ready');
  assert.equal(existsSync(join(cliHome, '.gitconfig')), false);
  assert.equal(run(['--apply']).status, 2);
  const applied = run(['--apply', '--yes']);
  assert.equal(applied.status, 1, applied.stdout + applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.completion, 'incomplete');
  assert.equal(result.operations.find(item => item.id === 'trust/git-config').application, 'applied');
  assert.match(readFileSync(join(cliHome, '.gitconfig'), 'utf8'), /sslCAInfo/);
  assert.ok(result.diagnostics.some(item => item.code === 'VERIFICATION_UNAVAILABLE' && item.reason === 'offline'));
});
