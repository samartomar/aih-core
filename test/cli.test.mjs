import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { policy } from './fixture.mjs';
import { COMMIT, TOKEN, enterprisePolicy, failingRoutes, orgRoutes } from './fixtures/github-org.mjs';

test('CLI evidence opt-in reports unavailable evidence without changing setup exit status', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-cli-evidence-'));
  const home = join(root, 'home'), project = join(root, 'project'); mkdirSync(home); mkdirSync(project);
  const document = policy();
  document.evidence = [{ schema: 'urn:aihq:scan:evidence-association:1.0.0', scanId: `scan:sha256:${'a'.repeat(64)}`,
    location: { kind: 'file', path: join(root, 'missing.scan.json') } }];
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(document));
  const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
  const run = flags => spawnSync(process.execPath, [cli, 'policy', file, '--project', project, '--json', ...flags], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 20_000
  });
  try {
    const skipped = run([]); assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(JSON.parse(skipped.stdout).evidence[0].reason, 'not-requested');
    const preview = run(['--evidence']); assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(JSON.parse(preview.stdout).evidence[0].reason, 'unavailable');
    const applied = run(['--evidence', '--apply', '--yes']); assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.completion, 'complete'); assert.equal(result.evidence[0].reason, 'unavailable');
    assert.equal(readFileSync(join(project, 'TEAM.md'), 'utf8'), "Read the project's contribution guide.\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI reports authenticated production and malformed evidence through the same successful setup path', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-cli-production-evidence-'));
  const home = join(root, 'home'), project = join(root, 'project'); mkdirSync(home); mkdirSync(project);
  const bytes = readFileSync(new URL('./fixtures/evidence/production.scan.json', import.meta.url));
  const artifactPath = join(root, 'report.scan.json'), file = join(root, 'policy.json');
  const document = policy(); document.evidence = [{ schema: 'urn:aihq:scan:evidence-association:1.0.0',
    scanId: JSON.parse(bytes).scanId, location: { kind: 'file', path: artifactPath } }];
  writeFileSync(file, JSON.stringify(document));
  const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
  try {
    for (const [input, expected] of [[bytes, 'authenticated'], [Buffer.from('{bad'), 'malformed']]) {
      writeFileSync(artifactPath, input);
      const run = spawnSync(process.execPath, [cli, 'policy', file, '--project', project, '--json', '--evidence', '--apply', '--yes'], {
        encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 20_000
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const result = JSON.parse(run.stdout); assert.equal(result.completion, 'complete');
      assert.equal(result.evidence[0].reason ?? result.evidence[0].status, expected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test('CLI explicitly reconciles a management set and accepts repeated empty-set application', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-core-lifecycle-cli-'));
  const home = join(root, 'home'), project = join(root, 'project'); mkdirSync(home); mkdirSync(project);
  const file = join(root, 'policy.json'), cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
  const document = policy(); document.managedSelections = [{ id: 'guidance', scope: 'project', members: [document.selections[0].managementId] }];
  const run = flags => spawnSync(process.execPath, [cli, 'policy', file, '--project', project, '--json', ...flags], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 30_000
  });
  try {
    writeFileSync(file, JSON.stringify(document));
    const initial = run(['--apply', '--yes']); assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    writeFileSync(file, JSON.stringify({ schema: document.schema, mode: 'vibe', selections: [],
      managedSelections: [{ id: 'guidance', scope: 'project', members: [] }] }));
    const preview = run([]); assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(JSON.parse(preview.stdout).review.operations[0].effects, 'remove-file');
    assert.equal(existsSync(join(project, 'TEAM.md')), true);
    const removed = run(['--apply', '--yes']); assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(existsSync(join(project, 'TEAM.md')), false);
    const again = run(['--apply', '--yes']); assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(JSON.parse(again.stdout).completion, 'complete');
    assert.deepEqual(JSON.parse(again.stdout).operations, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function enterpriseCli(routes) {
  const root = mkdtempSync(join(tmpdir(), 'aih-core-enterprise-cli-'));
  const home = join(root, 'home'); const project = join(root, 'project'); mkdirSync(home); mkdirSync(project);
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(enterprisePolicy()));
  const fixture = join(root, 'github.json'); writeFileSync(fixture, JSON.stringify({ routes }));
  const calls = join(root, 'calls.jsonl');
  const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
  const preload = new URL('./fixtures/fake-github-fetch.mjs', import.meta.url).href;
  const flags = ['--org-repository', 'Example-Org/Org-Policy', '--org-path', 'policy/org.json', '--org-ref', `commit:${COMMIT}`];
  const run = (args, env = {}, policyFile = file) => spawnSync(process.execPath, ['--import', preload, cli, 'policy', policyFile,
    '--project', project, '--json', ...args], { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, AIH_TEST_GITHUB_FIXTURE: fixture, AIH_TEST_GITHUB_CALLS: calls, ...env } });
  const requests = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { root, home, project, file, flags, run, requests, cli };
}
function leaks(directory, text) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() ? leaks(path, text) : readFileSync(path).includes(text)) return true;
  }
  return false;
}

test('CLI Enterprise preview and apply read the organization with one in-memory credential and never print it', () => {
  const fixture = enterpriseCli(orgRoutes());
  try {
    const env = { AIH_TEST_ORG_TOKEN: TOKEN };
    const preview = fixture.run([...fixture.flags, '--org-token-env', 'AIH_TEST_ORG_TOKEN'], env);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(JSON.parse(preview.stdout).review.mode, 'enterprise');
    assert.equal(existsSync(join(fixture.project, 'TEAM.md')), false);
    const applied = fixture.run([...fixture.flags, '--org-token-env', 'AIH_TEST_ORG_TOKEN', '--apply', '--yes'], env);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.equal(JSON.parse(applied.stdout).completion, 'complete');
    assert.equal(readFileSync(join(fixture.project, 'TEAM.md'), 'utf8'), "Read the project's contribution guide.\n");
    const requests = fixture.requests();
    assert.equal(requests.length, 4 + 4 + 4, 'preview, Prepare and Apply each read the organization');
    assert.ok(requests.every(request => request.authorization === `Bearer ${TOKEN}`));
    for (const output of [preview, applied]) assert.equal((output.stdout + output.stderr).includes(TOKEN), false);
    assert.equal(leaks(fixture.home, TOKEN), false);
    assert.equal(leaks(fixture.project, TOKEN), false);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('CLI without a token flag reads unauthenticated and ignores ambient token variables', () => {
  const fixture = enterpriseCli(orgRoutes());
  try {
    const result = fixture.run(fixture.flags, { GITHUB_TOKEN: TOKEN, GH_TOKEN: TOKEN });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(fixture.requests().every(request => request.authorization === undefined));
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('CLI validates the organization flags before reading anything', () => {
  const fixture = enterpriseCli(orgRoutes());
  const vibe = join(fixture.root, 'vibe.json'); writeFileSync(vibe, JSON.stringify(policy()));
  try {
    const [repository, path, ref] = [fixture.flags.slice(0, 2), fixture.flags.slice(2, 4), fixture.flags.slice(4)];
    const rejected = [
      fixture.run([]), fixture.run([...repository, ...path]), fixture.run([...repository, ...ref]),
      fixture.run([...repository, ...path, '--org-ref', 'main']), fixture.run([...repository, ...path, '--org-ref', 'commit:']),
      fixture.run(['--org-repository', 'no-slash', ...path, ...ref]),
      fixture.run([...fixture.flags, '--org-token-env', 'AIH_TEST_UNSET_TOKEN']),
      fixture.run([...fixture.flags, '--org-token-env', 'AIH_TEST_EMPTY_TOKEN'], { AIH_TEST_EMPTY_TOKEN: '' }),
      fixture.run(fixture.flags, {}, vibe), fixture.run(['--org-token-env', 'AIH_TEST_ORG_TOKEN'], { AIH_TEST_ORG_TOKEN: TOKEN }, vibe)
    ];
    for (const result of rejected) assert.equal(result.status, 2, result.stdout + result.stderr);
    for (const result of rejected) assert.equal((result.stdout + result.stderr).includes(TOKEN), false);
    assert.equal(fixture.requests().length, 0);
    const repair = spawnSync(process.execPath, [fixture.cli, 'repair', 'node-npm-ca', '--target', 'node', '--inputs-file',
      join(fixture.root, 'inputs.json'), ...fixture.flags, '--json'], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(repair.status, 2);
    assert.equal(JSON.parse(repair.stdout).diagnostics[0].reason, 'cli-options');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('CLI maps authority failure and denial previews to exit 2 without leaking the credential', () => {
  const failing = enterpriseCli(failingRoutes(401));
  try {
    const result = failing.run([...failing.flags, '--org-token-env', 'AIH_TEST_ORG_TOKEN'], { AIH_TEST_ORG_TOKEN: TOKEN });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, 'blocked');
    assert.equal(body.diagnostics[0].code, 'AUTHORITY_UNAVAILABLE');
    assert.equal((result.stdout + result.stderr).includes(TOKEN), false);
    assert.equal(leaks(failing.home, TOKEN), false);
  } finally { rmSync(failing.root, { recursive: true, force: true }); }
  const denying = enterpriseCli(orgRoutes({ bytes: Buffer.from(JSON.stringify({ schema: 'urn:aihq:core:organization-policy:1.0.0',
    id: 'other', selections: [{ selectionId: 'someone-else', recipeIdentity: `sha256:${'2'.repeat(64)}`, scopes: ['project'], inputs: {} }] })) }));
  try {
    const result = denying.run(denying.flags);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].reason, 'selection-not-admitted');
    assert.equal(existsSync(join(denying.project, 'TEAM.md')), false);
  } finally { rmSync(denying.root, { recursive: true, force: true }); }
});
