// Owned synthetic material outside the allowed cell roots. Never reads a user's existing files.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync,
  realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const missing = error => error?.code === 'ENOENT';
export function createLinuxCanaries(roots) {
  const directories = [], files = {}, writes = [], bytes = randomBytes(32);
  let agentDirectory;
  const remove = () => {
    let confirmed = true;
    for (const row of directories) {
      try {
        const stat = lstatSync(row.path);
        if (!stat.isDirectory() || !same(stat, row.stat)) { confirmed = false; continue; }
        const names = readdirSync(row.path);
        if (names.length > 3) { confirmed = false; continue; }
        for (const name of names) {
          const path = join(row.path, name), entry = lstatSync(path);
          const ours = name === 'read' && row.file && same(entry, row.file) && entry.isFile() && entry.nlink === 1;
          const probe = name === 'write' && entry.isFile() && entry.nlink === 1 && entry.uid === stat.uid && entry.size <= 32;
          const socket = name === 'agent' && entry.isSocket() && entry.uid === stat.uid;
          if (ours || probe || socket) unlinkSync(path); else confirmed = false;
        }
        if (readdirSync(row.path).length === 0) rmdirSync(row.path); else confirmed = false;
      } catch (error) { if (!missing(error)) confirmed = false; }
    }
    return confirmed;
  };
  try {
    for (const name of ['home', 'sibling', 'temporary', 'provisioner', 'agent']) {
      const parent = realpathSync.native(roots[name]);
      if (!lstatSync(parent).isDirectory()) throw Error('isolation-unobserved');
      const path = mkdtempSync(join(parent, '.aih-native-'));
      const row = { path, stat: lstatSync(path) }; directories.push(row);
      if (name === 'agent') { agentDirectory = path; continue; }
      files[name] = join(path, 'read'); writes.push(join(path, 'write'));
      writeFileSync(files[name], bytes, { flag: 'wx', mode: 0o600 }); row.file = lstatSync(files[name]);
    }
  } catch (error) { remove(); throw error; }
  return { files: Object.freeze(files), writes: Object.freeze(writes), agentDirectory, pathname: join(agentDirectory, 'agent'),
    snapshot() {
      let readIntact = true, writeAbsent = true;
      for (const row of directories.filter(value => value.file)) {
        let fd;
        try {
          fd = openSync(join(row.path, 'read'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
          const stat = fstatSync(fd), observed = Buffer.alloc(33);
          if (!same(stat, row.file) || !stat.isFile() || stat.size !== 32 || readSync(fd, observed, 0, 33, 0) !== 32 ||
              !observed.subarray(0, 32).equals(bytes)) readIntact = false;
        } catch { readIntact = false; }
        finally { if (fd !== undefined) closeSync(fd); }
      }
      for (const path of writes) { try { lstatSync(path); writeAbsent = false; } catch (error) { if (!missing(error) && writeAbsent !== false) writeAbsent = null; } }
      return { readIntact, writeAbsent };
    }, remove };
}
