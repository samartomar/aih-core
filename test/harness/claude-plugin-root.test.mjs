// Claude hook commands set CLAUDE_PLUGIN_ROOT to the Catalog placeholder {pluginRoot} (= {itemDir}). Superpowers'
// bootstrap reads it to emit the hookSpecificOutput Claude Code injects; every other real hook either ignores it or
// resolves the same folder from its own location, so the value changes nothing for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderDelivery, toolBindings } from '../../dist/harness/contracts.mjs';

const folder = new URL('../fixtures/catalog-1.7.0/', import.meta.url);
const provenance = JSON.parse(readFileSync(new URL('provenance.json', folder), 'utf8'));
const hooks = Object.keys(provenance.files).flatMap(name => JSON.parse(readFileSync(new URL(name, folder), 'utf8')).items)
  .filter(item => item.kind === 'hook');
const claude = toolBindings.find(binding => binding.tool === 'claude');
const commandOf = item => {
  const rendered = renderDelivery({ tool: 'claude', item, binding: claude, scope: 'project' });
  assert.equal(rendered.status, 'rendered', `${item.id}: ${JSON.stringify(rendered)}`);
  return rendered.recipe.operations.find(op => op.kind === 'hook.group').selector.value;
};

test('every real Claude hook command sets CLAUDE_PLUGIN_ROOT to its own item folder', () => {
  assert.equal(claude.layouts.hook.commandTemplate, 'CLAUDE_PLUGIN_ROOT="{pluginRoot}" {command}');
  assert.ok(hooks.length >= 28, `${hooks.length} real hooks`);
  for (const item of hooks) {
    const itemDir = `\${CLAUDE_PROJECT_DIR}/.claude/hooks/${item.id}`;
    const command = commandOf(item);
    assert.ok(command.startsWith(`CLAUDE_PLUGIN_ROOT="${itemDir}" `), `${item.id}: ${command}`);
    // The script itself still runs from the item folder, exactly as before.
    const script = item.materials.find(member => member.id === item.payload.command.script);
    assert.ok(command.includes(`"${itemDir}/${script.relPath}"`), `${item.id}: ${command}`);
  }
});

test('the hooks that read CLAUDE_PLUGIN_ROOT resolve the same item folder without it', () => {
  // ECC's runners fall back to the folder two levels above scripts/hooks/; Superpowers' script to the folder above
  // hooks/. Both are the item folder Core delivers the materials into, which is what {pluginRoot} names.
  const levelsUp = { ecc: ['scripts/hooks/', 2], superpowers: ['hooks/', 1] };
  for (const item of hooks) {
    const family = item.id.split('.')[0];
    const script = item.materials.find(member => member.id === item.payload.command.script).relPath;
    if (family === 'extensions') continue; // Extensions hooks never read CLAUDE_PLUGIN_ROOT.
    const [prefix, depth] = levelsUp[family];
    assert.ok(script.startsWith(prefix) && script.split('/').length === depth + 1, `${item.id}: ${script}`);
  }
  assert.deepEqual([...new Set(hooks.map(item => item.id.split('.')[0]))].sort(), ['ecc', 'extensions', 'superpowers']);
});
