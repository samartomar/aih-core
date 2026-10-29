// Compatibility and rendering agree for every real item: across every shipped binding and every real Catalog 1.7.0
// content, an item reported `support: native` with no static blocker renders. A supporting document renders beside each
// item that requires it, and a requiring item whose document cannot sit beside it is blocked, not shown as working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
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
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(value).digest('hex');
/** A real item that also requires other items, with its behaviour file and identity recomputed as Catalog would. */
function withRequires(item, requires) {
  const dependencies = { requires, optional: item.dependencies.optional ?? [], conflicts: item.dependencies.conflicts ?? [] };
  const content = item.materials.filter(member => member.role !== 'behaviour');
  const behaviour = { kind: item.kind, payload: item.payload ?? null, requirements: { inputs: item.requirements?.inputs ?? {} }, dependencies,
    executable: Object.fromEntries(content.map(member => [member.relPath, member.executable])) };
  const lines = content.map(member => `${member.relPath}	${member.sha256}
`).sort().join('');
  const text = `${canonicalJson(behaviour)}
`;
  const materials = item.materials.map(member => member.role === 'behaviour' ? { ...member, sha256: digest(text), byteLength: Buffer.byteLength(text) } : member);
  return { ...item, dependencies, materials, behaviourSha256: digest(canonicalJson({ ...behaviour, materials: lines })) };
}
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
        const hosts = items.filter(entry => requires(entry, item) && rows.get(entry.id).staticBlockers.length === 0 && !rows.get(entry.id).notRendered &&
          !rows.get(entry.id).boundAs);
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
  // On Codex the skill is unconfirmed and binds as its rule fallback, which keeps no folder: its notices go to the
  // neutral notices folder, so nothing is blocked.
  const codex = toolBindings.find(binding => binding.tool === 'codex');
  const rule = ecc.find(entry => entry.kind === 'rule' && requires(entry, notices));
  const fallback = checkCompatibility({ tool: 'codex', binding: codex, platform: WINDOWS, items: [{ item: skill, fallback: rule }, { item: notices }] });
  assert.equal(fallback.items.find(row => row.item.itemId === skill.id).boundAs?.viaFallback, true);
  assert.deepEqual([codes(fallback, skill.id), codes(fallback, notices.id)], [[], []]);
  // Rendering agrees: the notices render for the bound fallback rule into the neutral folder.
  const rendered = renderDelivery({ tool: 'codex', item: notices, binding: codex, scope: 'project', requiredBy: rule });
  assert.equal(rendered.status, 'rendered', JSON.stringify(rendered));
  assert.ok(rendered.recipe.operations.filter(op => op.kind === 'file.write')
    .every(op => op.target.segments.map(part => part.literal).join('/').startsWith('.aih/notices/ecc/ecc.notices/')));
});

test('the required notices render beside Claude hooks and in the neutral folder for a rule', () => {
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
  // A rule keeps no folder of its own, so ECC's notices for it go to the neutral notices folder.
  const rule = ecc.find(entry => entry.kind === 'rule' && requires(entry, item(ecc, 'ecc.notices')));
  const compat = checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS, items: [{ item: rule }, { item: item(ecc, 'ecc.notices') }] });
  const codes = id => compat.items.find(row => row.item.itemId === id).staticBlockers.map(blocker => blocker.code);
  assert.deepEqual([codes(rule.id), codes('ecc.notices')], [[], []]);
  const mismatch = renderDelivery({ tool: 'claude', item: notices, binding: claude, scope: 'project', requiredBy: rule });
  assert.deepEqual([mismatch.status, mismatch.reason], ['refused', 'required-by-mismatch']);
});

test('notices for items without a folder of their own go once per framework to the neutral notices folder', () => {
  const ecc = releases.find(release => release.name === 'release-ecc.content.json').items;
  const extensions = releases.find(release => release.name === 'release-extensions.content.json').items;
  const claude = toolBindings.find(binding => binding.tool === 'claude');
  const notices = ecc.find(entry => entry.id === 'ecc.notices');
  const folderless = ['agent', 'command', 'rule', 'mcp-server'].map(kind => ecc.find(entry => entry.kind === kind && requires(entry, notices)));
  const writes = rendered => rendered.recipe.operations.filter(op => op.kind === 'file.write')
    .map(op => [op.target.root, op.target.segments.map(part => part.literal).join('/'), op.material]);
  const placed = folderless.map(requirer => {
    const rendered = renderDelivery({ tool: 'claude', item: notices, binding: claude, scope: 'project', requiredBy: requirer });
    assert.equal(rendered.status, 'rendered', `${requirer.id}: ${JSON.stringify(rendered)}`);
    assert.equal(rendered.recipe.id, `claude.ecc.notices.for.${requirer.id}`);
    return writes(rendered);
  });
  // Every requirer renders the same one copy, which Core custody then shares among them.
  for (const copy of placed) assert.deepEqual(copy, placed[0]);
  assert.ok(placed[0].length > 0 && placed[0].every(([root, path]) => root === 'project' && path.startsWith('.aih/notices/ecc/ecc.notices/')),
    JSON.stringify(placed[0]));
  // User scope: Codex registers MCP servers in the user's home, so their notices go under the home's neutral folder.
  const codex = toolBindings.find(binding => binding.tool === 'codex');
  const server = folderless.find(entry => entry.kind === 'mcp-server');
  const user = renderDelivery({ tool: 'codex', item: notices, binding: codex, scope: 'user', requiredBy: server });
  assert.equal(user.status, 'rendered', JSON.stringify(user));
  assert.ok(writes(user).every(([root, path]) => root === 'userHome' && path.startsWith('.aih/notices/ecc/ecc.notices/')), JSON.stringify(writes(user)));
  // Compatibility plans and sizes the neutral copy once, however many items require it.
  const one = checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS, items: [{ item: folderless[0] }, { item: notices }] });
  const all = checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS, items: [...folderless.map(item => ({ item })), { item: notices }] });
  const size = result => result.items.find(row => row.item.itemId === notices.id).deliveredSize.bytes;
  assert.ok(size(one) > 0 && size(all) === size(one), `${size(one)} ${size(all)}`);
  for (const requirer of folderless) assert.deepEqual(all.items.find(row => row.item.itemId === requirer.id).staticBlockers, [], requirer.id);
  // Only notices and licences take the neutral folder: a reference goes where the item that reads it links it.
  const references = extensions.find(entry => entry.id === 'extensions.references');
  const agent = extensions.find(entry => entry.kind === 'agent' && requires(entry, references));
  const read = renderDelivery({ tool: 'claude', item: references, binding: claude, scope: 'project', requiredBy: agent });
  assert.ok(writes(read).every(([, path]) => !path.startsWith('.aih/')), JSON.stringify(writes(read)));
});

test('a reference goes where the items that read it link it, once per tool folder, for agents, commands and skills', () => {
  const extensions = releases.find(release => release.name === 'release-extensions.content.json').items;
  const references = extensions.find(entry => entry.id === 'extensions.references');
  const notices = extensions.find(entry => entry.id === 'extensions.notices');
  const writes = rendered => rendered.recipe.operations.filter(op => op.kind === 'file.write').map(op => op.target.segments.map(part => part.literal).join('/'));
  const requirersOf = kind => extensions.filter(entry => entry.kind === kind && requires(entry, references));
  const skill = extensions.find(entry => entry.id === 'extensions.skill.shipping-and-launch');
  for (const [tool, folder] of [['claude', '.claude'], ['codex', '.agents'], ['kiro', '.kiro'], ['copilot', '.github'], ['antigravity', '.agents']]) {
    const binding = toolBindings.find(entry => entry.tool === tool);
    const requirers = [skill, ...['agent', 'command'].flatMap(kind => binding.layouts[kind].roots?.project ? requirersOf(kind) : [])];
    const placed = requirers.map(requirer => {
      const rendered = renderDelivery({ tool, item: references, binding, scope: 'project', requiredBy: requirer });
      assert.equal(rendered.status, 'rendered', `${tool} ${requirer.id}: ${JSON.stringify(rendered)}`);
      assert.equal(rendered.recipe.id, `${tool}.extensions.references.for.${requirer.id}`);
      return writes(rendered);
    });
    // The same copy for every requirer, which Core custody shares among them, with the licence inside its folder.
    for (const copy of placed) assert.deepEqual(copy, placed[0]);
    assert.deepEqual(placed[0], references.payload.files.map(id => references.materials.find(member => member.id === id))
      .map(member => `${folder}/references/${member.relPath.split('/').at(-1)}`), tool);
    // The skill's own link resolves to the delivered file: from skills/<name>/SKILL.md, ../../references/<file>.
    const own = renderDelivery({ tool, item: skill, binding, scope: 'project' });
    const skillFile = writes(own).find(path => path.endsWith('/SKILL.md'));
    const linked = posix.normalize(posix.join(posix.dirname(skillFile), '../../references/definition-of-done.md'));
    assert.ok(placed[0].includes(linked), `${tool}: ${linked}`);
  }
  // A reference that requires its notices: the notices go to the neutral folder, and neither is blocked.
  const claude = toolBindings.find(binding => binding.tool === 'claude');
  const forReferences = renderDelivery({ tool: 'claude', item: notices, binding: claude, scope: 'project', requiredBy: references });
  assert.equal(forReferences.status, 'rendered', JSON.stringify(forReferences));
  assert.ok(writes(forReferences).every(path => path.startsWith('.aih/notices/extensions/extensions.notices/')));
  const one = checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS, items: [{ item: skill }, { item: references }, { item: notices }] });
  const all = checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS, items: extensions.map(item => ({ item })) });
  for (const result of [one, all]) for (const row of result.items)
    assert.ok(!row.staticBlockers.some(blocker => blocker.code === 'dependency-missing'), `${row.item.itemId}: ${JSON.stringify(row.staticBlockers)}`);
  // Compatibility plans and sizes the one copy once, however many items require it.
  const size = result => result.items.find(row => row.item.itemId === references.id).deliveredSize.bytes;
  assert.ok(size(one) > 0 && size(all) === size(one), `${size(one)} ${size(all)}`);
});

test('a reference has no place for an item that does not keep its source folders', () => {
  const extensions = releases.find(release => release.name === 'release-extensions.content.json').items;
  const ecc = releases.find(release => release.name === 'release-ecc.content.json').items;
  const references = extensions.find(entry => entry.id === 'extensions.references');
  const claude = toolBindings.find(binding => binding.tool === 'claude');
  const reading = requirer => withRequires(requirer, [...requirer.dependencies.requires, { framework: 'extensions', itemId: references.id }]);
  // An MCP server entry delivers no file of its own, so there is nothing its links could be relative to; a rule from
  // rules/<language>/ is delivered flat into the rules folder, so its links would not resolve either.
  const server = ecc.find(entry => entry.kind === 'mcp-server');
  const rule = ecc.find(entry => entry.kind === 'rule' && entry.materials.some(member => /^rules\/[^/]+\/[^/]+\.md$/.test(member.sourcePath ?? '')));
  for (const requirer of [server, rule]) {
    const refused = renderDelivery({ tool: 'claude', item: references, binding: claude, scope: 'project', requiredBy: reading(requirer) });
    assert.deepEqual([refused.status, refused.reason], ['refused', 'scope-not-bound'], `${requirer.id}: ${JSON.stringify(refused)}`);
  }
});

test('an item with no location of its own is not blamed on the documents it requires', () => {
  const ecc = releases.find(release => release.name === 'release-ecc.content.json').items;
  const kiro = toolBindings.find(binding => binding.tool === 'kiro');
  const notices = ecc.find(entry => entry.id === 'ecc.notices');
  const servers = ecc.filter(entry => entry.kind === 'mcp-server' && requires(entry, notices));
  const compat = checkCompatibility({ tool: 'kiro', binding: kiro, platform: WINDOWS, items: [...servers, notices].map(item => ({ item })) });
  assert.ok(servers.length > 0);
  for (const server of servers) {
    const row = compat.items.find(entry => entry.item.itemId === server.id);
    assert.deepEqual(row.staticBlockers, [], server.id);
    assert.equal(row.notRendered?.reason, 'scope-not-bound', server.id);
    assert.match(row.notRendered.detail, /location for mcp-server items/, server.id);
  }
});

test("a single-file item's own licence goes to the neutral folder under its id, so no two items write one licence", () => {
  const extensions = releases.find(release => release.name === 'release-extensions.content.json').items;
  const claude = toolBindings.find(binding => binding.tool === 'claude');
  const singles = extensions.filter(entry => ['agent', 'command'].includes(entry.kind));
  assert.ok(singles.length > 1);
  const licences = singles.map(item => {
    const rendered = renderDelivery({ tool: 'claude', item, binding: claude, scope: 'project' });
    assert.equal(rendered.status, 'rendered', `${item.id}: ${JSON.stringify(rendered)}`);
    const writes = rendered.recipe.operations.filter(op => op.kind === 'file.write').map(op => [op.material, op.target.segments.map(part => part.literal).join('/')]);
    const licence = writes.filter(([material]) => material === 'license').map(([, path]) => path);
    assert.deepEqual(licence, [`.aih/notices/extensions/${item.id}/LICENSE`], item.id);
    assert.ok(writes.every(([material, path]) => material === 'license' || path.startsWith(`.claude/${item.kind}s/`)), JSON.stringify(writes));
    return licence[0];
  });
  assert.equal(new Set(licences).size, licences.length);
  const compat = checkCompatibility({ tool: 'claude', binding: claude, platform: WINDOWS, items: extensions.map(item => ({ item })) });
  for (const item of singles) assert.deepEqual(compat.items.find(row => row.item.itemId === item.id).staticBlockers, [], item.id);
});
