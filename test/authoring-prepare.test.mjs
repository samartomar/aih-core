import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('public authoring example agrees with Prepare and refuses stale authority and serialized handles', () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-authoring-prepare-'));
  const home = join(root, 'home'); mkdirSync(home);
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../examples/authoring-consumer.mjs', import.meta.url))],
      { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const proof = JSON.parse(run.stdout);
    assert.equal(proof.cases.length, 2);
    assert.ok(proof.cases.every(item => item.admitted && item.denied && item.changedAuthorityRefused && item.serializedReviewRefused));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
