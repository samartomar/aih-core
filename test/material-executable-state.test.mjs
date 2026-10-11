import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, apply } from '../dist/core/index.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aih-material-state-'));
  const home = join(root, 'home'), project = join(root, 'project'), materials = join(root, 'materials');
  for (const directory of [home, project, materials]) mkdirSync(directory);
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  const executable = process.platform === 'win32' ?
    join(process.env.SystemRoot, 'System32/cmd.exe') : realpathSync('/bin/sh');
  const bytes = readFileSync(executable);
  writeFileSync(join(materials, 'helper'), bytes);
  const policy = {
    schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
      id: 'fixture', managementId: 'fixture-material', scope: 'project', configuration: {}, requires: [],
      recipe: { inline: {
        schema: 'urn:aihq:core:recipe:1.0.0', id: 'material-fixture',
        description: 'Run a pinned harmless material in a disposable project',
        inputs: {}, targets: ['project'], prerequisites: [], checks: [],
        materials: [{ id: 'helper', source: { kind: 'local', input: 'fixture' }, path: 'helper',
          sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }],
        operations: [{ id: 'run', purpose: 'Write the owned fixture marker', kind: 'process.run',
          scope: 'project', requires: [], checks: [], executable: { material: 'helper' },
          args: (process.platform === 'win32' ? ['/d', '/c', 'echo material-ok>marker.txt'] :
            ['-c', 'echo material-ok > marker.txt']).map(literal => ({ literal })),
          cwd: { root: 'project', segments: [] }, env: {}, timeoutMs: 5000,
          maxOutputBytes: 1024, acceptedExitCodes: [0], effects: ['Write only the disposable marker.txt'] }],
      } },
    }],
  };
  return { home, project, policy, controls: { logging: 'off', materialRoots: { fixture: materials } },
    close() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    } };
}

test('public material execution succeeds with logging off on first use and reuse of a temporary home',
  { timeout: 30_000 }, async () => {
    const f = fixture();
    try {
      for (const label of ['first use', 'reuse']) {
        const p = await prepare({ useCase: 'policy', policy: f.policy, target: { project: f.project } }, f.controls);
        assert.equal(p.status, 'ready', `${label}: ${JSON.stringify(p.diagnostics)}`);
        const result = await apply(p.prepared, { approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest }, f.controls);
        assert.equal(result.completion, 'complete', `${label}: ${JSON.stringify(result)}`);
        assert.equal(result.operations[0].application, 'applied');
        assert.deepEqual(result.record, { status: 'disabled', reason: 'logging-off' });
        assert.equal(readFileSync(join(f.project, 'marker.txt'), 'utf8').trim(), 'material-ok');
        rmSync(join(f.project, 'marker.txt'));
      }
    } finally { f.close(); }
  });

test('public material execution rejects an unsafe existing state root without staging or changing its protection',
  { timeout: 30_000 }, async () => {
    const f = fixture();
    try {
      const p = await prepare({ useCase: 'policy', policy: f.policy, target: { project: f.project } }, f.controls);
      assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
      const state = join(f.home, '.aih', 'core');
      mkdirSync(state, { recursive: true, mode: 0o700 });
      const acl = script => {
        const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $p=$env:AIHQ_TEST_STATE; " + script],
          { windowsHide: true, encoding: 'utf8', timeout: 10_000, env: { ...process.env, AIHQ_TEST_STATE: state } });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      let protection;
      if (process.platform === 'win32') {
        protection = acl("$a=[System.IO.Directory]::GetAccessControl($p); " +
          "$sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); " +
          "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'); " +
          "$a.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($p,$a); " +
          "([System.IO.Directory]::GetAccessControl($p)).Sddl");
      } else {
        chmodSync(state, 0o777);
        protection = statSync(state).mode;
      }
      const result = await apply(p.prepared, { approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest }, f.controls);
      assert.equal(result.completion, 'rejected', JSON.stringify(result));
      assert.equal(result.operations[0].application, 'not-attempted');
      assert.ok(result.diagnostics.some(d => d.reason === 'state-protection'), JSON.stringify(result.diagnostics));
      assert.equal(existsSync(join(f.project, 'marker.txt')), false);
      assert.equal(existsSync(join(state, 'work')), false);
      assert.equal(process.platform === 'win32' ? acl("([System.IO.Directory]::GetAccessControl($p)).Sddl") : statSync(state).mode, protection);
    } finally { f.close(); }
  });
