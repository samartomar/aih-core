import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { protectState, stateFiles, stateRoot } from '../dist/core/internal/state.js';

test('Windows state validates newly created recovery and history children under elevation',
  { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'aih-state-owner-'));
    const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const home = join(root, 'home'); mkdirSync(home);
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      protectState();
      mkdirSync(join(stateRoot(), 'recovery/run'), { recursive: true, mode: 0o700 });
      stateFiles().writeAtomic('runs/run.json', Buffer.from('{}'), 0o600);
      // Elevated Windows may assign Administrators as the children's owner,
      // although their inherited ACL still admits only the trusted principals.
      protectState(['recovery/run', 'runs/run.json']);
      assert.equal(stateFiles().read('runs/run.json').toString(), '{}');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

test('Windows state rejects an unrelated owner',
  { skip: process.platform !== 'win32' }, t => {
    const root = mkdtempSync(join(tmpdir(), 'aih-state-unrelated-owner-'));
    const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const home = join(root, 'home'); mkdirSync(home);
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      protectState(); stateFiles().writeAtomic('runs/foreign.json', Buffer.from('{}'), 0o600);
      const file = join(stateRoot(), 'runs/foreign.json');
      const script = "$ErrorActionPreference='Stop'; $p=$env:AIHQ_TEST_RECORD; " +
        "$a=[System.IO.File]::GetAccessControl($p); " +
        "$a.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'))); " +
        "try { [System.IO.File]::SetAccessControl($p,$a) } catch { " +
        "$e=$_.Exception; while($e.InnerException) { $e=$e.InnerException }; " +
        "if(($e.HResult -in @(-2147023589,-2147023582)) -or " +
        "($e -is [System.InvalidOperationException] -and " +
        "$e.Message -eq 'The security identifier is not allowed to be the owner of this object.')) { " +
        "Write-Output 'AIHQ_OWNER_PRIVILEGE_UNAVAILABLE'; exit 77 }; throw }";
      const assigned = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true, env: { ...process.env, AIHQ_TEST_RECORD: file } });
      assert.ifError(assigned.error);
      if (assigned.status === 77 && assigned.stdout.trim() === 'AIHQ_OWNER_PRIVILEGE_UNAVAILABLE') {
        t.skip('This Windows token cannot assign an unrelated owner; no privileges are changed.');
        return;
      }
      assert.equal(assigned.status, 0, assigned.stderr);
      assert.throws(() => protectState(['runs/foreign.json']), /state-protection/);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
