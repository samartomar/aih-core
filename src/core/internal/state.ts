import { chmodSync, lstatSync, mkdirSync, readFileSync, rmdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, isAbsolute, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { OwnedFileTransaction, fileIdentity, type OwnedFileRead } from './owned-file-transaction.js';
import { assertStrictJsonValueV1, assertWellFormedNfcV1, parseStrictJsonObjectV1 } from './strict-json.js';
import { fileTransaction, pathPins, pinsMatch, sha256, userHomeRoot, validSegment } from './host-files.js';
import { validCreatedDirectories, type CreatedDirectory } from './created-directories.js';
import { containedPath } from './contained-path.js';
import { windowsDirectory, windowsPowerShell } from './system-root.js';
import { claimIdentity, validClaim, memberKey, validDescriptor, type MemberDescriptor, type Claim } from './recipe-lifecycle.js';
import { tomlTableCustody, tomlTableOf, type TomlTableCustody } from './recipe-editors.js';
import { sharedBlockRole } from './shared-blocks.js';
import type { RecordStatus } from '../host-types.js';
import { stateLocation } from '../state-location.js';
import { refreshItems, resolvePending, validItems, type CustodyItem } from './custody-items.js';
import { canonicalJson } from './canonical.js';
import { validDisplaced, type DisplacedValue } from './displaced.js';
import { OWNERSHIP_17, expandOwnership, ownershipText } from './ownership-storage.js';

export const stateRoot = (): string => join(userHomeRoot(), ...stateLocation.root.segments);
/** `sha256` digests the exact member bytes; a hook group also records its canonical JSON digest. */
export interface Owner { managementId: string; recipeIdentity: string; sha256: string; mode: number; descriptor?: MemberDescriptor; claims?: Claim[]; canonicalSha256?: string; tomlTable?: TomlTableCustody;
  /** Recipe 1.4.0: this member is the person's OK for one server in `tool`, written by Core. */
  approval?: { tool: string };
  /** Recipe 1.4.0: Core created the array holding this member; it goes with the last member Core added. */
  createdContainer?: true;
  /** The target file was absent before this run's first effect on it; the last owned member removes an empty file. */
  createdFile?: true;
  /** JSON object/array prefixes this run created on the way to an entry or hook group, deepest last. */
  createdContainers?: string[][];
  /** Project basics: the exact text Core wrote inside an aih:shared block, so an update can rescue a person's own lines. */
  sharedContent?: string;
  /** Plan claims a reviewed replace displaced (C61): the value they share, for the one level of restore. */
  displaced?: DisplacedValue }
/** Receipts have one version (C15): every record is `urn:aihq:core:receipt:0.1.0`; an older dev record is not read. */
export const RECEIPT = OWNERSHIP_17;
export { OWNERSHIP_17, ownershipText };
const OWNERSHIP_VERSIONS: string[] = [RECEIPT];
/** One version admits every recorded feature. */
const atLeast = (schema: unknown, _minimum?: string): boolean => schema === RECEIPT;
export interface Ownership { directories?: CreatedDirectory[]; schema: typeof RECEIPT; target: string; members: Record<string, Owner>; selections?: Record<string, Claim>; items?: Record<string, CustodyItem> }
/** A TOML entry whose path has a non-bare (quoted) segment. */
const quotedToml = (descriptor?: MemberDescriptor): boolean => descriptor?.kind === 'entry' && descriptor.format === 'toml' &&
  descriptor.entry.some(segment => !/^[A-Za-z0-9_-]+$/u.test(segment));
/** A TOML entry owner can record a created table only when its path has a table segment. */
const tomlTableAllowed = (descriptor?: MemberDescriptor): boolean => descriptor?.kind === 'entry' && descriptor.format === 'toml' && tomlTableOf(descriptor.entry) !== undefined;
/** Array members, approvals and shared-block content are recorded from 1.6. */
const needs16 = (owner: Owner): boolean => owner.descriptor?.kind === 'member' || owner.approval !== undefined || owner.sharedContent !== undefined ||
  owner.createdFile !== undefined || owner.createdContainers !== undefined || owner.displaced !== undefined;
/** Every receipt is stored in its one version, `urn:aihq:core:receipt:0.1.0` (see ownership-storage). */
export function sealOwnership(value: Ownership): Ownership {
  const items = refreshItems(value, (scope, managementId) => claimIdentity(scope, managementId, value.target));
  const schema = RECEIPT;
  const { directories, items: _items, ...rest } = value;
  return { ...rest, ...(directories?.length ? { directories } : {}), ...(items ? { items } : {}), schema };
}
/** Every file in Core's state is at most 1 MiB, except an ownership record. */
export const STATE_FILE_BYTES = 1_048_576;
/**
 * An ownership record (stored form) is at most 2 MiB. Each of a pick's files is one member, so the record grows with
 * tools × items × files. Core reads and strictly admits a record whole in each operation, and Apply rewrites, encodes
 * and checks it whole twice for every file it changes (write-ahead, then publish), so one Apply's time grows with the
 * square of the record's size; this bound keeps that bounded.
 */
export const OWNERSHIP_RECORD_BYTES = 2 * 1_048_576;
export function stateFiles(maxFileBytes = STATE_FILE_BYTES): OwnedFileTransaction {
  return new OwnedFileTransaction(stateRoot(), {
    label: 'Core state', maxFileBytes, contentDirectoryMode: 0o700,
    stateDirectoryMode: 0o700, statePaths: new Set(),
    assertOwnedPath() {}, assertResolvedSegments() {}
  });
}

// No policy-supplied script or path interpolation. The fixed script receives the state path as an argument and the
// paths to check on standard input (one base64 UTF-8 path per line), reads access rules by SID so no name lookup can
// reach a domain controller, and ends with one verdict token: `ok`, `refused` for an access list that admits someone
// else, or `error` when it could not decide.
const aclScript = `param([string]$StatePath,[string]$Create)
$ErrorActionPreference='Stop'
try {
  $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $allowed=@($user.Value,'S-1-5-18','S-1-5-32-544')
  $sidType=[System.Security.Principal.SecurityIdentifier]
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
  foreach($line in ([Console]::In.ReadToEnd() -split '\\r?\\n')) {
    if(-not $line) { continue }
    $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    try {
      if([System.IO.Directory]::Exists($path)) { $actual=[System.IO.Directory]::GetAccessControl($path) }
      else { $actual=[System.IO.File]::GetAccessControl($path) }
    } catch { [Console]::Out.Write('aihq-state:refused'); exit 0 }
    # Elevated Windows creates children owned by Administrators, already trusted with FullControl.
    if($allowed -notcontains $actual.GetOwner($sidType).Value) { [Console]::Out.Write('aihq-state:refused'); exit 0 }
    foreach($rule in $actual.GetAccessRules($true,$true,$sidType)) {
      if($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { [Console]::Out.Write('aihq-state:refused'); exit 0 }
    }
  }
  [Console]::Out.Write('aihq-state:ok')
} catch { [Console]::Out.Write('aihq-state:error'); exit 1 }`;

/** The verdict of one Windows access-list check: `unverified` means it could not decide (a timeout, a launch failure). */
export type StateProtectionVerdict = 'ok' | 'refused' | 'unverified';
/** Classify one check's process result. Only the exact `ok` token with exit 0 admits; an explicit refusal always refuses. */
export function classifyStateProtection(result: { error?: unknown; status: number | null; stdout?: string | Uint8Array | null }): StateProtectionVerdict {
  if (result.error) return 'unverified';
  const out = (typeof result.stdout === 'string' ? result.stdout : result.stdout ? new TextDecoder().decode(result.stdout) : '').trim();
  if (out === 'aihq-state:refused') return 'refused';
  return result.status === 0 && out === 'aihq-state:ok' ? 'ok' : 'unverified';
}
/** How long one check may take: a first attempt and, after a timeout or launch failure, one longer retry. */
export const STATE_PROTECTION_BUDGETS: readonly number[] = Object.freeze([10_000, 60_000]);
/**
 * Run the fixed access-list check over `paths`, retrying once when it could not decide. The operation's signal, when
 * aborted, stops before the retry (`cancelled`). `program` and `programArgs` are a test seam; Core runs the Windows
 * PowerShell named by the kernel's `\SystemRoot` link, never one found through `%SystemRoot%` or `PATH`.
 */
export function checkStateAcl(root: string, created: boolean, paths: readonly string[], options: { program?: string; programArgs?: readonly string[];
  budgets?: readonly number[]; signal?: AbortSignal } = {}): StateProtectionVerdict {
  let program: string;
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    program = options.program ?? windowsPowerShell();
    // PowerShell itself starts from `%SystemRoot%`, so the child gets the folder the kernel link names.
    if (process.platform === 'win32') {
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'systemroot') delete env[key];
      env.SystemRoot = windowsDirectory();
    }
  } catch { return 'unverified'; }
  const args = [...(options.programArgs ?? []), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `& { ${aclScript} } $env:AIHQ_STATE_PATH $env:AIHQ_STATE_CREATE`];
  const input = paths.map(path => Buffer.from(path, 'utf8').toString('base64')).join('\n') + '\n';
  let verdict: StateProtectionVerdict = 'unverified';
  for (const budget of options.budgets ?? STATE_PROTECTION_BUDGETS) {
    if (options.signal?.aborted) throw new Error('cancelled');
    stateProtectionCounts.aclChecks += 1;
    verdict = classifyStateProtection(spawnSync(program, args, { windowsHide: true, timeout: budget, maxBuffer: 4096, input,
      env: { ...env, AIHQ_STATE_PATH: root, AIHQ_STATE_CREATE: created ? 'yes' : 'no' } }));
    if (verdict !== 'unverified') return verdict;
  }
  return verdict;
}
let operationSignal: AbortSignal | undefined;
/** The current operation's cancellation signal, consulted between state protection attempts. */
export function useStateSignal(signal: AbortSignal | undefined): void { operationSignal = signal; }

/** How often this process ran state protection, and how many Windows ACL checks (PowerShell processes) that started. */
export const stateProtectionCounts = { calls: 0, aclChecks: 0 };

/**
 * Windows only: the state paths this process has proven protected, each with the identity it had when proven (see
 * `proofIdentity`), under one state root. Starting PowerShell costs a fraction of a second, so a path is checked once
 * per identity instead of once per use.
 *
 * Why a proven path stays protected while its identity holds: the check admits a path only when its owner and every
 * Allow entry are the current user, SYSTEM or Administrators, and every directory between it and the state root is
 * admitted the same way. Changing its access list needs its owner or an Allow entry (or a privilege only SYSTEM and
 * Administrators hold), and replacing it needs write or delete access to an admitted directory, so only those trusted
 * principals can do either. A replacement is a new file with a new identity, which is checked again before use. A
 * file's identity includes its change time, which Windows moves when its access list changes, so a file whose access
 * list was widened (even by a trusted program) is checked again before its next use. An identity this process has not
 * proven (a file moved in from elsewhere keeps its own access list) is always checked. What is proven lasts one public
 * operation (see `forgetProvenState`).
 */
let proven: { root: string; paths: Map<string, string> } | undefined;
/**
 * Forget every proven path. Each public operation that reads Core state starts here (Prepare, Apply, managed inventory,
 * removal and update preparation), so a long-lived host (the Workbench) proves its state paths again in every
 * operation rather than trusting one proven earlier. Steps inside one operation, such as Apply's review recheck, keep
 * what the operation proved.
 */
export function forgetProvenState(): void { proven = undefined; operationSignal = undefined; }
/**
 * The identity a path is proven under: its pin (`dev:ino:mode`) and, for a file, its change time. A folder's change time
 * moves whenever an entry is added inside it, so a folder keeps its pin alone; its own access list cannot change
 * without a trusted principal, and anything new inside it is checked or recorded on its own.
 */
function proofIdentity(path: string, pin: string): string {
  if (pin === 'absent') return pin;
  const stats = lstatSync(path, { bigint: true });
  return stats.isDirectory() ? pin : `${pin}:${stats.ctimeNs}`;
}

export function protectState(relativePaths: string[] = []): void {
  stateProtectionCounts.calls += 1;
  const root = stateRoot(); pathPins(root);
  const base = dirname(root);
  try { mkdirSync(base, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  let created = false;
  try { mkdirSync(root, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const rootIdentity = pathPins(root).at(-1)!.identity;
  const stat = lstatSync(root);
  if (!stat.isDirectory()) throw new Error('state-protection');
  const protectedPaths = new Map([[root, rootIdentity]]);
  for (const path of relativePaths) {
    for (const pin of pathPins(join(root, path))) {
      if (pin.identity !== 'absent' && containedPath(root, pin.path)) protectedPaths.set(pin.path, process.platform === 'win32' ? proofIdentity(pin.path, pin.identity) : pin.identity);
    }
  }
  if (process.platform === 'win32') {
    // A new root, or a root that is no longer the one proven, starts again with nothing proven.
    if (created || proven?.root !== root || proven.paths.get(root) !== rootIdentity) proven = { root, paths: new Map() };
    const known = proven.paths;
    const unproven = [...protectedPaths].filter(([path, identity]) => known.get(path) !== identity);
    if (unproven.length === 0) return;
    // -Command uses fixed source; the state path is passed through the environment and the paths on standard input,
    // never concatenated into executable PowerShell text. A check that could not decide stays a refusal, but a
    // retryable one (`state-protection-unverified`); an access list that admits someone else is `state-protection`.
    const verdict = checkStateAcl(root, created, unproven.map(([path]) => path), { ...(operationSignal ? { signal: operationSignal } : {}) });
    if (verdict === 'refused') throw new Error('state-protection');
    if (verdict !== 'ok') throw new Error('state-protection-unverified');
    // Remember a path only if it is still the object that was checked, unchanged: anything replaced or changed meanwhile
    // (a swap and swap back moves the file's change time) is checked next time.
    for (const [path, identity] of unproven) {
      const pin = pathPins(path).at(-1)?.identity;
      if (pin && pin !== 'absent' && proofIdentity(path, pin) === identity) known.set(path, identity);
    }
  } else {
    if (created) chmodSync(root, 0o700);
    for (const path of protectedPaths.keys()) {
      const current = lstatSync(path);
      if (current.uid !== process.getuid?.() || (current.mode & 0o077) !== 0) throw new Error('state-protection');
    }
  }
}

/**
 * Windows only: record the state file this process just created at `relativePath`, so its next protection check needs
 * no PowerShell. `created` is the `dev:ino` of the very object Core created (read from its own handle or staging file),
 * and the path is recorded only while it still holds that object and every folder from the state root down to it is
 * proven with its identity unchanged. Such a folder's own entries can be created only by the trusted principals, and a
 * new entry Core creates there (Node sets no access list of its own) inherits only that folder's proven entries.
 * Anything else is checked.
 */
export function stateWritten(relativePath: string, created: string | undefined): void {
  if (process.platform !== 'win32' || !proven || !created) return;
  const root = stateRoot();
  if (proven.root !== root) return;
  const pins = pathPins(join(root, relativePath));
  const entry = pins.at(-1);
  if (!entry || entry.identity === 'absent' || !containedPath(root, entry.path) || !entry.identity.startsWith(`${created}:`)) return;
  const folders = pins.slice(0, -1).filter(pin => pin.path === root || containedPath(root, pin.path));
  if (folders.length === 0 || folders[0]!.path !== root || folders.some(pin => proven!.paths.get(pin.path) !== pin.identity)) return;
  proven.paths.set(entry.path, proofIdentity(entry.path, entry.identity));
}
/** Write a state file atomically and record it as written by Core (see `stateWritten`). */
export function writeStateFile(relativePath: string, contents: Buffer, mode: number, exclusive = false, maxFileBytes = STATE_FILE_BYTES): void {
  let created: string | undefined;
  stateFiles(maxFileBytes).writeAtomic(relativePath, contents, mode, exclusive, identity => { created = identity; });
  stateWritten(relativePath, created);
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
/**
 * The digest of a root's stored receipt (`null` when there is none), without settling pending members. Reading it runs
 * the same protection check and read as `readOwnership`, which also admits the receipt (strict parse and validation).
 * `admitted` names digests of receipt bytes already admitted for this target under the same home folder: bytes with one
 * of those digests are the very bytes admitted before, so their admission is not repeated. Any other bytes, or any
 * bytes once the home folder differs, are admitted exactly as before.
 */
export interface AdmittedReceipts { home: string; digests: Set<string> }
export function ownershipDigest(target: string, admitted?: AdmittedReceipts): string | null {
  if (!admitted) return readOwnership(target, false).digest;
  try { lstatSync(stateRoot()); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
  protectState([ownershipPath(target)]);
  const bytes = ownershipBytes(ownershipPath(target));
  if (!bytes) return null;
  const digest = sha256(bytes);
  if (homedir() !== admitted.home || !admitted.digests.has(digest)) admitOwnership(bytes, target);
  return digest;
}
/** Strict admission of stored receipt bytes for `target`: the parse and validation `readOwnership` applies. */
export function admitOwnership(bytes: Uint8Array, target: string): Ownership {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return admitParsed(parseStrictJsonObjectV1(text, 'ownership'), text, target);
}
/** Admit a strictly parsed receipt: its expanded record is valid, and the receipt is that record's one stored form. */
function admitParsed(parsed: Record<string, unknown>, text: string, target: string): Ownership {
  const value = expandOwnership(parsed);
  validateOwnership(value, target);
  if (ownershipText(value) !== text) throw new Error('ownership-invalid');
  return value;
}
/** Read a stored receipt's bytes (`null` when absent). */
const ownershipBytes = (path: string) => stateFiles(OWNERSHIP_RECORD_BYTES).read(path);
export function readOwnership(target: string, settle = true): { value: Ownership; digest: string | null; bytes: number } {
  const empty: Ownership = { schema: RECEIPT, target, members: {} };
  try { lstatSync(stateRoot()); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return { value: empty, digest: null, bytes: 0 };
    throw error;
  }
  // Custody is meaningful only in the protected store; existing records in a
  // writable/untrusted root must not establish ownership, including in previews.
  protectState([ownershipPath(target)]);
  const bytes = ownershipBytes(ownershipPath(target));
  if (!bytes) return { value: empty, digest: null, bytes: 0 };
  const value = admitOwnership(bytes, target);
  return { value: settle ? settled(value) : value, digest: sha256(bytes), bytes: bytes.length };
}

/** Protect a set of receipt paths once, then validate each value against its target. */
export function readOwnershipBatch(targets: readonly string[]): Map<string, { value: Ownership; digest: string | null; bytes: number }> {
  const unique = [...new Set(targets)];
  const result = new Map<string, { value: Ownership; digest: string | null; bytes: number }>();
  if (unique.length === 0) return result;
  try { lstatSync(stateRoot()); } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    for (const target of unique) result.set(target, { value: { schema: RECEIPT, target, members: {} }, digest: null, bytes: 0 });
    return result;
  }
  // One check for the whole batch: the paths go on standard input, so their number doesn't bound the environment.
  protectState(unique.map(ownershipPath));
  for (const target of unique) {
    const bytes = ownershipBytes(ownershipPath(target));
    if (!bytes) {
      result.set(target, { value: { schema: RECEIPT, target, members: {} }, digest: null, bytes: 0 });
      continue;
    }
    const value = admitOwnership(bytes, target);
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
  for (const name of names) {
    check();
    const data = ownershipBytes(`ownership/${name}`);
    if (!data) throw new Error('ownership-invalid');
    total += data.length;
    if (total > 32 * 1024 * 1024) throw new Error('ownership-limit');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    const parsed = parseStrictJsonObjectV1(text, 'ownership');
    if (typeof parsed.target !== 'string' || !isAbsolute(parsed.target) ||
      ownershipPath(parsed.target) !== `ownership/${name}`) throw new Error('ownership-invalid');
    receipts.push(settled(admitParsed(parsed, text, parsed.target)));
  }
  return { receipts, count: names.length, bytes: total };
}

export function validateOwnership(input: unknown, target: string): asserts input is Ownership {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ownership-invalid');
  const value = input as Record<string, unknown>;
  if (!OWNERSHIP_VERSIONS.includes(value.schema as string) || value.target !== target || !value.members || typeof value.members !== 'object' || Array.isArray(value.members)) throw new Error('ownership-invalid');
  if (Object.keys(value).some(key => !['schema', 'target', 'members', 'selections', 'directories', 'items'].includes(key)) || Object.keys(value.members).length > 8192) throw new Error('ownership-invalid');
  if (value.directories !== undefined && (!atLeast(value.schema, RECEIPT) || !validCreatedDirectories(value.directories))) throw new Error('ownership-invalid');
  // Reuse the resolved home only within this synchronous validation call.
  let resolvedHome: string | undefined;
  const homeRoot = (): string => resolvedHome ??= userHomeRoot();
  for (const [key, member] of Object.entries(value.members)) {
    if (!member || typeof member !== 'object') throw new Error('ownership-invalid');
    const m = member as Owner;
    if (Object.keys(member).some(key => !['managementId', 'recipeIdentity', 'sha256', 'mode', 'descriptor', 'claims', 'canonicalSha256', 'tomlTable', 'approval', 'createdContainer', 'createdFile', 'createdContainers', 'sharedContent', 'displaced'].includes(key))) throw new Error('ownership-invalid');
    if (m.displaced !== undefined && (!validDisplaced(m.displaced) || m.claims === undefined || !(m.descriptor?.kind === 'entry' || m.descriptor?.kind === 'block') ||
      m.displaced.claims.some(claim => m.claims!.some(live => live.scope === claim.scope && live.managementId === claim.managementId) ||
        claim.scope === 'user' && target !== homeRoot()))) throw new Error('ownership-invalid');
    if (needs16(m) && !atLeast(value.schema, RECEIPT) ||
        m.approval !== undefined && (!m.approval || typeof m.approval !== 'object' || Object.keys(m.approval).length !== 1 || typeof m.approval.tool !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(m.approval.tool) || !(m.descriptor?.kind === 'member' || m.descriptor?.kind === 'entry' && ['json', 'jsonc'].includes(m.descriptor.format))) ||
        Object.hasOwn(m, 'createdContainer') && (m.createdContainer !== true || m.descriptor?.kind !== 'member') ||
        Object.hasOwn(m, 'createdFile') && m.createdFile !== true ||
        Object.hasOwn(m, 'createdContainers') && (!Array.isArray(m.createdContainers) || m.createdContainers.length === 0 || m.createdContainers.length > 32 ||
          !m.createdContainers.every(path => Array.isArray(path) && path.length > 0 && path.length <= 32 && path.every(part => typeof part === 'string' && part.length > 0 && part.length <= 256))) ||
        Object.hasOwn(m, 'sharedContent') && (!atLeast(value.schema, RECEIPT) || m.descriptor?.kind !== 'block' ||
          sharedBlockRole(m.descriptor.startMarker, m.descriptor.endMarker) === null ||
          typeof m.sharedContent !== 'string' || m.sharedContent.length > 65536)) throw new Error('ownership-invalid');
    // Hook custody exists only in a 1.1 or newer root, and always carries its canonical digest.
    if ((m.descriptor?.kind === 'hook') !== (m.canonicalSha256 !== undefined) ||
        m.canonicalSha256 !== undefined && (typeof m.canonicalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.canonicalSha256)) ||
        m.descriptor?.kind === 'hook' && !atLeast(value.schema, RECEIPT) ||
        m.descriptor?.kind === 'entry' && ['ini', 'yaml', 'properties'].includes(m.descriptor.format) && !atLeast(value.schema, RECEIPT) ||
        quotedToml(m.descriptor) && !atLeast(value.schema, RECEIPT) ||
        Object.hasOwn(m, 'tomlTable') && (!atLeast(value.schema, RECEIPT) || !tomlTableAllowed(m.descriptor) ||
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
  if (value.items !== undefined && (!atLeast(value.schema, RECEIPT) ||
    !validItems(value as unknown as Ownership, (scope, managementId) => claimIdentity(scope, managementId, target)))) throw new Error('ownership-invalid');
  validatePending(value.items as Record<string, CustodyItem> | undefined, value.schema as Ownership['schema'], target);
}
/** A pending owner is exactly the custody its member would publish, held to the same rules. */
function validatePending(items: Record<string, CustodyItem> | undefined, schema: Ownership['schema'], target: string): void {
  for (const item of Object.values(items ?? {})) for (const entry of item.pending ?? []) {
    if (!validDescriptor(entry.descriptor) || memberKey(entry.descriptor) !== entry.key) throw new Error('ownership-invalid');
    if (entry.owner === null) continue;
    if (canonicalJson(entry.owner.descriptor ?? null) !== canonicalJson(entry.descriptor) ||
        !entry.owner.claims?.some(claim => claim.managementId === item.managementId && claim.scope === item.scope)) throw new Error('ownership-invalid');
    validateOwnership({ schema, target, members: { [entry.key]: entry.owner } }, target);
  }
}

/**
 * What one admitted receipt held: the custody objects it serialized, by key, and their parsed (admitted) data. Custody
 * objects are never changed in place; every change replaces the object, so the same object serializes the same.
 */
export interface AdmittedImage {
  schema: unknown; members: Map<string, unknown>; selections: unknown; selectionEntries: Map<string, unknown>;
  directories: unknown; items: Map<string, unknown>; parsed: WeakMap<object, unknown>;
}
const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
/** The strictly admitted data of one serialized part of a receipt, `depth` levels below its root (the root is level 1). */
function admittedPart(value: unknown, depth: number): unknown {
  const text = JSON.stringify(value);
  // A `__proto__` key reads differently through the strict parser; such a part is left to full admission.
  if (text === undefined || text.includes('"__proto__"')) throw new Error('ownership-invalid');
  assertWellFormedNfcV1(text, 'ownership JSON text');
  return assertStrictJsonValueV1(JSON.parse(text), 'ownership', true, new WeakSet(), depth);
}
function imageOf(value: Ownership, parsed: WeakMap<object, unknown>): AdmittedImage {
  return { schema: value.schema, members: new Map(Object.entries(value.members)), selections: value.selections,
    selectionEntries: new Map(Object.entries(value.selections ?? {})), directories: value.directories,
    items: new Map(Object.entries(value.items ?? {})), parsed };
}
/**
 * Admit the receipt bytes `text` (`JSON.stringify(next)`) that this process just wrote for `target`, given the image of
 * the receipt admitted before it under the same home folder. Returns the new image exactly when `admitOwnership` would
 * admit `text`, and `undefined` when it would not or when that is not shown here; the bytes then stay unadmitted and the
 * next read admits them in full. Only the parts that changed are parsed and validated, each under the same rules:
 *
 * - The receipt is the strict text JSON.stringify writes, so its strict parse is the parse of each part, and each part
 *   (a member, selection, item or the directories) is checked as strict JSON at its own depth.
 * - Each member, selection and directory record is validated on its own, as `validateOwnership` does; an unchanged one
 *   (the same object, under the same schema, target and home) keeps its earlier result.
 * - An item depends on its own record, the members its claim holds and its selection record, so it is validated again
 *   when any of them changed, against all members and selections; the counts are checked on the whole receipt.
 */
export function admitWrittenOwnership(previous: AdmittedImage | undefined, next: Ownership, text: string, target: string): AdmittedImage | undefined {
  try {
    if (!previous) {
      const value = admitOwnership(Buffer.from(text), target);
      const parsed = new WeakMap<object, unknown>();
      const pair = (live: Record<string, unknown> | undefined, stored: unknown) => {
        for (const [key, entry] of Object.entries(live ?? {})) if (entry && typeof entry === 'object') parsed.set(entry, (stored as Record<string, unknown>)[key]);
      };
      pair(next.members as Record<string, unknown>, value.members);
      pair(next.selections as Record<string, unknown> | undefined, value.selections);
      pair(next.items as Record<string, unknown> | undefined, value.items);
      return imageOf(next, parsed);
    }
    const value = next as unknown as Record<string, unknown>;
    if (next.schema !== previous.schema || next.target !== target || !OWNERSHIP_VERSIONS.includes(next.schema) ||
        Object.keys(value).some(key => !['schema', 'target', 'members', 'selections', 'directories', 'items'].includes(key)) ||
        !plainObject(next.members) || Object.keys(next.members).length > 8192) return undefined;
    const parsed = previous.parsed;
    const part = (entry: unknown, depth: number) => {
      if (entry && typeof entry === 'object' && parsed.has(entry)) return parsed.get(entry);
      const data = admittedPart(entry, depth);
      if (entry && typeof entry === 'object') parsed.set(entry, data);
      return data;
    };
    // Claims whose items must be validated again: those of every changed or removed member, before and after.
    const affected = new Set<string>();
    const touch = (owner: unknown) => {
      for (const claim of ((owner as Owner | undefined)?.claims ?? [])) affected.add(claimIdentity(claim.scope, claim.managementId, target));
    };
    const members: Record<string, unknown> = {};
    for (const [key, owner] of Object.entries(next.members)) {
      if (key === '__proto__' || !owner || typeof owner !== 'object') return undefined;
      if (previous.members.get(key) !== owner) {
        assertWellFormedNfcV1(JSON.stringify(key), 'ownership JSON text');
        const data = part(owner, 3);
        validateOwnership({ schema: next.schema, target, members: { [key]: data } }, target);
        touch(previous.members.get(key)); touch(owner);
      }
      members[key] = part(owner, 3);
    }
    for (const [key, owner] of previous.members) if (!Object.hasOwn(next.members, key)) touch(owner);
    if (next.directories !== previous.directories && next.directories !== undefined)
      validateOwnership({ schema: next.schema, target, members: {}, directories: admittedPart(next.directories, 2) }, target);
    let selections: Record<string, unknown> | undefined;
    if (next.selections !== undefined) {
      if (!plainObject(next.selections) || Object.keys(next.selections).length > 4096) return undefined;
      selections = {};
      for (const [key, claim] of Object.entries(next.selections)) {
        if (key === '__proto__' || !claim || typeof claim !== 'object') return undefined;
        if (previous.selectionEntries.get(key) !== claim) {
          assertWellFormedNfcV1(JSON.stringify(key), 'ownership JSON text');
          validateOwnership({ schema: next.schema, target, members: {}, selections: { [key]: part(claim, 3) } }, target);
          affected.add(key);
        }
        selections[key] = part(claim, 3);
      }
    }
    for (const key of previous.selectionEntries.keys()) if (!Object.hasOwn(next.selections ?? {}, key)) affected.add(key);
    if (next.items !== undefined) {
      if (!plainObject(next.items) || !atLeast(next.schema, RECEIPT)) return undefined;
      const count = Object.keys(next.items).length;
      if (count === 0 || count > 4096) return undefined;
      const items: Record<string, CustodyItem> = {};
      for (const [id, item] of Object.entries(next.items)) {
        if (id === '__proto__' || !item || typeof item !== 'object') return undefined;
        if (previous.items.get(id) !== item || affected.has(id)) {
          assertWellFormedNfcV1(JSON.stringify(id), 'ownership JSON text');
          items[id] = part(item, 3) as CustodyItem;
        }
      }
      if (Object.keys(items).length) {
        if (!validItems({ members: members as Record<string, Owner>, selections: selections as Record<string, Claim> | undefined, items },
          (scope, managementId) => claimIdentity(scope, managementId, target))) return undefined;
        validatePending(items, next.schema, target);
      }
    }
    return imageOf(next, parsed);
  } catch { return undefined; }
}

export function writeHistory(runId: string, result: unknown, logging: 'on' | 'off'): RecordStatus {
  if (logging === 'off') return { status: 'disabled', reason: 'logging-off' };
  const reference = `runs/${runId}.json`;
  const written: RecordStatus = { status: 'written', reference };
  try {
    const bytes = Buffer.from(JSON.stringify({ ...(result as object), record: written }));
    if (bytes.length > 1_048_576) return { status: 'failed', reason: 'record-limit', diagnosticId: 'record-limit' };
    protectState([reference]); writeStateFile(reference, bytes, 0o600);
    rotateHistory(reference);
    return written;
  } catch { return { status: 'failed', reason: 'record-write', diagnosticId: 'record-write' }; }
}

/** Routine history keeps at most this many run records; the oldest go first. */
export const HISTORY_LIMIT = 1000;
function rotateHistory(keep: string): void {
  try {
    const folder = join(stateRoot(), 'runs');
    const names = readdirSync(folder).filter(name => /^[a-f0-9-]{36}\.json$/.test(name) && `runs/${name}` !== keep);
    if (names.length < HISTORY_LIMIT) return;
    const aged = names.map(name => { try { return { name, at: lstatSync(join(folder, name)).mtimeMs }; } catch { return { name, at: 0 }; } })
      .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1));
    for (const { name } of aged.slice(0, names.length - HISTORY_LIMIT + 1)) {
      protectState([`runs/${name}`]);
      try { unlinkSync(join(folder, name)); } catch { /* left for the next run */ }
    }
  } catch { /* history rotation never fails a run */ }
}
const LOCK_HOLDER = 'holder.json';
/** How old an empty lock folder (no holder record) or a reclaim guard must be before it counts as a crash leftover. */
export const STALE_LOCK_MS = 120_000;
/**
 * Take a target's state lock. The lock names its holder (process and host), so a lock left by a process that no longer
 * runs on this host can be reclaimed after a crash. An empty lock folder older than `STALE_LOCK_MS` (a crash between
 * creating the lock and naming its holder) is reclaimable too. A lock from another host, or held by a running process,
 * is never taken over. Reclaiming assumes one process namespace per host name.
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
  try { writeFileSync(holder, JSON.stringify({ pid: process.pid, host: hostname() }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    // A lock that cannot name its holder is released at once rather than left for others to wait on.
    try { rmdirSync(lock); } catch { /* An empty leftover is reclaimable once stale. */ }
    throw error;
  }
  return () => {
    // Never recursively delete locks; leftovers need deliberate inspection.
    if (pathPins(lock).at(-1)?.identity !== pins.at(-1)?.identity) return;
    try { unlinkSync(holder); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    rmdirSync(lock);
  };
}
/**
 * `lockTarget`, waiting while another Apply holds the root's lock, in this process or another (at most `waitMs`, and
 * never past `signal`), so competing applies on one root run one after the other and the later one re-checks what it
 * reviewed once it holds the lock. The wait backs off from 20 ms to 250 ms between attempts; each attempt re-checks
 * whether the holder is gone.
 */
export async function waitLockTarget(target: string, signal?: AbortSignal, waitMs = 60_000): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  for (let pause = 20; ; pause = Math.min(pause * 2, 250)) {
    try { return lockTarget(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline || signal?.aborted) throw error;
    }
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, Math.max(1, Math.min(pause, deadline - Date.now())));
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
/** A crash leftover: an empty folder of this user's, older than `STALE_LOCK_MS`. */
function staleEmptyFolder(path: string): boolean {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || readdirSync(path).length !== 0 || Date.now() - stats.mtimeMs < STALE_LOCK_MS) return false;
    return process.platform === 'win32' || typeof process.getuid !== 'function' || stats.uid === process.getuid();
  } catch { return false; }
}
/** The lock's recorded holder is on this host and no longer runs, or the lock is an empty crash leftover. */
function holderGone(lock: string): boolean {
  let holder: { pid: unknown; host: unknown };
  try {
    pathPins(lock);
    if (!lstatSync(lock).isDirectory() || readdirSync(lock).some(name => name !== LOCK_HOLDER)) return false;
    if (staleEmptyFolder(lock)) return true;
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
  try { mkdirSync(guard, { mode: 0o700 }); }
  catch {
    // A guard left by a reclaimer that crashed is an empty, stale folder: clear it once and try again.
    if (!staleEmptyFolder(guard)) return false;
    try { rmdirSync(guard); mkdirSync(guard, { mode: 0o700 }); } catch { return false; }
  }
  try {
    try { lstatSync(lock); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
    if (!holderGone(lock)) return false;
    try { unlinkSync(join(lock, LOCK_HOLDER)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    rmdirSync(lock);
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
  const record = Buffer.from(ownershipText(update));
  if (record.length > OWNERSHIP_RECORD_BYTES) throw new Error('state-unwritable');
  const staged = `ownership/.pending-${runId}-${sha256(target)}.json`;
  protectState([path, staged, `recovery/${runId}`]);
  const files = stateFiles(OWNERSHIP_RECORD_BYTES); let stagedWritten = false;
  try {
    // The caller supplies a conservative bound covering intermediate custody
    // and intent records. Stage it in the actual destination directory to prove
    // capacity and receipt creation before any target changes.
    writeStateFile(staged, record, 0o600, true, OWNERSHIP_RECORD_BYTES); stagedWritten = true;
    const current = files.read(path);
    // Existing receipts also require replacement permission. Probe that exact
    // operation with unchanged bytes; this adds no claim of target ownership.
    if (current) writeStateFile(path, current, 0o600, false, OWNERSHIP_RECORD_BYTES);
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
      const bytes = ownershipBytes(`ownership/${name}`); if (!bytes) throw new Error('ownership-invalid');
      entries.push([name, sha256(bytes)]);
      const value = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'ownership');
      if (typeof value.target !== 'string' || !isAbsolute(value.target) || ownershipPath(value.target) !== `ownership/${name}`) throw new Error('ownership-invalid');
      targets.push(value.target);
    } catch { unverifiable = true; if (!entries.some(([entry]) => entry === name)) entries.push([name, 'unverifiable']); }
  }
  return { targets, entries, unverifiable };
}
