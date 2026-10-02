import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { inspect } from '../dist/core/index.js';
import { targets, helperMetadata } from '@aihq/core/harness';

const HELPERS = ['rg', 'fd', 'jq', 'curl', 'keytool', 'bash'];
const CLIENTS = ['antigravity', 'zed'];
const NEW_TARGETS = [...HELPERS, ...CLIENTS];

const win = process.platform === 'win32';
const targetDefinition = id => targets.find(target => target.id === id);
// keytool fixtures succeed only for the documented -J-version probe argv.
const writeExecutable = (dir, name) => {
  const file = join(dir, win ? `${name}.cmd` : name);
  writeFileSync(file, name === 'keytool'
    ? (win ? '@echo off\r\nif "%~1"=="-J-version" exit /b 0\r\nexit /b 3\r\n' : '#!/bin/sh\n[ "$1" = "-J-version" ] && exit 0\nexit 3\n')
    : (win ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n'));
  if (!win) chmodSync(file, 0o755);
  return file;
};
const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-inspect-helpers-'));
  const home = join(root, 'home'); const bin = join(root, 'bin');
  mkdirSync(home); mkdirSync(bin);
  return { root, home, bin };
};
const saveEnvironment = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE });
const restoreEnvironment = before => {
  for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
};
const useSandboxEnvironment = ({ home, bin }) => {
  process.env.PATH = bin; process.env.HOME = home; process.env.USERPROFILE = home;
};

test('new helper and client targets are registered with the unchanged target shape', () => {
  const diagnostic = helperMetadata.diagnostics.find(entry => entry.id === 'existing-tools');
  for (const id of NEW_TARGETS) {
    const definition = targetDefinition(id);
    assert.ok(definition, `targets is missing ${id}`);
    assert.deepEqual(Object.keys(definition).sort(), ['binaries', 'configDirs', 'id', 'label', 'origins']);
    assert.ok(definition.label.length > 0);
    assert.ok(Array.isArray(definition.binaries) && definition.binaries.length > 0);
    assert.ok(diagnostic.targets.includes(id), `helperMetadata existing-tools is missing ${id}`);
  }
  assert.deepEqual(targetDefinition('fd').binaries, ['fd', 'fdfind']);
});

test('requested helpers with fixture executables are runnable and pass their version check', async () => {
  const { root, home, bin } = sandbox();
  const before = saveEnvironment();
  try {
    for (const id of HELPERS) writeExecutable(bin, targetDefinition(id).binaries[0]);
    useSandboxEnvironment({ home, bin });
    const result = await inspect({ targets: [...HELPERS], network: 'off' });
    for (const id of HELPERS) {
      const tool = result.tools.find(entry => entry.id === id);
      assert.equal(tool.selection, 'requested');
      assert.equal(tool.state, 'runnable', `${id}: ${JSON.stringify(tool)}`);
      const check = result.checks.find(entry => entry.id === `${id}/version`);
      assert.equal(check.target, id);
      assert.equal(check.outcome, 'passed', `${id}: ${JSON.stringify(check)}`);
    }
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('requested helpers missing executables report executable-missing attributed to the helper itself', async () => {
  const { root, home, bin } = sandbox();
  const before = saveEnvironment();
  try {
    useSandboxEnvironment({ home, bin });
    for (const id of HELPERS) {
      const result = await inspect({ targets: [id], network: 'off' });
      const tool = result.tools.find(entry => entry.id === id);
      assert.equal(tool.selection, 'requested');
      assert.equal(tool.state, 'absent');
      const check = result.checks.find(entry => entry.id === `${id}/version`);
      assert.equal(check.target, id);
      assert.equal(check.outcome, 'unavailable');
      assert.equal(check.reason, 'executable-missing');
      assert.equal(result.checks.every(entry => entry.target === id), true, JSON.stringify(result.checks));
      const choice = result.repairChoices.find(entry => entry.target === id && entry.reason === 'executable-missing');
      assert.ok(choice, `no manual-guidance repairChoice for ${id}`);
      assert.equal(choice.kind, 'manual-guidance');
    }
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('unselected absent helpers stay unselected and add no checks or observations', async () => {
  const { root, home, bin } = sandbox();
  const before = saveEnvironment();
  try {
    useSandboxEnvironment({ home, bin });
    const result = await inspect({ targets: ['node'], network: 'off' });
    for (const id of HELPERS) {
      const tool = result.tools.find(entry => entry.id === id);
      assert.ok(tool, `tools is missing ${id}`);
      assert.equal(tool.selection, 'unselected');
      assert.equal(tool.state, 'absent');
      assert.equal(result.checks.some(entry => entry.target === id), false);
      assert.equal(result.observations.some(entry => entry.target === id), false);
    }
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('fd resolves through fdfind when only fdfind exists', async () => {
  const { root, home, bin } = sandbox();
  const before = saveEnvironment();
  try {
    const alternate = targetDefinition('fd').binaries.find(name => name === 'fdfind');
    assert.ok(alternate, 'fd target does not declare fdfind');
    writeExecutable(bin, alternate);
    useSandboxEnvironment({ home, bin });
    const result = await inspect({ targets: ['fd'], network: 'off' });
    const tool = result.tools.find(entry => entry.id === 'fd');
    assert.equal(tool.state, 'runnable', JSON.stringify(result.tools));
    assert.equal(result.checks.find(entry => entry.id === 'fd/version').outcome, 'passed');
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous PATH resolution emits a resolution observation; a single candidate does not', async () => {
  const { root, home, bin } = sandbox();
  const second = join(root, 'bin-second'); mkdirSync(second);
  const before = saveEnvironment();
  try {
    process.env.HOME = home; process.env.USERPROFILE = home;
    writeExecutable(bin, 'rg'); writeExecutable(second, 'rg');
    process.env.PATH = bin + delimiter + second;
    const ambiguous = await inspect({ targets: ['rg'], network: 'off' });
    const observation = ambiguous.observations.find(entry => entry.id === 'rg/resolution');
    assert.ok(observation, 'no rg/resolution observation for two PATH candidates');
    assert.equal(observation.target, 'rg');
    assert.match(observation.detail, /PATH entry 1\. 1 other candidate resolves on PATH\./);
    assert.equal(observation.detail.includes(root), false, 'resolution detail must not expose absolute paths');
    process.env.PATH = bin;
    const single = await inspect({ targets: ['rg'], network: 'off' });
    assert.equal(single.observations.some(entry => entry.id === 'rg/resolution'), false,
      JSON.stringify(single.observations));
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('clients with fixture binaries are runnable and native loading stays unverified', async () => {
  const { root, home, bin } = sandbox();
  const before = saveEnvironment();
  try {
    for (const id of CLIENTS) writeExecutable(bin, targetDefinition(id).binaries[0]);
    useSandboxEnvironment({ home, bin });
    const assertLoading = (result, selection) => {
      for (const id of CLIENTS) {
        const tool = result.tools.find(entry => entry.id === id);
        assert.equal(tool.selection, selection);
        assert.equal(tool.state, 'runnable', `${id}: ${JSON.stringify(tool)}`);
        assert.equal(result.checks.find(entry => entry.id === `${id}/version`).outcome, 'passed');
        const loading = result.observations.find(entry => entry.id === `${id}/loading`);
        assert.ok(loading, `no ${id}/loading observation`);
        assert.equal(loading.target, id);
        assert.match(loading.detail, /loading was not verified/);
        const choice = result.repairChoices.find(entry => entry.target === id && entry.reason === 'loading-unverified');
        assert.ok(choice, `no loading-unverified repairChoice for ${id}`);
        assert.equal(choice.kind, 'manual-guidance');
        assert.ok(choice.guidance.length > 0);
      }
    };
    assertLoading(await inspect({ targets: [...CLIENTS], network: 'off' }), 'requested');
    assertLoading(await inspect({ network: 'off' }), 'detected');
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('config-only clients keep the version check unavailable and loading unverified', async () => {
  const { root, home, bin } = sandbox();
  const before = saveEnvironment();
  try {
    for (const id of CLIENTS) {
      const definition = targetDefinition(id);
      assert.ok(definition.configDirs.length > 0, `${id} declares no configDirs`);
      mkdirSync(join(home, ...definition.configDirs[0].split('/')), { recursive: true });
    }
    useSandboxEnvironment({ home, bin });
    const result = await inspect({ targets: [...CLIENTS], network: 'off' });
    for (const id of CLIENTS) {
      const tool = result.tools.find(entry => entry.id === id);
      assert.equal(tool.selection, 'requested');
      assert.equal(tool.state, 'config-only', `${id}: ${JSON.stringify(tool)}`);
      const check = result.checks.find(entry => entry.id === `${id}/version`);
      assert.equal(check.outcome, 'unavailable');
      assert.equal(check.reason, 'executable-missing');
      const loading = result.observations.find(entry => entry.id === `${id}/loading`);
      assert.ok(loading, `no ${id}/loading observation`);
      assert.match(loading.detail, /loading was not verified/);
      const choice = result.repairChoices.find(entry => entry.target === id && entry.reason === 'loading-unverified');
      assert.ok(choice, `no loading-unverified repairChoice for ${id}`);
      assert.equal(choice.kind, 'manual-guidance');
    }
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('absent unselected clients add no checks and no loading observation', async () => {
  const { root, home, bin } = sandbox();
  const before = saveEnvironment();
  try {
    useSandboxEnvironment({ home, bin });
    const result = await inspect({ targets: ['node'], network: 'off' });
    for (const id of CLIENTS) {
      const tool = result.tools.find(entry => entry.id === id);
      assert.ok(tool, `tools is missing ${id}`);
      assert.equal(tool.selection, 'unselected');
      assert.equal(tool.state, 'absent');
      assert.equal(result.checks.some(entry => entry.target === id), false);
      assert.equal(result.observations.some(entry => entry.target === id), false);
    }
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('helper and client results preserve the published diagnostic contract', async () => {
  const schema = JSON.parse(readFileSync(new URL('../dist/harness/schemas/diagnostic/1.0.0.json', import.meta.url), 'utf8'));
  const states = schema.properties.tools.items.properties.state.enum;
  const selections = schema.properties.tools.items.properties.selection.enum;
  const outcomes = schema.properties.checks.items.properties.outcome.enum;
  const { root, home, bin } = sandbox();
  const before = saveEnvironment();
  try {
    writeExecutable(bin, targetDefinition('rg').binaries[0]);
    writeExecutable(bin, targetDefinition('antigravity').binaries[0]);
    mkdirSync(join(home, ...targetDefinition('zed').configDirs[0].split('/')), { recursive: true });
    useSandboxEnvironment({ home, bin });
    const baseline = await inspect({ targets: ['node'], network: 'off' });
    const result = await inspect({ targets: [...NEW_TARGETS], network: 'off' });
    assert.deepEqual(Object.keys(result).sort(), Object.keys(baseline).sort());
    for (const id of NEW_TARGETS) assert.ok(result.tools.some(entry => entry.id === id), `tools is missing ${id}`);
    for (const tool of result.tools) {
      assert.ok(states.includes(tool.state), `state ${tool.state}`);
      assert.ok(selections.includes(tool.selection), `selection ${tool.selection}`);
    }
    for (const check of result.checks) assert.ok(outcomes.includes(check.outcome), `outcome ${check.outcome}`);
    for (const observation of result.observations) {
      assert.deepEqual(Object.keys(observation).sort(), ['detail', 'id', 'target']);
    }
    for (const choice of result.repairChoices) assert.equal(choice.kind, 'manual-guidance');
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing targets are unaffected: claude config-only emits no loading observation', async () => {
  const { root, home, bin } = sandbox();
  const before = saveEnvironment();
  try {
    mkdirSync(join(home, '.claude'));
    useSandboxEnvironment({ home, bin });
    const result = await inspect({ targets: ['claude'], network: 'off' });
    const tool = result.tools.find(entry => entry.id === 'claude');
    assert.equal(tool.selection, 'requested');
    assert.equal(tool.state, 'config-only');
    assert.equal(result.observations.some(entry => entry.id === 'claude/loading'), false);
    assert.equal(result.repairChoices.some(entry => entry.reason === 'loading-unverified'), false);
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Windows WSL bash launcher is reported as ambiguous and never started', { skip: !win }, async () => {
  const { root, home } = sandbox();
  const system32 = join(root, 'System32'); mkdirSync(system32);
  // Any start attempt would fail: these bytes are not a runnable program.
  writeFileSync(join(system32, 'bash.exe'), 'not a program');
  const before = saveEnvironment();
  try {
    useSandboxEnvironment({ home, bin: system32 });
    const result = await inspect({ targets: ['bash'], network: 'off' });
    const version = result.checks.find(check => check.id === 'bash/version');
    assert.equal(version.outcome, 'skipped');
    assert.equal(version.reason, 'wsl-launcher');
    assert.match(result.observations.find(entry => entry.id === 'bash/resolution').detail, /WSL launcher/);
    assert.equal(result.tools.find(tool => tool.id === 'bash').state, 'binary');
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('symlinked PATH entries and alternate names in one install are not ambiguity', { skip: win }, async () => {
  const { root, home, bin } = sandbox();
  const alias = join(root, 'bin-alias'); symlinkSync(bin, alias);
  const before = saveEnvironment();
  try {
    writeExecutable(bin, 'rg'); writeExecutable(bin, 'zed'); writeExecutable(bin, 'zeditor');
    useSandboxEnvironment({ home, bin });
    process.env.PATH = bin + delimiter + alias;
    const result = await inspect({ targets: ['rg', 'zed'], network: 'off' });
    assert.equal(result.observations.some(entry => entry.id.endsWith('/resolution')), false,
      JSON.stringify(result.observations));
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('two names in one Windows install directory are not ambiguity', { skip: !win }, async () => {
  const { root, home, bin } = sandbox();
  const before = saveEnvironment();
  try {
    writeExecutable(bin, 'zed'); writeExecutable(bin, 'zeditor');
    useSandboxEnvironment({ home, bin });
    const result = await inspect({ targets: ['zed'], network: 'off' });
    assert.equal(result.observations.some(entry => entry.id === 'zed/resolution'), false,
      JSON.stringify(result.observations));
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an Antigravity-only ~/.gemini does not make gemini config-only', async () => {
  const { root, home, bin } = sandbox();
  const before = saveEnvironment();
  try {
    for (const dir of ['antigravity', 'antigravity-cli', 'config']) mkdirSync(join(home, '.gemini', dir), { recursive: true });
    writeFileSync(join(home, '.gemini', 'GEMINI.md'), '# Antigravity global rules\n');
    useSandboxEnvironment({ home, bin });
    const detected = await inspect({ targets: ['node'], network: 'off' });
    const gemini = detected.tools.find(entry => entry.id === 'gemini');
    assert.equal(gemini.state, 'absent');
    assert.equal(gemini.selection, 'unselected');
    assert.equal(detected.checks.some(entry => entry.target === 'gemini'), false);
    assert.equal(detected.tools.find(entry => entry.id === 'antigravity').state, 'config-only');
    const everything = await inspect({ network: 'off' });
    assert.equal(everything.tools.find(entry => entry.id === 'gemini').state, 'absent');
    assert.equal(everything.tools.find(entry => entry.id === 'gemini').selection, 'unselected');
    const requested = await inspect({ targets: ['gemini'], network: 'off' });
    const tool = requested.tools.find(entry => entry.id === 'gemini');
    assert.equal(tool.selection, 'requested');
    assert.notEqual(tool.state, 'config-only');
    assert.ok(requested.checks.some(entry => entry.target === 'gemini' && entry.reason === 'executable-missing'));
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('each Gemini-CLI-specific ~/.gemini directory alone makes gemini config-only', async () => {
  const before = saveEnvironment();
  for (const relative of ['tmp', 'extensions', 'commands', 'history']) {
    const { root, home, bin } = sandbox();
    try {
      mkdirSync(join(home, '.gemini', relative), { recursive: true });
      useSandboxEnvironment({ home, bin });
      const result = await inspect({ targets: ['gemini'], network: 'off' });
      const tool = result.tools.find(entry => entry.id === 'gemini');
      assert.equal(tool.state, 'config-only', relative);
      assert.equal(tool.config, `.gemini/${relative}`);
    } finally {
      restoreEnvironment(before);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('the Antigravity IDE directory alone is an Antigravity configuration trace', async () => {
  const { root, home, bin } = sandbox();
  const before = saveEnvironment();
  try {
    mkdirSync(join(home, '.gemini', 'antigravity'), { recursive: true });
    useSandboxEnvironment({ home, bin });
    const result = await inspect({ targets: ['antigravity', 'gemini'], network: 'off' });
    const antigravity = result.tools.find(tool => tool.id === 'antigravity');
    assert.equal(antigravity.state, 'config-only');
    assert.equal(antigravity.config, '.gemini/antigravity');
    assert.equal(result.tools.find(tool => tool.id === 'gemini').state, 'absent');
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a WSL bash launcher reached through a junction is still never started', { skip: !win }, async () => {
  const { root, home } = sandbox();
  const system32 = join(root, 'System32'); mkdirSync(system32);
  writeFileSync(join(system32, 'bash.exe'), 'not a program');
  const linked = join(root, 'linked-bin'); symlinkSync(system32, linked, 'junction');
  const before = saveEnvironment();
  try {
    useSandboxEnvironment({ home, bin: linked });
    const result = await inspect({ targets: ['bash'], network: 'off' });
    const version = result.checks.find(check => check.id === 'bash/version');
    assert.equal(version.outcome, 'skipped');
    assert.equal(version.reason, 'wsl-launcher');
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolution names the executable that runs, not an earlier alias of it', { skip: win }, async () => {
  const { root, home, bin } = sandbox();
  const second = join(root, 'bin-second'); const third = join(root, 'bin-third');
  mkdirSync(second); mkdirSync(third);
  const before = saveEnvironment();
  try {
    const fd = writeExecutable(second, 'fd'); writeExecutable(third, 'fd');
    symlinkSync(fd, join(bin, 'fdfind'));
    useSandboxEnvironment({ home, bin });
    process.env.PATH = [bin, second, third].join(delimiter);
    const result = await inspect({ targets: ['fd'], network: 'off' });
    assert.equal(result.observations.find(entry => entry.id === 'fd/resolution').detail,
      'Used fd from PATH entry 2. 1 other candidate resolves on PATH.');
  } finally {
    restoreEnvironment(before);
    rmSync(root, { recursive: true, force: true });
  }
});
