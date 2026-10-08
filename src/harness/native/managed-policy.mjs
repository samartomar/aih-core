// Bounded observation of Claude Code file-based managed policy outside the workload.
//
// This helper is a pure read: it never executes a process, writes a file, opens a network
// connection or mutates the environment. It exists so a WSL2 cell can establish that a known
// restricting Windows host policy is preserved rather than evaded by running under Linux, and so
// a native Linux cell reads /etc/claude-code with the same strictness.
//
// Only an outcome and safe limitation tokens are returned; raw policy content is never retained.
// Registry, MDM and server-managed sources are not readable here and are always reported as
// unobserved, so `file-sources-clear` is never proof that no restriction exists. A positively
// observed restriction keeps its precedence over any unreadable or unknown sibling source.
//
// Capture strictness: the source path is walked ancestor by ancestor; a symlinked, non-directory
// or missing ancestor is unreadable. Every consumed file must be a regular file, is size-bounded,
// and has its lstat/fstat identity compared, re-checked after the read and re-checked against a
// fresh lstat; a change, disappearance during capture or partial read is unreadable. This is
// deliberately NOT an atomic adversarial filesystem snapshot: it fails closed on the inconsistent
// cases it can observe, but a writer that wins a race inside the capture window is not defeated,
// and `file-sources-clear` is never proof of a stable filesystem.
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { isAbsolute, join, parse, sep } from 'node:path';
import { isRecord, parseStrictJson } from './canonical.mjs';
import { nativeBounds } from './contracts.mjs';

const DEFAULT_LINUX_DIRECTORY = '/etc/claude-code';
const MAX_MANAGED_BYTES = 65536;
const MAX_DIRECTORY_ENTRIES = 128;
// Bound the ancestor walk so a pathological path cannot cause unbounded filesystem work.
const MAX_ANCESTOR_DEPTH = 64;
// Windows rejects the Linux O_NOFOLLOW flag; the lstat guard below still rejects links there.
const OPEN_FLAGS = constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0));
// POSIX additionally needs the execute bit to traverse a directory. Windows has no separate
// execute access bit, so read access plus the directory type is the platform traversal check.
const DIRECTORY_ACCESS = process.platform === 'win32'
  ? constants.R_OK
  : (constants.R_OK | constants.X_OK);

// Safe limitation tokens. They name what was not observed, never policy content.
export const managedPolicyLimitations = Object.freeze({
  unshippedSources: 'registry-mdm-and-server-managed-sources-unobserved',
  windowsNotObserved: 'windows-host-file-sources-not-observed',
  windowsSourceUnknown: 'windows-host-file-source-unknown',
  executionUnknown: 'execution-unknown',
  linuxSourceInvalid: 'linux-host-file-source-invalid'
});

// Presence of any of these is a managed restriction. The set is deliberately conservative: a
// restricting host policy cannot be evaded by moving the workload into WSL2, so a managed
// permission, sandbox, hook or plugin rule must not be missed.
const RESTRICTING_KEYS = Object.freeze([
  // Managed auto-memory preferences govern the fixed session's instruction loading.
  'autoMemoryEnabled',
  'model',
  'effortLevel',
  'otelHeadersHelper',
  'allowManagedMcpServersOnly',
  'allowedMcpServers',
  'deniedMcpServers',
  'managedMcpServers',
  'permissions',
  'sandbox',
  'disableBypassPermissionsMode',
  'allowManagedHooksOnly',
  'hooks',
  'plugins',
  'enabledPlugins',
  'allowedPlugins',
  'deniedPlugins'
]);

// Fixed-disable and telemetry environment keys can change invocation behavior or the collector channel, which the
// native cell depends on. They are a positive restriction, not a benign preference.
const TELEMETRY_ENV_KEYS = Object.freeze([
  // A settings env block can replace inherited values, including the fixed disable switch.
  /^CLAUDE_CODE_DISABLE_AUTO_MEMORY$/,
  /^CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL$/,
  /^CLAUDE_CODE_DISABLE_FAST_MODE$/,
  /^OTEL_/,
  /^CLAUDE_CODE_ENABLE_TELEMETRY/,
  /^CLAUDE_CODE_ENHANCED/,
  /^DISABLE_TELEMETRY$/,
  /^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC$/
]);

// Deliberately small reviewed allowlist of managed settings whose policy effect is known benign.
// Anything not listed is an observation whose effect cannot be established, so it is unreadable:
// an unrecognised managed key may route credentials/providers or run helpers. A listed key is
// only benign when its value is a recognised, bounded scalar; any other shape is unreadable.
//
// Entry justification:
// - `theme`: documented non-executing display preference (bounded lowercase token).
// No other key is allowlisted. Unverified settings or UI keys stay unreadable rather than clear.
// Model and effort choices govern the actual invocation. Masking their host source would discard
// that policy, so their presence is a restriction regardless of the selected value.
const BOUNDED_LOWER_TOKEN = /^[a-z][a-z0-9-]{0,31}$/;
const BENIGN_SCALAR_KEYS = Object.freeze(new Map([
  ['theme', value => typeof value === 'string' && BOUNDED_LOWER_TOKEN.test(value)]
]));

// Identity of one captured object. `dev`/`ino` bind which object it is; size and the two change
// timestamps bind its observed bytes. A missing `dev`/`ino` (reported as 0 on some filesystems,
// especially Windows) is treated as unknown rather than as a mismatch, so a platform that does not
// populate both the path-based and handle-based stat still uses size/mtime/ctime for the binding.
const fileRef = stat => ({ dev: stat.dev, ino: stat.ino });
const sameRef = (a, b) => (a.dev === b.dev || a.dev === 0 || b.dev === 0) &&
  (a.ino === b.ino || a.ino === 0 || b.ino === 0);
const identity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size,
  mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const sameIdentity = (a, b) => sameRef(a, b) && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

// The path components to validate before trusting `directory`: the filesystem root and every
// ancestor down to (but excluding) the directory itself. Bounded; null means the bound was hit.
function ancestorPaths(directory) {
  const root = parse(directory).root;
  const parts = directory.slice(root.length).split(sep).filter(part => part !== '');
  if (parts.length > MAX_ANCESTOR_DEPTH) return null;
  const paths = [root];
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    paths.push(current);
  }
  return paths;
}

// Validate every ancestor once and remember the object identity. A symlinked, non-directory,
// unreadable or missing ancestor is not trusted, so the source below it is unreadable.
function captureAncestors(paths) {
  const chain = [];
  for (const path of paths) {
    let stat;
    try { stat = lstatSync(path); } catch { return null; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    try { accessSync(path, DIRECTORY_ACCESS); } catch { return null; }
    chain.push({ path, ref: fileRef(stat) });
  }
  return chain;
}

// Recheck ancestor identity after the capture. Ancestors are shared paths, so this compares which
// object they are (dev/ino) rather than their mtime: an unrelated sibling entry elsewhere in a
// shared ancestor changes its mtime without redirecting this path, while a replacement or a
// newly introduced link does redirect it and must be rejected.
function ancestorsUnchanged(chain) {
  for (const { path, ref } of chain) {
    let stat;
    try { stat = lstatSync(path); } catch { return false; }
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameRef(ref, stat)) return false;
  }
  return true;
}

// Read one bounded policy file. Regular files only: a symlink, junction, device, FIFO or
// over-limit file is unreadable rather than followed. A lossy UTF-8 decode is also unreadable.
// `requirePresent` marks a name that was already listed by a directory read: for such a name an
// absence is a disappearance during capture, never a benign absence.
function readBoundedPolicyFile(file, { requirePresent = false } = {}) {
  let before;
  try { before = lstatSync(file); } catch (error) {
    return error.code === 'ENOENT' && !requirePresent ? { kind: 'absent' } : { kind: 'unreadable' };
  }
  if (before.isSymbolicLink() || !before.isFile()) return { kind: 'unreadable' };
  let fd;
  try { fd = openSync(file, OPEN_FLAGS); } catch {
    // The path was just observed as a regular file: a failed open (including ENOENT from a
    // concurrent unlink) is a capture failure, not a benign absence.
    return { kind: 'unreadable' };
  }
  try {
    const opened = fstatSync(fd);
    // The descriptor must name the object the path named (dev/ino) with the same size. Full
    // timestamps are rechecked within each stat source below, where the values are directly
    // comparable, so a platform that reports path-based and handle-based metadata differently is
    // not misread as a change while a real replacement or rewrite is still rejected.
    if (!opened.isFile() || !sameRef(fileRef(before), fileRef(opened)) || before.size !== opened.size) {
      return { kind: 'unreadable' };
    }
    if (opened.size > MAX_MANAGED_BYTES) return { kind: 'unreadable' };
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const read = readSync(fd, buffer, offset, opened.size - offset, offset);
      if (read <= 0) return { kind: 'unreadable' };
      offset += read;
    }
    // A partial read, or any change to the open object while reading, is unreadable.
    if (offset !== opened.size || !sameIdentity(identity(opened), identity(fstatSync(fd)))) {
      return { kind: 'unreadable' };
    }
    const text = buffer.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buffer)) return { kind: 'unreadable' };
    // The path must still resolve to the read object, and must not have disappeared or changed.
    let after;
    try { after = lstatSync(file); } catch { return { kind: 'unreadable' }; }
    if (!sameRef(fileRef(opened), fileRef(after)) || opened.size !== after.size ||
      !sameIdentity(identity(before), identity(after))) return { kind: 'unreadable' };
    return { kind: 'ok', text };
  } catch { return { kind: 'unreadable' }; } finally { closeSync(fd); }
}

// One managed-settings document. A present restriction wins; a malformed document, an unrecognised
// key or an unrecognised environment key is an observation that could not be established, so it is
// unreadable rather than clear.
function classifyManagedSettings(text) {
  let value;
  try { value = parseStrictJson(text, nativeBounds.jsonDepth); } catch { return 'unreadable'; }
  if (!isRecord(value)) return 'unreadable';
  // A known restriction is decisive even when a sibling key is unrecognised or malformed.
  if (RESTRICTING_KEYS.some(key => Object.hasOwn(value, key))) return 'restricted';
  if (Object.hasOwn(value, 'env')) {
    const env = value.env;
    if (!isRecord(env)) return 'unreadable';
    const envKeys = Object.keys(env);
    if (envKeys.some(key => TELEMETRY_ENV_KEYS.some(pattern => pattern.test(key)))) return 'restricted';
    // An empty env map is a benign no-op. Any non-telemetry key may route credentials or
    // providers or execute helpers, so it is unreadable rather than benign.
    if (envKeys.length > 0) return 'unreadable';
  }
  for (const key of Object.keys(value)) {
    if (key === 'env') continue;
    const validate = BENIGN_SCALAR_KEYS.get(key);
    // An unknown managed key is an observation whose policy effect cannot be established.
    if (!validate || !validate(value[key])) return 'unreadable';
  }
  return 'clear';
}

// A managed-mcp.json is a managed restriction whenever it is present and valid strict JSON. Its
// mere presence governs MCP selection, so content is not needed to classify it.
function classifyManagedMcp(text) {
  try { parseStrictJson(text, nativeBounds.jsonDepth); return 'restricted'; } catch { return 'unreadable'; }
}

// Read one present policy source directory: managed-settings.json, managed-settings.d/*.json and
// managed-mcp.json. The directory and every file it yields are identity-checked; a change to the
// directory or an entry during the capture makes the observation unreadable.
function captureDirectory(directory) {
  let restricted = false;
  let unreadable = false;

  let link;
  try { link = lstatSync(directory); } catch (error) {
    // A symlink is refused. A genuinely absent directory is a clear (no managed files here); a
    // different failure is unknown.
    return error.code === 'ENOENT'
      ? { restricted: false, unreadable: false }
      : { restricted: false, unreadable: true };
  }
  if (link.isSymbolicLink() || !link.isDirectory()) return { restricted: false, unreadable: true };
  try { accessSync(directory, DIRECTORY_ACCESS); } catch { return { restricted: false, unreadable: true }; }
  const directoryIdentity = identity(link);

  const settings = readBoundedPolicyFile(join(directory, 'managed-settings.json'));
  if (settings.kind === 'unreadable') unreadable = true;
  else if (settings.kind === 'ok') {
    const state = classifyManagedSettings(settings.text);
    if (state === 'restricted') restricted = true;
    else if (state === 'unreadable') unreadable = true;
  }

  const dropIn = join(directory, 'managed-settings.d');
  let dropInLink = null;
  try { dropInLink = lstatSync(dropIn); } catch (error) { if (error.code !== 'ENOENT') unreadable = true; }
  if (dropInLink) {
    if (dropInLink.isSymbolicLink() || !dropInLink.isDirectory()) unreadable = true;
    else {
      const dropInIdentity = identity(dropInLink);
      let accessible = true;
      try { accessSync(dropIn, DIRECTORY_ACCESS); } catch { accessible = false; }
      let entries = null;
      if (accessible) {
        try { entries = readdirSync(dropIn); } catch { unreadable = true; }
      } else unreadable = true;
      if (entries) {
        if (entries.length > MAX_DIRECTORY_ENTRIES) unreadable = true;
        else for (const name of [...entries].sort()) {
          if (!name.endsWith('.json')) continue;
          // Listed by the directory read above: a later absence is a capture failure.
          const entry = readBoundedPolicyFile(join(dropIn, name), { requirePresent: true });
          if (entry.kind === 'unreadable') unreadable = true;
          else if (entry.kind === 'ok') {
            const state = classifyManagedSettings(entry.text);
            if (state === 'restricted') restricted = true;
            else if (state === 'unreadable') unreadable = true;
          }
        }
      }
      let dropInAfter;
      try { dropInAfter = lstatSync(dropIn); } catch { dropInAfter = null; unreadable = true; }
      if (dropInAfter && (dropInAfter.isSymbolicLink() || !dropInAfter.isDirectory() ||
        !sameIdentity(dropInIdentity, identity(dropInAfter)))) unreadable = true;
    }
  }

  const mcp = readBoundedPolicyFile(join(directory, 'managed-mcp.json'));
  if (mcp.kind === 'unreadable') unreadable = true;
  else if (mcp.kind === 'ok') {
    if (classifyManagedMcp(mcp.text) === 'restricted') restricted = true;
    else unreadable = true;
  }

  // The source directory itself must still be the same object at the end of the capture.
  let after;
  try { after = lstatSync(directory); } catch { after = null; unreadable = true; }
  if (after && (after.isSymbolicLink() || !after.isDirectory() ||
    !sameIdentity(directoryIdentity, identity(after)))) unreadable = true;

  return { restricted, unreadable };
}

// Observe one policy source directory: validate the ancestor walk first, then capture the
// directory, then re-check that the ancestor chain still resolves to the same objects. Absence of
// the source directory is only trusted once its ancestors are known real directories, so a missing
// host mount is never mistaken for an absent policy. A restriction found in the directory keeps its
// precedence even when the recheck makes the observation unreadable.
function observeManagedDirectory(directory) {
  const paths = ancestorPaths(directory);
  if (!paths) return { restricted: false, unreadable: true };
  const chain = captureAncestors(paths);
  if (!chain) return { restricted: false, unreadable: true };
  const captured = captureDirectory(directory);
  if (!ancestorsUnchanged(chain)) captured.unreadable = true;
  return captured;
}

// Observe bounded file-based managed policy across the selected execution cell.
//
// `execution: 'native'` reads only the Linux directory. `execution: 'wsl2'` additionally requires
// the host to supply the canonical Windows policy directory it resolved through verified WSL
// mounts (`windowsSourceKnown: true` and an explicit absolute `windowsDirectory`); otherwise the
// Windows source is unreadable rather than inferred absent. A known restriction always wins.
export function observeLinuxManagedPolicy({ execution, linuxDirectory = DEFAULT_LINUX_DIRECTORY,
  windowsDirectory, windowsSourceKnown = false } = {}) {
  const limitations = [managedPolicyLimitations.unshippedSources];

  if (execution !== 'native' && execution !== 'wsl2') {
    limitations.push(managedPolicyLimitations.executionUnknown);
    return { outcome: 'unreadable', limitations };
  }

  let restricted = false;
  let unreadable = false;

  if (typeof linuxDirectory !== 'string' || !isAbsolute(linuxDirectory)) {
    limitations.push(managedPolicyLimitations.linuxSourceInvalid);
    unreadable = true;
  } else {
    const linux = observeManagedDirectory(linuxDirectory);
    restricted = linux.restricted;
    unreadable = linux.unreadable;
  }

  if (execution === 'native') {
    // A native Linux cell has no Windows host policy source: it is not observed, not clear.
    limitations.push(managedPolicyLimitations.windowsNotObserved);
  } else if (windowsSourceKnown !== true || typeof windowsDirectory !== 'string' || !isAbsolute(windowsDirectory)) {
    // The host resolves this path from verified WSL mounts. A missing or inferred source cannot be
    // treated as absent policy, and a known restriction from Linux still takes precedence below.
    limitations.push(managedPolicyLimitations.windowsSourceUnknown);
    unreadable = true;
  } else {
    const windows = observeManagedDirectory(windowsDirectory);
    restricted = restricted || windows.restricted;
    unreadable = unreadable || windows.unreadable;
  }

  if (restricted) return { outcome: 'restricted', limitations };
  return { outcome: unreadable ? 'unreadable' : 'file-sources-clear', limitations };
}
