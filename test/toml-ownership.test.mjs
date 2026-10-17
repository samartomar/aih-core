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
// One selection whose recipe sets several entries of config.toml, given as [path, value] pairs.
const entriesDocument = (id, pairs) => {
  const base = document(id, pairs[0][0], pairs[0][1]);
  base.selections[0].recipe.inline.operations[0].entries = pairs.map(([path, value]) => ({ path, action: 'set', value: { literal: value } }));
  return base;
};
// One selection whose recipe removes the given entries from config.toml.
const removeDocument = (id, paths) => {
  const base = document(id, paths[0], null);
  base.selections[0].recipe.inline.operations[0].entries = paths.map(path => ({ path, action: 'remove' }));
  return base;
};
const receiptOf = s => join(s.home, '.aih', 'core', 'ownership', createHash('sha256').update(realpathSync.native(s.project)).digest('hex') + '.json');
const schemaOf = s => JSON.parse(readFileSync(receiptOf(s))).schema;
const aih = ['mcp_servers', 'aih'];
const recordsOf = s => Object.values(JSON.parse(readFileSync(receiptOf(s))).members).map(owner => owner.tomlTable);
const codexServer = id => entriesDocument(id, [[[...aih, 'command'], 'aih'], [[...aih, 'args'], ['--stdio']], [[...aih, 'env', 'TOKEN'], 'x']]);
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

test('custody of a quoted TOML name uses ownership 1.3.0, and a created table 1.4.0, until the last such entry is removed', async () => {
  const s = sandbox('aih-toml-own-');
  try {
    const original = '# keep\n[mcp_servers."name.with.dots"]\ncommand = "npx"\n';
    s.write('config.toml', original);
    await install(s, document('quoted', ['mcp_servers', 'name.with.dots', 'enabled'], true));
    assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.3.0');
    await install(s, document('bare', [...aih, 'args'], ['server.js', '--stdio']));
    assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.4.0', 'a created table outranks the quoted-name root');
    await remove(s, 'bare');
    assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.3.0', 'the root returns to its previous version');
    assert.equal(s.read('config.toml'), original + 'enabled = true\n');
    await remove(s, 'quoted');
    assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
    assert.equal(s.read('config.toml'), original);
  } finally { s.dispose(); }
});

test('removing a selection restores a file that did not have its table, byte for byte', async () => {
  for (const original of ['# keep\na = 1\n', 'a = 1', 'a = 1\r\n[u]\r\nk = 1\r\n', 'a = 1\r\n[u]\r\nk = 1']) {
    const s = sandbox('aih-toml-restore-');
    try {
      s.write('config.toml', original);
      await install(s, codexServer('aih'));
      const eol = original.includes('\r\n') ? '\r\n' : '\n';
      const lead = /[\r\n]$/u.test(original) ? '' : eol;
      assert.equal(s.read('config.toml'), original + lead + ['[mcp_servers.aih]', 'command = "aih"', 'args = ["--stdio"]', '[mcp_servers.aih.env]', 'TOKEN = "x"', ''].join(eol));
      assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.4.0');
      await remove(s, 'aih');
      assert.equal(s.read('config.toml'), original, JSON.stringify(original));
      assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
    } finally { s.dispose(); }
  }
});

test('repeat setup of a created table is already satisfied and leaves custody untouched', async () => {
  const s = sandbox('aih-toml-repeat-');
  try {
    const original = 'a = 1\n';
    s.write('config.toml', original);
    await install(s, codexServer('aih'));
    const installed = { file: s.read('config.toml'), receipt: readFileSync(receiptOf(s), 'utf8') };
    const again = await prepare({ useCase: 'policy', target: { project: s.project }, policy: codexServer('aih') }, { logging: 'off' });
    assert.equal(again.status, 'ready', JSON.stringify(again.diagnostics));
    assert.deepEqual(again.review.operations.map(operation => operation.effects), ['already-satisfied']);
    await apply(again.prepared, authorize(again), { logging: 'off' });
    assert.equal(s.read('config.toml'), installed.file);
    assert.equal(readFileSync(receiptOf(s), 'utf8'), installed.receipt);
    await remove(s, 'aih');
    assert.equal(s.read('config.toml'), original);
  } finally { s.dispose(); }
});

test('removal keeps the header of a table that gained a key or a comment after setup', async () => {
  const original = '# keep\na = 1\n';
  for (const [edit, expected] of [
    [text => text.replace('args = ["--stdio"]\n', 'args = ["--stdio"]\npersonal = 1\n'), '[mcp_servers.aih]\npersonal = 1\n'],
    [text => text.replace('[mcp_servers.aih]\n', '[mcp_servers.aih]\n# note\n'), '[mcp_servers.aih]\n# note\n'],
    [text => text.replace('TOKEN = "x"\n', 'TOKEN = "x"\n# env note\n'), '[mcp_servers.aih.env]\n# env note\n']
  ]) {
    const s = sandbox('aih-toml-edited-');
    try {
      s.write('config.toml', original);
      await install(s, codexServer('aih'));
      s.write('config.toml', edit(s.read('config.toml')));
      await remove(s, 'aih');
      assert.equal(s.read('config.toml'), original + expected);
      assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
    } finally { s.dispose(); }
  }
});

test('removal keeps the header of a table that existed before setup', async () => {
  for (const original of ['[mcp_servers.aih]\nother = 1\n', '[mcp_servers.aih]\n', 'a = 1\n[mcp_servers.aih]\n[mcp_servers.aih.env]\nother = 1\n']) {
    const s = sandbox('aih-toml-existing-');
    try {
      s.write('config.toml', original);
      await install(s, codexServer('aih'));
      await remove(s, 'aih');
      assert.equal(s.read('config.toml'), original);
      assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
    } finally { s.dispose(); }
  }
});

test('a created table keeps its header until the last managed key of any selection is gone', async () => {
  for (const order of [['first', 'second'], ['second', 'first']]) {
    const s = sandbox('aih-toml-shared-');
    try {
      const original = 'a = 1';
      s.write('config.toml', original);
      await install(s, entriesDocument('first', [[[...aih, 'command'], 'aih']]));
      await install(s, entriesDocument('second', [[[...aih, 'startup_timeout_sec'], 20]]));
      assert.equal(s.read('config.toml'), 'a = 1\n[mcp_servers.aih]\ncommand = "aih"\nstartup_timeout_sec = 20\n');
      await remove(s, order[0]);
      assert.equal(s.read('config.toml'), order[0] === 'first' ? 'a = 1\n[mcp_servers.aih]\nstartup_timeout_sec = 20\n' : 'a = 1\n[mcp_servers.aih]\ncommand = "aih"\n');
      assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.4.0');
      await remove(s, order[1]);
      assert.equal(s.read('config.toml'), original, order.join(','));
      assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
    } finally { s.dispose(); }
  }
});

test('removal keeps a comment the client added after a managed value, and the header with it', async () => {
  for (const eol of ['\n', '\r\n']) {
    for (const original of [`a = 1${eol}`, `a = 1${eol}b = 2`]) {
      const s = sandbox('aih-toml-comment-');
      try {
        s.write('config.toml', original);
        await install(s, entriesDocument('one', [[['t', 'x'], 1], [['t', 'y'], 2]]));
        const lead = /[\r\n]$/u.test(original) ? '' : eol;
        const installed = `${original}${lead}[t]${eol}x = 1${eol}y = 2${eol}`;
        assert.equal(s.read('config.toml'), installed);
        s.write('config.toml', installed.replace(`x = 1${eol}`, `x = 1 # keep this${eol}`));
        await remove(s, 'one');
        assert.equal(s.read('config.toml'), `${original}${lead}[t]${eol}# keep this${eol}`, JSON.stringify([eol, original]));
        assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
      } finally { s.dispose(); }
    }
  }
});

test('a comment on a managed value that is the file\'s last line stays as its own line', async () => {
  const s = sandbox('aih-toml-comment-last-');
  try {
    s.write('config.toml', 'a = 1\n');
    await install(s, entriesDocument('one', [[['t', 'x'], 1]]));
    s.write('config.toml', 'a = 1\n[t]\nx = 1 # keep this');
    await remove(s, 'one');
    assert.equal(s.read('config.toml'), 'a = 1\n[t]\n# keep this');
  } finally { s.dispose(); }
});

test('a recipe that removes the keys it set drops the table header Core created', async () => {
  for (const original of ['a = 1\n', 'a = 1', 'a = 1\r\n', 'a = 1\r\nb = 2', '']) {
    const s = sandbox('aih-toml-authored-remove-');
    try {
      s.write('config.toml', original);
      await install(s, entriesDocument('one', [[['t', 'x'], 1], [['t', 'y'], 2]]));
      assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.4.0');
      await install(s, removeDocument('one', [['t', 'x'], ['t', 'y']]));
      assert.equal(s.read('config.toml'), original, JSON.stringify(original));
      assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
      assert.deepEqual(recordsOf(s), []);
    } finally { s.dispose(); }
  }
});

test('a recipe that removes one key keeps the header while another managed key is in the table', async () => {
  const s = sandbox('aih-toml-authored-partial-');
  try {
    s.write('config.toml', 'a = 1');
    await install(s, entriesDocument('one', [[['t', 'x'], 1]]));
    await install(s, entriesDocument('two', [[['t', 'y'], 2]]));
    await install(s, removeDocument('one', [['t', 'x']]));
    assert.equal(s.read('config.toml'), 'a = 1\n[t]\ny = 2\n');
    assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.4.0');
    await remove(s, 'two');
    assert.equal(s.read('config.toml'), 'a = 1');
    assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
  } finally { s.dispose(); }
});

test('a recipe that removes a key of a table that existed before setup keeps that header', async () => {
  const s = sandbox('aih-toml-authored-existing-');
  try {
    s.write('config.toml', '[t]\nother = 1\n');
    await install(s, entriesDocument('one', [[['t', 'x'], 1]]));
    await install(s, removeDocument('one', [['t', 'x']]));
    assert.equal(s.read('config.toml'), '[t]\nother = 1\n');
    assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
  } finally { s.dispose(); }
});

test('the added line break moves to the header that follows when a created table is removed first', async () => {
  for (const original of ['a = 1', 'a = 1\r\nb = 2']) {
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const table = (name, key, value) => `[${name}]${eol}${key} = ${value}${eol}`;
    for (const order of [['one', 'two'], ['two', 'one']]) {
      const s = sandbox('aih-toml-separate-');
      try {
        s.write('config.toml', original);
        await install(s, entriesDocument('one', [[['t', 'x'], 1]]));
        await install(s, entriesDocument('two', [[['u', 'y'], 2]]));
        assert.equal(s.read('config.toml'), original + eol + table('t', 'x', 1) + table('u', 'y', 2));
        assert.deepEqual(recordsOf(s), ['created-after-newline', 'created']);
        await remove(s, order[0]);
        assert.equal(s.read('config.toml'), original + eol + (order[0] === 'one' ? table('u', 'y', 2) : table('t', 'x', 1)), order.join(','));
        assert.deepEqual(recordsOf(s), ['created-after-newline'], 'the record moved to the surviving table');
        assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.4.0');
        await remove(s, order[1]);
        assert.equal(s.read('config.toml'), original, JSON.stringify([original, order]));
        assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
      } finally { s.dispose(); }
    }
  }
});

test('the added line break passes along a chain of separately created tables', async () => {
  const s = sandbox('aih-toml-chain-');
  try {
    s.write('config.toml', 'a = 1');
    for (const [id, table] of [['one', 't'], ['two', 'u'], ['three', 'v']]) await install(s, entriesDocument(id, [[[table, 'k'], 1]]));
    for (const id of ['one', 'two']) await remove(s, id);
    assert.equal(s.read('config.toml'), 'a = 1\n[v]\nk = 1\n');
    assert.deepEqual(recordsOf(s), ['created-after-newline']);
    await remove(s, 'three');
    assert.equal(s.read('config.toml'), 'a = 1');
  } finally { s.dispose(); }
});

test('a header a client added after the created table does not receive the record', async () => {
  const s = sandbox('aih-toml-client-heir-');
  try {
    s.write('config.toml', 'a = 1');
    await install(s, entriesDocument('one', [[['t', 'x'], 1]]));
    s.write('config.toml', s.read('config.toml') + '[u]\nz = 1\n');
    await remove(s, 'one');
    assert.equal(s.read('config.toml'), 'a = 1\n[u]\nz = 1\n');
    assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
  } finally { s.dispose(); }
});

test('one reviewed removal of several selections restores the original, in either stored order', async () => {
  const removeBoth = { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [],
    removals: ['one', 'two'].map(managementId => ({ managementId, scope: 'project' })) };
  for (const original of ['a = 1', 'a = 1\r\nb = 2']) {
    for (const reinstall of [false, true]) {
      const s = sandbox('aih-toml-both-');
      try {
        s.write('config.toml', original);
        await install(s, entriesDocument('one', [[['t', 'x'], 1]]));
        await install(s, entriesDocument('two', [[['u', 'y'], 2]]));
        // Reinstalling the first selection after its removal puts its table last, behind the one that now holds the record.
        if (reinstall) { await remove(s, 'one'); await install(s, entriesDocument('one', [[['t', 'x'], 1]])); }
        const prepared = await prepare({ useCase: 'policy', target: { project: s.project }, policy: removeBoth }, { logging: 'off' });
        assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
        assert.equal((await apply(prepared.prepared, authorize(prepared), { logging: 'off' })).completion, 'complete');
        assert.equal(s.read('config.toml'), original, JSON.stringify([original, reinstall]));
        assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
      } finally { s.dispose(); }
    }
  }
});

test('a created table whose key comes first in the recipe still restores the original', async () => {
  for (const original of ['a = 1', 'a = 1\r\n']) {
    const s = sandbox('aih-toml-reversed-');
    try {
      s.write('config.toml', original);
      await install(s, entriesDocument('aih', [[[...aih, 'env', 'TOKEN'], 'x'], [[...aih, 'command'], 'aih']]));
      await remove(s, 'aih');
      assert.equal(s.read('config.toml'), original, JSON.stringify(original));
      assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
    } finally { s.dispose(); }
  }
});

test('a recipe that removes its keys passes the added line break to the table that follows', async () => {
  const s = sandbox('aih-toml-authored-heir-');
  try {
    s.write('config.toml', 'a = 1');
    await install(s, entriesDocument('one', [[['t', 'x'], 1]]));
    await install(s, entriesDocument('two', [[['u', 'y'], 2]]));
    await install(s, removeDocument('one', [['t', 'x']]));
    assert.equal(s.read('config.toml'), 'a = 1\n[u]\ny = 2\n');
    assert.deepEqual(recordsOf(s), ['created-after-newline']);
    await remove(s, 'two');
    assert.equal(s.read('config.toml'), 'a = 1');
    assert.equal(schemaOf(s), 'urn:aihq:core:ownership:1.0.0');
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

test('ownership validation admits tomlTable only on a 1.4.0 root, a TOML entry with a table and a known value', async () => {
  const { validateOwnership, sealOwnership } = await import('../dist/core/internal/state.js');
  const { memberKey } = await import('../dist/core/internal/recipe-lifecycle.js');
  const s = sandbox('aih-toml-own-table-');
  try {
    const target = realpathSync.native(s.project);
    const claims = [{ managementId: 'aih', scope: 'project', sets: [], requires: [] }];
    const owner = (descriptor, extra = {}) => ({ managementId: 'aih', recipeIdentity: `sha256:${'a'.repeat(64)}`, sha256: 'b'.repeat(64), mode: 420, descriptor, claims, ...extra });
    const toml = { path: 'config.toml', kind: 'entry', format: 'toml', entry: ['mcp_servers', 'aih', 'command'] };
    const root = (schema, descriptor, extra) => ({ schema, target, members: { [memberKey(descriptor)]: owner(descriptor, extra) } });
    const v14 = 'urn:aihq:core:ownership:1.4.0';
    for (const value of ['created', 'created-after-newline']) validateOwnership(root(v14, toml, { tomlTable: value }), target);
    validateOwnership(root(v14, toml), target);
    for (const version of ['1.0.0', '1.1.0', '1.2.0', '1.3.0'])
      assert.throws(() => validateOwnership(root(`urn:aihq:core:ownership:${version}`, toml, { tomlTable: 'created' }), target), /ownership-invalid/, version);
    for (const value of ['', 'other', true, null, 1, ['created']])
      assert.throws(() => validateOwnership(root(v14, toml, { tomlTable: value }), target), /ownership-invalid/, String(value));
    const ini = { path: 'settings.ini', kind: 'entry', format: 'ini', entry: ['global', 'cert'] };
    for (const descriptor of [{ ...toml, entry: ['model'] }, { path: 'config.json', kind: 'entry', format: 'json', entry: ['a', 'b'] }, ini])
      assert.throws(() => validateOwnership(root(v14, descriptor, { tomlTable: 'created' }), target), /ownership-invalid/, descriptor.path);
    // The seal picks 1.4.0 over the 1.3.0, 1.2.0 and 1.1.0 rules and returns once no owner records a table.
    const quoted = { ...toml, entry: ['mcp_servers', 'name.with.dots', 'command'] };
    const mixed = { schema: 'urn:aihq:core:ownership:1.0.0', target, members: { [memberKey(toml)]: owner(toml, { tomlTable: 'created' }),
      [memberKey(quoted)]: owner(quoted), [memberKey(ini)]: owner(ini) } };
    assert.equal(sealOwnership(mixed).schema, v14);
    validateOwnership(sealOwnership(mixed), target);
    delete mixed.members[memberKey(toml)];
    assert.equal(sealOwnership(mixed).schema, 'urn:aihq:core:ownership:1.3.0');
  } finally { s.dispose(); }
});
