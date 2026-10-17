import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderConfigEntries, configMemberBytes } from '../dist/core/internal/recipe-editors.js';

const toml = (text, entries) => renderConfigEntries('toml', Buffer.from(text), entries).toString();
const member = (text, path) => configMemberBytes('toml', Buffer.from(text), path)?.toString() ?? null;
const set = (path, value) => ({ path, action: 'set', value });
const remove = path => ({ path, action: 'remove' });

const codex = [
  '# Codex configuration',
  'model = "gpt-5"  # default model',
  'notify = ["notify-send", "Codex"]',
  '',
  '[projects."/home/u/p"]',
  'trust_level = "trusted"  # reviewed',
  '',
  "[projects.'C:\\work']",
  'trust_level = "untrusted"',
  '',
  '[mcp_servers."name.with.dots"]',
  'command = "npx"',
  'args = ["-y", "@scope/server"]',
  'startup_timeout_sec = 20',
  'tools = [',
  '  "one", # first',
  '  "two",',
  ']',
  'env = { TOKEN = "x", NESTED = { a = [1, 2] } }',
  'note = """',
  '[not.a.table]',
  'still text',
  '"""',
  'since = 2024-05-01',
  '',
  '[tui]',
  'notifications = true # trailing',
  ''
].join('\n');

test('TOML arrays of strings can be set, replaced, read and removed', () => {
  const added = toml('[srv]\ncommand = "x"\n', [set(['srv', 'args'], ['-y', 'pkg'])]);
  assert.equal(added, '[srv]\ncommand = "x"\nargs = ["-y", "pkg"]\n');
  assert.equal(member(added, ['srv', 'args']), '["-y", "pkg"]');
  assert.equal(toml(added, [set(['srv', 'args'], ['-y', 'pkg'])]), added);
  assert.equal(toml(added, [set(['srv', 'args'], [])]), '[srv]\ncommand = "x"\nargs = []\n');
  assert.equal(toml(added, [set(['srv', 'args'], [['a'], 1, true, 'b'])]),
    '[srv]\ncommand = "x"\nargs = [["a"], 1, true, "b"]\n');
  assert.equal(toml(added, [remove(['srv', 'args'])]), '[srv]\ncommand = "x"\n');
  assert.equal(toml('args = ["a"]\n', [set(['args'], ['b'])]), 'args = ["b"]\n');
  assert.equal(toml('', [set(['args'], ['a'])]), 'args = ["a"]\n');
});

test('TOML array member bytes are the raw span, including multi-line text, comments and CRLF', () => {
  const multi = 'tools = [\r\n  "one", # first\r\n  "two",\r\n]  # tail\r\nafter = 1\r\n';
  assert.equal(member(multi, ['tools']), '[\r\n  "one", # first\r\n  "two",\r\n]');
  assert.equal(member(multi, ['after']), '1');
  assert.equal(toml(multi, [set(['tools'], ['x', 'y'])]), 'tools = ["x", "y"]  # tail\r\nafter = 1\r\n');
  assert.equal(toml(multi, [remove(['tools'])]), 'after = 1\r\n');
  assert.equal(toml('a = 1\r\n', [set(['b'], ['x'])]), 'a = 1\r\nb = ["x"]\r\n');
  const same = toml('a = ["x"]\r\n', [set(['a'], ['x'])]);
  assert.equal(same, 'a = ["x"]\r\n');
});

test('TOML Codex-shaped file keeps every unrelated byte', () => {
  assert.equal(toml(codex, [
    set(['mcp_servers', 'aih', 'command'], 'aih'),
    set(['mcp_servers', 'aih', 'args'], ['serve', '--stdio']),
    set(['mcp_servers', 'aih', 'env', 'API_URL'], 'https://api.example')
  ]), codex + '[mcp_servers.aih]\ncommand = "aih"\nargs = ["serve", "--stdio"]\n' +
    '[mcp_servers.aih.env]\nAPI_URL = "https://api.example"\n');
  assert.equal(toml(codex, [set(['projects', '/home/u/p', 'trust_level'], 'untrusted')]),
    codex.replace('trust_level = "trusted"', 'trust_level = "untrusted"'));
  assert.equal(toml(codex, [set(['projects', 'C:\\work', 'trust_level'], 'trusted')]),
    codex.replace('trust_level = "untrusted"', 'trust_level = "trusted"'));
  assert.equal(toml(codex, [set(['mcp_servers', 'name.with.dots', 'command'], 'node')]),
    codex.replace('command = "npx"', 'command = "node"'));
  assert.equal(toml(codex, [set(['mcp_servers', 'name.with.dots', 'args'], ['a'])]),
    codex.replace('["-y", "@scope/server"]', '["a"]'));
  assert.equal(toml(codex, [set(['mcp_servers', 'name.with.dots', 'tools'], ['x', 'y'])]),
    codex.replace('[\n  "one", # first\n  "two",\n]', '["x", "y"]'));
  assert.equal(toml(codex, [remove(['mcp_servers', 'name.with.dots', 'tools'])]),
    codex.replace('tools = [\n  "one", # first\n  "two",\n]\n', ''));
  assert.equal(toml(codex, [set(['mcp_servers', 'name.with.dots', 'timeout'], 5)]),
    codex.replace('[tui]', 'timeout = 5\n[tui]'));
  assert.equal(toml(codex, [set(['mcp_servers', 'my.server', 'command'], 'x')]),
    codex + '[mcp_servers."my.server"]\ncommand = "x"\n');
  assert.equal(toml(codex, [set(['tui', 'notifications'], false)]),
    codex.replace('notifications = true', 'notifications = false'));
  assert.equal(toml(codex, [set(['approval'], 'never')]),
    codex.replace('[projects."/home/u/p"]', 'approval = "never"\n[projects."/home/u/p"]'));
  assert.equal(member(codex, ['projects', '/home/u/p', 'trust_level']), '"trusted"');
  assert.equal(member(codex, ['notify']), '["notify-send", "Codex"]');
  assert.equal(member(codex, ['mcp_servers', 'name.with.dots', 'command']), '"npx"');
  assert.equal(member(codex, ['mcp_servers', 'name.with.dots', 'tools']), '[\n  "one", # first\n  "two",\n]');
  assert.equal(member(codex, ['mcp_servers', 'missing', 'command']), null);
});

test('TOML quoted table headers accept literal strings, escapes and whitespace', () => {
  assert.equal(member('[ a . "b" ]\nc = 1\n', ['a', 'b', 'c']), '1');
  assert.equal(member("['a b'.\"c\\td\"]\ne = 1\n", ['a b', 'c\td', 'e']), '1');
  assert.equal(member('["\\u0061\\U00000062"]\nx = 1\n', ['ab', 'x']), '1');
  assert.equal(member('"quoted key" = 4\n', ['quoted key']), '4');
  assert.equal(toml('[ a . "b" ]\nc = 1\n', [set(['a', 'b', 'c'], 2)]), '[ a . "b" ]\nc = 2\n');
  assert.equal(toml('', [set(['a b', 'c"d\\', 'e'], 1)]), '["a b"."c\\"d\\\\"]\ne = 1\n');
  assert.equal(toml('x = 1', [set(['k', 'v'], 1)]), 'x = 1\n[k]\nv = 1\n');
  assert.equal(member('\uFEFF[a]\nb = 1\n', ['a', 'b']), '1');
});

test('TOML identity is the segment list, never a dotted join', () => {
  const text = '["a.b"]\nc = 1\n';
  assert.equal(member(text, ['a.b', 'c']), '1');
  assert.equal(member(text, ['a', 'b', 'c']), null);
  assert.equal(toml(text, [set(['a', 'b', 'c'], 2)]), '["a.b"]\nc = 1\n[a.b]\nc = 2\n');
  assert.equal(toml(text, [remove(['a', 'b', 'c'])]), text);
});

test('TOML refusals stay stable', () => {
  const fails = (text, entries, pattern) =>
    assert.throws(() => renderConfigEntries('toml', Buffer.from(text), entries), pattern);
  const probe = [set(['z'], 1)];
  fails('[[x]]\na = 1\n', probe, /unsupported-toml-array-table/);
  fails('a.b = 1\n', probe, /unsupported-toml-syntax/);
  fails('a = 1 2\n', probe, /unsupported-toml-syntax/);
  fails('a =\n', probe, /unsupported-toml-syntax/);
  fails('a = [1,, 2]\n', probe, /unsupported-toml-syntax/);
  fails('a = [1\n', probe, /unsupported-toml-syntax/);
  fails('a = { b = 1\n', probe, /unsupported-toml-syntax/);
  fails('a = "unterminated\n', probe, /unsupported-toml-syntax/);
  fails('a = """open\n', probe, /unsupported-toml-syntax/);
  fails('a = bare\n', probe, /unsupported-toml-syntax/);
  fails(`a = ${'['.repeat(80)}${']'.repeat(80)}\n`, probe, /unsupported-toml-syntax/);
  fails('[a\nb = 1\n', probe, /unsupported-toml-table/);
  fails('[a.]\n', probe, /unsupported-toml-table/);
  fails('[a] junk\n', probe, /unsupported-toml-table/);
  fails('[a.b]\n[ a . "b" ]\n', probe, /unsupported-toml-table/);
  fails('[a]\n[a]\n', probe, /unsupported-toml-table/);
  fails('a = 1\n"a" = 2\n', probe, /duplicate-toml-key/);
  fails('[t]\n\'k\' = 1\nk = 2\n', probe, /duplicate-toml-key/);
  fails('a = 1\n[a]\n', probe, /unsupported-toml-path/);
  fails('a = 1\n[a.b]\n', probe, /unsupported-toml-path/);
  fails('', [set(['a'], { b: 1 })], /unsupported-toml-value/);
  fails('', [set(['a'], null)], /unsupported-toml-value/);
  fails('', [set(['a'], [null])], /unsupported-toml-value/);
  fails('', [set(['a'], ['ok', { b: 1 }])], /unsupported-toml-value/);
  fails('', [set(['a'], '\ud800')], /unsupported-toml-value/);
  fails('', [set(['a\ud800'], 'x')], /unsupported-toml-path/);
  fails('[a]\nb = 1\n', [set(['a'], 'x')], /unsupported-toml-path/);
  fails('[a.b]\nc = 1\n', [set(['a'], 'x')], /unsupported-toml-path/);
  fails('a = "x"\n', [set(['a', 'b'], 'x')], /unsupported-toml-path/);
});

test('TOML values outside the managed kinds are refused for member, replace and remove', () => {
  const path = ['mcp_servers', 'name.with.dots'];
  for (const key of ['env', 'note', 'since']) {
    assert.throws(() => configMemberBytes('toml', Buffer.from(codex), [...path, key]), /unsupported-toml-value/);
    assert.throws(() => renderConfigEntries('toml', Buffer.from(codex), [set([...path, key], 'x')]),
      /unsupported-toml-value/);
    assert.throws(() => renderConfigEntries('toml', Buffer.from(codex), [remove([...path, key])]),
      /unsupported-toml-value/);
  }
  for (const value of ['0xFF', '0o7', '0b1', 'inf', '-nan', '1979-05-27T07:32:00Z', '07:32:00', "'''x'''", '{ a = 1 }',
    '[1, { a = 1 }]', '[1, """x"""]', '[1, 2024-01-01]', '[0x1]']) {
    assert.throws(() => configMemberBytes('toml', Buffer.from(`a = ${value}\n`), ['a']),
      /unsupported-toml-value/, value);
  }
  assert.throws(() => renderConfigEntries('toml', Buffer.from('a = [1, [2, {}]]\n'), [set(['a'], ['x'])]),
    /unsupported-toml-value/);
  assert.throws(() => renderConfigEntries('toml', Buffer.from(codex),
    [set([...path, 'env', 'TOKEN'], 'y')]), /unsupported-toml-path/);
  assert.equal(member(codex, [...path, 'env', 'TOKEN']), null);
});

test('TOML escapes strings and accepts every value kind in unrelated keys', () => {
  assert.equal(toml('', [set(['s'], 'a"b\\c\x7f\n\u00e9')]), 's = "a\\"b\\\\c\\u007F\\n\u00e9"\n');
  assert.equal(toml('', [set(['n'], 1e21)]), 'n = 1e+21\n');
  const odd = [
    'a = 0xDEAD_beef', 'b = 1979-05-27 07:32:00.5-08:00', 'c = [ ]', 'd = -inf', 'e = """\n# not a comment\n"""',
    "f = '''\n[x]\n''' # tail", "g = { x = 1, y = { z = [1, 2] } }", 'h = [\n  1, # one\n  [2, 3],\n  "four",\n]'
  ].join('\n') + '\n';
  assert.equal(toml(odd, [set(['i'], 1)]), odd + 'i = 1\n');
  assert.equal(member(odd, ['h']), '[\n  1, # one\n  [2, 3],\n  "four",\n]');
  assert.equal(toml('a = """x""""\nb = 1\n', [set(['b'], 2)]), 'a = """x""""\nb = 2\n');
});

test('TOML scalar member bytes equal the previous trimmed value text', () => {
  const cases = [['"x"', '"x"'], ["'x'", "'x'"], ['true', 'true'], ['1_000', '1_000'], ['-1.5e3', '-1.5e3'],
    ['"x" # comment', '"x"'], ['  "x\\"y"   ', '"x\\"y"'], ['\'a#b\'  # c', "'a#b'"], ['"a#b"#c', '"a#b"'], ['0', '0']];
  for (const [raw, expected] of cases)
    assert.equal(member(`k =${raw.startsWith(' ') ? '' : ' '}${raw}\n[t]\nz = 1\n`, ['k']), expected, raw);
  assert.equal(member('k = "x"', ['k']), '"x"');
  assert.equal(configMemberBytes('toml', null, ['k']), null);
});
