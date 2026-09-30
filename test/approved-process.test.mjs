import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutable, runApprovedProcess } from '../dist/core/internal/approved-process.js';

test('an in-place executable edit invalidates the captured byte identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-executable-pin-'));
  try {
    const path = join(root, 'helper.exe');
    writeFileSync(path, 'MZ00');
    chmodSync(path, 0o700);
    const executable = resolveExecutable(path);
    assert.ok(executable);
    writeFileSync(path, 'MZ11');
    const result = await runApprovedProcess({ executable, args: [], cwd: root, env: {},
      timeoutMs: 1000, maxOutputBytes: 1024, acceptedExitCodes: [0] });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'executable-changed');
    assert.equal(result.effectsUncertain, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
