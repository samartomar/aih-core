// Execution policy 1.6.0 accepts recipe-less item selections: a selection names its Catalog item, tool, scope,
// configuration, requirements and origins, and Core renders its recipe at Prepare from the shipped binding, reading the
// item from the Catalog release the policy names through the `catalog` material root. The rendering is byte-identical
// to the inline recipe the Workbench writes for the same item, tool and scope, over real Catalog 1.7 content.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { apply, prepare } from '../dist/core/index.js';
import { validatePolicy } from '../dist/core/contracts.js';
import { checkCompatibility, toolBindings } from '../dist/harness/contracts.mjs';
import { POLICY_15, POLICY_16, canonical, catalogPack, composePolicy, contentsOf, inlineRecipe, releaseReference, rootRequest,
  sha256 } from './fixtures/catalog-pack.mjs';

const pack = await catalogPack();
const skip = pack.skip;
const scratch = mkdtempSync(join(tmpdir(), 'aih-recipeless-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(scratch, { recursive: true, force: true });
  if (pack.folder) rmSync(pack.folder, { recursive: true, force: true });
});
let projects = 0;
const project = () => { const folder = join(scratch, `project-${++projects}`); mkdirSync(folder); return realpathSync(folder); };
const controls = () => ({ logging: 'off', materialRoots: { catalog: pack.root } });
const ask = (policy, target) => prepare({ useCase: 'policy', policy, target: { project: target } }, controls());
const approve = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
const WINDOWS = { os: 'windows', arch: 'x64' };
const claude = () => toolBindings.find(binding => binding.tool === 'claude');
/** The review without the project folder or digest, so two projects' reviews compare. */
const comparable = (review, folder) => JSON.parse(JSON.stringify({ operations: review.operations, checks: review.checks ?? null })
  .replaceAll(folder, '<project>'));
/** Every member a run wrote: kind, project-relative path, pointer or block, and the bytes now at that path. */
const written = (run, folder) => run.members.map(member => ({ kind: member.kind, path: relative(folder, member.path),
  ...(member.pointer ? { pointer: member.pointer } : {}), ...(member.blockId ? { blockId: member.blockId } : {}),
  ...(member.groupId ? { groupId: member.groupId } : {}), outcome: member.outcome,
  sha256: sha256(readFileSync(member.path)) })).sort((a, b) => canonical(a) < canonical(b) ? -1 : 1);

/** A few real items of every kind Claude Code takes, chosen by themselves; Catalog adds what they require. */
function mixedRoots() {
  const ecc = [...pack.releases.ecc.items.values()];
  const first = (items, predicate) => { const found = items.find(predicate); assert.ok(found, 'a real item of that kind'); return found.id; };
  const ids = {
    ecc: [first(ecc, item => item.kind === 'skill' && item.dependencies.requires.length > 0),
      first(ecc, item => item.kind === 'rule' && item.payload?.namespace === 'typescript'),
      first(ecc, item => item.kind === 'agent'), first(ecc, item => item.kind === 'command'),
      first(ecc, item => item.kind === 'hook'),
      first(ecc, item => item.kind === 'mcp-server' && Object.keys(item.requirements?.inputs ?? {}).length === 0)],
    extensions: [first([...pack.releases.extensions.items.values()], item => item.kind === 'hook')],
    'project-basics': [...pack.releases['project-basics'].items.values()].filter(item => item.kind !== 'document' ||
      item.payload?.placement === 'project-folder').map(item => item.id)
  };
  return Object.entries(ids).flatMap(([framework, items]) => items.map(id => rootRequest(pack, framework, id)));
}

test('execution policy 1.6.0 accepts a recipe-less item selection and keeps inline recipes', { skip }, () => {
  const recipeless = composePolicy(pack, { roots: mixedRoots(), recipeless: true });
  assert.equal(validatePolicy(recipeless).valid, true, JSON.stringify(validatePolicy(recipeless).diagnostics));
  assert.ok(recipeless.selections.every(selection => !('recipe' in selection)));
  // Legacy recipes keep working: the same selections with their inline recipes, in 1.5.0 and in 1.6.0.
  const inline = composePolicy(pack, { roots: mixedRoots(), recipeless: false });
  assert.equal(validatePolicy(inline).valid, true, JSON.stringify(validatePolicy(inline).diagnostics));
  assert.equal(validatePolicy({ ...inline, schema: POLICY_16 }).valid, true);
  const [first] = recipeless.selections;
  const invalid = (policy, reason) => {
    const result = validatePolicy(policy);
    assert.equal(result.valid, false, reason);
    if (reason) assert.ok(result.diagnostics.some(item => item.reason === reason), `${reason}: ${JSON.stringify(result.diagnostics)}`);
  };
  // A recipe-less selection names its item and the binding it is rendered from; 1.5.0 has no such selection.
  invalid({ ...recipeless, schema: POLICY_15, catalogReleases: undefined });
  invalid({ ...recipeless, selections: [(({ bindingDigest: _drop, ...rest }) => rest)(first)] });
  invalid({ ...recipeless, selections: [(({ item: _item, tool: _tool, name: _name, kind: _kind, origins: _origins, bindingDigest: _digest, ...rest }) => rest)(first)] });
  // Core renders only from a release the policy names, one per framework.
  invalid({ ...recipeless, catalogReleases: recipeless.catalogReleases.filter(release => release.framework !== first.item.framework) },
    'catalog-release-missing');
  invalid({ ...recipeless, catalogReleases: [...recipeless.catalogReleases, recipeless.catalogReleases[0]] }, 'duplicate-catalog-release');
});

test('Core renders a recipe-less selection byte-identically to its inline recipe, for every real Catalog 1.7 item on Claude Code', { skip }, async () => {
  const { renderSelectionRecipe } = await import('../dist/core/internal/recipeless.js');
  const binding = claude();
  const counts = { items: 0, documents: 0 };
  for (const release of Object.values(pack.releases)) {
    const items = [...release.items.values()];
    const compat = checkCompatibility({ tool: 'claude', binding, platform: WINDOWS, items: items.map(item => ({ item })) });
    assert.equal(compat.status, 'checked');
    const rendersAlone = new Set(compat.items.filter(row => row.support !== 'none' && !row.notRendered).map(row => row.item.itemId));
    for (const item of items) {
      const requires = other => (other.dependencies?.requires ?? []).some(ref => ref.itemId === item.id);
      const supporting = item.kind === 'document' && item.payload?.placement !== 'project-folder';
      // A supporting document renders beside the items requiring it: here two real ones, as two selections would carry it.
      const requiredBy = supporting ? items.filter(other => requires(other) && rendersAlone.has(other.id) && other.kind !== 'document').slice(0, 2) : [];
      if (supporting ? requiredBy.length === 0 : !rendersAlone.has(item.id)) continue;
      const expected = inlineRecipe({ pack, tool: 'claude', item, scope: 'project', requiredBy });
      if (expected.status !== 'rendered') continue;
      const actual = renderSelectionRecipe({ tool: 'claude', binding, item, scope: 'project', contents: contentsOf(pack, item), requiredBy });
      assert.equal(actual.status, 'rendered', `${item.id}: ${JSON.stringify(actual)}`);
      assert.equal(JSON.stringify(actual.recipe), JSON.stringify(expected.recipe), `${item.id} renders the inline recipe's exact bytes`);
      assert.equal(actual.bindingDigest, binding.digest);
      counts.items++; if (supporting) counts.documents++;
    }
  }
  assert.ok(counts.items > 900 && counts.documents >= 3, JSON.stringify(counts));
});

test('Prepare renders recipe-less selections into the review and writes the inline form produces', { skip }, async () => {
  const roots = mixedRoots();
  const inline = composePolicy(pack, { roots, recipeless: false });
  const recipeless = composePolicy(pack, { roots, recipeless: true });
  const [a, b] = [project(), project()];
  const [left, right] = [await ask(inline, a), await ask(recipeless, b)];
  assert.equal(left.status, 'ready', JSON.stringify(left.diagnostics));
  assert.equal(right.status, 'ready', JSON.stringify(right.diagnostics));
  assert.deepEqual(comparable(right.review, b), comparable(left.review, a));
  assert.deepEqual(right.review.selections.map(row => row.layout), left.review.selections.map(row => row.layout),
    'each review names the shipped binding it was rendered from');
  const [ran, ranRecipeless] = [await apply(left.prepared, approve(left), controls()), await apply(right.prepared, approve(right), controls())];
  assert.equal(ran.completion, 'complete', JSON.stringify(ran.diagnostics));
  assert.equal(ranRecipeless.completion, 'complete', JSON.stringify(ranRecipeless.diagnostics));
  assert.deepEqual(written(ranRecipeless, b), written(ran, a));
  assert.ok(written(ran, a).some(member => member.path === 'CLAUDE.md'), 'a marker block read from the release materials');
});

test('a recipe-less selection is bound to the shipped binding, the named release bytes and the item identities', { skip }, async () => {
  const roots = [rootRequest(pack, 'extensions', [...pack.releases.extensions.items.values()].find(item => item.kind === 'hook').id)];
  const policy = composePolicy(pack, { roots, recipeless: true });
  // Another binding digest is the conflict an inline recipe rendered for another binding gets.
  const stale = structuredClone(policy); stale.selections[0].bindingDigest = 'a'.repeat(64);
  const conflicted = await ask(stale, project());
  assert.ok(conflicted.review?.conflicts.some(item => item.reason === 'binding-changed'), JSON.stringify(conflicted.diagnostics));
  // Release bytes other than the named ones are refused before anything is rendered.
  const moved = structuredClone(policy); moved.catalogReleases[0].sha256 = 'b'.repeat(64);
  const refused = await ask(moved, project());
  assert.deepEqual([refused.status, refused.diagnostics.map(item => item.reason)], ['invalid', ['member-identity-mismatch']]);
  // An item whose identities the release does not carry is refused, never rendered from other bytes.
  const other = structuredClone(policy); other.selections[0].item.contentSha256 = 'c'.repeat(64);
  const mismatch = await ask(other, project());
  assert.deepEqual([mismatch.status, mismatch.diagnostics.map(item => item.reason)], ['invalid', ['catalog-item-identity']]);
  const absent = structuredClone(policy); absent.selections[0].item.itemId = 'extensions.hook.not-in-release';
  const missing = await ask(absent, project());
  assert.deepEqual([missing.status, missing.diagnostics.map(item => item.reason)], ['invalid', ['catalog-item-missing']]);
  // Without the material root the release cannot be read: the same unavailable material an inline recipe reports.
  const unread = await prepare({ useCase: 'policy', policy, target: { project: project() } }, { logging: 'off' });
  assert.equal(unread.diagnostics[0].code, 'PREREQUISITE_UNAVAILABLE', JSON.stringify(unread.diagnostics));
  assert.equal(releaseReference(pack.releases.extensions).path, 'release/release-extensions.content.json');
});
