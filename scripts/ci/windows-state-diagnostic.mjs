// Temporary bounded CI reproduction; remove after the hosted cause is known.
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tag = '[DEBUG-windows-state]';
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const aclFacts = String.raw`
$ErrorActionPreference='Stop'
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object System.Security.Principal.WindowsPrincipal($user)
$entries=@()
foreach($path in ($env:AIHQ_DIAGNOSTIC_PATHS -split '\n')) {
  if([System.IO.Directory]::Exists($path)) {$acl=[System.IO.Directory]::GetAccessControl($path)}
  else {$acl=[System.IO.File]::GetAccessControl($path)}
  $entries+=@{path=$path; ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
    inheritanceProtected=$acl.AreAccessRulesProtected;
    rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=$_.FileSystemRights.ToString();inherited=$_.IsInherited}
    })}
}
@{userSid=$user.User.Value;elevated=$principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);entries=$entries} | ConvertTo-Json -Depth 6 -Compress
`;

if (process.argv[2] !== '--fixture') {
  const root = mkdtempSync(join(tmpdir(), 'aih-windows-state-diagnostic-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--fixture', root],
      { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 45_000, maxBuffer: 32_768, windowsHide: true });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) console.error(tag, JSON.stringify({ error: result.error.code, signal: result.signal }));
    process.exitCode = result.error ? 124 : result.status ?? 1;
  } finally { rmSync(root, { recursive: true, force: true }); }
} else {
  const root = process.argv[3];
  const home = join(root, 'home'), project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  process.env.HOME = home; process.env.USERPROFILE = home;
  console.log(tag, JSON.stringify({ phase: 'fixture', node: process.version, home }));
  const original = childProcess.spawnSync;
  let checks = 0;
  childProcess.spawnSync = (file, args, options) => {
    const result = original(file, args, options);
    if (options?.env?.AIHQ_STATE_CHECK) {
      checks++;
      console.log(tag, JSON.stringify({ phase: 'state-check', checks, status: result.status,
        error: result.error?.code, signal: result.signal, stderr: result.stderr?.toString().slice(0, 4096) }));
      if (checks === 1 || result.status !== 0 || result.error) {
        const facts = original(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', aclFacts],
          { encoding: 'utf8', timeout: 10_000, maxBuffer: 8192, windowsHide: true,
            env: { ...process.env, AIHQ_DIAGNOSTIC_PATHS: options.env.AIHQ_STATE_CHECK } });
        console.log(tag, JSON.stringify({ phase: 'acl-facts', status: facts.status,
          stdout: facts.stdout, stderr: facts.stderr, error: facts.error?.code }));
      }
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    const { prepare, apply } = await import('../../dist/core/index.js');
    const document = {
      schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
        id: 'diagnostic', managementId: 'diagnostic', scope: 'project', configuration: {}, requires: [],
        recipe: { inline: { schema: 'urn:aihq:core:recipe:1.0.0', id: 'diagnostic',
          description: 'One temporary file effect', inputs: {}, materials: [], targets: ['project'], prerequisites: [],
          operations: [{ id: 'write', purpose: 'Write one temporary fixture file', kind: 'file.write', scope: 'project',
            target: { root: 'project', segments: [{ literal: 'fixture.txt' }] }, content: { literal: 'fixture' },
            requires: [], checks: [] }], checks: [] } }
      }]
    };
    const prepared = await prepare({ useCase: 'policy', policy: document, target: { project } });
    console.log(tag, JSON.stringify({ phase: 'prepared', status: prepared.status, diagnostics: prepared.diagnostics }));
    assert.equal(prepared.status, 'ready');
    const applied = await apply(prepared.prepared,
      { approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
    console.log(tag, JSON.stringify({ phase: 'applied', completion: applied.completion, diagnostics: applied.diagnostics }));
    assert.equal(applied.completion, 'complete');
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
}
