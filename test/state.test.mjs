import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { forgetProvenState, protectState, stateFiles, stateProtectionCounts, stateRoot, stateWritten, writeStateFile } from '../dist/core/internal/state.js';

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

/** A disposable home for one state test, with its previous HOME and USERPROFILE restored afterwards. */
function withHome(prefix, body) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = join(root, 'home'); mkdirSync(home);
  process.env.HOME = home; process.env.USERPROFILE = home;
  forgetProvenState();
  try { return body(); } finally {
    forgetProvenState();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}
/** Grant Everyone read access to one file, as a person or another program might. */
function grantEveryone(path) {
  const granted = spawnSync('icacls', [path, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(granted.status, 0, granted.stdout + granted.stderr);
}

test('Windows state checks a file Core did not write, even in a folder already proven', { skip: process.platform !== 'win32' }, () => withHome('aih-state-foreign-', () => {
  protectState(); writeStateFile('runs/a.json', Buffer.from('{}'), 0o600);
  protectState(['runs/a.json']);
  // Another program creates a file with a wider access list in the proven folder.
  const foreign = join(stateRoot(), 'runs/b.json'); writeFileSync(foreign, '{}'); grantEveryone(foreign);
  assert.throws(() => protectState(['runs/b.json']), /state-protection/);
}));

test('Windows state checks a proven file again once it is replaced', { skip: process.platform !== 'win32' }, () => withHome('aih-state-replaced-', () => {
  protectState(); writeStateFile('runs/a.json', Buffer.from('{}'), 0o600);
  protectState(['runs/a.json']);
  const replacement = join(stateRoot(), 'runs/c.json'); writeFileSync(replacement, '{}'); grantEveryone(replacement);
  renameSync(replacement, join(stateRoot(), 'runs/a.json'));
  assert.throws(() => protectState(['runs/a.json']), /state-protection/);
}));

test('Windows state checks a proven file again once its access list changes, within one operation and in the next', { skip: process.platform !== 'win32' }, () => withHome('aih-state-again-', () => {
  protectState(); writeStateFile('runs/a.json', Buffer.from('{}'), 0o600);
  protectState(['runs/a.json']);
  const before = stateProtectionCounts.aclChecks;
  protectState(['runs/a.json']);
  assert.equal(stateProtectionCounts.aclChecks, before, 'an unchanged proven path is not checked again within one operation');
  // Widened by a program the person runs, mid-operation: the file's change time moves, so it is checked again at once.
  grantEveryone(join(stateRoot(), 'runs/a.json'));
  assert.throws(() => protectState(['runs/a.json']), /state-protection/);
  forgetProvenState();
  assert.throws(() => protectState(['runs/a.json']), /state-protection/);
}));

test('Windows state records only what Core itself writes inside proven folders', { skip: process.platform !== 'win32' }, () => withHome('aih-state-recorded-', () => {
  protectState(); stateFiles().writeAtomic('runs/a.json', Buffer.from('{}'), 0o600);
  forgetProvenState();
  // Nothing proven yet: a write is not recorded, so the next protection check starts PowerShell.
  writeStateFile('runs/d.json', Buffer.from('{}'), 0o600);
  let before = stateProtectionCounts.aclChecks;
  protectState(['runs/d.json']);
  assert.equal(stateProtectionCounts.aclChecks, before + 1);
  // Once its folder is proven, a file Core writes there needs no PowerShell of its own.
  writeStateFile('runs/e.json', Buffer.from('{}'), 0o600);
  protectState(['runs/e.json']);
  assert.equal(stateProtectionCounts.aclChecks, before + 1);
  // The root is proven but a new folder below it is not: a file Core writes there is checked, with its folder.
  writeStateFile('recovery/run/f.json', Buffer.from('{}'), 0o600);
  before = stateProtectionCounts.aclChecks;
  protectState(['recovery/run/f.json']);
  assert.equal(stateProtectionCounts.aclChecks, before + 1);
  // A file Core did not create at that path (another object than the one named) is not recorded, even in a proven folder.
  writeFileSync(join(stateRoot(), 'runs/g.json'), '{}');
  stateWritten('runs/g.json', '1:2');
  before = stateProtectionCounts.aclChecks;
  protectState(['runs/g.json']);
  assert.equal(stateProtectionCounts.aclChecks, before + 1);
}));
