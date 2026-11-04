// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// The tool registry, inspection with Catalog-shaped tool profiles, the read-only file comparison, host and project
// facts, the state location, and report snapshots and claim sets. Tool profiles, plan requests and the two command-line
// "CLIs" on PATH are Core-side FIXTURES (each fake CLI only prints a version); they prove no real client compatibility.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, checkFiles, inspect, list, prepare, resolveStateLocation } from '@aihq/core';
import { createReport, exportSnapshot, importSnapshot, projectClaims, readClaimSet, renderSupportMarkdown, schemas, validateClaimSet,
  validateFormat, validateSnapshot, refusalCodes } from '@aihq/core/contracts';
import { listTools, selectTool, toolRegistry, validateToolRegistry } from '@aihq/core/harness';
import { detectProjectFacts, diagnose, inspectToolHost } from '@aihq/core/harness/runtime';
import { ownRequest, sha256 } from './plan-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'aih-inspect-report-'));
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };
/** A fresh home for one section: Core resolves home from the environment on every call. */
const freshHome = name => { const home = join(scratch, `home-${name}`); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; return home; };
const project = name => { const folder = join(scratch, `project-${name}`); mkdirSync(folder); return folder; };
const tree = folder => existsSync(folder) ? readdirSync(folder, { recursive: true }).map(String).sort() : null;
const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
const aih = args => {
  const child = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  return { code: child.status, result: child.stdout.trim() ? JSON.parse(child.stdout) : undefined, stderr: child.stderr };
};

await check('the registry holds the 15 accepted tools with ids matching Catalog profiles', () => {
  assert.deepEqual(toolRegistry.tools.map(tool => [tool.id, tool.surface]), [
    ['claude-code', 'cli'], ['codex', 'cli'], ['kiro', 'cli'], ['copilot', 'cli'], ['antigravity', 'cli'], ['gemini', 'cli'], ['opencode', 'cli'],
    ['kimi', 'cli'], ['cursor', 'cli'], ['dsh', 'cli'], ['cursor-ide', 'ide'], ['windsurf', 'ide'], ['zed', 'ide'], ['kiro-ide', 'ide'], ['copilot-vscode', 'ide']]);
  assert.equal(toolRegistry.schema, 'urn:aihq:core:tool-registry:0.1.0');
  assert.deepEqual(validateFormat(JSON.parse(JSON.stringify(toolRegistry))), { status: 'ok', schema: 'urn:aihq:core:tool-registry:0.1.0' });
  assert.deepEqual(validateToolRegistry(toolRegistry), { status: 'ok' });
  const entry = schemas['urn:aihq:core:tool-registry:0.1.0'];
  assert.deepEqual(entry.fixtures.valid, JSON.parse(JSON.stringify(toolRegistry)), 'the valid fixture is the shipped registry');
  assert.equal(validateToolRegistry(entry.fixtures.invalid).status, 'invalid');
  assert.equal(validateToolRegistry({ schema: 'urn:aihq:harness:tool-registry:1.0.0', tools: [] }).status, 'unsupported-version');
  const doubled = { ...JSON.parse(JSON.stringify(toolRegistry)) };
  doubled.tools = [...doubled.tools, { ...doubled.tools[0], id: 'other', aliases: ['claude'] }];
  assert.deepEqual(validateToolRegistry(doubled).problems.map(item => item.reason), ['duplicate-tool-name']);
  assert.ok(Object.isFrozen(toolRegistry) && toolRegistry.tools.every(Object.isFrozen));
});

await check('selection takes ids and the claude alias; listing is the registry, not observations', () => {
  const alias = selectTool('claude');
  assert.deepEqual([alias.status, alias.tool.id, alias.via], ['ok', 'claude-code', 'alias']);
  assert.equal(selectTool('claude-code').tool, alias.tool);
  assert.deepEqual([selectTool('cursor').tool.surface, selectTool('cursor').tool.binaries], ['cli', ['cursor-agent']]);
  assert.deepEqual([selectTool('cursor-ide').tool.surface, selectTool('dsh').tool.surface], ['ide', 'cli']);
  assert.deepEqual(selectTool('not-a-tool').status === 'refused' && selectTool('not-a-tool').code, 'tool-unknown');
  assert.equal(selectTool(42).code, 'tool-unknown');
  const all = listTools();
  assert.equal(all.status, 'ok');
  assert.equal(all.tools.length, 15, 'every registry tool is listed, observed or not');
  assert.deepEqual(listTools({ surface: 'ide' }).tools.map(tool => tool.id), ['cursor-ide', 'windsurf', 'zed', 'kiro-ide', 'copilot-vscode']);
  assert.equal(listTools({ includeUnobserved: true }).status, 'invalid');
  assert.ok(refusalCodes.some(item => item.code === 'tool-unknown'));
});

await check('plans and receipts carry ids only: the alias is refused in a plan', async () => {
  freshHome('alias');
  const folder = project('alias');
  const aliased = ownRequest(folder, { notes: { 'SKILL.md': '# Notes\n' } }, ['claude-code']);
  for (const step of aliased.plan.plan) step.clis = ['claude'];
  const refused = await prepare(aliased, { logging: 'off' });
  assert.deepEqual([refused.status, refused.code], ['refused', 'tool-unknown'], JSON.stringify(refused));
  const profiled = ownRequest(folder, { notes: { 'SKILL.md': '# Notes\n' } }, ['claude-code']);
  profiled.profiles = [{ ...profiled.profiles[0], id: 'claude' }];
  assert.equal((await prepare(profiled, { logging: 'off' })).code, 'tool-unknown');
  const request = ownRequest(folder, { notes: { 'SKILL.md': '# Notes\n' } }, ['claude-code']);
  const ready = await prepare(request, { logging: 'off' });
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  const run = await apply(ready.handle, { approved: true, origin: 'automation', reviewDigest: ready.review.reviewDigest }, { logging: 'off' });
  assert.equal(run.completion, 'complete');
  const inventory = await list({ target: { project: folder }, scope: 'project' });
  assert.deepEqual(inventory.entries.map(entry => entry.clis), [['claude-code']]);
  assert.equal(JSON.stringify(inventory).includes('"claude"'), false, 'no alias in the inventory');
});

// Two fixture CLIs on PATH that only print a version.
const bin = join(scratch, 'bin');
mkdirSync(bin);
const fakeCli = (name, line) => {
  if (process.platform === 'win32') writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\necho ${line}\r\n`);
  else { writeFileSync(join(bin, name), `#!/bin/sh\necho "${line}"\n`); chmodSync(join(bin, name), 0o755); }
};
fakeCli('codex', 'codex-cli 0.150.0');
fakeCli('claude', '2.1.400 (Claude Code)');
// Only the fixture CLIs, Node and (on Windows) the system folder that runs .cmd files: no real CLI of this host is seen.
process.env.PATH = [bin, dirname(process.execPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])].join(delimiter);
for (const key of Object.keys(process.env)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete process.env[key];
const profiles = [
  { schema: 'urn:aihq:catalog:tool-profile:0.1.0', id: 'codex', name: 'Codex', version: 3, checkedWith: [{ app: 'codex', version: '0.166.0', date: '2026-11-02' }] },
  { schema: 'urn:aihq:catalog:tool-profile:0.1.0', id: 'claude-code', name: 'Claude Code', version: 4, checkedWith: [{ app: 'claude-code', version: '2.1.316', date: '2026-11-02' }] },
  { schema: 'urn:aihq:catalog:tool-profile:0.1.0', id: 'kiro', name: 'Kiro', version: 4, checkedWith: [{ app: 'kiro-cli', version: '2.37.1', date: '2026-11-02' }] }];

await check('inspect warns, never blocks, when a CLI is older than its profile, and says "version not compared" without one', async () => {
  const home = freshHome('inspect');
  const result = await inspect({ target: ['codex', 'claude', 'kiro'], offline: true, profiles });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.deepEqual(validateFormat(result), { status: 'ok', schema: 'urn:aihq:core:inspection:0.1.0' });
  assert.equal(result.subject, 'machine');
  const byTool = Object.fromEntries(result.versions.map(item => [item.tool, item]));
  assert.deepEqual([byTool.codex.comparison, byTool.codex.installed, byTool.codex.checkedWith], ['older', '0.150.0', { app: 'codex', version: '0.166.0' }]);
  assert.deepEqual([byTool['claude-code'].comparison, byTool['claude-code'].installed], ['not-older', '2.1.400']);
  assert.deepEqual([byTool.kiro.comparison, byTool.kiro.reason], ['not-compared', 'not-installed']);
  assert.deepEqual(result.warnings.map(item => [item.code, item.tool]), [['cli-older-than-profile', 'codex']]);
  assert.deepEqual(result.tools.filter(item => item.selection === 'requested').map(item => [item.target, item.tool]),
    [['claude', 'claude-code'], ['codex', 'codex'], ['kiro', 'kiro']]);
  const bare = await inspect({ target: 'codex', offline: true });
  const codex = bare.versions.find(item => item.tool === 'codex');
  assert.deepEqual([codex.comparison, codex.reason], ['not-compared', 'no-profile']);
  assert.match(codex.message, /^Version not compared/);
  assert.equal(bare.warnings.length, 0);
  assert.equal(tree(join(home, '.aih')), null, 'inspection keeps no state');
});

await check('malformed or alias profiles are invalid with exact problems', async () => {
  const broken = await inspect({ target: 'codex', offline: true, profiles: [{ id: 'codex', version: 3, checkedWith: 'fixture' }] });
  assert.deepEqual(broken, { status: 'invalid', problems: [{ path: '/profiles/0/checkedWith', reason: 'checkedWith',
    message: 'A tool profile lists the app versions its facts were checked with.' }] });
  const alias = await inspect({ offline: true, profiles: [{ ...profiles[1], id: 'claude' }] });
  assert.deepEqual(alias.problems.map(item => [item.path, item.reason]), [['/profiles/0/id', 'tool-unknown']]);
  assert.equal((await inspect({ target: 'nothing-known', offline: true })).status, 'invalid');
  assert.equal((await inspect({ targets: 'codex' })).status, 'invalid', 'a malformed retained request is answered, not thrown');
  assert.deepEqual((await inspect({ unknown: true })).problems.map(item => item.reason), ['request-field']);
  const controller = new AbortController(); controller.abort();
  assert.equal((await inspect({ target: 'codex', offline: true }, { signal: controller.signal })).observation, 'cancelled');
});

await check('aih inspect prints the inspection and reads profiles from a folder', () => {
  freshHome('inspect-cli');
  const folder = join(scratch, 'profiles');
  mkdirSync(folder);
  profiles.forEach(item => writeFileSync(join(folder, `${item.id}.json`), JSON.stringify(item)));
  const shown = aih(['inspect', '--target', 'codex', '--offline', '--profiles', folder, '--json']);
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(shown.result.warnings.map(item => item.tool), ['codex']);
  assert.equal(shown.result.options.profiles, 3);
  writeFileSync(join(folder, 'broken.json'), '{"id":');
  assert.deepEqual([aih(['inspect', '--profiles', folder, '--json']).code, aih(['inspect', '--profiles', folder, '--json']).result.code], [2, 'request-unreadable']);
  assert.equal(aih(['inspect', '--no-such-option']).code, 2);
});

await check('checkFiles compares a plan with the disk and changes nothing', async () => {
  const home = freshHome('check-plan');
  const folder = project('check-plan');
  const request = ownRequest(folder, { alpha: { 'SKILL.md': '# Alpha\n' }, beta: { 'SKILL.md': '# Beta\n' } }, ['claude-code']);
  const absent = await checkFiles(request);
  assert.deepEqual(validateFormat(absent), { status: 'ok', schema: 'urn:aihq:core:file-check:0.1.0' });
  assert.deepEqual([absent.request, absent.observation, absent.fileState], ['plan', 'complete', 'changed']);
  assert.deepEqual(absent.targets.map(item => [item.target.path, item.outcome]),
    [['.claude/skills/alpha/SKILL.md', 'absent'], ['.claude/skills/beta/SKILL.md', 'absent']]);
  mkdirSync(join(folder, '.claude', 'skills', 'alpha'), { recursive: true });
  mkdirSync(join(folder, '.claude', 'skills', 'beta'), { recursive: true });
  writeFileSync(join(folder, '.claude', 'skills', 'alpha', 'SKILL.md'), '# Alpha\n');
  writeFileSync(join(folder, '.claude', 'skills', 'beta', 'SKILL.md'), '# Beta, edited\n');
  const changed = await checkFiles(request);
  assert.deepEqual(changed.targets.map(item => item.outcome), ['match', 'changed']);
  assert.equal(changed.fileState, 'changed');
  writeFileSync(join(folder, '.claude', 'skills', 'beta', 'SKILL.md'), '# Beta\n');
  const matched = await checkFiles(request);
  assert.deepEqual([matched.observation, matched.fileState, matched.coverage.comparedTargets], ['complete', 'match', 2]);
  assert.equal(readFileSync(join(folder, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'), '# Alpha\n');
  assert.equal(tree(join(home, '.aih')), null, 'no state, history or receipts');
  assert.deepEqual(tree(folder), ['.claude', '.claude/skills', '.claude/skills/alpha', '.claude/skills/alpha/SKILL.md', '.claude/skills/beta',
    '.claude/skills/beta/SKILL.md'].map(path => path.split('/').join(process.platform === 'win32' ? '\\' : '/')).sort());
  const missing = ownRequest(folder, { alpha: { 'SKILL.md': '# Alpha\n' } }, ['claude-code']);
  missing.files[0].bytes = Buffer.from('# Not alpha\n');
  assert.equal((await checkFiles(missing)).code, 'source-mismatch');
  assert.equal((await checkFiles({ schema: 'urn:aihq:core:plan-request:9.0.0' })).status, 'unsupported-version');
  assert.equal((await checkFiles({ schema: 'something-else' })).status, 'invalid');
  assert.equal((await checkFiles(request, { logging: 'on' })).status, 'invalid');
});

await check('checkFiles compares a change and aih check-files exits by its outcome', async () => {
  const home = freshHome('check-change');
  const folder = project('check-change');
  const change = { schema: 'urn:aihq:core:change:0.1.0', id: 'team-setting', description: 'Team setting', inputs: {}, materials: [],
    targets: ['project'], prerequisites: [], checks: [], operations: [{ id: 'set', purpose: 'Set the formatter', kind: 'config.entries',
      scope: 'project', format: 'json', target: { root: 'project', segments: [{ literal: '.team' }, { literal: 'settings.json' }] },
      set: [{ path: ['formatter'], value: 'prettier' }], requires: [], checks: [] }] };
  const request = { schema: 'urn:aihq:core:change-request:0.1.0', mode: 'vibe', scope: 'project', target: { project: folder },
    changes: [{ managementId: 'team-setting', change, inputs: {}, requires: [] }] };
  const absent = await checkFiles(request);
  assert.deepEqual(validateFormat(absent).status, 'ok', JSON.stringify(absent));
  assert.deepEqual([absent.request, absent.fileState, absent.targets[0].outcome, absent.targets[0].steps], ['change', 'changed', 'absent', ['set']]);
  mkdirSync(join(folder, '.team'));
  writeFileSync(join(folder, '.team', 'settings.json'), '{\n  "formatter": "prettier"\n}\n');
  const file = join(scratch, 'change-request.json');
  writeFileSync(file, JSON.stringify(request));
  const matched = aih(['check-files', file, '--json']);
  assert.deepEqual([matched.code, matched.result.observation, matched.result.fileState], [0, 'complete', 'match'], matched.stderr);
  writeFileSync(join(folder, '.team', 'settings.json'), '{ "formatter": "biome" }\n');
  assert.equal(aih(['check-files', file, '--json']).code, 1);
  assert.equal(aih(['check-files', join(scratch, 'missing.json'), '--json']).code, 2);
  assert.equal(tree(join(home, '.aih')), null, 'no state, history or receipts');
});

await check('inspectToolHost and detectProjectFacts answer with structured envelopes', async () => {
  freshHome('host');
  const folder = project('host');
  const item = { framework: 'local', itemId: 'notes', kind: 'skill', key: 'notes' };
  const host = await inspectToolHost({ tool: 'claude', project: folder, items: [item] });
  assert.deepEqual([host.schema, host.subject, host.status, host.tool.id], ['urn:aihq:core:inspection:0.1.0', 'tool-host', 'ok', 'claude-code']);
  assert.equal(validateFormat(host).status, 'ok', JSON.stringify(validateFormat(host)));
  assert.deepEqual([(await inspectToolHost({ tool: 'cursor', project: folder, items: [item] })).code], ['tool-not-observed']);
  assert.deepEqual([(await inspectToolHost({ tool: 'nope', project: folder, items: [item] })).code], ['tool-unknown']);
  const bad = await inspectToolHost({ tool: 'claude-code', project: 'relative', items: [item] });
  assert.deepEqual([bad.status, bad.problems[0].reason], ['invalid', 'project']);
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const facts = await detectProjectFacts({ project: folder });
  assert.notEqual(facts.status, 'invalid');
  const wrong = await detectProjectFacts({ project: 'relative' });
  assert.deepEqual([wrong.status, wrong.problems[0].path], ['invalid', '/project']);
});

await check('resolveStateLocation returns ok or refused home-unavailable, never throws', () => {
  const home = freshHome('state');
  const located = resolveStateLocation();
  assert.equal(located.status, 'ok');
  assert.equal(located.root, join(home, '.aih', 'core'));
  assert.deepEqual(located.markers.map(marker => marker.path), ['ownership', 'recovery', 'runs'].map(name => join(home, '.aih', 'core', name)));
  assert.equal(existsSync(located.root), false, 'nothing is created');
  process.env.HOME = process.env.USERPROFILE = join(scratch, 'no-such-home');
  assert.deepEqual(resolveStateLocation().status === 'refused' && resolveStateLocation().code, 'home-unavailable');
});

await check('report snapshots: create, validate, export and import, with versions and malformed input answered', async () => {
  const home = freshHome('report');
  const diagnostic = await diagnose({ requestId: 'report', targets: ['node'], network: 'off' });
  const created = createReport({ diagnostic, producer: { name: '@aihq/core', version: '0.1.0', revision: null },
    observedAt: '2026-11-04T00:00:00.000Z', acquisition: 'newly-acquired', redaction: { homePaths: [home] } });
  assert.equal(created.status, 'ok', JSON.stringify(created));
  assert.equal(created.snapshot.schema, 'urn:aihq:core:report:0.1.0');
  assert.deepEqual(validateFormat(created.snapshot).status, 'ok');
  assert.deepEqual(validateSnapshot(created.snapshot), { status: 'ok', schema: 'urn:aihq:core:report:0.1.0' });
  const exported = exportSnapshot(created.snapshot);
  assert.equal(exported.status, 'ok');
  const imported = importSnapshot(exported.json);
  assert.deepEqual(imported, { status: 'ok', snapshot: created.snapshot });
  assert.equal(exportSnapshot(imported.snapshot).json, exported.json, 'export is deterministic');
  const old = JSON.stringify({ ...created.snapshot, schema: 'urn:aihq:report:snapshot:1.0.0' });
  assert.deepEqual(importSnapshot(old), { status: 'unsupported-version', encountered: 'urn:aihq:report:snapshot:1.0.0', supported: ['urn:aihq:core:report:0.1.0'] });
  assert.equal(importSnapshot('{"schema":').status, 'invalid');
  assert.equal(importSnapshot(exported.json.replace('{"schema"', '{"status":"completed","schema"')).status, 'invalid', 'a repeated key is refused');
  assert.equal(importSnapshot(42).status, 'invalid');
  assert.equal(validateSnapshot({ schema: 'urn:aihq:core:report:0.1.0' }).status, 'invalid');
  assert.equal(createReport({ diagnostic: {} }).status, 'invalid');
  const secret = 'not-for-reports-' + sha256('x').slice(0, 8);
  const redacted = createReport({ diagnostic: { ...diagnostic, observations: [{ id: 'x', target: 'node', detail: `token ${secret}` }] },
    producer: { name: '@aihq/core', version: '0.1.0', revision: null }, observedAt: '2026-11-04T00:00:00.000Z', acquisition: 'supplied',
    redaction: { secretValues: [secret] } });
  assert.equal(JSON.stringify(redacted).includes(secret), false);
  const markdown = renderSupportMarkdown({ kind: 'inspect', result: await inspect({ target: 'node', offline: true }) }, { platform: 'unknown' });
  assert.equal(markdown.status, 'rendered');
  assert.match(markdown.markdown, /Status: complete|Status: incomplete/);
});

await check('claim sets: exact predicates, versions and malformed input answered without throwing', () => {
  const valid = schemas['urn:aihq:core:claims:0.1.0'].fixtures.valid;
  assert.deepEqual(validateClaimSet(valid), { status: 'ok', schema: 'urn:aihq:core:claims:0.1.0' });
  const read = readClaimSet(JSON.stringify(valid));
  assert.deepEqual(read, { status: 'ok', claimSet: valid });
  const projected = projectClaims(valid);
  assert.equal(projected.status, 'ok');
  assert.equal(projected.projection.source.schema, 'urn:aihq:core:claims:0.1.0');
  assert.equal(validateClaimSet({ ...valid, schema: 'urn:aihq:report:claims:1.1.0' }).status, 'unsupported-version');
  assert.equal(projectClaims({ ...valid, schema: 'urn:aihq:report:claims:1.0.0' }).status, 'unsupported-version');
  const rejected = readClaimSet('{"schema":"urn:aihq:core:claims:0.1.0"}');
  assert.deepEqual([rejected.status, rejected.original], ['invalid', '{"schema":"urn:aihq:core:claims:0.1.0"}']);
  assert.equal(projectClaims(schemas['urn:aihq:core:claims:0.1.0'].fixtures.invalid).status, 'invalid');
});

console.log(JSON.stringify({ status: 'passed', checks }));
