// Where an `acquire` step's bytes come from (decision C78): a supplied folder of exact files, the recorded https URL, or
// resolution by exact identity (PyPI's JSON API for wheels and sdists, python-build-standalone's release downloads for
// interpreters), always checked against the qualified sha256. Through the built public entries in a disposable home and
// project. Artifacts, index answers and Python are Core-side FIXTURES (test/fixtures/acquire-fixture.mjs, fake-python.cjs):
// the local HTTPS server stands in for PyPI and GitHub through Core's internal index-base seam. They prove no real index.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { apply, list, prepare } from '../dist/core/index.js';
import { schemas, validateFormat } from '../dist/core/contracts.js';
import { indexBases } from '../dist/core/plan/acquire/sources.js';
import { artifactServer, fakeEnvironment, fakeInterpreterBase, fakePython, fallbackArchive, nativeSetup, pypiIndex, pythonSetup, setupRequest,
  suppliedFolder, withoutUrls } from './fixtures/acquire-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-acquire-sources-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };
const defaults = { ...indexBases };
let home; let server; let base; let fallbackBytes;
const bin = join(scratch, 'bin');
before(async () => {
  home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home;
  Object.assign(process.env, fakeEnvironment(bin));
  server = await artifactServer();
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), server.caPem]);
  indexBases.pypi = `${server.base}/pypi-index`; indexBases.pythonBuildStandalone = `${server.base}/pbs`;
  base = fakeInterpreterBase(join(scratch, 'base'));
  fallbackBytes = fallbackArchive(base, { version: '3.14.5' });
});
after(async () => {
  Object.assign(indexBases, defaults);
  await server?.close();
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});
const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex');
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
let counter = 0;
const project = () => { const path = join(scratch, `project-${counter++}`); mkdirSync(path); return path; };
const folder = () => { const path = join(scratch, `supplied-${counter++}`); mkdirSync(path); return path; };
const noPython = () => rmSync(bin, { recursive: true, force: true });
const installedPython = facts => { rmSync(bin, { recursive: true, force: true }); return fakePython(base, bin, facts); };
const byId = (run, id) => run.steps.find(step => step.managementId === id);
const entryOf = async (target, id) => (await list({ target: { project: target }, scope: 'user' })).entries.find(row => row.managementId === id);

test('a supplied folder supplies exact files by name and sha256; a recorded URL is used when none is supplied', async () => {
  noPython();
  const target = project();
  const native = withoutUrls(nativeSetup(server, { name: 's-native' }));
  const supplied = suppliedFolder(folder(), { [native.step.distribution.file]: native.archive });
  const prepared = await prepare(setupRequest(target, [native]), { artifacts: supplied });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  assert.deepEqual(prepared.review.steps[0].acquire.downloads, [{ role: 'artifact', file: native.step.distribution.file,
    sha256: native.step.distribution.sha256, source: { kind: 'supplied', folder: supplied } }]);
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(readFileSync(join(home, ...native.folder.split('/'), 'LICENSE'), 'utf8'), 'MIT\n');
  assert.equal(existsSync(join(supplied, native.step.distribution.file)), true, 'the supplied folder is only read');
  const entry = await entryOf(target, native.id);
  assert.deepEqual(entry.aiSetup.downloads, [{ role: 'artifact', file: native.step.distribution.file, sha256: native.step.distribution.sha256, origin: 'supplied' }]);

  // With a URL recorded and nothing supplied, the URL is the source and is recorded.
  const recorded = nativeSetup(server, { name: 's-url' });
  const viaUrl = await prepare(setupRequest(project(), [recorded]));
  assert.deepEqual(viaUrl.review.steps[0].acquire.downloads[0].source, { kind: 'url', url: recorded.step.distribution.url });
  const urlRun = await apply(viaUrl.handle, approve(viaUrl.review));
  assert.equal(urlRun.completion, 'complete', JSON.stringify(urlRun));
});

test('a supplied file whose bytes differ fails closed with artifact-mismatch and never falls through to the URL', async () => {
  noPython();
  const native = nativeSetup(server, { name: 's-mismatch' });
  const supplied = suppliedFolder(folder(), { [native.step.distribution.file]: Buffer.from('other bytes\n') });
  const prepared = await prepare(setupRequest(project(), [native]), { artifacts: supplied });
  assert.equal(prepared.review.steps[0].acquire.downloads[0].source.kind, 'supplied');
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.deepEqual([byId(run, native.id).application, byId(run, native.id).reason], ['failed', 'artifact-mismatch']);
  assert.equal(server.requests.some(line => line === `GET /${native.step.distribution.file}`), false, 'the URL is not tried');
});

test('nothing obtainable fails that download artifact-unavailable and its dependants are not attempted', async () => {
  noPython();
  const target = project();
  const native = withoutUrls(nativeSetup(server, { name: 's-none' }));
  const prepared = await prepare(setupRequest(target, [native], [{ name: 'needs-tool', text: 'Needs.\n', dependencies: [native.id] }, { name: 'other', text: 'Other.\n' }]));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.deepEqual(prepared.review.steps[0].acquire.downloads[0].source, { kind: 'none' });
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.equal(run.completion, 'incomplete', JSON.stringify(run));
  assert.deepEqual([byId(run, native.id).application, byId(run, native.id).reason], ['failed', 'artifact-unavailable']);
  assert.equal(byId(run, 'local-my-skills.skill.needs-tool').application, 'not-attempted');
  assert.equal(byId(run, 'local-my-skills.skill.other').application, 'applied');
  assert.equal(existsSync(join(home, ...native.folder.split('/'))), false);
});

test('wheels resolve through the PyPI JSON API and the fallback interpreter through its python-build-standalone release', async () => {
  installedPython({ version: '3.13.1', failWheels: ['networkx'] });
  const target = project();
  const python = withoutUrls(pythonSetup(server, { name: 's-index', fallbackBytes, fallbackFile: 'cpython-3.14.5+20261026-x86_64-unknown-linux-gnu-install_only.tar.gz' }));
  pypiIndex(server, `${server.base}/pypi-index`, python);
  server.serve(`/pbs/20261026/${encodeURIComponent(python.step.interpreter.fallback.file)}`, fallbackBytes);
  const prepared = await prepare(setupRequest(target, [python]));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  const downloads = prepared.review.steps[0].acquire.downloads;
  assert.deepEqual(downloads.find(entry => entry.role === 'closure').source, { kind: 'index', index: 'pypi', name: 'networkx', version: '3.4.2' });
  assert.deepEqual(downloads.find(entry => entry.role === 'interpreter').source, { kind: 'index', index: 'python-build-standalone', release: '20261026' });
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(byId(run, python.id).interpreter.branch, 'fallback');
  const recorded = (await entryOf(target, python.id)).aiSetup.downloads;
  const wheel = recorded.find(entry => entry.role === 'closure');
  assert.deepEqual([wheel.origin, wheel.url], ['downloaded', server.url('/files/networkx-3.4.2-py3-none-any.whl')]);
  const fallback = recorded.find(entry => entry.role === 'interpreter');
  assert.deepEqual([fallback.origin, fallback.url], ['downloaded', server.url(`/pbs/20261026/${encodeURIComponent(python.step.interpreter.fallback.file)}`)]);
});

test('an index answer whose file has other bytes fails closed; an index with no such file is artifact-unavailable', async () => {
  installedPython({ version: '3.13.1' });
  const python = withoutUrls(pythonSetup(server, { name: 's-index-bad', fallbackBytes }));
  pypiIndex(server, `${server.base}/pypi-index`, python, { 'networkx-3.4.2-py3-none-any.whl': Buffer.from('tampered\n') });
  const prepared = await prepare(setupRequest(project(), [python]));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.deepEqual([byId(run, python.id).application, byId(run, python.id).reason], ['failed', 'artifact-mismatch']);

  const missing = withoutUrls(pythonSetup(server, { name: 's-index-missing', fallbackBytes }));
  pypiIndex(server, `${server.base}/pypi-index`, missing, {}, ['networkx-3.4.2-py3-none-any.whl']);
  const again = await prepare(setupRequest(project(), [missing]));
  const failed = await apply(again.handle, approve(again.review));
  assert.deepEqual([byId(failed, missing.id).application, byId(failed, missing.id).reason], ['failed', 'artifact-unavailable']);
});

test('the receipt records each acquired file origin in the published receipt format; inconsistent records are invalid', async () => {
  const id = 'urn:aihq:core:receipt:0.1.0';
  const example = schemas[id].fixtures.valid;
  conforms(example);
  const aiSetup = Object.values(example.items).find(item => item.plan?.aiSetup).plan.aiSetup;
  assert.deepEqual(aiSetup.downloads.map(entry => entry.origin), ['supplied', 'downloaded', 'downloaded', 'supplied', 'built']);
  assert.notEqual(validateFormat(schemas[id].fixtures.invalid).status, 'ok');
  const variant = change => { const copy = structuredClone(example); change(Object.values(copy.items).find(item => item.plan?.aiSetup).plan.aiSetup.downloads); return validateFormat(copy).status; };
  assert.equal(variant(downloads => { downloads[0].url = 'https://example.invalid/x.whl'; }), 'invalid', 'a supplied file has no URL');
  assert.equal(variant(downloads => { delete downloads[1].url; }), 'invalid', 'a download names its URL');
  assert.equal(variant(downloads => { downloads[4].built.byteQualified = true; }), 'invalid', 'a built wheel is never byte-qualified');
  assert.equal(variant(downloads => { downloads[4].role = 'artifact'; }), 'invalid', 'only a closure wheel is built');
  assert.equal(variant(downloads => { downloads[2].origin = 'guessed'; }), 'invalid');

  // Every receipt Core stored in this file's runs is in that format.
  const ownership = join(home, '.aih', 'core', 'ownership');
  const stored = readdirSync(ownership, { recursive: true }).filter(name => String(name).endsWith('.json'));
  const receipts = stored.map(name => JSON.parse(readFileSync(join(ownership, String(name)), 'utf8'))).filter(document => document.schema === id);
  const withDownloads = receipts.filter(document => Object.values(document.items ?? {}).some(item => item.plan?.aiSetup?.downloads?.length));
  assert.ok(withDownloads.length > 0, 'a stored receipt records acquired files');
  for (const document of receipts) conforms(document);
});

test('a Catalog recipe plan whose qualification records no URLs keeps recipe origin proven and is never changed', async () => {
  installedPython({ version: '3.13.1' });
  const target = project();
  const python = withoutUrls(pythonSetup(server, { name: 's-recipe', fallbackBytes }));
  const supplied = suppliedFolder(folder(), python.files);
  const recipe = { schema: 'urn:aihq:catalog:recipe:0.1.0', id: 'tools-base', kind: 'combination', framework: 'crg', members: [{ item: python.id, preTicked: true }],
    options: [], data: { repository: 'samartomar/aih-catalog', commit: 'd'.repeat(40) } };
  const recipeJson = JSON.stringify(recipe);
  const source = { repository: 'https://github.com/example/tools-recipe', commit: 'e'.repeat(40) };
  // A Core-side planRecipe FIXTURE: it plans the acquire step from the supplied qualification the way Catalog's planner
  // records it (closure and fallback interpreter copied from `observed`, so with no URLs).
  const planRecipe = (document, contents, _profiles, _choices, options) => {
    const qualification = options.qualifications[0];
    const step = structuredClone(python.step);
    step.closure = structuredClone(qualification.observed.closure);
    step.interpreter = { ...step.interpreter, fallback: structuredClone(qualification.observed.interpreter) };
    return { status: 'ok', data: document.data, recipe: { id: document.id, sha256: sha256Hex(recipeJson), ...options.source }, plan: [step],
      missing: [], unavailable: [], clashes: [], duplicates: [], references: [], warnings: [] };
  };
  const request = setupRequest(target, [python]);
  request.plan = planRecipe(recipe, request.contents, request.profiles, {}, { scope: 'project', source, qualifications: request.qualifications });
  request.recipeProof = { pluginJson: JSON.stringify({ name: recipe.id, version: '1.0.0', description: 'Fixture recipe' }), recipeJson, choices: {}, options: {} };
  assert.equal(request.plan.plan[0].closure.some(wheel => 'url' in wheel), false);
  const planned = JSON.stringify(request.plan); const qualified = JSON.stringify(request.qualifications);
  const controls = { artifacts: supplied, catalog: { version: '0.0.0-core-fixture', planRecipe } };
  const prepared = await prepare(request, controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.deepEqual(prepared.review.origin.recipe, { id: 'tools-base', sha256: sha256Hex(recipeJson), ...source });
  const run = await apply(prepared.handle, approve(prepared.review), controls);
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(JSON.stringify(request.plan), planned, 'the plan is never changed');
  assert.equal(JSON.stringify(request.qualifications), qualified, 'the qualification is never changed');
  const entry = await entryOf(target, python.id);
  assert.equal(entry.origin.recipe.id, 'tools-base');
  assert.ok(entry.aiSetup.downloads.every(record => record.origin === 'supplied'), JSON.stringify(entry.aiSetup.downloads));
});
