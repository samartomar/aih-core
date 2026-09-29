import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderConfigEntries, renderTextBlock } from '../dist/internal/recipe-editors.js';

test('JSONC edits nested object keys while retaining unrelated comments and formatting', () => {
  const before = Buffer.from('{\n  // keep this note\n  "other": 1,\n  "nested": { "old": true }\n}\n');
  const after = renderConfigEntries('jsonc', before, [
    { path: ['nested', 'old'], action: 'set', value: false },
    { path: ['nested', 'new'], action: 'set', value: ['a', 'b'] }
  ]).toString();
  assert.match(after, /\/\/ keep this note/);
  assert.match(after, /"other": 1/);
  assert.match(after, /"old": false/);
  assert.match(after, /"new": \[/);
  assert.deepEqual(JSON.parse(after.replace(/\/\/ keep this note/, '')), { other: 1, nested: { old: false, new: ['a', 'b'] } });
  assert.throws(() => renderConfigEntries('json', before, [{ path: ['other'], action: 'set', value: 2 }]), /unsupported-json-syntax/);
});

test('JSON/JSONC refuse duplicate keys, array traversal and overlapping edit paths', () => {
  assert.throws(() => renderConfigEntries('json', Buffer.from('{"x":1,"x":2}'),
    [{ path: ['x'], action: 'set', value: 3 }]), /duplicate-json-key/);
  assert.throws(() => renderConfigEntries('json', Buffer.from('{"items":[1]}'),
    [{ path: ['items', '0'], action: 'set', value: 3 }]), /unsupported-json-path/);
  assert.throws(() => renderConfigEntries('json', Buffer.from('{}'), [
    { path: ['x'], action: 'set', value: 1 }, { path: ['x', 'y'], action: 'set', value: 2 }
  ]), /overlapping-entry-paths/);
});

test('TOML changes one scalar while preserving comments and rejects ambiguous structures', () => {
  const before = Buffer.from('# preface\r\n[client]\r\nother = "unchanged" # note\r\nmode = "old" # retain\r\n');
  const after = renderConfigEntries('toml', before, [{ path: ['client', 'mode'], action: 'set', value: 'new' }]).toString();
  assert.equal(after, '# preface\r\n[client]\r\nother = "unchanged" # note\r\nmode = "new" # retain\r\n');
  const added = renderConfigEntries('toml', before, [{ path: ['client', 'enabled'], action: 'set', value: true }]).toString();
  assert.match(added, /enabled = true\r\n/);
  assert.throws(() => renderConfigEntries('toml', Buffer.from('[[client]]\nmode = "x"\n'),
    [{ path: ['client', 'mode'], action: 'set', value: 'y' }]), /unsupported-toml-array-table/);
  assert.throws(() => renderConfigEntries('toml', Buffer.from('client.mode = "x"\n'),
    [{ path: ['client', 'mode'], action: 'set', value: 'y' }]), /unsupported-toml-syntax/);
});

test('TOML refuses a scalar key colliding with an existing table or implicit parent', () => {
  assert.throws(() => renderConfigEntries('toml', Buffer.from('[a]\nvalue = 1\n'),
    [{ path: ['a'], action: 'set', value: 'scalar' }]), /unsupported-toml-path/);
  assert.throws(() => renderConfigEntries('toml', Buffer.from('[a.b]\nvalue = 1\n'),
    [{ path: ['a'], action: 'set', value: 'scalar' }]), /unsupported-toml-path/);
  assert.throws(() => renderConfigEntries('toml', Buffer.from('[a]\n[a.b]\nvalue = 1\n'),
    [{ path: ['a', 'b'], action: 'set', value: 'scalar' }]), /unsupported-toml-path/);
  assert.throws(() => renderConfigEntries('toml', Buffer.from('a = "scalar"\n[a]\nvalue = 1\n'),
    [{ path: ['a', 'value'], action: 'set', value: 2 }]), /unsupported-toml-path/);
});

test('text block preserves unrelated bytes and rejects duplicate or malformed markers', () => {
  const edit = { blockId: 'guidance', startMarker: '<!-- START guidance -->',
    endMarker: '<!-- END guidance -->', action: 'set', content: 'new text\n' };
  const initial = renderTextBlock(Buffer.from('user text\n'), edit);
  assert.equal(initial.toString(), 'user text\n<!-- START guidance -->\nnew text\n<!-- END guidance -->\n');
  const changed = renderTextBlock(initial, { ...edit, content: 'replacement\n' });
  assert.equal(changed.toString(), 'user text\n<!-- START guidance -->\nreplacement\n<!-- END guidance -->\n');
  const removed = renderTextBlock(changed, { ...edit, action: 'remove', content: undefined });
  assert.equal(removed.toString(), 'user text\n');
  assert.throws(() => renderTextBlock(Buffer.from(initial.toString() + initial.toString()), edit), /ambiguous-text-block/);
  assert.throws(() => renderTextBlock(Buffer.from('prefix <!-- START guidance -->\n'), edit), /ambiguous-text-block/);
});
