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
  assert.deepEqual(Object.fromEntries(['ecc', 'extensions', 'superpowers'].map(family =>
    [family, hooks.filter(item => item.id.startsWith(`${family}.`)).length])), { ecc: 24, extensions: 3, superpowers: 1 });
  for (const item of hooks) {
    const itemDir = `\${CLAUDE_PROJECT_DIR}/.claude/hooks/${item.id}`;
    const command = commandOf(item);
    assert.ok(command.startsWith(`CLAUDE_PLUGIN_ROOT="${itemDir}" `), `${item.id}: ${command}`);
    // The script itself still runs from the item folder, exactly as before.
    const script = item.materials.find(member => member.id === item.payload.command.script);
    assert.ok(command.includes(`"${itemDir}/${script.relPath}"`), `${item.id}: ${command}`);
  }
});

test('the hooks that read CLAUDE_PLUGIN_ROOT see their own item folder, and no item supplies the config it adds', () => {
  // ECC's runners fall back to the folder two levels above scripts/hooks/, and Superpowers' script to the folder above
  // hooks/: both are the item folder Core delivers the materials into, which is what {pluginRoot} names. Extensions
  // hooks never read the variable.
  const levelsUp = { ecc: ['scripts/hooks/', 2], superpowers: ['hooks/', 1] };
  for (const item of hooks) {
    const family = item.id.split('.')[0];
    assert.ok(['ecc', 'extensions', 'superpowers'].includes(family), `${item.id}: a hook family this test has not checked`);
    if (family === 'extensions') continue;
    const script = item.materials.find(member => member.id === item.payload.command.script).relPath;
    const [prefix, depth] = levelsUp[family];
    assert.ok(script.startsWith(prefix) && script.split('/').length === depth + 1, `${item.id}: ${script}`);
  }
  // ECC's scripts/lib/hook-flags.js has no fallback of its own: with the variable set it also looks for
  // <pluginRoot>/ecc/setup.json. No item delivers that file, so its hooks read no extra configuration.
  for (const item of hooks) assert.ok(!item.materials.some(member => member.relPath.startsWith('ecc/')), item.id);
});
