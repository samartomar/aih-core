// A notices or licence document's recipe, and so its recipe identity, covers its own material bytes and its one place in
// the neutral notices folder, never which items require it. An organization entry authored for one requiring set admits
// the same document installed for any other, while every other kind keeps its exact identity. Real Catalog 1.7.0
// content: ECC's notices with agents and skills that require it, and two agents vendored with their bytes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare } from '../dist/core/index.js';
import { deriveRecipeIdentity } from '../dist/core/contracts.js';
import { renderSelectionRecipe } from '../dist/core/internal/recipeless.js';
import { renderSelectionDelivery, toolBindings } from '../dist/harness/contracts.mjs';
import { catalogRoot, controls } from './real-catalog-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-notices-identity-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(scratch, { recursive: true, force: true });
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const path = 'release-ecc.content.json';
const bytes = readFileSync(join(catalogRoot, path));
const ecc = JSON.parse(bytes);
const item = id => ecc.items.find(entry => entry.id === id);
const claude = toolBindings.find(binding => binding.tool === 'claude');
const notices = item('ecc.notices');
const AGENTS = ['ecc.agent.a11y-architect', 'ecc.agent.agent-evaluator'];
const skills = ecc.items.filter(entry => entry.kind === 'skill' &&
  entry.dependencies?.requires?.some(ref => ref.itemId === 'ecc.notices')).slice(0, 2);
const identityOf = async recipe => {
  const derived = await deriveRecipeIdentity({ recipe });
  assert.equal(derived.status, 'ok', JSON.stringify(derived));
  return derived.value.recipeIdentity;
};
const rendered = (requiredBy, tool = 'claude') => {
  const result = renderSelectionRecipe({ tool, binding: toolBindings.find(binding => binding.tool === tool), item: notices,
    scope: 'project', requiredBy });
  assert.equal(result.status, 'rendered', JSON.stringify(result));
  return result.recipe;
};

test('the notices recipe is the same for every requiring subset, order and requirer kind', async () => {
  assert.equal(skills.length, 2, 'ECC skills require its notices');
  const agents = AGENTS.map(item);
  const subsets = [[agents[0]], [agents[1]], agents, [...agents].reverse(), [skills[0]], skills, [skills[1], agents[0]], [...agents, ...skills]];
  const recipes = subsets.map(requiredBy => rendered(requiredBy));
  const identities = await Promise.all(recipes.map(identityOf));
  assert.equal(new Set(identities).size, 1, 'one identity whichever items require the notices');
  const [recipe] = recipes;
  assert.equal(recipe.id, 'claude.ecc.notices', 'the recipe id names no requiring item');
  const placed = recipe.operations.map(operation => operation.target.segments.map(segment => segment.literal).join('/'));
  const files = notices.payload.files?.length ? notices.payload.files.length : notices.materials.filter(member => member.role !== 'behaviour').length;
  assert.equal(placed.length, files, 'each notices file is written once');
  assert.ok(placed.every(where => where.startsWith('.aih/notices/ecc/ecc.notices/')), `only the neutral folder: ${placed}`);
  // Another tool's copy is its own recipe, and the requiring set does not change it either.
  const codex = await Promise.all([[skills[0]], skills].map(requiredBy => identityOf(rendered(requiredBy, 'codex'))));
  assert.equal(codex[0], codex[1]);
  assert.notEqual(codex[0], identities[0]);
});

test('a consumer composing through Harness renders the recipe Core renders', async () => {
  for (const requiredBy of [[item(AGENTS[0])], [...AGENTS.map(item), ...skills]]) {
    const consumer = renderSelectionDelivery({ tool: 'claude', binding: claude, item: notices, scope: 'project', requiredBy });
    assert.equal(consumer.status, 'rendered', JSON.stringify(consumer));
    assert.deepEqual(consumer.recipe, rendered(requiredBy));
  }
  // A notices document is still delivered only for an item that requires it.
  const unrelated = ecc.items.find(entry => entry.kind === 'agent' && !entry.dependencies?.requires?.some(ref => ref.itemId === 'ecc.notices'));
  if (unrelated) assert.equal(renderSelectionDelivery({ tool: 'claude', binding: claude, item: notices, scope: 'project',
    requiredBy: [item(AGENTS[0]), unrelated] }).reason, 'required-by-mismatch');
  assert.equal(renderSelectionDelivery({ tool: 'claude', binding: claude, item: notices, scope: 'project', requiredBy: [] }).reason, 'scope-not-bound');
});

// Enterprise Prepare: the organization permits both agents and the notices as authored for both; the developer installs
// one agent with the notices.
const managementId = id => `project--aihq.catalog--${id}`;
const selection = (id, origins, requires) => {
  const found = item(id);
  return { id, managementId: managementId(id), organizationSelectionId: `${managementId(id)}--claude`, scope: 'project', configuration: {}, requires,
    item: { framework: 'ecc', itemId: id, contentSha256: found.contentSha256, behaviourSha256: found.behaviourSha256 },
    tool: 'claude', name: found.name ?? found.label, kind: found.kind, origins, bindingDigest: claude.digest };
};
const requiredBy = itemId => ({ reasonIncluded: 'required-by', requiredBy: { framework: 'ecc', itemId } });
const policyFor = agents => ({ schema: 'urn:aihq:core:execution-policy:1.6.0', mode: 'enterprise',
  catalogReleases: [{ framework: 'ecc', source: { kind: 'local', input: 'catalog' }, path, sha256: sha256(bytes), byteLength: bytes.length }],
  selections: [selection('ecc.notices', agents.map(requiredBy), []),
    ...agents.map(id => selection(id, [{ reasonIncluded: 'chosen' }], ['ecc.notices']))] });
const entry = (id, recipeIdentity) => ({ selectionId: `${managementId(id)}--claude`, recipeIdentity, scopes: ['project'],
  obligation: 'permitted', inputs: {}, lifecycle: { replace: true, remove: true } });
async function prepareWith(organization, agents) {
  const folder = join(scratch, `project-${Math.random().toString(16).slice(2)}`); mkdirSync(folder);
  const file = join(scratch, `organization-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(organization));
  return prepare({ useCase: 'policy', policy: policyFor(agents), target: { project: realpathSync(folder) },
    organizationSource: { provider: 'local', path: file } }, controls());
}
const authored = async agents => ({ schema: 'urn:aihq:core:organization-policy:1.2.0', id: 'notices-identity', selections: [
  entry('ecc.notices', await identityOf(rendered(agents.map(item)))),
  ...await Promise.all(AGENTS.map(async id => entry(id, await identityOf(renderSelectionRecipe({ tool: 'claude', binding: claude,
    item: item(id), scope: 'project', requiredBy: [] }).recipe))))] });

test('an organization entry authored for both requirers admits the notices installed for either one', async () => {
  const organization = await authored(AGENTS);
  for (const agents of [AGENTS, [AGENTS[0]], [AGENTS[1]]]) {
    const prepared = await prepareWith(organization, agents);
    assert.equal(prepared.status, 'ready', `${agents}: ${JSON.stringify(prepared.diagnostics)}`);
  }
});

test('authority is not weakened: other notices bytes and any other changed recipe are still refused', async () => {
  const organization = await authored(AGENTS);
  const otherNotices = structuredClone(organization);
  otherNotices.selections[0].recipeIdentity = await identityOf(rendered([skills[0]], 'codex'));
  const notices = await prepareWith(otherNotices, [AGENTS[0]]);
  assert.deepEqual(notices.diagnostics.map(d => [d.code, d.reason, d.path]),
    [['AUTHORITY_DENIED', 'recipe-identity', '/selections/0/recipeIdentity']]);
  const otherAgent = structuredClone(organization);
  otherAgent.selections[1].recipeIdentity = otherAgent.selections[2].recipeIdentity;
  const agent = await prepareWith(otherAgent, [AGENTS[0]]);
  assert.deepEqual(agent.diagnostics.map(d => [d.code, d.reason, d.path]),
    [['AUTHORITY_DENIED', 'recipe-identity', '/selections/1/recipeIdentity']]);
});
