// Records REAL @aihq/catalog output for Core's tests: the producer, planners and renders of the Catalog package built
// from samartomar/aih-catalog commit 6d9c54450f8ad7e00372728854fa0bf0a2cece7a (unreleased 0.1.0 candidate).
//
//   node test/fixtures/catalog-6d9c544/generate.mjs --consumer <folder with that @aihq/catalog installed> \
//     --tarball-sha256 <sha256 of the packed tarball> --data <aih-catalog checkout at that commit>/data //     --superpowers <Git checkout of obra/superpowers holding its pinned commit>
//
// `recorded.json` holds, byte for byte as Catalog returned them: a bring-your-own content document (built by
// `buildContent` from the small folder below), the nine shipped tool profiles, `planInstall` plans for it at user and
// project scope, every `renderStep` result those plans need, and the real codebase-memory-mcp (cbm) data plan on
// windows-x64, and a `planRecipe` plan of a local-plugin recipe over Catalog's Superpowers data for Claude Code (the recipe
// document is a Core-side FIXTURE; the plan is Catalog's). `recipe-files.json.gz` holds the Superpowers plugin folder's
// bytes at its pinned commit, read from Git (MIT, its LICENSE included). Core's tests replay the renders and that one
// `planRecipe` call instead of importing Catalog. This is real Catalog output for this
// candidate only: it says nothing about a released Catalog, a client loading the result, or a qualified AI setup.
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
const consumer = resolve(arg('--consumer')), data = resolve(arg('--data')), tarballSha256 = arg('--tarball-sha256');
const superpowersGit = resolve(arg('--superpowers'));
const COMMIT = '6d9c54450f8ad7e00372728854fa0bf0a2cece7a';
const packageDir = join(consumer, 'node_modules', '@aihq', 'catalog');
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const entry = name => import(pathToFileURL(join(packageDir, manifest.exports[name].import)).href);
const [{ toolProfiles }, { readLocalSource, readContentFile }, { buildContent }, reader, { findItems }] =
  await Promise.all(['./contracts', './node', './producer', './reader', './source'].map(entry));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const canonical = value => JSON.stringify(sorted(value));

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
  const encode = text => new TextEncoder().encode(text);
  const profiles = Object.keys(toolProfiles).sort().map(id => reader.readToolProfile(encode(toolProfiles[id])).profile);
  const ids = content.items.map(item => item.id);
  const plans = {
    user: reader.planInstall(ids, [content], profiles, { scope: 'user', data: null }),
    // `ship` is left out at project scope: its user-only renders differ in the one `.agents/skills` folder six
    // clients share, which Catalog reports as a clash (a plan Core refuses `plan-unresolved`).
    project: reader.planInstall(ids.filter(id => id !== `${FRAMEWORK}.skill.ship`), [content], profiles, { scope: 'project', data: null }),
  };
  for (const [scope, plan] of Object.entries(plans)) assert.ok(plan.plan && !plan.clashes.length, `${scope}: ${JSON.stringify(plan.clashes)}`);

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
    [name, reader.planInstall(ruleIds, [rulesBuilt.content], profiles.filter(profile => ids.includes(profile.id)), { scope: 'project', data: null })]));
  const rulesFiles = rulesRead.files.map(entry => ({ sourceId: RULES, sourcePath: entry.path, sha256: entry.sha256, text: new TextDecoder().decode(entry.bytes) }));

  // cbm: Catalog's own codebase-memory-mcp data, planned for every client on windows-x64 with its qualifications.
  const cbm = (await readContentFile(join(data, 'cbm', 'content.json'))).content;
  const qualifications = readdirSync(join(data, 'qualifications')).sort().map(name =>
    reader.readQualification(readFileSync(join(data, 'qualifications', name))).qualification);
  const dataPin = { repository: 'https://github.com/samartomar/aih-catalog', commit: COMMIT };
  const cbmPlan = reader.planInstall(cbm.items.map(item => item.id), [cbm], profiles,
    { scope: 'project', data: dataPin, cell: 'windows-x64', qualifications });
  assert.ok(cbmPlan.plan, JSON.stringify(cbmPlan));
  const used = cbmPlan.plan.filter(step => step.qualification).map(step => step.qualification);
  // The one source file the cbm plan copies (its licence notice), read from the pinned upstream commit.
  const cbmSource = cbm.sources[0];
  const cbmFiles = await Promise.all(cbmSource.notices.map(async notice => {
    const url = `${cbmSource.repository.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/${cbmSource.commit}/${notice.sourcePath}`;
    const text = await (await fetch(url)).text();
    assert.equal(sha256(encode(text)), notice.sha256, url);
    return { sourceId: cbmSource.id, sourcePath: notice.sourcePath, sha256: notice.sha256, text };
  }));
  const cbmQualifications = qualifications.filter(record => used.includes(sha256(encode(`${JSON.stringify(sorted(record), null, 2)}\n`))));

  // A local-plugin recipe over Catalog's Superpowers data: Claude Code copies the pinned plugin folder as one unit.
  const superpowers = (await readContentFile(join(data, 'superpowers', 'content.json'))).content;
  const upstream = superpowers.sources.find(source => source.id === 'superpowers');
  const recipeDocument = { schema: 'urn:aihq:catalog:recipe:0.1.0', id: 'superpowers-local', kind: 'base', framework: 'superpowers',
    content: { repository: upstream.repository, commit: upstream.commit }, routes: { 'claude-code': 'local-plugin' },
    plugins: { 'claude-code': { source: 'superpowers', path: '/', plugin: 'superpowers', commit: upstream.commit, marketplace: 'superpowers-dev' } },
    members: superpowers.items.filter(item => item.kind === 'skill').map(item => ({ item: item.id, preTicked: true })), data: dataPin };
  // The recipe file in Catalog's canonical form (sorted keys, two-space indent): its sha256 is the recipe's identity.
  const recipeJson = `${JSON.stringify(sorted(recipeDocument), null, 2)}\n`;
  const pluginJson = `${JSON.stringify({ name: 'superpowers-local', version: '0.1.0', description: 'Superpowers as a local plugin (Core test fixture)',
    author: { name: 'AIH Core tests' }, license: 'MIT', keywords: ['fixture'] }, null, 2)}\n`;
  assert.equal(reader.readRecipe(encode(pluginJson), encode(recipeJson)).status, 'ok');
  const recipeProfiles = profiles.filter(profile => profile.id === 'claude-code');
  // Exactly the call Core makes to prove the origin (the parsed recipe.json, the request's contents and profiles).
  const recipeOptions = { scope: 'project', source: { repository: 'https://github.com/example/superpowers-local-recipe', commit: 'a'.repeat(40) } };
  const recipePlan = reader.planRecipe(JSON.parse(recipeJson), [superpowers], recipeProfiles, {}, recipeOptions);
  assert.equal(recipePlan.status, 'ok', JSON.stringify(recipePlan).slice(0, 2000));
  const named = [...new Set(recipePlan.plan.filter(step => step.from?.sourceId === 'superpowers').map(step => step.from.sourcePath))].sort();
  const recipeFiles = named.map(path => {
    const bytes = execFileSync('git', ['-C', superpowersGit, 'show', `${upstream.commit}:${path}`], { maxBuffer: 64 * 1_048_576 });
    const listed = superpowers.plugins[0].files.find(file => file.sourcePath === path) ?? upstream.notices.find(notice => notice.sourcePath === path);
    assert.equal(sha256(bytes), listed.sha256, path);
    // UTF-8 text as text (it compresses far better), any other bytes as base64.
    const text = bytes.toString('utf8');
    return { sourceId: 'superpowers', sourcePath: path, sha256: listed.sha256,
      ...(Buffer.from(text, 'utf8').equals(bytes) ? { text } : { base64: bytes.toString('base64') }) };
  });
  writeFileSync(join(here, 'recipe-files.json.gz'), gzipSync(`${JSON.stringify(recipeFiles)}\n`, { level: 9 }));

  const files = read.files.map(entry => ({ sourceId: FRAMEWORK, sourcePath: entry.path, sha256: entry.sha256,
    text: new TextDecoder().decode(entry.bytes) }));
  const renders = [];
  const seen = new Set();
  for (const [plan, docs, texts] of [...Object.values(plans).map(plan => [plan, content, files]),
    ...Object.values(rulesPlans).map(plan => [plan, rulesBuilt.content, rulesFiles])]) for (const step of plan.plan) {
    if (!step.render || seen.has(canonical(step))) continue;
    seen.add(canonical(step));
    const from = step.from ? [{ sourceId: step.from.sourceId, sourcePath: step.from.sourcePath,
      bytes: encode(texts.find(entry => entry.sourcePath === step.from.sourcePath).text) }] : [];
    const result = reader.renderStep(step, [docs], profiles, from);
    renders.push({ step: canonical(step), result: result.status === 'ok' ?
      { status: 'ok', sha256: result.sha256, base64: Buffer.from(result.bytes).toString('base64') } : result });
  }
  const recorded = {
    producer: { package: '@aihq/catalog', version: manifest.version, repository: 'https://github.com/samartomar/aih-catalog', commit: COMMIT,
      tarballSha256, note: 'Real output of this unreleased Catalog candidate, recorded for Core tests; no client or qualification evidence.' },
    profiles: Object.fromEntries(Object.keys(toolProfiles).sort().map(id => [id, toolProfiles[id]])),
    byo: { content, files, plans },
    rules: { content: rulesBuilt.content, files: rulesFiles, plans: rulesPlans },
    cbm: { content: cbm, qualifications: cbmQualifications, plan: cbmPlan, files: cbmFiles },
    recipe: { content: superpowers, pluginJson, recipeJson, choices: {}, options: recipeOptions, profiles: recipeProfiles.map(profile => profile.id), plan: recipePlan },
    renders,
  };
  writeFileSync(join(here, 'recorded.json'), `${JSON.stringify(recorded, null, 1)}\n`);
  console.log(`recorded ${renders.length} renders; user ${plans.user.plan.length} steps, project ${plans.project.plan.length}, cbm ${cbmPlan.plan.length}`);
} finally { rmSync(folder, { recursive: true, force: true }); }
