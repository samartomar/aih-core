// Typed plan input bindings (contract 4.1, C59, C63; Catalog D121): ordinary and secret values land only at the places
// a plan marks, through the built public entries in a disposable home and project. Producer documents are Core-side
// fixtures (test/fixtures/plan-fixture.mjs), not Catalog output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apply, list, prepare, prepareRemoval } from '../dist/core/index.js';
import { validateFormat } from '../dist/core/contracts.js';
import { ENV_REFERENCE, inputProfile, mergeRequest, ownRequest, sha256 } from './fixtures/plan-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-inputs-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home;
before(() => { home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const approve = (review, extra = {}) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...extra });
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
let counter = 0;
function project(files = {}) {
  const path = join(scratch, `project-${counter++}`);
  mkdirSync(path);
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(path, name)), { recursive: true }); writeFileSync(join(path, name), text); }
  return path;
}
/** Every byte Core keeps in its state (receipts, history), except its protected recovery material. */
function stateText() {
  let text = '';
  const walk = dir => { if (!existsSync(dir)) return; for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'recovery') walk(path); } else text += readFileSync(path, 'utf8');
  } };
  walk(join(home, '.aih', 'core'));
  return text;
}
const removeAll = async (target, managementId) => {
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId }] });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  return apply(removal.handle, approve(removal.review));
};

const GITHUB = 'local-my-setup.mcp.github';
const SECRET = 'ghp_0123456789abcdefSECRETVALUE';
const declared = (extra = {}) => ({ [GITHUB]: {
  GITHUB_HOST: { description: 'Host', isRequired: true, isSecret: false },
  GITHUB_TOKEN: { description: 'Token', isRequired: true, isSecret: true }, ...extra } });
/** The GitHub MCP entry as Catalog lowers it: the host marker in an argv slot, the token at a pointer the entry lacks. */
const github = (extra = {}) => ({ item: GITHUB, file: '.mcp.json', format: 'json', key: '/mcpServers/github',
  entry: { type: 'stdio', command: 'npx', args: ['-y', '@example/github-mcp@1.0.0', '--host', '{GITHUB_HOST}'] },
  inputs: [{ item: GITHUB, input: 'GITHUB_HOST', at: { argv: 4 } }, { item: GITHUB, input: 'GITHUB_TOKEN', at: { pointer: '/env/GITHUB_TOKEN' } }],
  ...extra });
const request = (target, { references = {}, values = { GITHUB_HOST: 'github.example.com' }, merges = [github()], inputs = declared() } = {}) =>
  ({ ...mergeRequest(target, merges, { inputs, profiles: [inputProfile('claude-code', references)] }), inputs: { [GITHUB]: values } });

test('an ordinary value lands in its argv slot and a secret is written as the client\'s own reference where the profile declares one', async () => {
  const target = project();
  const ready = await prepare(request(target, { references: { 'mcp-env': ENV_REFERENCE } }));
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  conforms(ready.review);
  const [step] = ready.review.steps;
  assert.deepEqual(step.inputs, [
    { item: GITHUB, input: 'GITHUB_HOST', at: { argv: 4 }, secret: false, written: 'value', from: 'inputs', value: 'github.example.com' },
    { item: GITHUB, input: 'GITHUB_TOKEN', at: { pointer: '/env/GITHUB_TOKEN' }, secret: true, written: 'reference', from: null }]);
  assert.deepEqual(ready.review.warnings, [], 'a reference holds no secret');
  const run = await apply(ready.handle, approve(ready.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual(JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8')).mcpServers.github,
    { type: 'stdio', command: 'npx', args: ['-y', '@example/github-mcp@1.0.0', '--host', 'github.example.com'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } });
  assert.ok(stateText().includes('github.example.com'), 'the receipt keeps the ordinary value');
  assert.equal((await removeAll(target, GITHUB)).completion, 'complete');
});

test('without a declared reference a secret is written as its value with a named-file warning, appears in no review, history or receipt, and a changed private input rejects Apply', async () => {
  const target = project();
  const controls = () => ({ privateInputs: { [GITHUB]: { GITHUB_TOKEN: SECRET } } });
  const ready = await prepare(request(target), controls());
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  conforms(ready.review);
  assert.deepEqual(ready.review.warnings.length, 1);
  assert.match(ready.review.warnings[0], /`\.mcp\.json`.*this file will hold a secret/);
  const [step] = ready.review.steps;
  assert.deepEqual(step.inputs[1], { item: GITHUB, input: 'GITHUB_TOKEN', at: { pointer: '/env/GITHUB_TOKEN' }, secret: true, written: 'value', from: 'privateInputs' });
  assert.equal(step.entry.env.GITHUB_TOKEN, '[REDACTED]');
  assert.equal(JSON.stringify(ready).includes(SECRET), false, 'the review never holds the secret');
  // A different secret at Apply is a changed private input: rejected, nothing written.
  const changed = await apply(ready.handle, approve(ready.review), { privateInputs: { [GITHUB]: { GITHUB_TOKEN: SECRET + 'x' } } });
  assert.deepEqual([changed.completion, changed.code, changed.changed], ['rejected', 'REVIEW_STALE', 'input']);
  assert.equal(existsSync(join(target, '.mcp.json')), false);
  // The same values apply; the value is in the file and nowhere in Core's state.
  const again = await prepare(request(target), controls());
  const run = await apply(again.handle, approve(again.review), controls());
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8')).mcpServers.github.env.GITHUB_TOKEN, SECRET);
  assert.equal(JSON.stringify(run).includes(SECRET), false);
  assert.equal(stateText().includes(SECRET), false, 'receipts and history never hold the secret');
  const listed = await list({ target: { project: target }, scope: 'project' });
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
  assert.equal((await removeAll(target, GITHUB)).completion, 'complete');
});

test('a required value nobody supplied is input-missing, an input no step marks is input-binding-missing, and undeclared or misplaced values are invalid, all before any effect', async () => {
  const target = project();
  const missingHost = await prepare(request(target, { values: {} }), { privateInputs: { [GITHUB]: { GITHUB_TOKEN: SECRET } } });
  assert.deepEqual([missingHost.status, missingHost.code, missingHost.item, missingHost.input], ['refused', 'input-missing', GITHUB, 'GITHUB_HOST'], JSON.stringify(missingHost));
  const missingToken = await prepare(request(target));
  assert.deepEqual([missingToken.status, missingToken.code, missingToken.input], ['refused', 'input-missing', 'GITHUB_TOKEN'], JSON.stringify(missingToken));
  // The plan marks no place for the token (a Catalog without R11): refused, never guessed (C63).
  const unmarked = await prepare(request(target, { merges: [github({ inputs: [{ item: GITHUB, input: 'GITHUB_HOST', at: { argv: 4 } }] })] }),
    { privateInputs: { [GITHUB]: { GITHUB_TOKEN: SECRET } } });
  assert.deepEqual([unmarked.status, unmarked.code, unmarked.item, unmarked.input], ['refused', 'input-binding-missing', GITHUB, 'GITHUB_TOKEN'], JSON.stringify(unmarked));
  const invalid = [
    ['a secret in the request', request(target, { values: { GITHUB_HOST: 'h', GITHUB_TOKEN: SECRET } }), {}],
    ['an undeclared value', request(target, { values: { GITHUB_HOST: 'h', OTHER: 'x' } }), {}],
    ['an ordinary value as a private input', request(target), { privateInputs: { [GITHUB]: { GITHUB_TOKEN: SECRET, GITHUB_HOST: 'h' } } }],
    ['a binding of an undeclared input', request(target, { merges: [github({ inputs: [...github().inputs, { item: GITHUB, input: 'NOPE', at: { pointer: '/env/NOPE' } }] })] }),
      { privateInputs: { [GITHUB]: { GITHUB_TOKEN: SECRET } } }],
    ['a binding with two destinations', request(target, { merges: [github({ inputs: [{ item: GITHUB, input: 'GITHUB_HOST', at: { argv: 4, env: 'X' } }] })] }), {}],
    ['a binding at a slot the entry already fills', request(target, { merges: [github({ inputs: [{ item: GITHUB, input: 'GITHUB_HOST', at: { argv: 1 } },
      { item: GITHUB, input: 'GITHUB_TOKEN', at: { pointer: '/env/GITHUB_TOKEN' } }] })] }), { privateInputs: { [GITHUB]: { GITHUB_TOKEN: SECRET } } }],
  ];
  for (const [name, body, controls] of invalid) {
    const result = await prepare(body, controls);
    assert.equal(result.status, 'invalid', `${name}: ${JSON.stringify(result)}`);
    assert.equal(JSON.stringify(result).includes(SECRET), false, name);
  }
  assert.equal(existsSync(join(target, '.mcp.json')), false);
});

test('an optional input takes its default or is left out, and an omitted marker slot is dropped', async () => {
  const target = project();
  const inputs = declared({ GITHUB_HOST: { description: 'Host', isRequired: false, isSecret: false, default: 'github.com' },
    GITHUB_TOKEN: { description: 'Token', isRequired: false, isSecret: true },
    GITHUB_ORG: { description: 'Org', isRequired: false, isSecret: false } });
  const merge = github({ entry: { ...github().entry, args: [...github().entry.args, '{GITHUB_ORG}'] },
    inputs: [...github().inputs, { item: GITHUB, input: 'GITHUB_ORG', at: { argv: 5 } }] });
  const ready = await prepare(request(target, { values: {}, merges: [merge], inputs }));
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.deepEqual(ready.review.steps[0].inputs.map(row => [row.input, row.written, row.from, row.value]),
    [['GITHUB_HOST', 'value', 'default', 'github.com'], ['GITHUB_TOKEN', 'omitted', null, undefined], ['GITHUB_ORG', 'omitted', null, undefined]]);
  assert.equal((await apply(ready.handle, approve(ready.review))).completion, 'complete');
  assert.deepEqual(JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8')).mcpServers.github,
    { type: 'stdio', command: 'npx', args: ['-y', '@example/github-mcp@1.0.0', '--host', 'github.com'] });
});

test('a declared placeholder in a written file takes its value with the file format\'s escaping, and only that marker is replaced', async () => {
  const target = project();
  const skill = { 'SKILL.md': '---\nname: notes\n---\nPost to {{TEAM}} at {TEAM} literally.\n', 'config.json': '{ "team": "{{TEAM}}" }\n' };
  const built = ownRequest(target, { notes: skill }, ['claude-code']);
  const item = built.contents[0].items[0];
  item.requirements = { inputs: { TEAM: { description: 'Team', isRequired: true, isSecret: false, placeholder: { sourcePath: 'notes/SKILL.md', marker: '{{TEAM}}' } } } };
  const jsonItem = { ...structuredClone(item), id: 'local-my-skills.skill.config', name: 'config', files: item.files.filter(file => file.sourcePath.endsWith('.json')),
    requirements: { inputs: { TEAM: { description: 'Team', isRequired: true, isSecret: false, placeholder: { sourcePath: 'notes/config.json', marker: '{{TEAM}}' } } } } };
  item.files = item.files.filter(file => file.sourcePath.endsWith('.md'));
  built.contents[0].items.push(jsonItem);
  built.plan.plan = [
    { op: 'write', item: item.id, root: 'project', path: '.claude/skills/notes/SKILL.md', from: { item: item.id, sourcePath: 'notes/SKILL.md' }, clis: ['claude-code'],
      inputs: [{ item: item.id, input: 'TEAM', at: { placeholder: '{{TEAM}}' } }] },
    { op: 'write', item: jsonItem.id, root: 'project', path: '.claude/notes/config.json', from: { item: jsonItem.id, sourcePath: 'notes/config.json' }, clis: ['claude-code'],
      inputs: [{ item: jsonItem.id, input: 'TEAM', at: { placeholder: '{{TEAM}}' } }] }];
  const team = 'Core "infra" \ ops';
  built.inputs = { [item.id]: { TEAM: 'core-infra' }, [jsonItem.id]: { TEAM: team } };
  const ready = await prepare(built);
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  conforms(ready.review);
  assert.equal((await apply(ready.handle, approve(ready.review))).completion, 'complete');
  assert.equal(readFileSync(join(target, '.claude/skills/notes/SKILL.md'), 'utf8'), '---\nname: notes\n---\nPost to core-infra at {TEAM} literally.\n');
  assert.deepEqual(JSON.parse(readFileSync(join(target, '.claude/notes/config.json'), 'utf8')), { team });
  // A value that would break a Markdown line is refused rather than written.
  const other = project();
  const broken = structuredClone({ ...built, target: { project: other } });
  broken.files = built.files; broken.inputs[item.id].TEAM = 'two\nlines';
  assert.equal((await prepare(broken)).status, 'invalid');
  // A placeholder the item does not declare for that file is invalid.
  const undeclared = structuredClone({ ...built, target: { project: other } });
  undeclared.files = built.files; undeclared.plan.plan[0].inputs[0].at.placeholder = '{TEAM}';
  assert.equal((await prepare(undeclared)).status, 'invalid');
});

test('an environment-name binding and a TOML table entry take their values in the entry\'s own format', async () => {
  const target = project();
  const codexMcp = { stdio: { command: 'command', args: 'args', env: 'env' } };
  const entry = { command: 'npx', args: ['-y', '@example/github-mcp@1.0.0'] };
  const merge = { item: GITHUB, file: '.codex/config.toml', format: 'toml', key: 'mcp_servers.github', entry, clis: ['codex'],
    inputs: [{ item: GITHUB, input: 'GITHUB_HOST', at: { env: 'GITHUB_HOST' } }, { item: GITHUB, input: 'GITHUB_TOKEN', at: { pointer: '/env/GITHUB_TOKEN' } }] };
  const body = { ...mergeRequest(target, [merge], { inputs: declared(), profiles: [inputProfile('codex', {}, { mcpFile: codexMcp })] }),
    inputs: { [GITHUB]: { GITHUB_HOST: 'gh "enterprise"' } } };
  const ready = await prepare(body, { privateInputs: { [GITHUB]: { GITHUB_TOKEN: SECRET } } });
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.equal(JSON.stringify(ready).includes(SECRET), false);
  assert.match(ready.review.warnings[0], /`\.codex\/config\.toml`.*this file will hold a secret/);
  const run = await apply(ready.handle, approve(ready.review), { privateInputs: { [GITHUB]: { GITHUB_TOKEN: SECRET } } });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const text = readFileSync(join(target, '.codex/config.toml'), 'utf8');
  assert.match(text, /\[mcp_servers\.github\.env\]|env = \{|\[mcp_servers\.github\]/);
  assert.ok(text.includes('GITHUB_HOST = "gh \\"enterprise\\""'), text);
  assert.ok(text.includes(`GITHUB_TOKEN = "${SECRET}"`), text);
  assert.equal(stateText().includes(SECRET), false);
});
