import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepare, apply, prepareManagedRemoval } from '../dist/core/index.js';
import { sandbox, authorize } from './hook-group-fixture.mjs';

const document = (id, path, value) => ({
  schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
    id, managementId: id, scope: 'project', configuration: {}, requires: [], recipe: { inline: {
      schema: 'urn:aihq:core:recipe:1.0.0', id: 'toml-fixture', description: 'Selected TOML entry',
      inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [], operations: [{
        id: 'config', purpose: 'Set selected TOML entry', kind: 'config.entries', format: 'toml', scope: 'project',
        target: { root: 'project', segments: [{ literal: 'config.toml' }] }, requires: [], checks: [],
        entries: [{ path, action: 'set', value: { literal: value } }]
      }]
    } }
  }]
});
async function install(s, policy) {
  const p = await prepare({ useCase: 'policy', target: { project: s.project }, policy }, { logging: 'off' });
  assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
  assert.equal((await apply(p.prepared, authorize(p), { logging: 'off' })).completion, 'complete');
}
async function remove(s, id) {
  const r = await prepareManagedRemoval({ target: { project: s.project }, managementId: id, scope: 'project', mode: 'vibe' }, { logging: 'off' });
  assert.equal(r.preparation.status, 'ready', JSON.stringify(r));
  assert.equal((await apply(r.preparation.prepared, authorize(r.preparation), { logging: 'off' })).completion, 'complete');
}

test('custody of a quoted TOML name uses ownership 1.3.0 until the last such entry is removed', async () => {
  const s = sandbox('aih-toml-own-');
  try {
    const original = '# keep\n[mcp_servers."name.with.dots"]\ncommand = "npx"\n';
    s.write('config.toml', original);
    const receipt = join(s.home, '.aih', 'core', 'ownership', createHash('sha256').update(realpathSync.native(s.project)).digest('hex') + '.json');
    const schema = () => JSON.parse(readFileSync(receipt)).schema;
    await install(s, document('bare', ['mcp_servers', 'aih', 'args'], ['server.js', '--stdio']));
    assert.equal(schema(), 'urn:aihq:core:ownership:1.0.0', 'bare paths and arrays keep the 1.0.0 root');
    await install(s, document('quoted', ['mcp_servers', 'name.with.dots', 'enabled'], true));
    assert.equal(schema(), 'urn:aihq:core:ownership:1.3.0');
    await remove(s, 'quoted');
    assert.equal(schema(), 'urn:aihq:core:ownership:1.0.0');
    await remove(s, 'bare');
    // Entry removal deletes only the statement; the header it created stays, as before.
    assert.equal(s.read('config.toml'), original + '[mcp_servers.aih]\n');
  } finally { s.dispose(); }
});

test('ownership validation requires 1.3.0 for a non-bare TOML entry segment', async () => {
  const { validateOwnership, sealOwnership } = await import('../dist/core/internal/state.js');
  const { memberKey } = await import('../dist/core/internal/recipe-lifecycle.js');
  const s = sandbox('aih-toml-own-validate-');
  try {
    const target = realpathSync.native(s.project);
    const descriptor = { path: 'config.toml', kind: 'entry', format: 'toml', entry: ['mcp_servers', 'name.with.dots', 'command'] };
    const owner = { managementId: 'quoted', recipeIdentity: `sha256:${'a'.repeat(64)}`, sha256: 'b'.repeat(64), mode: 420, descriptor,
      claims: [{ managementId: 'quoted', scope: 'project', sets: [], requires: [] }] };
    const root = schema => ({ schema, target, members: { [memberKey(descriptor)]: owner } });
    assert.equal(sealOwnership(root('urn:aihq:core:ownership:1.0.0')).schema, 'urn:aihq:core:ownership:1.3.0');
    for (const schema of ['1.0.0', '1.1.0', '1.2.0'])
      assert.throws(() => validateOwnership(root(`urn:aihq:core:ownership:${schema}`), target), /ownership-invalid/);
    validateOwnership(root('urn:aihq:core:ownership:1.3.0'), target);
    // An INI entry may share a 1.3.0 root, which returns to 1.2.0 once the quoted entry is gone.
    const ini = { path: 'settings.ini', kind: 'entry', format: 'ini', entry: ['global', 'cert'] };
    const mixed = { ...root('urn:aihq:core:ownership:1.3.0'), members: { ...root('').members,
      [memberKey(ini)]: { ...owner, managementId: 'ini', descriptor: ini, claims: [{ ...owner.claims[0], managementId: 'ini' }] } } };
    validateOwnership(mixed, target);
    const remaining = { ...mixed, members: { [memberKey(ini)]: mixed.members[memberKey(ini)] } };
    assert.equal(sealOwnership(remaining).schema, 'urn:aihq:core:ownership:1.2.0');
  } finally { s.dispose(); }
});
