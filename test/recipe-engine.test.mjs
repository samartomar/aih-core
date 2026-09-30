import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, apply } from '../dist/core/index.js';
import { apply as applyWithGuard } from '../dist/core/recipe-engine.js';

const scratch = mkdtempSync(join(tmpdir(), 'aih-recipe-engine-'));
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => {
  const home = join(scratch, 'home'); mkdirSync(home);
  process.env.HOME = home; process.env.USERPROFILE = home;
});
after(() => {
  for (const [key, value] of Object.entries(previousHome)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const target = name => ({ root: 'project', segments: [{ literal: name }] });
const op = (id, kind, fields) => ({ id, purpose: `${id} fixture`, kind, scope: 'project', requires: [], checks: [], ...fields });
const document = (operations, checks = [], materials = []) => ({
  schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
    id: 'fixture', managementId: 'fixture-managed', scope: 'project', configuration: {}, requires: [],
    recipe: { inline: { schema: 'urn:aihq:core:recipe:1.0.0', id: 'fixture-recipe',
      description: 'Focused recipe execution fixtures', inputs: {}, materials, targets: ['project'],
      prerequisites: [], operations, checks } }
  }]
});
const request = (project, policy, resolutions) => ({ useCase: 'policy', policy, target: { project },
  ...(resolutions ? { resolutions } : {}) });
const authorize = (prepared, extras = {}) => ({ approved: true, origin: 'automation',
  reviewDigest: prepared.review.reviewDigest, ...extras });
const controls = { logging: 'off' };

test('an asynchronous guard must settle before either a file or process effect begins', { timeout: 30_000 }, async () => {
  for (const kind of ['file', 'process']) {
    const project = mkdtempSync(join(scratch, `guard-${kind}-`));
    const sentinel = join(project, 'started.txt');
    const effect = kind === 'file' ? op('effect', 'file.write', {
      target: target('started.txt'), content: { literal: 'started' }
    }) : op('effect', 'process.run', {
      executable: { name: process.execPath },
      args: [{ literal: '-e' }, { literal: "require('node:fs').writeFileSync(process.env.AIH_SENTINEL,'started')" }],
      cwd: { root: 'project', segments: [] }, env: { AIH_SENTINEL: { literal: sentinel } },
      timeoutMs: 5000, maxOutputBytes: 1024, acceptedExitCodes: [0], effects: ['Write a start marker']
    });
    const prepared = await prepare(request(project, document([effect])), controls);
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    let guardCalls = 0; let entered; let rejectGate;
    const atGuard = new Promise(resolve => { entered = resolve; });
    const pending = new Promise((_resolve, reject) => { rejectGate = reject; });
    const resultPromise = applyWithGuard(prepared.prepared, authorize(prepared), controls, () => {
      guardCalls++;
      if (guardCalls === 2) { entered(); return pending; }
    });
    // A prerequisite rejection must fail this assertion, rather than leave the
    // test waiting for an effect boundary that Apply will never reach.
    await Promise.race([atGuard, resultPromise.then(result => {
      assert.fail(`Apply finished before the guard: ${JSON.stringify(result)}`);
    })]);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(existsSync(sentinel), false, `${kind} effect started before the guard settled`);
    rejectGate(new Error('review-stale'));
    const result = await resultPromise;
    assert.equal(result.completion, 'rejected', JSON.stringify(result));
    assert.equal(result.operations[0].application, 'not-attempted');
    assert.equal(existsSync(sentinel), false);
    assert.equal(guardCalls, 2);
  }
});

test('public Prepare/Apply edits JSONC, TOML and text blocks without changing neighboring content', async () => {
  const project = mkdtempSync(join(scratch, 'project-edit-'));
  const initial = {
    jsonc: Buffer.from('{\n  // retained note\n  "other": 7,\n  "nested": { "mode": "old" }\n}\n'),
    toml: Buffer.from('# retained heading\n[client]\nother = "keep" # retained\nmode = "old"\n'),
    text: Buffer.from('Human introduction.\n')
  };
  writeFileSync(join(project, 'settings.jsonc'), initial.jsonc);
  writeFileSync(join(project, 'settings.toml'), initial.toml);
  writeFileSync(join(project, 'NOTES.md'), initial.text);
  const policy = document([
    op('jsonc', 'config.entries', { target: target('settings.jsonc'), format: 'jsonc',
      entries: [{ path: ['nested', 'mode'], action: 'set', value: { literal: 'new' } }] }),
    op('toml', 'config.entries', { target: target('settings.toml'), format: 'toml',
      entries: [{ path: ['client', 'mode'], action: 'set', value: { literal: 'new' } }] }),
    op('text', 'text.block', { target: target('NOTES.md'), blockId: 'managed-note',
      startMarker: '<!-- AIH START managed-note -->', endMarker: '<!-- AIH END managed-note -->',
      action: 'set', content: { literal: 'Managed guidance.\n' } })
  ]);
  const resolutions = [
    { selectionId: 'fixture', operationId: 'jsonc', choice: 'replace', observedSha256: sha(initial.jsonc) },
    { selectionId: 'fixture', operationId: 'toml', choice: 'replace', observedSha256: sha(initial.toml) },
    { selectionId: 'fixture', operationId: 'text', choice: 'replace', observedSha256: sha(initial.text) }
  ];
  const prepared = await prepare(request(project, policy, resolutions), controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.deepEqual(prepared.review.operations.map(item => item.effects), ['replace-file', 'replace-file', 'replace-file']);
  assert.deepEqual(prepared.review.operations[0].details.entries,
    [{ path: ['nested', 'mode'], action: 'set', value: '"new"' }]);
  assert.deepEqual(prepared.review.operations[1].details.entries,
    [{ path: ['client', 'mode'], action: 'set', value: '"new"' }]);
  assert.equal(prepared.review.operations[2].details.content, 'Managed guidance.\n');
  assert.equal(prepared.review.operations[2].details.startMarker, '<!-- AIH START managed-note -->');
  assert.equal(readFileSync(join(project, 'settings.jsonc'), 'utf8'), initial.jsonc.toString());
  const result = await apply(prepared.prepared, authorize(prepared), controls);
  assert.equal(result.completion, 'complete', JSON.stringify(result));
  assert.deepEqual(result.operations.map(item => item.application), ['applied', 'applied', 'applied']);
  const jsonc = readFileSync(join(project, 'settings.jsonc'), 'utf8');
  assert.match(jsonc, /\/\/ retained note/); assert.match(jsonc, /"other": 7/); assert.match(jsonc, /"mode": "new"/);
  assert.equal(readFileSync(join(project, 'settings.toml'), 'utf8'),
    '# retained heading\n[client]\nother = "keep" # retained\nmode = "new"\n');
  assert.equal(readFileSync(join(project, 'NOTES.md'), 'utf8'),
    'Human introduction.\n<!-- AIH START managed-note -->\nManaged guidance.\n<!-- AIH END managed-note -->\n');
});

test('failed required process check blocks a dependent while explicit partial approval permits independent work', async () => {
  const project = mkdtempSync(join(scratch, 'project-check-'));
  mkdirSync(join(project, 'work'));
  const write = (id, name, text) => op(id, 'file.write', { target: target(name), content: { literal: text } });
  const a = write('a', 'A.md', 'A'); a.checks = ['verify-a'];
  const b = write('b', 'B.md', 'B'); b.requires = ['a'];
  const c = write('c', 'C.md', 'C');
  const check = { id: 'verify-a', purpose: 'Required process verification', kind: 'process.exit',
    executable: { name: process.execPath }, args: [{ literal: '-e' }, { literal: 'process.exit(5)' }],
    cwd: target('work'), env: {}, acceptedExitCodes: [0], timeoutMs: 5000, maxOutputBytes: 1024 };
  const prepared = await prepare(request(project, document([a, b, c], [check])), controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal(prepared.review.operations[0].checks[0].purpose, 'Required process verification');
  assert.equal(prepared.review.operations[0].checks[0].details.executable, process.execPath);
  assert.equal(prepared.review.operations[0].checks[0].details.executableSha256.length, 64);
  assert.deepEqual(prepared.review.operations[0].checks[0].details.acceptedExitCodes, [0]);
  assert.deepEqual(prepared.review.operations[0].checks[0].details.args, ['"-e"', '"process.exit(5)"']);
  const result = await apply(prepared.prepared, authorize(prepared, { allowPartial: true }), controls);
  assert.equal(result.completion, 'incomplete', JSON.stringify(result));
  const byId = Object.fromEntries(result.operations.map(item => [item.id, item]));
  assert.equal(byId['fixture/a'].application, 'applied');
  assert.equal(byId['fixture/a'].verification.status, 'failed');
  assert.equal(byId['fixture/b'].application, 'not-attempted');
  assert.equal(byId['fixture/b'].reason, 'dependency-not-satisfied');
  assert.equal(byId['fixture/c'].application, 'applied');
  assert.deepEqual(result.checks.map(item => ({ id: item.id, status: item.status })),
    [{ id: 'fixture/verify-a', status: 'failed' }]);
  assert.equal(result.checks[0].effectsUncertain, true);
  assert.equal(existsSync(join(project, 'A.md')), true);
  assert.equal(existsSync(join(project, 'B.md')), false);
  assert.equal(readFileSync(join(project, 'C.md'), 'utf8'), 'C');
});

test('prepared edit and stdin reviews redact sensitive values before JSON escaping', async () => {
  const project = mkdtempSync(join(scratch, 'project-private-review-'));
  mkdirSync(join(project, 'work'));
  const secret = 'quoted " and slash \\ plus\nnewline';
  const edit = op('edit', 'config.entries', { target: target('settings.json'), format: 'json',
    entries: [{ path: ['credential'], action: 'set', value: { input: 'secret' } }] });
  const run = op('run', 'process.run', { executable: { name: process.execPath },
    args: [{ literal: '-e' }, { literal: 'process.exit(0)' }], cwd: target('work'),
    env: { TOKEN: { input: 'secret' } }, stdin: { input: 'secret' },
    timeoutMs: 1000, maxOutputBytes: 1024, acceptedExitCodes: [0], effects: ['Verify token'] });
  const policy = document([edit, run]);
  policy.selections[0].recipe.inline.inputs.secret = { type: 'string', required: true, sensitive: true };
  const prepared = await prepare(request(project, policy), { ...controls,
    privateInputs: { fixture: { secret } } });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const review = JSON.stringify(prepared.review);
  assert.equal(review.includes(secret), false);
  assert.equal(review.includes(JSON.stringify(secret).slice(1, -1)), false);
  assert.equal(review.includes(sha(secret)), false);
  assert.equal(prepared.review.operations[0].details.entries[0].value, '[REDACTED]');
  assert.equal(prepared.review.operations[1].details.stdin, '[REDACTED]');
  assert.deepEqual(prepared.review.operations[1].details.env, { TOKEN: '"[REDACTED]"' });
});

test('opaque process requires reviewed approval and reports deadline with uncertain effects', async () => {
  const project = mkdtempSync(join(scratch, 'project-process-'));
  mkdirSync(join(project, 'work'));
  const sentinel = join(project, 'work', 'started.txt');
  const script = "require('node:fs').writeFileSync(process.env.AIH_SENTINEL, 'started'); setTimeout(() => {}, 60000)";
  const run = op('run', 'process.run', { executable: { name: process.execPath },
    args: [{ literal: '-e' }, { literal: script }], cwd: target('work'),
    env: { AIH_SENTINEL: { literal: sentinel } }, timeoutMs: 2000, maxOutputBytes: 1024,
    acceptedExitCodes: [0], effects: ['Write a start marker, then wait for the deadline.'] });
  const policy = document([run]);
  const prepared = await prepare(request(project, policy), controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal(prepared.review.operations[0].effects, 'opaque-process');
  assert.equal(prepared.review.operations[0].details.timeoutMs.value, 2000);
  assert.deepEqual(prepared.review.operations[0].details.acceptedExitCodes, [0]);
  assert.equal(prepared.review.operations[0].details.executableSha256.length, 64);
  assert.equal(existsSync(sentinel), false);
  const refused = await apply(prepared.prepared, undefined, controls);
  assert.equal(refused.completion, 'rejected');
  assert.equal(refused.diagnostics[0].code, 'APPROVAL_REQUIRED');
  assert.equal(existsSync(sentinel), false);
  const approved = await prepare(request(project, policy), controls);
  assert.equal(approved.status, 'ready', JSON.stringify(approved.diagnostics));
  const result = await apply(approved.prepared, authorize(approved), controls);
  assert.equal(result.completion, 'incomplete', JSON.stringify(result));
  assert.equal(result.operations[0].application, 'failed');
  assert.equal(result.operations[0].reason, 'deadline');
  assert.equal(result.operations[0].effectsUncertain, true);
  assert.equal(readFileSync(sentinel, 'utf8'), 'started');
});

test('referenced local recipe captures named closure and rejects source drift before Apply', async () => {
  const project = mkdtempSync(join(scratch, 'project-reference-'));
  const source = mkdtempSync(join(scratch, 'source-reference-'));
  const payload = Buffer.from('captured material\n');
  const material = { id: 'payload', path: 'payload.txt', sha256: sha(payload), byteLength: payload.length };
  const recipe = document([op('write', 'file.write', { target: target('OUTPUT.txt'), material: 'payload' })],
    [], [{ id: material.id, sha256: material.sha256, byteLength: material.byteLength }]).selections[0].recipe.inline;
  const rawRecipe = Buffer.from(JSON.stringify(recipe));
  writeFileSync(join(source, 'recipe.json'), rawRecipe);
  writeFileSync(join(source, 'payload.txt'), payload);
  const policy = document([]);
  policy.selections[0].recipe = { reference: { source: { kind: 'local', input: 'source' },
    path: 'recipe.json', sha256: sha(rawRecipe), byteLength: rawRecipe.length, materials: [material] } };
  const host = { ...controls, materialRoots: { source } };
  const prepared = await prepare(request(project, policy), host);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal(existsSync(join(project, 'OUTPUT.txt')), false);
  writeFileSync(join(source, 'payload.txt'), 'altered material\n');
  const stale = await apply(prepared.prepared, authorize(prepared), controls);
  assert.equal(stale.completion, 'rejected', JSON.stringify(stale));
  assert.equal(stale.diagnostics[0].code, 'REVIEW_STALE');
  assert.equal(existsSync(join(project, 'OUTPUT.txt')), false);
  writeFileSync(join(source, 'payload.txt'), payload);
  const fresh = await prepare(request(project, policy), host);
  assert.equal(fresh.status, 'ready', JSON.stringify(fresh.diagnostics));
  const result = await apply(fresh.prepared, authorize(fresh), controls);
  assert.equal(result.completion, 'complete', JSON.stringify(result));
  assert.deepEqual(readFileSync(join(project, 'OUTPUT.txt')), payload);
});

test('pre-cancelled Prepare and Apply expose no file effects', async () => {
  const project = mkdtempSync(join(scratch, 'project-cancel-'));
  const policy = document([op('write', 'file.write', { target: target('CANCELLED.md'), content: { literal: 'no effect' } })]);
  const aborted = new AbortController(); aborted.abort();
  const rejected = await prepare(request(project, policy), { ...controls, signal: aborted.signal });
  assert.equal(rejected.status, 'cancelled');
  const prepared = await prepare(request(project, policy), controls);
  assert.equal(prepared.status, 'ready');
  const result = await apply(prepared.prepared, authorize(prepared), { ...controls, signal: aborted.signal });
  assert.equal(result.completion, 'cancelled');
  assert.equal(existsSync(join(project, 'CANCELLED.md')), false);
});
