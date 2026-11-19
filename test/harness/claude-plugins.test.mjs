import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { observeClaudePlugins } from '@aihq/core/harness/runtime';
import { claudePluginLookupPath, observeClaudePluginsWith, parseClaudePluginReadback } from '../../src/harness/claude-plugins.mjs';
import { symlinked } from './symlink-fixture.mjs';

const response = (id, value) => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response: value } });
const records = plugins => [response('init', {}), response('plugins', { plugins, mcpServers: [], error_count: 0 })];
const encode = value => Buffer.from(value.map(record => JSON.stringify(record)).join('\n') + '\n');
const knownPlugins = [{ name: 'superpowers', source: 'superpowers@superpowers', path: 'C:\\owned\\project\\.aihq\\plugins\\superpowers', version: '6.4.1' },
  { name: 'builtin-plugin', source: 'builtin-plugin@builtin', path: 'builtin' },
  { name: 'superpowers', source: 'superpowers@another-source', path: 'C:\\owned\\other-copy' }];

test('complete readback keeps builtin and unrelated copies distinct without inferring target admission', () => {
  const result = parseClaudePluginReadback(encode(records(knownPlugins)));
  assert.equal(result.status, 'observed');
  assert.deepEqual(result.plugins.map(plugin => [plugin.source, plugin.builtin]),
    [['superpowers@superpowers', false], ['builtin-plugin@builtin', true], ['superpowers@another-source', false]]);
  assert.equal(result.plugins[0].version, '6.4.1');
  assert.deepEqual(parseClaudePluginReadback(encode(records([]))), { status: 'observed', plugins: [] });
});

test('missing, failed, ambiguous and malformed responses never establish absence', () => {
  const cases = [
    [response('init', {})], [response('plugins', { plugins: [], mcpServers: [], error_count: 0 })],
    [...records([]), response('plugins', { plugins: [], mcpServers: [], error_count: 0 })],
    [response('init', {}), response('other-id', { plugins: [], mcpServers: [], error_count: 0 })],
    [response('init', {}), { type: 'control_response', response: { subtype: 'error', request_id: 'plugins', error: 'failed' } }],
    [response('init', {}), response('plugins', { plugins: knownPlugins, mcpServers: [], error_count: 1 })],
    [response('init', { error_count: 1 }), response('plugins', { plugins: [], mcpServers: [], error_count: 0 })],
    [response('init', {}), response('plugins', { plugins: [], error_count: 0 })],
    [response('init', {}), response('plugins', { plugins: [], mcpServers: [{ name: 'not-contained' }], error_count: 0 })],
    records([{ name: 'bad', path: 'relative/plugin', source: 'bad@market' }]),
    records([{ name: 'bad', path: 'builtin', source: 'bad@market' }]),
    records([...knownPlugins, knownPlugins[0]]), records(Array.from({ length: 257 }, () => knownPlugins[0])),
    [...records([]), { type: 'assistant', message: { content: [] } }],
    [...records([]), { type: 'system', subtype: 'error', message: 'failed' }],
    [...records([]), { type: 'system', mcp_servers: [{ name: 'not-contained' }] }]
  ];
  for (const value of cases) {
    const result = parseClaudePluginReadback(encode(value));
    assert.equal(result.status, 'unconfirmed', JSON.stringify(value));
    assert.deepEqual(result.plugins, []);
  }
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff]), Buffer.from('{"type":"system","type":"control_response"}\n')])
    assert.equal(parseClaudePluginReadback(bytes).status, 'unconfirmed');
  assert.equal(parseClaudePluginReadback(Buffer.alloc(1_048_577)).reason, 'output-limit');
});

function fixture(t, options = {}) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'aih-plugin-observation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), home = join(root, 'home'), binary = join(root, 'trusted', 'claude.exe');
  for (const directory of [project, home, join(root, 'trusted')]) mkdirSync(directory);
  writeFileSync(binary, 'test executable pin');
  const calls = { start: [], cleanup: [], inputs: [] };
  const host = {
    platform: 'win32', personalHome: () => join(root, 'personal'), managed: () => ({ outcome: 'file-sources-clear' }),
    pin: async () => ({ status: 'pinned', path: binary, sha256: 'a'.repeat(64), byteLength: 19 }),
    revalidate: async () => ({ ok: true }),
    start: async input => {
      calls.start.push(input);
      const stdout = new PassThrough(), stderr = new PassThrough();
      let resolveExit;
      const exited = new Promise(resolve => { resolveExit = resolve; });
      const stdin = new Writable({ write(chunk, encoding, done) { calls.inputs.push(chunk.toString()); done(); }, final(done) {
        if (!options.hang) {
          stdout.end(options.output ?? encode(records(knownPlugins))); stderr.end(options.stderr ?? '');
          resolveExit({ code: options.code ?? 0 });
        }
        done();
      } });
      return { status: 'started', handle: { stdin, stdout, stderr, exited, terminate: async input => {
        calls.cleanup.push(input); stdout.end(); stderr.end(); resolveExit({ code: null });
        return { processes: options.cleanup ?? 'confirmed', survivors: [] };
      } } };
    }
  };
  return { root, project, home, binary, host, calls, request: { project, home } };
}

test('fixed prompt-free invocation preserves the supplied workspace plugin cache and excludes ambient credentials', async t => {
  const f = fixture(t);
  mkdirSync(join(f.home, '.claude'));
  writeFileSync(join(f.home, '.claude', 'registered-plugin-marker'), 'keep existing workspace registration');
  const observed = await observeClaudePluginsWith(f.request, f.host);
  assert.equal(observed.status, 'observed');
  assert.equal(observed.plugins[0].source, 'superpowers@superpowers');
  assert.equal(readFileSync(join(f.home, '.claude', 'registered-plugin-marker'), 'utf8'), 'keep existing workspace registration');
  assert.equal(f.calls.start.length, 1);
  const spec = f.calls.start[0];
  assert.deepEqual(spec.argv, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--no-session-persistence', '--bare', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config',
    '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}']);
  assert.equal(spec.file, f.binary); assert.equal(spec.cwd, f.project);
  assert.equal(spec.env.CLAUDE_CONFIG_DIR, join(f.home, '.claude'));
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert.equal(spec.env[key], undefined);
  const input = f.calls.inputs.join('').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(input.map(message => [message.type, message.request_id, message.request.subtype]),
    [['control_request', 'init', 'initialize'], ['control_request', 'plugins', 'reload_plugins']]);
  assert.equal(f.calls.cleanup.length, 1); assert.equal(observed.modelTurnRequested, false);
});

test('request refusals and unsafe lookup cannot execute caller-selected binaries', async t => {
  const f = fixture(t);
  const getter = { get project() { throw Error('getter must not run'); }, home: f.home };
  for (const input of [null, {}, { ...f.request, executable: f.binary }, getter, new Proxy(f.request, {}),
    { ...f.request, home: f.project }, { ...f.request, home: join(f.project, 'nested') }]) {
    assert.equal((await observeClaudePluginsWith(input, f.host)).status, 'unconfirmed');
  }
  assert.equal(f.calls.start.length, 0);
  assert.equal((await observeClaudePluginsWith(f.request, { ...f.host, personalHome: () => f.home })).reason, 'home-not-isolated');
  mkdirSync(join(f.home, '.claude')); writeFileSync(join(f.home, '.claude', '.credentials.json'), '{}');
  assert.equal((await observeClaudePluginsWith(f.request, f.host)).reason, 'home-has-credentials');
  const trusted = join(f.root, 'trusted');
  assert.equal(claudePluginLookupPath(['.', f.project, f.home, trusted].join(delimiter), f.project, f.home), trusted);
  assert.equal((await observeClaudePlugins({ project: 'relative', home: f.home })).reason, 'input-invalid');
});

test('unsupported containment, machine policy and changed executables return unconfirmed', async t => {
  const f = fixture(t);
  for (const [overrides, reason] of [
    [{ platform: 'linux' }, 'platform-unsupported'], [{ managed: () => ({ outcome: 'restricted' }) }, 'managed-settings-unconfirmed'],
    [{ pin: async () => ({ status: 'unavailable' }) }, 'client-unavailable'],
    [{ pin: async () => ({ status: 'pinned', path: join(f.project, 'claude.exe') }) }, 'executable-unsafe'],
    [{ revalidate: async () => ({ ok: false }) }, 'executable-changed'],
    [{ start: async () => ({ status: 'unavailable', reason: 'facility-absent' }) }, 'containment-unavailable']
  ]) assert.equal((await observeClaudePluginsWith(f.request, { ...f.host, ...overrides })).reason, reason);
  assert.equal(f.calls.start.length, 0);
});

test('workspace cache, bookkeeping and project settings cannot follow links outside the cell', async t => {
  for (const target of ['plugins', 'plugins/cache/linked-marketplace']) await t.test(target + ' junction', async sub => {
    const f = fixture(sub), outside = join(f.root, 'outside-cache'), link = join(f.home, '.claude', ...target.split('/'));
    mkdirSync(outside); mkdirSync(join(link, '..'), { recursive: true });
    if (!symlinked(outside, link, sub, process.platform === 'win32' ? 'junction' : 'dir')) return;
    assert.equal((await observeClaudePluginsWith(f.request, f.host)).reason, 'path-unsafe');
    assert.equal(f.calls.start.length, 0);
  });
  for (const target of ['home/.claude.json', 'home/.claude/.claude.json', 'project/.claude/settings.json']) await t.test(target + ' file link', async sub => {
    const f = fixture(sub), outside = join(f.root, 'outside-state.json'), link = join(f.root, ...target.split('/'));
    writeFileSync(outside, '{}'); mkdirSync(join(link, '..'), { recursive: true });
    linkSync(outside, link);
    assert.equal((await observeClaudePluginsWith(f.request, f.host)).reason, 'path-unsafe');
    assert.equal(f.calls.start.length, 0); assert.equal(readFileSync(outside, 'utf8'), '{}');
  });
  await t.test('linked project settings directory', async sub => {
    const f = fixture(sub), outside = join(f.root, 'outside-settings');mkdirSync(outside);
    if (!symlinked(outside, join(f.project, '.claude'), sub, process.platform === 'win32' ? 'junction' : 'dir')) return;
    assert.equal((await observeClaudePluginsWith(f.request, f.host)).reason, 'path-unsafe');assert.equal(f.calls.start.length, 0);
  });
});

test('named local plugin inputs stay in the cell, while harmless settings and remote declarations remain readable', async t => {
  const outside = fixture(t), external = join(outside.root, 'external-plugin');mkdirSync(external);
  mkdirSync(join(outside.home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(outside.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { x: [{ installPath: external }] } }));
  assert.equal((await observeClaudePluginsWith(outside.request, outside.host)).reason, 'client-state-outside-workspace');
  assert.equal(outside.calls.start.length, 0);
  const benign = fixture(t);mkdirSync(join(benign.project, '.claude'));
  writeFileSync(join(benign.project, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', model: 'inherited-choice',
    permissions: { defaultMode: 'default' }, hooks: { SessionStart: [] }, extraKnownMarketplaces: { upstream: { source: { source: 'github', repo: 'example/plugins' } } } }));
  assert.equal((await observeClaudePluginsWith(benign.request, benign.host)).status, 'observed');
  const oversized = fixture(t);mkdirSync(join(oversized.project, '.claude'));
  writeFileSync(join(oversized.project, '.claude', 'settings.json'), Buffer.alloc(1_048_577));
  assert.equal((await observeClaudePluginsWith(oversized.request, oversized.host)).reason, 'client-state-limit');
  assert.equal(oversized.calls.start.length, 0);
});

test('nonzero exit, excessive output and unconfirmed cleanup cannot produce observations', async t => {
  for (const [options, reason] of [[{ code: 1 }, 'client-failed'], [{ output: Buffer.alloc(1_048_577) }, 'output-limit'],
    [{ stderr: Buffer.alloc(1_048_577) }, 'output-limit'], [{ cleanup: 'unresolved' }, 'cleanup-unconfirmed']]) {
    const f = fixture(t, options);
    const result = await observeClaudePluginsWith(f.request, f.host);
    assert.equal(result.status, 'unconfirmed'); assert.equal(result.reason, reason);
    assert.deepEqual(result.plugins, []); assert.equal(f.calls.cleanup.length, 1);
  }
});

test('deadline closes the owned process tree without waiting indefinitely for protocol output', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { hang: true });
  const observed = observeClaudePluginsWith(f.request, f.host);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(20_001);
  assert.equal((await observed).reason, 'deadline'); assert.equal(f.calls.cleanup.length, 1);
});
