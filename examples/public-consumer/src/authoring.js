// Portable policy authoring against the public Core contracts and Catalog reader.
// No Node built-ins: this module is safe to bundle for the browser.
import { parsePolicy } from '@aihq/core/contracts';
import {
  configureItem, getItem, listItems, readRelease, validateSelectionSet
} from '@aihq/catalog/reader';

export function openRelease(bytes, expectedSha256) {
  return readRelease(bytes, { expectedSha256 });
}

export function catalogItems(release) {
  return listItems(release);
}

// Same-release required closure in dependency-first order, root item last.
// Cross-release pinned requirements are reported, never silently resolved.
export function requiredItems(release, itemId) {
  const itemIds = [];
  const seen = new Set();
  const diagnostics = [];
  const visit = id => {
    if (seen.has(id)) return;
    seen.add(id);
    const found = getItem(release, id);
    if (!found.found) {
      diagnostics.push(...found.diagnostics);
      return;
    }
    for (const ref of found.item.dependencies.requires) {
      if ('release' in ref) {
        diagnostics.push({
          code: 'DEPENDENCY_UNSUPPORTED', reason: 'cross-release', blocking: true, itemId: id,
          message: 'A required item is pinned to another release; this example selects from one supplied release.'
        });
      } else {
        visit(ref.itemId);
      }
    }
    itemIds.push(id);
  };
  visit(itemId);
  return diagnostics.some(diagnostic => diagnostic.blocking)
    ? { valid: false, diagnostics }
    : { valid: true, itemIds, diagnostics };
}

// selections: [{ id, managementId, scope, itemId, configuration }]
// Values are exactly the caller's; declared defaults are never inserted.
export function authorPolicy({ release, mode, materialSource, selections }) {
  const diagnostics = [];
  const configured = new Map();
  for (const selection of selections) {
    const result = configureItem({
      release, itemId: selection.itemId, configuration: selection.configuration, materialSource
    });
    diagnostics.push(...result.diagnostics);
    if (result.valid) configured.set(selection.id, result);
  }
  if (configured.size !== selections.length) return { valid: false, diagnostics };

  const set = validateSelectionSet({
    releases: { [release.sha256]: release },
    selections: selections.map(selection => ({
      id: selection.id,
      item: {
        releaseSha256: release.sha256,
        itemId: selection.itemId,
        itemSha256: configured.get(selection.id).provenance.itemSha256
      },
      configuration: selection.configuration
    }))
  });
  diagnostics.push(...set.diagnostics);
  if (!set.valid) return { valid: false, diagnostics };

  const policy = {
    schema: 'urn:aihq:core:execution-policy:1.0.0',
    mode,
    selections: selections.map(selection => ({
      id: selection.id,
      managementId: selection.managementId,
      scope: selection.scope,
      configuration: configured.get(selection.id).selection.configuration,
      requires: [...set.requiresBySelectionId[selection.id]],
      recipe: configured.get(selection.id).selection.recipe
    }))
  };
  const origins = Object.fromEntries(selections.map(selection => [
    selection.id,
    Object.fromEntries(Object.entries(configured.get(selection.id).inputs)
      .map(([name, input]) => [name, input.origin]))
  ]));
  return { valid: true, policy, origins, diagnostics };
}

export function exportPolicy(policy) {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

export function reopenPolicy(text) {
  return parsePolicy(text);
}

// Where each declared input's value comes from, for a policy reopened from JSON.
// Selections are matched back to catalog items by their recipe reference identity.
export function policyOrigins(release, document) {
  const diagnostics = [];
  const bySelectionId = {};
  for (const selection of document.selections) {
    const reference = selection.recipe.reference;
    if (!reference) {
      diagnostics.push({
        code: 'ORIGIN_UNAVAILABLE', reason: 'inline-recipe', blocking: false, selectionId: selection.id,
        message: 'Inline recipes declare no catalog item; input origins cannot be named.'
      });
      continue;
    }
    const item = listItems(release).find(candidate =>
      candidate.recipe.path === reference.path && candidate.recipe.sha256 === reference.sha256);
    if (!item) {
      diagnostics.push({
        code: 'ORIGIN_UNAVAILABLE', reason: 'item-not-in-release', blocking: false, selectionId: selection.id,
        message: 'No item in the supplied release matches this selection recipe.'
      });
      continue;
    }
    bySelectionId[selection.id] = Object.fromEntries(Object.entries(item.inputs).map(([name, spec]) => [
      name,
      Object.hasOwn(selection.configuration, name) ? 'explicit' : spec.default !== undefined ? 'default' : 'omitted'
    ]));
  }
  return { valid: true, bySelectionId, diagnostics };
}
