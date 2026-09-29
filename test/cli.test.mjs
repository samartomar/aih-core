import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { policy } from './fixture.mjs';

test('CLI previews by default and applies only deliberate automation through the shared host', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-core-cli-'));
  const home = join(root, 'home'); const project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  const file = join(root, 'policy.json'); writeFileSync(file, JSON.stringify(policy()));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
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
