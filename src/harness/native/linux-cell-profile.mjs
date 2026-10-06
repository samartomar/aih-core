// One trusted immutable enforcement base per cell phase. Session plans are replaced only
// under an exclusive lease after the preceding native owner confirmed complete cleanup.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, fstatSync, ftruncateSync, lstatSync,
  openSync, readSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, snapshotNativeData } from './canonical.mjs';
import { stageLinuxLibraryClosure } from './linux-libraries.mjs';
import { createLinuxBaseProfile } from './linux-profile.mjs';

const cells = new WeakMap();
const fail = () => { throw Error('isolation-unobserved'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uid = () => process.getuid?.() ?? 0;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode &&
  a.uid === b.uid && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const heldFile = (path, expected) => {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd), named = lstatSync(path);
    if (!before.isFile() || named.isSymbolicLink() || before.nlink !== 1 || before.uid !== uid() ||
        before.size > 65536 || !same(before, named) || (expected && !same(before, expected.identity))) fail();
    const bytes = Buffer.alloc(before.size + 1); let used = 0, count;
    while (used < bytes.length && (count = readSync(fd, bytes, used, bytes.length - used, null)) > 0) used += count;
    if (used !== before.size || !same(before, fstatSync(fd)) || !same(before, lstatSync(path))) fail();
    const sha256 = hash(bytes.subarray(0, used));
    if (expected && sha256 !== expected.sha256) fail();
    return { identity: before, sha256, byteLength: used };
  } finally { closeSync(fd); }
};

export function acquireLinuxCellProfile({ cell, phase = 'sessions', expected, runtime, execution, workload, interopSource, interopHelper }) {
  if (!['preflight', 'sessions'].includes(phase)) fail();
  const signature = canonicalJson(snapshotNativeData(expected, 1048576));
  let owner = cells.get(cell);
  if (!owner) {
    const directories = ['path', 'home', 'project', 'scratch', 'observations'].map(key => {
      const path = cell[key], identity = lstatSync(path);
      if (!identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== uid() || (identity.mode & 0o777) !== 0o700) fail();
      return { key, path, identity };
    });
    owner = { phases: new Map(), active: false, blocked: false, validate() {
      for (const { key, path, identity } of directories) {
        const current = lstatSync(path);
        if (cell[key] !== path || !current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev ||
            current.ino !== identity.ino || current.uid !== identity.uid || current.mode !== identity.mode) fail();
      }
    } };
    cells.set(cell, owner);
  }
  if (owner.active || owner.blocked) fail();
  try { owner.validate(); } catch (error) { owner.blocked = true; throw error; }
  let resource = owner.phases.get(phase), created = false;
  if (resource && resource.signature !== signature) fail();
  if (!resource) {
    created = true;
    const suffix = randomBytes(4).toString('hex');
    const planFile = join(cell.observations, `p${suffix}.json`), baseFile = join(cell.observations, `b${suffix}.json`);
    const windowsCanary = execution === 'wsl2' ? join(cell.observations, `w${suffix}.exe`) : null;
    const files = new Map(); let staged;
    try {
      staged = stageLinuxLibraryClosure({ directory: cell.observations, closure: runtime.libraryClosure });
      const loader = runtime.libraryClosure.find(member => member.source === '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2');
      if (!loader) fail();
      if (windowsCanary) {
        const reference = expected.observerPins.find(pin => pin.path === realpathSync.native(interopSource));
        if (!reference || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 2 || reference.byteLength > 65536) fail();
        copyFileSync(interopSource, windowsCanary, constants.COPYFILE_EXCL); chmodSync(windowsCanary, 0o700);
        files.set(windowsCanary, heldFile(windowsCanary));
        const copied = files.get(windowsCanary);
        if (!reference || copied.sha256 !== reference.sha256 || copied.byteLength !== reference.byteLength) fail();
      }
      const profileRuntime = Object.fromEntries(['node', 'client', 'bash', 'env', 'bwrap', 'socat', 'rg', 'libraries', 'readFiles']
        .map(key => [key, runtime[key]]));
      profileRuntime.libraries = [...staged.pins.map(pin => pin.path), loader.source, ...runtime.libraryAliasDirectories];
      profileRuntime.readFiles = [...runtime.readFiles, ...(windowsCanary ? [windowsCanary, interopHelper] : [])];
      const profileInput = snapshotNativeData({ cell: Object.fromEntries(['path', 'home', 'project', 'scratch', 'observations']
        .map(key => [key, cell[key]])), runtime: profileRuntime, workload, plan: planFile, selectedPaths: expected.selectedPaths });
      const base = createLinuxBaseProfile(profileInput), baseBytes = canonicalJson(base);
      if (Buffer.byteLength(baseBytes) > 65536) fail();
      writeFileSync(baseFile, baseBytes, { flag: 'wx', mode: 0o400 }); files.set(baseFile, heldFile(baseFile));
      writeFileSync(planFile, '', { flag: 'wx', mode: 0o600 }); files.set(planFile, heldFile(planFile));
      const validate = ({ check = () => {} } = {}) => {
        check(); owner.validate(); staged.validate({ check });
        for (const [path, pin] of files) { check(); heldFile(path, pin); }
        check();
      };
      const remove = (options = {}) => {
        try {
          validate(options);
          for (const path of files.keys()) { options.check?.(); unlinkSync(path); }
          return staged.remove(options);
        } catch { return false; }
      };
      resource = { signature, planFile, baseFile, windowsCanary, profileInput, base, staged, validate, remove,
        pins: [...staged.pins, ...[...files].filter(([path]) => path !== planFile)
          .map(([path, pin]) => ({ path, sha256: pin.sha256, byteLength: pin.byteLength }))],
        writePlan(bytes) {
          validate(); if (Buffer.byteLength(bytes) > 65536) fail();
          const prior = files.get(planFile), fd = openSync(planFile, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            if (!same(fstatSync(fd), prior.identity)) fail();
            ftruncateSync(fd, 0); const data = Buffer.from(bytes); let used = 0;
            while (used < data.length) used += writeSync(fd, data, used, data.length - used, null);
            const after = fstatSync(fd), named = lstatSync(planFile);
            if (after.dev !== prior.identity.dev || after.ino !== prior.identity.ino || !same(after, named)) fail();
          } finally { closeSync(fd); }
          const current = heldFile(planFile); if (current.sha256 !== hash(bytes)) fail(); files.set(planFile, current);
        } };
      owner.phases.set(phase, resource);
    } catch (error) {
      let removed = true;
      for (const [path, pin] of files) { try { heldFile(path, pin); unlinkSync(path); } catch { removed = false; } }
      if (staged && !staged.remove()) removed = false;
      if (!removed) owner.blocked = true;
      throw error;
    }
  }
  try { resource.validate(); } catch (error) { owner.blocked = true; throw error; }
  owner.active = true;
  let released = false;
  return { ...resource, release(confirmed, prepared = true, options) {
    if (released) return !owner.blocked;
    released = true;
    if (confirmed) { try { resource.validate(options); } catch { confirmed = false; } }
    if (confirmed && !prepared && created) {
      confirmed = resource.remove(options); if (confirmed) owner.phases.delete(phase);
    }
    if (!confirmed) owner.blocked = true;
    owner.active = false;
    return confirmed;
  } };
}
