import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Serialized into an outside consumer: every Core import uses a package export.
async function packedScenario() {
  const { default: assert } = await import('node:assert/strict');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const { prepare, apply, checkFileState } = await import('@aihq/core');
  const { contractSupport, parsePolicy, validateRecipe } = await import('@aihq/core/contracts');
  const ajv = new Ajv2020({ strict: true });
  for (const entry of contractSupport.contracts) {
    ajv.addSchema((await import(entry.schemaExport, { with: { type: 'json' } })).default);
  }
  const validate = value => {
    assert.ok(ajv.getSchema(value.schema), `exported schema for ${value.schema}`);
    assert.equal(ajv.validate(value.schema, value), true, JSON.stringify(ajv.errors));
  };
  const file = join(process.env.HOME, '.codex', 'config.toml');
  const original = `# Codex configuration
model = "gpt-6.1-sol"
model_reasoning_effort = "medium"

[projects."/home/u/p"]
trust_level = "trusted"

[mcp_servers."name.with.dots"]
command = "npx"
args = ["-y", "other-server"]

[tui]
notifications = true

# Trailing notes kept by the user
# second trailing line
`;
  const appended = `[mcp_servers.aih]
command = "node"
args = ["server.js", "--stdio"]
[mcp_servers.aih.env]
API_URL = "https://example.test"
`;
  const op = (id, path, value) => ({ id, purpose: `Manage Codex ${id}`, kind: 'config.entries', scope: 'user',
    target: { root: 'userHome', segments: [{ literal: '.codex' }, { literal: 'config.toml' }] }, format: 'toml',
    entries: [{ path, action: 'set', value: { literal: value } }], requires: [], checks: [] });
  const document = { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
    id: 'codex', managementId: 'codex-mcp', scope: 'user', configuration: {}, requires: [], recipe: { inline: {
      schema: 'urn:aihq:core:recipe:1.0.0', id: 'codex-mcp', description: 'Manage selected Codex MCP settings',
      inputs: {}, materials: [], targets: ['user'], prerequisites: [], checks: [], operations: [
        op('command', ['mcp_servers', 'aih', 'command'], 'node'),
        op('args', ['mcp_servers', 'aih', 'args'], ['server.js', '--stdio']),
        op('env', ['mcp_servers', 'aih', 'env', 'API_URL'], 'https://example.test')
      ]
    } }
  }] };
  const parsed = parsePolicy(JSON.stringify(document));
  assert.equal(parsed.valid, true, JSON.stringify(parsed));
  assert.equal(validateRecipe(parsed.document.selections[0].recipe.inline).valid, true);
  const request = { useCase: 'policy', policy: parsed.document, target: { project: process.env.TEST_PROJECT } };
  const controls = { logging: 'off' };
  const preview = async () => {
    const p = await prepare(request, controls);
    validate(p.review);
    assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
    assert.ok(p.prepared);
    return p;
  };
  const execute = async p => {
    const result = await apply(p.prepared, { approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest }, controls);
    validate(result);
    assert.equal(result.completion, 'complete', JSON.stringify(result));
  };
  const check = async expected => {
    const state = await checkFileState({ policy: request.policy, target: request.target });
    validate(state);
    assert.equal(state.status, 'complete', JSON.stringify(state));
    assert.equal(state.fileState, expected, JSON.stringify(state));
    if (expected === 'match') {
      assert.ok(state.targets.length > 0);
      assert.ok(state.targets.every(target => target.outcome === 'match'), JSON.stringify(state.targets));
    }
    return state;
  };
  const repeat = async () => {
    const before = readFileSync(file);
    const p = await preview();
    assert.deepEqual(p.review.operations.map(op => op.effects), ['already-satisfied', 'already-satisfied', 'already-satisfied']);
    await execute(p);
    assert.deepEqual(readFileSync(file), before, 'repeat setup changes no bytes');
  };

  writeFileSync(file, original);
  const first = await preview();
  assert.equal(first.review.operations.find(op => op.id === 'codex/args').details.entries[0].value, '["server.js","--stdio"]');
  assert.deepEqual(readFileSync(file), Buffer.from(original), 'Prepare is inert');
  await execute(first);
  assert.deepEqual(readFileSync(file), Buffer.from(original + appended), 'all original bytes survive the appended tables');
  await check('match');
  await repeat();

  // Simulate the client inserting a project table before its original trailing comments.
  const clientEdited = (original + appended)
    .replace('model = "gpt-6.1-sol"', 'model = "gpt-6-sol"')
    .replace('# Trailing notes kept by the user\n# second trailing line\n',
      '[projects."/home/u/q"]\ntrust_level = "trusted"\n# Trailing notes kept by the user\n# second trailing line\n');
  assert.notEqual(clientEdited, original + appended);
  writeFileSync(file, clientEdited);
  await check('match');
  await repeat();

  const drift = clientEdited.replace('args = ["server.js", "--stdio"]', 'args = ["server.js", "--evil"]');
  assert.notEqual(drift, clientEdited);
  writeFileSync(file, drift);
  const state = await check('changed');
  assert.ok(state.targets.some(target => target.outcome === 'changed' && target.operationIds.includes('codex/args')), JSON.stringify(state.targets));
  const blocked = await prepare(request, controls);
  validate(blocked.review);
  assert.equal(blocked.status, 'partial', JSON.stringify(blocked));
  assert.deepEqual(blocked.resolutionInputs.map(item => item.operationId), ['args']);
  assert.deepEqual(Object.fromEntries(blocked.review.operations.map(op => [op.id, op.effects])), {
    'codex/command': 'already-satisfied', 'codex/args': 'conflict', 'codex/env': 'already-satisfied'
  });
  assert.ok(blocked.diagnostics.some(d => d.code === 'STATE_CONFLICT'), JSON.stringify(blocked.diagnostics));
  assert.equal(readFileSync(file, 'utf8'), drift, 'inspection never repairs a client edit');
  console.log('packed Codex TOML API passed');
}

test('a packed consumer preserves Codex TOML neighbors and detects drift in individual managed keys', { timeout: 1_200_000 }, () => {
  assert.ok(process.env.npm_execpath, 'Run this acceptance with npm test so its npm CLI is known.');
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'aih-toml-codex-packed-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const home = join(root, 'home'), project = join(root, 'project'), consumer = join(root, 'consumer');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(project);
  mkdirSync(consumer);
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    npm_config_cache: process.env.npm_config_cache ?? join(root, 'npm-cache') };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  delete env.NODE_TEST_CONTEXT;
  let invocation = 0;
  // File-backed output also works in hosts that restrict synchronous pipe reads.
  const run = (args, options) => {
    const stdoutPath = join(root, `stdout-${invocation}`), stderrPath = join(root, `stderr-${invocation++}`);
    const stdout = openSync(stdoutPath, 'w'), stderr = openSync(stderrPath, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, args, { ...options, stdio: ['ignore', stdout, stderr] });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    const output = readFileSync(stdoutPath, 'utf8') + readFileSync(stderrPath, 'utf8');
    assert.equal(result.error, undefined, result.error?.message + '\n' + output);
    assert.equal(result.status, 0, output);
    return readFileSync(stdoutPath, 'utf8');
  };
  // Installing the packed artifact beside the concurrent suite has exceeded 300 s on Windows runners.
  const npm = (args, cwd) => run([process.env.npm_execpath, ...args], { cwd, env, timeout: 600_000 });
  try {
    const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], packageRoot))[0];
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'codex-toml-consumer', private: true, type: 'module',
      dependencies: { '@aihq/core': `file:${join(root, packed.filename)}` } }));
    writeFileSync(join(consumer, '.npmrc'), '@sigstore:registry=http://127.0.0.1:1/\nfetch-retries=0\n');
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
    const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules/@aihq/core/package.json'), 'utf8'));
    assert.equal(manifest.name, '@aihq/core');
    assert.equal(manifest.version, JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version);
    const driver = join(consumer, 'scenario.mjs');
    writeFileSync(driver, `await (${packedScenario.toString()})();\n`);
    const output = run([driver], { cwd: consumer, env: { ...env, TEST_PROJECT: project }, timeout: 180_000 });
    assert.match(output, /packed Codex TOML API passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
