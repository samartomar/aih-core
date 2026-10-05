// SRT resolves host symlinks before constructing mounts. Materialize only independently pinned
// library bytes under their fixed SONAME aliases so the sandbox loader needs no broad library grant.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync,
  readSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const fail = () => { throw Error('runtime-changed'); };
const hash = value => createHash('sha256').update(value).digest('hex');
const namePattern = /^(?:lib|ld-)[A-Za-z0-9._+-]{1,127}$/;
export function stageLinuxLibraryClosure({ directory, closure }) {
  if (!isAbsolute(directory) || !Array.isArray(closure) || !closure.length || closure.length > 32) fail();
  const names = new Map(); let total = 0;
  for (const member of closure) {
    if (!member || !isAbsolute(member.source) || !/^[a-f0-9]{64}$/.test(member.sha256) ||
        !Number.isSafeInteger(member.byteLength) || member.byteLength < 1 || member.byteLength > 32 * 1024 * 1024 ||
        !Array.isArray(member.names) || !member.names.length || member.names.length > 4 || member.names.some(name => !namePattern.test(name))) fail();
    const fd = openSync(member.source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size !== member.byteLength) fail();
      const buffer = Buffer.alloc(member.byteLength + 1); let used = 0, read;
      while (used < buffer.length && (read = readSync(fd, buffer, used, buffer.length - used, null)) > 0) used += read;
      bytes = buffer.subarray(0, used); const after = fstatSync(fd), current = lstatSync(member.source);
      if (bytes.length !== member.byteLength || hash(bytes) !== member.sha256 || current.isSymbolicLink() ||
          before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          current.ino !== before.ino || current.dev !== before.dev) fail();
    } finally { closeSync(fd); }
    for (const name of member.names) {
      if (names.has(name)) { if (names.get(name).sha256 !== member.sha256) fail(); continue; }
      total += bytes.length; if (total > 128 * 1024 * 1024 || names.size >= 64) fail();
      names.set(name, { bytes, sha256: member.sha256 });
    }
  }
  const root = mkdtempSync(join(directory, 'l')); chmodSync(root, 0o700);
  const pins = [], identities = new Map();
  const remove = () => {
    try {
      if (readdirSync(root).some(name => !identities.has(name))) return false;
      for (const [name, identity] of identities) {
        const path = join(root, name); let current;
        try { current = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.ino !== identity.ino || current.dev !== identity.dev) return false;
        if (process.platform === 'win32') chmodSync(path, 0o600);
        unlinkSync(path);
      }
      rmdirSync(root); return true;
    } catch (error) { return error.code === 'ENOENT'; }
  };
  try {
    for (const [name, member] of names) {
      const path = join(root, name);
      writeFileSync(path, member.bytes, { flag: 'wx', mode: 0o444 });
      identities.set(name, lstatSync(path));
      pins.push({ path, sha256: member.sha256, byteLength: member.bytes.length });
    }
    return { directory: root, pins, remove };
  } catch (error) { remove(); throw error; }
}
