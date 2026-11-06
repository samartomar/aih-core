// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// AI setup acquisition through plan requests (contract 8.1, C36, C46). Artifacts are served by a local HTTPS FIXTURE
// server whose CA is trusted only through NODE_EXTRA_CA_CERTS (the trust the `node-npm-ca` repair sets up); Python is
// the `fake-python.cjs` PROCESS FIXTURE. Nothing here is a real tool, interpreter, closure or qualification.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactServer, fakeEnvironment, fakeInterpreterBase, fakePython, fallbackArchive, nativeSetup, pypiIndex, pythonSetup, setupRequest, suppliedFolder,
  withoutUrls } from './acquire-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });

// Child mode: the public API in a process whose trust and PATH the parent chose.
if (process.argv[2] === 'child') {
  const { apply, list, prepare, prepareRemoval } = await import('@aihq/core');
  const { validateFormat } = await import('@aihq/core/contracts');
  const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
  const [, , , mode, file, project, indexBase] = process.argv;
  let out;
  if (indexBase) {
    // Core's internal index-base seam (not a public entry), pointed at the fixture server: the same module the package loads.
    const { indexBases } = await import('./node_modules/@aihq/core/dist/core/plan/acquire/sources.js');
    indexBases.pypi = `${indexBase}/pypi-index`; indexBases.pypiFiles = indexBase; indexBases.pythonBuildStandalone = `${indexBase}/pbs`;
  }
  if (mode === 'install') {
    const prepared = await prepare(JSON.parse(readFileSync(file, 'utf8')));
    if (prepared.status !== 'ready') { console.log(JSON.stringify({ prepared })); process.exit(0); }
    const run = conforms(await apply(prepared.handle, approve(conforms(prepared.review))));
    out = { review: prepared.review, run, list: conforms(await list({ target: { project }, scope: 'user' })) };
  } else {
    const removal = await prepareRemoval({ target: { project }, scope: 'user', removals: [{ managementId: file }] });
    out = { removed: await apply(removal.handle, approve(removal.review)) };
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

const certificates = JSON.parse(readFileSync(join(here, 'certificates.json'), 'utf8'));
const root = mkdtempSync(join(process.env.HOME, 'acquire-'));
const caFile = join(root, 'ca.pem'); writeFileSync(caFile, certificates.caPem);
const server = await artifactServer({}, certificates);
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };
try {
  const base = fakeInterpreterBase(join(root, 'base'));
  const fallbackBytes = fallbackArchive(base, { version: '3.14.5' });
  const project = join(root, 'project'); mkdirSync(project);
  const write = (name, request) => { const path = join(root, `${name}.json`); writeFileSync(path, JSON.stringify(request)); return path; };
  const native = nativeSetup(server, { name: 'packed-native' });
  const installedFirst = pythonSetup(server, { name: 'packed-installed', fallbackBytes });
  const fallsBack = pythonSetup(server, { name: 'packed-fallback', fallbackBytes });
  const nativeFile = write('native', setupRequest(project, [native]));
  const bins = { ok: join(root, 'bin-ok'), broken: join(root, 'bin-broken') };
  fakePython(base, bins.ok, { version: '3.13.1' });
  fakePython(base, bins.broken, { version: '3.13.1', failWheels: ['networkx'] });
  const environment = (bin, trusted) => {
    const env = { ...process.env, ...fakeEnvironment(bin) };
    if (trusted) env.NODE_EXTRA_CA_CERTS = caFile; else delete env.NODE_EXTRA_CA_CERTS;
    return env;
  };
  const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
  // Asynchronous: the fixture server in this process must keep answering while the child runs.
  const exec = (args, env) => new Promise((resolve, reject) => {
    const spawned = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    spawned.stdout.on('data', chunk => { stdout += chunk; }); spawned.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => spawned.kill(), 600_000);
    spawned.once('error', reject);
    spawned.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  const aih = async (args, env) => {
    const result = await exec([cli, ...args], env);
    return { code: result.status, result: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
  };
  const child = async (args, env) => {
    const result = await exec([fileURLToPath(import.meta.url), 'child', ...args], env);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };

  await check('untrusted-tls-refused-at-prepare', async () => {
    const { code, result } = await aih(['install', nativeFile, '--apply', '--yes', '--json'], environment(bins.ok, false));
    assert.deepEqual([code, result.status, result.code, result.repair], [2, 'refused', 'tls-untrusted', 'node-npm-ca'], JSON.stringify(result));
    assert.equal(existsSync(join(process.env.HOME, '.aihq')), false);
  });
  await check('cli-installs-native-archive-with-repaired-trust', async () => {
    const { code, result } = await aih(['install', nativeFile, '--apply', '--yes', '--json'], environment(bins.ok, true));
    assert.deepEqual([code, result.completion], [0, 'complete'], JSON.stringify(result));
    assert.equal(readFileSync(join(process.env.HOME, ...native.folder.split('/'), 'LICENSE'), 'utf8'), 'MIT\n');
  });
  await check('installed-interpreter-first', async () => {
    const out = await child(['install', write('installed', setupRequest(project, [installedFirst])), project], environment(bins.ok, true));
    assert.equal(out.review.steps[0].interpreter.installed.version, '3.13.1', JSON.stringify(out));
    assert.equal(out.review.steps[0].interpreter.fallback.version, '3.14.5');
    assert.deepEqual([out.run.completion, out.run.steps[0].interpreter.branch, out.run.steps[0].interpreter.fallback], ['complete', 'installed', false]);
    const entry = out.list.entries.find(row => row.managementId === installedFirst.id);
    assert.deepEqual([entry.aiSetup.branch, entry.aiSetup.fallback], ['installed', false]);
    assert.equal(existsSync(join(process.env.HOME, ...installedFirst.folder.split('/'), 'interpreter')), false);
  });
  await check('forced-failure-uses-reviewed-fallback', async () => {
    const out = await child(['install', write('fallback', setupRequest(project, [fallsBack])), project], environment(bins.broken, true));
    assert.deepEqual([out.run.completion, out.run.steps[0].interpreter.branch, out.run.steps[0].interpreter.fallbackReason],
      ['complete', 'fallback', 'wheel-install-failed'], JSON.stringify(out));
    const entry = out.list.entries.find(row => row.managementId === fallsBack.id);
    assert.deepEqual([entry.aiSetup.branch, entry.aiSetup.fallback, entry.aiSetup.interpreter.version], ['fallback', true, '3.14.5']);
  });
  await check('cli-installs-from-supplied-artifacts', async () => {
    const supplied = withoutUrls(nativeSetup(server, { name: 'packed-supplied' }));
    const folder = suppliedFolder(mkdtempSync(join(root, 'artifacts-')), { [supplied.step.distribution.file]: supplied.archive });
    const file = write('supplied', setupRequest(project, [supplied]));
    const reviewed = await aih(['install', file, '--artifacts', folder, '--json'], environment(bins.ok, false));
    assert.deepEqual(reviewed.result.review.steps[0].acquire.downloads[0].source, { kind: 'supplied', folder }, JSON.stringify(reviewed.result));
    const { code, result } = await aih(['install', file, '--artifacts', folder, '--apply', '--yes', '--json'], environment(bins.ok, false));
    assert.deepEqual([code, result.completion], [0, 'complete'], JSON.stringify(result));
    assert.equal(readFileSync(join(process.env.HOME, ...supplied.folder.split('/'), 'LICENSE'), 'utf8'), 'MIT\n');
    const missing = await aih(['install', write('unsupplied', setupRequest(project, [withoutUrls(nativeSetup(server, { name: 'packed-unsupplied' }))])), '--apply', '--yes', '--json'],
      environment(bins.ok, false));
    assert.deepEqual([missing.result.completion, missing.result.steps[0].reason], ['incomplete', 'artifact-unavailable'], JSON.stringify(missing.result));
  });
  await check('index-resolution-without-urls', async () => {
    const indexed = withoutUrls(pythonSetup(server, { name: 'packed-indexed', fallbackBytes, fallbackFile: 'cpython-3.14.5+20261026-fixture-install_only.tar.gz' }));
    pypiIndex(server, `${server.base}/pypi-index`, indexed);
    server.serve(`/pbs/20261026/${encodeURIComponent(indexed.step.interpreter.fallback.file)}`, fallbackBytes);
    const out = await child(['install', write('indexed', setupRequest(project, [indexed])), project, server.base], environment(bins.broken, true));
    assert.deepEqual([out.run.completion, out.run.steps[0].interpreter.branch], ['complete', 'fallback'], JSON.stringify(out));
    const entry = out.list.entries.find(row => row.managementId === indexed.id);
    assert.ok(entry.aiSetup.downloads.every(record => record.origin === 'downloaded' && record.url.startsWith(server.base)), JSON.stringify(entry.aiSetup));
  });
  await check('removal-removes-ai-setup-folder', async () => {
    const folder = join(process.env.HOME, ...fallsBack.folder.split('/'));
    assert.ok(existsSync(folder));
    const out = await child(['remove', fallsBack.id, project], environment(bins.ok, true));
    assert.equal(out.removed.completion, 'complete', JSON.stringify(out));
    assert.equal(existsSync(folder), false);
    assert.ok(existsSync(join(process.env.HOME, ...installedFirst.folder.split('/'))), 'other AI setups stay');
  });
} finally { await server.close(); }
console.log(JSON.stringify({ status: 'passed', checks }));
