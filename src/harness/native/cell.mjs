// Owned disposable verification cell: exclusive owner-only child, once-only staging, persistence
// observation and identity-checked removal. It never deletes the caller's parent or follows links.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isSafeRelativePath } from './canonical.mjs';
import { nativeBounds } from './contracts.mjs';
import { configurationDigest, sha256, treeDigest } from './digest.mjs';

const unavailable = reason => ({ status: 'unavailable', reason });
const AREAS = ['home', 'project', 'scratch', 'credentials', 'observation'];
const OS_ADMIN_SIDS = new Set(['SY', 'BA', 'S-1-5-18', 'S-1-5-32-544']);
const system32 = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

function windowsUserSid() {
  const out = execFileSync(join(system32(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10000 }).toString();
  const match = /"(S-1-5-[0-9-]+)"/.exec(out);
  return match ? match[1] : null;
}

// Observe the DACL trustees of a path through icacls' SDDL export (locale independent).
export function windowsDaclPrincipals(path) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'aihq-acl-'));
    const out = join(dir, 'acl.txt');
    execFileSync(join(system32(), 'icacls.exe'), [path, '/save', out, '/q'], { windowsHide: true, timeout: 15000 });
    const text = readFileSync(out).toString('utf16le').replace(/^\uFEFF/, '');
    const sddl = /D:[^\r\n]*/.exec(text);
    if (!sddl) return { status: 'unavailable' };
    const sids = [];
    for (const ace of sddl[0].matchAll(/\(([^)]*)\)/g)) {
      const fields = ace[1].split(';');
      if (fields[0] === 'A' && fields[5]) sids.push(fields[5]);
    }
    return { status: 'observed', sids };
  } catch { return { status: 'unavailable' }; } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}

function hardenWindows(path) {
  try {
    const sid = windowsUserSid();
    if (!sid) return false;
    execFileSync(join(system32(), 'icacls.exe'), [path, '/setowner', `*${sid}`, '/q'], { windowsHide: true, timeout: 15000 });
    execFileSync(join(system32(), 'icacls.exe'), [path, '/inheritance:r', '/grant:r',
      `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/q'], { windowsHide: true, timeout: 15000 });
    const seen = windowsDaclPrincipals(path);
    // SDDL abbreviates the built-in local Administrator account (RID 500) as LA.
    const own = entry => entry === sid || (entry === 'LA' && sid.endsWith('-500'));
    return seen.status === 'observed' && seen.sids.length > 0 && seen.sids.every(entry => own(entry) || OS_ADMIN_SIDS.has(entry));
  } catch { return false; }
}

function ownerOnlyPosix(path) {
  const stat = statSync(path);
  return stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}

function windowsOwnerSid(path) {
  try {
    // Read the security descriptor directly; Get-Acl module loading can stall in a minimal environment.
    const script = "$ErrorActionPreference='Stop';$p=$env:AIHQ_NATIVE_OWNER_PATH;$s=[System.Security.AccessControl.AccessControlSections]::Owner;$acl=if([System.IO.Directory]::Exists($p)){[System.IO.Directory]::GetAccessControl($p,$s)}else{[System.IO.File]::GetAccessControl($p,$s)};[Console]::Write($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)";
    const out = execFileSync(join(system32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], env: { SystemRoot: process.env.SystemRoot, AIHQ_NATIVE_OWNER_PATH: path } }).toString().trim();
    return /^S-1-5-[0-9-]+$/.test(out) ? out : null;
  } catch { return null; }
}

// true/false when both owner and access policy are observed; null when either facility is unavailable.
export function isOwnerOnly(path) {
  if (process.platform !== 'win32') { try { return ownerOnlyPosix(path); } catch { return null; } }
  try {
    const seen = windowsDaclPrincipals(path);
    const sid = windowsUserSid();
    const owner = windowsOwnerSid(path);
    if (seen.status !== 'observed' || !sid || !owner || seen.sids.length === 0) return null;
    if (owner !== sid) return false;
    return seen.sids.every(entry => entry === sid || (entry === 'LA' && sid.endsWith('-500')) || OS_ADMIN_SIDS.has(entry));
  } catch { return null; }
}

export function createOwnedCell({ parent } = {}) {
  let realParent;
  try {
    if (parent === undefined) realParent = realpathSync.native(tmpdir());
    else {
      if (typeof parent !== 'string' || parent.length === 0 || parent.length > 4096 || parent.includes('\0') ||
          !isAbsolute(parent) || !lstatSync(parent).isDirectory()) return unavailable('sandbox-root-unavailable');
      realParent = realpathSync.native(parent);
    }
    if (!statSync(realParent).isDirectory()) return unavailable('sandbox-root-unavailable');
  } catch { return unavailable('sandbox-root-unavailable'); }

  const basename = `aihq-native-${randomBytes(8).toString('hex')}`;
  const path = join(realParent, basename);
  try { mkdirSync(path, { mode: 0o700 }); } catch { return unavailable('sandbox-root-unavailable'); }
  const discard = () => { try { rmSync(path, { recursive: true, force: true }); } catch { /* retained by the caller's parent */ } };
  try {
    const protectedChild = process.platform === 'win32' ? hardenWindows(path) : ownerOnlyPosix(path);
    if (!protectedChild) { discard(); return unavailable('sandbox-root-unavailable'); }
    const cell = { basename, path, parent: realParent };
    for (const area of AREAS) { cell[area] = join(path, area); mkdirSync(cell[area], { mode: 0o700 }); }
    mkdirSync(join(cell.scratch, 'tmp'), { mode: 0o700 });
    const identity = statSync(path, { bigint: true });
    cell.identity = { dev: identity.dev, ino: identity.ino };
    return { status: 'created', cell };
  } catch { discard(); return unavailable('sandbox-root-unavailable'); }
}

const targetOf = (cell, file) => join(cell[file.root], ...file.path.split('/'));

export function stageCellFiles(cell, files) {
  for (const file of files)
    if ((file.root !== 'home' && file.root !== 'project') || !isSafeRelativePath(file.path)) return unavailable('material-path-unsafe');
  try {
    for (const file of files) if (existsSync(targetOf(cell, file))) return unavailable('staging-unavailable');
    for (const file of files) {
      const target = targetOf(cell, file);
      mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(target, file.bytes, { flag: 'wx', mode: 0o600 });
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.nlink !== 1) return unavailable('staging-unavailable');
    }
  } catch { return unavailable('staging-unavailable'); }
  return { status: 'staged' };
}

function readSelected(cell, file) {
  const target = targetOf(cell, file);
  let fd;
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > nativeBounds.materialFileBytes) return null;
    fd = openSync(target, 'r');
    const opened = fstatSync(fd);
    if (opened.size !== stat.size) return null;
    const bytes = Buffer.alloc(opened.size);
    readSync(fd, bytes, 0, opened.size, 0);
    return { root: file.root, path: file.path, member: { sha256: sha256(bytes), byteLength: bytes.length } };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// Known configuration-loading locations. Anything present here that is not selected is a conflict.
const LOADING_PATHS = {
  project: ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json', '.claude/settings.json', '.claude/settings.local.json',
    '.claude/rules', '.claude/commands', '.claude/agents', '.claude/skills', '.claude/hooks'],
  home: ['.claude/CLAUDE.md', '.claude/settings.json', '.claude/settings.local.json', '.claude/rules', '.claude/commands',
    '.claude/agents', '.claude/skills', '.claude/hooks']
};

// Compare actual selected bytes with the pinned digests, and look for new loading files.
export function observeCellConfiguration(cell, { outputPaths, guardrailPaths, outputTreeSha256, guardrailsSha256 }) {
  const pinned = configurationDigest({ outputTreeSha256, guardrailsSha256 });
  const read = paths => paths.map(file => readSelected(cell, file));
  const output = read(outputPaths), guardrails = read(guardrailPaths);
  const selected = new Set([...outputPaths, ...guardrailPaths].map(file => `${file.root}/${file.path}`));
  let unexpectedLoadingFiles = 0;
  for (const [root, paths] of Object.entries(LOADING_PATHS))
    for (const path of paths)
      if (!selected.has(`${root}/${path}`) && existsSync(join(cell[root], ...path.split('/')))) unexpectedLoadingFiles += 1;
  const complete = ![...output, ...guardrails].includes(null);
  const observed = complete ? configurationDigest({ outputTreeSha256: treeDigest(output), guardrailsSha256: treeDigest(guardrails) }) : null;
  const changed = !complete || observed !== pinned || unexpectedLoadingFiles > 0;
  return { status: changed ? 'changed' : 'unchanged', stagedConfigurationDigest: pinned,
    observedConfigurationDigest: observed, unexpectedLoadingFiles };
}

// Remove only the exclusive child, and only when its directory identity is unchanged and no
// process may still be writing. Otherwise retain it and report which condition applies.
export function removeOwnedCell(cell, { processesConfirmed }) {
  const retained = reason => ({ files: 'retained', reason, retainedCell: cell.basename });
  if (!processesConfirmed) return retained('termination-unresolved');
  try {
    const stat = lstatSync(cell.path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== cell.identity.dev || stat.ino !== cell.identity.ino ||
        resolve(realpathSync.native(cell.path)) !== resolve(join(realpathSync.native(cell.parent), cell.basename)))
      return retained('cleanup-unresolved');
    rmSync(cell.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return existsSync(cell.path) ? retained('cleanup-unresolved') : { files: 'removed', reason: null, retainedCell: null };
  } catch { return retained('cleanup-unresolved'); }
}
