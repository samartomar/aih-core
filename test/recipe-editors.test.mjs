import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderConfigEntries, renderConfigMember, renderTextBlock, configMemberBytes } from '../dist/core/internal/recipe-editors.js';

test('INI owns one scalar option, retaining neighboring sections, comments, continuations and CRLF bytes', () => {
  const original = '# keep\r\n[global]\r\ntimeout=15\r\nfind-links=\r\n  https://one.example/\r\n  https://two.example/\r\n[install]\r\nupgrade=true\r\n';
  const set = [{ path: ['global', 'cert'], action: 'set', value: 'C:\\trust\\team.pem' }];
  const after = renderConfigEntries('ini', Buffer.from(original), set);
  assert.equal(after.toString(), original.replace('[global]\r\n', '[global]\r\ncert=C:\\trust\\team.pem\r\n'));
  assert.deepEqual(renderConfigEntries('ini', after, set), after);
  assert.equal(configMemberBytes('ini', after, ['global', 'CERT']).toString(), 'C:\\trust\\team.pem');
  assert.equal(renderConfigEntries('ini', after, [{ path: ['global', 'cert'], action: 'remove' }]).toString(), original);
  assert.equal(renderConfigEntries('ini', Buffer.from('[global]'), set).toString(), '[global]\ncert=C:\\trust\\team.pem\n');
});

test('INI refuses duplicate sections/options, selected continuations and unsafe scalar syntax', () => {
  const set = [{ path: ['global', 'cert'], action: 'set', value: '/trust.pem' }];
  for (const text of ['[global]\n[global]\n', '[global]\ncert=/one\nCERT=/two\n',
    '[global]\ncert=/one\n  /two\n', '[global]\ntimeout=15\n  cert=/other\n', '\uFEFF[global]\n', '[global]\ncert=\0\n'])
    assert.throws(() => renderConfigEntries('ini', Buffer.from(text), set));
  for (const value of ['/one\ncert=/two', ' leading', '', false, 3, ['path']])
    assert.throws(() => renderConfigEntries('ini', null, [{ ...set[0], value }]), /unsupported-ini-value/);
  assert.throws(() => renderConfigEntries('ini', null, [set[0], { ...set[0], path: ['global', 'CERT'] }]), /overlapping-entry-paths/);
});

test('INI preserves indented neighboring options and opaque unrelated subsections', () => {
  const before = '[user]\n  name=Native Acceptance\n[credential "https://example.test"]\n  helper=manager\n[http]\n  proxy=https://proxy.test\n';
  const set = [{ path: ['http', 'sslCAInfo'], action: 'set', value: '"/team.pem"' }];
  const after = renderConfigEntries('ini', Buffer.from(before), set);
  assert.equal(after.toString(), before.replace('[http]\n', '[http]\n  sslCAInfo="/team.pem"\n'));
  assert.equal(renderConfigEntries('ini', after, [{ path: ['http', 'sslCAInfo'], action: 'remove' }]).toString(), before);
});

for (const format of ['yaml', 'properties']) test(`${format} owns a scalar line and preserves neighboring configuration`, () => {
  const original = format === 'yaml' ? '# keep\r\nchannels:\r\n  - defaults\r\n' : '# keep\r\norg.gradle.parallel=false\r\n';
  const path = [format === 'yaml' ? 'ssl_verify' : 'systemProp.javax.net.ssl.trustStore'];
  const after = renderConfigEntries(format, Buffer.from(original), [{ path, action: 'set', value: '/team/store' }]);
  assert.ok(after.toString().startsWith(original));
  assert.deepEqual(renderConfigEntries(format, after, [{ path, action: 'set', value: '/team/store' }]), after);
  assert.equal(renderConfigEntries(format, after, [{ path, action: 'remove' }]).toString(), original);
  assert.ok(configMemberBytes(format, after, path));
});

test('bounded scalar formats refuse duplicates, selected multiline values, aliases and escaped properties', () => {
  const set = (path) => [{ path: [path], action: 'set', value: '/team.pem' }];
  for (const text of ['ssl_verify: /one\nssl_verify: /two\n', 'ssl_verify: |\n  /one\n',
    'ssl_verify: /one\n  /two\n', 'ssl_verify: &ca /one\n', '<<: *defaults\n', '---\nssl_verify: /one\n',
    'ssl_verify: [one, two]\n', '\uFEFFssl_verify: /one\n'])
    assert.throws(() => renderConfigEntries('yaml', Buffer.from(text), set('ssl_verify')));
  for (const text of ['store=/one\nstore=/two\n', 'store=/one\\\n  /two\n', '\\u0073tore=/one\n', 'store: /one\n'])
    assert.throws(() => renderConfigEntries('properties', Buffer.from(text), set('store')));
  for (const format of ['yaml', 'properties']) {
    assert.throws(() => renderConfigEntries(format, null, [{ path: ['a', 'b'], action: 'set', value: 'x' }]));
    assert.throws(() => renderConfigEntries(format, null, [{ path: ['a'], action: 'set', value: 'x\ny' }]));
  }
});

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

test('a JSONC array member is added and removed alone, giving back the earlier bytes with comments kept', () => {
  const original = '{\n  // approved servers\n  "enabledMcpjsonServers": [\n    "mine" // kept\n  ],\n  "theme": "dark"\n}\n';
  const add = { container: ['enabledMcpjsonServers'], action: 'add', value: 'github' };
  const added = renderConfigMember('jsonc', Buffer.from(original), add);
  assert.match(added.toString(), /"mine", "github" \/\/ kept/);
  assert.deepEqual(renderConfigMember('jsonc', added, add), added, 'adding a present member changes nothing');
  assert.equal(renderConfigMember('jsonc', added, { ...add, action: 'remove' }).toString(), original);
  assert.equal(renderConfigMember('json', Buffer.from('{"a":[]}'), { container: ['a'], action: 'add', value: 1 }).toString(), '{"a":[1]}');
  assert.equal(renderConfigMember('json', Buffer.from('{"a":[1]}'), { container: ['a'], action: 'remove', value: 1 }, true).toString(), '{}');
  assert.equal(renderConfigMember('json', Buffer.from('{"a":["x","y"]}'), { container: ['a'], action: 'remove', value: 'x' }).toString(), '{"a":["y"]}');
});

test('a member edit refuses an excluded value, a duplicate member and a container that is not an array', () => {
  const add = { container: ['enabled'], action: 'add', value: 'github', exclusiveWith: [['denied']] };
  for (const [text, reason] of [['{"denied":["github"]}', 'member-excluded'], ['{"enabled":["github","github"]}', 'member-ambiguous'],
    ['{"enabled":{"github":true}}', 'member-container-invalid'], ['{"denied":"github"}', 'member-container-invalid'], ['[]', 'unsupported-json-syntax']])
    assert.throws(() => renderConfigMember('json', Buffer.from(text), add), error => error.reason === reason, text);
  assert.throws(() => renderConfigMember('json', null, { ...add, value: { all: true } }), error => error.reason === 'invalid-member');
});
