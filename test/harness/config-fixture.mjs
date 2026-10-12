import { renderConfigEntries, renderTextBlock } from '../../dist/core/internal/recipe-editors.js';

// Exercise the actual bounded editor from the authored recipe, rather than a
// second vendor-specific whole-file renderer.
export function renderConfigurations(result, recipe, snapshots) {
  if (result.status !== 'completed' || !result.bindings) return result;
  const values = { ...result.bindings, ...result.privateBindings };
  const slot = value => Object.hasOwn(value, 'literal') ? value.literal : values[value.input];
  result.renderedConfigs = {};
  for (const op of recipe.operations.filter(item => item.id.endsWith('-config'))) {
    const before = Buffer.from(snapshots[op.id] ?? '');
    const after = op.kind === 'config.entries' ? renderConfigEntries(op.format, before,
      op.entries.map(entry => ({ ...entry, value: slot(entry.value) }))) :
      renderTextBlock(before, { ...op, content: slot(op.content) });
    result.renderedConfigs[op.id.replace('-config', 'Config')] = after.toString();
  }
  return result;
}
