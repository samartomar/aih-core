// Execution policy 1.6.0: recipe-less item selections. A selection names its Catalog item and tool; Core renders its
// recipe at Prepare from the shipped binding, through Harness renderDelivery, exactly as a consumer renders the inline
// recipe it would otherwise carry. The item comes from the Catalog release content document the policy names, read
// through the same material sources and roots as recipe materials and verified by SHA-256 and length.
import { renderDelivery, deliveryMaterialRoot, type CatalogItem, type DeliveryRefusal, type RenderedDelivery } from '../../harness/delivery.mjs';
import { toolBindings, type ToolBinding } from '../../harness/tool-binding.mjs';
import { captureInlineMaterials, type InlineMaterialDescriptor, type MaterialCaptureBudget } from './material.js';
import { parseStrictJsonObjectV1 } from './strict-json.js';
import { canonicalJson, codeUnitCompare } from './canonical.js';
import type { Diagnostic, ExecutionPolicy, Recipe, Selection } from '../types.js';

type Rendered = RenderedDelivery | DeliveryRefusal;
type Recheck = { recheck(): Promise<boolean> };

/**
 * The recipe for one item selection: one rendering, or for a supporting document one rendering beside each requiring
 * item, combined with each rendering's operation and check ids suffixed by its position. Requirers without a folder of
 * their own share one copy in the neutral notices folder: their renderings differ only in the recipe id, so that copy
 * is planned once, by the first of them, and the others add no operations.
 */
export function renderSelectionRecipe({ tool, binding, item, scope, contents, requiredBy }: {
  tool: string; binding: ToolBinding | undefined; item: CatalogItem; scope: 'project' | 'user';
  contents?: Readonly<Record<string, string>>; requiredBy: readonly CatalogItem[];
}): Rendered {
  const deliveries = (requiredBy.length ? requiredBy : [undefined]).map(requirer => renderDelivery({ tool, item, binding: binding!, scope,
    ...(contents ? { contents } : {}), ...(requirer ? { requiredBy: requirer } : {}) }));
  const refused = deliveries.find(delivery => delivery.status !== 'rendered');
  if (refused) return refused;
  const rendered = deliveries[0] as RenderedDelivery;
  if (deliveries.length === 1) return rendered;
  const planned = new Set<string>();
  const unique = (deliveries as RenderedDelivery[]).map((delivery, index) => ({ delivery, index })).filter(({ delivery }) => {
    const { id: _id, ...recipe } = delivery.recipe;
    const key = canonicalJson(recipe);
    if (planned.has(key)) return false;
    planned.add(key);
    return true;
  }).map(({ delivery, index }) => ({ ...delivery, recipe: { ...delivery.recipe,
    operations: delivery.recipe.operations.map(operation => ({ ...operation, id: `${String(operation.id)}-${index + 1}`,
      requires: ((operation.requires ?? []) as string[]).map(required => `${required}-${index + 1}`),
      checks: ((operation.checks ?? []) as string[]).map(check => `${check}-${index + 1}`) })),
    checks: delivery.recipe.checks.map(check => ({ ...check, id: `${String(check.id)}-${index + 1}` })) } }));
  return { ...rendered, recipe: { ...rendered.recipe,
    materials: [...new Map(unique.flatMap(delivery => delivery.recipe.materials)
      .map(material => [`${material.id}/${material.path}/${material.sha256}`, material])).values()],
    targets: [...new Set(unique.flatMap(delivery => delivery.recipe.targets))],
    prerequisites: [...new Set(unique.flatMap(delivery => delivery.recipe.prerequisites))],
    operations: unique.flatMap(delivery => delivery.recipe.operations), checks: unique.flatMap(delivery => delivery.recipe.checks) } };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const supportingDocument = (item: CatalogItem) => item.kind === 'document' &&
  (item.payload as { placement?: unknown } | null | undefined)?.placement !== 'project-folder';
const refusal = (code: Diagnostic['code'], reason: string, path: string, message: string): Diagnostic => ({ code, reason, path, message });

/**
 * Renders every recipe-less selection of a policy in place, from the releases it names. Returns the diagnostics that
 * refuse the policy, and the captures Apply rechecks so the release and material text read here cannot change unseen.
 * Every capture is charged to `budget` before it is sealed, so rendering and the recipes share one per-policy bound.
 * Prepare calls this only after any organization authority read.
 */
export async function renderRecipelessSelections(policy: ExecutionPolicy, roots: Record<string, string>,
    budget: MaterialCaptureBudget, signal?: AbortSignal): Promise<{ diagnostics: Diagnostic[]; captures: Recheck[] }> {
  const pending = policy.selections.map((selection, index) => ({ selection, index })).filter(({ selection }) => selection.recipe === undefined);
  if (!pending.length) return { diagnostics: [], captures: [] };
  // Requiring items are read too: a supporting document is rendered beside each one.
  const named = (selection: Selection) => selection.item!;
  const requirerOf = (selection: Selection, origin: NonNullable<Selection['origins']>[number]) => {
    if (origin.reasonIncluded !== 'required-by') return undefined;
    const framework = origin.requiredBy.framework ?? named(selection).framework;
    return policy.selections.find(other => other.item?.framework === framework && other.item.itemId === origin.requiredBy.itemId) ?? null;
  };
  const frameworks = new Set(pending.flatMap(({ selection }) => [named(selection).framework,
    ...(selection.origins ?? []).map(origin => requirerOf(selection, origin)?.item?.framework).filter((id): id is string => id !== undefined)]));
  const references = (policy.catalogReleases ?? []).filter(release => frameworks.has(release.framework));
  const descriptors: InlineMaterialDescriptor[] = references.map(release => ({ id: `catalog-release.${release.framework}`,
    source: release.source, path: release.path, sha256: release.sha256, byteLength: release.byteLength }))
    .sort((a, b) => codeUnitCompare(a.id, b.id));
  budget.chargeInline(descriptors);
  const captured = await captureInlineMaterials(descriptors, roots, signal === undefined ? {} : { signal });
  const captures: Recheck[] = [captured];
  const diagnostics: Diagnostic[] = [];
  const releases = new Map<string, Map<string, CatalogItem>>();
  for (const release of references) {
    let document: Record<string, unknown> | undefined;
    try { document = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(captured.readMaterial(`catalog-release.${release.framework}`)),
      'catalog release'); } catch { document = undefined; }
    const items = document?.items;
    if (!document || !isRecord(document.framework) || document.framework.id !== release.framework || !Array.isArray(items) ||
        !items.every(item => isRecord(item) && typeof item.id === 'string')) {
      diagnostics.push(refusal('INPUT_INVALID', 'catalog-release-invalid', `/catalogReleases/${policy.catalogReleases!.indexOf(release)}`,
        'The named Catalog release is not a release content document for that framework.'));
      continue;
    }
    releases.set(release.framework, new Map((items as CatalogItem[]).map(item => [item.id, item])));
  }
  if (diagnostics.length) return { diagnostics, captures };
  /** The release item a selection names, with both identities and the kind it declares. */
  const itemFor = (selection: Selection, path: string): CatalogItem | undefined => {
    const ref = named(selection);
    const item = releases.get(ref.framework)?.get(ref.itemId);
    if (!item) {
      diagnostics.push(refusal('INPUT_INVALID', releases.has(ref.framework) ? 'catalog-item-missing' : 'catalog-release-missing', `${path}/item`,
        'The named Catalog release does not carry this item.'));
      return undefined;
    }
    if (item.contentSha256 !== ref.contentSha256 || item.behaviourSha256 !== ref.behaviourSha256 || item.kind !== selection.kind) {
      diagnostics.push(refusal('INPUT_INVALID', 'catalog-item-identity', `${path}/item`,
        'The named Catalog release carries another version of this item.'));
      return undefined;
    }
    return item;
  };
  for (const { selection, index } of pending) {
    const path = `/selections/${index}`;
    const item = itemFor(selection, path);
    if (!item) continue;
    const requiredBy: CatalogItem[] = [];
    if (supportingDocument(item)) for (const origin of selection.origins ?? []) {
      const requirer = requirerOf(selection, origin);
      if (requirer === undefined) continue;
      const found = requirer === null ? undefined : itemFor(requirer, `/selections/${policy.selections.indexOf(requirer)}`);
      if (requirer === null) diagnostics.push(refusal('INPUT_INVALID', 'required-by-missing', `${path}/origins`,
        'A supporting document is delivered beside the item requiring it; that item is not selected.'));
      if (!found) break;
      requiredBy.push(found);
    }
    if (diagnostics.length) continue;
    const binding = toolBindings.find(candidate => candidate.tool === selection.tool);
    const render = (contents?: Record<string, string>) =>
      renderSelectionRecipe({ tool: selection.tool!, binding, item, scope: selection.scope, ...(contents ? { contents } : {}), requiredBy });
    // A marker block carries its material's text: read from the Catalog root only the materials rendering asks for,
    // each once. A block's material is never also a written recipe material, so nothing is captured twice.
    const contents: Record<string, string> = {};
    let rendered = render();
    while (rendered.status !== 'rendered' && rendered.reason === 'content-required') {
      const id = rendered.path?.startsWith('/contents/') ? rendered.path.slice('/contents/'.length) : undefined;
      const member = item.materials.find(candidate => candidate.id === id && candidate.role !== 'behaviour');
      if (!member || Object.hasOwn(contents, member.id)) break;
      const wanted = [{ id: member.id, source: { kind: 'local' as const, input: deliveryMaterialRoot }, path: member.packagePath,
        sha256: member.sha256, byteLength: member.byteLength }];
      budget.chargeInline(wanted);
      const text = await captureInlineMaterials(wanted, roots, signal === undefined ? {} : { signal });
      captures.push(text);
      try { contents[member.id] = new TextDecoder('utf-8', { fatal: true }).decode(text.readMaterial(member.id)); } catch { break; }
      rendered = render(contents);
    }
    if (rendered.status !== 'rendered') {
      diagnostics.push(refusal(rendered.code, rendered.reason, path, rendered.guidance ?? rendered.message ?? 'Core could not render this item for the tool.'));
      continue;
    }
    selection.recipe = { inline: rendered.recipe as unknown as Recipe };
  }
  // A requiring item's own refusal is reported once, at its own selection.
  const seen = new Set<string>();
  return { diagnostics: diagnostics.filter(item => !seen.has(`${item.path}\0${item.reason}`) && !!seen.add(`${item.path}\0${item.reason}`)), captures };
}
