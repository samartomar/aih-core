// No two items that can be installed together write one path for Claude Code, across the real Catalog 1.7.0 contents of
// ECC, Superpowers and AIH Extensions. ECC's language rules keep their namespace folder, and a Kiro-edition variant
// picked with its main edition is left out, not installed over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkCompatibility, renderDelivery, toolBindings } from '../../dist/harness/contracts.mjs';
import { reidentified } from './catalog-item-fixture.mjs';

const folder = new URL('../fixtures/catalog-1.7.0/', import.meta.url);
const provenance = JSON.parse(readFileSync(new URL('provenance.json', folder), 'utf8'));
const texts = JSON.parse(readFileSync(new URL('rule-texts.json', folder), 'utf8'));
const release = name => {
  const bytes = readFileSync(new URL(`release-${name}.content.json`, folder));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.files[`release-${name}.content.json`]);
  return JSON.parse(bytes);
};
const ecc = release('ecc'), superpowers = release('superpowers'), extensions = release('extensions');
const claude = toolBindings.find(binding => binding.tool === 'claude');
const WINDOWS = { os: 'windows', arch: 'x64' };
const contentsOf = item => Object.fromEntries(item.materials.filter(member => member.role === 'content' && texts[member.packagePath] !== undefined)
  .map(member => [member.id, texts[member.packagePath]]));
const frameworkOf = item => item.materials.find(member => member.role === 'behaviour').sourceId;
const requires = (requirer, document) => (requirer.dependencies?.requires ?? [])
  .some(ref => ref.itemId === document.id && (ref.framework ?? frameworkOf(requirer)) === frameworkOf(document));
const supporting = item => item.kind === 'document' && item.payload.placement !== 'project-folder';

/** ECC with one language: every item except the rule sets of the other languages, with or without its Kiro-edition skills. */
function eccWith(language, { variants }) {
  const otherLanguages = new Set(ecc.sets.filter(set => /^ecc\.rules\./.test(set.id) && ![`ecc.rules.${language}`, 'ecc.rules.common'].includes(set.id))
    .flatMap(set => set.members.map(member => member.item.itemId)));
  const kiroEdition = item => item.variantOf !== undefined && (item.hints?.tools ?? []).includes('kiro');
  return ecc.items.filter(item => !otherLanguages.has(item.id) && (variants || !kiroEdition(item)));
}

/** Every file each installable item writes for Claude Code, as compatibility and rendering agree it is installed. */
function writesOf(items) {
  const compat = checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS, items: items.map(item => ({ item })) });
  const rows = new Map(compat.items.map(row => [row.item.itemId, row]));
  const installed = items.filter(item => !rows.get(item.id).excluded && rows.get(item.id).staticBlockers.length === 0 && !rows.get(item.id).notRendered);
  const writers = new Map();
  for (const item of installed) {
    // A supporting document is rendered once per requiring item; the copies it writes are its own, shared by design.
    const requirers = supporting(item) ? installed.filter(entry => requires(entry, item)) : [undefined];
    for (const requiredBy of requirers) {
      const rendered = renderDelivery({ tool: 'claude', item, binding: claude, scope: 'project', contents: contentsOf(item), ...(requiredBy ? { requiredBy } : {}) });
      assert.equal(rendered.status, 'rendered', `${item.id}: ${JSON.stringify(rendered)}`);
      for (const op of rendered.recipe.operations) if (op.kind === 'file.write') {
        const path = `${op.target.root}/${op.target.segments.map(part => part.literal).join('/')}`;
        writers.set(path, new Set([...(writers.get(path) ?? []), item.id]));
      }
    }
  }
  return { compat, rows, installed, writers };
}

// ECC with typescript (its common and typescript rules), all of Superpowers and all of AIH Extensions. The two blocked
// items are the code-reviewer agents above; the Kiro edition adds 43 skills, each left out for its main edition.
const EXPECTED = {
  without: { picked: 625, installed: 623, leftOut: 0, blocked: 2, files: 1540 },
  with: { picked: 668, installed: 623, leftOut: 43, blocked: 2, files: 1540 },
};

for (const variants of [false, true]) test(`ECC (typescript), Superpowers and Extensions ${variants ? 'with' : 'without'} the Kiro-edition variants: no two items write one path`, () => {
  const picked = [...eccWith('typescript', { variants }), ...superpowers.items, ...extensions.items];
  const { compat, rows, installed, writers } = writesOf(picked);
  const shared = [...writers].filter(([, ids]) => ids.size > 1).map(([path, ids]) => `${path} <= ${[...ids].join(', ')}`);
  assert.deepEqual(shared, []);
  // The one conflict left is between frameworks, two agents of one name; it is reported and neither is installed over
  // the other. Resolving it is a naming decision, not a placement rule.
  assert.deepEqual(compat.items.filter(row => row.staticBlockers.some(blocker => blocker.code === 'same-folder')).map(row => row.item.itemId),
    ['ecc.agent.code-reviewer', 'extensions.agent.code-reviewer']);
  // Exact counts: what is picked, what installs, what is left out, and the files written.
  const leftOut = compat.items.filter(row => row.leftOut).map(row => row.item.itemId);
  const blocked = compat.items.filter(row => row.staticBlockers.length > 0).length;
  const counts = { picked: picked.length, installed: installed.length, leftOut: leftOut.length, blocked, files: writers.size };
  assert.equal(counts.installed + counts.leftOut + counts.blocked, counts.picked);
  assert.deepEqual(counts, variants ? EXPECTED.with : EXPECTED.without);
  // Every variant left out names its main edition, which is installed.
  for (const id of leftOut) {
    const variant = picked.find(item => item.id === id);
    assert.equal(rows.get(id).leftOut.reason, 'variant-of-selected');
    assert.ok(installed.some(item => item.id === variant.variantOf.itemId), id);
  }
});

test('ECC language rules keep their namespace folder instead of sharing one file', () => {
  const rules = ecc.items.filter(item => item.kind === 'rule' && item.name === 'coding-style');
  assert.ok(rules.length > 2);
  const paths = rules.map(item => {
    const rendered = renderDelivery({ tool: 'claude', item, binding: claude, scope: 'project', contents: contentsOf(item) });
    assert.equal(rendered.status, 'rendered', `${item.id}: ${JSON.stringify(rendered)}`);
    return rendered.recipe.operations.filter(op => op.kind === 'file.write' && op.material !== 'license').map(op => op.target.segments.map(part => part.literal).join('/'));
  });
  for (const [index, item] of rules.entries()) assert.deepEqual(paths[index], [`.claude/rules/${item.payload.namespace}/coding-style.md`], item.id);
  assert.equal(new Set(paths.flat()).size, rules.length);
});

test('a Kiro-edition variant picked alone is installed in its own folder name; with its main edition it is left out', () => {
  const variant = ecc.items.find(item => item.id === 'ecc.skill.api-design.kiro-variant');
  const main = ecc.items.find(item => item.id === variant.variantOf.itemId);
  const notices = ecc.items.find(item => item.id === 'ecc.notices');
  const alone = checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS, items: [variant, notices].map(item => ({ item })) });
  const row = alone.items.find(entry => entry.item.itemId === variant.id);
  assert.deepEqual([row.excluded, row.leftOut, row.staticBlockers], [undefined, undefined, []]);
  const rendered = renderDelivery({ tool: 'claude', item: variant, binding: claude, scope: 'project' });
  assert.ok(rendered.recipe.operations.some(op => op.kind === 'file.write' && op.target.segments.map(part => part.literal).join('/') === '.claude/skills/api-design/SKILL.md'));
  const both = checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS, items: [main, variant, notices].map(item => ({ item })) });
  const left = both.items.find(entry => entry.item.itemId === variant.id);
  assert.deepEqual([left.excluded, left.staticBlockers], [true, []]);
  assert.deepEqual(left.leftOut, { reason: 'variant-of-selected', detail: 'Kiro CLI version of api-design. api-design is picked, so this version is left out.' });
  assert.deepEqual(both.items.find(entry => entry.item.itemId === main.id).staticBlockers, []);
  // Left out by the person as well, it is still only left out; leaving the main edition out installs the variant.
  const mainLeftOut = checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS,
    items: [{ item: main, excluded: true }, { item: variant }, { item: notices }] });
  const installedVariant = mainLeftOut.items.find(entry => entry.item.itemId === variant.id);
  assert.equal(installedVariant.excluded, undefined);
  assert.deepEqual(installedVariant.staticBlockers, []);
});

test('a variant is never left out in a way that hides a conflict or drops both editions', () => {
  const variant = ecc.items.find(item => item.id === 'ecc.skill.api-design.kiro-variant');
  const main = ecc.items.find(item => item.id === variant.variantOf.itemId);
  const notices = ecc.items.find(item => item.id === 'ecc.notices');
  const check = entries => checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS, items: entries });
  const row = (result, item) => result.items.find(entry => entry.item.itemId === item.id);
  const conflict = (result, ...items) => {
    for (const item of items) {
      assert.equal(row(result, item).leftOut, undefined, item.id);
      assert.ok(row(result, item).staticBlockers.some(blocker => blocker.code === 'same-folder'), item.id);
    }
  };
  // Required by the person: shown as the conflict it is.
  conflict(check([{ item: main }, { item: variant, required: true }, { item: notices }]), main, variant);
  // A cycle (each names the other as its main edition) is a visible conflict, whatever the order.
  const cyclic = { ...main, variantOf: { itemId: variant.id } };
  conflict(check([cyclic, variant, notices].map(item => ({ item }))), cyclic, variant);
  conflict(check([variant, cyclic, notices].map(item => ({ item }))), cyclic, variant);
  // A main edition that would not install (here it requires an item nobody picked) does not take the variant down with it.
  const blockedMain = reidentified(main, { dependencies: { ...main.dependencies, requires: [...main.dependencies.requires, { itemId: 'ecc.not-picked' }] } });
  const blocked = check([blockedMain, variant, notices].map(item => ({ item })));
  assert.equal(row(blocked, variant).leftOut, undefined);
  assert.equal(row(blocked, variant).excluded, undefined);
  assert.ok(row(blocked, blockedMain).staticBlockers.some(blocker => blocker.code === 'dependency-missing'));
});
