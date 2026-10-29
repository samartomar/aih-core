// The real Catalog 1.7.0 Superpowers set (16 items) with its notices, and AIH-Extensions' git-guard with its
// notices: the 19 items the Workbench installs for the first product journey. Materials are the released package
// bytes at their published package paths; nothing here is a hand-built stand-in for an item or its content.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, prepare } from '../dist/core/index.js';
import { renderDelivery, toolBindings } from '../dist/harness/contracts.mjs';

export const catalogRoot = fileURLToPath(new URL('./fixtures/catalog-1.7.0/', import.meta.url));
const read = name => JSON.parse(readFileSync(join(catalogRoot, name), 'utf8'));
export const superpowers = read('release-superpowers.content.json');
export const extensions = read('release-extensions.content.json');
const provenance = read('provenance.json');
const texts = read('rule-texts.json');
const releases = { superpowers, extensions };
const frameworkOf = new Map(Object.entries(releases).flatMap(([framework, release]) => release.items.map(item => [item.id, framework])));
const items = new Map(Object.entries(releases).flatMap(([, release]) => release.items.map(item => [item.id, item])));
const claude = toolBindings.find(binding => binding.tool === 'claude');
const set = superpowers.sets.find(entry => entry.id === 'superpowers');
export const noticesId = { superpowers: 'superpowers.notices--superpowers.hook.session-start',
  extensions: 'extensions.notices--extensions.hook.git-guard' };

export const itemOf = id => items.get(id);
export const selectionIdOf = id => id.endsWith('.notices') ? noticesId[id.split('.')[0]] : id;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const contentsOf = item => Object.fromEntries(item.materials
  .filter(member => member.role === 'content' && texts[member.packagePath] !== undefined)
  .map(member => [member.id, texts[member.packagePath]]));

function selection(itemId, requiredById) {
  const item = items.get(itemId), framework = frameworkOf.get(itemId);
  const rendered = renderDelivery({ tool: 'claude', item, binding: claude, scope: 'project',
    ...(requiredById === undefined ? {} : { requiredBy: items.get(requiredById) }), contents: contentsOf(item) });
  assert.equal(rendered.status, 'rendered', `${itemId}: ${JSON.stringify(rendered)}`);
  const id = selectionIdOf(itemId);
  const origins = itemId.endsWith('.notices')
    ? [{ reasonIncluded: 'required-by', requiredBy: { framework, itemId: requiredById } }]
    : itemId === 'extensions.hook.git-guard' ? [{ reasonIncluded: 'chosen' }]
    : [{ reasonIncluded: 'in-set', set: { framework: 'superpowers', setId: set.id, setSha256: set.setSha256 } }];
  return { id, managementId: id, scope: 'project', configuration: {},
    requires: itemId.endsWith('.notices') ? [] : itemId.startsWith('superpowers.') ? [noticesId.superpowers] : [noticesId.extensions],
    recipe: { inline: rendered.recipe },
    item: { framework, itemId, contentSha256: item.contentSha256, behaviourSha256: item.behaviourSha256 },
    tool: 'claude', name: item.name, kind: item.kind, origins };
}

/** The 19 real selections: Superpowers' 16 set members and notices, git-guard and its notices. */
export function realSelections() {
  const ids = [...set.members.map(member => member.item.itemId), 'superpowers.notices', 'extensions.hook.git-guard', 'extensions.notices'];
  for (const id of ids) {
    const item = items.get(id);
    assert.ok(item, id);
    for (const member of item.materials) {
      const path = join(catalogRoot, member.packagePath);
      assert.ok(existsSync(path), `${id} material ${member.relPath}`);
      assert.equal(sha256(readFileSync(path)), member.sha256, `${id} material ${member.relPath}`);
    }
  }
  return ids.map(id => id === 'superpowers.notices' ? selection(id, 'superpowers.hook.session-start')
    : id === 'extensions.notices' ? selection(id, 'extensions.hook.git-guard') : selection(id));
}

export function assertVendoredRelease() {
  for (const [name, digest] of Object.entries(provenance.files)) assert.equal(sha256(readFileSync(join(catalogRoot, name))), digest, name);
}

export const controls = () => ({ logging: 'off', materialRoots: { catalog: catalogRoot } });
export const approve = review => ({ reviewDigest: review.reviewDigest, approved: true, origin: 'automation' });

export async function installReal(sandbox) {
  const selections = realSelections();
  const prepared = await prepare({ useCase: 'policy', policy: { schema: 'urn:aihq:core:execution-policy:1.5.0', mode: 'vibe', selections },
    target: { project: sandbox.project } }, controls());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const run = await apply(prepared.prepared, approve(prepared.review), controls());
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  return { selections, prepared, run };
}

/** Every file under `directory`, path-relative, by exact bytes digest. */
export function fileTree(directory) {
  const result = {};
  const walk = current => {
    for (const name of readdirSync(current)) {
      const path = join(current, name), rel = path.slice(directory.length + 1).replaceAll('\\', '/');
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else result[rel] = sha256(readFileSync(path));
    }
  };
  if (existsSync(directory)) walk(directory);
  return result;
}
