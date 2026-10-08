// Behavioral tests for the bounded Claude Code managed-policy observer used by the
// native Linux/WSL2 sandbox cells. Every fixture is an isolated temporary
// directory; the helper itself performs no execution, writes or network use.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { observeLinuxManagedPolicy } from '../../src/harness/native/managed-policy.mjs';
import { observeClaudeManagedSettings } from '../../src/harness/native/claude.mjs';

// Expected limitation tokens are written as independent literals, not imported
// from the module under test, so a token change is caught rather than tautological.
const REGISTRY_UNOBSERVED = 'registry-mdm-and-server-managed-sources-unobserved';
const WINDOWS_NOT_OBSERVED = 'windows-host-file-sources-not-observed';
const WINDOWS_SOURCE_UNKNOWN = 'windows-host-file-source-unknown';
const EXECUTION_UNKNOWN = 'execution-unknown';

const withRoot = body => {
  // macOS exposes its temporary root through /var -> /private/var. Fixtures must
  // start at the real root so tests introduce only the symlinks under test.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aihq-managed-policy-')));
  try { return body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const write = (file, value) => writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));

// Create one host policy source directory. `settings`, `mcp` and each drop-in are
// written only when supplied, so absence can be tested explicitly.
const source = (directory, { settings, mcp, dropIn } = {}) => {
  mkdirSync(directory, { recursive: true });
  if (settings !== undefined) write(join(directory, 'managed-settings.json'), settings);
  if (mcp !== undefined) write(join(directory, 'managed-mcp.json'), mcp);
  if (dropIn !== undefined) {
    mkdirSync(join(directory, 'managed-settings.d'), { recursive: true });
    for (const [name, value] of Object.entries(dropIn)) write(join(directory, 'managed-settings.d', name), value);
  }
  return directory;
};

const observeNative = linuxDirectory => observeLinuxManagedPolicy({ execution: 'native', linuxDirectory });
const observeWsl = (linuxDirectory, windows = {}) =>
  observeLinuxManagedPolicy({ execution: 'wsl2', linuxDirectory, ...windows });

test('native observes Linux only: an empty trusted directory is clear, never proof of no restriction', () =>
  withRoot(root => {
    const linux = source(join(root, 'linux'));
    const result = observeLinuxManagedPolicy({
      execution: 'native', linuxDirectory: linux,
      // Even a Windows path that would be restricted must be irrelevant to a native Linux cell.
      windowsDirectory: source(join(root, 'windows'), { settings: { allowManagedMcpServersOnly: true } }),
      windowsSourceKnown: true
    });
    assert.equal(result.outcome, 'file-sources-clear');
    assert.deepEqual(Object.keys(result).sort(), ['limitations', 'outcome']);
    assert.deepEqual(result.limitations, [REGISTRY_UNOBSERVED, WINDOWS_NOT_OBSERVED]);
  }));

test('known restricting managed-setting fields are restricted', () =>
  withRoot(root => {
    const fields = {
      otelHeadersHelper: '/usr/bin/helper',
      allowManagedMcpServersOnly: true,
      allowedMcpServers: ['time'],
      deniedMcpServers: ['shell'],
      managedMcpServers: [{ name: 'x' }],
      permissions: { deny: ['Bash'] },
      sandbox: { enabled: true },
      disableBypassPermissionsMode: 'disable',
      allowManagedHooksOnly: true,
      hooks: { PreToolUse: [] },
      plugins: { enabled: [] },
      enabledPlugins: ['x'],
      allowedPlugins: ['x'],
      deniedPlugins: ['x']
    };
    for (const [key, value] of Object.entries(fields)) {
      const linux = source(join(root, key), { settings: { [key]: value } });
      assert.equal(observeNative(linux).outcome, 'restricted', key);
    }
  }));

test('telemetry environment keys are restricted', () =>
  withRoot(root => {
    for (const key of ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'CLAUDE_CODE_ENABLE_TELEMETRY',
      'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA', 'DISABLE_TELEMETRY']) {
      const linux = source(join(root, key), { settings: { env: { [key]: '1' } } });
      assert.equal(observeNative(linux).outcome, 'restricted', key);
    }
  }));

test('non-restricting settings and empty drop-in directories are clear', () =>
  withRoot(root => {
    assert.equal(observeNative(source(join(root, 'theme'), { settings: { theme: 'dark' } })).outcome, 'file-sources-clear');
    assert.equal(observeNative(source(join(root, 'empty-dropin'), { dropIn: {} })).outcome, 'file-sources-clear');
    assert.equal(observeNative(source(join(root, 'empty-env'), { settings: { env: {} } })).outcome, 'file-sources-clear');
  }));

test('managed-settings.d json drop-ins are observed and non-json entries are ignored', () =>
  withRoot(root => {
    const clear = source(join(root, 'clear'), { dropIn: { 'a.json': { theme: 'dark' }, 'README.txt': 'ignore' } });
    assert.equal(observeNative(clear).outcome, 'file-sources-clear');
    const restricted = source(join(root, 'restricted'), { dropIn: { 'a.json': { deniedMcpServers: ['x'] } } });
    assert.equal(observeNative(restricted).outcome, 'restricted');
  }));

test('a valid managed-mcp.json restricts while malformed content is unreadable', () =>
  withRoot(root => {
    assert.equal(observeNative(source(join(root, 'present'), { mcp: {} })).outcome, 'restricted');
    assert.equal(observeNative(source(join(root, 'malformed'), { mcp: '{not json' })).outcome, 'unreadable');
  }));

test('wsl2 observes both Linux and Windows file sources', () =>
  withRoot(root => {
    const emptyLinux = source(join(root, 'linux'));
    const emptyWindows = source(join(root, 'windows'));
    const clear = observeWsl(emptyLinux, { windowsDirectory: emptyWindows, windowsSourceKnown: true });
    assert.equal(clear.outcome, 'file-sources-clear');
    assert.deepEqual(clear.limitations, [REGISTRY_UNOBSERVED]);

    const restrictedLinux = source(join(root, 'linux-restricted'), { settings: { allowManagedMcpServersOnly: true } });
    assert.equal(observeWsl(restrictedLinux, { windowsDirectory: emptyWindows, windowsSourceKnown: true }).outcome, 'restricted');

    const restrictedWindows = source(join(root, 'windows-restricted'), { settings: { sandbox: { enabled: true } } });
    assert.equal(observeWsl(emptyLinux, { windowsDirectory: restrictedWindows, windowsSourceKnown: true }).outcome, 'restricted');
  }));

test('wsl2 without a known explicit absolute Windows source is unreadable', () =>
  withRoot(root => {
    const linux = source(join(root, 'linux'));
    const windows = source(join(root, 'windows'));
    const unknownSources = [
      {},
      { windowsDirectory: windows },
      { windowsSourceKnown: true },
      { windowsDirectory: 'relative/windows', windowsSourceKnown: true },
      { windowsDirectory: windows, windowsSourceKnown: false }
    ];
    for (const windowsOptions of unknownSources) {
      const result = observeWsl(linux, windowsOptions);
      assert.equal(result.outcome, 'unreadable', JSON.stringify(windowsOptions));
      assert.ok(result.limitations.includes(WINDOWS_SOURCE_UNKNOWN), JSON.stringify(windowsOptions));
    }
  }));

test('an absent policy directory is clear only when its parent is known readable', () =>
  withRoot(root => {
    const linux = source(join(root, 'linux'));
    const mount = join(root, 'mount');
    mkdirSync(mount, { recursive: true });
    const underKnownParent = observeWsl(linux, { windowsDirectory: join(mount, 'ClaudeCode'), windowsSourceKnown: true });
    assert.equal(underKnownParent.outcome, 'file-sources-clear');

    const underMissingParent = observeWsl(linux, { windowsDirectory: join(root, 'missing-mount', 'ClaudeCode'), windowsSourceKnown: true });
    assert.equal(underMissingParent.outcome, 'unreadable');

    assert.equal(observeNative(join(mount, 'claude-code')).outcome, 'file-sources-clear');
    assert.equal(observeNative(join(root, 'missing-etc', 'claude-code')).outcome, 'unreadable');
  }));

test('malformed, duplicate-key, oversized and non-UTF-8 settings are unreadable', () =>
  withRoot(root => {
    assert.equal(observeNative(source(join(root, 'malformed'), { settings: '{not json' })).outcome, 'unreadable');
    assert.equal(observeNative(source(join(root, 'duplicate'), { settings: '{"theme":"dark","theme":"light"}' })).outcome, 'unreadable');
    assert.equal(observeNative(source(join(root, 'oversized'), { settings: { pad: 'x'.repeat(70000) } })).outcome, 'unreadable');
    assert.equal(observeNative(source(join(root, 'non-record'), { settings: '[]' })).outcome, 'unreadable');
    assert.equal(observeNative(source(join(root, 'ambiguous-env'), { settings: { env: 'nope' } })).outcome, 'unreadable');
    const invalidUtf8 = source(join(root, 'invalid-utf8'));
    writeFileSync(join(invalidUtf8, 'managed-settings.json'), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    assert.equal(observeNative(invalidUtf8).outcome, 'unreadable');
  }));

test('a policy path that is a directory, a plain file or another special file is unreadable', () =>
  withRoot(root => {
    const settingsDirectory = source(join(root, 'settings-directory'));
    mkdirSync(join(settingsDirectory, 'managed-settings.json'));
    assert.equal(observeNative(settingsDirectory).outcome, 'unreadable');

    const dropInIsFile = source(join(root, 'dropin-is-file'));
    writeFileSync(join(dropInIsFile, 'managed-settings.d'), '{}');
    assert.equal(observeNative(dropInIsFile).outcome, 'unreadable');

    const sourceIsFile = join(root, 'source-is-file');
    writeFileSync(sourceIsFile, '{}');
    assert.equal(observeNative(sourceIsFile).outcome, 'unreadable');
  }));

test('a managed-settings.d with more entries than the bound is unreadable', () =>
  withRoot(root => {
    const directory = source(join(root, 'flooded'));
    const dropIn = join(directory, 'managed-settings.d');
    mkdirSync(dropIn);
    for (let index = 0; index < 129; index += 1) writeFileSync(join(dropIn, `${index}.json`), '{}');
    assert.equal(observeNative(directory).outcome, 'unreadable');
  }));

test('a symlinked policy file is not followed', t =>
  withRoot(root => {
    const target = source(join(root, 'target'), { settings: { theme: 'dark' } });
    const directory = source(join(root, 'linked-file'));
    try {
      symlinkSync(join(target, 'managed-settings.json'), join(directory, 'managed-settings.json'), 'file');
    } catch (error) {
      t.skip(`file symlink unavailable: ${error.code}`);
      return;
    }
    assert.equal(observeNative(directory).outcome, 'unreadable');
  }));

test('a symlinked managed-settings.d directory is not followed', t =>
  withRoot(root => {
    const target = source(join(root, 'target-dir'), { dropIn: { 'a.json': { theme: 'dark' } } });
    const directory = source(join(root, 'linked-dir'));
    try {
      symlinkSync(join(target, 'managed-settings.d'), join(directory, 'managed-settings.d'),
        process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`directory symlink unavailable: ${error.code}`);
      return;
    }
    assert.equal(observeNative(directory).outcome, 'unreadable');
  }));

test('a known restriction survives an unreadable file or unknown Windows source', () =>
  withRoot(root => {
    const mixed = source(join(root, 'mixed'), { settings: { deniedMcpServers: ['x'] }, dropIn: { 'z.json': '{bad' } });
    assert.equal(observeNative(mixed).outcome, 'restricted');

    const restrictedLinux = source(join(root, 'linux'), { settings: { allowManagedMcpServersOnly: true } });
    assert.equal(observeWsl(restrictedLinux, {}).outcome, 'restricted');
    assert.ok(observeWsl(restrictedLinux, {}).limitations.includes(WINDOWS_SOURCE_UNKNOWN));
  }));

test('the result retains no raw policy content', () =>
  withRoot(root => {
    const marker = 'RAW-POLICY-CONTENT-MARKER-9c1f';
    const linux = source(join(root, 'linux'), { settings: { theme: 'dark', deniedMcpServers: [marker] } });
    const result = observeNative(linux);
    assert.equal(result.outcome, 'restricted');
    assert.deepEqual(Object.keys(result).sort(), ['limitations', 'outcome']);
    assert.equal(JSON.stringify(result).includes(marker), false);
  }));

test('an unknown execution mode or non-absolute Linux directory fails closed', () =>
  withRoot(root => {
    const linux = source(join(root, 'linux'));
    const unknownExecution = observeLinuxManagedPolicy({ execution: 'posix', linuxDirectory: linux });
    assert.equal(unknownExecution.outcome, 'unreadable');
    assert.ok(unknownExecution.limitations.includes(EXECUTION_UNKNOWN));

    const relativeLinux = observeLinuxManagedPolicy({ execution: 'native', linuxDirectory: 'relative/etc' });
    assert.equal(relativeLinux.outcome, 'unreadable');
  }));

// --- Unknown managed keys and environment variables must not read as clear ---

test('unknown managed-setting keys and non-telemetry env keys are unreadable', () =>
  withRoot(root => {
    const unknown = {
      'unknown-boolean': { someUnknownManagedKey: true },
      'unknown-scalar': { preferredNotebookEditor: 'vim' },
      'unknown-nested': { statusLine: { type: 'command', command: '/bin/sh' } },
      'proxy-env': { env: { HTTPS_PROXY: 'http://proxy.example' } },
      'path-env': { env: { PATH: '/usr/bin' } },
      'mixed-env': { env: { SAFE_LOOKING: '1' } }
    };
    for (const [name, settings] of Object.entries(unknown)) {
      assert.equal(observeNative(source(join(root, `unknown-${name}`), { settings })).outcome, 'unreadable', name);
    }
    // Empty settings and an empty env map stay clear; only genuinely unknown content fails closed.
    assert.equal(observeNative(source(join(root, 'empty-document'), { settings: {} })).outcome, 'file-sources-clear');
    assert.equal(observeNative(source(join(root, 'empty-env-map'), { settings: { env: {} } })).outcome, 'file-sources-clear');
  }));

test('managed model or effort choices are preserved as restrictions, with only display preferences clear', () =>
  withRoot(root => {
    const restricted = {
      'model-alias': { model: 'sonnet' },
      'model-id': { model: 'claude-sonnet-4-5-20250929' },
      'effort': { effortLevel: 'high' },
      'combined': { model: 'opus', effortLevel: 'low', theme: 'dark' },
      'model-number': { model: 42 },
      'model-empty': { model: '' },
      'model-path': { model: '/usr/bin/helper' },
      'model-newline': { model: 'sonnet\nrm -rf /' },
      'effort-uppercase': { effortLevel: 'HIGH' }
    };
    for (const [name, settings] of Object.entries(restricted)) {
      assert.equal(observeNative(source(join(root, `restricted-${name}`), { settings })).outcome, 'restricted', name);
    }
    assert.equal(observeNative(source(join(root, 'theme'), { settings: { theme: 'dark-daltonized' } })).outcome, 'file-sources-clear');
    const rejected = {
      'theme-injection': { theme: 'dark; rm -rf /' },
      'theme-number': { theme: 1 }
    };
    for (const [name, settings] of Object.entries(rejected)) {
      assert.equal(observeNative(source(join(root, `rejected-${name}`), { settings })).outcome, 'unreadable', name);
    }
  }));

test('a known restriction wins over an unknown or unreadable sibling', () =>
  withRoot(root => {
    assert.equal(observeNative(source(join(root, 'unknown-sibling'),
      { settings: { deniedMcpServers: ['x'], someUnknownManagedKey: true } })).outcome, 'restricted');
    assert.equal(observeNative(source(join(root, 'env-sibling'),
      { settings: { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://proxy.example' } } })).outcome,
    'restricted');
    assert.equal(observeNative(source(join(root, 'dropin-sibling'),
      { settings: { allowManagedMcpServersOnly: true }, dropIn: { 'z.json': { someUnknownManagedKey: true } } })).outcome,
    'restricted');
  }));

// --- Ancestor traversal and capture consistency ---

test('a policy source below a symlinked ancestor is unreadable', t =>
  withRoot(root => {
    const real = source(join(root, 'real', 'claude-code'));
    const alias = join(root, 'alias');
    try { symlinkSync(join(root, 'real'), alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      t.skip(`directory symlink unavailable: ${error.code}`);
      return;
    }
    assert.equal(observeNative(join(alias, 'claude-code')).outcome, 'unreadable');
    // The same directory reached without the link stays observable, so the link is the cause.
    assert.equal(observeNative(real).outcome, 'file-sources-clear');
  }));

test('a symlinked policy source directory is not followed', t =>
  withRoot(root => {
    const target = source(join(root, 'target-source'), { settings: { theme: 'dark' } });
    const link = join(root, 'linked-source');
    try { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      t.skip(`directory symlink unavailable: ${error.code}`);
      return;
    }
    assert.equal(observeNative(link).outcome, 'unreadable');
  }));

test('a policy source below a non-directory ancestor is unreadable', () =>
  withRoot(root => {
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, '{}');
    assert.equal(observeNative(join(blocker, 'claude-code')).outcome, 'unreadable');
  }));

test('a policy source deeper than the ancestor traversal bound is unreadable', () =>
  withRoot(root => {
    const deep = join(root, ...Array.from({ length: 70 }, (_, index) => `d${index}`));
    assert.equal(observeNative(deep).outcome, 'unreadable');
  }));

test('a drop-in entry that is not a regular file is unreadable', () =>
  withRoot(root => {
    const directory = source(join(root, 'dropin-entry-dir'));
    mkdirSync(join(directory, 'managed-settings.d', 'a.json'), { recursive: true });
    assert.equal(observeNative(directory).outcome, 'unreadable');
  }));


test('managed auto-memory keys are restrictions and win over unreadable observations', () =>
  withRoot(root => {
    const policies = [true, false, null, ''].map(value => ({ autoMemoryEnabled: value }));
    policies.push(...['0', 'false', '', '1', 0, false].map(value => ({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: value } })));
    for (const [index, policy] of policies.entries()) {
      const linux = source(join(root, `policy-${index}`), { settings: { ...policy, unknownPolicy: {} },
        dropIn: { 'unreadable.json': '{broken' } });
      assert.equal(observeNative(linux).outcome, 'restricted', JSON.stringify(policy));
      assert.equal(observeWsl(linux).outcome, 'restricted', 'restriction wins over unknown Windows source');
    }
    assert.equal(observeNative(source(join(root, 'unreadable'), { settings: '{broken' })).outcome, 'unreadable');
  }));

test('managed fixed env presence restricts native and WSL policy observations', () =>
  withRoot(root => {
    let index = 0;
    for (const key of ['CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL', 'CLAUDE_CODE_DISABLE_FAST_MODE',
      'MCP_CONNECTION_NONBLOCKING', 'mcp_connection_nonblocking', 'Mcp_Connection_Nonblocking'])
      for (const value of ['', '0', 'false', '1', false, 0, null]) {
        const policy = { env: { [key]: value }, unknownPolicy: {} };
        const linux = source(join(root, `linux-${index}`), { settings: policy, dropIn: { 'broken.json': '{broken' } });
        const windows = source(join(root, `windows-${index++}`), { dropIn: { 'switch.json': policy, 'broken.json': '{broken' } });
        assert.equal(observeNative(linux).outcome, 'restricted', `${key}/${value}`);
        assert.equal(observeWsl(linux).outcome, 'restricted', 'restriction wins over unknown Windows source');
        assert.equal(observeWsl(source(join(root, 'clear')), { windowsDirectory: windows, windowsSourceKnown: true }).outcome,
          'restricted', 'Windows policy restriction wins over unreadable drop-in');
        assert.equal(readFileSync(join(linux, 'managed-settings.json'), 'utf8'), JSON.stringify(policy));
      }
  }));

// --- One managed env classification for the Linux/WSL2 and the non-Linux observers ---

// Independent literals: every fixed or telemetry env key that must restrict on every observer.
const RESTRICTING_ENV_KEYS = ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL',
  'CLAUDE_CODE_DISABLE_FAST_MODE', 'MCP_CONNECTION_NONBLOCKING', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_LOGS_EXPORTER',
  'CLAUDE_CODE_ENABLE_TELEMETRY', 'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA', 'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
const caseVariants = key => [key, key.toLowerCase(),
  key.toLowerCase().replace(/(^|_)([a-z])/g, (_, separator, letter) => separator + letter.toUpperCase())];
// Each observer reports the same document-level classification under its own clear token.
const outcomes = directory => [observeNative(directory).outcome,
  observeClaudeManagedSettings({ platform: 'win32', directory }).outcome]
  .map(outcome => outcome.replace('file-sources-clear', 'clear'));

test('every fixed or telemetry managed env key restricts both observers, including case variants', () =>
  withRoot(root => {
    let index = 0;
    for (const key of RESTRICTING_ENV_KEYS) for (const variant of caseVariants(key)) for (const value of ['', '0', '1', null]) {
      const directory = source(join(root, `known-${index++}`), { settings: { env: { [variant]: value } } });
      assert.deepEqual(outcomes(directory), ['restricted', 'restricted'], `${variant}/${value}`);
    }
  }));

test('unrecognised or malformed managed env blocks fail closed on both observers', () =>
  withRoot(root => {
    const unreadable = {
      proxy: { HTTPS_PROXY: 'http://proxy.example' }, path: { PATH: '/usr/bin' }, provider: { ANTHROPIC_BASE_URL: 'https://x' },
      lookalike: { CLAUDE_CODE_DISABLE_FAST_MODES: '1' }, prefix: { XOTEL_EXPORTER: '1' }, safe: { SAFE_LOOKING: '1' }
    };
    for (const [name, env] of Object.entries(unreadable))
      assert.deepEqual(outcomes(source(join(root, `unknown-${name}`), { settings: { env } })), ['unreadable', 'unreadable'], name);
    for (const [name, env] of Object.entries({ string: 'nope', array: [], nil: null, number: 1 }))
      assert.deepEqual(outcomes(source(join(root, `malformed-${name}`), { settings: { env } })), ['unreadable', 'unreadable'], name);
    // Prototype-shaped and empty names are own keys of the parsed block, never a benign or inherited value.
    for (const [name, text] of Object.entries({ proto: '{"env":{"__proto__":{}}}', protoNull: '{"env":{"__proto__":null}}',
      constructor: '{"env":{"constructor":"1"}}', empty: '{"env":{"":"1"}}',
      // A duplicate env key must not let a later empty block erase an earlier restriction.
      duplicate: '{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"http://x"},"env":{}}' }))
      assert.deepEqual(outcomes(source(join(root, `crafted-${name}`), { settings: text })), ['unreadable', 'unreadable'], name);
    // A known key still wins over an unrecognised sibling key, in the same block or another source file.
    assert.deepEqual(outcomes(source(join(root, 'mixed'), { settings: { env: { HTTPS_PROXY: 'x', otel_logs_exporter: 'none' } } })),
      ['restricted', 'restricted']);
    assert.deepEqual(outcomes(source(join(root, 'split'), { settings: { env: { HTTPS_PROXY: 'x' } },
      dropIn: { 'a.json': { env: { DISABLE_TELEMETRY: '1' } } } })), ['restricted', 'restricted']);
  }));

test('absent and empty managed env blocks leave both observers clear', () =>
  withRoot(root => {
    assert.deepEqual(outcomes(source(join(root, 'absent'), { settings: { theme: 'dark' } })), ['clear', 'clear']);
    assert.deepEqual(outcomes(source(join(root, 'empty'), { settings: { env: {} } })), ['clear', 'clear']);
    assert.deepEqual(outcomes(source(join(root, 'dropin-empty'), { dropIn: { 'a.json': { env: {} } } })), ['clear', 'clear']);
  }));
