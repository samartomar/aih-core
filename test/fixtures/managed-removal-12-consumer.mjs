// Runs inside a disposable consumer with the packed @aihq/core installed; public entries only.
// Removal preparation 1.2.0: removal by qualified origin, named member actions, several removals in one review,
// and "removed" only from run result 1.4 member checks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderDelivery, toolBindings } from '@aihq/core/harness';
import { contractSupport, removalClaims, runMemberClaims } from '@aihq/core/contracts';
import { apply, listManagedSelections, prepare, prepareManagedRemoval, resolveStateLocation } from '@aihq/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { basename, dirname, join } from 'node:path';

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
const REMOVAL_12 = 'urn:aihq:core:managed-removal-preparation:1.2.0';
const SECRET = 'ghp_RemovalConsumerSecret0123456789';
const USER_VALUE = 'person-owned-value-41ab';
const PATH_SECRET = 'tok-removal-path-9f2c';

/** An independently built Catalog release item: content materials with bytes, one behaviour file, both identities. */
function catalogItem({ id, kind, payload, files, requirements = { inputs: {} } }) {
  const content = Object.entries(files).map(([relPath, text], index) => ({
    id: `m${index}`, relPath, sourcePath: relPath,
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
const skillItem = (id, extra = {}) => catalogItem({ id, kind: 'skill',
  files: { 'SKILL.md': `---\nname: ${id}\ndescription: Skill ${id}\n---\nDo ${id}.\n`, LICENSE: `MIT for ${id}\n`, ...extra },
  payload: { dirName: id, invocation: 'model-allowed', invocationBasis: 'authored frontmatter' } });
const github = catalogItem({ id: 'github', kind: 'mcp-server', files: { LICENSE: 'MIT\n' },
  requirements: { inputs: { githubToken: { type: 'string', required: true, sensitive: true } } },
  payload: { key: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'github-mcp'], env: { GITHUB_TOKEN: { input: 'githubToken' } } } });
const claude = toolBindings.find(entry => entry.tool === 'claude');
// A binding whose MCP approval location is object-keyed; its digest is recomputed as a binding publisher would.
const objectKeyed = (() => {
  const { digest: _digest, ...binding } = plain(claude);
  binding.layouts['mcp-server'].register.approvalLocation = { shape: 'object-keyed', file: '.claude/approvals.json', format: 'json',
    container: ['mcpServerApprovals'], approved: 'allow' };
  return { ...binding, digest: sha256(canonical(binding)) };
})();
const render = (item, binding = claude, extra = {}) => {
  const rendered = renderDelivery({ tool: 'claude', item, binding, scope: 'project', ...extra });
  assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
  return rendered.recipe;
};
const itemRef = item => ({ framework: FRAMEWORK, itemId: item.id, contentSha256: item.contentSha256, behaviourSha256: item.behaviourSha256 });
const inSet = (setId, digest = sha256(setId)) => ({ reasonIncluded: 'in-set', set: { framework: FRAMEWORK, setId, setSha256: digest } });
const selectionOf = (item, origins, extra = {}) => ({ id: item.id, managementId: `${item.id}-managed`, scope: 'project', configuration: {}, requires: [],
  recipe: { inline: render(item) }, item: itemRef(item), tool: 'claude', name: `Item ${item.id}`, kind: item.kind, origins, ...extra });
const policy = (selections, extra = {}) => ({ schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections, ...extra });
const approve = (review, allowPartial) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...(allowPartial ? { allowPartial } : {}) });

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const id of ['prepared-work/1.0.0', 'prepared-work/1.1.0', 'prepared-work/1.4.0', 'prepared-work/1.5.0', 'prepared-work/1.6.0', 'run-result/1.0.0', 'run-result/1.1.0', 'run-result/1.4.0', 'managed-inventory-result/1.1.0',
  'managed-removal-preparation/1.0.0', 'managed-removal-preparation/1.2.0'])
  ajv.addSchema(JSON.parse(readFileSync(require.resolve(`@aihq/core/schemas/${id}.json`))));
// A removal preparation's JSON projection omits the live Apply handle.
const projection = document => document?.preparation?.prepared ? { ...document, preparation: (({ prepared: _handle, ...rest }) => rest)(document.preparation) } : document;
const conforms = (document, id) => {
  const validate = ajv.getSchema(id);
  assert.equal(validate(plain(projection(document))), true, `${id}: ${JSON.stringify(validate.errors)}`);
  return document;
};
const outputs = [];
const keep = value => { outputs.push(value); return value; };
async function install(project, document, controls = {}) {
  const prepared = keep(await prepare({ useCase: 'policy', policy: document, target: { project } }, { logging: 'on', ...controls }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const result = keep(conforms(await apply(prepared.prepared, approve(prepared.review), { logging: 'on', ...controls }), 'urn:aihq:core:run-result:1.4.0'));
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  return result;
}
const removeMany = async (project, removals, extra = {}) =>
  conforms(keep(await prepareManagedRemoval({ target: { project }, scope: 'project', removals, ...extra }, { logging: 'on' })), REMOVAL_12);
async function confirm(removal, allowPartial) {
  const result = keep(conforms(await apply(removal.preparation.prepared, approve(removal.preparation.review, allowPartial), { logging: 'on' }),
    'urn:aihq:core:run-result:1.4.0'));
  return result;
}
const inventory = async project =>
  conforms(keep(await listManagedSelections({ target: { project }, scope: 'project', format: INVENTORY_11 })), INVENTORY_11);
const rowOf = (removal, managementId) => removal.removals.find(entry => entry.managementId === managementId);
const actions = row => row.members.map(member => [basename(member.path), member.kind, member.action, member.reason ?? null]);
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

await check('the package declares removal preparation 1.2.0 as a produced contract with its schema and fixtures', async () => {
  const contract = contractSupport.contracts.find(item => item.id === REMOVAL_12);
  assert.equal(contract?.role, 'produces');
  assert.ok(existsSync(require.resolve(contract.schemaExport)));
  for (const fixture of contract.fixtures) assert.ok(existsSync(require.resolve(fixture.export)), fixture.export);
});

// Two overlapping sets: "shared" is in both, "only-a" in A, "only-b" in B.
const shared = skillItem('shared'), onlyA = skillItem('only-a'), onlyB = skillItem('only-b');
const sets = workspace('sets', [shared, onlyA, onlyB]);
const setA = inSet('set-a'), setB = inSet('set-b');
await check('removing one set by qualified origin keeps every member another origin still owns', async () => {
  await install(sets.project, policy([selectionOf(shared, [setA, setB]), selectionOf(onlyA, [setA]), selectionOf(onlyB, [setB])]), sets.controls);
  // After a restart, the exact selector is rebuilt from inventory 1.1 origins alone.
  const listed = await inventory(sets.project);
  const selectors = listed.selections.flatMap(entry => entry.origins.filter(origin => origin.reasonIncluded === 'in-set' &&
    canonical(origin.set) === canonical(setA.set)).map(origin => ({ managementId: entry.managementId, origin: { set: origin.set } })));
  assert.deepEqual(selectors.map(item => item.managementId).sort(), ['only-a-managed', 'shared-managed']);
  const removal = await removeMany(sets.project, selectors);
  assert.equal(removal.disposition, 'prepared', JSON.stringify(removal));
  assert.equal(removal.preparation.status, 'ready', JSON.stringify(removal.preparation.diagnostics));
  assert.equal(removal.reviewDigest, removal.preparation.review.reviewDigest, 'one review digest binds every listed file');
  const kept = rowOf(removal, 'shared-managed'), removed = rowOf(removal, 'only-a-managed');
  assert.deepEqual([kept.disposition, kept.change, kept.origin], ['prepared', 'remove-origin', { set: setA.set }]);
  assert.deepEqual(actions(kept).sort(), [['LICENSE', 'file', 'keep-shared', 'another-origin'], ['SKILL.md', 'file', 'keep-shared', 'another-origin']]);
  assert.deepEqual([removed.disposition, removed.change], ['prepared', 'remove-selection']);
  assert.deepEqual(actions(removed).sort(), [['LICENSE', 'file', 'remove', null], ['SKILL.md', 'file', 'remove', null]]);
  assert.equal(removal.removals.flatMap(entry => entry.members).every(member => member.path.startsWith(sets.project)), true, 'every file is listed');
  const run = await confirm(removal);
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.deepEqual(removalClaims(removal, run).removals.map(entry => [entry.managementId, entry.claim]),
    selectors.map(item => [item.managementId, item.managementId === 'shared-managed' ? 'inclusion-removed' : 'removed']), 'in request order');
  const after = await inventory(sets.project);
  assert.deepEqual(after.selections.map(entry => [entry.managementId, entry.origins]),
    [['only-b-managed', [setB]], ['shared-managed', [setB]]], 'set B still owns "shared"; only its set A inclusion went');
  assert.equal(after.selections.flatMap(entry => entry.members).every(member => member.fileState === 'matches'), true);
  assert.equal(existsSync(join(sets.project, '.claude', 'skills', 'only-a')), false);
});

await check('a set id with a different digest, or an inclusion never recorded, is not collapsed onto a recorded set', async () => {
  const other = inSet('set-b', sha256('a different set-b'));
  const removal = await removeMany(sets.project, [{ managementId: 'shared-managed', origin: { set: other.set } },
    { managementId: 'only-b-managed', origin: { reasonIncluded: 'chosen' } }]);
  assert.equal(removal.disposition, 'not-prepared');
  assert.equal(Object.hasOwn(removal, 'preparation'), false);
  assert.deepEqual(removal.removals.map(entry => [entry.managementId, entry.disposition, entry.diagnostics.map(item => item.reason)]),
    [['shared-managed', 'absent', ['origin-absent']], ['only-b-managed', 'absent', ['origin-absent']]]);
  // The last inclusion removes the selection itself.
  const last = await removeMany(sets.project, [{ managementId: 'shared-managed', origin: { set: setB.set } }]);
  assert.deepEqual([rowOf(last, 'shared-managed').change, actions(rowOf(last, 'shared-managed')).map(entry => entry[2])], ['remove-selection', ['remove', 'remove']]);
});

await check('several removals in one review keep the existing per-removal dispositions, and ambiguous requests are refused whole', async () => {
  const { project } = workspace('grouped', []);
  const file = (id, name, requires = []) => ({ id, managementId: id, scope: 'project', configuration: {}, requires,
    recipe: { inline: { schema: 'urn:aihq:core:recipe:1.3.0', id, description: id, inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [],
      operations: [{ id: 'write', purpose: 'Write', kind: 'file.write', scope: 'project', target: { root: 'project', segments: [{ literal: name }] },
        content: { literal: `${id}\n` }, requires: [], checks: [] }] } } });
  await install(project, policy([file('base', 'BASE.md'), file('top', 'TOP.md', ['base']), file('loose', 'LOOSE.md')]));
  const mixed = await removeMany(project, [{ managementId: 'base' }, { managementId: 'loose' }, { managementId: 'ghost' }]);
  assert.equal(mixed.disposition, 'prepared');
  assert.deepEqual(mixed.removals.map(entry => [entry.managementId, entry.disposition, entry.diagnostics.map(item => item.reason)]),
    [['base', 'retained', ['dependency-retained']], ['loose', 'prepared', []], ['ghost', 'absent', []]]);
  assert.deepEqual(actions(rowOf(mixed, 'loose')), [['LOOSE.md', 'file', 'remove', null]]);
  assert.deepEqual(rowOf(mixed, 'base').members, [], 'nothing is prepared for a retained selection');
  const grouped = await removeMany(project, [{ managementId: 'top' }, { managementId: 'base' }]);
  assert.deepEqual(grouped.removals.map(entry => entry.disposition), ['prepared', 'prepared'], 'removing the dependant with it frees the dependency');
  const run = await confirm(grouped);
  assert.equal(run.authorization.reviewDigest, grouped.reviewDigest, 'the run names the review it applied');
  assert.deepEqual(removalClaims(grouped, run).removals.map(entry => entry.claim), ['removed', 'removed']);
  // Operation ids repeat across cleanup reviews: another review's run never speaks for this one.
  const pending = await removeMany(project, [{ managementId: 'loose' }]);
  assert.equal(pending.removals[0].members[0].operationId, run.members[0].operationId);
  assert.deepEqual(removalClaims(pending, run).removals.map(entry => entry.claim), ['not-confirmed']);
  assert.equal(existsSync(join(project, 'LOOSE.md')), true);
  for (const removals of [[{ managementId: 'loose' }, { managementId: 'loose' }],
    [{ managementId: 'loose' }, { managementId: 'loose', origin: { reasonIncluded: 'chosen' } }], []]) {
    const refused = await removeMany(project, removals);
    assert.deepEqual([refused.disposition, refused.diagnostics.map(item => item.reason)], ['invalid', [removals.length ? 'removal-conflict' : 'request-shape']]);
    assert.equal(Object.hasOwn(refused, 'removals'), false);
  }
  assert.equal(existsSync(join(project, 'LOOSE.md')), true);
});

await check('an edited item is partly removed: the edited file is kept as changed and its licence kept as required', async () => {
  const notes = skillItem('notes', { 'reference.md': 'Reference.\n', NOTICE: 'Notice text\n' });
  const { project, controls } = workspace('edited', [notes]);
  await install(project, policy([selectionOf(notes, [{ reasonIncluded: 'chosen' }])]), controls);
  const skillDir = join(project, '.claude', 'skills', 'notes');
  writeFileSync(join(skillDir, 'SKILL.md'), 'my own edit\n');
  const removal = await removeMany(project, [{ managementId: 'notes-managed' }]);
  assert.equal(removal.preparation.status, 'ready', 'named keeps are reviewed actions, not conflicts');
  assert.deepEqual(actions(rowOf(removal, 'notes-managed')).sort(), [['LICENSE', 'file', 'keep-required', 'licence-or-notice'],
    ['NOTICE', 'file', 'keep-required', 'licence-or-notice'], ['SKILL.md', 'file', 'keep-changed', 'managed-content-changed'], ['reference.md', 'file', 'remove', null]]);
  const run = await confirm(removal);
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.deepEqual(removalClaims(removal, run).removals.map(entry => entry.claim), ['partly-removed'], 'never "removed" while a member is kept as changed');
  assert.equal(runMemberClaims(run).removed, true, 'the removed member itself is confirmed absent');
  assert.deepEqual(readdirSync(skillDir).sort(), ['LICENSE', 'NOTICE', 'SKILL.md']);
  const after = (await inventory(project)).selections.find(entry => entry.managementId === 'notes-managed');
  assert.deepEqual(after.members.map(member => [basename(member.path), member.fileState]).sort(),
    [['LICENSE', 'matches'], ['NOTICE', 'matches'], ['SKILL.md', 'changed']], 'kept members stay in custody with the item');
});

await check('approval members: a person\'s later edit to an approval Core wrote is keep-changed while the registration is removed', async () => {
  const { project, controls } = workspace('approval', [github]);
  const approvals = join(project, '.claude', 'approvals.json');
  mkdirSync(dirname(approvals), { recursive: true });
  writeFileSync(approvals, '{\n  "mcpServerApprovals": {\n    "mine": "allow"\n  }\n}\n');
  const secrets = { ...controls, privateInputs: { github: { githubToken: SECRET } } };
  await install(project, policy([selectionOf(github, [{ reasonIncluded: 'chosen' }], { recipe: { inline: render(github, objectKeyed, { grantApproval: { framework: FRAMEWORK, itemId: 'github' } }) } })]), secrets);
  writeFileSync(approvals, '{\n  "mcpServerApprovals": {\n    "mine": "allow",\n    "github": "ask"\n  }\n}\n');
  const removal = await removeMany(project, [{ managementId: 'github-managed' }]);
  assert.equal(removal.preparation.status, 'ready');
  const row = rowOf(removal, 'github-managed');
  const approval = row.members.find(member => member.approval);
  assert.deepEqual([approval.kind, approval.pointer, approval.approval, approval.action, approval.reason],
    ['config-entry', '/mcpServerApprovals/github', { tool: 'claude' }, 'keep-changed', 'managed-content-changed']);
  assert.equal(row.members.some(member => member.kind === 'file'), false, 'a server delivers no files, so no licence file is kept');
  assert.equal(row.members.filter(member => member.path.endsWith('.mcp.json')).every(member => member.action === 'remove'), true);
  const run = await confirm(removal);
  assert.equal(JSON.parse(readFileSync(approvals, 'utf8')).mcpServerApprovals.github, 'ask', 'the person\'s edit stays');
  assert.equal(removalClaims(removal, run).removals[0].claim, 'partly-removed');
  // An untouched array approval (recipe 1.4.0 config.member) is removed with its server and confirmed absent.
  const arrayed = workspace('approval-array', [github]);
  const settings = join(arrayed.project, '.claude', 'settings.local.json');
  mkdirSync(dirname(settings), { recursive: true });
  const earlier = '{\n  "enabledMcpjsonServers": ["mine"]\n}\n';
  writeFileSync(settings, earlier);
  await install(arrayed.project, policy([selectionOf(github, [{ reasonIncluded: 'chosen' }], { recipe: { inline: render(github, claude, { grantApproval: { framework: FRAMEWORK, itemId: 'github' } }) } })]),
    { ...arrayed.controls, privateInputs: { github: { githubToken: SECRET } } });
  const granted = await removeMany(arrayed.project, [{ managementId: 'github-managed' }]);
  const member = rowOf(granted, 'github-managed').members.find(item => item.kind === 'config-member');
  assert.deepEqual([member.pointer, member.approval, member.action], ['/enabledMcpjsonServers', { tool: 'claude' }, 'remove']);
  const removed = await confirm(granted);
  assert.equal(removalClaims(granted, removed).removals[0].claim, 'removed');
  assert.equal(readFileSync(settings, 'utf8'), earlier, 'only the member Core added is removed');
});

await check('a replaced value is restored and reported restored; a missing member is only unregistered', async () => {
  const { project } = workspace('restore', []);
  const settings = join(project, 'settings.json');
  writeFileSync(settings, `${JSON.stringify({ tool: { mode: USER_VALUE } }, null, 2)}\n`);
  const entry = { id: 'mode', managementId: 'tool-mode', scope: 'project', configuration: {}, requires: [],
    recipe: { inline: { schema: 'urn:aihq:core:recipe:1.3.0', id: 'mode', description: 'mode', inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [],
      operations: [{ id: 'entry', purpose: 'Set', kind: 'config.entries', scope: 'project', target: { root: 'project', segments: [{ literal: 'settings.json' }] },
        format: 'json', entries: [{ path: ['tool', 'mode'], action: 'set', value: { literal: 'aih' } }], requires: [], checks: [] },
      { id: 'note', purpose: 'Write', kind: 'file.write', scope: 'project', target: { root: 'project', segments: [{ literal: 'MODE.md' }] },
        content: { literal: 'mode\n' }, requires: [], checks: [] }] } } };
  const prepared = keep(await prepare({ useCase: 'policy', policy: policy([entry]), target: { project },
    resolutions: [{ selectionId: 'mode', operationId: 'entry', choice: 'replace', observedSha256: sha256(readFileSync(settings)) }] }, { logging: 'on' }));
  assert.equal((await apply(prepared.prepared, approve(prepared.review), { logging: 'on' })).completion, 'complete');
  rmSync(join(project, 'MODE.md')); // The person deletes a managed file.
  const removal = await removeMany(project, [{ managementId: 'tool-mode' }]);
  assert.deepEqual(actions(rowOf(removal, 'tool-mode')).sort(), [['MODE.md', 'file', 'unregister', 'already-absent'], ['settings.json', 'config-entry', 'restore', 'pre-existing-value']]);
  const run = await confirm(removal);
  assert.deepEqual(removalClaims(removal, run).removals.map(item => item.claim), ['removed']);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { tool: { mode: USER_VALUE } });
  // A run that never confirmed its members supports no claim.
  assert.deepEqual(removalClaims(removal, { ...run, completion: 'incomplete' }).removals.map(item => item.claim), ['not-confirmed']);
  assert.deepEqual(removalClaims(removal, { ...run, members: run.members.map(member => ({ ...member, check: 'unchecked' })) }).removals.map(item => item.claim), ['not-confirmed']);
});

await check('a private input value inside a member path stays redacted in the removal review', async () => {
  const { project } = workspace('private-path', []);
  const vault = { id: 'vault', managementId: 'vault', scope: 'project', configuration: {}, requires: [],
    recipe: { inline: { schema: 'urn:aihq:core:recipe:1.3.0', id: 'vault', description: 'vault', materials: [], targets: ['project'], prerequisites: [], checks: [],
      inputs: { name: { type: 'string', required: true, sensitive: true, maxLength: 64 } },
      operations: [{ id: 'file', purpose: 'Write', kind: 'file.write', scope: 'project', target: { root: 'project', segments: [{ literal: 'vault' }, { input: 'name' }] },
        content: { literal: 'v\n' }, requires: [], checks: [] }] } } };
  await install(project, policy([vault]), { privateInputs: { vault: { name: PATH_SECRET } } });
  const removal = await removeMany(project, [{ managementId: 'vault' }]);
  assert.deepEqual(rowOf(removal, 'vault').members.map(member => [member.path, member.action]), [[join(project, 'vault', '[REDACTED]'), 'remove']]);
  const run = await confirm(removal);
  assert.deepEqual(removalClaims(removal, run).removals.map(item => item.claim), ['removed']);
});

await check('the single-id convenience call keeps its published shape', async () => {
  const single = keep(await prepareManagedRemoval({ target: { project: sets.project }, managementId: 'only-b-managed', scope: 'project', mode: 'vibe' }));
  conforms(single, 'urn:aihq:core:managed-removal-preparation:1.0.0');
  assert.deepEqual([single.schema, single.disposition, Object.hasOwn(single, 'removals')], ['urn:aihq:core:managed-removal-preparation:1.0.0', 'prepared', false]);
});

await check('no input value, restoration value or private path appears in any removal output or history', async () => {
  const { root } = resolveStateLocation();
  const history = existsSync(join(root, 'runs')) ? readdirSync(join(root, 'runs')).map(name => readFileSync(join(root, 'runs', name), 'utf8')) : [];
  assert.ok(history.length >= 6);
  const text = [...outputs.map(value => JSON.stringify(value)), ...history].join('\n');
  for (const forbidden of [SECRET, sha256(SECRET), USER_VALUE, PATH_SECRET]) assert.equal(text.includes(forbidden), false, forbidden);
  const removals = outputs.filter(value => value?.schema === REMOVAL_12).map(value => JSON.stringify(value.removals ?? [])).join('\n');
  assert.equal(/"(sha256|preExisting|value-sha256)"/.test(removals), false, 'member rows carry no digest or restoration field');
});

process.stdout.write(`${JSON.stringify({ status: 'passed', checks })}\n`);
