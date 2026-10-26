// Runs inside a disposable consumer with the packed @aihq/core installed; public entries only.
// Execution policy 1.4.0, prepared work 1.6.0 and the Apply re-check's REVIEW_STALE mapping.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderDelivery, toolBindings } from '@aihq/core/harness';
import { contractSupport, deriveRecipeIdentity, validatePolicy } from '@aihq/core/contracts';
import { apply, prepare, resolveStateLocation } from '@aihq/core';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const POLICY_14 = 'urn:aihq:core:execution-policy:1.4.0';

/** An independently built Catalog release 1.6 item: content materials with bytes, one behaviour file, both identities. */
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
    contentSha256: sha256(lines(content)), behaviourSha256: sha256(lines([...content, behaviour])), payload };
}
const binding = tool => toolBindings.find(item => item.tool === tool);
const render = (item, tool = 'claude', scope = 'project') => {
  const rendered = renderDelivery({ tool, item, binding: binding(tool), scope });
  assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
  return rendered.recipe;
};
const itemRef = item => ({ framework: FRAMEWORK, itemId: item.id, contentSha256: item.contentSha256, behaviourSha256: item.behaviourSha256 });
const chosen = { reasonIncluded: 'chosen' };
const inSet = (setId, options) => ({ reasonIncluded: 'in-set', set: { framework: FRAMEWORK, setId, setSha256: sha256(setId) },
  ...(options ? { options } : {}) });
const requiredBy = itemId => ({ reasonIncluded: 'required-by', requiredBy: { framework: FRAMEWORK, itemId } });
const describe = (item, name, origins = [chosen], tool = 'claude') => ({ item: itemRef(item), tool, name, kind: item.kind, origins });

const SKILL_FILES = { 'SKILL.md': '---\nname: review\ndescription: Review code — carefully\n---\nReview carefully.\n', LICENSE: 'MIT\n' };
const skill = catalogItem({ id: 'review', kind: 'skill', files: SKILL_FILES,
  payload: { dirName: 'code-review', invocation: 'model-allowed', invocationBasis: 'authored frontmatter' } });
const HOOK_FILES = { 'hooks/start.mjs': 'console.log("start");\n' };
const hook = catalogItem({ id: 'session-start', kind: 'hook', files: HOOK_FILES,
  payload: { event: 'SessionStart', protocol: 'claude-code-hooks', command: { script: 'm0', interpreter: 'node', args: ['{projectDir}'] } } });
const github = catalogItem({ id: 'github', kind: 'mcp-server', files: { LICENSE: 'MIT\n' },
  requirements: { inputs: { githubToken: { type: 'string', required: true, sensitive: true } } },
  payload: { key: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'github-mcp'],
    env: { GITHUB_TOKEN: { input: 'githubToken' } } } });
const SECRET = 'ghp_ExampleSecretValue0123456789';
const plainFile = (id, path, text) => ({ schema: 'urn:aihq:core:recipe:1.0.0', id, description: `Write ${path}`, inputs: {},
  materials: [], targets: ['project'], prerequisites: [], checks: [], operations: [{ id: 'write', purpose: `Write ${path}`,
    kind: 'file.write', scope: 'project', requires: [], checks: [], target: { root: 'project', segments: [{ literal: path }] },
    content: { literal: text } }] });
const selection = (id, recipe, extra = {}) => ({ id, managementId: `${id}-managed`, scope: 'project', configuration: {}, requires: [],
  recipe: { inline: recipe }, ...extra });
const policy14 = (selections, extra = {}) => ({ schema: POLICY_14, mode: 'vibe', selections, ...extra });
const approve = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });

function workspace(prefix) {
  const work = mkdtempSync(join(process.env.HOME, `${prefix}-`));
  const catalog = join(work, 'catalog'), project = join(work, 'project');
  mkdirSync(project);
  for (const [item, files] of [[skill, SKILL_FILES], [hook, HOOK_FILES], [github, { LICENSE: 'MIT\n' }]])
    for (const member of item.materials.filter(entry => entry.role === 'content')) {
      mkdirSync(dirname(join(catalog, member.packagePath)), { recursive: true });
      writeFileSync(join(catalog, member.packagePath), files[member.relPath]);
    }
  return { work, catalog, project, controls: { logging: 'off', materialRoots: { catalog } } };
}
const ask = (policy, project, controls, extra = {}) => prepare({ useCase: 'policy', policy, target: { project }, ...extra }, controls);
const reasons = result => result.diagnostics.map(item => item.reason);

// Produced documents are checked against the package's exported schemas.
const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const id of ['prepared-work/1.4.0', 'prepared-work/1.5.0', 'prepared-work/1.6.0', 'run-result/1.4.0'])
  ajv.addSchema(JSON.parse(readFileSync(require.resolve(`@aihq/core/schemas/${id}.json`))));
const conforms = (document, id) => {
  const validate = ajv.getSchema(id);
  assert.equal(validate(plain(document)), true, `${id}: ${JSON.stringify(validate.errors)}`);
  return document;
};
const review16 = prepared => conforms(prepared.review, 'urn:aihq:core:prepared-work:1.6.0');
const result14 = run => conforms(run, 'urn:aihq:core:run-result:1.4.0');
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

await check('the package declares execution policy 1.4.0, prepared work 1.6.0 and run result 1.4.0 with fixtures', async () => {
  const contract = id => contractSupport.contracts.find(item => item.id === id);
  assert.equal(contract(POLICY_14)?.role, 'accepts');
  assert.equal(contract('urn:aihq:core:prepared-work:1.6.0')?.role, 'produces');
  assert.equal(contract('urn:aihq:core:run-result:1.4.0')?.role, 'produces');
  for (const id of [POLICY_14, 'urn:aihq:core:prepared-work:1.6.0', 'urn:aihq:core:run-result:1.4.0']) {
    for (const fixture of contract(id).fixtures) {
      const bytes = readFileSync(require.resolve(fixture.export));
      if (id === POLICY_14) assert.equal(validatePolicy(JSON.parse(bytes)).valid, fixture.expect === 'accept', fixture.export);
    }
    assert.ok(existsSync(require.resolve(contract(id).schemaExport)));
  }
});

await check('execution policy 1.4.0 keeps every accepted field: inline and referenced recipes, management ids, requires, sets, removals and evidence', async () => {
  const { catalog, project, controls } = workspace('fields');
  const referenced = render(skill);
  // A referenced recipe declares material identities; the reference pins where each one is read.
  const recipeText = JSON.stringify({ ...referenced, materials: referenced.materials.map(({ id, sha256: digest, byteLength }) => ({ id, sha256: digest, byteLength })) });
  mkdirSync(join(catalog, 'release', 'recipes'), { recursive: true });
  writeFileSync(join(catalog, 'release', 'recipes', 'review.json'), recipeText);
  const reference = { source: { kind: 'local', input: 'catalog' }, path: 'release/recipes/review.json', sha256: sha256(recipeText),
    byteLength: Buffer.byteLength(recipeText), materials: referenced.materials.map(({ id, path, sha256: digest, byteLength }) =>
      ({ id, path, sha256: digest, byteLength })) };
  const evidence = [{ schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: `scan:sha256:${'a'.repeat(64)}`,
    location: { kind: 'file', path: join(project, 'scan.json') } }];
  const first = policy14([
    { id: 'review', managementId: 'catalog-review', scope: 'project', configuration: {}, requires: [], recipe: { reference }, ...describe(skill, 'Code review') },
    selection('notes', plainFile('notes', 'NOTES.md', 'Notes\n'), { requires: ['review'] }),
    selection('team', plainFile('team', 'TEAM.md', 'Team\n'))
  ], { managedSelections: [{ id: 'starter', scope: 'project', members: ['notes-managed'] }], evidence });
  assert.equal(validatePolicy(first).valid, true, JSON.stringify(validatePolicy(first)));
  const prepared = await ask(first, project, controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  review16(prepared);
  assert.deepEqual(prepared.review.evidence.map(item => item.scanId), [evidence[0].scanId], 'evidence associations are kept');
  assert.ok(prepared.review.operations.find(op => op.id === 'notes/write').requires.some(id => id.startsWith('review/')),
    'selection-id requires orders dependent work');
  const run = await apply(prepared.prepared, approve(prepared), controls);
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  result14(run);
  assert.equal(readFileSync(join(project, '.claude', 'skills', 'code-review', 'SKILL.md'), 'utf8'), SKILL_FILES['SKILL.md']);
  // Omitted managedSelections retain earlier members; an empty member list reconciles the set; removals stay scoped.
  const omitted = await ask(policy14([selection('team', plainFile('team', 'TEAM.md', 'Team\n'))]), project, controls);
  assert.equal(omitted.review.operations.some(op => op.id.startsWith('lifecycle/')), false, 'omitted sets keep their members');
  const emptied = await ask(policy14([selection('team', plainFile('team', 'TEAM.md', 'Team\n'))],
    { managedSelections: [{ id: 'starter', scope: 'project', members: [] }] }), project, controls);
  assert.deepEqual(review16(emptied).operations.filter(op => op.id.startsWith('lifecycle/')).map(op => [op.effects, op.selectionId]),
    [['remove-file', null]], 'an empty set removes its former member; generated cleanup has no selection');
  const removed = await ask(policy14([selection('team', plainFile('team', 'TEAM.md', 'Team\n'))],
    { removals: [{ managementId: 'catalog-review', scope: 'project' }, { managementId: 'notes-managed', scope: 'project' }] }), project, controls);
  assert.deepEqual(removed.review.operations.filter(op => op.id.startsWith('lifecycle/') && op.effects === 'remove-file')
    .map(op => op.details.target.slice(project.length + 1).replaceAll('\\', '/')).sort(),
    ['.claude/skills/code-review/LICENSE', '.claude/skills/code-review/SKILL.md', 'NOTES.md'],
    'scoped removals remove the referenced recipe and its dependent');
  const wrongScope = await ask(policy14([selection('team', plainFile('team', 'TEAM.md', 'Team\n'))],
    { removals: [{ managementId: 'catalog-review', scope: 'user' }] }), project, controls);
  assert.equal(wrongScope.review.operations.some(op => op.id.startsWith('lifecycle/')), false, 'a removal names its scope');
});

await check('selections carry descriptive metadata with every qualified origin, and the review names each item', async () => {
  const { project, controls } = workspace('origins');
  const origins = [chosen, inSet('starter'), inSet('developer', { languages: ['typescript'] }), requiredBy('lint')];
  const policy = policy14([
    selection('review', render(skill), describe(skill, 'Code review', origins)),
    selection('hook', render(hook), describe(hook, 'Session start', [inSet('starter')])),
    selection('github', render(github), describe(github, 'GitHub MCP server', [requiredBy('review')])),
    selection('plain', plainFile('plain', 'PLAIN.md', 'Plain\n'))
  ]);
  assert.equal(validatePolicy(policy).valid, true, JSON.stringify(validatePolicy(policy)));
  const prepared = await ask(policy, project, { ...controls, privateInputs: { github: { githubToken: SECRET } } });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const { selections, operations } = review16(prepared);
  assert.deepEqual(selections.map(item => item.selectionId), ['review', 'hook', 'github', 'plain'], 'one entry per selection, in policy order');
  const review = selections[0];
  assert.deepEqual({ name: review.name, kind: review.kind, tool: review.tool, item: review.item, origins: review.origins },
    { name: 'Code review', kind: 'skill', tool: 'claude', item: itemRef(skill), origins }, 'overlapping inclusions keep every origin');
  const skillBytes = Buffer.byteLength(SKILL_FILES['SKILL.md']) + Buffer.byteLength(SKILL_FILES.LICENSE);
  const skillChars = SKILL_FILES['SKILL.md'].length + SKILL_FILES.LICENSE.length;
  assert.deepEqual(review.deliveredSize, { bytes: skillBytes, chars: skillChars,
    alwaysLoaded: { bytes: Buffer.byteLength('review') + Buffer.byteLength('Review code — carefully'), chars: 'review'.length + 'Review code — carefully'.length } });
  assert.deepEqual(review.inputs, []);
  assert.equal(review.hookCommands, undefined);
  const hookEntry = selections[1];
  const group = operations.find(op => op.kind === 'hook.group');
  assert.deepEqual(hookEntry.hookCommands, [group.details.hookGroup.desiredGroup.hooks[0].command], 'the hook command is shown verbatim');
  assert.match(hookEntry.hookCommands[0], /^node "\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\/session-start\/hooks\/start\.mjs" "\$\{CLAUDE_PROJECT_DIR\}"$/);
  assert.deepEqual(hookEntry.deliveredSize, { bytes: Buffer.byteLength(HOOK_FILES['hooks/start.mjs']), chars: HOOK_FILES['hooks/start.mjs'].length,
    alwaysLoaded: { bytes: 0, chars: 0 } });
  const server = selections[2];
  assert.equal(server.permissionStep, binding('claude').layouts['mcp-server'].register.permissionStep);
  assert.deepEqual(server.inputs, ['githubToken'], 'inputs are named, never valued');
  assert.equal(selections[3].name, undefined, 'a selection without metadata names nothing it was not told');
  assert.deepEqual(selections[3].deliveredSize, { bytes: 6, chars: 6 });
  for (const op of operations) assert.equal(op.selectionId, op.id.split('/')[0], `${op.id} carries its selection id`);
  assert.equal(JSON.stringify(prepared).includes(SECRET), false, 'the review holds no input value');
  const run = await apply(prepared.prepared, approve(prepared), { ...controls, privateInputs: { github: { githubToken: SECRET } } });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.equal(JSON.stringify(result14(run)).includes(SECRET), false, 'the run result holds no input value');
  assert.equal(JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8')).mcpServers.github.env.GITHUB_TOKEN, SECRET,
    'the value travels only in the live request to its target');
});

await check('hook commands redact private input values, and rule sizes say only what the delivery shows', async () => {
  const { project, controls } = workspace('hook-secret');
  const secretHook = { schema: 'urn:aihq:core:recipe:1.3.0', id: 'secret-hook', description: 'A hook bound to a private input',
    inputs: { token: { type: 'string', required: true, sensitive: true } }, materials: [], targets: ['project'], prerequisites: [], checks: [],
    operations: [{ id: 'register', purpose: 'Register a hook', kind: 'hook.group', scope: 'project', requires: [], checks: [],
      target: { root: 'project', segments: [{ literal: '.claude' }, { literal: 'settings.json' }] }, format: 'json', container: ['hooks', 'SessionStart'],
      groupId: 'secret-hook', selector: { path: ['matcher'], value: 'startup' }, action: 'set',
      group: { literal: { matcher: 'startup', hooks: [{ type: 'command', command: 'placeholder' }] } },
      groupBindings: [{ path: ['hooks', 0, 'command'], value: { input: 'token' } }] }] };
  const RULE = '# Style\nKeep it small.\n';
  const fileRule = catalogItem({ id: 'style', kind: 'rule', files: { 'style.md': RULE }, payload: { applyTo: ['**'], applyToBasis: 'authored' } });
  const blockRule = catalogItem({ id: 'guide', kind: 'rule', files: { 'guide.md': RULE }, payload: { applyTo: ['**'], applyToBasis: 'authored' } });
  const block = renderDelivery({ tool: 'codex', item: blockRule, binding: binding('codex'), scope: 'project',
    contents: { m0: RULE } });
  assert.equal(block.status, 'rendered', JSON.stringify(block));
  const written = render(fileRule);
  const literal = { ...written, materials: [], operations: written.operations.map(op => ({ id: op.id, purpose: op.purpose, kind: op.kind, scope: op.scope,
    target: op.target, content: { literal: RULE }, requires: [], checks: [] })), checks: [] };
  const prepared = await ask(policy14([
    selection('hook', secretHook, { ...describe(hook, 'Secret hook'), item: { ...itemRef(hook), itemId: 'secret-hook' } }),
    selection('file-rule', literal, describe(fileRule, 'Style', [chosen], 'claude')),
    selection('block-rule', block.recipe, describe(blockRule, 'Guide', [chosen], 'codex'))
  ]), project, { ...controls, privateInputs: { hook: { token: SECRET } } });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const [hookEntry, fileEntry, blockEntry] = review16(prepared).selections;
  assert.deepEqual(hookEntry.hookCommands, ['[REDACTED]']);
  assert.deepEqual(hookEntry.inputs, ['token']);
  assert.equal(JSON.stringify(prepared).includes(SECRET), false, 'no private value in the review');
  assert.deepEqual(fileEntry.deliveredSize, { bytes: RULE.length, chars: RULE.length }, 'a rule file does not say how the tool includes it');
  assert.deepEqual(blockEntry.deliveredSize, { bytes: RULE.length, chars: RULE.length, alwaysLoaded: { bytes: RULE.length, chars: RULE.length } },
    'an entry-file block is read every session');
  const run = await apply(prepared.prepared, approve(prepared), { ...controls, privateInputs: { hook: { token: SECRET } } });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.equal(JSON.stringify(result14(run)).includes(SECRET), false, 'no private value in the run result');
});

await check('metadata adds no operations and no authority', async () => {
  const { project, controls } = workspace('fence');
  const bare = await ask(policy14([selection('review', render(skill))]), project, controls);
  const described = await ask(policy14([selection('review', render(skill), describe(skill, 'Code review', [chosen, inSet('starter')]))]), project, controls);
  assert.deepEqual(described.review.operations, bare.review.operations);
  const { value: { recipeIdentity } } = await deriveRecipeIdentity({ recipe: render(skill) });
  const enterprise = policy14([selection('review', render(skill), { organizationSelectionId: 'review', ...describe(skill, 'Code review') })], { mode: 'enterprise' });
  const originalFetch = globalThis.fetch;
  try {
    const denied = await ask(enterprise, project, controls, { organizationSource: serveOrganization({ schema: 'urn:aihq:core:organization-policy:1.0.0',
      id: 'example-org', selections: [{ selectionId: 'review', recipeIdentity: `sha256:${'0'.repeat(64)}`, scopes: ['project'], inputs: {} }] }) });
    assert.deepEqual([denied.status, denied.diagnostics[0].reason], ['blocked', 'recipe-identity'], 'metadata naming the item admits nothing');
    const admitted = await ask(enterprise, project, controls, { organizationSource: serveOrganization({ schema: 'urn:aihq:core:organization-policy:1.0.0',
      id: 'example-org', selections: [{ selectionId: 'review', recipeIdentity, scopes: ['project'], inputs: {} }] }) });
    assert.equal(admitted.status, 'ready', JSON.stringify(admitted.diagnostics));
    assert.equal(admitted.review.selections[0].name, 'Code review');
  } finally { globalThis.fetch = originalFetch; }
});

await check('excludedItems match by framework and item id whatever the identities; a matching selection makes the policy invalid', async () => {
  const policy = excludedItems => policy14([selection('review', render(skill), describe(skill, 'Code review'))], { excludedItems });
  assert.equal(validatePolicy(policy([{ framework: FRAMEWORK, itemId: 'other' }, { framework: 'elsewhere', itemId: 'review' }])).valid, true);
  const refused = validatePolicy(policy([{ framework: FRAMEWORK, itemId: 'review' }]));
  assert.equal(refused.valid, false);
  assert.deepEqual(refused.diagnostics.map(item => [item.code, item.reason, item.path]), [['INPUT_INVALID', 'excluded-item-selected', '/selections/0/item']]);
  // A fallback or dependency for an excluded item is the same item identity, whatever its content hashes: never re-added.
  const fallback = { ...describe(skill, 'Code review', [requiredBy('lint')]), item: { ...itemRef(skill), contentSha256: '1'.repeat(64), behaviourSha256: '2'.repeat(64) } };
  const readded = validatePolicy(policy14([selection('review', render(skill), fallback)], { excludedItems: [{ framework: FRAMEWORK, itemId: 'review' }] }));
  assert.deepEqual(readded.diagnostics.map(item => item.reason), ['excluded-item-selected']);
  const { project, controls } = workspace('excluded');
  const prepared = await ask(policy([{ framework: FRAMEWORK, itemId: 'review' }]), project, controls);
  assert.deepEqual([prepared.status, reasons(prepared)], ['invalid', ['excluded-item-selected']]);
  assert.equal(prepared.prepared, undefined);
});

await check('duplicate management ids are invalid in 1.4.0 while older policies stay valid', async () => {
  const twice = scope => [selection('a', plainFile('a', 'A.md', 'A\n'), { managementId: 'shared' }),
    { ...selection('b', { ...plainFile('b', 'B.md', 'B\n'), targets: [scope], operations: [{ ...plainFile('b', 'B.md', 'B\n').operations[0], scope,
      target: { root: scope === 'user' ? 'userHome' : 'project', segments: [{ literal: 'B.md' }] } }] }), managementId: 'shared', scope }];
  for (const scope of ['project', 'user']) {
    const result = validatePolicy(policy14(twice(scope)));
    assert.deepEqual(result.diagnostics.map(item => item.reason), ['duplicate-management-id'], scope);
  }
  assert.equal(validatePolicy({ ...policy14(twice('user')), schema: 'urn:aihq:core:execution-policy:1.3.0' }).valid, true,
    'a 1.3.0 policy keeps its per-scope management ids');
  const { project, controls } = workspace('older');
  for (const [schema, prepared] of [['urn:aihq:core:execution-policy:1.0.0', 'urn:aihq:core:prepared-work:1.0.0'],
    ['urn:aihq:core:execution-policy:1.3.0', 'urn:aihq:core:prepared-work:1.4.0']]) {
    const older = await ask({ schema, mode: 'vibe', selections: [selection('a', plainFile('a', 'A.md', 'A\n'))] }, project, controls);
    assert.deepEqual([older.status, older.review.schema, older.review.selections, older.review.operations[0].selectionId],
      ['ready', prepared, undefined, undefined], schema);
  }
  assert.equal(validatePolicy({ schema: 'urn:aihq:core:execution-policy:1.3.0', mode: 'vibe',
    selections: [selection('a', plainFile('a', 'A.md', 'A\n'), describe(skill, 'Code review'))] }).valid, false, 'metadata is a 1.4.0 field');
});

await check('grantApproval is a render input, never selection metadata', async () => {
  const result = validatePolicy(policy14([selection('github', render(github), { ...describe(github, 'GitHub'), grantApproval: [{ framework: FRAMEWORK, itemId: 'github' }] })]));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(item => item.path === '/selections/0/grantApproval'), JSON.stringify(result.diagnostics));
});

await check('the review digest stays nonce-bound and opaque: two identical previews have different digests', async () => {
  const { project, controls } = workspace('nonce');
  const policy = policy14([selection('review', render(skill), describe(skill, 'Code review'))]);
  const [first, second] = [await ask(policy, project, controls), await ask(policy, project, controls)];
  const { reviewDigest: a, ...left } = first.review, { reviewDigest: b, ...right } = second.review;
  assert.deepEqual(left, right, 'the previews are identical');
  assert.notEqual(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
  const stale = await apply(first.prepared, { ...approve(first), reviewDigest: b }, controls);
  assert.deepEqual(stale.diagnostics.map(item => [item.code, item.reason, item.changed]), [['REVIEW_STALE', 'digest-mismatch', undefined]]);
});

// Each held review is refused at Apply with the binding that changed, and nothing is written.
async function stale(name, { selections, privateInputs, mutate, changed, reason, written, extra }) {
  const { project, controls, catalog, work } = workspace(`stale-${name}`);
  const live = { ...controls, ...(privateInputs ? { privateInputs } : {}) };
  const request = { useCase: 'policy', policy: policy14(selections({ project, work })), target: { project }, ...(extra ?? {}) };
  const prepared = await prepare(request, live);
  assert.equal(prepared.status, 'ready', `${name}: ${JSON.stringify(prepared.diagnostics)}`);
  const restore = await mutate({ request, live, project, catalog, prepared, controls, work });
  let run;
  try { run = await apply(prepared.prepared, approve(prepared), live); }
  finally { await restore?.(); }
  assert.equal(run.completion, 'rejected', `${name}: ${JSON.stringify(run)}`);
  assert.deepEqual(run.diagnostics.map(item => [item.code, item.reason, item.changed]),
    [['REVIEW_STALE', reason ?? 'binding-changed', changed]], name);
  result14(run);
  for (const path of written(project)) assert.equal(existsSync(path), false, `${name}: nothing is written (${path})`);
}
const skillTarget = project => [join(project, '.claude', 'skills', 'code-review', 'SKILL.md')];

await check('REVIEW_STALE names each changed binding: policy, recipe, target-file, ownership, input, host and trust', async () => {
  const reviewSelection = () => [selection('review', render(skill), describe(skill, 'Code review'))];
  await stale('policy', { selections: reviewSelection, changed: 'policy', written: skillTarget,
    mutate: ({ request }) => { request.policy.selections[0].configuration = { extra: true }; } });
  await stale('recipe', { selections: reviewSelection, changed: 'recipe', written: skillTarget,
    mutate: ({ catalog }) => { writeFileSync(join(catalog, skill.materials.find(item => item.relPath === 'SKILL.md').packagePath), 'Changed.\n'); } });
  await stale('target-file', { selections: () => [selection('team', plainFile('team', 'TEAM.md', 'Team\n'))], changed: 'target-file',
    written: () => [], mutate: ({ project }) => { writeFileSync(join(project, 'TEAM.md'), 'Mine.\n'); } });
  await stale('ownership', { selections: reviewSelection, changed: 'ownership', written: skillTarget,
    mutate: async ({ project, controls }) => {
      const other = await ask(policy14([selection('other', plainFile('other', 'OTHER.md', 'Other\n'))]), project, controls);
      assert.equal((await apply(other.prepared, approve(other), controls)).completion, 'complete');
    } });
  await stale('input', { selections: () => [selection('github', render(github), describe(github, 'GitHub'))],
    privateInputs: { github: { githubToken: SECRET } }, changed: 'input', written: project => [join(project, '.mcp.json')],
    mutate: ({ live }) => { live.privateInputs.github.githubToken = `${SECRET}-rotated`; } });
  await stale('host', { selections: reviewSelection, changed: 'host', written: skillTarget,
    mutate: ({ work }) => {
      const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      const other = join(work, 'other-home'); mkdirSync(other);
      process.env.HOME = other; process.env.USERPROFILE = other;
      return () => { process.env.HOME = previous.HOME; process.env.USERPROFILE = previous.USERPROFILE; };
    } });
  // Enterprise authority rereads are part of the policy binding.
  const { value: { recipeIdentity } } = await deriveRecipeIdentity({ recipe: render(skill) });
  const organization = selectionId => ({ schema: 'urn:aihq:core:organization-policy:1.0.0', id: 'example-org',
    selections: [{ selectionId, recipeIdentity, scopes: ['project'], inputs: {} }] });
  const originalFetch = globalThis.fetch;
  try {
    const { project, controls } = workspace('stale-organization');
    const enterprise = policy14([selection('review', render(skill), { organizationSelectionId: 'review', ...describe(skill, 'Code review') })], { mode: 'enterprise' });
    const source = serveOrganization(organization('review'));
    const prepared = await ask(enterprise, project, controls, { organizationSource: source });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    serveOrganization({ ...organization('review'), metadata: { revision: 2 } });
    const run = await apply(prepared.prepared, approve(prepared), controls);
    assert.deepEqual(run.diagnostics.map(item => [item.code, item.reason, item.changed]), [['REVIEW_STALE', 'binding-changed', 'policy']]);
  } finally { globalThis.fetch = originalFetch; }
  await trustStale();
});

await check('REVIEW_STALE reason handle-unavailable and digest-mismatch are not binding changes', async () => {
  const { project, controls } = workspace('handles');
  const prepared = await ask(policy14([selection('team', plainFile('team', 'TEAM.md', 'Team\n'))]), project, controls);
  const wrong = await apply(prepared.prepared, { ...approve(prepared), reviewDigest: '0'.repeat(64) }, controls);
  assert.deepEqual(result14(wrong).diagnostics.map(item => [item.code, item.reason, item.changed]), [['REVIEW_STALE', 'digest-mismatch', undefined]]);
  assert.equal(existsSync(join(project, 'TEAM.md')), false);
  assert.equal((await apply(prepared.prepared, approve(prepared), controls)).completion, 'complete');
  const consumed = await apply(prepared.prepared, approve(prepared), controls);
  assert.deepEqual(consumed.diagnostics.map(item => [item.code, item.reason, item.changed]), [['REVIEW_STALE', 'handle-unavailable', undefined]]);
  const lost = await apply({}, approve(prepared), controls);
  assert.deepEqual(lost.diagnostics.map(item => [item.code, item.reason]), [['REVIEW_STALE', 'handle-unavailable']]);
});

await check('new scan evidence and index status never invalidate a held preparation', async () => {
  const { project, controls, catalog } = workspace('fresh-evidence');
  const scan = join(project, 'scan.json');
  const evidence = [{ schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: `scan:sha256:${'b'.repeat(64)}`, location: { kind: 'file', path: scan } }];
  // Core holds no index binding: a consumer-side index file changing beside the material root is not reviewed state.
  const index = join(catalog, 'release', 'index.json');
  writeFileSync(index, JSON.stringify({ status: 'current' }));
  const live = { ...controls, evidence: { acquire: true, trust: { keys: [], publishers: [] } } };
  const prepared = await ask(policy14([selection('review', render(skill), describe(skill, 'Code review'))], { evidence }), project, live);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  writeFileSync(scan, JSON.stringify({ schema: 'urn:aihq:scan:report:9.9.9', findings: ['new'] }));
  writeFileSync(index, JSON.stringify({ status: 'revoked' }));
  const run = await apply(prepared.prepared, approve(prepared), live);
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.equal(run.diagnostics.some(item => item.code === 'REVIEW_STALE'), false);
});

/** Trust custody that claims a reviewed path after Prepare is a changed trust binding. */
async function trustStale() {
  // Its own home, so the trust custody it leaves never reaches another check.
  const work = mkdtempSync(join(process.env.HOME, 'stale-trust-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = join(work, 'home'); mkdirSync(home);
  process.env.HOME = home; process.env.USERPROFILE = home;
  try { await trustStaleIn(work); }
  finally { process.env.HOME = previous.HOME; process.env.USERPROFILE = previous.USERPROFILE; }
}
async function trustStaleIn(work) {
  const project = join(work, 'project'); mkdirSync(project);
  const pem = join(work, 'team.pem'); copyFileSync(new URL('./root-a.pem', import.meta.url), pem);
  const output = ['.aih', 'exports', 'os-ca.pem'];
  const userFile = { schema: 'urn:aihq:core:recipe:1.0.0', id: 'ca', description: 'Write a user file', inputs: {}, materials: [],
    targets: ['user'], prerequisites: [], checks: [], operations: [{ id: 'write', purpose: 'Write a user file', kind: 'file.write',
      scope: 'user', requires: [], checks: [], target: { root: 'userHome', segments: output.map(literal => ({ literal })) }, content: { literal: 'mine\n' } }] };
  const held = await ask(policy14([{ ...selection('ca', userFile), scope: 'user' }]), project, { logging: 'off' });
  assert.equal(held.status, 'ready', JSON.stringify(held.diagnostics));
  const exported = await prepare({ schema: 'urn:aihq:core:certificate-export-request:1.0.0', useCase: 'certificate-export',
    sources: { os: false, supplied: [{ id: 'team', file: pem }] } }, { logging: 'off' });
  if (exported.status === 'ready') assert.equal((await apply(exported.prepared, approve(exported), { logging: 'off' })).completion, 'complete');
  else {
    // Certificate export is admitted only on recorded platforms. Elsewhere, stand in for its committed result: the
    // published trust-custody 1.0.0 fixture, which records this output path, at the published state location.
    assert.ok(['trust-platform-unsupported', 'trust-format-unavailable'].includes(reasons(exported)[0]), JSON.stringify(exported.diagnostics));
    const custody = readFileSync(require.resolve('@aihq/core/fixtures/core/trust-custody/1.0.0/accept.json'));
    assert.equal(JSON.parse(custody).entries[0].relativePath, output.join('/'));
    const { root } = resolveStateLocation();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'trust-custody.json'), custody, { mode: 0o600 });
  }
  const run = await apply(held.prepared, approve(held), { logging: 'off' });
  assert.deepEqual(run.diagnostics.map(item => [item.code, item.reason, item.changed]), [['REVIEW_STALE', 'binding-changed', 'trust']]);
  assert.equal(existsSync(join(process.env.HOME, ...output)) && readFileSync(join(process.env.HOME, ...output), 'utf8') === 'mine\n', false);
  checks.push(exported.status === 'ready' ? 'trust: after a certificate export' : 'trust: published custody fixture standing in for an unadmitted export');
}

function serveOrganization(document) {
  const bytes = Buffer.from(JSON.stringify(document)), commit = 'a'.repeat(40);
  const blob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  const tree = n => String(n).padStart(40, '0'), base = '/repos/example-org/org-policy/git';
  const routes = {
    [`${base}/commits/${commit}`]: { sha: commit, tree: { sha: tree(1) } },
    [`${base}/trees/${tree(1)}`]: { sha: tree(1), truncated: false, tree: [{ path: 'policy', mode: '040000', type: 'tree', sha: tree(2) }] },
    [`${base}/trees/${tree(2)}`]: { sha: tree(2), truncated: false, tree: [{ path: 'org.json', mode: '100644', type: 'blob', sha: blob, size: bytes.length }] },
    [`${base}/blobs/${blob}`]: { sha: blob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') } };
  globalThis.fetch = async url => {
    const body = routes[new URL(String(url)).pathname];
    return new Response(JSON.stringify(body ?? { message: 'Not Found' }), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
  };
  return { provider: 'github', repository: { owner: 'example-org', name: 'org-policy' }, path: 'policy/org.json', revision: { kind: 'commit', value: commit } };
}

process.stdout.write(`${JSON.stringify({ status: 'passed', checks })}\n`);
