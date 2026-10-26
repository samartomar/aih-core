// Runs inside a disposable consumer with the packed @aihq/core installed; public entries only.
// Managed update preparation 1.0.0: an update to a replacement the consumer supplies, reviewed before Apply, keeping the
// management id and every local edit as a conflict that is never overwritten.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderDelivery, toolBindings } from '@aihq/core/harness';
import { contractSupport, runMemberClaims } from '@aihq/core/contracts';
import { apply, listManagedSelections, prepare, prepareUpdate, resolveStateLocation } from '@aihq/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { basename, dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const FRAMEWORK = 'example-framework';
const BEHAVIOUR = 'aih-behaviour.json';
const INVENTORY_11 = 'urn:aihq:core:managed-inventory-result:1.1.0';
const UPDATE_10 = 'urn:aihq:core:managed-update-preparation:1.0.0';

/** An independently built Catalog release item: content materials with bytes, one behaviour file, both identities. */
function catalogItem({ id, kind, payload, files, requirements = { inputs: {} } }) {
  const content = Object.entries(files).map(([relPath, text], index) => ({
    id: `m${index}`, relPath, sourcePath: relPath,
    // Each release keeps its own bytes, so two versions of one item can sit in one Catalog.
    packagePath: `release/${sha256(text).slice(0, 12)}/items/${id}/${relPath}`, sha256: sha256(text), byteLength: Buffer.byteLength(text),
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
const skillItem = (id, version, files) => catalogItem({ id, kind: 'skill',
  files: { 'SKILL.md': `---\nname: ${id}\ndescription: Skill ${id} ${version}\n---\nDo ${id} ${version}.\n`, LICENSE: `MIT for ${id}\n`, ...files },
  payload: { dirName: id, invocation: 'model-allowed', invocationBasis: 'authored frontmatter' } });
const claude = toolBindings.find(entry => entry.tool === 'claude');
const render = item => {
  const rendered = renderDelivery({ tool: 'claude', item, binding: claude, scope: 'project' });
  assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
  return rendered.recipe;
};
const itemRef = item => ({ framework: FRAMEWORK, itemId: item.id, contentSha256: item.contentSha256, behaviourSha256: item.behaviourSha256 });
const selectionOf = (item, origins, extra = {}) => ({ id: item.id, managementId: `${item.id}-managed`, scope: 'project', configuration: {}, requires: [],
  recipe: { inline: render(item) }, item: itemRef(item), tool: 'claude', name: `Item ${item.id}`, kind: item.kind, origins, ...extra });
const policy = (selections, extra = {}) => ({ schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections, ...extra });
const approve = (review, allowPartial) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...(allowPartial ? { allowPartial } : {}) });

const outputs = [];
const keep = value => { outputs.push(value); return value; };
async function install(project, document, controls = {}) {
  const prepared = keep(await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'on', ...controls }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const result = keep(await apply(prepared.prepared, approve(prepared.review), { logging: 'on', ...controls }));
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  return result;
}
const update = async (project, updates, controls = {}) =>
  keep(await prepareUpdate({ target: { project }, scope: 'project', updates }, { logging: 'on', ...controls }));
const inventory = async project => keep(await listManagedSelections({ target: { project }, scope: 'project', format: INVENTORY_11 }));
const rowOf = (preview, managementId) => preview.updates.find(entry => entry.managementId === managementId);
const actions = row => row.members.map(member => [basename(member.path), member.kind, member.action, member.reason ?? null]).sort();
function workspace(prefix, items) {
  const work = mkdtempSync(join(process.env.HOME, `${prefix}-`));
  const catalog = join(work, 'catalog'), project = join(work, 'project');
  mkdirSync(project);
  for (const item of items) for (const member of item.materials.filter(entry => entry.role === 'content')) {
    mkdirSync(dirname(join(catalog, member.packagePath)), { recursive: true });
    writeFileSync(join(catalog, member.packagePath), item.files[member.relPath]);
  }
  return { catalog, project, controls: { materialRoots: { catalog } } };
}
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const id of ['prepared-work/1.0.0', 'prepared-work/1.1.0', 'prepared-work/1.4.0', 'prepared-work/1.5.0', 'prepared-work/1.6.0', 'run-result/1.0.0', 'run-result/1.1.0',
  'run-result/1.4.0', 'managed-update-preparation/1.0.0'])
  ajv.addSchema(JSON.parse(readFileSync(require.resolve(`@aihq/core/schemas/${id}.json`))));
// An update preparation's JSON projection omits the live Apply handle.
const projection = document => document?.preparation?.prepared ? { ...document, preparation: (({ prepared: _handle, ...rest }) => rest)(document.preparation) } : document;

await check('the package declares managed update preparation 1.0.0 as a produced contract with its schema and fixtures', async () => {
  const contract = contractSupport.contracts.find(item => item.id === UPDATE_10);
  assert.equal(contract?.role, 'produces');
  assert.ok(existsSync(require.resolve(contract.schemaExport)));
  assert.ok(contract.fixtures.length > 0);
  for (const fixture of contract.fixtures) assert.ok(existsSync(require.resolve(fixture.export)), fixture.export);
});

const chosen = [{ reasonIncluded: 'chosen' }];
const v1 = skillItem('notes', 'v1', { 'ref.md': 'Reference v1.\n', 'old.md': 'Old page.\n' });
const v2 = skillItem('notes', 'v2', { 'ref.md': 'Reference v2.\n', 'new.md': 'New page.\n' });

await check('an explicit replacement updates through one review, keeping the management id and a local edit as a conflict', async () => {
  const { project, controls } = workspace('replace', [v1, v2]);
  await install(project, policy([selectionOf(v1, chosen)]), controls);
  const skillDir = join(project, '.claude', 'skills', 'notes');
  writeFileSync(join(skillDir, 'ref.md'), 'My own notes.\n');
  const preview = await update(project, [{ managementId: 'notes-managed', replacement: selectionOf(v2, chosen) }], controls);
  assert.equal(preview.schema, 'urn:aihq:core:managed-update-preparation:1.0.0');
  assert.equal(preview.disposition, 'prepared', JSON.stringify(preview));
  assert.equal(preview.preparation.status, 'partial', 'the local edit is a conflict, so only the rest is reviewable');
  assert.equal(preview.reviewDigest, preview.preparation.review.reviewDigest, 'one review digest binds every listed member');
  const row = rowOf(preview, 'notes-managed');
  assert.deepEqual([row.disposition, row.from.item, row.to.item], ['prepared', itemRef(v1), itemRef(v2)]);
  assert.deepEqual(actions(row), [['LICENSE', 'file', 'unchanged', null], ['SKILL.md', 'file', 'replace', null], ['new.md', 'file', 'add', null],
    ['old.md', 'file', 'conflict', 'depends-on-conflict'], ['ref.md', 'file', 'conflict', 'managed-content-changed']]);
  // Without explicit partial approval nothing runs; with it, the edit stays exactly as the person left it.
  const refused = keep(await apply(preview.preparation.prepared, approve(preview.preparation.review), { logging: 'on' }));
  assert.equal(refused.completion, 'rejected');
  assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), v1.files['SKILL.md']);
  const again = await update(project, [{ managementId: 'notes-managed', replacement: selectionOf(v2, chosen) }], controls);
  const run = keep(await apply(again.preparation.prepared, approve(again.preparation.review, true), { logging: 'on', ...controls }));
  assert.equal(run.authorization.reviewDigest, again.reviewDigest);
  assert.deepEqual(Object.fromEntries(['SKILL.md', 'LICENSE', 'ref.md', 'new.md'].map(name => [name, readFileSync(join(skillDir, name), 'utf8')])),
    { 'SKILL.md': v2.files['SKILL.md'], LICENSE: v2.files.LICENSE, 'ref.md': 'My own notes.\n', 'new.md': v2.files['new.md'] });
  // Cleanup of the page v2 no longer delivers waits for every operation of the selection, so it stays too.
  assert.equal(readFileSync(join(skillDir, 'old.md'), 'utf8'), v1.files['old.md']);
  assert.equal(run.completion, 'incomplete', 'a run that left a conflict is never complete');
  const written = run.members.filter(member => member.intent === 'write' && member.outcome === 'written').map(member => basename(member.path)).sort();
  assert.deepEqual(written, ['LICENSE', 'SKILL.md', 'new.md']);
  assert.equal(run.members.filter(member => member.outcome === 'written' || member.outcome === 'claim-removed').every(member =>
    member.check === (member.outcome === 'written' ? 'present-matching' : 'absent')), true);
  const listed = (await inventory(project)).selections.find(entry => entry.managementId === 'notes-managed');
  // Custody records the replacement with the written members; the kept edit reads changed and the held page stays listed.
  assert.deepEqual([listed.item, listed.origins], [itemRef(v2), chosen]);
  assert.deepEqual(listed.members.map(member => [basename(member.path), member.fileState]).sort(),
    [['LICENSE', 'matches'], ['SKILL.md', 'matches'], ['new.md', 'matches'], ['old.md', 'matches'], ['ref.md', 'changed']]);
});

await check('without local edits the update completes and its exact changes are confirmed on disk', async () => {
  const { project, controls } = workspace('clean', [v1, v2]);
  await install(project, policy([selectionOf(v1, chosen)]), controls);
  const skillDir = join(project, '.claude', 'skills', 'notes');
  const preview = await update(project, [{ managementId: 'notes-managed', replacement: selectionOf(v2, chosen) }], controls);
  assert.equal(preview.preparation.status, 'ready');
  assert.deepEqual(actions(rowOf(preview, 'notes-managed')), [['LICENSE', 'file', 'unchanged', null], ['SKILL.md', 'file', 'replace', null],
    ['new.md', 'file', 'add', null], ['old.md', 'file', 'remove', null], ['ref.md', 'file', 'replace', null]]);
  const run = keep(await apply(preview.preparation.prepared, approve(preview.preparation.review), { logging: 'on', ...controls }));
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.deepEqual(runMemberClaims(run), { confirmedOnDisk: true, removed: true });
  assert.deepEqual(readdirSync(skillDir).sort(), ['LICENSE', 'SKILL.md', 'new.md', 'ref.md']);
  for (const name of ['LICENSE', 'SKILL.md', 'new.md', 'ref.md']) assert.equal(readFileSync(join(skillDir, name), 'utf8'), v2.files[name], name);
  const listed = (await inventory(project)).selections;
  assert.deepEqual(listed.map(entry => [entry.managementId, entry.item, entry.origins, entry.installState]), [['notes-managed', itemRef(v2), chosen, 'complete']],
    'the same management id now records the replacement');
});

await check('a change between the preview and Apply refuses the update safely and writes nothing', async () => {
  const { project, controls } = workspace('stale', [v1, v2]);
  await install(project, policy([selectionOf(v1, chosen)]), controls);
  const skillDir = join(project, '.claude', 'skills', 'notes');
  const preview = await update(project, [{ managementId: 'notes-managed', replacement: selectionOf(v2, chosen) }], controls);
  assert.equal(preview.preparation.status, 'ready');
  writeFileSync(join(skillDir, 'SKILL.md'), 'Edited after the preview.\n');
  const stale = keep(await apply(preview.preparation.prepared, approve(preview.preparation.review), { logging: 'on', ...controls }));
  assert.deepEqual([stale.completion, stale.diagnostics.map(item => [item.code, item.reason, item.changed])],
    ['rejected', [['REVIEW_STALE', 'binding-changed', 'target-file']]]);
  assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), 'Edited after the preview.\n');
  assert.equal(existsSync(join(skillDir, 'new.md')), false);
  // Custody that changes after the preview (here another install) is also a stale binding.
  const fresh = await update(project, [{ managementId: 'notes-managed', replacement: selectionOf(v2, chosen) }], controls);
  const other = skillItem('other', 'v1', {});
  const extra = workspace('stale-other', [other]);
  await install(project, policy([selectionOf(other, chosen)]), extra.controls);
  const moved = keep(await apply(fresh.preparation.prepared, approve(fresh.preparation.review, true), { logging: 'on', ...controls }));
  assert.deepEqual([moved.completion, moved.diagnostics.map(item => [item.code, item.reason, item.changed])],
    ['rejected', [['REVIEW_STALE', 'binding-changed', 'ownership']]]);
  assert.equal(existsSync(join(skillDir, 'new.md')), false);
  // An authorization naming another review never applies this one.
  const third = await update(project, [{ managementId: 'notes-managed', replacement: selectionOf(v2, chosen) }], controls);
  const mismatch = keep(await apply(third.preparation.prepared, approve(fresh.preparation.review, true), { logging: 'on', ...controls }));
  assert.deepEqual(mismatch.diagnostics.map(item => [item.code, item.reason]), [['REVIEW_STALE', 'digest-mismatch']]);
});

await check('several updates in one review keep a disposition each, and leave every other selection alone', async () => {
  const alpha1 = skillItem('alpha', 'v1', {}), alpha2 = skillItem('alpha', 'v2', {});
  const beta1 = skillItem('beta', 'v1', { 'beta.md': 'Beta v1.\n' }), beta2 = skillItem('beta', 'v2', { 'beta.md': 'Beta v2.\n' });
  const gamma = skillItem('gamma', 'v1', {}), other = skillItem('other', 'v1', {});
  const { project, controls } = workspace('mixed', [alpha1, alpha2, beta1, beta2, gamma, other]);
  const setA = { reasonIncluded: 'in-set', set: { framework: FRAMEWORK, setId: 'team', setSha256: sha256('team-1') } };
  const setA2 = { reasonIncluded: 'in-set', set: { framework: FRAMEWORK, setId: 'team', setSha256: sha256('team-2') } };
  await install(project, policy([selectionOf(alpha1, [setA]), selectionOf(beta1, [setA, ...chosen]), selectionOf(gamma, chosen)]), controls);
  const gammaBytes = readFileSync(join(project, '.claude', 'skills', 'gamma', 'SKILL.md'), 'utf8');
  const preview = await update(project, [
    { managementId: 'beta-managed', replacement: selectionOf(beta2, [setA2, ...chosen]) },
    { managementId: 'ghost-managed', replacement: selectionOf(other, chosen, { id: 'ghost', managementId: 'ghost-managed' }) },
    { managementId: 'alpha-managed', replacement: selectionOf(alpha2, [setA2]) },
    { managementId: 'gamma-managed', replacement: selectionOf(other, chosen, { id: 'gamma-other', managementId: 'gamma-managed' }) }], controls);
  assert.equal(preview.disposition, 'prepared');
  assert.deepEqual(preview.updates.map(entry => [entry.managementId, entry.disposition, entry.diagnostics.map(item => item.reason)]),
    [['beta-managed', 'prepared', []], ['ghost-managed', 'absent', ['not-managed']], ['alpha-managed', 'prepared', []],
      ['gamma-managed', 'invalid', ['replacement-item-changed']]], 'in request order');
  assert.deepEqual(rowOf(preview, 'beta-managed').to.origins, [setA2, ...chosen], 'the replacement carries its own qualified origins');
  assert.deepEqual(rowOf(preview, 'beta-managed').from.origins, [setA, ...chosen]);
  assert.deepEqual(preview.preparation.review.selections.map(item => [item.selectionId, item.managementId]), [['beta', 'beta-managed'], ['alpha', 'alpha-managed']]);
  assert.equal(rowOf(preview, 'ghost-managed').members.length + rowOf(preview, 'gamma-managed').members.length, 0);
  const run = keep(await apply(preview.preparation.prepared, approve(preview.preparation.review), { logging: 'on', ...controls }));
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.deepEqual(new Set(run.members.map(member => member.managementId)), new Set(['alpha-managed', 'beta-managed']));
  assert.equal(readFileSync(join(project, '.claude', 'skills', 'beta', 'beta.md'), 'utf8'), beta2.files['beta.md']);
  assert.equal(readFileSync(join(project, '.claude', 'skills', 'gamma', 'SKILL.md'), 'utf8'), gammaBytes);
  assert.equal(existsSync(join(project, '.claude', 'skills', 'other')), false, 'neither the absent nor the refused update installs anything');
  const listed = (await inventory(project)).selections;
  assert.deepEqual(listed.map(entry => [entry.managementId, entry.item.contentSha256, entry.origins]), [
    ['alpha-managed', alpha2.contentSha256, [setA2]], ['beta-managed', beta2.contentSha256, [setA2, ...chosen]], ['gamma-managed', gamma.contentSha256, chosen]]);
  // Nothing to update is not-prepared, with no preparation to apply.
  const none = await update(project, [{ managementId: 'ghost-managed', replacement: selectionOf(other, chosen, { id: 'ghost', managementId: 'ghost-managed' }) }], controls);
  assert.deepEqual([none.disposition, Object.hasOwn(none, 'preparation')], ['not-prepared', false]);
});

await check('an update that would change its management id, its scope or name one selection twice is refused whole', async () => {
  const { project, controls } = workspace('refused', [v1, v2]);
  await install(project, policy([selectionOf(v1, chosen)]), controls);
  const replacement = selectionOf(v2, chosen);
  for (const [updates, reason] of [
    [[{ managementId: 'notes-managed', replacement: { ...replacement, managementId: 'notes-v2' } }], 'management-id-changed'],
    [[{ managementId: 'notes-managed', replacement: { ...replacement, scope: 'user' } }], 'scope-changed'],
    [[{ managementId: 'notes-managed', replacement }, { managementId: 'notes-managed', replacement: { ...replacement, id: 'again' } }], 'update-conflict'],
    [[], 'request-shape'], [[{ managementId: 'notes-managed' }], 'request-shape']]) {
    const refused = await update(project, updates, controls);
    assert.deepEqual([refused.disposition, refused.diagnostics.map(item => item.reason), Object.hasOwn(refused, 'updates')], ['invalid', [reason], false]);
  }
  const resolution = keep(await prepareUpdate({ target: { project }, scope: 'project', updates: [{ managementId: 'notes-managed', replacement }],
    resolutions: [] }, controls));
  assert.deepEqual([resolution.disposition, resolution.diagnostics.map(item => item.reason)], ['invalid', ['request-shape']], 'an update accepts no overwrite resolution');
  assert.equal(readFileSync(join(project, '.claude', 'skills', 'notes', 'SKILL.md'), 'utf8'), v1.files['SKILL.md']);
});

const SECRET = 'ghp_UpdateConsumerSecret0123456789';
const PATH_SECRET = 'tok-update-path-7d1e';
const server = (version, args) => catalogItem({ id: 'github', kind: 'mcp-server', files: { LICENSE: `MIT ${version}\n` },
  requirements: { inputs: { githubToken: { type: 'string', required: true, sensitive: true } } },
  payload: { key: 'github', transport: 'stdio', command: 'npx', args, env: { GITHUB_TOKEN: { input: 'githubToken' } } } });
const github1 = server('v1', ['-y', 'github-mcp@1']), github2 = server('v2', ['-y', 'github-mcp@2']);
const approved = item => selectionOf(item, chosen, { recipe: { inline: renderDelivery({ tool: 'claude', item, binding: claude, scope: 'project',
  grantApproval: { framework: FRAMEWORK, itemId: 'github' } }).recipe } });

await check('an update keeps one-server approval semantics and never re-grants an approval the person took back', async () => {
  const { project, controls } = workspace('approval', [github1, github2]);
  const secrets = { ...controls, privateInputs: { github: { githubToken: SECRET } } };
  const settings = join(project, '.claude', 'settings.local.json');
  await install(project, policy([approved(github1)]), secrets);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).enabledMcpjsonServers, ['github']);
  const preview = await update(project, [{ managementId: 'github-managed', replacement: approved(github2) }], secrets);
  assert.equal(preview.preparation.status, 'ready', JSON.stringify(preview.preparation.diagnostics));
  const row = rowOf(preview, 'github-managed');
  assert.deepEqual(row.members.filter(member => member.approval).map(member => [member.kind, member.pointer, member.approval, member.action]),
    [['config-member', '/enabledMcpjsonServers', { tool: 'claude' }, 'unchanged']]);
  assert.equal(row.members.some(member => member.path.endsWith('.mcp.json') && member.action === 'replace'), true, 'the server command changes');
  const run = keep(await apply(preview.preparation.prepared, approve(preview.preparation.review), { logging: 'on', ...secrets }));
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.deepEqual(JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8')).mcpServers.github.args, ['-y', 'github-mcp@2']);
  // The person takes the approval back in the tool; a later update reports that as a conflict and leaves it.
  writeFileSync(settings, '{\n  "enabledMcpjsonServers": []\n}\n');
  const later = await update(project, [{ managementId: 'github-managed', replacement: approved(github1) }], secrets);
  const taken = rowOf(later, 'github-managed').members.find(member => member.approval);
  assert.deepEqual([taken.action, taken.reason], ['conflict', 'managed-content-changed']);
  keep(await apply(later.preparation.prepared, approve(later.preparation.review, true), { logging: 'on', ...secrets }));
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).enabledMcpjsonServers, [], 'never re-granted');
});

await check('a private input value inside a member path stays redacted in the update preview', async () => {
  const { project } = workspace('private-path', []);
  const vault = content => ({ id: 'vault', managementId: 'vault', scope: 'project', configuration: {}, requires: [],
    recipe: { inline: { schema: 'urn:aihq:core:recipe:1.3.0', id: 'vault', description: 'vault', materials: [], targets: ['project'], prerequisites: [], checks: [],
      inputs: { name: { type: 'string', required: true, sensitive: true, maxLength: 64 } },
      operations: [{ id: 'file', purpose: 'Write', kind: 'file.write', scope: 'project', target: { root: 'project', segments: [{ literal: 'vault' }, { input: 'name' }] },
        content: { literal: content }, requires: [], checks: [] }] } } });
  const secrets = { privateInputs: { vault: { name: PATH_SECRET } } };
  await install(project, policy([vault('v1\n')]), secrets);
  const preview = await update(project, [{ managementId: 'vault', replacement: vault('v2\n') }], secrets);
  assert.deepEqual(rowOf(preview, 'vault').members.map(member => [member.path, member.action]), [[join(project, 'vault', '[REDACTED]'), 'replace']]);
  const run = keep(await apply(preview.preparation.prepared, approve(preview.preparation.review), { logging: 'on', ...secrets }));
  assert.equal(run.completion, 'complete');
  assert.equal(readFileSync(join(project, 'vault', PATH_SECRET), 'utf8'), 'v2\n');
});

await check('every update output conforms to its published schema, and no input value or private path appears in any output or history', async () => {
  const { root } = resolveStateLocation();
  const history = existsSync(join(root, 'runs')) ? readdirSync(join(root, 'runs')).map(name => readFileSync(join(root, 'runs', name), 'utf8')) : [];
  assert.ok(history.length >= 8);
  const text = [...outputs.map(value => JSON.stringify(value)), ...history].join('\n');
  for (const forbidden of [SECRET, sha256(SECRET), PATH_SECRET]) assert.equal(text.includes(forbidden), false, forbidden);
  for (const document of outputs) {
    const id = document?.schema === UPDATE_10 ? UPDATE_10 : document?.schema === 'urn:aihq:core:run-result:1.4.0' ? document.schema : undefined;
    if (!id) continue;
    const validate = ajv.getSchema(id);
    assert.equal(validate(JSON.parse(JSON.stringify(projection(document)))), true, `${id}: ${JSON.stringify(validate.errors)}`);
  }
  assert.ok(outputs.filter(value => value?.schema === UPDATE_10).length >= 12);
  const updates = outputs.filter(value => value?.schema === UPDATE_10).map(value => JSON.stringify(value.updates ?? [])).join('\n');
  assert.equal(/"(sha256|preExisting|value-sha256)"/.test(updates), false, 'member rows carry no digest or restoration field');
});

process.stdout.write(`${JSON.stringify({ status: 'passed', checks })}\n`);
