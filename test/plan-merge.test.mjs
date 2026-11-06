// Plan `merge` steps (contract 7, 8.1, 14): planned entries and guidance blocks added to files a person may already have,
// through the built public entries in a disposable home and project. Producer documents are Core-side fixtures
// (test/fixtures/plan-fixture.mjs), not Catalog output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apply, list, prepare, prepareRemoval } from '../dist/core/index.js';
import { ENV_REFERENCE, inputProfile, mergeRequest, sha256 } from './fixtures/plan-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-merge-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home;
before(() => { home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const approve = (review, extra = {}) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...extra });
let counter = 0;
function project(files = {}) {
  const path = join(scratch, `project-${counter++}`);
  mkdirSync(path);
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(path, name)), { recursive: true }); writeFileSync(join(path, name), text); }
  return path;
}
function snapshot(folder) {
  const out = {};
  const walk = (dir, prefix) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(join(dir, entry.name), rel); else out[rel] = readFileSync(join(dir, entry.name), 'utf8');
  } };
  walk(folder, '');
  return out;
}
/** Every byte Core keeps in its state (receipts, history), except its protected recovery material. */
function stateText() {
  const root = join(home, '.aih', 'core');
  let text = '';
  const walk = dir => { if (!existsSync(dir)) return; for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'recovery') walk(path); } else text += readFileSync(path, 'utf8');
  } };
  walk(root);
  return text;
}
const remove = async (target, managementId, extra = {}) => {
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId }] });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  return apply(removal.handle, approve(removal.review, extra));
};

const GITHUB = 'local-my-setup.mcp.github';
const SECRET = 'ghp_0123456789abcdefSECRET';
const MINE = '{\n  "mcpServers": {\n    "github": { "command": "my-github", "env": { "GITHUB_TOKEN": "' + SECRET + '" } },\n' +
  '    "other": {"command":"keep-me"}\n  }\n}\n';
const github = (extra = {}) => ({ item: GITHUB, file: '.mcp.json', format: 'json', key: '/mcpServers/github',
  entry: { command: 'npx', args: ['-y', '@example/github-mcp'] },
  inputs: [{ item: GITHUB, input: 'GITHUB_TOKEN', at: { pointer: '/env/GITHUB_TOKEN' } }], ...extra });
/** The entry as written: the fixture profile declares Claude's `${NAME}` reference for MCP environment values. */
const writtenEntry = () => ({ ...github().entry, env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } });
const githubProfiles = [inputProfile('claude-code', { 'mcp-env': ENV_REFERENCE })];
const githubInputs = { [GITHUB]: { GITHUB_TOKEN: { description: 'Token', isRequired: true, isSecret: true } } };
const githubRequest = (target, resolutions) => ({ ...mergeRequest(target, [github()], { inputs: githubInputs, profiles: githubProfiles }), ...(resolutions ? { resolutions } : {}) });

test('your own .mcp.json entry blocks with its exact bytes (secret slot redacted), a replace resolution is reviewed and applied, and removal writes your bytes back', async () => {
  const target = project({ '.mcp.json': MINE });
  const blocked = await prepare(githubRequest(target));
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  assert.equal(blocked.handle, undefined);
  assert.equal(blocked.review.conflicts.length, 1, JSON.stringify(blocked.review.conflicts));
  const [conflict] = blocked.review.conflicts;
  assert.deepEqual([conflict.code, conflict.reason, conflict.target, conflict.key, conflict.observedSha256],
    ['STATE_CONFLICT', 'existing-content', '.mcp.json', '/mcpServers/github', sha256(MINE)]);
  assert.deepEqual(conflict.choices, ['replace', 'skip'], 'adopt is offered only for identical bytes');
  assert.equal(conflict.existing, '{ "command": "my-github", "env": { "GITHUB_TOKEN": "[REDACTED]" } }');
  assert.deepEqual(conflict.redacted, ['/mcpServers/github/env/GITHUB_TOKEN']);
  assert.equal(JSON.stringify(blocked).includes(SECRET), false, 'a known secret slot never appears in the review');

  const resolution = [{ managementId: GITHUB, step: conflict.step, choice: 'replace', observedSha256: conflict.observedSha256 }];
  const ready = await prepare(githubRequest(target, resolution));
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  const step = ready.review.steps.find(item => item.step === conflict.step);
  assert.deepEqual([step.op, step.effect, step.path, step.format, step.key], ['merge', 'replace-file', '.mcp.json', 'json', '/mcpServers/github']);
  assert.match(step.sentence, /your original is kept for restore/);
  assert.notEqual(ready.review.reviewDigest, blocked.review.reviewDigest);

  const run = await apply(ready.handle, approve(ready.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const written = JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8'));
  assert.deepEqual(written.mcpServers.github, writtenEntry());
  assert.match(readFileSync(join(target, '.mcp.json'), 'utf8'), /"other": \{"command":"keep-me"\}/, 'neighbouring bytes are kept byte for byte');
  assert.equal(stateText().includes(SECRET), false, 'receipts and history never hold the replaced secret');
  const listed = await list({ target: { project: target }, scope: 'project' });
  assert.deepEqual(listed.entries.map(row => [row.managementId, row.members.map(member => [member.kind, member.pointer, member.state])]),
    [[GITHUB, [['config-entry', '/mcpServers/github', 'matching']]]]);

  assert.equal((await remove(target, GITHUB)).completion, 'complete');
  assert.equal(readFileSync(join(target, '.mcp.json'), 'utf8'), MINE, 'removal restores your entry byte for byte');
});

test('a resolution for bytes that changed is blocked again with the new facts, an edit after review rejects Apply, adopt needs identical bytes, and skip needs partial approval', async () => {
  const target = project({ '.mcp.json': MINE });
  const blocked = await prepare(githubRequest(target));
  const [conflict] = blocked.review.conflicts;
  const choose = (choice, observedSha256 = conflict.observedSha256) => [{ managementId: GITHUB, step: conflict.step, choice, observedSha256 }];
  // The file changes between the person's choice and the second Prepare: blocked again, with the new digest.
  const edited = MINE.replace('my-github', 'my-github-2');
  writeFileSync(join(target, '.mcp.json'), edited);
  const again = await prepare(githubRequest(target, choose('replace')));
  assert.equal(again.status, 'blocked', JSON.stringify(again));
  assert.deepEqual([again.handle, again.review.conflicts[0].observedSha256, again.review.conflicts[0].detail], [undefined, sha256(edited), 'resolution-stale']);
  // A fresh, matching resolution gives a ready review; an edit before Apply rejects it and writes nothing.
  const ready = await prepare(githubRequest(target, choose('replace', sha256(edited))));
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  writeFileSync(join(target, '.mcp.json'), MINE);
  const stale = await apply(ready.handle, approve(ready.review));
  assert.deepEqual([stale.completion, stale.code, stale.changed], ['rejected', 'REVIEW_STALE', 'target-file']);
  assert.equal(readFileSync(join(target, '.mcp.json'), 'utf8'), MINE);
  // Adopt is not offered for different bytes, and a forced adopt is not used.
  const forced = await prepare(githubRequest(target, choose('adopt', sha256(MINE))));
  assert.notEqual(forced.status, 'ready', JSON.stringify(forced));
  assert.equal(forced.handle, undefined);
  // Skip leaves the entry out: partial, which needs explicit partial approval, and the file is untouched.
  const skip = () => prepare(githubRequest(target, choose('skip', sha256(MINE))));
  const skipped = await skip();
  assert.equal(skipped.status, 'partial', JSON.stringify(skipped));
  assert.equal(skipped.review.steps[0].effect, 'skipped');
  assert.equal((await apply(skipped.handle, approve(skipped.review))).reason, 'partial-approval-required');
  const retry = await skip();
  assert.notEqual((await apply(retry.handle, approve(retry.review, { allowPartial: true }))).completion, 'rejected');
  assert.equal(readFileSync(join(target, '.mcp.json'), 'utf8'), MINE);

  // Identical bytes Core didn't write: still blocked, offering adopt (and skip); adopting claims them without a write.
  // (Core's own bytes for the entry: what a fresh install writes.)
  const fresh = project();
  const first = await prepare(githubRequest(fresh));
  assert.equal((await apply(first.handle, approve(first.review))).completion, 'complete');
  const same = readFileSync(join(fresh, '.mcp.json'), 'utf8');
  const twin = project({ '.mcp.json': same });
  const identical = await prepare(githubRequest(twin));
  assert.equal(identical.status, 'blocked', JSON.stringify(identical));
  assert.deepEqual(identical.review.conflicts[0].choices, ['adopt', 'skip']);
  const adopted = await prepare(githubRequest(twin, [{ managementId: GITHUB, step: 0, choice: 'adopt', observedSha256: sha256(same) }]));
  assert.equal(adopted.status, 'ready', JSON.stringify(adopted));
  assert.equal((await apply(adopted.handle, approve(adopted.review))).completion, 'complete');
  assert.equal(readFileSync(join(twin, '.mcp.json'), 'utf8'), same);
  assert.equal((await list({ target: { project: twin }, scope: 'project' })).entries[0].members[0].state, 'matching');
});

test('a managed entry you edited is keep-changed: a replace resolution never overwrites it, and removal keeps it', async () => {
  const target = project({ '.mcp.json': '{\n  "mcpServers": {}\n}\n' });
  const installed = await prepare(githubRequest(target));
  assert.equal(installed.status, 'ready', JSON.stringify(installed));
  assert.equal((await apply(installed.handle, approve(installed.review))).completion, 'complete');
  const mine = readFileSync(join(target, '.mcp.json'), 'utf8').replace('"npx"', '"my-npx"');
  writeFileSync(join(target, '.mcp.json'), mine);
  const again = await prepare(githubRequest(target, [{ managementId: GITHUB, step: 0, choice: 'replace', observedSha256: sha256(mine) }]));
  assert.notEqual(again.status, 'ready', JSON.stringify(again));
  const [conflict] = again.review.conflicts;
  assert.deepEqual([conflict.reason, conflict.choices], ['managed-content-changed', []]);
  if (again.handle) assert.notEqual((await apply(again.handle, approve(again.review, { allowPartial: true }))).completion, 'rejected');
  assert.equal(readFileSync(join(target, '.mcp.json'), 'utf8'), mine, 'your edit is never overwritten');
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: GITHUB }] });
  assert.deepEqual(removal.entries[0].members.map(member => member.action), ['keep-changed']);
  if (removal.handle) await apply(removal.handle, approve(removal.review, { allowPartial: true }));
  assert.equal(readFileSync(join(target, '.mcp.json'), 'utf8'), mine);
});

const CODEX_MCP = 'local-my-setup.mcp.codex-github';
const toml = (extra = {}) => ({ item: CODEX_MCP, file: '.codex/config.toml', format: 'toml', key: 'mcp_servers.github', clis: ['codex'],
  entry: { command: 'npx', args: ['-y', '@example/github-mcp'], env: { GITHUB_HOST: 'github.example.com' } }, ...extra });

test('a TOML table is added beside your settings and removed byte for byte; your own table blocks, and a replace is restored', async () => {
  const settings = 'model = "o5"\n# my comment\n\n[profiles.work]\nmodel = "o5-pro"\n';
  const target = project({ '.codex/config.toml': settings });
  const prepared = await prepare(mergeRequest(target, [toml()]));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.deepEqual([prepared.review.steps[0].sentence, prepared.review.steps[0].effect], ['Adds `mcp_servers.github` to `.codex/config.toml`', 'replace-file']);
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const written = readFileSync(join(target, '.codex/config.toml'), 'utf8');
  assert.ok(written.startsWith(settings), written);
  assert.match(written, /\[mcp_servers\.github\]\r?\ncommand = "npx"\r?\nargs = \["-y", "@example\/github-mcp"\]/);
  assert.match(written, /\[mcp_servers\.github\.env\]\r?\nGITHUB_HOST = "github\.example\.com"/);
  assert.equal((await remove(target, CODEX_MCP)).completion, 'complete');
  assert.equal(readFileSync(join(target, '.codex/config.toml'), 'utf8'), settings, 'removal takes the tables Core created with it');

  // Your own [mcp_servers.github] with a key the entry doesn't name: blocked (never merged into), replace or skip only.
  const yours = 'model = "o5"\n\n[mcp_servers.github]\ncommand = "mine"\nurl = "https://example.test/mcp"\n';
  const second = project({ '.codex/config.toml': yours });
  const blocked = await prepare(mergeRequest(second, [toml()]));
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  const [conflict] = blocked.review.conflicts;
  assert.deepEqual([conflict.key, conflict.choices, conflict.existing],
    ['mcp_servers.github', ['replace', 'skip'], '[mcp_servers.github]\ncommand = "mine"\nurl = "https://example.test/mcp"\n']);
  const replaced = await prepare({ ...mergeRequest(second, [toml()]),
    resolutions: [{ managementId: CODEX_MCP, step: 0, choice: 'replace', observedSha256: conflict.observedSha256 }] });
  assert.equal(replaced.status, 'ready', JSON.stringify(replaced));
  assert.equal((await apply(replaced.handle, approve(replaced.review))).completion, 'complete');
  assert.match(readFileSync(join(second, '.codex/config.toml'), 'utf8'), /command = "npx"/);
  assert.equal((await remove(second, CODEX_MCP)).completion, 'complete');
  assert.equal(readFileSync(join(second, '.codex/config.toml'), 'utf8'), yours, 'removal writes your table back byte for byte');
});

const RULE = 'local-my-setup.rule.style';
const block = (text, extra = {}) => ({ item: RULE, file: 'AGENTS.md', format: 'markdown', key: RULE, entry: text, clis: ['codex'], ...extra });

test('a Markdown block lands beside your guidance and is removed byte for byte; Codex AGENTS.md is checked whole against 32 KiB before any write', async () => {
  const guidance = '# My project\n\nUse tabs.\n';
  const target = project({ 'AGENTS.md': guidance });
  const prepared = await prepare(mergeRequest(target, [block('Prefer small functions.\n')]));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.review.steps[0].sentence, `Adds the \`${RULE}\` block to \`AGENTS.md\``);
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  assert.equal(readFileSync(join(target, 'AGENTS.md'), 'utf8'),
    `${guidance}<!-- aih:begin ${RULE} -->\nPrefer small functions.\n<!-- aih:end ${RULE} -->\n`);
  assert.equal((await remove(target, RULE)).completion, 'complete');
  assert.equal(readFileSync(join(target, 'AGENTS.md'), 'utf8'), guidance);

  // 30 KiB of yours plus a 4 KiB block passes Codex's limit: refused, naming the file and size, nothing written.
  const large = '# Mine\n' + 'x'.repeat(30 * 1024) + '\n';
  const big = project({ 'AGENTS.md': large });
  const before = snapshot(big);
  const refused = await prepare(mergeRequest(big, [block('y'.repeat(4 * 1024) + '\n')]));
  assert.deepEqual([refused.status, refused.code, refused.file, refused.handle], ['refused', 'file-too-large-for-client', 'AGENTS.md', undefined], JSON.stringify(refused));
  assert.ok(refused.size > 32 * 1024);
  assert.deepEqual(snapshot(big), before);
  // The same block for a CLI other than Codex is not bounded by Codex's limit.
  assert.equal((await prepare(mergeRequest(big, [block('y'.repeat(4 * 1024) + '\n', { clis: ['claude-code'] })]))).status, 'ready');
  // Your own block with the same markers: blocked with its exact bytes; a reviewed replace is restored on removal.
  const own = `${guidance}<!-- aih:begin ${RULE} -->\nMy own rule.\n<!-- aih:end ${RULE} -->\n`;
  const third = project({ 'AGENTS.md': own });
  const blocked = await prepare(mergeRequest(third, [block('Prefer small functions.\n')]));
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  assert.equal(blocked.review.conflicts[0].existing, `<!-- aih:begin ${RULE} -->\nMy own rule.\n<!-- aih:end ${RULE} -->\n`);
  const replaced = await prepare({ ...mergeRequest(third, [block('Prefer small functions.\n')]),
    resolutions: [{ managementId: RULE, step: 0, choice: 'replace', observedSha256: sha256(own) }] });
  assert.equal(replaced.status, 'ready', JSON.stringify(replaced));
  assert.equal((await apply(replaced.handle, approve(replaced.review))).completion, 'complete');
  assert.equal((await remove(third, RULE)).completion, 'complete');
  assert.equal(readFileSync(join(third, 'AGENTS.md'), 'utf8'), own);
});

test('a malformed merge step is invalid, and a merge leaving its root is refused, before any effect', async () => {
  const target = project({ '.mcp.json': MINE });
  const before = snapshot(target);
  const cases = [
    ['the whole document as a key', { key: '' }, 'invalid'],
    ['an unknown format', { format: 'yaml' }, 'invalid'],
    ['a TOML entry that is not a table', { format: 'toml', key: 'mcp_servers.github', entry: 'text' }, 'invalid'],
    ['a TOML key that is not a bare table', { format: 'toml', key: 'mcp_servers."git.hub"' }, 'invalid'],
    ['a Markdown entry that is not text', { format: 'markdown', key: GITHUB, entry: { text: 1 } }, 'invalid'],
    ['a Markdown entry holding another block\'s end marker', { format: 'markdown', key: GITHUB, entry: 'Text.\n<!-- aih:end other -->\n' }, 'invalid'],
    ['a Markdown entry holding another block\'s start marker', { format: 'markdown', key: GITHUB, entry: '<!-- aih:begin other -->\nText.\n' }, 'invalid'],
    ['a Markdown entry holding a shared block marker', { format: 'markdown', key: GITHUB, entry: '<!-- BEGIN aih:shared -->\n' }, 'invalid'],
    ['a binding without a pointer', { inputs: [{ item: GITHUB, input: 'GITHUB_TOKEN', at: { argv: 1 } }] }, 'invalid'],
    ['a file leaving its root', { file: '../.mcp.json' }, 'refused'],
  ];
  for (const [name, change, status] of cases) {
    const result = await prepare(mergeRequest(target, [github(change)], { inputs: githubInputs, profiles: githubProfiles }));
    assert.equal(result.status, status, `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.handle, undefined, name);
  }
  assert.deepEqual(snapshot(target), before);
});

test('an MCP entry is bound to the item\'s scanned server.json: a command, arguments or URL it does not declare is refused', async () => {
  const declared = (server, entry) => {
    const request = mergeRequest(project(), [{ item: 'local-my-setup.mcp.search', file: '.mcp.json', format: 'json', key: '/mcpServers/search', entry }]);
    const bytes = Buffer.from(JSON.stringify(server));
    const file = { sourceId: 'local-my-setup', sourcePath: 'mcp/search/server.json', sha256: sha256(bytes), bytes: bytes.length, executable: false, role: 'content' };
    request.contents[0].items[0].files = [file];
    request.files = [{ sourceId: file.sourceId, sourcePath: file.sourcePath, sha256: file.sha256, bytes }];
    return prepare(request);
  };
  const npm = { name: 'search', packages: [{ registryType: 'npm', identifier: 'search-mcp', version: '1.2.3', runtimeHint: 'npx',
    runtimeArguments: [{ type: 'positional', value: '-y' }], packageArguments: [{ type: 'positional', value: '{ROOT}' }], transport: { type: 'stdio' } }] };
  // Catalog's lowering of the package: its runner, the runner's flags, the exact package and the package's arguments.
  const ok = await declared(npm, { type: 'stdio', command: 'npx', args: ['-y', 'search-mcp@1.2.3', '{ROOT}'] });
  assert.equal(ok.status, 'ready', JSON.stringify(ok).slice(0, 1500));
  for (const entry of [{ type: 'stdio', command: 'node', args: ['-y', 'search-mcp@1.2.3', '{ROOT}'] },
    { type: 'stdio', command: 'npx', args: ['-y', 'search-mcp@9.9.9', '{ROOT}'] }, { type: 'stdio', command: 'npx', args: ['-y', 'search-mcp@1.2.3', '{ROOT}', '--eval'] }]) {
    const refused = await declared(npm, entry);
    assert.deepEqual([refused.status, refused.code], ['refused', 'source-mismatch'], JSON.stringify(entry));
  }
  const remote = { name: 'search', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.test/search' }] };
  assert.equal((await declared(remote, { type: 'http', url: 'https://mcp.example.test/search' })).status, 'ready');
  const elsewhere = await declared(remote, { type: 'http', url: 'https://other.example.test/search' });
  assert.deepEqual([elsewhere.status, elsewhere.code], ['refused', 'source-mismatch']);
});

test('every MCP entry for an item with a scanned server.json is bound to it, whatever the step\'s owners, and never sets a loader variable', async () => {
  const npm = { name: 'search', packages: [{ registryType: 'npm', identifier: 'search-mcp', version: '1.2.3', runtimeHint: 'npx',
    runtimeArguments: [{ type: 'positional', value: '-y' }], environmentVariables: [{ name: 'SEARCH_KEY' }], transport: { type: 'stdio' } }] };
  const good = { type: 'stdio', command: 'npx', args: ['-y', 'search-mcp@1.2.3'] };
  const evil = { type: 'stdio', command: 'node', args: ['-e', 'evil'] };
  const item = 'local-my-setup.mcp.search';
  const make = (entry, { server = npm, supply = true, name = 'server.json', shape } = {}) => {
    const request = mergeRequest(project(), [{ item, file: '.mcp.json', format: 'json', key: '/mcpServers/search', entry }]);
    const bytes = Buffer.from(JSON.stringify(server));
    const file = { sourceId: 'local-my-setup', sourcePath: `mcp/search/${name}`, sha256: sha256(bytes), bytes: bytes.length, executable: false, role: 'content' };
    request.contents[0].items[0].files = [file];
    if (supply) request.files = [{ sourceId: file.sourceId, sourcePath: file.sourcePath, sha256: file.sha256, bytes }];
    shape?.(request);
    return prepare(request);
  };
  const outcome = async (...args) => { const result = await make(...args); return [result.status, result.code ?? result.problems?.[0]?.reason]; };
  assert.deepEqual(await outcome(good), ['ready', undefined]);
  // The plan lists the item's server.json but withholds its bytes.
  assert.deepEqual(await outcome(evil, { supply: false }), ['refused', 'source-missing']);
  // Two owners, or the framework as owner: the MCP item is still found and bound.
  assert.deepEqual(await outcome(evil, { shape: request => {
    const step = request.plan.plan[0]; delete step.item; step.items = [item, 'local-my-setup.skill.other'].sort();
    request.contents[0].items.push({ id: 'local-my-setup.skill.other', kind: 'skill', name: 'other', description: 'other', files: [] }); } }), ['refused', 'source-mismatch']);
  assert.deepEqual(await outcome(evil, { shape: request => { const step = request.plan.plan[0]; delete step.item; step.framework = 'local-my-setup'; } }),
    ['refused', 'source-mismatch']);
  // Another item's claim that it is an AI setup's MCP item exempts nothing unless that setup is acquired.
  assert.deepEqual(await outcome(evil, { shape: request => request.contents[0].items.push({ id: 'local-my-setup.ai-setup.claim', kind: 'ai-setup',
    name: 'claim', description: 'claim', files: [], aiSetup: { version: '1.0.0', mcpItem: item } }) }), ['refused', 'source-mismatch']);
  // A registry Core can't lower, a server file named otherwise, and an environment key the file doesn't declare.
  assert.deepEqual(await outcome(evil, { server: { name: 'search', packages: [{ registryType: 'oci', identifier: 'x', version: '1' }] } }), ['refused', 'source-mismatch']);
  assert.deepEqual(await outcome(evil, { name: 'Server.json' }), ['refused', 'source-mismatch']);
  assert.deepEqual(await outcome({ ...good, env: { SEARCH_KEY: 'x' } }), ['ready', undefined]);
  assert.deepEqual(await outcome({ ...good, env: { OTHER: 'x' } }), ['refused', 'source-mismatch']);
  // A literal loader variable in any MCP entry's environment, with or without a server.json.
  const loader = mergeRequest(project(), [{ item: 'local-my-setup.mcp.plain', file: '.mcp.json', format: 'json', key: '/mcpServers/plain',
    entry: { command: 'tool', env: { node_options: '--require=x' } } }]);
  const refused = await prepare(loader);
  assert.deepEqual([refused.status, refused.problems?.[0]?.reason], ['invalid', 'loader-variable']);
});

test('an MCP merge writes one whole server entry that equals its MCP item\'s, with only allowlisted keys', async () => {
  const npm = { name: 'search', packages: [{ registryType: 'npm', identifier: 'search-mcp', version: '1.2.3', runtimeHint: 'npx',
    runtimeArguments: [{ type: 'positional', value: '-y' }], transport: { type: 'stdio' } }] };
  const remote = { name: 'search', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.test/search' }] };
  const item = 'local-my-setup.mcp.search';
  const good = { type: 'stdio', command: 'npx', args: ['-y', 'search-mcp@1.2.3'] };
  const attempt = async ({ key = '/mcpServers/search', entry = good, server = npm, format = 'json', shape } = {}) => {
    const request = mergeRequest(project(), [{ item, file: format === 'toml' ? '.codex/config.toml' : '.mcp.json', format, key, entry,
      ...(format === 'toml' ? { clis: ['codex'] } : {}) }]);
    const bytes = Buffer.from(JSON.stringify(server));
    const file = { sourceId: 'local-my-setup', sourcePath: 'mcp/search/server.json', sha256: sha256(bytes), bytes: bytes.length, executable: false, role: 'content' };
    request.contents[0].items[0].files = [file];
    request.files = [{ sourceId: file.sourceId, sourcePath: file.sourcePath, sha256: file.sha256, bytes }];
    shape?.(request);
    const result = await prepare(request);
    return [result.status, result.code ?? result.problems?.[0]?.reason];
  };
  assert.deepEqual(await attempt(), ['ready', undefined]);
  // Not one whole server: a field of it, its environment, the container itself.
  assert.deepEqual(await attempt({ key: '/mcpServers/search/command', entry: 'evil' }), ['refused', 'mcp-entry-shape']);
  assert.deepEqual(await attempt({ key: '/mcpServers/search/env', entry: { NODE_OPTIONS: '--require=x' },
    shape: request => { delete request.plan.plan[0].item; request.plan.plan[0].framework = 'local-my-setup'; } }), ['refused', 'mcp-entry-shape']);
  assert.deepEqual(await attempt({ key: 'mcp_servers.search.env', entry: { X: '1' }, format: 'toml' }), ['refused', 'mcp-entry-shape']);
  assert.deepEqual(await attempt({ key: '/mcpServers', entry: { search: good },
    shape: request => { delete request.plan.plan[0].item; request.plan.plan[0].framework = 'local-my-setup'; } }), ['refused', 'mcp-entry-shape']);
  // A server name no MCP item of the step's content has, or one written by another framework.
  assert.deepEqual(await attempt({ key: '/mcpServers/srch', entry: { command: 'evil' },
    shape: request => { delete request.plan.plan[0].item; request.plan.plan[0].framework = 'local-my-setup'; } }), ['refused', 'source-mismatch']);
  assert.deepEqual(await attempt({ entry: { command: 'evil' }, shape: request => {
    request.contents.push({ ...request.contents[0], framework: { id: 'other-setup', name: 'Other' }, sources: [{ id: 'other-setup', kind: 'local', notices: [] }],
      items: [{ id: 'other-setup.skill.x', kind: 'skill', name: 'x', description: 'x', files: [] }] });
    request.plan.plan[0].item = 'other-setup.skill.x'; } }), ['refused', 'source-mismatch']);
  // Keys no client's MCP entry takes from a plan, and fields of the other form.
  for (const extra of [{ cwd: '/tmp/planted' }, { envFile: '.env' }, { autoApprove: ['x'] }])
    assert.deepEqual(await attempt({ entry: { ...good, ...extra } }), ['refused', 'mcp-entry-shape'], JSON.stringify(extra));
  assert.deepEqual(await attempt({ entry: { ...good, type: 'http', url: 'https://evil.example.test/' } }), ['refused', 'source-mismatch']);
  assert.deepEqual(await attempt({ server: remote, entry: { url: 'https://mcp.example.test/search', command: 'evil' } }), ['refused', 'source-mismatch']);
  assert.deepEqual(await attempt({ server: remote, entry: { type: 'http', url: 'https://mcp.example.test/search' } }), ['ready', undefined]);
});
