// Real Catalog content for recipe-less selection tests, read at test time from a packed @aihq/catalog named by
// AIH_CATALOG_PACK (the .tgz from `npm pack` in samartomar/aih-catalog). Nothing from the Catalog is vendored here.
// Policies are composed as the Workbench composes them: Catalog's own reader resolves sets and requirements, and an
// inline selection carries the recipe Harness renders for it.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderDelivery, toolBindings } from '../../dist/harness/contracts.mjs';

export const POLICY_15 = 'urn:aihq:core:execution-policy:1.5.0';
export const POLICY_16 = 'urn:aihq:core:execution-policy:1.6.0';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
export const policyBytes = policy => new TextEncoder().encode(JSON.stringify(policy) + '\n').length;
const RELEASES = ['release-ecc.content.json', 'release-extensions.content.json', 'release-superpowers.content.json',
  'release-project-basics.content.json'];

/** The packed Catalog, extracted once into a temporary folder, or why the tests that need it are skipped. */
export async function catalogPack() {
  const pack = process.env.AIH_CATALOG_PACK;
  if (!pack) return { skip: 'AIH_CATALOG_PACK is not set: set it to a packed @aihq/catalog (.tgz) to run the real-content recipe-less tests' };
  if (!existsSync(pack)) return { skip: `AIH_CATALOG_PACK names no file: ${pack}` };
  const folder = mkdtempSync(join(tmpdir(), 'aih-catalog-pack-'));
  execFileSync('tar', ['-xzf', pack, '-C', folder], { windowsHide: true });
  const root = join(folder, 'package');
  const reader = await import(pathToFileURL(join(root, 'dist/release/reader.js')).href);
  const releases = {};
  for (const name of RELEASES) {
    const path = `release/${name}`;
    const bytes = readFileSync(join(root, path));
    const digest = sha256(bytes);
    const read = reader.readReleaseContent(new Uint8Array(bytes), { expectedSha256: digest });
    if (!read.valid) throw new Error(`${name}: ${JSON.stringify(read.diagnostics)}`);
    const document = JSON.parse(bytes);
    releases[document.framework.id] = { path, bytes, sha256: digest, document, checked: read.release,
      items: new Map(document.items.map(item => [item.id, item])) };
  }
  return { root, reader, releases, folder };
}

/** The release reference a recipe-less policy names, read through the `catalog` material root. */
export const releaseReference = release => ({ framework: release.document.framework.id, source: { kind: 'local', input: 'catalog' },
  path: release.path, sha256: release.sha256, byteLength: release.bytes.length });

/** Material text as the Workbench supplies it for marker blocks: every content material, decoded. */
export function contentsOf(pack, item) {
  return Object.fromEntries(item.materials.filter(member => member.role === 'content')
    .map(member => [member.id, new TextDecoder().decode(readFileSync(join(pack.root, member.packagePath)))]));
}

/**
 * The inline recipe the Workbench writes for one selection: one rendering per requiring item for a supporting
 * document (operation and check ids suffixed per rendering), otherwise one rendering.
 */
export function inlineRecipe({ pack, tool, item, scope, requiredBy = [] }) {
  const binding = toolBindings.find(candidate => candidate.tool === tool);
  const contents = contentsOf(pack, item);
  const deliveries = (requiredBy.length ? requiredBy : [undefined]).map(requirer =>
    renderDelivery({ tool, item, binding, scope, contents, ...(requirer ? { requiredBy: requirer } : {}) }));
  const refused = deliveries.find(delivery => delivery.status !== 'rendered');
  if (refused) return refused;
  const [rendered] = deliveries;
  if (deliveries.length === 1) return rendered;
  const unique = deliveries.map((delivery, index) => ({ ...delivery, recipe: { ...delivery.recipe,
    operations: delivery.recipe.operations.map(operation => ({ ...operation, id: `${operation.id}-${index + 1}`,
      requires: (operation.requires ?? []).map(required => `${required}-${index + 1}`), checks: (operation.checks ?? []).map(check => `${check}-${index + 1}`) })),
    checks: delivery.recipe.checks.map(check => ({ ...check, id: `${check.id}-${index + 1}` })) } }));
  return { ...rendered, recipe: { ...rendered.recipe,
    materials: [...new Map(unique.flatMap(delivery => delivery.recipe.materials).map(material => [`${material.id}/${material.path}/${material.sha256}`, material])).values()],
    targets: [...new Set(unique.flatMap(delivery => delivery.recipe.targets))], prerequisites: [...new Set(unique.flatMap(delivery => delivery.recipe.prerequisites))],
    operations: unique.flatMap(delivery => delivery.recipe.operations), checks: unique.flatMap(delivery => delivery.recipe.checks) } };
}

const releaseOf = (pack, releaseSha256) => Object.values(pack.releases).find(release => release.sha256 === releaseSha256);
/** A starting set chosen whole, as the Workbench requests it. */
export const setRequest = (pack, framework, setId, options) => {
  const release = pack.releases[framework];
  const set = release.document.sets.find(entry => entry.id === setId);
  if (!set) throw new Error(`no set ${setId}`);
  return { release: { releaseSha256: release.sha256, scope: 'project' }, setId, setSha256: set.setSha256, ...(options ? { options } : {}) };
};
/** A single item chosen by itself. */
export const rootRequest = (pack, framework, itemId) => ({ releaseSha256: pack.releases[framework].sha256, itemId, scope: 'project', configuration: {} });

/**
 * The values a person enters for an item's required inputs that have no default: ordinary ones go in the selection's
 * configuration, sensitive ones only in the live request. Only the `${NAME}` reference is ever written.
 */
function filledIn(item, sensitive) {
  // Only an input the server's registration references becomes a recipe input.
  const referenced = new Set(['env', 'headers'].flatMap(field => Object.values(item.payload?.[field] ?? {}))
    .filter(value => value && typeof value.input === 'string').map(value => value.input));
  return Object.fromEntries(Object.entries(item.requirements?.inputs ?? {})
    .filter(([name, spec]) => referenced.has(name) && spec.required && spec.default === undefined && !!spec.sensitive === sensitive)
    .map(([name]) => [name, `example-${name.toLowerCase()}`]));
}
/** The sensitive input values for a composed policy's selections, as `controls.privateInputs`. */
export function privateInputsFor(pack, policy) {
  return Object.fromEntries(policy.selections.map(selection => [selection.id,
    filledIn(pack.releases[selection.item.framework].items.get(selection.item.itemId), true)])
    .filter(([, values]) => Object.keys(values).length > 0));
}

/**
 * An execution policy for the tool, composed as the Workbench composes it from Catalog's resolution. `recipeless`
 * names each item instead of carrying its rendered recipe, in execution policy 1.6.0 with the releases it reads.
 */
export function composePolicy(pack, { sets = [], roots = [], tool = 'claude', recipeless, schema }) {
  const checked = Object.fromEntries(Object.values(pack.releases).map(release => [release.sha256, release.checked]));
  const resolution = pack.reader.resolveSelections({ releases: checked, roots, skips: [], sets });
  if (resolution.status !== 'ok') throw new Error(JSON.stringify(resolution.diagnostics));
  const resolved = resolution.value.selections;
  const validation = pack.reader.validateSelectionSet({ releases: checked, selections: resolved });
  if (!validation.valid) throw new Error(JSON.stringify(validation.diagnostics));
  const binding = toolBindings.find(candidate => candidate.tool === tool);
  const used = new Set();
  const itemOf = selection => releaseOf(pack, selection.item.releaseSha256).items.get(selection.item.itemId);
  const selections = resolved.map(selection => {
    const release = releaseOf(pack, selection.item.releaseSha256);
    const item = itemOf(selection);
    used.add(release.document.framework.id);
    const metadata = { item: { framework: release.document.framework.id, itemId: item.id, contentSha256: item.contentSha256,
      behaviourSha256: item.behaviourSha256 }, tool, name: item.name ?? item.label, kind: item.kind, origins: structuredClone(selection.origins) };
    const requiredBy = item.kind === 'document' && item.payload?.placement !== 'project-folder'
      ? selection.origins.filter(origin => origin.reasonIncluded === 'required-by').map(origin => {
        const other = resolved.find(candidate => candidate.item.itemId === origin.requiredBy?.itemId &&
          releaseOf(pack, candidate.item.releaseSha256).document.framework.id === origin.requiredBy?.framework);
        if (!other) throw new Error(`no requirer for ${item.id}`);
        return itemOf(other);
      }) : [];
    const base = { id: selection.id, managementId: `${selection.scope}--aihq.catalog--${item.id}`, scope: selection.scope,
      configuration: { ...selection.configuration, ...filledIn(item, false) }, ...metadata, bindingDigest: binding.digest,
      ...(item.scan?.length ? { scanRecords: structuredClone(item.scan), itemMaterials: item.materials.map(material => ({ materialId: material.id,
        relPath: material.relPath, path: material.packagePath, sha256: material.sha256, byteLength: material.byteLength, role: material.role })) } : {}),
      requires: validation.requiresBySelectionId[selection.id] ?? [] };
    if (recipeless) return base;
    const rendered = inlineRecipe({ pack, tool, item, scope: selection.scope, requiredBy });
    if (rendered.status !== 'rendered') throw new Error(`${item.id}: ${JSON.stringify(rendered)}`);
    return { ...base, recipe: { inline: rendered.recipe } };
  });
  return { schema: schema ?? (recipeless ? POLICY_16 : POLICY_15), mode: 'vibe',
    ...(recipeless ? { catalogReleases: [...used].sort().map(framework => releaseReference(pack.releases[framework])) } : {}),
    selections, excludedItems: [] };
}

/** The ECC default pick in the Workbench: its pre-ticked starting sets plus TypeScript rules. */
export const ECC_DEFAULT = ['ecc.rules.common', 'ecc.module.rules-core', 'ecc.module.agents-core', 'ecc.module.commands-core',
  'ecc.module.hooks-runtime', 'ecc.module.platform-configs', 'ecc.module.workflow-quality', 'ecc.rules.typescript'];
export const eccDefault = pack => ECC_DEFAULT.map(id => setRequest(pack, 'ecc', id));
export const eccFullTypescript = pack => [setRequest(pack, 'ecc', 'ecc.profile.full', { languages: ['typescript'] })];
