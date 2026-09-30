import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { policy } from './fixture.mjs';

test('CLI previews by default and applies only deliberate automation through the shared host', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-core-cli-'));
  const home = join(root, 'home'); const project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(policy()));
  const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
  const run = flags => spawnSync(process.execPath, [cli, 'policy', file, '--project', project, '--json', ...flags], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 20_000
  });
  try {
    const preview = run([]); assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).status, 'ready');
    assert.equal(existsSync(join(project, 'TEAM.md')), false);
    assert.equal(run(['--apply']).status, 2);
    const applied = run(['--apply', '--yes']); assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.completion, 'complete');
    assert.equal(result.operations[0].application, 'applied');
    assert.equal(result.authorization.origin, 'automation');
    assert.equal(readFileSync(join(project, 'TEAM.md'), 'utf8'), "Read the project's contribution guide.\n");
    assert.equal(run(['--yes']).status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI binds dotted private-input names without exposing their values', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-core-private-cli-'));
  const home = join(root, 'home'); const project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  const document = policy(); const selection = document.selections[0];
  selection.id = 'team.guidance'; selection.configuration = {};
  selection.recipe.inline.inputs = { 'text.content': { type: 'string', required: true, sensitive: true } };
  selection.recipe.inline.operations[0].content = { input: 'text.content' };
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(document));
  try {
    const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'policy', file, '--project', project, '--json', '--apply', '--yes',
      '--private-input', 'team%2Eguidance.text%2Econtent=AIHQ_TEST_PRIVATE'], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, AIHQ_TEST_PRIVATE: 'fixture-private-content' }
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).operations[0].id, 'team.guidance/write');
    assert.equal(result.stdout.includes('fixture-private-content'), false);
    assert.equal(readFileSync(join(project, 'TEAM.md'), 'utf8'), 'fixture-private-content');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI binds an explicit local material root to a referenced recipe', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-core-reference-cli-'));
  const home = join(root, 'home'); const project = join(root, 'project'); const source = join(root, 'source');
  mkdirSync(home); mkdirSync(project); mkdirSync(source);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const content = Buffer.from('referenced content\n');
  const document = policy(); const selection = document.selections[0];
  selection.recipe.inline.materials = [{ id: 'payload', sha256: digest(content), byteLength: content.length }];
  delete selection.recipe.inline.operations[0].content;
  selection.recipe.inline.operations[0].material = 'payload';
  const recipe = Buffer.from(JSON.stringify(selection.recipe.inline));
  writeFileSync(join(source, 'recipe.json'), recipe); writeFileSync(join(source, 'payload.txt'), content);
  selection.recipe = { reference: { source: { kind: 'local', input: 'selected' }, path: 'recipe.json',
    sha256: digest(recipe), byteLength: recipe.length,
    materials: [{ id: 'payload', path: 'payload.txt', sha256: digest(content), byteLength: content.length }] } };
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(document));
  try {
    const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
    const run = spawnSync(process.execPath, [cli, 'policy', file, '--project', project, '--json', '--apply', '--yes',
      '--material-root', `selected=${source}`], { encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout).completion, 'complete');
    assert.deepEqual(readFileSync(join(project, 'TEAM.md')), content);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI applies a narrow config edit only with an exact reviewed resolution file', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-core-resolution-cli-'));
  const home = join(root, 'home'); const project = join(root, 'project'); mkdirSync(home); mkdirSync(project);
  const before = Buffer.from('{\n  // retained\n  "other": 7,\n  "mode": "old"\n}\n');
  writeFileSync(join(project, 'settings.jsonc'), before);
  const document = policy(); const operation = document.selections[0].recipe.inline.operations[0];
  operation.kind = 'config.entries'; operation.target.segments = [{ literal: 'settings.jsonc' }];
  delete operation.content; operation.format = 'jsonc';
  operation.entries = [{ path: ['mode'], action: 'set', value: { literal: 'new' } }];
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(document));
  const resolutions = join(root, 'resolutions.json'); writeFileSync(resolutions, JSON.stringify({ resolutions: [{
    selectionId: document.selections[0].id, operationId: operation.id, choice: 'replace',
    observedSha256: createHash('sha256').update(before).digest('hex') }] }));
  try {
    const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
    const run = flags => spawnSync(process.execPath, [cli, 'policy', file, '--project', project, '--json', ...flags],
      { encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: home, USERPROFILE: home } });
    const blocked = run(['--apply', '--yes']); assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.equal(readFileSync(join(project, 'settings.jsonc'), 'utf8'), before.toString());
    const applied = run(['--apply', '--yes', '--resolutions', resolutions]); assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.match(readFileSync(join(project, 'settings.jsonc'), 'utf8'), /\/\/ retained/);
    assert.match(readFileSync(join(project, 'settings.jsonc'), 'utf8'), /"mode": "new"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
