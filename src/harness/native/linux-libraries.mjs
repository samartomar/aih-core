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
  const rootIdentity = lstatSync(root);
  const pins = [], identities = new Map();
  const validate = ({ check = () => {} } = {}) => {
    check();
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev !== rootIdentity.dev || rootStat.ino !== rootIdentity.ino ||
        rootStat.uid !== (process.getuid?.() ?? rootStat.uid) ||
        (process.platform !== 'win32' && (rootStat.mode & 0o777) !== 0o700) ||
        readdirSync(root).length !== identities.size || readdirSync(root).some(name => !identities.has(name))) fail();
    for (const pin of pins) {
      check();
      const identity = identities.get(pin.path.slice(root.length + 1));
      const fd = openSync(pin.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const before = fstatSync(fd), current = lstatSync(pin.path);
        if (!before.isFile() || current.isSymbolicLink() || before.nlink !== 1 || before.ino !== identity.ino || before.dev !== identity.dev ||
            before.size !== pin.byteLength || before.mode !== identity.mode || before.uid !== identity.uid ||
            before.mtimeMs !== identity.mtimeMs || before.ctimeMs !== identity.ctimeMs || current.ino !== before.ino || current.dev !== before.dev) fail();
        const digest = createHash('sha256'), buffer = Buffer.alloc(65536); let used = 0, count;
        while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) { check(); used += count; if (used > pin.byteLength) fail(); digest.update(buffer.subarray(0, count)); }
        const after = fstatSync(fd), named = lstatSync(pin.path);
        if (used !== pin.byteLength || digest.digest('hex') !== pin.sha256 || before.ino !== after.ino || before.dev !== after.dev ||
            before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.ino !== before.ino || named.dev !== before.dev) fail();
      } finally { closeSync(fd); }
    }
    check();
    return true;
  };
  const remove = ({ check = () => {} } = {}) => {
    try {
      check();
      const currentRoot = lstatSync(root);
      if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.ino !== rootIdentity.ino ||
          currentRoot.dev !== rootIdentity.dev || currentRoot.uid !== rootIdentity.uid) return false;
      if (readdirSync(root).some(name => !identities.has(name))) return false;
      for (const [name, identity] of identities) {
        check();
        const path = join(root, name); let current;
        try { current = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.ino !== identity.ino || current.dev !== identity.dev) return false;
        if (process.platform === 'win32') chmodSync(path, 0o600);
        unlinkSync(path);
      }
      check(); rmdirSync(root); return true;
    } catch (error) { return error.code === 'ENOENT'; }
  };
  try {
    for (const [name, member] of names) {
      const path = join(root, name);
      writeFileSync(path, member.bytes, { flag: 'wx', mode: 0o444 });
      identities.set(name, lstatSync(path));
      pins.push({ path, sha256: member.sha256, byteLength: member.bytes.length });
    }
    return { directory: root, pins, validate, remove };
  } catch (error) { remove(); throw error; }
}
