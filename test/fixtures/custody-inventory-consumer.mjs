// Runs inside a disposable consumer with the packed @aihq/core installed; public entries only.
// Custody migration, inventory 1.1.0, post-apply member checks and run result 1.4.0 members.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderDelivery, toolBindings } from '@aihq/core/harness';
import { contractSupport, runMemberClaims } from '@aihq/core/contracts';
import { apply, listManagedSelections, prepare, prepareManagedRemoval, resolveStateLocation } from '@aihq/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const plain = value => JSON.parse(JSON.stringify(value));
const FRAMEWORK = 'example-framework';
const BEHAVIOUR = 'aih-behaviour.json';
const INVENTORY_11 = 'urn:aihq:core:managed-inventory-result:1.1.0';
const SECRET = 'ghp_ConsumerSecretValue0123456789';
const USER_VALUE = 'person-owned-value-7c1d';

/** An independently built Catalog release item: content materials with bytes, one behaviour file, both identities. */
function catalogItem({ id, kind, payload, files, requirements = { inputs: {} } }) {
  const content = Object.entries(files).map(([relPath, text], index) => ({
    id: relPath === 'LICENSE' ? 'license' : `m${index}`, relPath, sourcePath: relPath,
    packagePath: `release/items/${id}/${relPath}`, sha256: sha256(text), byteLength: Buffer.byteLength(text),
    executable: false, sourceId: 'upstream', role: 'content',
    size: { bytes: Buffer.byteLength(text), chars: text.length, status: 'measured' } }));
  const dependencies = { requires: [], optional: [], conflicts: [] };
  const executableMap = Object.fromEntries(content.map(member => [member.relPath, member.executable]));
  const behaviourText = `${canonical({ kind, payload: payload ?? null, requirements, dependencies, executable: executableMap })}\n`;
  const behaviour = { id: 'behaviour', relPath: BEHAVIOUR, sourcePath: null, packagePath: `release/items/${id}/${BEHAVIOUR}`,
    sha256: sha256(behaviourText), byteLength: Buffer.byteLength(behaviourText), executable: false, sourceId: FRAMEWORK, role: 'behaviour' };
  const lines = members => members.map(member => `${member.relPath}\t${member.sha256}\n`).sort().join('');
  return { id, label: id, kind, sourceIds: ['upstream'], targets: [], scopes: ['project'], inputs: {},
    recipe: { id, schema: 'urn:aihq:core:recipe:1.0.0', path: `release/recipes/${id}.json`, sha256: sha256(`${id}-recipe`), byteLength: 900 },
    materials: [...content, behaviour].sort((a, b) => a.id < b.id ? -1 : 1), dependencies, requirements, executable: executableMap,
    contentSha256: sha256(lines(content)), behaviourSha256: sha256(lines([...content, behaviour])), payload, files };
}
const render = item => {
  const rendered = renderDelivery({ tool: 'claude', item, binding: toolBindings.find(entry => entry.tool === 'claude'), scope: 'project' });
  assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
  return rendered.recipe;
};
const itemRef = item => ({ framework: FRAMEWORK, itemId: item.id, contentSha256: item.contentSha256, behaviourSha256: item.behaviourSha256 });
const skill = catalogItem({ id: 'review', kind: 'skill', files: { 'SKILL.md': '---\nname: review\ndescription: Review code\n---\nReview carefully.\n', LICENSE: 'MIT\n' },
  payload: { dirName: 'code-review', invocation: 'model-allowed', invocationBasis: 'authored frontmatter' } });
const github = catalogItem({ id: 'github', kind: 'mcp-server', files: { LICENSE: 'MIT\n' },
  requirements: { inputs: { githubToken: { type: 'string', required: true, sensitive: true } } },
  payload: { key: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'github-mcp'], env: { GITHUB_TOKEN: { input: 'githubToken' } } } });
const starter = { reasonIncluded: 'in-set', set: { framework: FRAMEWORK, setId: 'starter', setSha256: sha256('starter') } };
const described = (selection, item, name, origins) => ({ ...selection, item: itemRef(item), tool: 'claude', name, kind: item.kind, origins });
const op = (id, kind, extra) => ({ id, purpose: `Apply ${id}`, kind, scope: 'project', requires: [], checks: [], ...extra });
const recipe = (id, operations, schema = 'urn:aihq:core:recipe:1.0.0') => ({ schema, id, description: id, inputs: {}, materials: [],
  targets: ['project'], prerequisites: [], checks: [], operations });
const policy = (schema, selections, extra = {}) => ({ schema: `urn:aihq:core:execution-policy:${schema}`, mode: 'vibe', selections, ...extra });
const approve = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const id of ['prepared-work/1.4.0', 'prepared-work/1.6.0', 'run-result/1.4.0', 'managed-inventory-result/1.1.0'])
  ajv.addSchema(JSON.parse(readFileSync(require.resolve(`@aihq/core/schemas/${id}.json`))));
const conforms = (document, id) => {
  const validate = ajv.getSchema(id);
  assert.equal(validate(plain(document)), true, `${id}: ${JSON.stringify(validate.errors)}`);
  return document;
};
const outputs = [];
const keep = value => { outputs.push(value); return value; };
async function run(project, document, controls = {}, extra = {}) {
  const prepared = keep(await prepare({ useCase: 'policy', policy: document, target: { project }, ...extra }, { logging: 'on', ...controls }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const result = keep(await apply(prepared.prepared, approve(prepared), { logging: 'on', ...controls }));
  if (result.schema === 'urn:aihq:core:run-result:1.4.0') conforms(result, result.schema);
  return { prepared, result };
}
const inventory = async (project, extra = {}) =>
  conforms(keep(await listManagedSelections({ target: { project }, scope: 'project', format: INVENTORY_11, ...extra })), INVENTORY_11);
function workspace(prefix) {
  const work = mkdtempSync(join(process.env.HOME, `${prefix}-`));
  const catalog = join(work, 'catalog'), project = join(work, 'project');
  mkdirSync(project);
  for (const item of [skill, github]) for (const member of item.materials.filter(entry => entry.role === 'content')) {
    mkdirSync(dirname(join(catalog, member.packagePath)), { recursive: true });
    writeFileSync(join(catalog, member.packagePath), item.files[member.relPath]);
  }
  return { catalog, project, controls: { materialRoots: { catalog } } };
}
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

await check('the package declares inventory 1.1.0 and run result 1.4.0 as produced contracts with schema and fixture exports', async () => {
  for (const id of [INVENTORY_11, 'urn:aihq:core:run-result:1.4.0']) {
    const contract = contractSupport.contracts.find(item => item.id === id);
    assert.equal(contract?.role, 'produces', id);
    assert.ok(existsSync(require.resolve(contract.schemaExport)));
    for (const fixture of contract.fixtures) assert.ok(existsSync(require.resolve(fixture.export)), fixture.export);
  }
});

const main = workspace('install');
await check('an install is confirmed on disk only from complete, written, present-matching member checks', async () => {
  const document = policy('1.4.0', [
    described({ id: 'review', managementId: 'catalog-review', scope: 'project', configuration: {}, requires: [], recipe: { inline: render(skill) } },
      skill, 'Code review', [{ reasonIncluded: 'chosen' }, starter]),
    described({ id: 'github', managementId: 'catalog-github', scope: 'project', configuration: {}, requires: [], recipe: { inline: render(github) } },
      github, 'GitHub', [starter])]);
  const { result } = await run(main.project, document, { ...main.controls, privateInputs: { github: { githubToken: SECRET } } });
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  assert.ok(result.members.length >= 3);
  assert.equal(result.members.every(member => member.intent === 'write' && member.outcome === 'written' && member.check === 'present-matching'), true);
  assert.deepEqual(runMemberClaims(result), { confirmedOnDisk: true, removed: false });
});

await check('inventory 1.1 reads names, origins, members and states from receipts alone, without the Catalog', async () => {
  rmSync(main.catalog, { recursive: true });
  const listed = await inventory(main.project, { index: { offered: [] } });
  assert.equal(listed.status, 'complete', JSON.stringify(listed.diagnostics));
  const byId = Object.fromEntries(listed.selections.map(entry => [entry.managementId, entry]));
  assert.deepEqual([byId['catalog-review'].name, byId['catalog-review'].framework, byId['catalog-review'].item, byId['catalog-review'].tool, byId['catalog-review'].kind],
    ['Code review', FRAMEWORK, itemRef(skill), 'claude', 'skill']);
  assert.deepEqual(byId['catalog-review'].origins, [{ reasonIncluded: 'chosen' }, starter], 'every qualified origin');
  assert.equal(byId['catalog-review'].updateState, 'no-longer-offered');
  assert.equal(byId['catalog-review'].approval, 'not-needed');
  assert.equal(byId['catalog-github'].approval, 'needed');
  assert.equal(listed.selections.every(entry => entry.installState === 'complete' && !('policyState' in entry)), true);
  assert.equal(listed.selections.flatMap(entry => entry.members).every(member => member.fileState === 'matches'), true);
  const current = await inventory(main.project, { index: { offered: [itemRef(skill), { ...itemRef(github), contentSha256: sha256('newer') }] } });
  assert.deepEqual(current.selections.map(entry => [entry.managementId, entry.updateState]), [['catalog-github', 'update-available'], ['catalog-review', 'current']]);
});

await check('a locally edited item reads changed', async () => {
  const listed = await inventory(main.project);
  const skillFile = listed.selections.find(entry => entry.managementId === 'catalog-review').members.find(member => member.path.endsWith('SKILL.md'));
  writeFileSync(skillFile.path, 'my own edit\n');
  const edited = (await inventory(main.project)).selections.find(entry => entry.managementId === 'catalog-review').members.find(member => member.path === skillFile.path);
  assert.equal(edited.fileState, 'changed');
});

await check('the custody migration keeps claims, set membership and dependency edges, and names them once described', async () => {
  const { project } = workspace('migration');
  const legacy = (id, operations, requires = []) => ({ id, managementId: `${id}-managed`, scope: 'project', configuration: {}, requires,
    recipe: { inline: recipe(id, operations, 'urn:aihq:core:recipe:1.3.0') } });
  const selections = [
    legacy('base', [op('file', 'file.write', { target: { root: 'project', segments: [{ literal: 'docs' }, { literal: 'BASE.md' }] }, content: { literal: 'base\n' } })]),
    legacy('notes', [op('block', 'text.block', { target: { root: 'project', segments: [{ literal: 'AGENTS.md' }] }, blockId: 'notes',
      startMarker: '<!-- aih:notes:start -->', endMarker: '<!-- aih:notes:end -->', action: 'set', content: { literal: 'Notes.\n' } })], ['base'])];
  const sets = [{ id: 'bundle', scope: 'project', members: ['base-managed', 'notes-managed'] }];
  await run(project, policy('1.3.0', selections, { managedSelections: sets }));
  const unnamed = await inventory(project);
  assert.deepEqual(unnamed.selections.map(entry => [entry.managementId, entry.name, entry.members.map(member => member.kind)]),
    [['base-managed', null, ['file']], ['notes-managed', null, ['text-block']]]);
  const named = selections.map(entry => ({ ...entry, item: { framework: FRAMEWORK, itemId: entry.id, contentSha256: sha256(entry.id), behaviourSha256: sha256(`${entry.id}!`) },
    tool: 'claude', name: `Item ${entry.id}`, kind: 'rule', origins: [{ reasonIncluded: 'in-set', set: { framework: FRAMEWORK, setId: 'bundle', setSha256: sha256('bundle') } }] }));
  const { result } = await run(project, policy('1.4.0', named, { managedSelections: sets }));
  assert.equal(result.operations.every(operation => operation.application === 'already-satisfied'), true, 'describing changes no target');
  const after = await inventory(project);
  assert.deepEqual(after.selections.map(entry => [entry.managementId, entry.name, entry.members.map(member => [member.kind, member.fileState])]),
    [['base-managed', 'Item base', [['file', 'matches']]], ['notes-managed', 'Item notes', [['text-block', 'matches']]]]);
  const retained = await prepareManagedRemoval({ target: { project }, managementId: 'base-managed', scope: 'project', mode: 'vibe' });
  assert.equal(retained.disposition, 'retained', 'the dependency edge survived the migration');
  const { result: removed } = await run(project, policy('1.4.0', [], { managedSelections: [{ id: 'bundle', scope: 'project', members: [] }] }));
  assert.deepEqual(runMemberClaims(removed), { confirmedOnDisk: false, removed: true }, 'the set record survived the migration');
  assert.deepEqual(removed.members.map(member => [member.kind, member.outcome, member.check]).sort(),
    [['file', 'claim-removed', 'absent'], ['text-block', 'claim-removed', 'absent']]);
});

await check('removal restores a replaced value to its pre-existing state and reports restored present-matching', async () => {
  const { project } = workspace('restore');
  const settings = join(project, 'settings.json');
  writeFileSync(settings, `${JSON.stringify({ tool: { mode: USER_VALUE } }, null, 2)}\n`);
  const selection = { id: 'mode', managementId: 'tool-mode', scope: 'project', configuration: {}, requires: [],
    recipe: { inline: recipe('mode', [op('entry', 'config.entries', { target: { root: 'project', segments: [{ literal: 'settings.json' }] },
      format: 'json', entries: [{ path: ['tool', 'mode'], action: 'set', value: { literal: 'aih' } }] })]) } };
  const resolutions = [{ selectionId: 'mode', operationId: 'entry', choice: 'replace', observedSha256: sha256(readFileSync(settings)) }];
  const { result: installed } = await run(project, policy('1.4.0', [selection]), {}, { resolutions });
  assert.deepEqual(installed.members.map(member => [member.outcome, member.check]), [['written', 'present-matching']]);
  const { result: removed } = await run(project, policy('1.4.0', [], { removals: [{ managementId: 'tool-mode', scope: 'project' }] }));
  assert.deepEqual(removed.members.map(member => [member.kind, member.pointer, member.intent, member.outcome, member.check]),
    [['config-entry', '/tool/mode', 'remove', 'restored', 'present-matching']]);
  assert.deepEqual(runMemberClaims(removed), { confirmedOnDisk: false, removed: true });
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { tool: { mode: USER_VALUE } });
});

await check('an incomplete run is never confirmed on disk and inventory reports it interrupted', async () => {
  const { project } = workspace('incomplete');
  const failing = { id: 'note', managementId: 'note', scope: 'project', configuration: {}, requires: [], item: { framework: FRAMEWORK, itemId: 'note',
    contentSha256: sha256('n'), behaviourSha256: sha256('b') }, tool: 'claude', name: 'Note', kind: 'document', origins: [{ reasonIncluded: 'chosen' }],
    recipe: { inline: { ...recipe('note', [op('file', 'file.write', { target: { root: 'project', segments: [{ literal: 'NOTE.md' }] },
      content: { literal: 'note\n' }, checks: ['digest'] })]), checks: [{ id: 'digest', kind: 'file.sha256', purpose: 'Check',
      target: { root: 'project', segments: [{ literal: 'NOTE.md' }] }, sha256: sha256('other') }] } } };
  const { result } = await run(project, policy('1.4.0', [failing]));
  assert.equal(result.completion, 'incomplete');
  assert.deepEqual(result.members.map(member => [member.outcome, member.check]), [['written', 'present-matching']], 'the written subset matches');
  assert.deepEqual(runMemberClaims(result), { confirmedOnDisk: false, removed: false });
  assert.equal((await inventory(project)).selections[0].installState, 'interrupted');
});

const PATH_SECRET = 'tok-consumer-path-6e3b';
await check('a private input value inside a member path is redacted in the run result and inventory', async () => {
  const { project } = workspace('private-path');
  const vault = { id: 'vault', managementId: 'vault', scope: 'project', configuration: {}, requires: [],
    recipe: { inline: { ...recipe('vault', [op('file', 'file.write', { target: { root: 'project', segments: [{ literal: 'vault' }, { input: 'name' }] },
      content: { literal: 'v\n' } })]), inputs: { name: { type: 'string', required: true, sensitive: true, maxLength: 64 } } } } };
  const { result } = await run(project, policy('1.4.0', [vault]), { privateInputs: { vault: { name: PATH_SECRET } } });
  assert.deepEqual(result.members.map(member => [member.path, member.check]), [[join(project, 'vault', '[REDACTED]'), 'present-matching']]);
  const listed = await inventory(project);
  assert.deepEqual(listed.selections[0].members.map(member => [member.path, member.fileState]), [[join(project, 'vault', '[REDACTED]'), 'matches']]);
});

await check('no input value, restoration value, member digest or private-input hash appears in any output, history or receipt', async () => {
  const { root } = resolveStateLocation();
  const recorded = ['runs', 'ownership'].flatMap(folder => existsSync(join(root, folder)) ?
    readdirSync(join(root, folder)).filter(name => name.endsWith('.json')).map(name => readFileSync(join(root, folder, name), 'utf8')) : []);
  assert.ok(recorded.length >= 8);
  const text = [...outputs.map(value => JSON.stringify(value)), ...recorded].join('\n');
  for (const forbidden of [SECRET, sha256(SECRET), USER_VALUE]) assert.equal(text.includes(forbidden), false);
  // Protected custody records the resolved path it manages; every published output and history record redacts it.
  const history = existsSync(join(root, 'runs')) ? readdirSync(join(root, 'runs')).map(name => readFileSync(join(root, 'runs', name), 'utf8')) : [];
  assert.equal([...outputs.map(value => JSON.stringify(value)), ...history].some(text => text.includes(PATH_SECRET)), false);
  const memberOutputs = outputs.filter(value => value?.schema === INVENTORY_11 || value?.schema === 'urn:aihq:core:run-result:1.4.0').map(value => JSON.stringify(value)).join('\n');
  assert.equal(memberOutputs.includes(sha256(skill.files['SKILL.md'])), false, 'no member digest');
  assert.equal(/"(sha256|preExisting|value-sha256)"/.test(JSON.stringify(outputs.filter(value => value?.schema === INVENTORY_11))), false, 'inventory carries no digest or restoration field');
});

process.stdout.write(`${JSON.stringify({ status: 'passed', checks })}\n`);
