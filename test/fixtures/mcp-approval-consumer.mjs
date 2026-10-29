// Runs inside a disposable consumer with the packed @aihq/core installed (or this package by self-reference);
// public entries only. One-server MCP approval: rendered, reviewed, applied, inventoried and removed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { checkCompatibility, renderDelivery, toolBindings, validateToolBinding } from '@aihq/core/harness';
import { validateRecipe } from '@aihq/core/contracts';
import { apply, listManagedSelections, prepare } from '@aihq/core';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const plain = value => JSON.parse(JSON.stringify(value));
const FRAMEWORK = 'example-framework';
const BEHAVIOUR = 'aih-behaviour.json';
const SECRET = 'ghp_example_value_never_published_0123456789';

/** An independently built Catalog release 1.6 item: content materials with bytes, one behaviour file, both identities. */
function catalogItem({ id, kind, payload, files, requirements = { inputs: {} } }) {
  const content = Object.entries(files).map(([relPath, text], index) => ({
    id: relPath === 'LICENSE' ? 'license' : `m${index}`, relPath, sourcePath: relPath,
    packagePath: `release/items/${id}/${relPath}`, sha256: sha256(text), byteLength: Buffer.byteLength(text),
    executable: false, sourceId: 'upstream', role: 'content' }));
  const dependencies = { requires: [], optional: [], conflicts: [] };
  const executable = Object.fromEntries(content.map(member => [member.relPath, false]));
  const behaviourText = `${canonical({ kind, payload, requirements, dependencies, executable })}\n`;
  const behaviour = { id: 'behaviour', relPath: BEHAVIOUR, sourcePath: null, packagePath: `release/items/${id}/${BEHAVIOUR}`,
    sha256: sha256(behaviourText), byteLength: Buffer.byteLength(behaviourText), executable: false, sourceId: FRAMEWORK, role: 'behaviour' };
  const lines = members => members.map(member => `${member.relPath}\t${member.sha256}\n`).sort().join('');
  return { id, label: id, kind, sourceIds: ['upstream'], targets: [], scopes: ['project'], inputs: {},
    materials: [...content, behaviour].sort((a, b) => a.id < b.id ? -1 : 1), dependencies, requirements, executable,
    contentSha256: sha256(lines(content)), behaviourSha256: sha256(lines([...content, behaviour])), payload };
}
/** A shipped binding with layout overrides and a recomputed digest. */
function bindingWith(tool, layouts = {}) {
  const { digest, ...binding } = plain(toolBindings.find(item => item.tool === tool));
  for (const [kind, fields] of Object.entries(layouts)) Object.assign(binding.layouts[kind], fields);
  return { ...binding, digest: sha256(canonical(binding)) };
}
const targetPath = target => [target.root, ...target.segments.map(segment => segment.literal)].join('/');
const server = (key, extra = {}) => catalogItem({ id: key, kind: 'mcp-server', files: { LICENSE: 'MIT\n' },
  requirements: { inputs: { githubToken: { type: 'string', required: true, sensitive: true } } },
  payload: { key, transport: 'stdio', command: 'npx', args: ['-y', `${key}-mcp`],
    env: { GITHUB_TOKEN: { input: 'githubToken' }, LOG_LEVEL: { value: 'warn' } }, ...extra } });
const github = server('github');
const ref = item => ({ framework: FRAMEWORK, itemId: item.id });

const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

await check('an array approval location renders one config.member add for the ticked server only', async () => {
  const binding = toolBindings.find(item => item.tool === 'claude');
  const register = binding.layouts['mcp-server'].register;
  assert.deepEqual(register.approvalLocation, { shape: 'array', file: '.claude/settings.local.json', format: 'json',
    container: ['enabledMcpjsonServers'], denied: ['disabledMcpjsonServers'] });
  const rendered = renderDelivery({ tool: 'claude', item: github, binding, scope: 'project', grantApproval: ref(github) });
  assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
  const { recipe } = rendered;
  assert.equal(recipe.schema, 'urn:aihq:core:recipe:1.4.0');
  assert.equal(validateRecipe(recipe).valid, true, JSON.stringify(validateRecipe(recipe).diagnostics));
  const approvals = recipe.operations.filter(op => op.approval);
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0], { id: 'approve-server', purpose: 'Allow the github MCP server in Claude Code', kind: 'config.member', scope: 'project',
    target: { root: 'project', segments: [{ literal: '.claude' }, { literal: 'settings.local.json' }] }, format: 'json',
    container: ['enabledMcpjsonServers'], action: 'add', value: { literal: 'github' }, exclusiveWith: [['disabledMcpjsonServers']],
    approval: { tool: 'claude' }, requires: ['register-server'], checks: [] });
  // Never an approve-all switch: nothing but the server's own registration and its one member is written.
  assert.deepEqual(recipe.operations.map(op => [op.kind, targetPath(op.target)]), [
    ['config.entries', 'project/.mcp.json'], ['config.member', 'project/.claude/settings.local.json']]);
  assert.equal(JSON.stringify(recipe).includes('enableAllProjectMcpServers'), false);
});


const objectKeyed = bindingWith('claude', { 'mcp-server': { register: { ...plain(toolBindings[0].layouts['mcp-server'].register),
  approvalLocation: { shape: 'object-keyed', file: '.claude/approvals.json', format: 'json', container: ['mcpServerApprovals'], approved: 'allow' } } } });

await check('an object-keyed approval location renders one config.entries set on that server key', async () => {
  assert.equal(validateToolBinding(objectKeyed).valid, true);
  const register = plain(toolBindings[0].layouts['mcp-server'].register);
  const overlapping = bindingWith('claude', { 'mcp-server': { register: { ...register,
    approvalLocation: { ...register.approvalLocation, denied: ['enabledMcpjsonServers', 'denied'] } } } });
  assert.deepEqual(validateToolBinding(overlapping).diagnostics.map(item => item.reason), ['approval-location-invalid']);
  const onHooks = bindingWith('claude', { hook: { register: { ...plain(toolBindings[0].layouts.hook.register), approvalLocation: { shape: 'other' } } } });
  assert.deepEqual(validateToolBinding(onHooks).diagnostics.map(item => item.reason), ['approval-location-invalid']);
  const rendered = renderDelivery({ tool: 'claude', item: github, binding: objectKeyed, scope: 'project', grantApproval: ref(github) });
  assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
  const approvals = rendered.recipe.operations.filter(op => op.approval);
  assert.deepEqual(approvals, [{ id: 'approve-server', purpose: 'Allow the github MCP server in Claude Code', kind: 'config.entries', scope: 'project',
    target: { root: 'project', segments: [{ literal: '.claude' }, { literal: 'approvals.json' }] }, format: 'json',
    entries: [{ path: ['mcpServerApprovals', 'github'], action: 'set', value: { literal: 'allow' } }],
    approval: { tool: 'claude' }, requires: ['register-server'], checks: [] }]);
  assert.equal(validateRecipe(rendered.recipe).valid, true);
});

await check('any other approval shape is refused with guidance to approve in the tool', async () => {
  const refused = renderDelivery({ tool: 'codex', item: github, binding: toolBindings.find(item => item.tool === 'codex'), scope: 'user', grantApproval: ref(github) });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.code, 'PREREQUISITE_UNAVAILABLE');
  assert.equal(refused.reason, 'approval-shape-unsupported');
  assert.equal(refused.guidance, "Still needs your OK in Codex CLI. Allow the server's tool calls in the Codex approval policy.");
  const unnamed = bindingWith('claude', { 'mcp-server': { register: { ...plain(toolBindings[0].layouts['mcp-server'].register), approvalLocation: { shape: 'other' } } } });
  assert.equal(renderDelivery({ tool: 'claude', item: github, binding: unnamed, scope: 'project', grantApproval: ref(github) }).reason, 'approval-shape-unsupported');
  // Without a tick nothing is granted, and the recipe keeps its earlier format.
  const plainRender = renderDelivery({ tool: 'claude', item: github, binding: toolBindings[0], scope: 'project' });
  assert.equal(plainRender.recipe.schema, 'urn:aihq:core:recipe:1.0.0');
  assert.equal(plainRender.recipe.operations.some(op => op.approval || op.kind === 'config.member'), false);
});

await check('grantApproval names exactly the one server being rendered: never a list, another item or a non-server', async () => {
  const skill = catalogItem({ id: 'review', kind: 'skill', files: { 'SKILL.md': '---\nname: review\ndescription: Review\n---\n' }, payload: { dirName: 'review' } });
  for (const [item, grant] of [[github, [ref(github)]], [github, [ref(github), ref(server('other'))]], [github, ref(server('other'))],
    [github, { ...ref(github), all: true }], [github, true], [skill, ref(skill)]]) {
    const refused = renderDelivery({ tool: 'claude', item, binding: toolBindings[0], scope: 'project', grantApproval: grant });
    assert.deepEqual([refused.status, refused.code, refused.reason], ['refused', 'INPUT_INVALID', 'grant-approval'], JSON.stringify(grant));
  }
});

await check('compatibility says the server still needs your OK in the tool', async () => {
  const result = checkCompatibility({ tool: 'claude', platform: { os: 'windows', arch: 'x64' }, binding: toolBindings[0], items: [{ item: github }] });
  assert.equal(result.status, 'checked');
  assert.equal(result.items[0].permissionStep, 'Still needs your OK in Claude Code. Approve the project MCP server in Claude Code.');
});

const ORG = 'acme-visible-org';
const configured = catalogItem({ id: 'issues', kind: 'mcp-server', files: { LICENSE: 'MIT\n' },
  requirements: { inputs: { githubToken: { type: 'string', required: true, sensitive: true }, org: { type: 'string', required: true } } },
  payload: { key: 'issues', transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: { input: 'githubToken' }, GITHUB_ORG: { input: 'org' } } } });

await check('an MCP input is written only as a reference by name, never as a value, sensitive or not', async () => {
  const { recipe } = renderDelivery({ tool: 'claude', item: configured, binding: toolBindings[0], scope: 'project' });
  const register = recipe.operations.find(op => op.id === 'register-server');
  assert.deepEqual(register.entries.filter(entry => entry.path[3]?.startsWith('GITHUB_')).map(entry => [entry.path.at(-1), entry.value]),
    [['GITHUB_TOKEN', { literal: '${githubToken}' }], ['GITHUB_ORG', { literal: '${org}' }]]);
  assert.deepEqual(recipe.inputs, { githubToken: { type: 'string', required: true, sensitive: true }, org: { type: 'string', required: true } });
  const dotted = catalogItem({ id: 'dotted', kind: 'mcp-server', files: { LICENSE: 'MIT\n' },
    requirements: { inputs: { 'api.key': { type: 'string', required: true, sensitive: true } } },
    payload: { key: 'dotted', transport: 'stdio', command: 'npx', env: { KEY: { input: 'api.key' } } } });
  const refused = renderDelivery({ tool: 'claude', item: dotted, binding: toolBindings[0], scope: 'project' });
  assert.deepEqual([refused.code, refused.reason], ['PREREQUISITE_UNAVAILABLE', 'input-reference-invalid']);
});

await check('Core accepts an approval only for one server its recipe registers: never several, never a switch', async () => {
  const { recipe } = renderDelivery({ tool: 'claude', item: github, binding: toolBindings[0], scope: 'project', grantApproval: ref(github) });
  const approve = recipe.operations.find(op => op.id === 'approve-server');
  const reasons = operations => validateRecipe({ ...recipe, operations }).diagnostics.map(item => item.reason);
  const allSwitch = { ...approve, id: 'approve-all', kind: 'config.entries', entries: [{ path: ['enableAllProjectMcpServers'], action: 'set', value: { literal: true } }] };
  delete allSwitch.container; delete allSwitch.action; delete allSwitch.value; delete allSwitch.exclusiveWith;
  assert.deepEqual(reasons([recipe.operations[0], allSwitch]), ['approval-server-unregistered']);
  assert.deepEqual(reasons([...recipe.operations, { ...approve, id: 'approve-other', value: { literal: 'other' } }]), ['approval-one-server']);
  assert.deepEqual(reasons([recipe.operations[0], { ...approve, requires: [] }]), ['approval-server-unregistered']);
  assert.deepEqual(reasons(recipe.operations), []);
});

// Engine flow in a disposable project and home.
const sandbox = realpathSync.native(mkdtempSync(join(process.env.HOME, 'mcp-approval-')));
// Produced documents are checked against the package's exported schemas.
const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const id of ['prepared-work/1.4.0', 'prepared-work/1.5.0', 'prepared-work/1.6.0', 'run-result/1.4.0', 'managed-inventory-result/1.1.0'])
  ajv.addSchema(JSON.parse(readFileSync(new URL(import.meta.resolve(`@aihq/core/schemas/${id}.json`)), 'utf8')));
const validator = id => value => { const validate = ajv.getSchema(id); assert.equal(validate(plain(value)), true, `${id}: ${JSON.stringify(validate.errors)}`); };
const validPrepared = validator('urn:aihq:core:prepared-work:1.6.0');
const validRun = validator('urn:aihq:core:run-result:1.4.0');
const validInventory = validator('urn:aihq:core:managed-inventory-result:1.1.0');
const project = name => { const root = join(sandbox, name); mkdirSync(root); return root; };
const selection = (item, binding = toolBindings[0], grant = true) => ({ id: item.id, managementId: `${item.id}-managed`, scope: 'project', configuration: {},
  requires: [], recipe: { inline: renderDelivery({ tool: 'claude', item, binding, scope: 'project', ...(grant ? { grantApproval: ref(item) } : {}) }).recipe },
  item: { framework: FRAMEWORK, itemId: item.id, contentSha256: item.contentSha256, behaviourSha256: item.behaviourSha256 },
  tool: 'claude', name: `Server ${item.id}`, kind: 'mcp-server', origins: [{ reasonIncluded: 'chosen' }] });
const policy = (selections, extra = {}) => ({ schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections, ...extra });
const secrets = item => ({ privateInputs: { [item.id]: { githubToken: SECRET } } });
const outputs = [];
async function prepared(root, document, controls = {}) {
  const result = await prepare({ useCase: 'policy', policy: document, target: { project: root } }, { logging: 'on', ...controls });
  outputs.push(result);
  if (result.review) validPrepared(result.review);
  return result;
}
async function applied(result, controls = {}, allowPartial = false) {
  const run = await apply(result.prepared, { approved: true, origin: 'automation', reviewDigest: result.review.reviewDigest, ...(allowPartial ? { allowPartial } : {}) },
    { logging: 'on', ...controls });
  outputs.push(run); validRun(run);
  return run;
}
const inventory = async root => {
  const listed = await listManagedSelections({ target: { project: root }, scope: 'project', format: 'urn:aihq:core:managed-inventory-result:1.1.0' });
  outputs.push(listed); validInventory(listed);
  return listed;
};
const remove = async (root, item) => {
  const result = await prepared(root, policy([], { removals: [{ scope: 'project', managementId: `${item.id}-managed` }] }));
  return result;
};
const settings = root => join(root, '.claude', 'settings.local.json');
const read = path => readFileSync(path, 'utf8');
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

await check('grant then remove: one member added beside the others, shown granted-by-aih, then removed restoring the earlier bytes', async () => {
  const root = project('grant-array');
  const earlier = '{\n  "enabledMcpjsonServers": ["mine"],\n  "theme": "dark"\n}\n';
  write(settings(root), earlier);
  const ready = await prepared(root, policy([selection(github)]), secrets(github));
  assert.equal(ready.status, 'ready', JSON.stringify(ready.diagnostics));
  const approve = ready.review.operations.find(op => op.id === 'github/approve-server');
  assert.deepEqual([approve.kind, approve.effects, approve.ownership, approve.details.approval, approve.details.member],
    ['config.member', 'replace-file', 'unowned', { tool: 'claude' }, { container: ['enabledMcpjsonServers'], action: 'add', value: '"github"' }]);
  assert.equal(ready.review.selections[0].permissionStep, undefined, 'the ticked server no longer waits for an OK');
  assert.deepEqual(ready.review.selections[0].inputs, ['githubToken']);
  const run = await applied(ready, secrets(github));
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.deepEqual(JSON.parse(read(settings(root))), { enabledMcpjsonServers: ['mine', 'github'], theme: 'dark' });
  assert.deepEqual(run.members.filter(member => member.operationId === 'github/approve-server').map(member => [member.kind, member.pointer, member.outcome, member.check]),
    [['config-member', '/enabledMcpjsonServers', 'written', 'present-matching']]);
  const listed = await inventory(root);
  const row = listed.selections.find(item => item.managementId === 'github-managed');
  assert.equal(row.approval, 'granted-by-aih');
  assert.deepEqual(row.members.filter(member => member.kind === 'config-member').map(member => [member.path, member.pointer, member.fileState]),
    [[settings(root), '/enabledMcpjsonServers', 'matches']]);
  const removal = await remove(root, github);
  assert.equal(removal.status, 'ready', JSON.stringify(removal.diagnostics));
  const removed = await applied(removal);
  assert.equal(removed.completion, 'complete', JSON.stringify(removed.diagnostics));
  assert.equal(read(settings(root)), earlier, 'only the granted member is removed; the earlier bytes are back');
  assert.deepEqual(removed.members.filter(member => member.kind === 'config-member').map(member => [member.outcome, member.check]), [['claim-removed', 'absent']]);
  assert.equal((await inventory(root)).selections.some(item => item.managementId === 'github-managed'), false);
});

await check('an array Core created goes with the last approval Core added, restoring the absent location', async () => {
  const root = project('grant-created');
  write(settings(root), '{\n  "theme": "dark"\n}\n');
  const second = server('second');
  const run = await applied(await prepared(root, policy([selection(github), selection(second)]), { privateInputs: { github: { githubToken: SECRET }, second: { githubToken: SECRET } } }),
    { privateInputs: { github: { githubToken: SECRET }, second: { githubToken: SECRET } } });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.deepEqual(JSON.parse(read(settings(root))).enabledMcpjsonServers, ['github', 'second']);
  assert.equal((await applied(await remove(root, github))).completion, 'complete');
  assert.deepEqual(JSON.parse(read(settings(root))).enabledMcpjsonServers, ['second']);
  assert.equal((await applied(await remove(root, second))).completion, 'complete');
  assert.deepEqual(JSON.parse(read(settings(root))), { theme: 'dark' });
});

await check('without an approvals file, grant then remove leaves no approval location behind', async () => {
  const root = project('grant-no-file');
  await applied(await prepared(root, policy([selection(github)]), secrets(github)), secrets(github));
  assert.deepEqual(JSON.parse(read(settings(root))), { enabledMcpjsonServers: ['github'] });
  assert.equal((await applied(await remove(root, github))).completion, 'complete');
  // The file Core created to hold the location stays as an empty object.
  assert.deepEqual(JSON.parse(read(settings(root))), {});
});

await check('a server the person already approved is left as it is: not rewritten, not owned, kept on removal', async () => {
  const root = project('preapproved');
  const earlier = '{ "enabledMcpjsonServers": ["github"] }\n';
  write(settings(root), earlier);
  const ready = await prepared(root, policy([selection(github)]), secrets(github));
  assert.equal(ready.status, 'ready', JSON.stringify(ready.diagnostics));
  const approve = ready.review.operations.find(op => op.id === 'github/approve-server');
  assert.deepEqual([approve.effects, approve.ownership], ['already-satisfied', 'unowned']);
  assert.equal(ready.review.selections[0].permissionStep, undefined, 'already allowed: no OK still needed');
  await applied(ready, secrets(github));
  assert.equal(read(settings(root)), earlier);
  assert.equal((await inventory(root)).selections.find(item => item.managementId === 'github-managed').approval, 'not-needed',
    "the person's own approval is seen, never claimed by Core");
  assert.equal((await applied(await remove(root, github))).completion, 'complete');
  assert.equal(read(settings(root)), earlier, "the person's approval stays after removal");
});

await check('a server the person denied is a STATE_CONFLICT and is never overwritten, not even by a reviewed replace', async () => {
  const root = project('denied');
  const earlier = '{ "disabledMcpjsonServers": ["github"] }\n';
  write(settings(root), earlier);
  const blocked = await prepared(root, policy([selection(github)]), secrets(github));
  assert.equal(blocked.status, 'partial');
  assert.deepEqual(blocked.diagnostics.filter(item => item.code === 'STATE_CONFLICT').map(item => item.reason), ['approval-denied']);
  assert.equal(blocked.review.operations.find(op => op.id === 'github/approve-server').effects, 'conflict');
  assert.equal(blocked.review.selections[0].permissionStep, 'Still needs your OK in Claude Code. Approve the project MCP server in Claude Code.');
  const replace = await prepare({ useCase: 'policy', policy: policy([selection(github)]), target: { project: root },
    resolutions: [{ selectionId: 'github', operationId: 'approve-server', choice: 'replace', observedSha256: sha256(earlier) }] }, { logging: 'off', ...secrets(github) });
  assert.deepEqual([replace.status, replace.diagnostics[0].reason], ['invalid', 'resolution-invalid']);
  const run = await applied(blocked, secrets(github), true);
  assert.equal(read(settings(root)), earlier);
  assert.deepEqual(run.members.filter(member => member.kind === 'config-member').map(member => [member.outcome, member.check]), [['kept', 'unchecked']]);
  // The same key holding another value in an object-keyed location is the person's choice too.
  const objectRoot = project('denied-object');
  write(join(objectRoot, '.claude', 'approvals.json'), '{ "mcpServerApprovals": { "github": "deny" } }\n');
  const denied = await prepared(objectRoot, policy([selection(github, objectKeyed)]), secrets(github));
  assert.deepEqual(denied.diagnostics.map(item => item.reason), ['approval-denied']);
});

await check('object-keyed: grant writes one key, a later edit by the person is kept on removal, an untouched grant is removed', async () => {
  const root = project('grant-object');
  const approvals = join(root, '.claude', 'approvals.json');
  const earlier = '{\n  "mcpServerApprovals": {\n    "mine": "allow"\n  }\n}\n';
  write(approvals, earlier);
  const run = await applied(await prepared(root, policy([selection(github, objectKeyed)]), secrets(github)), secrets(github));
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.deepEqual(JSON.parse(read(approvals)), { mcpServerApprovals: { mine: 'allow', github: 'allow' } });
  assert.equal((await inventory(root)).selections.find(item => item.managementId === 'github-managed').approval, 'granted-by-aih');
  // The person later changes the approval Core wrote: removal keeps their edit (keep-changed) and removes the rest.
  write(approvals, '{\n  "mcpServerApprovals": {\n    "mine": "allow",\n    "github": "ask"\n  }\n}\n');
  const removal = await remove(root, github);
  assert.equal(removal.status, 'partial');
  const changed = removal.review.operations.find(op => op.effects === 'conflict');
  assert.deepEqual([changed.kind, changed.details.entries], ['config.entries', [{ path: ['mcpServerApprovals', 'github'], action: 'remove' }]]);
  assert.deepEqual(removal.diagnostics.map(item => item.reason), ['managed-content-changed']);
  const removed = await applied(removal, {}, true);
  assert.equal(JSON.parse(read(approvals)).mcpServerApprovals.github, 'ask');
  assert.deepEqual(removed.members.filter(member => member.pointer === '/mcpServerApprovals/github').map(member => [member.intent, member.outcome, member.check]),
    [['remove', 'kept', 'unchecked']], 'a conflicting removal is never attempted');
  // Core created .mcp.json for the registration, so it goes with the registration entries; the kept approval lives elsewhere.
  assert.equal(existsSync(join(root, '.mcp.json')), false, 'the registration entries are removed, and with them the file Core created');

  const fresh = project('grant-object-remove');
  const freshApprovals = join(fresh, '.claude', 'approvals.json');
  write(freshApprovals, earlier);
  await applied(await prepared(fresh, policy([selection(github, objectKeyed)]), secrets(github)), secrets(github));
  assert.equal((await applied(await remove(fresh, github))).completion, 'complete');
  assert.deepEqual(JSON.parse(read(freshApprovals)), JSON.parse(earlier));
});

await check('a server not ticked still needs the OK in the tool: preview and inventory say so', async () => {
  const root = project('needed');
  const ready = await prepared(root, policy([selection(github, toolBindings[0], false)]), secrets(github));
  assert.equal(ready.review.selections[0].permissionStep, 'Still needs your OK in Claude Code. Approve the project MCP server in Claude Code.');
  await applied(ready, secrets(github));
  assert.equal((await inventory(root)).selections.find(item => item.managementId === 'github-managed').approval, 'needed');
  assert.equal(JSON.parse(read(join(root, '.mcp.json'))).mcpServers.github.env.GITHUB_TOKEN, '${githubToken}');
});

await check('a configured input value is never reviewed or written either', async () => {
  const root = project('configured');
  const chosen = { ...selection(configured, toolBindings[0], false), configuration: { org: ORG } };
  const ready = await prepared(root, policy([chosen]), secrets(configured));
  assert.deepEqual(ready.review.selections[0].inputs, ['githubToken', 'org']);
  await applied(ready, secrets(configured));
  assert.equal(read(join(root, '.mcp.json')).includes(ORG), false);
  assert.equal(JSON.parse(read(join(root, '.mcp.json'))).mcpServers.issues.env.GITHUB_ORG, '${org}');
});

await check('MCP input values appear in no preview, receipt, run result, inventory, history or written file: only the name', async () => {
  const published = JSON.stringify(outputs);
  assert.equal(published.includes(SECRET), false);
  assert.equal(published.includes(ORG), false);
  assert.equal(published.includes(sha256(SECRET)), false);
  assert.equal(published.includes('githubToken'), true);
  const files = [];
  const walk = folder => { for (const name of readdirSync(folder)) { const path = join(folder, name);
    if (statSync(path).isDirectory()) walk(path); else files.push(path); } };
  walk(process.env.HOME);
  assert.ok(files.some(path => path.includes('ownership')), 'receipts were written under the disposable home');
  for (const path of files) {
    const bytes = readFileSync(path);
    assert.equal(bytes.includes(SECRET), false, path);
    assert.equal(bytes.includes(sha256(SECRET)), false, path);
  }
});

console.log(JSON.stringify({ status: 'passed', checks }));
