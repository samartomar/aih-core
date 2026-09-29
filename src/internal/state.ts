import { chmodSync, lstatSync, mkdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { OwnedFileTransaction } from './owned-file-transaction.js';
import { parseStrictJsonObjectV1 } from './strict-json.js';
import { pathPins, sha256 } from './host-files.js';
import type { RecordStatus } from '../host-types.js';

export const stateRoot = (): string => join(homedir(), '.aih', 'core');
export interface Owner { managementId: string; recipeIdentity: string; sha256: string; mode: number }
export interface Ownership { schema: 'urn:aihq:core:ownership:1.0.0'; target: string; members: Record<string, Owner> }
export function stateFiles(): OwnedFileTransaction {
  return new OwnedFileTransaction(stateRoot(), {
    label: 'Core state', maxFileBytes: 1_048_576, contentDirectoryMode: 0o700,
    stateDirectoryMode: 0o700, statePaths: new Set(),
    assertOwnedPath() {}, assertResolvedSegments() {}
  });
}

// No policy-supplied script or path interpolation. The fixed script receives
// the state path as an argument and validates the actual Windows ACL.
const aclScript = `param([string]$StatePath,[string]$Create)
$ErrorActionPreference='Stop'
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed=@($user.Value,'S-1-5-18','S-1-5-32-544')
if($Create -eq 'yes') {
  $acl=New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($user)
  $acl.SetAccessRuleProtection($true,$false)
  foreach($sid in $allowed) {
    $identity=New-Object System.Security.Principal.SecurityIdentifier($sid)
    $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
  }
  [System.IO.Directory]::SetAccessControl($StatePath,$acl)
}
$actual=[System.IO.Directory]::GetAccessControl($StatePath)
if($actual.Owner -ne $user.Translate([System.Security.Principal.NTAccount]).Value -and $actual.Owner -ne $user.Value) { throw 'state-owner' }
foreach($rule in $actual.Access) {
  $sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $sid) { throw 'state-protection' }
}`;

export function protectState(): void {
  const root = stateRoot(); pathPins(root);
  const base = join(homedir(), '.aih');
  try { mkdirSync(base, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  let created = false;
  try { mkdirSync(root, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  pathPins(root);
  const stat = lstatSync(root);
  if (!stat.isDirectory()) throw new Error('state-protection');
  if (process.platform === 'win32') {
    // -Command uses fixed source; variable values are passed through the environment,
    // never concatenated into executable PowerShell text.
    const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `& { ${aclScript} } $env:AIHQ_STATE_PATH $env:AIHQ_STATE_CREATE`], {
      windowsHide: true, timeout: 10_000, maxBuffer: 4096,
      env: { ...process.env, AIHQ_STATE_PATH: root, AIHQ_STATE_CREATE: created ? 'yes' : 'no' }
    });
    if (result.error || result.status !== 0) throw new Error('state-protection');
  } else {
    if (created) chmodSync(root, 0o700);
    if (stat.uid !== process.getuid?.() || (lstatSync(root).mode & 0o077) !== 0) throw new Error('state-protection');
  }
}

export function ownershipPath(target: string): string { return `ownership/${sha256(target)}.json`; }
export function readOwnership(target: string): { value: Ownership; digest: string | null } {
  const empty: Ownership = { schema: 'urn:aihq:core:ownership:1.0.0', target, members: {} };
  try { lstatSync(stateRoot()); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return { value: empty, digest: null };
    throw error;
  }
  // Custody is meaningful only in the protected store; existing records in a
  // writable/untrusted root must not establish ownership, including in previews.
  protectState();
  const bytes = stateFiles().read(ownershipPath(target));
  if (!bytes) return { value: empty, digest: null };
  const value = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'ownership');
  if (value.schema !== empty.schema || value.target !== target || !value.members || typeof value.members !== 'object' || Array.isArray(value.members)) throw new Error('ownership-invalid');
  for (const member of Object.values(value.members)) {
    if (!member || typeof member !== 'object') throw new Error('ownership-invalid');
    const m = member as Owner;
    if (typeof m.managementId !== 'string' || typeof m.recipeIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isInteger(m.mode)) throw new Error('ownership-invalid');
  }
  return { value: value as unknown as Ownership, digest: sha256(bytes) };
}

export function writeHistory(runId: string, result: unknown, logging: 'on' | 'off'): RecordStatus {
  if (logging === 'off') return { status: 'disabled', reason: 'logging-off' };
  const reference = `runs/${runId}.json`;
  const written: RecordStatus = { status: 'written', reference };
  try {
    const bytes = Buffer.from(JSON.stringify({ ...(result as object), record: written }));
    if (bytes.length > 1_048_576) return { status: 'failed', reason: 'record-limit', diagnosticId: 'record-limit' };
    protectState(); stateFiles().writeAtomic(reference, bytes, 0o600);
    return written;
  } catch { return { status: 'failed', reason: 'record-write', diagnosticId: 'record-write' }; }
}

export function lockTarget(target: string): () => void {
  const root = stateRoot(); const lock = join(root, `lock-${sha256(target)}`);
  mkdirSync(lock, { mode: 0o700 }); const pins = pathPins(lock);
  return () => {
    // Never recursively delete locks; leftovers need deliberate inspection.
    if (pathPins(lock).at(-1)?.identity === pins.at(-1)?.identity) rmdirSync(lock);
  };
}
