// Recipe-less selections in the default suite, with no packed Catalog: the five real Catalog 1.7.0 items vendored with
// their published bytes (Superpowers' verification skill and session-start hook with their notices, Extensions'
// git-guard hook with its notices). Core renders each from its shipped binding and the vendored release documents,
// byte-identically to the inline recipe, and installs exactly what the inline policy installs. Each integrity check
// refuses a release, item or requirer that does not match. The packed-Catalog tests remain the large-scale proof.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { apply, prepare } from '../dist/core/index.js';
import { validatePolicy } from '../dist/core/contracts.js';
import { createMaterialCaptureBudget } from '../dist/core/internal/material.js';
import { toolBindings } from '../dist/harness/contracts.mjs';
import { approve, assertVendoredRelease, catalogRoot, controls, fileTree, realSelections } from './real-catalog-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-recipeless-real-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(scratch, { recursive: true, force: true });
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let projects = 0;
const project = () => { const folder = join(scratch, `project-${++projects}`); mkdirSync(folder); return realpathSync(folder); };
const ask = (policy, target) => prepare({ useCase: 'policy', policy, target: { project: target } }, controls());
const claude = toolBindings.find(binding => binding.tool === 'claude');
const release = framework => {
  const path = `release-${framework}.content.json`, bytes = readFileSync(join(catalogRoot, path));
  return { framework, source: { kind: 'local', input: 'catalog' }, path, sha256: sha256(bytes), byteLength: bytes.length };
};
const inlinePolicy = () => ({ schema: 'urn:aihq:core:execution-policy:1.5.0', mode: 'vibe', selections: realSelections() });
/** The same five selections naming their items instead of carrying recipes. */
const recipelessPolicy = () => ({ schema: 'urn:aihq:core:execution-policy:1.6.0', mode: 'vibe',
  catalogReleases: [release('extensions'), release('superpowers')],
  selections: realSelections().map(({ recipe: _recipe, ...selection }) => ({ ...selection, bindingDigest: claude.digest })) });
// The folder as it appears inside JSON text: Windows paths carry backslashes, which JSON escapes.
const comparable = (review, folder) => JSON.parse(JSON.stringify({ operations: review.operations, checks: review.checks ?? null })
  .replaceAll(JSON.stringify(folder).slice(1, -1), '<project>'));
const members = (run, folder) => run.members.map(member => ({ kind: member.kind, path: relative(folder, member.path),
  pointer: member.pointer ?? null, groupId: member.groupId ?? null, blockId: member.blockId ?? null, outcome: member.outcome,
  sha256: sha256(readFileSync(member.path)) })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

test('Core renders the real items byte-identically to their inline recipes and installs what the inline policy installs', async () => {
  assertVendoredRelease();
  const policy = recipelessPolicy();
  assert.equal(validatePolicy(policy).valid, true, JSON.stringify(validatePolicy(policy).diagnostics));
  // Core's own rendering, reading the vendored release and material text itself.
  const { renderRecipelessSelections } = await import('../dist/core/internal/recipeless.js');
  const rendered = structuredClone(policy);
  const result = await renderRecipelessSelections(rendered, { catalog: catalogRoot }, createMaterialCaptureBudget());
  assert.deepEqual(result.diagnostics, []);
  const inline = inlinePolicy();
  for (const [index, selection] of rendered.selections.entries())
    assert.equal(JSON.stringify(selection.recipe), JSON.stringify(inline.selections[index].recipe), `${selection.id} renders the inline recipe's bytes`);
  // Prepare and Apply: the same review and the same writes, in two disposable projects.
  const [a, b] = [project(), project()];
  const [left, right] = [await ask(inline, a), await ask(policy, b)];
  assert.equal(left.status, 'ready', JSON.stringify(left.diagnostics));
  assert.equal(right.status, 'ready', JSON.stringify(right.diagnostics));
  assert.deepEqual(comparable(right.review, b), comparable(left.review, a));
  const [ranInline, ran] = [await apply(left.prepared, approve(left.review), controls()), await apply(right.prepared, approve(right.review), controls())];
  assert.equal(ranInline.completion, 'complete', JSON.stringify(ranInline.diagnostics));
  assert.equal(ran.completion, 'complete', JSON.stringify(ran.diagnostics));
  assert.deepEqual(members(ran, b), members(ranInline, a));
  assert.deepEqual(fileTree(b), fileTree(a));
  assert.ok(Object.keys(fileTree(b)).some(path => path.startsWith('.claude/hooks/extensions.hook.git-guard/')), 'the hook scripts landed');
});

test('a recipe-less selection is refused when the release, item or requiring item does not match, and conflicts on another binding', async () => {
  const reasons = async mutate => {
    const policy = recipelessPolicy(); mutate(policy);
    const result = await ask(policy, project());
    return [result.status, result.diagnostics.map(item => item.reason)];
  };
  const at = (policy, itemId) => policy.selections.find(selection => selection.item.itemId === itemId);
  // Release bytes other than the ones the policy names.
  assert.deepEqual(await reasons(policy => { policy.catalogReleases[1].sha256 = 'b'.repeat(64); }), ['invalid', ['member-identity-mismatch']]);
  // The release carries another version of the item.
  assert.deepEqual(await reasons(policy => { at(policy, 'superpowers.skill.verification-before-completion').item.behaviourSha256 = 'c'.repeat(64); }),
    ['invalid', ['catalog-item-identity']]);
  // The release does not carry the item at all.
  assert.deepEqual(await reasons(policy => { at(policy, 'superpowers.skill.verification-before-completion').item.itemId = 'superpowers.skill.not-released'; }),
    ['invalid', ['catalog-item-missing']]);
  // A supporting document whose requiring item is not selected has nowhere to go.
  assert.deepEqual(await reasons(policy => { policy.selections = policy.selections.filter(selection => selection.item.itemId !== 'extensions.hook.git-guard'); }),
    ['invalid', ['required-by-missing']]);
  // A binding digest Core does not ship is the conflict an inline recipe rendered for another binding gets.
  const stale = recipelessPolicy(); stale.selections[0].bindingDigest = 'a'.repeat(64);
  const conflicted = await ask(stale, project());
  assert.ok(conflicted.review?.conflicts.some(item => item.reason === 'binding-changed'), JSON.stringify(conflicted.diagnostics));
});
