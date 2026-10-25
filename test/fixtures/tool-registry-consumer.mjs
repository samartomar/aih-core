// Runs inside a disposable consumer with the packed @aihq/core installed; public entries only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { prepare } from '@aihq/core';
import { contractSupport as coreSupport, deriveRecipeIdentity, validateOrganizationTarget } from '@aihq/core/contracts';
import { contractSupport as harnessSupport, listTools, nativeClientIds, selectTool, toolRegistry,
  validateToolRegistry } from '@aihq/core/harness';
import registrySchema from '@aihq/core/harness/schemas/tool-registry/1.0.0.json' with { type: 'json' };
import target10Schema from '@aihq/core/schemas/organization-target/1.0.0.json' with { type: 'json' };
import target11Schema from '@aihq/core/schemas/organization-target/1.1.0.json' with { type: 'json' };
import acceptRegistry from '@aihq/core/fixtures/harness/tool-registry/1.0.0/accept.json' with { type: 'json' };
import refuseRegistry from '@aihq/core/fixtures/harness/tool-registry/1.0.0/refuse.json' with { type: 'json' };
import acceptTarget11 from '@aihq/core/fixtures/core/organization-target/1.1.0/accept.json' with { type: 'json' };
import refuseTarget11 from '@aihq/core/fixtures/core/organization-target/1.1.0/refuse.json' with { type: 'json' };

const REGISTRY = 'urn:aihq:harness:tool-registry:1.0.0';
const TARGET10 = 'urn:aihq:core:organization-target:1.0.0';
const TARGET11 = 'urn:aihq:core:organization-target:1.1.0';
const golden = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const reasons = result => result.diagnostics.map(item => [item.code, item.reason]);
const checks = [];
const check = (name, body) => { body(); checks.push(name); };

check('registry is published with its schema', () => {
  assert.equal(registrySchema.$id, REGISTRY);
  assert.equal(toolRegistry.schema, REGISTRY);
  assert.partialDeepStrictEqual(harnessSupport.contracts.find(item => item.id === REGISTRY),
    { id: REGISTRY, role: 'produces', schemaExport: '@aihq/core/harness/schemas/tool-registry/1.0.0.json' });
  const ajv = new Ajv2020({ strict: true });
  assert.equal(ajv.validate(registrySchema, toolRegistry), true, JSON.stringify(ajv.errors));
  assert.equal(validateToolRegistry(toolRegistry).valid, true);
  assert.deepEqual(acceptRegistry, JSON.parse(JSON.stringify(toolRegistry)), 'the accept fixture is the shipped registry');
  assert.equal(validateToolRegistry(refuseRegistry).valid, false);
  for (const entry of toolRegistry.tools) assert.deepEqual(Object.keys(entry), ['id', 'label', 'surface', 'binaries', 'aliases']);
  assert.ok(Object.isFrozen(toolRegistry) && Object.isFrozen(toolRegistry.tools) && toolRegistry.tools.every(Object.isFrozen));
});

check('command-line tools and IDEs are separate entries', () => {
  const byId = Object.fromEntries(toolRegistry.tools.map(entry => [entry.id, entry]));
  assert.deepEqual(new Set(toolRegistry.tools.map(entry => entry.surface)), new Set(['cli', 'ide']));
  assert.equal(byId.kiro.surface, 'cli');
  assert.equal(byId['kiro-ide'].surface, 'ide');
  assert.equal(byId.copilot.surface, 'cli');
  assert.equal(byId['copilot-vscode'].surface, 'ide');
  assert.deepEqual(byId.claude.aliases, ['claude-code']);
  assert.deepEqual(byId.antigravity.binaries, ['agy']);
  assert.notEqual(byId.antigravity.id, byId.gemini.id);
  assert.deepEqual(byId.gemini.binaries, ['gemini']);
  const names = toolRegistry.tools.flatMap(entry => [entry.id, ...entry.aliases]);
  assert.equal(new Set(names).size, names.length, 'ids and aliases name one tool each');
});

check('existing native client ids stay valid registry ids', () => {
  const ids = toolRegistry.tools.map(entry => entry.id);
  for (const client of nativeClientIds) assert.ok(ids.includes(client), client);
  assert.deepEqual(target10Schema.properties.client.enum, [...nativeClientIds]);
});

check('listTools offers only observed tools: today\'s command-line tools and no IDE', () => {
  const offered = listTools();
  assert.deepEqual(JSON.parse(JSON.stringify(offered)), golden);
  assert.deepEqual(JSON.parse(JSON.stringify(listTools({}))), golden);
  assert.equal(offered.some(entry => entry.surface === 'ide'), false);
  const all = listTools({ includeUnobserved: true });
  assert.deepEqual(all.map(entry => entry.id), toolRegistry.tools.map(entry => entry.id));
  for (const id of ['kiro-ide', 'copilot-vscode', 'gemini', 'cursor']) assert.ok(all.some(entry => entry.id === id), id);
  assert.deepEqual(JSON.parse(JSON.stringify(listTools({ includeUnobserved: false }))), golden);
  assert.throws(() => listTools({ includeUnobserved: 'yes' }), TypeError);
  assert.throws(() => listTools({ unknown: true }), TypeError);
});

check('a request naming a tool resolves its alias or is refused with a named reason', () => {
  const alias = selectTool('claude-code');
  assert.equal(alias.status, 'selected');
  assert.equal(alias.tool.id, 'claude');
  assert.equal(selectTool('claude').tool, alias.tool);
  for (const id of ['kiro-ide', 'copilot-vscode', 'gemini']) {
    const refused = selectTool(id);
    assert.deepEqual({ status: refused.status, code: refused.code, reason: refused.reason },
      { status: 'refused', code: 'PREREQUISITE_UNAVAILABLE', reason: 'tool-not-observed' }, id);
    assert.equal(refused.tool.id, id);
  }
  const unknown = selectTool('not-a-tool');
  assert.deepEqual(unknown, { status: 'refused', code: 'INPUT_INVALID', reason: 'unknown-tool' });
  assert.equal(selectTool(42).reason, 'unknown-tool');
});

check('organization target 1.1 accepts registry tool ids with their surface', () => {
  assert.equal(target11Schema.$id, TARGET11);
  for (const id of [TARGET10, TARGET11])
    assert.partialDeepStrictEqual(coreSupport.contracts.find(item => item.id === id), { id, role: 'accepts' });
  assert.equal(validateOrganizationTarget(acceptTarget11).valid, true);
  assert.equal(validateOrganizationTarget(refuseTarget11).valid, false);
  for (const entry of toolRegistry.tools) {
    const declared = { schema: TARGET11, tool: { id: entry.id, surface: entry.surface }, repository: 'github.com/example-org/app' };
    assert.equal(validateOrganizationTarget(declared).valid, true, entry.id);
  }
  const invalid = tool => reasons(validateOrganizationTarget({ schema: TARGET11, tool }));
  assert.deepEqual(invalid({ id: 'kiro', surface: 'ide' }), [['INPUT_INVALID', 'tool-surface-mismatch']]);
  assert.deepEqual(invalid({ id: 'claude-code', surface: 'cli' }), [['INPUT_INVALID', 'tool-alias']]);
  assert.deepEqual(invalid({ id: 'not-a-tool', surface: 'cli' }), [['INPUT_INVALID', 'unknown-tool']]);
  assert.equal(validateOrganizationTarget({ schema: TARGET11, tool: { id: 'claude' } }).valid, false);
  assert.equal(validateOrganizationTarget({ schema: TARGET11, client: 'claude' }).valid, false);
});

check('organization target 1.0 keeps its closed client roster', () => {
  assert.equal(validateOrganizationTarget({ schema: TARGET10, client: 'codex' }).valid, true);
  for (const client of ['kiro-ide', 'copilot-vscode', 'claude-code', 'not-a-tool'])
    assert.equal(validateOrganizationTarget({ schema: TARGET10, client }).valid, false, client);
});

// Enterprise Prepare through the public API, against a fake GitHub organization source.
const recipe = {
  schema: 'urn:aihq:core:recipe:1.0.0', id: 'team-note', description: 'Team note',
  inputs: { text: { type: 'string', required: true, maxLength: 4096 } },
  materials: [], targets: ['project'], prerequisites: [], checks: [],
  operations: [{ id: 'write', purpose: 'Write team note', kind: 'file.write',
    scope: 'project', target: { root: 'project', segments: [{ literal: 'TEAM.md' }] },
    content: { input: 'text' }, requires: [], checks: [] }]
};
const identity = await deriveRecipeIdentity({ recipe });
assert.equal(identity.status, 'ok');
const policy = { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'enterprise', selections: [{
  id: 'note', managementId: 'team-note', scope: 'project', organizationSelectionId: 'team-note',
  configuration: { text: 'Read CONTRIBUTING.md\n' }, requires: [], recipe: { inline: recipe } }] };
const organization = clients => Buffer.from(JSON.stringify({ schema: 'urn:aihq:core:organization-policy:1.1.0', id: 'team',
  selections: [{ selectionId: 'team-note', recipeIdentity: identity.value.recipeIdentity, scopes: ['project'],
    inputs: { text: { allowDeclared: true } }, obligation: 'required', clients }] }));
const commit = 'a'.repeat(40);
const tree = index => String(index).padStart(40, '0');
const calls = [];
const serve = bytes => {
  const blob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  const base = '/repos/example-org/org-policy/git';
  const routes = {
    [`${base}/commits/${commit}`]: { sha: commit, tree: { sha: tree(1) } },
    [`${base}/trees/${tree(1)}`]: { sha: tree(1), truncated: false, tree: [{ path: 'policy', mode: '040000', type: 'tree', sha: tree(2) }] },
    [`${base}/trees/${tree(2)}`]: { sha: tree(2), truncated: false,
      tree: [{ path: 'org.json', mode: '100644', type: 'blob', sha: blob, size: bytes.length }] },
    [`${base}/blobs/${blob}`]: { sha: blob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }
  };
  globalThis.fetch = async url => {
    const { pathname } = new URL(String(url)); calls.push(pathname);
    const body = routes[pathname];
    return new Response(JSON.stringify(body ?? { message: 'Not Found' }), { status: body ? 200 : 404,
      headers: { 'content-type': 'application/json' } });
  };
};
const scratch = mkdtempSync(join(tmpdir(), 'aih-tool-target-'));
const run = organizationTarget => prepare({ useCase: 'policy', policy, target: { project: mkdtempSync(join(scratch, 'p-')) },
  organizationSource: { provider: 'github', repository: { owner: 'example-org', name: 'org-policy' }, path: 'policy/org.json',
    revision: { kind: 'commit', value: commit } }, organizationTarget }, { logging: 'off' });

serve(organization(['claude']));
const applies = await run({ schema: TARGET11, tool: { id: 'claude', surface: 'cli' } });
assert.equal(applies.status, 'ready', JSON.stringify(applies.diagnostics));
assert.equal(applies.review.schema, 'urn:aihq:core:prepared-work:1.5.0');
assert.deepEqual(applies.review.organizationObligations.target, { basis: 'declared', client: 'claude' });
assert.deepEqual(applies.review.organizationObligations.fulfillment.map(item => [item.applicability, item.status]), [['applies', 'fulfilled']]);
checks.push('Enterprise Prepare evaluates a 1.1 registry tool target');

const denied = await run({ schema: TARGET11, tool: { id: 'codex', surface: 'cli' } });
assert.equal(denied.status, 'blocked');
assert.deepEqual(reasons(denied), [['AUTHORITY_DENIED', 'client']]);
checks.push('a 1.1 target outside the client selector is denied');

calls.length = 0;
const unobserved = await run({ schema: TARGET11, tool: { id: 'kiro-ide', surface: 'ide' } });
assert.equal(unobserved.status, 'blocked');
assert.equal(unobserved.prepared, undefined);
assert.deepEqual(reasons(unobserved), [['PREREQUISITE_UNAVAILABLE', 'tool-not-observed']]);
assert.equal(calls.length, 0, 'no organization read for an unobserved tool');
const roster = await run({ schema: TARGET10, client: 'kiro-ide' });
assert.equal(roster.status, 'invalid');
assert.deepEqual(roster.diagnostics.map(item => item.code), ['INPUT_INVALID']);
assert.equal(calls.length, 0);
checks.push('Prepare refuses an unobserved tool target and keeps the 1.0 roster');

console.log(JSON.stringify({ status: 'passed', checks }));
