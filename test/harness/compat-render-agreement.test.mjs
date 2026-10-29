// Compatibility and rendering agree for every real item: across every shipped binding and every real Catalog 1.7.0
// content, an item reported `support: native` with no static blocker renders. A supporting document renders beside each
// item that requires it, and a requiring item whose document cannot sit beside it is blocked, not shown as working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkCompatibility, renderDelivery, toolBindings } from '../../dist/harness/contracts.mjs';

const folder = new URL('../fixtures/catalog-1.7.0/', import.meta.url);
const provenance = JSON.parse(readFileSync(new URL('provenance.json', folder), 'utf8'));
const texts = JSON.parse(readFileSync(new URL('rule-texts.json', folder), 'utf8'));
const releases = Object.entries(provenance.files).map(([name, digest]) => {
  const bytes = readFileSync(new URL(name, folder));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, `${name} is the vendored Catalog content`);
  return { name, items: JSON.parse(bytes).items };
});
const WINDOWS = { os: 'windows', arch: 'x64' };
const scopeOf = (binding, kind) => binding.layouts[kind].roots?.project ? 'project' : 'user';
/** A `requires` reference without a framework names the requirer's own framework, as Catalog states it. */
const frameworkOf = item => item.materials.find(member => member.role === 'behaviour').sourceId;
const requires = (requirer, document) => (requirer.dependencies?.requires ?? [])
  .some(ref => ref.itemId === document.id && (ref.framework ?? frameworkOf(requirer)) === frameworkOf(document));
/** Text of each Markdown content material, as a consumer supplies it for marker blocks. */
const contentsOf = item => Object.fromEntries(item.materials.filter(member => member.role === 'content' && texts[member.packagePath] !== undefined)
  .map(member => [member.id, texts[member.packagePath]]));
/** Every installed version a binding was observed on, plus the historical projection without a version. */
const versionsOf = binding => [undefined, ...new Set(Object.values(binding.layouts).flatMap(layout => layout.observations.map(item => item.toolVersion)))];

test('every item compatibility reports native with no blocker renders, for every binding, observed version and real 1.7 content', () => {
  const rendered = { document: 0, total: 0, refusedNative: 0 };
  for (const { name, items } of releases) for (const binding of toolBindings) for (const installedVersion of versionsOf(binding)) {
    const tuple = installedVersion === undefined ? {} : { platform: WINDOWS, installedVersion };
    const compat = checkCompatibility({ tool: binding.tool, binding, platform: WINDOWS, ...(installedVersion ? { installedVersion } : {}),
      items: items.map(item => ({ item })) });
    const at = `${name} ${binding.tool} ${installedVersion ?? 'any version'}`;
    assert.equal(compat.status, 'checked', `${at}: ${JSON.stringify(compat)}`);
    const rows = new Map(compat.items.map(row => [row.item.itemId, row]));
    for (const row of compat.items) {
      // A native cell that rendering refuses is never shown as working: its refusal is also a blocker.
      if (row.support === 'native' && row.notRendered) {
        assert.ok(row.staticBlockers.some(blocker => blocker.code === row.notRendered.reason), `${at} ${row.item.itemId}`);
        rendered.refusedNative++;
      }
      if (row.support !== 'native' || row.staticBlockers.length > 0) continue;
      const item = items.find(entry => entry.id === row.item.itemId);
      const render = (requiredBy, scope) => renderDelivery({ tool: binding.tool, item, binding, scope, contents: contentsOf(item), ...tuple,
        ...(requiredBy ? { requiredBy } : {}) });
      if (item.kind === 'document' && item.payload.placement !== 'project-folder') {
        // Beside each requiring item that is installed as itself with no blocker: each one is a place for it.
        const hosts = items.filter(entry => requires(entry, item) && rows.get(entry.id).staticBlockers.length === 0 && !rows.get(entry.id).boundAs);
        assert.ok(hosts.length > 0, `${at} ${item.id} is working only beside a requiring item`);
        for (const host of hosts) {
          const result = render(host, scopeOf(binding, host.kind));
          assert.equal(result.status, 'rendered', `${at} ${item.id} beside ${host.id}: ${JSON.stringify(result)}`);
          rendered.document++;
        }
      } else {
        const result = render(undefined, item.kind === 'document' ? 'project' : scopeOf(binding, item.kind));
        assert.equal(result.status, 'rendered', `${at} ${item.id}: ${JSON.stringify(result)}`);
      }
      rendered.total++;
    }
  }
  assert.ok(rendered.document > 1000 && rendered.total > 1000 && rendered.refusedNative > 0, JSON.stringify(rendered));
});

test('an item whose required item is not selected, left out or has no place beside it is blocked', () => {
  const ecc = releases.find(release => release.name === 'release-ecc.content.json').items;
  const claude = toolBindings.find(binding => binding.tool === 'claude');
  const notices = ecc.find(entry => entry.id === 'ecc.notices');
  const skill = ecc.find(entry => entry.kind === 'skill' && requires(entry, notices));
  const check = items => checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS, items });
  const codes = (result, id) => result.items.find(row => row.item.itemId === id).staticBlockers.map(blocker => blocker.code);
  assert.deepEqual(codes(check([{ item: skill }]), skill.id), ['dependency-missing'], 'a skill selected without its notices');
  assert.deepEqual(codes(check([{ item: skill }, { item: notices, excluded: true }]), skill.id), ['excluded-but-required']);
  const together = check([{ item: skill }, { item: notices }]);
  assert.deepEqual([codes(together, skill.id), codes(together, notices.id)], [[], []], 'the notices sit inside the skill folder');
  // On Codex the skill is unconfirmed and binds as its rule fallback, which keeps no folder: the notices have no place.
  const codex = toolBindings.find(binding => binding.tool === 'codex');
  const rule = ecc.find(entry => entry.kind === 'rule' && requires(entry, notices));
  const fallback = checkCompatibility({ tool: 'codex', binding: codex, platform: WINDOWS, items: [{ item: skill, fallback: rule }, { item: notices }] });
  assert.equal(fallback.items.find(row => row.item.itemId === skill.id).boundAs?.viaFallback, true);
  assert.deepEqual([codes(fallback, skill.id), codes(fallback, notices.id)], [['dependency-missing'], ['scope-not-bound']]);
});

test('the required notices render beside Claude hooks; an item they cannot sit beside is blocked by its dependency', () => {
  const extensions = releases.find(release => release.name === 'release-extensions.content.json').items;
  const ecc = releases.find(release => release.name === 'release-ecc.content.json').items;
  const claude = toolBindings.find(binding => binding.tool === 'claude');
  const item = (items, id) => items.find(entry => entry.id === id);
  const guard = item(extensions, 'extensions.hook.git-guard'), notices = item(extensions, 'extensions.notices');
  const beside = renderDelivery({ tool: 'claude', item: notices, binding: claude, scope: 'project', requiredBy: guard });
  assert.equal(beside.status, 'rendered', JSON.stringify(beside));
  const targets = beside.recipe.operations.filter(op => op.kind === 'file.write').map(op => op.target.segments.map(part => part.literal).join('/'));
  assert.ok(targets.length > 0 && targets.every(path => path.startsWith('.claude/hooks/extensions.hook.git-guard/extensions.notices/')), targets.join(' '));
  // Without the requiring item there is no place to put a supporting document.
  const alone = renderDelivery({ tool: 'claude', item: notices, binding: claude, scope: 'project' });
  assert.deepEqual([alone.status, alone.reason], ['refused', 'scope-not-bound']);
  // A rule keeps no folder of its own in a tool that reads every Markdown file there as a rule: ECC's notices would
  // become rules, so the rule is blocked by its dependency rather than shown as working.
  const rule = ecc.find(entry => entry.kind === 'rule' && requires(entry, item(ecc, 'ecc.notices')));
  const compat = checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS, items: [{ item: rule }, { item: item(ecc, 'ecc.notices') }] });
  const codes = id => compat.items.find(row => row.item.itemId === id).staticBlockers.map(blocker => blocker.code);
  assert.deepEqual(codes(rule.id), ['dependency-missing']);
  assert.deepEqual(codes('ecc.notices'), ['scope-not-bound'], 'with no requirer it can sit beside, the notices are not shown as working');
  const mismatch = renderDelivery({ tool: 'claude', item: notices, binding: claude, scope: 'project', requiredBy: rule });
  assert.deepEqual([mismatch.status, mismatch.reason], ['refused', 'required-by-mismatch']);
});
