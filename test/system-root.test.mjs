// Windows system programs (PowerShell, setx, fsutil) are found from the kernel's `\SystemRoot` link, never from the
// inherited `%SystemRoot%` or a bare name on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { system32, windowsDirectory, windowsPowerShell } from '../dist/core/internal/system-root.js';
import { checkStateAcl } from '../dist/core/internal/state.js';
import { windowsDirectory as harnessWindowsDirectory, windowsDirectorySource } from '../dist/harness/user-trust.mjs';
import { repairObservationRequests } from '../dist/harness/runtime.mjs';

const windows = { skip: process.platform !== 'win32' ? 'Windows only.' : false };

test('the Windows folder comes from the kernel link even when %SystemRoot% points elsewhere', windows, () => {
  const decoy = mkdtempSync(join(tmpdir(), 'aih-decoy-windows-'));
  const previous = process.env.SystemRoot;
  try {
    process.env.SystemRoot = decoy;
    const folder = windowsDirectory();
    assert.notEqual(folder.toLowerCase(), decoy.toLowerCase());
    assert.ok(existsSync(join(folder, 'System32', 'kernel32.dll')));
    assert.equal(harnessWindowsDirectory(), folder);
    assert.equal(system32('fsutil.exe'), join(folder, 'System32', 'fsutil.exe'));
    assert.equal(windowsPowerShell(), join(folder, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    // The fixed `node -e` helpers evaluate the same lookup in a child with the decoy inherited.
    const child = execFileSync(process.execPath, ['-e', `process.stdout.write(${windowsDirectorySource})`],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, SystemRoot: decoy } });
    assert.equal(child, folder);
    const [observation] = repairObservationRequests({ id: 'node-npm-ca', targets: ['node'] });
    assert.equal(observation.executable, windowsPowerShell());
    // The state check still reaches the real PowerShell and gets its verdict.
    const state = join(decoy, 'state');
    assert.equal(checkStateAcl(state, false, [decoy], { budgets: [60_000] }) !== 'unverified', true);
  } finally {
    if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous;
    rmSync(decoy, { recursive: true, force: true });
  }
});

test('a repair removal names the Windows user environment values that its recorded profile blocks went with', async () => {
  const { windowsUserEnvironmentKept } = await import('../dist/harness/runtime.mjs');
  assert.deepEqual(windowsUserEnvironmentKept(['node-ca']), ['NODE_EXTRA_CA_CERTS']);
  assert.deepEqual(windowsUserEnvironmentKept(['node-system-ca', 'npm-ca']), ['NODE_USE_SYSTEM_CA']);
  assert.deepEqual(windowsUserEnvironmentKept(['python-ca', 'python-ca']), ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE']);
  assert.deepEqual(windowsUserEnvironmentKept(['npm-ca', 'constructor', '__proto__']), []);
});
