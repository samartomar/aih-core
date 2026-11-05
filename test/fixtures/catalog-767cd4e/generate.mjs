// Records REAL @aihq/catalog output for Core's tests: the producer, planners and renders of the Catalog package built
// from samartomar/aih-catalog commit 767cd4edc4faf40058766438991baccd2bd6465c (unreleased candidate, 0.0.0-dev.1).
//
//   node test/fixtures/catalog-767cd4e/generate.mjs --consumer <folder with that @aihq/catalog installed> \
//     --tarball-sha256 <sha256 of the packed tarball> --catalog <aih-catalog checkout at that commit> \
//     --superpowers <Git checkout of obra/superpowers holding its pinned commit> \n//     --notices <folder holding <sourceId>/<sourcePath> for the cbm, crg and serena licence notices at their pinned commits>
//
// `recorded.json` holds, byte for byte as Catalog returned them: a bring-your-own content document (built by
// `buildContent` from the small folder below), the nine shipped tool profiles, `planInstall` plans for it at user and
// project scope, every `renderStep` result those plans need, Catalog's real codebase-memory-mcp (cbm) data plans on
// windows-x64 (not qualified there) and linux-x64 (qualified: acquire, MCP entries and settings commands with their
// `restore`), and three `planRecipe` plans over Catalog's own data (`recipes`):
//   - `superpowers`: a recipe (a Core-side FIXTURE document) installing the native Superpowers plugin on Claude Code (from
//     the pinned local marketplace the plan writes) and Codex (by marketplace name), and one skill as items on Kiro;
//   - `egm`: Catalog's draft `egm-base` recipe at project scope for Claude Code, Codex and Antigravity (local plugins, a
//     bundle, Codex items);
//   - `trio`: Catalog's `code-intelligence-trio` recipe on linux-x64 for Claude Code and Codex with Catalog's
//     qualifications (three acquire steps, settings commands, MCP entries).
// `recipe-files.json.gz` holds only the upstream files those plans copy, at their pinned commits (Superpowers from Git,
// MIT; EGM from Catalog's pinned fixture copy, Apache-2.0; each upstream's LICENSE included and its commit recorded beside
// it in `recorded.json`). Core's tests replay the renders and the recorded `planRecipe` calls instead of importing
// Catalog. This is real Catalog output for this candidate only: it says nothing about a released Catalog, a client loading
// the result, or a qualified AI setup on this host.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = name => { const at = process.argv.indexOf(name); assert.ok(at > 0 && process.argv[at + 1], `missing ${name}`); return process.argv[at + 1]; };
const consumer = resolve(arg('--consumer')), catalogDir = resolve(arg('--catalog')), tarballSha256 = arg('--tarball-sha256');
const data = join(catalogDir, 'data');
const superpowersGit = resolve(arg('--superpowers')), notices = resolve(arg('--notices'));
const COMMIT = '767cd4edc4faf40058766438991baccd2bd6465c';
const packageDir = join(consumer, 'node_modules', '@aihq', 'catalog');
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const entry = name => import(pathToFileURL(join(packageDir, manifest.exports[name].import)).href);
const [{ toolProfiles }, { readLocalSource, readContentFile }, { buildContent }, reader, { findItems }] =
  await Promise.all(['./contracts', './node', './producer', './reader', './source'].map(entry));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const canonical = value => JSON.stringify(sorted(value));
const encode = text => new TextEncoder().encode(text);
// A file's bytes as recorded: UTF-8 text as text, any other bytes as base64.
const asRecorded = (sourceId, sourcePath, sha, bytes) => {
  const text = Buffer.from(bytes).toString('utf8');
  return { sourceId, sourcePath, sha256: sha, ...(Buffer.from(text, 'utf8').equals(Buffer.from(bytes)) ? { text } : { base64: Buffer.from(bytes).toString('base64') }) };
};

const FRAMEWORK = 'my-skills';
const SERVER = name => readFileSync(join(data, 'ecc', 'generated', `ecc.mcp.${name}`, 'server.json'), 'utf8');
const TREE = {
  LICENSE: 'MIT Licence\n',
  'skills/notes/SKILL.md': '---\nname: notes\ndescription: Take notes.\n---\n\nTake notes. Use the checklist in references/checklist.md.\n',
  'skills/notes/references/checklist.md': '- tests\n',
  'skills/ship/SKILL.md': '---\nname: ship\ndescription: Ship the change.\ndisable-model-invocation: true\n---\n\nShip $ARGUMENTS now.\n',
  'skills/steps/SKILL.md': '---\nname: steps\ndescription: Follow the guide.\n---\n\nRead `../../docs/guide.md` first.\n',
  'docs/guide.md': '# Guide\n\nWork in small steps.\n',
  'rules/style.md': '# Style\n\nUse two spaces.\n',
  'agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews code.\ntools: Read, Grep\n---\n\nReview the code.\n',
  'editions/kiro/reviewer.json': '{\n  "name": "reviewer",\n  "description": "Reviews code.",\n  "prompt": "Review the code."\n}\n',
  // Two Registry server.json files copied from Catalog's own ECC data (one argv input, one secret environment input).
  'mcp/filesystem/server.json': SERVER('filesystem'),
  'mcp/exa-web-search/server.json': SERVER('exa-web-search'),
};
const folder = mkdtempSync(join(tmpdir(), 'catalog-byo-'));
try {
  for (const [path, text] of Object.entries(TREE)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  const read = readLocalSource(folder);
  assert.equal(read.status, 'ok', JSON.stringify(read));
  const found = findItems(read.files.filter(file => !file.path.startsWith('editions/')), { framework: FRAMEWORK });
  assert.equal(found.status, 'ok', JSON.stringify(found));
  const file = path => { const entry = read.files.find(candidate => candidate.path === path);
    return { sourceId: FRAMEWORK, sourcePath: path, sha256: entry.sha256, executable: false, role: 'content' }; };
  const items = found.items.map(item => item.id === `${FRAMEWORK}.agent.reviewer` ?
    { ...item, editions: { kiro: { files: [file('editions/kiro/reviewer.json')] } } } :
    item.id === `${FRAMEWORK}.skill.steps` ? { ...item, bundle: `${FRAMEWORK}.runtime` } : item);
  const built = await buildContent(read.source, read.files, items,
    { framework: FRAMEWORK, bundles: [{ id: `${FRAMEWORK}.runtime`, layout: 'skills/<name>/', include: ['docs/*.md'] }] });
  assert.equal(built.status, 'ok', JSON.stringify(built));
  const content = built.content;
  const profiles = Object.keys(toolProfiles).sort().map(id => reader.readToolProfile(encode(toolProfiles[id])).profile);
  const only = ids => profiles.filter(profile => ids.includes(profile.id));
  const ids = content.items.map(item => item.id);
  const plans = {
    user: reader.planInstall(ids, [content], profiles, { scope: 'user', data: null }),
    // `ship` is left out at project scope: it uses `$ARGUMENTS`, which Kimi's profile substitutes and the other five
    // clients sharing the one `.agents/skills` folder reword, so Catalog truthfully reports the renders as a clash
    // (recorded below as `shipClashes`; Core refuses it `plan-unresolved`).
    project: reader.planInstall(ids.filter(id => id !== `${FRAMEWORK}.skill.ship`), [content], profiles, { scope: 'project', data: null }),
  };
  for (const [scope, plan] of Object.entries(plans)) assert.ok(plan.plan && !plan.clashes.length, `${scope}: ${JSON.stringify(plan.clashes)}`);
  const withShip = reader.planInstall(ids, [content], profiles, { scope: 'project', data: null });
  const shipClashes = withShip.clashes, shipUnavailable = withShip.unavailable;

  // A rule declaring an input with a placeholder in its own file, planned for Claude Code alone (a rule file) and with
  // Codex too (a block in the shared AGENTS.md).
  const RULES = 'my-rules';
  const rulesFolder = join(folder, '..', `${basename(folder)}-rules`);
  mkdirSync(join(rulesFolder, 'rules'), { recursive: true });
  writeFileSync(join(rulesFolder, 'rules', 'team.md'), '# Team\n\nAsk {{TEAM}} before changing the style.\n');
  const rulesRead = readLocalSource(rulesFolder);
  rmSync(rulesFolder, { recursive: true, force: true });
  const rulesFound = findItems(rulesRead.files, { framework: RULES });
  const rulesBuilt = await buildContent(rulesRead.source, rulesRead.files, rulesFound.items.map(item => ({ ...item, requirements: { inputs: {
    TEAM: { description: 'The team that owns the style', isRequired: true, isSecret: false, placeholder: { sourcePath: 'rules/team.md', marker: '{{TEAM}}' } } } } })),
    { framework: RULES });
  assert.equal(rulesBuilt.status, 'ok', JSON.stringify(rulesBuilt));
  const ruleIds = rulesBuilt.content.items.map(item => item.id);
  const rulesPlans = Object.fromEntries([['claude', ['claude-code']], ['shared', ['claude-code', 'codex']]].map(([name, ids]) =>
    [name, reader.planInstall(ruleIds, [rulesBuilt.content], only(ids), { scope: 'project', data: null })]));
  const rulesFiles = rulesRead.files.map(entry => ({ sourceId: RULES, sourcePath: entry.path, sha256: entry.sha256, text: new TextDecoder().decode(entry.bytes) }));

  // cbm: Catalog's own codebase-memory-mcp data, planned for every client with its qualifications, on windows-x64 (this
  // host's cell, not qualified) and linux-x64 (qualified).
  const cbm = (await readContentFile(join(data, 'cbm', 'content.json'))).content;
  const qualifications = readdirSync(join(data, 'qualifications')).sort().map(name =>
    reader.readQualification(readFileSync(join(data, 'qualifications', name))).qualification);
  const dataPin = { repository: 'https://github.com/samartomar/aih-catalog', commit: COMMIT };
  const cbmPlans = Object.fromEntries(['windows-x64', 'linux-x64'].map(cell => [cell, reader.planInstall(cbm.items.map(item => item.id), [cbm], profiles,
    { scope: 'project', data: dataPin, cell, qualifications })]));
  for (const plan of Object.values(cbmPlans)) assert.ok(plan.plan, JSON.stringify(plan));
  // A qualification is named by the sha256 of its canonical document bytes.
  const documentSha = record => sha256(encode(`${JSON.stringify(sorted(record), null, 2)}\n`));
  const usedBy = plan => plan.plan.filter(step => step.qualification).map(step => step.qualification.replace(/^sha256:/, ''));
  // The one source file the cbm plan copies (its licence notice), as supplied and checked against the content's sha256.
  const cbmSource = cbm.sources[0];
  const noticeFiles = source => source.notices.map(notice => {
    const text = readFileSync(join(notices, source.id, ...notice.sourcePath.split('/')), 'utf8');
    assert.equal(sha256(encode(text)), notice.sha256, `${source.id} ${notice.sourcePath}`);
    return { sourceId: source.id, sourcePath: notice.sourcePath, sha256: notice.sha256, text };
  });
  const cbmFiles = noticeFiles(cbmSource);
  const cbmUsed = Object.values(cbmPlans).flatMap(usedBy);
  const cbmQualifications = qualifications.filter(record => cbmUsed.includes(documentSha(record)));

  const recipeSource = { repository: 'https://github.com/example/aih-core-fixture-recipes', commit: 'a'.repeat(40) };
  const pluginJsonOf = (name, description) => `${JSON.stringify({ name, version: '0.1.0', description,
    author: { name: 'AIH Core tests' }, license: 'MIT', keywords: ['fixture'] }, null, 2)}\n`;
  // A recipe as Catalog reads it: its canonical file (sorted keys, two-space indent: its sha256 is the recipe's identity),
  // the plan.json beside it, and exactly the planRecipe call Core makes to prove the origin.
  const recipes = {};
  const planned = (name, document, contents, ids, options, description) => {
    const recipeJson = `${JSON.stringify(sorted(document), null, 2)}\n`;
    const pluginJson = pluginJsonOf(document.id, description);
    const readBack = reader.readRecipe(encode(pluginJson), encode(recipeJson));
    assert.equal(readBack.status, 'ok', JSON.stringify(readBack).slice(0, 2000));
    const plan = reader.planRecipe(JSON.parse(recipeJson), contents, only(ids), {}, options);
    assert.ok(plan.plan, JSON.stringify(plan).slice(0, 2000));
    recipes[name] = { contents, pluginJson, recipeJson, choices: {}, options, profiles: ids, plan };
    return plan;
  };

  // Superpowers at user scope: the native plugin on Claude Code (from the pinned local marketplace the plan writes) and
  // Codex (from the marketplace its recipe names by its declared name), and one skill as items on Kiro.
  const superpowers = (await readContentFile(join(data, 'superpowers', 'content.json'))).content;
  const upstream = superpowers.sources.find(source => source.id === 'superpowers');
  const pinned = { source: 'superpowers', path: '/', plugin: 'superpowers', commit: upstream.commit };
  const superpowersPlan = planned('superpowers', { schema: 'urn:aihq:catalog:recipe:0.1.0', id: 'superpowers-plugins', kind: 'base', framework: 'superpowers',
    content: { repository: upstream.repository, commit: upstream.commit }, routes: { 'claude-code': 'plugin', codex: 'plugin', kiro: 'items' },
    plugins: { 'claude-code': pinned, codex: { ...pinned, marketplace: upstream.repository, marketplaceName: 'superpowers-dev' } },
    clis: { kiro: ['skill'] }, members: [{ item: 'superpowers.skill.brainstorming', preTicked: true }], data: dataPin },
  [superpowers], ['claude-code', 'codex', 'kiro'], { scope: 'user', source: recipeSource }, 'Superpowers as native plugins (Core test fixture)');
  assert.equal(superpowersPlan.status, 'ok', JSON.stringify(superpowersPlan).slice(0, 2000));
  assert.deepEqual(superpowersPlan.plan.filter(step => step.op === 'plugin').map(step => [step.cli, step.marketplaceName]),
    [['claude-code', 'aihq-superpowers'], ['codex', 'superpowers-dev']]);

  // EGM: Catalog's draft `egm-base` recipe at project scope.
  const egm = (await readContentFile(join(data, 'egm', 'content.json'))).content;
  const remaining = JSON.parse(readFileSync(join(catalogDir, 'port-report', 'remaining.json'), 'utf8'));
  const egmPlan = planned('egm', { schema: 'urn:aihq:catalog:recipe:0.1.0', data: dataPin, ...remaining.recipes['egm-base'] },
    [egm], ['antigravity', 'claude-code', 'codex'], { scope: 'project', source: recipeSource }, 'EGM, as Catalog drafts it (Core test fixture)');

  // The code-intelligence trio on linux-x64 with Catalog's qualifications.
  const aiSetup = JSON.parse(readFileSync(join(catalogDir, 'port-report', 'ai-setup.json'), 'utf8'));
  const tools = await Promise.all(['cbm', 'crg', 'serena'].map(async name => (await readContentFile(join(data, name, 'content.json'))).content));
  const trioDocument = { schema: 'urn:aihq:catalog:recipe:0.1.0', ...aiSetup.recipes[0], data: dataPin };
  const withAll = reader.planRecipe(trioDocument, tools, only(['claude-code', 'codex']), {}, { scope: 'project', source: recipeSource, cell: 'linux-x64', qualifications });
  const trioUsed = new Set([...usedBy(withAll), aiSetup.recipes[0].qualifications['linux-x64']]);
  // Only the qualifications the plan names (and the recipe's own) are kept: the plan is the same as with all of them.
  const trioQualifications = qualifications.filter(record => trioUsed.has(documentSha(record)));
  const trioPlan = planned('trio', trioDocument, tools, ['claude-code', 'codex'],
    { scope: 'project', source: recipeSource, cell: 'linux-x64', qualifications: trioQualifications }, 'The code-intelligence trio (Core test fixture)');
  assert.equal(trioPlan.status, 'ok', JSON.stringify(trioPlan).slice(0, 2000));
  assert.equal(canonical(trioPlan), canonical(withAll));
  // The trio copies only its three upstreams' licence notices; any other copied file stops the recording.
  const trioNotices = tools.flatMap(doc => doc.sources.filter(source => source.notices?.length).flatMap(noticeFiles));
  const trioFiles = [];
  for (const step of trioPlan.plan) if (step.from && !trioFiles.some(entry => entry.sourcePath === step.from.sourcePath && entry.sourceId === step.from.sourceId)) {
    const notice = trioNotices.find(entry => entry.sourceId === step.from.sourceId && entry.sourcePath === step.from.sourcePath);
    assert.ok(notice, JSON.stringify(step));
    trioFiles.push(notice);
  }

  // The upstream bytes the recipe plans copy, each checked against the content's sha256.
  const listedIn = (doc, sourceId, path) => doc.items.flatMap(item => [...(item.files ?? []), ...Object.values(item.editions ?? {}).flatMap(edition => edition.files ?? [])])
    .find(file => file.sourceId === sourceId && file.sourcePath === path) ??
    (doc.plugins ?? []).flatMap(plugin => plugin.sourceId === sourceId ? plugin.files ?? [] : []).find(file => file.sourcePath === path) ??
    (doc.bundles ?? []).flatMap(bundle => bundle.sourceId === sourceId ? bundle.files ?? [] : []).find(file => file.sourcePath === path) ??
    doc.sources.find(source => source.id === sourceId)?.notices?.find(notice => notice.sourcePath === path);
  const copied = (plan, sourceId) => [...new Set(plan.plan.filter(step => step.from?.sourceId === sourceId).map(step => step.from.sourcePath))].sort();
  const superpowersPaths = copied(superpowersPlan, 'superpowers');
  const egmPaths = copied(egmPlan, 'egm');
  assert.ok(superpowersPaths.includes('LICENSE') && egmPaths.includes('LICENSE'), 'each upstream LICENSE is kept with its files');
  const egmFixture = join(catalogDir, 'tests', 'fixtures', 'egm-403d8881');
  const recipeFiles = {
    superpowers: superpowersPaths.map(path => {
      const bytes = execFileSync('git', ['-C', superpowersGit, 'show', `${upstream.commit}:${path}`], { maxBuffer: 64 * 1_048_576 });
      const listed = listedIn(superpowers, 'superpowers', path);
      assert.equal(sha256(bytes), listed.sha256, path);
      return asRecorded('superpowers', path, listed.sha256, bytes);
    }),
    egm: egmPaths.map(path => {
      const bytes = readFileSync(join(egmFixture, ...path.split('/')));
      const listed = listedIn(egm, 'egm', path);
      assert.equal(sha256(bytes), listed.sha256, path);
      return asRecorded('egm', path, listed.sha256, bytes);
    }),
  };
  writeFileSync(join(here, 'recipe-files.json.gz'), gzipSync(`${JSON.stringify(recipeFiles)}\n`, { level: 9 }));
  recipes.superpowers.files = { upstream: upstream.repository, commit: upstream.commit, license: 'MIT', paths: superpowersPaths };
  const egmUpstream = egm.sources.find(source => source.id === 'egm');
  recipes.egm.files = { upstream: egmUpstream.repository, commit: egmUpstream.commit, license: 'Apache-2.0', paths: egmPaths };
  recipes.trio.files = trioFiles;

  const files = read.files.map(entry => ({ sourceId: FRAMEWORK, sourcePath: entry.path, sha256: entry.sha256,
    text: new TextDecoder().decode(entry.bytes) }));
  const renders = [];
  const seen = new Set();
  const asBytes = list => list.map(({ sourceId, sourcePath, text, base64 }) => ({ sourceId, sourcePath, bytes: text === undefined ?
    new Uint8Array(Buffer.from(base64, 'base64')) : encode(text) }));
  for (const [plan, docs, texts] of [...Object.values(plans).map(plan => [plan, [content], asBytes(files)]),
    ...Object.values(rulesPlans).map(plan => [plan, [rulesBuilt.content], asBytes(rulesFiles)]), ...Object.values(cbmPlans).map(plan => [plan, [cbm], asBytes(cbmFiles)]),
    [superpowersPlan, [superpowers], asBytes(recipeFiles.superpowers)], [egmPlan, [egm], asBytes(recipeFiles.egm)], [trioPlan, tools, asBytes(trioFiles)]]) for (const step of plan.plan) {
    if (!step.render || seen.has(canonical(step))) continue;
    seen.add(canonical(step));
    const source = step.from ? texts.find(entry => entry.sourceId === step.from.sourceId && entry.sourcePath === step.from.sourcePath) : undefined;
    const from = source ? [source] : [];
    const result = reader.renderStep(step, docs, profiles, from);
    renders.push({ step: canonical(step), result: result.status === 'ok' ?
      { status: 'ok', sha256: result.sha256, base64: Buffer.from(result.bytes).toString('base64') } : result });
  }
  const recorded = {
    producer: { package: '@aihq/catalog', version: manifest.version, repository: 'https://github.com/samartomar/aih-catalog', commit: COMMIT,
      tarballSha256, note: 'Real output of this unreleased Catalog candidate, recorded for Core tests; no client or qualification evidence.' },
    profiles: Object.fromEntries(Object.keys(toolProfiles).sort().map(id => [id, toolProfiles[id]])),
    byo: { content, files, plans, shipClashes, shipUnavailable },
    rules: { content: rulesBuilt.content, files: rulesFiles, plans: rulesPlans },
    cbm: { content: cbm, qualifications: cbmQualifications, plans: cbmPlans, files: cbmFiles },
    recipes,
    renders,
  };
  writeFileSync(join(here, 'recorded.json'), `${JSON.stringify(recorded, null, 1)}\n`);
  console.log(`recorded ${renders.length} renders; user ${plans.user.plan.length} steps, project ${plans.project.plan.length}, ` +
    `cbm ${Object.entries(cbmPlans).map(([cell, plan]) => `${cell} ${plan.plan.length}`).join(', ')}, ` +
    Object.entries(recipes).map(([name, recipe]) => `${name} ${recipe.plan.status} ${recipe.plan.plan.length}`).join(', ') +
    `; files superpowers ${superpowersPaths.length}, egm ${egmPaths.length}`);
} finally { rmSync(folder, { recursive: true, force: true }); }
