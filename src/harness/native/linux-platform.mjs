// Resolve references against independently supplied package metadata. Nothing here admits isolation.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, lstat, readdir, readlink } from 'node:fs/promises';
import { release } from 'node:os';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasExactKeys, parseStrictJson, snapshotNativeData } from './canonical.mjs';

const VERSIONS = Object.freeze({ node: '24.19.0', client: '2.1.285', bash: '5.3-2ubuntu1',
  env: '0.8.0-0ubuntu3', bwrap: '0.11.1-1ubuntu0.3', socat: '1.8.1.1-1ubuntu0.1', rg: '15.1.0-1ubuntu1', which: '5.23.2build1' });
const MAX_FILE = 268435456;
const SOURCE = fileURLToPath(new URL('./linux/runtime-platform.json', import.meta.url));
const SHA = /^[a-f0-9]{64}$/;
const safePath = value => typeof value === 'string' && value.length <= 4096 && value === value.trim() &&
  /^\/[A-Za-z0-9._/+-]+$/.test(value) && value !== '/' && posix.normalize(value) === value && !value.endsWith('/');
const hashReference = value => typeof value === 'string' && value.length === 64 && SHA.test(value);
const artifact = row => hasExactKeys(row, ['version', 'sha256', 'byteLength']) &&
  typeof row.version === 'string' && row.version === row.version.trim() && /^[0-9][A-Za-z0-9.+:-]{0,63}$/.test(row.version) && hashReference(row.sha256) &&
  Number.isSafeInteger(row.byteLength) && row.byteLength > 0 && row.byteLength <= MAX_FILE;
const fileBytes = row => hashReference(row.sha256) && Number.isSafeInteger(row.byteLength) && row.byteLength > 0 && row.byteLength <= MAX_FILE;
const fileReference = row => hasExactKeys(row, ['path', 'sha256', 'byteLength'], ['aliases']) && safePath(row.path) && fileBytes(row);
const libraryPath = path => /^\/(?:usr\/)?lib(?:64|\/x86_64-linux-gnu)?\/[A-Za-z0-9.+_-]+\.so(?:\.[0-9]+)*$/.test(path);
const READ_FILES = new Set(['/etc/ssl/certs/ca-certificates.crt', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf',
  '/etc/localtime', '/usr/share/zoneinfo/Etc/UTC', '/usr/share/zoneinfo/UTC', '/usr/bin/dash']);
const WRAP_LIBRARY = '../lib/x86_64-linux-gnu/libwrap.so.0.7.6';
const WRAP_ALIAS = '../lib/x86_64-linux-gnu/libwrap.so.0';
const roleLibrary = row => hasExactKeys(row, ['role', 'relative', 'sha256', 'byteLength'], ['aliases']) &&
  row.role === 'socat' && row.relative === WRAP_LIBRARY && fileBytes(row);
const aliases = (row, allowed) => row.aliases === undefined || Array.isArray(row.aliases) && row.aliases.length <= 4 &&
  new Set(row.aliases).size === row.aliases.length && row.aliases.every(allowed);

const LOADER = '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2';
const LOADER_NAME = 'ld-linux-x86-64.so.2';
const LOADER_TARGET = '../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2';
const aliasDirectoryReference = row => hasExactKeys(row, ['path', 'entries']) && row.path === '/usr/lib64' &&
  Array.isArray(row.entries) && row.entries.length === 1 && hasExactKeys(row.entries[0], ['name', 'target']) &&
  row.entries[0].name === LOADER_NAME && row.entries[0].target === LOADER_TARGET;

export function validateLinuxLibraryAliasInventory(input) {
  try {
    const row = snapshotNativeData(input, 4096, 4);
    return hasExactKeys(row, ['directory', 'entries', 'lib64Canonical']) && row.lib64Canonical === '/usr/lib64' &&
      hasExactKeys(row.directory, ['uid', 'mode', 'symlink']) && row.directory.uid === 0 && row.directory.symlink === false &&
      Number.isSafeInteger(row.directory.mode) && row.directory.mode >= 0 && row.directory.mode <= 0o7777 && !(row.directory.mode & 0o022) &&
      Array.isArray(row.entries) && row.entries.length === 1 && hasExactKeys(row.entries[0], ['name', 'uid', 'type', 'target']) &&
      row.entries[0].name === LOADER_NAME && row.entries[0].uid === 0 && row.entries[0].type === 'symlink' && row.entries[0].target === LOADER_TARGET;
  } catch { return false; }
}

export function validateLinuxPlatformRecord(input) {
  try {
    const record = snapshotNativeData(input, 65536, 8);
    if (!hasExactKeys(record, ['schemaVersion', 'platform', 'roles', 'libraries', 'readFiles', 'libraryAliasDirectories', 'wsl']) ||
        record.schemaVersion !== '1.0.0' || record.platform !== 'linux-x64' ||
        !hasExactKeys(record.roles, [...Object.keys(VERSIONS), 'wslinfo']) ||
        !hasExactKeys(record.wsl, ['networkingMode']) || record.wsl.networkingMode !== 'nat') return false;
    for (const [name, version] of Object.entries(VERSIONS)) if (!artifact(record.roles[name]) || record.roles[name].version !== version) return false;
    if (record.roles.wslinfo !== null && !artifact(record.roles.wslinfo)) return false;
    if (!Array.isArray(record.libraries) || record.libraries.length > 32 ||
        !Array.isArray(record.readFiles) || record.readFiles.length > 32 ||
        !Array.isArray(record.libraryAliasDirectories) || record.libraryAliasDirectories.length !== 1 ||
        !aliasDirectoryReference(record.libraryAliasDirectories[0])) return false;
    const seen = new Set();
    for (const row of record.libraries) {
      const relative = roleLibrary(row);
      if (!(relative || fileReference(row) && libraryPath(row.path)) ||
          !aliases(row, relative ? value => value === WRAP_ALIAS : libraryPath)) return false;
      const key = relative ? `${row.role}:${row.relative}` : row.path;
      if (seen.has(key)) return false; seen.add(key);
    }
    for (const row of record.readFiles) {
      if (!fileReference(row) || !READ_FILES.has(row.path) || seen.has(row.path) ||
          !aliases(row, value => row.path === '/usr/bin/dash' && ['/bin/sh', '/usr/bin/sh'].includes(value))) return false;
      seen.add(row.path);
    }
    if (!record.readFiles.some(row => row.path === '/usr/bin/dash' &&
        row.aliases?.includes('/bin/sh'))) return false;
    if (!record.libraries.some(row => row.path === LOADER && row.aliases?.includes('/lib64/' + LOADER_NAME) &&
        row.aliases?.includes('/usr/lib64/' + LOADER_NAME))) return false;
    return true;
  } catch { return false; }
}

const mountText = value => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
const cDrive = value => ['C:', 'C:\\', 'C:/'].includes(value.toUpperCase());
export function windowsPolicyDirectoryFromMounts(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 262144 || text.includes('\0')) return null;
  const lines = text.split('\n'); if (lines.length > 4096) return null;
  let candidates = 0, valid = false;
  for (const line of lines) {
    if (!line) continue;
    const fields = line.split(' '); if (fields.length !== 6 || fields.some(value => !value)) return null;
    const [source, target, type, options] = fields.map(mountText);
    if (target.startsWith('/mnt/c/')) return null; // No nested overlays can substitute the policy reference.
    if (!cDrive(source) && target !== '/mnt/c') continue;
    candidates++;
    const drvfs = type === 'drvfs' || type === '9p' && options.split(',').some(value =>
      value.startsWith('aname=drvfs;') && value.split(';').includes(`path=${source}`));
    valid = cDrive(source) && target === '/mnt/c' && drvfs;
  }
  return candidates === 1 && valid ? '/mnt/c/Program Files/ClaudeCode' : null;
}

export function observedWslNetworkingMode(text) {
  return ['nat', 'nat\n', 'nat\r\n'].includes(text) ? 'nat' : null;
}

class Unavailable extends Error { constructor(reason, drift) { super(); this.reason = reason; if (drift) this.drift = drift; } }
class CheckFailed extends Error { constructor(error) { super(); this.error = error; } }
const refuse = (reason, drift) => { throw new Unavailable(reason, drift); };
// A stably read pinned file whose size or SHA-256 differs from its row; the descriptor names only the row, never host bytes or paths.
const DRIFT = 'platform-record-drift';
const unavailable = reason => ({ status: 'unavailable', reason });
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
async function readBounded(path, maximum, check) {
  await check();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum) refuse('runtime-changed');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      await check();
      const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!bytesRead) refuse('runtime-changed'); offset += bytesRead;
    }
    const after = await handle.stat(), current = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) refuse('runtime-changed');
    return bytes;
  } finally { await handle.close(); }
}

async function matchFile(candidate, expected, check, executable = false, row = null) {
  await check();
  const path = await realpath(candidate);
  if (!safePath(path)) refuse('runtime-changed');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || executable && !(before.mode & 0o111)) refuse('runtime-changed');
    if (before.size !== expected.byteLength) refuse(row ? DRIFT : 'runtime-changed', row);
    const chunk = Buffer.alloc(65536), hash = createHash('sha256'); let offset = 0;
    while (offset < before.size) {
      await check();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!bytesRead) refuse('runtime-changed');
      if (!offset && executable === 'which-script' && !chunk.subarray(0, 11).equals(Buffer.from('#! /bin/sh\n'))) refuse('runtime-changed');
      if (!offset && executable && executable !== 'which-script' && (bytesRead < 20 || !chunk.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) ||
          chunk[4] !== 2 || chunk[5] !== 1 || chunk[6] !== 1 || ![2, 3].includes(chunk.readUInt16LE(16)) || chunk.readUInt16LE(18) !== 62)) refuse('runtime-changed');
      hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    const sha256 = hash.digest('hex'), after = await handle.stat(), current = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) refuse('runtime-changed');
    if (sha256 !== expected.sha256) refuse(row ? DRIFT : 'runtime-changed', row);
    return { path, sha256, byteLength: offset };
  } finally { await handle.close(); }
}

async function searchRole(name, expected, check) {
  let drift = null;
  const value = process.env.PATH ?? '';
  if (value.length > 32768) refuse('runtime-changed');
  const entries = value.split(':'); if (entries.length > 64) refuse('runtime-changed');
  const dirs = [...new Set(entries.filter(safePath))];
  for (const directory of dirs) {
    await check();
    try { return await matchFile(posix.join(directory, name), expected, check, name === 'which' ? 'which-script' : true, { table: 'roles', key: name }); }
    catch (error) {
      if (!(error instanceof Unavailable) && !['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(error.code)) throw error;
      if (error instanceof Unavailable && error.drift) drift ??= error.drift;
    }
  }
  if (drift) refuse(DRIFT, drift); // Only when no candidate matched and a stable candidate differed.
  refuse('runtime-changed');
}

const networkingMode = () => new Promise(resolve => {
  // One fixed read-only OS metadata operation; never run the client or an arbitrary PATH program.
  execFile('/usr/bin/wslinfo', ['--networking-mode'], { shell: false, env: { LANG: 'C' },
    timeout: 1000, maxBuffer: 128, encoding: 'buffer', killSignal: 'SIGKILL' }, (error, stdout) => {
    try { resolve(error ? null : observedWslNetworkingMode(decode(stdout))); } catch { resolve(null); }
  });
});

const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function verifyAliasDirectory(record, check) {
  await check();
  const path = '/usr/lib64', before = await lstat(path), lib64Before = await lstat('/lib64');
  if (!before.isDirectory() || before.isSymbolicLink() || !lib64Before.isSymbolicLink() || lib64Before.uid !== 0) refuse('runtime-changed');
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat(); if (!sameObject(before, held)) refuse('runtime-changed');
    const names = await readdir(path); if (names.length !== 1 || names[0] !== LOADER_NAME) refuse('runtime-changed');
    const entryPath = posix.join(path, LOADER_NAME), entryBefore = await lstat(entryPath);
    const inventory = { directory: { uid: before.uid, mode: before.mode & 0o7777, symlink: false }, lib64Canonical: await realpath('/lib64'),
      entries: [{ name: LOADER_NAME, uid: entryBefore.uid, type: entryBefore.isSymbolicLink() ? 'symlink' : 'other', target: await readlink(entryPath) }] };
    if (!validateLinuxLibraryAliasInventory(inventory) || await realpath(entryPath) !== LOADER) refuse('runtime-changed');
    const expected = record.libraries.find(row => row.path === LOADER);
    const pin = await matchFile(LOADER, expected, check, false, { table: 'libraries', key: record.libraries.indexOf(expected) });
    await check();
    if (!sameObject(before, await lstat(path)) || !sameObject(held, await handle.stat()) ||
        !sameObject(entryBefore, await lstat(entryPath)) || !sameObject(lib64Before, await lstat('/lib64')) ||
        await readlink(entryPath) !== LOADER_TARGET || await realpath('/lib64') !== path ||
        (await readdir(path)).join('\0') !== LOADER_NAME) refuse('runtime-changed');
    return pin;
  } finally { await handle.close(); }
}

export async function revalidateLinuxLibraryAliases({ check: trustedCheck = () => {} } = {}) {
  await trustedCheck();
  if (process.platform !== 'linux' || process.arch !== 'x64') return unavailable('platform-unsupported');
  const check = async () => { try { await trustedCheck(); } catch (error) { throw new CheckFailed(error); } };
  try {
    const record = parseStrictJson(decode(await readBounded(SOURCE, 65536, check)));
    if (!validateLinuxPlatformRecord(record)) refuse('runtime-changed');
    await verifyAliasDirectory(record, check); return { status: 'ready' };
  } catch (error) {
    if (error instanceof CheckFailed) throw error.error;
    return unavailable('runtime-changed');
  }
}

export async function resolveLinuxPlatform({ check: trustedCheck = () => {}, client } = {}) {
  await trustedCheck();
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() === 0 || process.getuid() !== process.geteuid()) return unavailable('platform-unsupported');
  const check = async () => { try { await trustedCheck(); } catch (error) { throw new CheckFailed(error); } };
  try {
    const recordBytes = await readBounded(SOURCE, 65536, check), record = parseStrictJson(decode(recordBytes));
    if (!validateLinuxPlatformRecord(record) || process.version !== `v${VERSIONS.node}`) refuse('runtime-changed');
    if (!hasExactKeys(client, ['path', 'sha256', 'byteLength']) || !safePath(client.path) ||
        client.sha256 !== record.roles.client.sha256 || client.byteLength !== record.roles.client.byteLength) refuse('executable-changed');
    const refs = { node: await matchFile(process.execPath, record.roles.node, check, true),
      client: await matchFile(client.path, record.roles.client, check, true) };
    for (const name of ['bash', 'env', 'bwrap', 'socat', 'rg', 'which']) refs[name] = await searchRole(name, record.roles[name], check);
    const libraries = [], readFiles = [], extraPins = [], libraryParents = new Set(), libraryClosure = [];
    for (const [rows, result] of [[record.libraries, libraries], [record.readFiles, readFiles]]) {
      for (const [index, row] of rows.entries()) {
        const base = row.role ? posix.dirname(refs.socat.path) : null;
        const logical = base ? posix.resolve(base, row.relative) : row.path;
        const pin = await matchFile(logical, row, check, row.path === '/usr/bin/dash', { table: rows === record.libraries ? 'libraries' : 'readFiles', key: index });
        const logicalAliases = (row.aliases ?? []).map(value => base ? posix.resolve(base, value) : value);
        for (const alias of logicalAliases) { await check(); if (await realpath(alias) !== pin.path) refuse('runtime-changed'); }
        for (const path of [pin.path, logical, ...logicalAliases]) if (!result.includes(path)) result.push(path);
        if (result.length > (rows === record.libraries ? 64 : 256)) refuse('runtime-changed');
        extraPins.push(pin);
        if (rows === record.libraries) {
          libraryParents.add(posix.dirname(pin.path));
          libraryClosure.push({ source: pin.path, sha256: pin.sha256, byteLength: pin.byteLength,
            names: [...new Set([pin.path, logical, ...logicalAliases].map(path => posix.basename(path)))] });
        }
      }
    }
    await verifyAliasDirectory(record, check);
    const kernel = release(), isWsl = /-microsoft-standard-WSL2$/.test(kernel);
    if (!isWsl && /microsoft|wsl/i.test(kernel)) refuse('platform-unsupported');
    const platform = { execution: isWsl ? 'wsl2' : 'native', kernel, uid: process.getuid() };
    if (isWsl) {
      if (!record.roles.wslinfo) refuse('isolation-unobserved');
      const info = await matchFile('/usr/bin/wslinfo', record.roles.wslinfo, check, true, { table: 'roles', key: 'wslinfo' });
      if (info.path !== '/init') refuse('isolation-unobserved');
      await check(); const mode = await networkingMode(); await check();
      if (mode !== 'nat') refuse('isolation-unobserved');
      const mounts = decode(await readProc('/proc/self/mounts', 262144, check));
      const windowsPolicyDirectory = windowsPolicyDirectoryFromMounts(mounts);
      if (!windowsPolicyDirectory) refuse('restriction-unobservable');
      platform.networkingMode = mode; platform.windowsPolicyDirectory = windowsPolicyDirectory; extraPins.push(info);
    }
    await check();
    const pins = [{ path: SOURCE, byteLength: recordBytes.length, sha256: createHash('sha256').update(recordBytes).digest('hex') }, ...Object.values(refs), ...extraPins];
    const uniquePins = [...new Map(pins.map(pin => [pin.path, pin])).values()];
    return { status: 'ready', runtime: { ...Object.fromEntries(Object.entries(refs).map(([name, pin]) => [name, pin.path])), libraries, readFiles,
      libraryAliasDirectories: ['/usr/lib64'] }, libraryClosure, pins: uniquePins, ldLibraryPath: [...libraryParents].join(':'), platform };
  } catch (error) {
    if (error instanceof CheckFailed) throw error.error;
    if (error instanceof Unavailable) return error.drift ? { ...unavailable(error.reason), drift: Object.freeze({ ...error.drift }) } : unavailable(error.reason);
    return unavailable('runtime-changed'); // No raw native errors or path contents enter public evidence.
  }
}

async function readProc(path, maximum, check) {
  await check(); const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(maximum + 1); let used = 0;
    while (used <= maximum) {
      await check(); const { bytesRead } = await handle.read(bytes, used, Math.min(65536, bytes.length - used), null);
      if (!bytesRead) break; used += bytesRead;
    }
    if (used > maximum) refuse('isolation-unobserved'); return bytes.subarray(0, used);
  } finally { await handle.close(); }
}
