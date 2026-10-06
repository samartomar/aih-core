// Bounded capture and verification of the installed Anthropic SRT dependency closure
// against the packaged fixed lock at ./linux/runtime-lock.json.
//
// Read-only: no dynamic import, evaluation, package script, network use or command
// execution. The packaged lock is the expected material; observed bytes are compared
// with its pins and are never substituted for them. Only identity pins (absolute path,
// sha256, byte length) are returned; raw file data is never retained or returned.
//
// The installed roots are resolved with createRequire from this module (the vendor) and
// from the vendor manifest (its transitive dependencies), so both the normal installed
// bundled npm layout and this repository's source layout are supported. Each declared
// runtime dependency is re-resolved from its parent package and must land on the exact
// root that was verified, never on a shadow copy.
//
// This is deliberately NOT an atomic adversarial filesystem snapshot. Files are opened
// without following links, path/handle identities are compared before, during and after
// each bounded read, package roots are rechecked after capture, and the observed tree
// digest must equal the packaged tree digest. A same-UID writer that wins a race inside
// the capture window is not defeated, and `ready` is not proof the tree stayed stable
// afterwards.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHA256_RE, canonicalJson, compareCodeUnits, hasExactKeys, isRecord, isSafeInteger,
  isSafeRelativePath, parseStrictJson, sha256Hex } from './canonical.mjs';
import { nativeBounds } from './contracts.mjs';

const LOCK_URL = new URL('./linux/runtime-lock.json', import.meta.url);
// Closed validation bounds. `materialFileBytes` is the existing 8 MiB material-file bound.
const MAX_LOCK_BYTES = 512 * 1024;
const MAX_FILES = 1024;
const MAX_FILE_BYTES = nativeBounds.materialFileBytes;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = nativeBounds.jsonDepth;
const FIXED_PACKAGE_COUNT = 5;
const MAX_MANIFEST_BYTES = 65536;
const MAX_DEPENDENCY_RANGE_BYTES = 256;
const MAX_PACKAGE_NAME_BYTES = 214;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{64,128}={0,2}$/;
const RELEASE_COMMIT_RE = /^[0-9a-f]{40}$/;
// Windows rejects the Linux O_NOFOLLOW flag; the lstat guards still reject links there.
const OPEN_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0));

class LimitError extends Error {}
class ChangedError extends Error {}
const limitExceeded = () => { throw new LimitError('limit-exceeded'); };
const changed = () => { throw new ChangedError('executable-changed'); };
const unavailable = reason => ({ status: 'unavailable', reason });

// Identity of one observed object. dev/ino bind which object it is; size and the two
// change timestamps bind its observed bytes. A dev/ino reported as 0 (some platforms,
// especially Windows) is treated as unknown rather than as a mismatch.
const fileRef = stat => ({ dev: stat.dev, ino: stat.ino });
const sameRef = (a, b) => (a.dev === b.dev || a.dev === 0 || b.dev === 0) &&
  (a.ino === b.ino || a.ino === 0 || b.ino === 0);
const identity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size,
  mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const sameIdentity = (a, b) => sameRef(a, b) && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

// A package name is a bounded npm name. Duplicate and unknown names are rejected by callers.
function validPackageName(value) {
  return typeof value === 'string' && Buffer.byteLength(value) <= MAX_PACKAGE_NAME_BYTES &&
    PACKAGE_NAME_RE.test(value);
}

// The packaged lock's file lists are in the generator's order: a depth-first walk whose
// directory entries are sorted by UTF-16 code unit. Rebuild that order from the paths and
// require an exact match, so duplicates, file/directory conflicts and unsorted lists are
// rejected without touching the filesystem.
function canonicalPathOrder(paths) {
  const root = { children: new Map(), leaf: false };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      let child = node.children.get(part);
      if (!child) { child = { children: new Map(), leaf: false }; node.children.set(part, child); }
      if (index === parts.length - 1) {
        if (child.leaf || child.children.size > 0) return false;
        child.leaf = true;
      } else if (child.leaf) return false;
      node = child;
    }
  }
  const produced = [];
  const visit = (node, prefix) => {
    for (const name of [...node.children.keys()].sort(compareCodeUnits)) {
      const child = node.children.get(name);
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (child.leaf) produced.push(path);
      else visit(child, path);
    }
  };
  visit(root, '');
  return produced.length === paths.length && produced.every((path, index) => path === paths[index]);
}

// Portable closed-shape and bound validation for the packaged runtime lock. Host-free:
// callers use it to reject a malformed or over-bound lock before any filesystem work.
export function validateLinuxRuntimeLock(value) {
  try {
    if (!hasExactKeys(value, ['format', 'vendor', 'packages', 'treeSha256'])) return false;
    if (value.format !== 1 || !SHA256_RE.test(value.treeSha256)) return false;
    const vendor = value.vendor;
    if (!hasExactKeys(vendor, ['name', 'version', 'releaseCommit', 'archiveIntegrity'])) return false;
    if (!validPackageName(vendor.name) || !VERSION_RE.test(vendor.version)) return false;
    if (!RELEASE_COMMIT_RE.test(vendor.releaseCommit) || !INTEGRITY_RE.test(vendor.archiveIntegrity)) return false;
    if (!Array.isArray(value.packages) || value.packages.length !== FIXED_PACKAGE_COUNT) return false;
    const names = new Set();
    let totalFiles = 0;
    let totalBytes = 0;
    const digest = [];
    for (const pkg of value.packages) {
      if (!hasExactKeys(pkg, ['name', 'version', 'integrity', 'files'])) return false;
      if (!validPackageName(pkg.name) || names.has(pkg.name)) return false;
      names.add(pkg.name);
      if (!VERSION_RE.test(pkg.version) || !INTEGRITY_RE.test(pkg.integrity)) return false;
      if (!Array.isArray(pkg.files)) return false;
      const paths = new Set();
      const files = [];
      for (const file of pkg.files) {
        if (!hasExactKeys(file, ['path', 'byteLength', 'sha256'])) return false;
        if (!isSafeRelativePath(file.path) || file.path.split('/').length > MAX_DEPTH) return false;
        if (!isSafeInteger(file.byteLength, 0, MAX_FILE_BYTES)) return false;
        if (!SHA256_RE.test(file.sha256) || paths.has(file.path)) return false;
        paths.add(file.path);
        totalFiles += 1;
        totalBytes += file.byteLength;
        if (totalFiles > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) return false;
        files.push({ path: file.path, byteLength: file.byteLength, sha256: file.sha256 });
      }
      if (!canonicalPathOrder(pkg.files.map(file => file.path))) return false;
      digest.push({ name: pkg.name, version: pkg.version, integrity: pkg.integrity, files });
    }
    if (value.packages[0].name !== vendor.name || value.packages[0].version !== vendor.version ||
        value.packages[0].integrity !== vendor.archiveIntegrity) return false;
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_LOCK_BYTES) return false;
    return sha256Hex(canonicalJson(digest)) === value.treeSha256;
  } catch { return false; }
}

// Read one bounded regular file. Symlinks, junctions and special files are rejected, never
// followed. The path identity, the handle identity and a fresh path identity after the read
// must all agree, and a partial read is a failure. `capture` returns the verified bytes to
// the caller without ever leaking them beyond the module.
function readBoundedFile(file, before, check, capture = false) {
  if (before.isSymbolicLink() || !before.isFile()) return changed();
  if (before.size > MAX_FILE_BYTES) return limitExceeded();
  let fd;
  try { fd = openSync(file, OPEN_FLAGS); } catch { return changed(); }
  try {
    let opened;
    try { opened = fstatSync(fd); } catch { return changed(); }
    if (!opened.isFile() || !sameRef(fileRef(before), fileRef(opened)) || before.size !== opened.size) return changed();
    if (opened.size > MAX_FILE_BYTES) return limitExceeded();
    const buffer = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      check();
      let read;
      try { read = readSync(fd, buffer, offset, opened.size - offset, offset); } catch { return changed(); }
      if (read <= 0) return changed();
      offset += read;
    }
    let closed;
    try { closed = fstatSync(fd); } catch { return changed(); }
    if (!sameIdentity(identity(opened), identity(closed))) return changed();
    let after;
    try { after = lstatSync(file); } catch { return changed(); }
    if (!sameIdentity(identity(before), identity(after)) || !sameRef(fileRef(opened), fileRef(after))) return changed();
    return { sha256: createHash('sha256').update(buffer).digest('hex'), byteLength: opened.size,
      ...(capture ? { bytes: buffer } : {}) };
  } finally { closeSync(fd); }
}

// Enumerate one package root in the generator's canonical order. Bounds are applied as the
// walk progresses: total files, per-file bytes, total bytes and path depth. A nested
// node_modules directory is an unaccounted dependency and is rejected.
function enumerateRoot(root, check, state) {
  const files = [];
  let manifestBytes = null;
  const visit = (directory, prefix) => {
    check();
    let entries;
    try { entries = readdirSync(directory); } catch { return changed(); }
    if (entries.length > MAX_FILES) return limitExceeded();
    entries.sort(compareCodeUnits);
    for (const name of entries) {
      check();
      if (name === 'node_modules') return changed();
      const child = join(directory, name);
      const path = prefix === '' ? name : `${prefix}/${name}`;
      let stat;
      try { stat = lstatSync(child); } catch { return changed(); }
      if (stat.isSymbolicLink()) return changed();
      if (stat.isDirectory()) {
        if (path.split('/').length > MAX_DEPTH) return limitExceeded();
        visit(child, path);
        continue;
      }
      if (!stat.isFile()) return changed();
      if (path.split('/').length > MAX_DEPTH) return limitExceeded();
      if (!isSafeRelativePath(path)) return changed();
      state.files += 1;
      state.bytes += stat.size;
      if (state.files > MAX_FILES || stat.size > MAX_FILE_BYTES || state.bytes > MAX_TOTAL_BYTES) return limitExceeded();
      const capture = prefix === '' && name === 'package.json';
      const observed = readBoundedFile(child, stat, check, capture);
      if (capture) manifestBytes = observed.bytes;
      files.push({ path, byteLength: observed.byteLength, sha256: observed.sha256 });
    }
  };
  visit(root, '');
  return { files, manifestBytes };
}

function decodeManifest(bytes) {
  if (!bytes || bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) return null;
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return null;
  try {
    const manifest = parseStrictJson(text, nativeBounds.jsonDepth);
    return isRecord(manifest) ? manifest : null;
  } catch { return null; }
}

// The package's own pinned manifest must name the lock's identity and declare only
// dependencies that belong to the registered closure, with bounded string ranges.
// Bundled dependencies would imply an unaccounted nested node_modules and are rejected.
function checkDependencyMaps(manifest, name, names) {
  const required = [];
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!Object.hasOwn(manifest, key)) continue;
    const map = manifest[key];
    if (!isRecord(map)) return changed();
    for (const dependency of Object.keys(map)) {
      const range = map[dependency];
      if (!names.has(dependency) || dependency === name) return changed();
      if (typeof range !== 'string' || range.length === 0 ||
          Buffer.byteLength(range) > MAX_DEPENDENCY_RANGE_BYTES) return changed();
      if (key === 'dependencies') required.push(dependency);
    }
  }
  for (const key of ['bundledDependencies', 'bundleDependencies']) {
    if (!Object.hasOwn(manifest, key)) continue;
    const value = manifest[key];
    if (value === false || (Array.isArray(value) && value.length === 0)) continue;
    return changed();
  }
  return required;
}

// The wrapper imports only the SDK entry of this fixed release. Importing the CLI would run its
// argument parser as a side effect and would bypass the adapter's fixed profile construction.
function deriveEntry(manifest, root, files) {
  const relative = 'dist/index.js';
  if (manifest.main !== './dist/index.js' && manifest.main !== relative) return changed();
  if (!files.some(file => file.path === relative)) return changed();
  if (createRequire(join(root, 'package.json')).resolve(manifest.name) !== join(root, relative)) return changed();
  return join(root, relative);
}

// Canonicalize a package root and refuse a root that is itself a link or not a directory.
function canonicalRoot(path) {
  let direct;
  try { direct = lstatSync(path); } catch { return changed(); }
  if (direct.isSymbolicLink() || !direct.isDirectory()) return changed();
  let real;
  try { real = realpathSync.native(path); } catch { return changed(); }
  let stat;
  try { stat = lstatSync(real); } catch { return changed(); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return changed();
  return real;
}

// Read a candidate package.json during resolution. Unreadable or malformed candidates do
// not match; a capture-level identity change still fails closed through readBoundedFile.
function readManifestAt(file, check) {
  let before;
  try { before = lstatSync(file); } catch { return null; }
  if (before.isSymbolicLink() || !before.isFile()) return null;
  const observed = readBoundedFile(file, before, check, true);
  return decodeManifest(observed.bytes);
}

// Walk up from a resolved module path to the directory whose package.json names `name`.
function walkToPackageRoot(start, name, check) {
  let directory = start;
  for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
    check();
    const manifest = readManifestAt(join(directory, 'package.json'), check);
    if (manifest && manifest.name === name) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return changed();
}

// Resolve one package root through Node's own resolution from `fromPath`, preferring the
// package.json entry and falling back to the main entry for packages that hide it behind
// an exports map.
function resolvePackageRoot(name, fromPath, check) {
  check();
  let resolved = null;
  try { resolved = createRequire(fromPath).resolve(`${name}/package.json`); } catch { resolved = null; }
  if (typeof resolved === 'string' && isAbsolute(resolved)) return dirname(resolved);
  let main = null;
  try { main = createRequire(fromPath).resolve(name); } catch { return changed(); }
  if (typeof main !== 'string' || !isAbsolute(main)) return changed();
  return walkToPackageRoot(dirname(main), name, check);
}

function samePins(expected, observed) {
  if (expected.length !== observed.length) return false;
  return expected.every((file, index) => file.path === observed[index].path &&
    file.sha256 === observed[index].sha256 && file.byteLength === observed[index].byteLength);
}

function inspectTree({ lock, roots, check }) {
  if (typeof check !== 'function') return changed();
  check();
  if (!validateLinuxRuntimeLock(lock)) return changed();
  if (!Array.isArray(roots) || roots.length !== lock.packages.length) return changed();
  const names = new Set(lock.packages.map(pkg => pkg.name));
  const verified = new Map();
  for (const entry of roots) {
    if (!hasExactKeys(entry, ['name', 'root']) || !names.has(entry.name) || verified.has(entry.name)) return changed();
    verified.set(entry.name, canonicalRoot(entry.root));
  }
  if (verified.size !== lock.packages.length) return changed();
  if (new Set(verified.values()).size !== verified.size) return changed();

  const state = { files: 0, bytes: 0 };
  const observed = [];
  const records = [];
  let entryPath = null;
  for (const pkg of lock.packages) {
    check();
    const root = verified.get(pkg.name);
    let before;
    try { before = lstatSync(root); } catch { return changed(); }
    if (before.isSymbolicLink() || !before.isDirectory()) return changed();
    const captured = enumerateRoot(root, check, state);
    const manifest = decodeManifest(captured.manifestBytes);
    if (!manifest || manifest.name !== pkg.name || manifest.version !== pkg.version) return changed();
    const required = checkDependencyMaps(manifest, pkg.name, names);
    if (!samePins(pkg.files, captured.files)) return changed();
    if (pkg.name === lock.vendor.name) entryPath = deriveEntry(manifest, root, captured.files);
    observed.push({ name: pkg.name, version: pkg.version, integrity: pkg.integrity, files: captured.files });
    records.push({ pkg, root, required });
    let after;
    try { after = lstatSync(root); } catch { return changed(); }
    if (after.isSymbolicLink() || !after.isDirectory() || !sameRef(fileRef(before), fileRef(after))) return changed();
  }
  if (state.files === 0 || entryPath === null) return changed();

  // Import resolution: every declared dependency and the vendor itself must resolve from
  // its own manifest to the exact root that was verified, never a shadow copy. Every
  // non-vendor registered package must be reachable as a declared dependency.
  const reachable = new Set();
  for (const record of records) {
    const anchor = join(record.root, 'package.json');
    if (canonicalRoot(resolvePackageRoot(record.pkg.name, anchor, check)) !== record.root) return changed();
    for (const dependency of record.required) {
      if (canonicalRoot(resolvePackageRoot(dependency, anchor, check)) !== verified.get(dependency)) return changed();
      reachable.add(dependency);
    }
  }
  for (const pkg of lock.packages) if (pkg.name !== lock.vendor.name && !reachable.has(pkg.name)) return changed();

  // The observed closure's canonical digest must equal the packaged digest.
  if (sha256Hex(canonicalJson(observed)) !== lock.treeSha256) return changed();

  // Final bounded receipt: package roots and the chosen vendor entry are still the same
  // kind of object at the end of the capture.
  for (const record of records) {
    let stat;
    try { stat = lstatSync(record.root); } catch { return changed(); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return changed();
  }
  let entryStat;
  try { entryStat = lstatSync(entryPath); } catch { return changed(); }
  if (entryStat.isSymbolicLink() || !entryStat.isFile()) return changed();

  const pins = lock.packages.flatMap(pkg => pkg.files.map(file => ({
    path: join(verified.get(pkg.name), file.path), sha256: file.sha256, byteLength: file.byteLength })));
  return { status: 'ready', entry: entryPath, treeSha256: lock.treeSha256, pins };
}

// Internal test seam only: verify a caller-supplied lock against caller-supplied roots,
// where `roots` is an array of exactly { name, root } entries covering the lock's
// registered package identities. The fixed public verifier below never accepts an
// expected lock or roots from a caller.
export function inspectLinuxVendorTree(options = {}) {
  const { lock, roots, check = () => {} } = options;
  try { return inspectTree({ lock, roots, check }); }
  catch (error) {
    if (error instanceof LimitError) return unavailable('limit-exceeded');
    if (error instanceof ChangedError) return unavailable('executable-changed');
    throw error;
  }
}

// Read the packaged fixed lock. It is the expected material: a link, an over-bound file,
// malformed JSON or an invalid closed shape is unavailable rather than substituted.
function loadFixedLock(check) {
  const file = fileURLToPath(LOCK_URL);
  let before;
  try { before = lstatSync(file); } catch { return changed(); }
  if (before.isSymbolicLink() || !before.isFile()) return changed();
  if (before.size > MAX_LOCK_BYTES) return limitExceeded();
  const observed = readBoundedFile(file, before, check, true);
  if (observed.bytes.length === 0 || observed.bytes.length > MAX_LOCK_BYTES) return limitExceeded();
  const text = observed.bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(observed.bytes)) return changed();
  let lock;
  try { lock = parseStrictJson(text, MAX_DEPTH); } catch { return changed(); }
  if (!isRecord(lock) || !validateLinuxRuntimeLock(lock)) return changed();
  return lock;
}

// Resolve the vendor root from this module and every registered transitive root from the
// vendor manifest. The lock's package names are the expected identity set.
function resolveFixedRoots(lock, check) {
  const anchor = fileURLToPath(import.meta.url);
  const vendorRoot = canonicalRoot(resolvePackageRoot(lock.vendor.name, anchor, check));
  const roots = [{ name: lock.vendor.name, root: vendorRoot }];
  const vendorManifest = join(vendorRoot, 'package.json');
  for (const pkg of lock.packages.slice(1)) {
    roots.push({ name: pkg.name, root: canonicalRoot(resolvePackageRoot(pkg.name, vendorManifest, check)) });
  }
  return roots;
}

// Verify the installed Anthropic SRT closure against the packaged fixed lock.
//
// `check` is a private composition deadline check supplied by the trusted host, not a Core
// request control. It is called before and during the capture; a throw from it is never
// mapped to an unavailable result, so cancellation and budget stops stay intact.
//
// Returns { status: 'ready', entry, treeSha256, pins } when the installed closure exactly
// matches the packaged pins, otherwise { status: 'unavailable', reason } with
// reason 'executable-changed' or 'limit-exceeded'.
export function verifyLinuxVendorClosure({ check = () => {} } = {}) {
  try {
    if (typeof check !== 'function') return unavailable('executable-changed');
    const lock = loadFixedLock(check);
    const roots = resolveFixedRoots(lock, check);
    return inspectLinuxVendorTree({ lock, roots, check });
  } catch (error) {
    if (error instanceof LimitError) return unavailable('limit-exceeded');
    if (error instanceof ChangedError) return unavailable('executable-changed');
    throw error;
  }
}
