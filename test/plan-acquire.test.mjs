// `acquire` steps (contract 4.1, 7, 8.1, C36, C46, C60) through the built public entries, in a disposable home and
// project. Artifacts come from a local HTTPS fixture server; Python is the `fake-python.cjs` process fixture. These are
// Core-side fixtures (test/fixtures/acquire-fixture.mjs): they prove no real tool, interpreter or qualification.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, list, prepare, prepareRemoval } from '../dist/core/index.js';
import { refusalCodes, validateFormat } from '../dist/core/contracts.js';
import { artifactServer, documentSha, fakeEnvironment, fakeInterpreterBase, fakePython, fallbackArchive, nativeSetup, pythonSetup,
  setupRequest } from './fixtures/acquire-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-acquire-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };
let home; let server; let base; let fallbackBytes;
const bin = join(scratch, 'bin');
before(async () => {
  home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home;
  Object.assign(process.env, fakeEnvironment(bin));
  server = await artifactServer();
  // The repaired machine trust: this process trusts the fixture server's CA.
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), server.caPem]);
  base = fakeInterpreterBase(join(scratch, 'base'));
  fallbackBytes = fallbackArchive(base, { version: '3.14.5' });
});
after(async () => {
  await server?.close();
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
let counter = 0;
const project = () => { const path = join(scratch, `project-${counter++}`); mkdirSync(path); return path; };
const installedPython = facts => { rmSync(bin, { recursive: true, force: true }); return fakePython(base, bin, facts); };
const noPython = () => rmSync(bin, { recursive: true, force: true });

test('a missing or disagreeing qualification refuses Prepare before any effect', async () => {
  noPython();
  const target = project();
  const native = nativeSetup(server, { name: 'q-native' });
  const python = pythonSetup(server, { name: 'q-python', fallbackBytes });
  const refused = async (setup, change, code) => {
    const copy = structuredClone({ step: setup.step, qualification: setup.qualification });
    change(copy);
    const request = setupRequest(target, [{ ...setup, ...copy }]);
    const result = await prepare(request);
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.equal(result.code, code, JSON.stringify(result));
    assert.equal(existsSync(join(home, '.aihq')), false, 'nothing is written');
    return result;
  };
  const missing = await refused(native, value => { value.qualification = { ...value.qualification, result: { ...value.qualification.result, date: '2026-11-04' } }; },
    'qualification-missing');
  assert.equal(missing.step, 0);
  const resign = value => { value.step.qualification = `sha256:${documentSha(value.qualification)}`; };
  await refused(native, value => { value.qualification.observed.artifact.sha256 = 'f'.repeat(64); resign(value); }, 'qualification-mismatch');
  await refused(native, value => { value.step.distribution.members = value.qualification.observed.members.map(member => ({ ...member, sha256: 'e'.repeat(64) })); }, 'qualification-mismatch');
  await refused(native, value => { value.qualification.subject.cell = 'linux-riscv64'; resign(value); }, 'qualification-mismatch');
  await refused(native, value => { value.qualification.result.status = 'blocked'; resign(value); }, 'qualification-mismatch');
  await refused(python, value => { value.qualification.observed.closure[0].sha256 = 'd'.repeat(64); resign(value); }, 'qualification-mismatch');
  await refused(python, value => { value.qualification.observed.interpreter.sha256 = 'c'.repeat(64); resign(value); }, 'qualification-mismatch');
  // A step for another platform cell, qualified for that cell, is refused here before effects.
  const other = await refused(native, value => { value.step.cell = 'linux-riscv64'; value.step.into = value.step.into.replace(/[^/]+\/$/, 'linux-riscv64/');
    value.qualification.subject.cell = 'linux-riscv64'; resign(value); }, 'cell-mismatch');
  assert.match(other.reason, /linux-riscv64/);
  // A distribution with neither a file name nor a URL names nothing to acquire: invalid, never guessed.
  const nameless = structuredClone(native.step); delete nameless.distribution.url; delete nameless.distribution.file;
  const invalid = await prepare(setupRequest(target, [{ ...native, step: nameless }]));
  assert.equal(invalid.status, 'invalid', JSON.stringify(invalid));
});

test('a native archive installs its qualified members, lists, and is removed with its folder', async () => {
  noPython();
  const target = project();
  const native = nativeSetup(server, { name: 'n-ok' });
  const events = [];
  const prepared = await prepare(setupRequest(target, [native]), { onProgress: event => events.push(event) });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const step = prepared.review.steps[0];
  assert.equal(step.op, 'acquire');
  assert.equal(step.managementId, native.id);
  assert.match(step.sentence, /^Downloads `n-ok-linux-portable\.tar\.gz` and extracts its 2 qualified members into `~\/\.aihq\/ai-setup\/n-ok\/0\.12\.1\//);
  assert.deepEqual([step.acquire.kind, step.acquire.qualification, step.acquire.members], ['native-archive', native.step.qualification, 2]);
  assert.equal(step.interpreter, undefined);

  const run = await apply(prepared.handle, approve(prepared.review), { onProgress: event => events.push(event) });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const folder = join(home, ...native.folder.split('/'));
  assert.equal(readFileSync(join(folder, 'memory-mcp'), 'utf8'), native.members['memory-mcp']);
  assert.equal(readFileSync(join(folder, 'LICENSE'), 'utf8'), 'MIT\n');
  assert.equal(existsSync(join(folder, 'unlisted.txt')), false, 'only qualified members are extracted');
  assert.equal(existsSync(join(folder, '.aih-acquiring')), false);
  if (process.platform !== 'win32') assert.equal(statSync(join(folder, 'memory-mcp')).mode & 0o111, 0o111);
  assert.ok(events.some(event => event.op === 'acquire' && event.phase === 'bytes' && event.bytes > 0), JSON.stringify(events));

  const listed = await list({ target: { project: target }, scope: 'both' });
  const entry = listed.entries.find(row => row.managementId === native.id);
  assert.ok(entry, JSON.stringify(listed));
  assert.deepEqual([entry.scope, entry.items, entry.aiSetup], ['user', [native.id], { branch: null, interpreter: null, fallback: false, fallbackReason: null,
    downloads: [{ role: 'artifact', file: native.step.distribution.file, sha256: native.step.distribution.sha256, origin: 'downloaded', url: native.step.distribution.url }] }]);

  const again = await prepare(setupRequest(target, [native]));
  assert.equal(again.review.steps[0].effect, 'already-satisfied', 'an installed setup is already in place');

  const removal = await prepareRemoval({ target: { project: target }, scope: 'user', removals: [{ managementId: native.id }] });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  const removed = await apply(removal.handle, approve(removal.review));
  assert.equal(removed.completion, 'complete', JSON.stringify(removed));
  assert.equal(existsSync(folder), false, 'the acquired folder goes with its last claim');
  assert.equal(existsSync(join(home, '.aihq', 'ai-setup', 'n-ok')), false);
});

test('acquired bytes that differ fail that AI setup and its dependants; an unrelated item is applied and the run is incomplete', async () => {
  noPython();
  const target = project();
  const native = nativeSetup(server, { name: 'n-bad' });
  const request = setupRequest(target, [native], [{ name: 'uses-tool', text: 'Uses the tool.\n', dependencies: [native.id] }, { name: 'unrelated', text: 'Unrelated.\n' }]);
  const prepared = await prepare(request);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  server.serve(`/${native.step.distribution.file}`, Buffer.concat([native.archive.subarray(0, -1), Buffer.from([native.archive.at(-1) ^ 1])]));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.equal(run.completion, 'incomplete', JSON.stringify(run));
  const by = id => run.steps.find(step => step.managementId === id);
  assert.deepEqual([by(native.id).application, by(native.id).reason], ['failed', 'artifact-mismatch']);
  assert.equal(by('local-my-skills.skill.uses-tool').application, 'not-attempted');
  assert.equal(by('local-my-skills.skill.unrelated').application, 'applied');
  assert.equal(readFileSync(join(target, '.claude/skills/unrelated/SKILL.md'), 'utf8'), 'Unrelated.\n');
  assert.equal(existsSync(join(target, '.claude/skills/uses-tool/SKILL.md')), false);
  assert.equal(existsSync(join(home, ...native.folder.split('/'))), false, 'a failed acquisition leaves no folder');
  server.serve(`/${native.step.distribution.file}`, native.archive);
});

test('a Python tool uses the installed interpreter in range first; the review shows both branches and the receipt says which ran', async () => {
  const installed = installedPython({ version: '3.13.1' });
  const target = project();
  const python = pythonSetup(server, { name: 'p-installed', fallbackBytes });
  const prepared = await prepare(setupRequest(target, [python]));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const { interpreter } = prepared.review.steps[0];
  assert.equal(interpreter.installed.version, '3.13.1');
  assert.equal(interpreter.installed.note, 'in range, not qualified');
  assert.equal(interpreter.installed.path.toLowerCase(), installed.toLowerCase());
  assert.deepEqual(interpreter.fallback, { version: '3.14.5', file: 'cpython-3.14.5-install_only.tar.gz', sha256: python.qualification.observed.interpreter.sha256 });
  assert.deepEqual(interpreter.switchesOn, ['outside-range', 'wheel-install-failed', 'readback-failed']);
  assert.match(prepared.review.steps[0].cantPromise, /never byte-qualified/);

  const run = await apply(prepared.handle, approve(prepared.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual([run.steps[0].interpreter.branch, run.steps[0].interpreter.fallback, run.steps[0].interpreter.version], ['installed', false, '3.13.1']);
  const folder = join(home, ...python.folder.split('/'));
  assert.deepEqual(JSON.parse(readFileSync(join(folder, 'env', 'fake-site.json'), 'utf8')), { networkx: '3.4.2', 'p_installed': '2.3.9' });
  assert.equal(existsSync(join(folder, 'interpreter')), false, 'no second interpreter is downloaded');
  const listed = await list({ target: { project: target }, scope: 'user' });
  const entry = listed.entries.find(row => row.managementId === python.id);
  assert.deepEqual([entry.aiSetup.branch, entry.aiSetup.fallback, entry.aiSetup.interpreter.version], ['installed', false, '3.13.1']);
  for (const document of [prepared.review, run, listed]) assert.equal(validateFormat(document).status, 'ok', JSON.stringify(validateFormat(document)));
});

test('a real failure on the installed interpreter switches to the reviewed fallback, and only to it', async () => {
  installedPython({ version: '3.13.1', failWheels: ['networkx'] });
  const target = project();
  const python = pythonSetup(server, { name: 'p-fallback', fallbackBytes });
  const prepared = await prepare(setupRequest(target, [python]));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual([run.steps[0].interpreter.branch, run.steps[0].interpreter.fallback, run.steps[0].interpreter.fallbackReason, run.steps[0].interpreter.version],
    ['fallback', true, 'wheel-install-failed', '3.14.5']);
  const folder = join(home, ...python.folder.split('/'));
  assert.ok(existsSync(join(folder, 'interpreter', 'python')), 'the qualified fallback is unpacked into the tool folder');
  const entry = (await list({ target: { project: target }, scope: 'user' })).entries.find(row => row.managementId === python.id);
  assert.deepEqual([entry.aiSetup.branch, entry.aiSetup.fallback, entry.aiSetup.fallbackReason], ['fallback', true, 'wheel-install-failed']);

  // A fallback whose own install fails fails the step; nothing else is tried.
  installedPython({ version: '3.9.7' });
  const failing = pythonSetup(server, { name: 'p-broken', fallbackBytes: fallbackArchive(base, { version: '3.14.5', failWheels: ['networkx'] }) });
  const second = await prepare(setupRequest(project(), [failing]));
  assert.equal(second.review.steps[0].interpreter.installed, null, 'an out-of-range interpreter is not offered');
  assert.deepEqual(second.review.steps[0].interpreter.switchesOn, ['none-found']);
  const failed = await apply(second.handle, approve(second.review));
  assert.deepEqual([failed.completion, failed.steps[0].application, failed.steps[0].reason], ['incomplete', 'failed', 'wheel-install-failed']);
  assert.equal(existsSync(join(home, ...failing.folder.split('/'))), false);
});

test('behind an untrusted certificate Prepare is refused with tls-untrusted, naming node-npm-ca', async () => {
  noPython();
  const untrusted = await artifactServer();
  try {
    const native = nativeSetup(untrusted, { name: 'n-tls' });
    const result = await prepare(setupRequest(project(), [native]));
    assert.deepEqual([result.status, result.code, result.repair, result.step], ['refused', 'tls-untrusted', 'node-npm-ca', 0], JSON.stringify(result));
    assert.match(result.reason, /node-npm-ca/);
    for (const code of ['tls-untrusted', 'qualification-missing', 'qualification-mismatch', 'cell-mismatch'])
      assert.ok(refusalCodes.some(entry => entry.code === code), code);
    assert.equal(untrusted.requests.some(line => line.startsWith('GET')), false, 'nothing was downloaded');
  } finally { await untrusted.close(); }
});

test('a cancelled acquisition is reported cancelled, leaves the install interrupted, and the next Prepare finishes it', async () => {
  noPython();
  const target = project();
  const native = nativeSetup(server, { name: 'n-cancel' });
  const prepared = await prepare(setupRequest(target, [native]));
  const controller = new AbortController();
  const run = await apply(prepared.handle, approve(prepared.review),
    { signal: controller.signal, onProgress: event => { if (event.phase === 'bytes') controller.abort(); } });
  assert.equal(run.completion, 'cancelled', JSON.stringify(run));
  const folder = join(home, ...native.folder.split('/'));
  assert.equal(existsSync(join(folder, '.aih-acquired')), false, 'the marker is never written for unfinished work');
  const interrupted = (await list({ target: { project: target }, scope: 'user' })).entries.find(row => row.managementId === native.id);
  assert.equal(interrupted?.installState, 'interrupted', JSON.stringify(interrupted));
  const again = await prepare(setupRequest(target, [native]));
  assert.equal(again.status, 'ready', JSON.stringify(again));
  const finished = await apply(again.handle, approve(again.review));
  assert.equal(finished.completion, 'complete', JSON.stringify(finished));
  assert.equal(readFileSync(join(folder, 'LICENSE'), 'utf8'), 'MIT\n');
  assert.equal((await list({ target: { project: target }, scope: 'user' })).entries.find(row => row.managementId === native.id).installState, 'complete');
});

test('two projects share one AI setup folder: removing it from one project keeps the folder, the last claim removes it', async () => {
  noPython();
  const one = project(), two = project();
  const native = nativeSetup(server, { name: 'n-shared' });
  for (const target of [one, two]) {
    const prepared = await prepare(setupRequest(target, [native]));
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    const run = await apply(prepared.handle, approve(prepared.review));
    assert.equal(run.completion, 'complete', JSON.stringify(run));
  }
  const folder = join(home, ...native.folder.split('/'));
  const entry = (await list({ target: { project: one }, scope: 'user' })).entries.find(row => row.managementId === native.id);
  assert.deepEqual(entry.claims.map(claim => claim.project).sort(), [realpathSync(one), realpathSync(two)].sort());
  const removeFrom = async target => {
    const removal = await prepareRemoval({ target: { project: target }, scope: 'user', removals: [{ managementId: native.id }] });
    assert.equal(removal.status, 'ok', JSON.stringify(removal));
    const run = await apply(removal.handle, approve(removal.review));
    assert.equal(run.completion, 'complete', JSON.stringify(run));
  };
  await removeFrom(one);
  assert.equal(readFileSync(join(folder, 'LICENSE'), 'utf8'), 'MIT\n', 'the other project still claims the folder');
  await removeFrom(two);
  assert.equal(existsSync(folder), false, 'the acquired folder goes with its last claim');
});
