// Closure wheels with a recorded source build (decision C78), through the built public entries in a disposable home and
// project. The branch logic runs on `fake-python.cjs` (a Core-side PROCESS FIXTURE: it proves no real interpreter);
// the last test builds a tiny pure-Python sdist for real with this host's Python, offline, with its pinned build backend
// supplied as an exact wheel. Producer documents and artifacts are Core-side fixtures (acquire-fixture.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, list, prepare } from '../dist/core/index.js';
import { validateFormat } from '../dist/core/contracts.js';
import { indexBases } from '../dist/core/plan/acquire/sources.js';
import { artifactServer, fakeEnvironment, fakeInterpreterBase, fakePython, fallbackArchive, nativeSetup, pypiIndex, pythonSetup, setupRequest, suppliedFolder,
  withBuild, withoutUrls } from './fixtures/acquire-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-acquire-build-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };
const defaults = { ...indexBases };
let home; let server; let base; let fallbackBytes;
const bin = join(scratch, 'bin');
before(async () => {
  home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home;
  Object.assign(process.env, fakeEnvironment(bin));
  server = await artifactServer();
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), server.caPem]);
  indexBases.pypi = `${server.base}/pypi-index`; indexBases.pypiFiles = server.base; indexBases.pythonBuildStandalone = `${server.base}/pbs`;
  base = fakeInterpreterBase(join(scratch, 'base'));
  fallbackBytes = fallbackArchive(base, { version: '3.14.5' });
});
after(async () => {
  Object.assign(indexBases, defaults);
  await server?.close();
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
let counter = 0;
const project = () => { const path = join(scratch, `project-${counter++}`); mkdirSync(path); return path; };
const folder = () => { const path = join(scratch, `supplied-${counter++}`); mkdirSync(path); return path; };
const installedPython = facts => { rmSync(bin, { recursive: true, force: true }); return fakePython(base, bin, facts); };
const byId = (run, id) => run.steps.find(step => step.managementId === id);
const entryOf = async (target, id) => (await list({ target: { project: target }, scope: 'user' })).entries.find(row => row.managementId === id);
/** A Python setup with one source-built closure wheel whose prebuilt bytes no source has; dependencies come from the index. */
function buildSetup(name, options = {}) {
  const setup = withBuild(server, pythonSetup(server, { name, fallbackBytes, ...(options.setup ?? {}) }), options.build ?? {});
  pypiIndex(server, `${server.base}/pypi-index`, setup, {}, options.indexDigest ? [] : [setup.build.file],
    setup.build.dependencies.map(dependency => ({ ...dependency, bytes: setup.files[dependency.file] })),
    options.indexDigest ? { [setup.build.file]: options.indexDigest } : {});
  return setup;
}

test('a wheel with no obtainable qualified bytes is built offline from its pinned source and recorded as built, not byte-qualified', async () => {
  installedPython({ version: '3.13.1' });
  const target = project();
  const setup = buildSetup('b-built');
  const prepared = await prepare(setupRequest(target, [setup]));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  const shown = prepared.review.steps[0].acquire.downloads.find(entry => entry.file === setup.build.file);
  assert.deepEqual(shown.build.source, { role: 'build-source', file: setup.build.sourceFile, sha256: setup.qualification.observed.closure.at(-1).build.source.sha256,
    source: { kind: 'url', url: server.url(`/build/${setup.build.sourceFile}`) } });
  assert.deepEqual(shown.build.dependencies.map(entry => [entry.name, entry.version, entry.source.kind]), [['backend', '1.0', 'index']]);
  assert.deepEqual(prepared.review.steps[0].interpreter.switchesOn, ['outside-range', 'wheel-install-failed', 'readback-failed', 'build-failed']);
  assert.match(prepared.review.steps[0].sentence, /\(one wheel may be built from pinned source\)$/);
  assert.match(prepared.review.steps[0].cantPromise, /One closure wheel may be built here from pinned source .*; a built wheel is never byte-qualified\.$/);

  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(byId(run, setup.id).interpreter.branch, 'installed');
  const tool = join(home, ...setup.folder.split('/'));
  assert.deepEqual(JSON.parse(readFileSync(join(tool, 'env', 'fake-site.json'), 'utf8')).yamlish, '6.0.3');
  assert.equal(existsSync(join(tool, 'build')), false, 'the build folder is removed after the install');
  const recorded = conforms(await list({ target: { project: target }, scope: 'user' })).entries.find(row => row.managementId === setup.id).aiSetup.downloads;
  const built = recorded.find(entry => entry.file === setup.build.file);
  assert.deepEqual([built.origin, built.sha256, built.built.byteQualified, built.built.file], ['built', setup.qualification.observed.closure.at(-1).sha256, false,
    'yamlish-6.0.3-py3-none-any.whl']);
  assert.notEqual(built.built.sha256, built.sha256, 'the built wheel never stands in for the qualified bytes');
  assert.deepEqual([built.built.source, built.built.dependencies], [setup.qualification.observed.closure.at(-1).build.source.sha256, [setup.build.dependencies[0].sha256]]);
  assert.ok(recorded.some(entry => entry.role === 'build-dependency' && entry.origin === 'downloaded'), JSON.stringify(recorded));
});

test('a build runs with its home and temp inside the build folder and without the host compiler or setuptools settings', async () => {
  installedPython({ version: '3.13.1' });
  const record = join(scratch, 'build-env.json');
  const host = { CC: 'host-cc', CXX: 'host-cxx', CFLAGS: '-O0', CPPFLAGS: '-I/host', LDFLAGS: '-L/host', SETUPTOOLS_USE_DISTUTILS: 'stdlib',
    DISTUTILS_DEBUG: '1', AIH_FAKE_BUILD_RECORD: record };
  const saved = Object.fromEntries(Object.keys(host).map(key => [key, process.env[key]]));
  Object.assign(process.env, host);
  try {
    const setup = buildSetup('b-env');
    const prepared = await prepare(setupRequest(project(), [setup]));
    assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
    const seen = JSON.parse(readFileSync(record, 'utf8'));
    const lower = Object.fromEntries(Object.entries(seen).map(([key, value]) => [key.toUpperCase(), value]));
    const work = join(home, ...setup.folder.split('/'), 'build');
    for (const key of ['HOME', 'USERPROFILE', 'TMP', 'TEMP', ...(process.platform === 'win32' ? ['APPDATA'] : [])])
      assert.ok(lower[key]?.startsWith(work), `${key}=${lower[key]}`);
    assert.deepEqual(Object.keys(lower).filter(key => /^(CC|CXX|CFLAGS|CPPFLAGS|LDFLAGS|SETUPTOOLS_.*|DISTUTILS_.*)$/.test(key)), []);
  } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('qualified bytes are used when obtainable and installable; when not installable on this interpreter the wheel is built', async () => {
  installedPython({ version: '3.13.1' });
  const target = project();
  const setup = buildSetup('b-qualified', { build: { served: true } });
  const prepared = await prepare(setupRequest(target, [setup]));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const entry = (await entryOf(target, setup.id)).aiSetup.downloads.find(item => item.file === setup.build.file);
  assert.deepEqual([entry.origin, entry.url], ['downloaded', server.url(`/${setup.build.file}`)]);

  installedPython({ version: '3.13.1', incompatible: ['yamlish'] });
  const other = project();
  const again = buildSetup('b-incompatible', { build: { served: true } });
  const second = await prepare(setupRequest(other, [again]));
  const built = await apply(second.handle, approve(second.review));
  assert.equal(built.completion, 'complete', JSON.stringify(built));
  assert.equal((await entryOf(other, again.id)).aiSetup.downloads.find(item => item.file === again.build.file).origin, 'built');
});

test('a build that fails on the installed interpreter switches to the reviewed fallback, which builds again', async () => {
  installedPython({ version: '3.13.1', failBuild: true });
  const target = project();
  const setup = buildSetup('b-fallback');
  const prepared = await prepare(setupRequest(target, [setup]));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual([byId(run, setup.id).interpreter.branch, byId(run, setup.id).interpreter.fallbackReason], ['fallback', 'build-failed']);
  assert.equal((await entryOf(target, setup.id)).aiSetup.downloads.find(item => item.file === setup.build.file).origin, 'built');

  // The fallback's own build failing fails the step.
  installedPython({ version: '3.13.1', failBuild: true });
  const broken = buildSetup('b-broken', { setup: { fallbackBytes: fallbackArchive(base, { version: '3.14.5', failBuild: true }) } });
  const second = await prepare(setupRequest(project(), [broken]));
  const failed = await apply(second.handle, approve(second.review));
  assert.deepEqual([byId(failed, broken.id).application, byId(failed, broken.id).reason], ['failed', 'build-failed']);
});

test('an index entry for the qualified wheel with another sha256 is a mismatch, never a reason to build', async () => {
  installedPython({ version: '3.13.1' });
  const target = project();
  const setup = buildSetup('b-index-other', { indexDigest: 'f'.repeat(64) });
  const prepared = await prepare(setupRequest(target, [setup]));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.deepEqual([byId(run, setup.id).application, byId(run, setup.id).reason], ['failed', 'artifact-mismatch'], JSON.stringify(run));
  assert.equal(existsSync(join(home, ...setup.folder.split('/'))), false, 'nothing was built or kept');
});

test('a changed source or dependency hash fails closed; a missing host build tool is a build failure, its hash only recorded', async () => {
  installedPython({ version: '3.13.1' });
  const source = buildSetup('b-source');
  server.serve(`/build/${source.build.sourceFile}`, Buffer.from('tampered sdist\n'));
  const one = await prepare(setupRequest(project(), [source]));
  const sourceRun = await apply(one.handle, approve(one.review));
  assert.deepEqual([byId(sourceRun, source.id).application, byId(sourceRun, source.id).reason], ['failed', 'artifact-mismatch']);

  const dependency = buildSetup('b-dependency');
  const supplied = suppliedFolder(folder(), { [dependency.build.dependencies[0].file]: Buffer.from('tampered wheel\n') });
  const two = await prepare(setupRequest(project(), [dependency]), { artifacts: supplied });
  assert.equal(two.review.steps[0].acquire.downloads.find(entry => entry.build).build.dependencies[0].source.kind, 'supplied');
  const dependencyRun = await apply(two.handle, approve(two.review));
  assert.deepEqual([byId(dependencyRun, dependency.id).application, byId(dependencyRun, dependency.id).reason], ['failed', 'artifact-mismatch']);

  const tooled = buildSetup('b-tool', { build: { tools: [{ name: 'aih-no-such-compiler', version: 'fixture 1.0', sha256: 'a'.repeat(64) }] } });
  const three = await prepare(setupRequest(project(), [tooled]));
  assert.deepEqual(three.review.steps[0].acquire.downloads.find(entry => entry.build).build.tools, [{ name: 'aih-no-such-compiler', version: 'fixture 1.0', sha256: 'a'.repeat(64) }]);
  const toolRun = await apply(three.handle, approve(three.review));
  assert.deepEqual([byId(toolRun, tooled.id).application, byId(toolRun, tooled.id).reason], ['failed', 'build-failed']);

  // A present tool with other bytes than the qualification observed is used, and both identities are recorded.
  const target = project();
  const node = process.platform === 'win32' ? 'node' : 'node';
  const present = buildSetup('b-tool-present', { build: { tools: [{ name: node, version: 'qualified node', sha256: 'b'.repeat(64) }] } });
  const four = await prepare(setupRequest(target, [present]));
  const presentRun = await apply(four.handle, approve(four.review));
  assert.equal(presentRun.completion, 'complete', JSON.stringify(presentRun));
  const [tool] = (await entryOf(target, present.id)).aiSetup.downloads.find(item => item.origin === 'built').built.tools;
  assert.deepEqual(tool.qualified, { version: 'qualified node', sha256: 'b'.repeat(64) });
  assert.match(tool.observed.version, /^v\d+\./);
  assert.match(tool.observed.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(tool.observed.sha256, 'b'.repeat(64));
});

test('a first acquisition whose build fails on both branches leaves no folders behind; the two unrelated acquisitions install', async () => {
  // A fresh home: no `.aihq` exists yet, so the failed acquisition is the one that would create it.
  const fresh = join(scratch, `home-fresh-${counter++}`); mkdirSync(fresh);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = fresh; process.env.USERPROFILE = fresh;
  try {
    installedPython({ version: '3.13.1', failBuild: true });
    const failing = buildSetup('t-graph', { setup: { fallbackBytes: fallbackArchive(base, { version: '3.14.5', failBuild: true }),
      fallbackFile: 'cpython-3.14.5+broken-install_only.tar.gz' } });
    const native = nativeSetup(server, { name: 't-memory' });
    const plain = pythonSetup(server, { name: 't-serena', fallbackBytes, id: 'serena.ai-setup.t-serena' });
    const target = project();
    const prepared = await prepare(setupRequest(target, [failing, native, plain]));
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    const run = conforms(await apply(prepared.handle, approve(prepared.review)));
    assert.equal(run.completion, 'incomplete', JSON.stringify(run));
    assert.equal(run.code, undefined, JSON.stringify(run));
    assert.deepEqual([byId(run, failing.id).application, byId(run, failing.id).reason], ['failed', 'build-failed']);
    assert.equal(byId(run, native.id).application, 'applied', JSON.stringify(run));
    assert.equal(byId(run, plain.id).application, 'applied', JSON.stringify(run));
    assert.equal(existsSync(join(fresh, '.aihq', 'ai-setup', 't-graph')), false, 'the failed acquisition leaves no empty parent folders');
    assert.ok(existsSync(join(fresh, ...native.folder.split('/'), 'memory-mcp')));
    assert.ok(existsSync(join(fresh, ...plain.folder.split('/'), 'env')));
    const listed = conforms(await list({ target: { project: target }, scope: 'user' })).entries;
    const row = id => listed.find(entry => entry.managementId === id);
    assert.deepEqual([row(failing.id).installState, row(failing.id).lastRun], ['interrupted', { runId: run.runId, outcome: 'failed', reason: 'build-failed' }]);
    for (const id of [native.id, plain.id]) assert.deepEqual([row(id).installState, row(id).lastRun], ['complete', undefined]);
  } finally { Object.assign(process.env, saved); }
});

test('a C compiler named in the build record is the one the build uses: CC, CXX beside it and LDSHARED on Linux, recorded with the built wheel', async () => {
  installedPython({ version: '3.13.1' });
  // Fixture compilers on PATH: copies of this Node executable named like a compiler (they only answer `--version`).
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['gcc', 'g++']) copyFileSync(process.execPath, join(bin, `${name}${exe}`));
  const record = join(scratch, 'build-compiler.json');
  const saved = { CC: process.env.CC, AIH_FAKE_BUILD_RECORD: process.env.AIH_FAKE_BUILD_RECORD };
  Object.assign(process.env, { CC: 'host-clang', AIH_FAKE_BUILD_RECORD: record });
  try {
    const target = project();
    const setup = buildSetup('b-compiler', { build: { tools: [{ name: 'gcc', version: 'gcc (fixture) 13.3.0', sha256: 'c'.repeat(64) },
      { name: 'ld', version: 'GNU ld (fixture) 2.42', sha256: 'd'.repeat(64) }] } });
    // `ld` is only recorded: it stands for a tool present on the qualifying host, here the fixture Node copy.
    copyFileSync(process.execPath, join(bin, `ld${exe}`));
    const prepared = await prepare(setupRequest(target, [setup]));
    const run = await apply(prepared.handle, approve(prepared.review));
    assert.equal(run.completion, 'complete', JSON.stringify(run));
    const seen = Object.fromEntries(Object.entries(JSON.parse(readFileSync(record, 'utf8'))).map(([key, value]) => [key.toUpperCase(), value]));
    const gcc = join(bin, `gcc${exe}`), gxx = join(bin, `g++${exe}`);
    const expected = { CC: gcc, CXX: gxx, ...(process.platform === 'linux' ? { LDSHARED: `${gcc} -shared` } : {}) };
    assert.deepEqual(Object.fromEntries(Object.entries(seen).filter(([key]) => ['CC', 'CXX', 'LDSHARED'].includes(key))), expected);
    const built = conforms(await list({ target: { project: target }, scope: 'user' })).entries.find(row => row.managementId === setup.id)
      .aiSetup.downloads.find(entry => entry.origin === 'built').built;
    assert.deepEqual(built.env, expected);
    assert.deepEqual(built.tools.map(tool => tool.name), ['gcc', 'ld']);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('a failed build names the wheel, the phase, the branch and the end of its redacted log; no build folder is left', async () => {
  installedPython({ version: '3.13.1', failBuild: true });
  const saved = process.env.AIH_FIXTURE_TOKEN;
  process.env.AIH_FIXTURE_TOKEN = 'fixture-secret-value-0123456789';
  const events = [];
  try {
    const setup = buildSetup('b-diagnosed', { setup: { fallbackBytes: fallbackArchive(base, { version: '3.14.5', failBuild: true }),
      fallbackFile: 'cpython-3.14.5+diagnosed-install_only.tar.gz' } });
    const prepared = await prepare(setupRequest(project(), [setup]), { onProgress: event => events.push(event) });
    const run = conforms(await apply(prepared.handle, approve(prepared.review)));
    const step = byId(run, setup.id);
    assert.deepEqual([step.application, step.reason], ['failed', 'build-failed']);
    assert.deepEqual(step.buildFailures.map(failure => [failure.wheel.name, failure.wheel.version, failure.phase, failure.branch]),
      [['yamlish', '6.0.3', 'build', 'installed'], ['yamlish', '6.0.3', 'build', 'fallback']]);
    for (const failure of step.buildFailures) {
      assert.equal(failure.log.length, 40, JSON.stringify(failure.log));
      assert.equal(failure.log.at(-1), 'fixture: build failed');
      assert.ok(failure.log.some(line => line === 'fixture: token [REDACTED]'), JSON.stringify(failure.log));
      assert.ok(!JSON.stringify(failure).includes('fixture-secret-value'));
    }
    assert.ok(!JSON.stringify(events).includes('fixture-secret-value'));
    assert.equal(existsSync(join(home, ...setup.folder.split('/'))), false, 'neither the folder nor its build/ is left');
  } finally { if (saved === undefined) delete process.env.AIH_FIXTURE_TOKEN; else process.env.AIH_FIXTURE_TOKEN = saved; }
});
