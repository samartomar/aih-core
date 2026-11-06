// `acquire` steps (contract 4.1, 7, 8.1, C36, C46, C60) through the built public entries, in a disposable home and
// project. Artifacts come from a local HTTPS fixture server; Python is the `fake-python.cjs` process fixture. These are
// Core-side fixtures (test/fixtures/acquire-fixture.mjs): they prove no real tool, interpreter or qualification.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
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
  // A Python tool always names its fallback interpreter (Catalog never plans `fallback: null`): a malformed plan.
  const fallbackless = structuredClone(python.step); fallbackless.interpreter.fallback = null;
  const malformed = await prepare(setupRequest(target, [{ ...python, step: fallbackless }]));
  assert.equal(malformed.status, 'invalid', JSON.stringify(malformed));
  assert.deepEqual(malformed.problems.map(problem => problem.path), ['/plan/plan/0/interpreter/fallback']);
  assert.equal(existsSync(join(home, '.aihq')), false, 'nothing is written');
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

test('removal of an AI setup deletes only what the acquisition placed: an added or changed file is kept and reported', async () => {
  noPython();
  const target = project();
  const native = nativeSetup(server, { name: 'n-kept' });
  const prepared = await prepare(setupRequest(target, [native]));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const folder = join(home, ...native.folder.split('/'));
  writeFileSync(join(folder, 'extra.txt'), 'mine\n');
  writeFileSync(join(folder, 'LICENSE'), 'changed\n');
  const removal = await prepareRemoval({ target: { project: target }, scope: 'user', removals: [{ managementId: native.id }] });
  const removed = await apply(removal.handle, approve(removal.review));
  assert.equal(removed.completion, 'complete', JSON.stringify(removed));
  assert.equal(readFileSync(join(folder, 'extra.txt'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(folder, 'LICENSE'), 'utf8'), 'changed\n');
  assert.equal(existsSync(join(folder, 'memory-mcp')), false, 'the recorded, unchanged member goes');
  const into = native.folder.replace(/\/$/, '');
  assert.deepEqual(removed.members.filter(member => member.kind === 'kept-unrecorded').map(member => [member.path, member.intent, member.outcome]).sort(),
    [[`${into}/LICENSE`, 'keep', 'kept'], [`${into}/extra.txt`, 'keep', 'kept']]);
  rmSync(join(home, '.aihq'), { recursive: true, force: true });
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
  // `list` keeps the unfinished installs interrupted (contract 12) and says what the run that left them did.
  const listed = conforms(await list({ target: { project: target }, scope: 'both' }));
  const entry = id => listed.entries.find(row => row.managementId === id);
  assert.deepEqual([entry(native.id).installState, entry(native.id).lastRun], ['interrupted', { runId: run.runId, outcome: 'failed', reason: 'artifact-mismatch' }]);
  assert.deepEqual([entry('local-my-skills.skill.uses-tool').installState, entry('local-my-skills.skill.uses-tool').lastRun],
    ['interrupted', { runId: run.runId, outcome: 'not-attempted' }]);
  assert.deepEqual([entry('local-my-skills.skill.unrelated').installState, entry('local-my-skills.skill.unrelated').lastRun], ['complete', undefined]);
  server.serve(`/${native.step.distribution.file}`, native.archive);
  // Approving the next Prepare finishes the install; nothing of the earlier run is listed any more.
  const again = await prepare(request);
  assert.equal((await apply(again.handle, approve(again.review))).completion, 'complete');
  const finished = conforms(await list({ target: { project: target }, scope: 'both' }));
  for (const row of finished.entries) assert.deepEqual([row.installState, row.lastRun], ['complete', undefined], row.managementId);
});

/** The setup's MCP entry (Catalog `rootPaths`): `.mcp.json` starts the acquired executable by its path under the user root. */
function withMcp(request, native) {
  const id = native.id.replace('.ai-setup.', '.mcp.');
  const executable = `${native.folder}/memory-mcp`;
  request.contents[0].items.find(item => item.id === native.id).aiSetup.mcpItem = id;
  request.contents[0].items.push({ id, kind: 'mcp', name: 'memory', description: 'memory', files: [] });
  request.plan.plan.push({ op: 'merge', root: 'project', file: '.mcp.json', format: 'json', key: '/mcpServers/memory', entry: { command: executable },
    item: id, clis: ['claude-code'], rootPaths: [{ pointer: '/command', root: 'user', path: executable }] });
  return { request, id, step: request.plan.plan.length - 1 };
}

test('an MCP entry naming an acquired executable needs its acquire step; when that step is skipped the entry is not written', async () => {
  noPython();
  const target = project();
  const native = nativeSetup(server, { name: 'n-mcp' });
  const planned = withMcp(setupRequest(target, [native]), native);
  const prepared = await prepare(planned.request);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  assert.equal(JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8')).mcpServers.memory.command, join(home, ...native.folder.split('/'), 'memory-mcp'));

  // Skipping the acquisition leaves its MCP entry out too: it would start a program that is not there.
  const other = project();
  const skipped = withMcp(setupRequest(other, [nativeSetup(server, { name: 'n-mcp-skip' })]), nativeSetup(server, { name: 'n-mcp-skip' }));
  const partial = await prepare({ ...skipped.request, resolutions: [{ managementId: 'cbm.ai-setup.n-mcp-skip', step: 0, choice: 'skip', observedSha256: null }] });
  assert.equal(partial.status, 'partial', JSON.stringify(partial));
  assert.deepEqual(partial.review.steps.map(step => [step.step, step.effect]), [[0, 'skipped'], [skipped.step, 'skipped']]);
  assert.equal((await apply(partial.handle, { ...approve(partial.review), allowPartial: true })).completion, 'complete');
  assert.equal(existsSync(join(other, '.mcp.json')), false);
});

test('a failed AI setup holds back only its own MCP entries: the other tools\' entries in the same config files are written (C60)', async () => {
  noPython();
  const target = project();
  // The trio's shape: three acquires, then every tool's Codex TOML entry, then every tool's Claude Code JSON entry, so
  // the failing tool's entry comes first in both shared files.
  const setups = ['q-graph', 'q-memory', 'q-serena'].map((name, index) => nativeSetup(server, { name,
    id: `${['crg', 'cbm', 'serena'][index]}.ai-setup.${name}`, members: { [name]: `#!/bin/sh\necho ${name}\n`, LICENSE: 'MIT\n' } }));
  const request = setupRequest(target, setups);
  request.profiles.push({ schema: 'urn:aihq:catalog:tool-profile:0.1.0', id: 'codex', version: 1, checkedWith: 'fixture' });
  const mcpOf = setup => setup.id.replace('.ai-setup.', '.mcp.');
  for (const setup of setups) {
    request.contents[0].items.find(item => item.id === setup.id).aiSetup.mcpItem = mcpOf(setup);
    request.contents[0].items.push({ id: mcpOf(setup), kind: 'mcp', name: setup.item.name, description: setup.item.name, files: [] });
  }
  const executable = setup => `${setup.folder}/${setup.item.name}`;
  for (const setup of setups) request.plan.plan.push({ op: 'merge', root: 'project', file: '.codex/config.toml', format: 'toml',
    key: `mcp_servers.${setup.item.name}`, entry: { command: executable(setup), args: ['--stdio'] }, item: mcpOf(setup), clis: ['codex'],
    rootPaths: [{ pointer: '/command', root: 'user', path: executable(setup) }] });
  for (const setup of setups) request.plan.plan.push({ op: 'merge', root: 'project', file: '.mcp.json', format: 'json',
    key: `/mcpServers/${setup.item.name}`, entry: { type: 'stdio', command: executable(setup), args: ['--stdio'] }, item: mcpOf(setup), clis: ['claude-code'],
    rootPaths: [{ pointer: '/command', root: 'user', path: executable(setup) }] });
  const prepared = await prepare(request);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const [failing, ...others] = setups;
  server.serve(`/${failing.step.distribution.file}`, Buffer.concat([failing.archive.subarray(0, -1), Buffer.from([failing.archive.at(-1) ^ 1])]));
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'incomplete', JSON.stringify(run));
  const steps = id => run.steps.filter(step => step.managementId === id).map(step => step.application);
  assert.deepEqual(steps(failing.id), ['failed']);
  assert.deepEqual(steps(mcpOf(failing)), ['not-attempted', 'not-attempted']);
  for (const setup of others) {
    assert.deepEqual(steps(setup.id), ['applied'], setup.id);
    assert.deepEqual(steps(mcpOf(setup)), ['applied', 'applied'], JSON.stringify(run));
  }
  const toml = readFileSync(join(target, '.codex', 'config.toml'), 'utf8');
  const json = JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(json.mcpServers), others.map(setup => setup.item.name));
  for (const setup of others) {
    assert.match(toml, new RegExp(`\\[mcp_servers\\.${setup.item.name}\\]`));
    assert.equal(json.mcpServers[setup.item.name].command, join(home, ...executable(setup).split('/')));
  }
  assert.doesNotMatch(toml, /q-graph/);
  const listed = conforms(await list({ target: { project: target }, scope: 'both' }));
  const entry = id => listed.entries.find(row => row.managementId === id);
  for (const setup of others) assert.equal(entry(mcpOf(setup)).installState, 'complete', mcpOf(setup));
  assert.equal(entry(mcpOf(failing)).installState, 'interrupted');

  // Fixed, the next Prepare finishes the failed tool: its entries join the others in both files.
  server.serve(`/${failing.step.distribution.file}`, failing.archive);
  const again = await prepare(request);
  assert.equal(again.status, 'ready', JSON.stringify(again));
  assert.equal(conforms(await apply(again.handle, approve(again.review))).completion, 'complete');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8')).mcpServers).sort(), setups.map(setup => setup.item.name).sort());
  assert.match(readFileSync(join(target, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.q-graph\]/);

  // Removing everything takes every entry and acquired folder away, and each config file the run created goes with its
  // last entry: absent before, absent after.
  for (const scope of ['project', 'user']) {
    const removal = await prepareRemoval({ target: { project: target }, scope,
      removals: setups.map(setup => ({ managementId: scope === 'user' ? setup.id : mcpOf(setup) })) });
    assert.equal(removal.status, 'ok', JSON.stringify(removal));
    assert.equal((await apply(removal.handle, approve(removal.review))).completion, 'complete');
  }
  assert.equal(existsSync(join(target, '.mcp.json')), false);
  assert.equal(existsSync(join(target, '.codex', 'config.toml')), false);
  for (const setup of setups) assert.equal(existsSync(join(home, ...setup.folder.split('/'))), false, setup.id);
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

test('removing the last AI setup leaves no empty folder Core made: .aihq/ai-setup and .aihq go, a folder the person made stays', async () => {
  noPython();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    for (const prior of [false, true]) {
      const fresh = join(scratch, `parents-home-${prior}`); mkdirSync(fresh);
      // With `prior`, the person already has an empty `~/.aihq`: Core did not make it, so it stays.
      if (prior) mkdirSync(join(fresh, '.aihq'));
      process.env.HOME = fresh; process.env.USERPROFILE = fresh;
      const target = project();
      const native = nativeSetup(server, { name: `parents-${prior}` });
      const prepared = await prepare(setupRequest(target, [native]));
      assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
      const removal = await prepareRemoval({ target: { project: target }, scope: 'user', removals: [{ managementId: native.id }] });
      assert.equal((await apply(removal.handle, approve(removal.review))).completion, 'complete');
      assert.equal(existsSync(join(fresh, '.aihq', 'ai-setup')), false, 'the empty AI setup root Core made goes');
      assert.equal(existsSync(join(fresh, '.aihq')), prior, prior ? 'a folder the person made stays' : 'the empty .aihq Core made goes');
    }
  } finally { Object.assign(process.env, saved); }
});

test('a Python tool\'s named executable is placed where the step names it, read back through it, and removed with the folder', async () => {
  installedPython({ version: '3.13.1' });
  const target = project();
  const python = pythonSetup(server, { name: 'p-named', fallbackBytes });
  assert.equal(python.step.executable, `${python.folder}/${process.platform === 'win32' ? 'Scripts/p-named.exe' : 'bin/p-named'}`);
  const prepared = await prepare(setupRequest(target, [python]));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const folder = join(home, ...python.folder.split('/'));
  const named = join(home, ...python.step.executable.split('/'));
  const entry = join(folder, 'env', ...(process.platform === 'win32' ? ['Scripts', 'p-named.exe'] : ['bin', 'p-named']));
  assert.ok(existsSync(named), 'the step\'s executable exists at the path it names');
  if (process.platform === 'win32') {
    // On Windows a hard link to the environment's console-script launcher: the same file.
    assert.equal(statSync(named, { bigint: true }).ino, statSync(entry, { bigint: true }).ino);
  } else {
    assert.ok(lstatSync(named).isSymbolicLink(), 'on POSIX a symlink to the environment\'s console script');
    assert.equal(realpathSync(named), realpathSync(entry));
  }
  const listed = conforms(await list({ target: { project: target }, scope: 'user' }));
  assert.deepEqual(listed.entries.find(row => row.managementId === python.id).aiSetup.executable,
    { path: python.step.executable, placed: process.platform === 'win32' ? 'hardlink' : 'symlink' });

  const removal = await prepareRemoval({ target: { project: target }, scope: 'user', removals: [{ managementId: python.id }] });
  assert.equal((await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.equal(existsSync(named), false, 'the placed executable goes with the folder');
  assert.equal(existsSync(folder), false);
});

test('a named executable the environment does not provide fails the readback on both branches, and the step', async () => {
  installedPython({ version: '3.13.1' });
  // The tool wheel provides `other-tool`, but the step names `p-missing`: the readback through the named path fails.
  const python = pythonSetup(server, { name: 'p-missing', fallbackBytes, scripts: ['other-tool'] });
  const prepared = await prepare(setupRequest(project(), [python]));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  const step = run.steps.find(row => row.managementId === python.id);
  assert.deepEqual([run.completion, step.application, step.reason], ['incomplete', 'failed', 'readback-failed']);
  assert.equal(existsSync(join(home, ...python.folder.split('/'))), false);
});

test('an acquire step whose executable is outside its folder, or a native member that is not executable, is invalid', async () => {
  noPython();
  const target = project();
  const python = pythonSetup(server, { name: 'p-shape', fallbackBytes });
  const outside = structuredClone(python.step); outside.executable = '.aihq/ai-setup/other/1.0/x/bin/tool';
  const invalid = await prepare(setupRequest(target, [{ ...python, step: outside }]));
  assert.equal(invalid.status, 'invalid', JSON.stringify(invalid));
  assert.deepEqual(invalid.problems.map(problem => problem.path), ['/plan/plan/0/executable']);
  const native = nativeSetup(server, { name: 'n-shape' });
  const license = { ...structuredClone(native.step), executable: `${native.folder}/LICENSE` };
  const notExecutable = await prepare(setupRequest(target, [{ ...native, step: license }]));
  assert.deepEqual(notExecutable.problems?.map(problem => problem.path), ['/plan/plan/0/executable'], JSON.stringify(notExecutable));
  assert.equal(existsSync(join(home, ...native.folder.split('/'))), false);
});

test('on Windows a `.cmd` executable is Core\'s launcher for the console script, and a name without .exe or .cmd is invalid', { skip: process.platform !== 'win32' }, async () => {
  installedPython({ version: '3.13.1' });
  const target = project();
  const python = pythonSetup(server, { name: 'p-cmd', fallbackBytes, executable: 'Scripts/p-cmd.cmd' });
  const prepared = await prepare(setupRequest(target, [python]));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const named = join(home, ...python.step.executable.split('/'));
  assert.equal(readFileSync(named, 'utf8'), '@"%~dp0..\\env\\Scripts\\p-cmd.exe" %*\r\n');
  const entry = (await list({ target: { project: target }, scope: 'user' })).entries.find(row => row.managementId === python.id);
  assert.deepEqual(entry.aiSetup.executable, { path: python.step.executable, placed: 'launcher' });

  const bare = pythonSetup(server, { name: 'p-bare', fallbackBytes, executable: 'bin/p-bare' });
  const invalid = await prepare(setupRequest(project(), [bare]));
  assert.equal(invalid.status, 'invalid', JSON.stringify(invalid));
  assert.match(invalid.problems[0].message, /Scripts\/<name>\.exe/);
});
