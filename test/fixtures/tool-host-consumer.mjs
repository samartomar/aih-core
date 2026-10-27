// Runs inside a disposable consumer with the packed @aihq/core installed; public entries only. argv[2] is a
// disposable root for projects, homes and PATH folders. Nothing under it is ever run by inspection.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectToolHost } from '@aihq/core/harness/runtime';
import { toolBindings } from '@aihq/core/harness';

const root = process.argv[2];
const windows = process.platform === 'win32';
const marker = join(root, 'ran');
const byTool = Object.fromEntries(toolBindings.map(binding => [binding.tool, binding]));
const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
// A program that would leave a marker if anything ran it.
const program = path => {
  write(path, windows ? `@echo off\r\necho ran> "${marker}"\r\n` : `#!/bin/sh\necho ran > '${marker}'\n`);
  if (!windows) chmodSync(path, 0o755);
};
const programName = name => windows ? `${name}.cmd` : name;
// An npm prefix as npm lays it out on Windows: a command shim beside `node_modules`, whose package `bin` names it.
const installTool = (prefix, packageName, binary, version) => {
  const directory = join(prefix, 'node_modules', packageName);
  program(join(directory, 'cli.js'));
  write(join(directory, 'package.json'), JSON.stringify({ name: packageName, version, bin: { [binary]: 'cli.js' } }));
  program(join(prefix, programName(binary)));
  return prefix;
};
// An npm prefix as npm lays it out on POSIX: `bin/<name>` links to the package's file.
const linkTool = (prefix, packageName, binary, version) => {
  const directory = join(prefix, 'lib', 'node_modules', packageName);
  program(join(directory, 'cli.js'));
  write(join(directory, 'package.json'), JSON.stringify({ name: packageName, version, bin: { [binary]: 'cli.js' } }));
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  symlinkSync(join(directory, 'cli.js'), join(prefix, 'bin', binary));
  return join(prefix, 'bin');
};
const here = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch}`;
const host = ({ home, path }) => {
  process.env.HOME = home; process.env.USERPROFILE = home;
  for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PATH' || key === 'CODEX_HOME') delete process.env[key];
  if (path !== undefined) process.env.PATH = path;
};
const folder = (...parts) => { const path = join(root, ...parts); mkdirSync(path, { recursive: true }); return path; };
const skill = { framework: 'example', itemId: 'review', kind: 'skill', key: 'review' };
const hook = { framework: 'example', itemId: 'format-hook', kind: 'hook', executables: ['node'] };
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };
const codes = result => result.diagnostics.map(item => [item.code, item.reason]);
const where = (result, code) => result.hostBlockers.filter(item => item.code === code);

await check('requests outside the published shape are refused, and unobserved tools are not targets', async () => {
  const project = folder('refusals', 'home', 'project');
  host({ home: folder('refusals', 'home'), path: '' });
  assert.deepEqual(codes(await inspectToolHost({ tool: 'nope', project, items: [skill] })), [['INPUT_INVALID', 'unknown-tool']]);
  const cursor = await inspectToolHost({ tool: 'cursor', project, items: [skill] });
  assert.equal(cursor.status, 'refused');
  assert.deepEqual(codes(cursor), [['PREREQUISITE_UNAVAILABLE', 'tool-not-observed']]);
  assert.deepEqual(codes(await inspectToolHost({ tool: 'claude', project: 'project', items: [skill] })), [['INPUT_INVALID', 'project']]);
  assert.deepEqual(codes(await inspectToolHost({ tool: 'claude', project: join(project, 'missing'), items: [skill] })), [['INPUT_INVALID', 'project']]);
  assert.deepEqual(codes(await inspectToolHost({ tool: 'claude', project, items: [skill], extra: true })), [['INPUT_INVALID', 'request-field']]);
  assert.deepEqual(codes(await inspectToolHost({ tool: 'claude', project, items: [{ ...skill, key: '../escape' }] })), [['INPUT_INVALID', 'item']]);
  assert.deepEqual(codes(await inspectToolHost({ tool: 'claude', project, items: [skill, skill] })), [['INPUT_INVALID', 'duplicate-item']]);
  assert.deepEqual(codes(await inspectToolHost({ tool: 'claude', project, items: [skill] }, { budgetMs: 0 })), [['INPUT_INVALID', 'budget-ms']]);
});

await check('unknown and unavailable facts make no works or duplicate claim, only unchecked notes', async () => {
  const project = folder('unknown', 'home', 'project');
  host({ home: folder('unknown', 'home') }); // no PATH at all
  const result = await inspectToolHost({ tool: 'claude-code', project, items: [skill, hook] });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.tool, { id: 'claude', label: 'Claude Code' });
  assert.equal(result.binding.digest, byTool.claude.digest);
  assert.deepEqual(result.installedVersion, { state: 'unknown', reason: 'tool-executable-unknown' });
  assert.equal(result.stale, 'unchecked');
  assert.deepEqual(result.items.map(item => item.stale), ['unchecked', 'unchecked']);
  assert.deepEqual(result.items[1].executables, [{ name: 'node', state: 'unknown' }]);
  assert.deepEqual(where(result, 'executable-missing'), [], 'an unknown executable is never reported missing');
  assert.deepEqual(result.items[0].copies, {
    user: { state: 'unavailable', reason: 'user-root-not-observed' },
    parentFolders: { state: 'unavailable', reason: 'ancestor-reading-not-observed' },
    plugins: { state: 'unavailable', reason: 'plugin-locations-not-observed' } });
  assert.deepEqual(result.items[1].copies.user, { state: 'unavailable', reason: 'item-not-keyed' });
  assert.deepEqual(result.warnings.filter(item => item.code === 'same-key-elsewhere'), [], 'nothing unchecked is a duplicate');
  assert.deepEqual(result.unchecked, [
    { fact: 'tool-version', reason: 'tool-executable-unknown' },
    { fact: 'user-copy', item: { framework: 'example', itemId: 'review' }, reason: 'user-root-not-observed' },
    { fact: 'parent-folder-copy', item: { framework: 'example', itemId: 'review' }, reason: 'ancestor-reading-not-observed' },
    { fact: 'plugin-copy', item: { framework: 'example', itemId: 'review' }, reason: 'plugin-locations-not-observed' },
    { fact: 'stale', item: { framework: 'example', itemId: 'review' }, reason: 'tool-version-unknown' },
    { fact: 'executable', item: { framework: 'example', itemId: 'format-hook' }, executable: 'node', reason: 'path-unavailable' },
    { fact: 'user-copy', item: { framework: 'example', itemId: 'format-hook' }, reason: 'item-not-keyed' },
    { fact: 'parent-folder-copy', item: { framework: 'example', itemId: 'format-hook' }, reason: 'item-not-keyed' },
    { fact: 'plugin-copy', item: { framework: 'example', itemId: 'format-hook' }, reason: 'item-not-keyed' },
    { fact: 'stale', item: { framework: 'example', itemId: 'format-hook' }, reason: 'tool-version-unknown' }]);
});

await check('a missing executable gives executable-missing and the tool version stays unknown', async () => {
  const project = folder('missing', 'home', 'project');
  host({ home: folder('missing', 'home'), path: folder('missing', 'empty-bin') });
  const result = await inspectToolHost({ tool: 'claude', project, items: [hook] });
  assert.deepEqual(result.installedVersion, { state: 'unknown', reason: 'tool-executable-absent' });
  assert.deepEqual(result.items[0].executables, [{ name: 'node', state: 'absent' }]);
  assert.deepEqual(result.hostBlockers, [{ code: 'executable-missing', item: { framework: 'example', itemId: 'format-hook' }, executable: 'node' }]);
  // A relative PATH entry could hold it, so it is not known to be missing.
  host({ home: folder('missing', 'home'), path: [folder('missing', 'empty-bin'), 'relative-bin'].join(windows ? ';' : ':') });
  const relative = await inspectToolHost({ tool: 'claude', project, items: [hook] });
  assert.deepEqual(relative.items[0].executables, [{ name: 'node', state: 'unknown' }]);
  assert.deepEqual(relative.hostBlockers, []);
  if (!windows) {
    // An empty POSIX entry is the current folder.
    host({ home: folder('missing', 'home'), path: folder('missing', 'empty-bin') + ':' });
    const empty = await inspectToolHost({ tool: 'claude', project, items: [hook] });
    assert.deepEqual([empty.items[0].executables, empty.hostBlockers], [[{ name: 'node', state: 'unknown' }], []]);
  }
});

await check('an installed version without an exact proving observation is stale; read from files, never by running the tool', async () => {
  const project = folder('stale', 'home', 'project');
  const newer = installTool(folder('stale', 'newer'), '@anthropic-ai/claude-code', 'claude', '2.2.0');
  const tools = folder('stale', 'tools');
  program(join(tools, programName('node')));
  host({ home: folder('stale', 'home'), path: [newer, tools].join(windows ? ';' : ':') });
  const agent = { framework: 'example', itemId: 'planner', kind: 'agent', key: 'planner.md' };
  const result = await inspectToolHost({ tool: 'claude', project, items: [skill, agent, hook] });
  assert.deepEqual(result.installedVersion, { state: 'known', version: '2.2.0', source: 'package-manifest' });
  assert.equal(result.stale, true);
  assert.deepEqual(result.items.map(item => [item.observedVersion, item.stale]),
    [['2.1.308', true], [undefined, 'unchecked'], ['2.1.308', true]], 'an unproven agent cell is neither stale nor current');
  assert.deepEqual(result.unchecked.filter(note => note.fact === 'stale'),
    [{ fact: 'stale', item: { framework: 'example', itemId: 'planner' }, reason: 'cell-not-proven' }]);
  assert.deepEqual(result.items[2].executables, [{ name: 'node', state: 'present' }]);
  assert.deepEqual(where(result, 'executable-missing'), []);
  const older = installTool(folder('stale', 'older'), '@anthropic-ai/claude-code', 'claude', '2.1.0');
  host({ home: folder('stale', 'home'), path: older });
  const current = await inspectToolHost({ tool: 'claude', project, items: [skill] });
  // An older version does not inherit a proving observation from a different version either.
  assert.deepEqual([current.installedVersion.version, current.stale, current.items[0].stale], ['2.1.0', true, true]);
  assert.deepEqual(current.unchecked.filter(note => note.fact === 'stale'), []);
  if (!windows) {
    host({ home: folder('stale', 'home'), path: linkTool(folder('stale', 'linked'), '@anthropic-ai/claude-code', 'claude', '2.3.1') });
    const linked = await inspectToolHost({ tool: 'claude', project, items: [skill] });
    assert.deepEqual([linked.installedVersion, linked.stale], [{ state: 'known', version: '2.3.1', source: 'package-manifest' }, true]);
  }
  assert.equal(existsSync(marker), false, 'no tool or executable was run');
});

await check('a parent-folder copy gives same-key-elsewhere with where, only where ancestor reading is observed', async () => {
  const parent = folder('parent', 'home', 'workspace');
  const project = folder('parent', 'home', 'workspace', 'project');
  const copy = join(parent, '.github', 'skills', 'review', 'SKILL.md');
  write(copy, '# Review\n');
  const claudeCopy = join(parent, '.claude', 'skills', 'review', 'SKILL.md');
  write(claudeCopy, '# Review\n');
  host({ home: folder('parent', 'home'), path: '' });
  const other = { framework: 'example', itemId: 'lint', kind: 'skill', key: 'lint' };
  const result = await inspectToolHost({ tool: 'copilot', project, items: [skill, other] });
  assert.deepEqual(result.items[0].copies.parentFolders, { state: 'found', paths: [join(parent, '.github', 'skills', 'review')] });
  assert.deepEqual(result.items[1].copies.parentFolders, { state: 'none' });
  assert.deepEqual(result.warnings.filter(item => item.code === 'same-key-elsewhere'), [
    { code: 'same-key-elsewhere', item: { framework: 'example', itemId: 'review' }, key: 'review', where: 'parent-folder',
      path: join(parent, '.github', 'skills', 'review') }]);
  // Claude Code's binding records no ancestor reading, so its parent-folder copy is unchecked, never a duplicate.
  const claude = await inspectToolHost({ tool: 'claude', project, items: [skill] });
  assert.deepEqual(claude.items[0].copies.parentFolders, { state: 'unavailable', reason: 'ancestor-reading-not-observed' });
  assert.deepEqual(claude.warnings.filter(item => item.code === 'same-key-elsewhere'), []);
  assert.equal(readFileSync(copy, 'utf8'), '# Review\n');
  assert.equal(readFileSync(claudeCopy, 'utf8'), '# Review\n');
});

await check('user-level copies are read only where the binding observes a user root', async () => {
  const home = folder('user', 'home');
  const project = folder('user', 'home', 'project');
  write(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { github: {} } }));
  write(join(home, '.codex', 'config.toml'), '[mcp_servers.github]\ncommand = "gh-mcp"\n');
  host({ home, path: '' });
  const mcp = { framework: 'example', itemId: 'github', kind: 'mcp-server', key: 'github' };
  const antigravity = await inspectToolHost({ tool: 'antigravity', project, items: [mcp] });
  assert.deepEqual(antigravity.items[0].copies.user, { state: 'found', paths: [join(home, '.gemini', 'config', 'mcp_config.json')] });
  assert.deepEqual(antigravity.warnings.filter(item => item.code === 'same-key-elsewhere').map(item => item.where), ['user']);
  write(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify([{ mcpServers: { github: {} } }]));
  const malformed = await inspectToolHost({ tool: 'antigravity', project, items: [mcp] });
  assert.deepEqual(malformed.items[0].copies.user, { state: 'unavailable', reason: 'unreadable' }, 'a malformed file is never none');
  const codex = await inspectToolHost({ tool: 'codex', project, items: [mcp] });
  assert.deepEqual(codex.items[0].copies.user, { state: 'unavailable', reason: 'registration-format-unread' });
  assert.deepEqual(codex.warnings.filter(item => item.code === 'same-key-elsewhere'), []);
  // A redirected Codex home is followed; it holds no key here.
  process.env.CODEX_HOME = folder('user', 'codex-home');
  const redirected = await inspectToolHost({ tool: 'codex', project, items: [mcp] });
  assert.deepEqual(redirected.items[0].copies.user, { state: 'unavailable', reason: 'registration-format-unread' });
});

await check('required inputs and missing dependencies are blockers with their exact meaning', async () => {
  const project = folder('inputs', 'home', 'project');
  host({ home: folder('inputs', 'home'), path: '' });
  const base = { framework: 'example', itemId: 'base', kind: 'rule' };
  const mcp = { framework: 'example', itemId: 'github', kind: 'mcp-server', key: 'github', inputs: ['GITHUB_TOKEN', 'GITHUB_HOST'],
    requires: [{ framework: 'example', itemId: 'base' }, { framework: 'other', itemId: 'auth' }] };
  const result = await inspectToolHost({ tool: 'claude', project, items: [mcp, base] });
  assert.deepEqual(result.hostBlockers, [
    { code: 'input-required', item: { framework: 'example', itemId: 'github' }, input: 'GITHUB_TOKEN' },
    { code: 'input-required', item: { framework: 'example', itemId: 'github' }, input: 'GITHUB_HOST' },
    { code: 'dependency-missing', item: { framework: 'example', itemId: 'github' }, dependency: { framework: 'other', itemId: 'auth' } }]);
  assert.deepEqual(result.items[0].inputs, ['GITHUB_TOKEN', 'GITHUB_HOST']);
});

await check('what the tool also reads is a warning from its binding', async () => {
  const project = folder('also', 'home', 'project');
  host({ home: folder('also', 'home'), path: '' });
  const result = await inspectToolHost({ tool: 'copilot', project, items: [{ ...skill }] });
  assert.deepEqual(result.warnings.filter(item => item.code === 'also-reads'),
    byTool.copilot.alsoReads.map(entry => ({ code: 'also-reads', what: entry.what, where: entry.where })));
  assert.equal(result.warnings.filter(item => item.code === 'also-reads').length, 2);
});

await check('a cancelled inspection reports cancellation, not facts', async () => {
  const project = folder('cancel', 'home', 'project');
  const controller = new AbortController(); controller.abort();
  host({ home: folder('cancel', 'home'), path: '' });
  const result = await inspectToolHost({ tool: 'claude', project, items: [skill] }, { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(codes(result), [['CANCELLED', 'cancelled']]);
});

assert.equal(existsSync(marker), false, 'no tool or executable was run');
console.log(JSON.stringify({ status: 'passed', checks }));
