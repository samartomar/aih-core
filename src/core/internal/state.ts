import { chmodSync, lstatSync, mkdirSync, readFileSync, rmdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, isAbsolute, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { OwnedFileTransaction, fileIdentity, type OwnedFileRead } from './owned-file-transaction.js';
import { parseStrictJsonObjectV1 } from './strict-json.js';
import { fileTransaction, pathPins, pinsMatch, sha256, userHomeRoot, validSegment } from './host-files.js';
import { validCreatedDirectories, type CreatedDirectory } from './created-directories.js';
import { containedPath } from './contained-path.js';
import { claimIdentity, validClaim, memberKey, validDescriptor, type MemberDescriptor, type Claim } from './recipe-lifecycle.js';
import { tomlTableCustody, tomlTableOf, type TomlTableCustody } from './recipe-editors.js';
import { sharedBlockRole } from './shared-blocks.js';
import type { RecordStatus } from '../host-types.js';
import { stateLocation } from '../state-location.js';
import { refreshItems, resolvePending, validItems, type CustodyItem } from './custody-items.js';
import { canonicalJson } from './canonical.js';

export const stateRoot = (): string => join(userHomeRoot(), ...stateLocation.root.segments);
/** `sha256` digests the exact member bytes; a hook group also records its canonical JSON digest. */
export interface Owner { managementId: string; recipeIdentity: string; sha256: string; mode: number; descriptor?: MemberDescriptor; claims?: Claim[]; canonicalSha256?: string; tomlTable?: TomlTableCustody;
  /** Recipe 1.4.0: this member is the person's OK for one server in `tool`, written by Core. */
  approval?: { tool: string };
  /** Recipe 1.4.0: Core created the array holding this member; it goes with the last member Core added. */
  createdContainer?: true;
  /** Project basics: the exact text Core wrote inside an aih:shared block, so an update can rescue a person's own lines. */
  sharedContent?: string }
export const OWNERSHIP_10 = 'urn:aihq:core:ownership:1.0.0';
export const OWNERSHIP_11 = 'urn:aihq:core:ownership:1.1.0';
export const OWNERSHIP_12 = 'urn:aihq:core:ownership:1.2.0';
export const OWNERSHIP_13 = 'urn:aihq:core:ownership:1.3.0';
export const OWNERSHIP_14 = 'urn:aihq:core:ownership:1.4.0';
export const OWNERSHIP_15 = 'urn:aihq:core:ownership:1.5.0';
export const OWNERSHIP_16 = 'urn:aihq:core:ownership:1.6.0';
const OWNERSHIP_VERSIONS: string[] = [OWNERSHIP_10, OWNERSHIP_11, OWNERSHIP_12, OWNERSHIP_13, OWNERSHIP_14, OWNERSHIP_15, OWNERSHIP_16];
/** Each version admits every record of the versions before it. */
const atLeast = (schema: unknown, minimum: string): boolean => OWNERSHIP_VERSIONS.indexOf(schema as string) >= OWNERSHIP_VERSIONS.indexOf(minimum);
export interface Ownership { directories?: CreatedDirectory[]; schema: typeof OWNERSHIP_10 | typeof OWNERSHIP_11 | typeof OWNERSHIP_12 | typeof OWNERSHIP_13 | typeof OWNERSHIP_14 | typeof OWNERSHIP_15 | typeof OWNERSHIP_16; target: string; members: Record<string, Owner>; selections?: Record<string, Claim>; items?: Record<string, CustodyItem> }
/** A TOML entry whose path has a non-bare (quoted) segment. */
const quotedToml = (descriptor?: MemberDescriptor): boolean => descriptor?.kind === 'entry' && descriptor.format === 'toml' &&
  descriptor.entry.some(segment => !/^[A-Za-z0-9_-]+$/u.test(segment));
/** A TOML entry owner can record a created table only when its path has a table segment. */
const tomlTableAllowed = (descriptor?: MemberDescriptor): boolean => descriptor?.kind === 'entry' && descriptor.format === 'toml' && tomlTableOf(descriptor.entry) !== undefined;
/** Array members, approvals and shared-block content are recorded from 1.6. */
const needs16 = (owner: Owner): boolean => owner.descriptor?.kind === 'member' || owner.approval !== undefined || owner.sharedContent !== undefined;
/** Item custody, array members and approvals require 1.6; directory evidence 1.5; created TOML tables 1.4; quoted TOML names 1.3; bounded entries 1.2; hooks 1.1; otherwise 1.0. */
export function sealOwnership(value: Ownership): Ownership {
  const items = refreshItems(value, (scope, managementId) => claimIdentity(scope, managementId, value.target));
  const schema = items || Object.values(value.members).some(needs16) ? OWNERSHIP_16 : value.directories?.length ? OWNERSHIP_15 : Object.values(value.members).some(owner => owner.tomlTable !== undefined) ? OWNERSHIP_14 :
    Object.values(value.members).some(owner => quotedToml(owner.descriptor)) ? OWNERSHIP_13 :
    Object.values(value.members).some(owner => owner.descriptor?.kind === 'entry' && ['ini', 'yaml', 'properties'].includes(owner.descriptor.format)) ? OWNERSHIP_12 :
    Object.values(value.members).some(owner => owner.descriptor?.kind === 'hook') ? OWNERSHIP_11 : OWNERSHIP_10;
  const { directories, items: _items, ...rest } = value;
  return { ...rest, ...(directories?.length ? { directories } : {}), ...(items ? { items } : {}), schema };
}
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
  # Preserve the filesystem-assigned owner; validate it against the allowed owners below.
  $acl.SetAccessRuleProtection($true,$false)
  foreach($sid in $allowed) {
    $identity=New-Object System.Security.Principal.SecurityIdentifier($sid)
    $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
  }
  [System.IO.Directory]::SetAccessControl($StatePath,$acl)
}
foreach($path in ($env:AIHQ_STATE_CHECK -split '\\n')) {
  if([System.IO.Directory]::Exists($path)) { $actual=[System.IO.Directory]::GetAccessControl($path) }
  else { $actual=[System.IO.File]::GetAccessControl($path) }
  # Elevated Windows creates children owned by Administrators, already trusted with FullControl.
  $owner=$actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if($allowed -notcontains $owner) { throw 'state-owner' }
  foreach($rule in $actual.Access) {
    $sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $sid) { throw 'state-protection' }
  }
}`;

export function protectState(relativePaths: string[] = []): void {
  const root = stateRoot(); pathPins(root);
  const base = dirname(root);
  try { mkdirSync(base, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  let created = false;
  try { mkdirSync(root, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  pathPins(root);
  const stat = lstatSync(root);
  if (!stat.isDirectory()) throw new Error('state-protection');
  const protectedPaths = new Set([root]);
  for (const path of relativePaths) {
    for (const pin of pathPins(join(root, path))) {
      if (pin.identity !== 'absent' && containedPath(root, pin.path)) protectedPaths.add(pin.path);
    }
  }
  if (process.platform === 'win32') {
    // -Command uses fixed source; variable values are passed through the environment,
    // never concatenated into executable PowerShell text.
    const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `& { ${aclScript} } $env:AIHQ_STATE_PATH $env:AIHQ_STATE_CREATE`], {
      windowsHide: true, timeout: 10_000, maxBuffer: 4096,
      env: { ...process.env, AIHQ_STATE_PATH: root, AIHQ_STATE_CREATE: created ? 'yes' : 'no', AIHQ_STATE_CHECK: [...protectedPaths].join('\n') }
    });
    if (result.error || result.status !== 0) throw new Error('state-protection');
  } else {
    if (created) chmodSync(root, 0o700);
    for (const path of protectedPaths) {
      const current = lstatSync(path);
      if (current.uid !== process.getuid?.() || (current.mode & 0o077) !== 0) throw new Error('state-protection');
    }
  }
}

/** A Core-assigned managed-content child of the state root (user-scope `userState`). */
export const isContentRoot = (root: string): boolean => /^content\/[a-f0-9]{64}$/.test(relative(stateRoot(), root).replaceAll('\\', '/'));
/** The guarded transaction for a managed-content root; it is never the reserved state root itself. */
export function contentTransaction(root: string, directoryCreated?: (path: string) => void): OwnedFileTransaction {
  return new OwnedFileTransaction(root, { label: 'Core managed content', maxFileBytes: 16 * 1024 * 1024,
    contentDirectoryMode: 0o700, stateDirectoryMode: 0o700, statePaths: new Set<string>(),
    assertOwnedPath(path: string) { if (path.split('/').some(part => !validSegment(part))) throw new Error('invalid-path'); },
    assertResolvedSegments(parts: readonly string[]) { if (parts.some(part => !validSegment(part))) throw new Error('invalid-path'); } }, directoryCreated);
}
/** Read one target member file of a custody root without changing anything. */
export function inspectTarget(root: string, path: string): OwnedFileRead {
  if (!isContentRoot(root)) return fileTransaction(root, stateRoot()).inspect(path);
  if (path.split('/').some(part => !validSegment(part))) return { state: 'unreadable', detail: 'invalid-path' };
  if (pathPins(root).at(-1)?.identity === 'absent') return { state: 'absent' };
  return contentTransaction(root).inspect(path);
}
/**
 * The custody a receipt establishes once members a crash left pending are settled against the target. Only read views
 * change; the receipt bytes and digest stay, and the next Apply writing this root persists the settled custody.
 */
function settled(value: Ownership): Ownership {
  if (!Object.values(value.items ?? {}).some(item => item.pending)) return value;
  const view: Ownership = { ...value, members: { ...value.members }, ...(value.items ? { items: { ...value.items } } : {}) };
  const inspect = (path: string) => {
    try {
      const live = inspectTarget(value.target, path);
      return live.state === 'present' ? { ...live, identity: fileIdentity(join(value.target, ...path.split('/'))) } : live;
    } catch { return { state: 'unreadable' as const }; }
  };
  if (!resolvePending(view, inspect)) return value;
  const sealed = sealOwnership(view);
  validateOwnership(sealed, value.target);
  return sealed;
}

export function ownershipPath(target: string): string { return `ownership/${sha256(target)}.json`; }
/** The digest of a root's stored receipt (`null` when there is none), without settling pending members. */
export const ownershipDigest = (target: string): string | null => readOwnership(target, false).digest;
export function readOwnership(target: string, settle = true): { value: Ownership; digest: string | null; bytes: number } {
  const empty: Ownership = { schema: OWNERSHIP_10, target, members: {} };
  try { lstatSync(stateRoot()); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return { value: empty, digest: null, bytes: 0 };
    throw error;
  }
  // Custody is meaningful only in the protected store; existing records in a
  // writable/untrusted root must not establish ownership, including in previews.
  protectState([ownershipPath(target)]);
  const bytes = stateFiles().read(ownershipPath(target));
  if (!bytes) return { value: empty, digest: null, bytes: 0 };
  const value = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'ownership');
  validateOwnership(value, target);
  return { value: settle ? settled(value) : value, digest: sha256(bytes), bytes: bytes.length };
}

/** Protect a set of receipt paths once, then validate each value against its target. */
export function readOwnershipBatch(targets: readonly string[]): Map<string, { value: Ownership; digest: string | null; bytes: number }> {
  const unique = [...new Set(targets)];
  const result = new Map<string, { value: Ownership; digest: string | null; bytes: number }>();
  if (unique.length === 0) return result;
  try { lstatSync(stateRoot()); } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    for (const target of unique) result.set(target, { value: { schema: OWNERSHIP_10, target, members: {} }, digest: null, bytes: 0 });
    return result;
  }
  // Keep both process launch count and Windows environment size bounded.
  for (let offset = 0; offset < unique.length; offset += 32)
    protectState(unique.slice(offset, offset + 32).map(ownershipPath));
  const files = stateFiles();
  for (const target of unique) {
    const bytes = files.read(ownershipPath(target));
    if (!bytes) {
      result.set(target, { value: { schema: OWNERSHIP_10, target, members: {} }, digest: null, bytes: 0 });
      continue;
    }
    const value = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'ownership');
    validateOwnership(value, target);
    result.set(target, { value: settled(value), digest: sha256(bytes), bytes: bytes.length });
  }
  return result;
}

/** Enumerate protected receipts with one protection check for the whole batch. */
export function readOwnershipReceipts(check: () => void): { receipts: Ownership[]; count: number; bytes: number } {
  try { lstatSync(stateRoot()); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return { receipts: [], count: 0, bytes: 0 };
    throw error;
  }
  protectState(['ownership']);
  check();
  protectState();
  const directory = join(stateRoot(), 'ownership');
  try { if (!lstatSync(directory).isDirectory()) throw new Error('ownership-invalid'); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return { receipts: [], count: 0, bytes: 0 };
    throw error;
  }
  check();
  const allNames = readdirSync(directory);
  if (allNames.length > 8192) throw new Error('ownership-limit');
  const names = allNames.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  // Keep the Windows environment argument bounded while checking many receipts per process.
  for (let offset = 0; offset < names.length; offset += 128) {
    check();
    protectState(names.slice(offset, offset + 128).map(name => `ownership/${name}`));
  }
  check();
  const receipts: Ownership[] = []; let total = 0;
  const files = stateFiles();
  for (const name of names) {
    check();
    const data = files.read(`ownership/${name}`);
    if (!data) throw new Error('ownership-invalid');
    total += data.length;
    if (total > 32 * 1024 * 1024) throw new Error('ownership-limit');
    const value = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(data), 'ownership');
    if (typeof value.target !== 'string' || !isAbsolute(value.target) ||
      ownershipPath(value.target) !== `ownership/${name}`) throw new Error('ownership-invalid');
    validateOwnership(value, value.target);
    receipts.push(settled(value));
  }
  return { receipts, count: names.length, bytes: total };
}

export function validateOwnership(input: unknown, target: string): asserts input is Ownership {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ownership-invalid');
  const value = input as Record<string, unknown>;
  if (!OWNERSHIP_VERSIONS.includes(value.schema as string) || value.target !== target || !value.members || typeof value.members !== 'object' || Array.isArray(value.members)) throw new Error('ownership-invalid');
  if (Object.keys(value).some(key => !['schema', 'target', 'members', 'selections', 'directories', 'items'].includes(key)) || Object.keys(value.members).length > 8192) throw new Error('ownership-invalid');
  if (value.directories !== undefined && (!atLeast(value.schema, OWNERSHIP_15) || !validCreatedDirectories(value.directories))) throw new Error('ownership-invalid');
  // Reuse the resolved home only within this synchronous validation call.
  let resolvedHome: string | undefined;
  const homeRoot = (): string => resolvedHome ??= userHomeRoot();
  for (const [key, member] of Object.entries(value.members)) {
    if (!member || typeof member !== 'object') throw new Error('ownership-invalid');
    const m = member as Owner;
    if (Object.keys(member).some(key => !['managementId', 'recipeIdentity', 'sha256', 'mode', 'descriptor', 'claims', 'canonicalSha256', 'tomlTable', 'approval', 'createdContainer', 'sharedContent'].includes(key))) throw new Error('ownership-invalid');
    if (needs16(m) && !atLeast(value.schema, OWNERSHIP_16) ||
        m.approval !== undefined && (!m.approval || typeof m.approval !== 'object' || Object.keys(m.approval).length !== 1 || typeof m.approval.tool !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(m.approval.tool) || !(m.descriptor?.kind === 'member' || m.descriptor?.kind === 'entry' && ['json', 'jsonc'].includes(m.descriptor.format))) ||
        Object.hasOwn(m, 'createdContainer') && (m.createdContainer !== true || m.descriptor?.kind !== 'member') ||
        Object.hasOwn(m, 'sharedContent') && (!atLeast(value.schema, OWNERSHIP_16) || m.descriptor?.kind !== 'block' ||
          sharedBlockRole(m.descriptor.startMarker, m.descriptor.endMarker) === null ||
          typeof m.sharedContent !== 'string' || m.sharedContent.length > 65536)) throw new Error('ownership-invalid');
    // Hook custody exists only in a 1.1 or newer root, and always carries its canonical digest.
    if ((m.descriptor?.kind === 'hook') !== (m.canonicalSha256 !== undefined) ||
        m.canonicalSha256 !== undefined && (typeof m.canonicalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.canonicalSha256)) ||
        m.descriptor?.kind === 'hook' && !atLeast(value.schema, OWNERSHIP_11) ||
        m.descriptor?.kind === 'entry' && ['ini', 'yaml', 'properties'].includes(m.descriptor.format) && !atLeast(value.schema, OWNERSHIP_12) ||
        quotedToml(m.descriptor) && !atLeast(value.schema, OWNERSHIP_13) ||
        Object.hasOwn(m, 'tomlTable') && (!atLeast(value.schema, OWNERSHIP_14) || !tomlTableAllowed(m.descriptor) ||
          !(tomlTableCustody as readonly unknown[]).includes(m.tomlTable))) throw new Error('ownership-invalid');
    if ((m.descriptor === undefined) !== (m.claims === undefined)) throw new Error('ownership-invalid');
    if (m.descriptor ? !validDescriptor(m.descriptor) || memberKey(m.descriptor) !== key : !validDescriptor({ kind: 'file', path: key })) throw new Error('ownership-invalid');
    if (m.claims !== undefined && (!Array.isArray(m.claims) || !m.claims.length || m.claims.length > 4096 || !m.claims.every(validClaim) ||
      new Set(m.claims.map(claim => `${claim.scope}:${claim.managementId}`)).size !== m.claims.length)) throw new Error('ownership-invalid');
    if (m.claims?.some(claim => claim.scope === 'user' && target !== homeRoot() && !/^content\/[a-f0-9]{64}$/.test(relative(stateRoot(), target).replaceAll('\\', '/')))) throw new Error('ownership-invalid');
    if (typeof m.managementId !== 'string' || typeof m.recipeIdentity !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(m.recipeIdentity) || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isInteger(m.mode) || m.mode < 0 || m.mode > 0o7777) throw new Error('ownership-invalid');
  }
  if (value.selections !== undefined) {
    if (!value.selections || typeof value.selections !== 'object' || Array.isArray(value.selections) || Object.keys(value.selections).length > 4096) throw new Error('ownership-invalid');
    for (const [key, selection] of Object.entries(value.selections)) {
      if (!validClaim(selection) || key !== claimIdentity(selection.scope, selection.managementId, target) || selection.scope === 'user' && target !== homeRoot()) throw new Error('ownership-invalid');
    }
  }
  // Items describe claims already held here; the target-keyed members above stay authoritative.
  if (value.items !== undefined && (!atLeast(value.schema, OWNERSHIP_16) ||
    !validItems(value as unknown as Ownership, (scope, managementId) => claimIdentity(scope, managementId, target)))) throw new Error('ownership-invalid');
  // A pending owner is exactly the custody its member would publish, held to the same rules.
  for (const item of Object.values((value.items ?? {}) as Record<string, CustodyItem>)) for (const entry of item.pending ?? []) {
    if (!validDescriptor(entry.descriptor) || memberKey(entry.descriptor) !== entry.key) throw new Error('ownership-invalid');
    if (entry.owner === null) continue;
    if (canonicalJson(entry.owner.descriptor ?? null) !== canonicalJson(entry.descriptor) ||
        !entry.owner.claims?.some(claim => claim.managementId === item.managementId && claim.scope === item.scope)) throw new Error('ownership-invalid');
    validateOwnership({ schema: value.schema, target, members: { [entry.key]: entry.owner } }, target);
  }
}

export function writeHistory(runId: string, result: unknown, logging: 'on' | 'off'): RecordStatus {
  if (logging === 'off') return { status: 'disabled', reason: 'logging-off' };
  const reference = `runs/${runId}.json`;
  const written: RecordStatus = { status: 'written', reference };
  try {
    const bytes = Buffer.from(JSON.stringify({ ...(result as object), record: written }));
    if (bytes.length > 1_048_576) return { status: 'failed', reason: 'record-limit', diagnosticId: 'record-limit' };
    protectState([reference]); stateFiles().writeAtomic(reference, bytes, 0o600);
    return written;
  } catch { return { status: 'failed', reason: 'record-write', diagnosticId: 'record-write' }; }
}

const LOCK_HOLDER = 'holder.json';
/**
 * Take a target's state lock. The lock names its holder (process and host), so a lock left by a process that no longer
 * runs on this host can be reclaimed after a crash. A lock without a readable holder, from another host, or held by a
 * running process is never taken over; leftovers need deliberate inspection. Reclaiming assumes one process namespace
 * per host name.
 */
export function lockTarget(target: string): () => void {
  const root = stateRoot(); const lock = join(root, `lock-${sha256(target)}`);
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !reclaimLock(lock)) throw error;
    mkdirSync(lock, { mode: 0o700 });
  }
  const pins = pathPins(lock);
  const holder = join(lock, LOCK_HOLDER);
  try { writeFileSync(holder, JSON.stringify({ pid: process.pid, host: hostname() }), { flag: 'wx', mode: 0o600 }); } catch { /* An unnamed lock is only ever released by its own process. */ }
  return () => {
    // Never recursively delete locks; leftovers need deliberate inspection.
    if (pathPins(lock).at(-1)?.identity !== pins.at(-1)?.identity) return;
    try { unlinkSync(holder); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    rmdirSync(lock);
  };
}
/** The lock's recorded holder is on this host and no longer runs. */
function holderGone(lock: string): boolean {
  let holder: { pid: unknown; host: unknown };
  try {
    pathPins(lock);
    if (!lstatSync(lock).isDirectory() || readdirSync(lock).some(name => name !== LOCK_HOLDER)) return false;
    holder = JSON.parse(readFileSync(join(lock, LOCK_HOLDER), 'utf8')) as typeof holder;
  } catch { return false; }
  if (!Number.isSafeInteger(holder.pid) || (holder.pid as number) <= 0 || holder.host !== hostname() || holder.pid === process.pid) return false;
  try { process.kill(holder.pid as number, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/**
 * Remove a lock whose recorded holder is provably gone; reports whether the lock path may be taken again. Reclaimers
 * are serialised by an exclusive guard and re-check the holder under it. A live process only ever takes the lock by
 * creating it, which fails while the stale one exists, so the lock removed here can only be the stale one. The caller's
 * own exclusive create still decides who holds the lock afterwards.
 */
function reclaimLock(lock: string): boolean {
  if (!holderGone(lock)) return false;
  const guard = `${lock}.reclaim`;
  try { mkdirSync(guard, { mode: 0o700 }); } catch { return false; }
  try {
    try { lstatSync(lock); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
    if (!holderGone(lock)) return false;
    unlinkSync(join(lock, LOCK_HOLDER)); rmdirSync(lock);
    return true;
  } catch { return false; }
  finally { rmdirSync(guard); }
}

export function stageOwnership(target: string, runId: string, update: Ownership): () => void {
  const path = ownershipPath(target);
  // A byte-sized receipt must also remain readable under strict admission.
  // Reject semantic count/descriptor failures before any target effects.
  update = sealOwnership(update);
  try { validateOwnership(update, target); } catch { throw new Error('state-unwritable'); }
  const record = Buffer.from(JSON.stringify(update));
  if (record.length > 1_048_576) throw new Error('state-unwritable');
  const staged = `ownership/.pending-${runId}-${sha256(target)}.json`;
  protectState([path, staged, `recovery/${runId}`]);
  const files = stateFiles(); let stagedWritten = false;
  try {
    // The caller supplies a conservative bound covering intermediate custody
    // and intent records. Stage it in the actual destination directory to prove
    // capacity and receipt creation before any target changes.
    files.writeAtomic(staged, record, 0o600, true); stagedWritten = true;
    const current = files.read(path);
    // Existing receipts also require replacement permission. Probe that exact
    // operation with unchanged bytes; this adds no claim of target ownership.
    if (current) files.writeAtomic(path, current, 0o600);
  } catch {
    if (stagedWritten) { try { files.remove(staged); } catch { /* A failed probe can leave recognizable inert staging. */ } }
    throw new Error('state-unwritable');
  }
  const pins = pathPins(join(stateRoot(), 'ownership'));
  return () => {
    if (!pinsMatch(pins)) throw new Error('state-protection');
    files.remove(staged);
  };
}

/** Read inert inventory bytes; imported custody still requires readOwnership protection. */
export function ownershipInventory(): { targets: string[]; entries: [string, string][]; unverifiable: boolean } {
  const directory = join(stateRoot(), 'ownership');
  try { if (!lstatSync(directory).isDirectory()) throw new Error('ownership-invalid'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { targets: [], entries: [], unverifiable: false }; throw error; }
  pathPins(directory);
  const names = readdirSync(directory); if (names.length > 8192) throw new Error('ownership-limit');
  const targets: string[] = []; const entries: [string, string][] = []; let unverifiable = false;
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
    try {
      const bytes = stateFiles().read(`ownership/${name}`); if (!bytes) throw new Error('ownership-invalid');
      entries.push([name, sha256(bytes)]);
      const value = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'ownership');
      if (typeof value.target !== 'string' || !isAbsolute(value.target) || ownershipPath(value.target) !== `ownership/${name}`) throw new Error('ownership-invalid');
      targets.push(value.target);
    } catch { unverifiable = true; if (!entries.some(([entry]) => entry === name)) entries.push([name, 'unverifiable']); }
  }
  return { targets, entries, unverifiable };
}
