import { mkdirSync, lstatSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, parse, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathPins, pinsMatch, sha256, type PathPin } from './host-files.js';
import { readRegularFileWithStats } from './fsxn.js';
import { canonicalJson } from './canonical.js';
import { NativeStop, safeNativePath } from './native-input.js';
import { nativeTreeDigest, type NativeMaterial, type NativeTreeFile } from './native-material.js';

export interface NativeCell {
  path: string; home: string; project: string; scratch: string; credentials: string; observations: string;
  pins: PathPin[]; configurationPins: PathPin[][]; configurationFacts: { path: string; identity: string }[];
  tree: NativeTreeFile[]; bytes: Map<string, Buffer>; outputTreeSha256: string; guardrailsSha256: string;
}
function configurationIdentity(path: string): string { const s = lstatSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.ctimeNs}:${s.mtimeNs}:${s.birthtimeNs}:${s.size}`; }
function inside(parent: string, child: string): boolean { const value = relative(parent, child); return value === '' || !value.startsWith('..') && !parse(value).root; }
export function createNativeCell(sandboxRoot: string | undefined, check: () => void, onCreated?: (cell: NativeCell) => void): NativeCell {
  check();
  try {
    const requested = resolve(sandboxRoot ?? tmpdir()); const parent = realpathSync.native(requested);
    const systemTemp = realpathSync.native(tmpdir());
    if (requested !== parent && parent !== systemTemp) throw new NativeStop('sandbox-root-unavailable');
    const pins = pathPins(parent);
    if (!lstatSync(parent).isDirectory() || parse(parent).root === parent || !inside(systemTemp, parent) &&
      (inside(realpathSync.native(homedir()), parent) || inside(realpathSync.native(process.cwd()), parent))) throw new NativeStop('sandbox-root-unavailable');
    if (!pinsMatch(pins)) throw new NativeStop('sandbox-root-unavailable');
    check(); const path = join(parent, `aih-native-${randomBytes(16).toString('hex')}`);
    mkdirSync(path, { mode: 0o700 });
    const cell: NativeCell = { path, home: join(path, 'home'), project: join(path, 'project'), scratch: join(path, 'scratch'), credentials: join(path, 'credentials'), observations: join(path, 'observations'),
      pins: [], configurationPins: [], configurationFacts: [], tree: [], bytes: new Map(), outputTreeSha256: '', guardrailsSha256: '' };
    // Transfer ownership before pinning so an interrupted/failed pin cannot lose the directory.
    onCreated?.(cell);
    cell.pins = pathPins(path);
    if (!pinsMatch(pins)) throw new NativeStop('sandbox-root-unavailable');
    return cell;
  } catch (error) { if (error instanceof NativeStop) throw error; throw new NativeStop('sandbox-root-unavailable'); }
}
export function stageNativeCell(cell: NativeCell, material: NativeMaterial, guardrails: NativeTreeFile[], guardrailBytes: Map<string, Buffer>, guardrailsSha256: string, credential?: { destination: string; bytes: Buffer }, check: () => void = () => {}): string {
  check();
  const aliases = new Set(material.outputTree.map(file => `${file.root}/${file.path.toLowerCase()}`));
  for (const file of guardrails) {
    const alias = `${file.root}/${file.path.toLowerCase()}`;
    if (!safeNativePath(file.path) || aliases.has(alias) || [...aliases].some(other => other.startsWith(`${alias}/`) || alias.startsWith(`${other}/`))) throw new NativeStop('guardrail-path-conflict', 'unsupported');
    aliases.add(alias);
  }
  if (nativeTreeDigest(guardrails) !== guardrailsSha256) throw new NativeStop('fixture-bytes-mismatch', 'failed');
  if (credential && (!safeNativePath(credential.destination) || [...aliases].some(alias => alias === `home/${credential.destination.toLowerCase()}` || alias.startsWith(`home/${credential.destination.toLowerCase()}/`) || `home/${credential.destination.toLowerCase()}`.startsWith(`${alias}/`)))) throw new NativeStop('guardrail-path-conflict', 'unsupported');
  try {
    for (const root of [cell.home, cell.project, cell.scratch, cell.credentials, cell.observations]) {
      check(); try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new NativeStop('staging-unavailable');
    }
    const write = (root: string, path: string, bytes: Buffer) => {
      check(); if (!safeNativePath(path) || !pinsMatch(cell.pins)) throw new NativeStop('staging-unavailable');
      const segments = path.split('/'); let current = root;
      for (const segment of segments.slice(0, -1)) {
        current = join(current, segment);
        try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) throw new NativeStop('staging-unavailable');
      }
      writeFileSync(join(root, ...segments), bytes, { mode: 0o600, flag: 'wx' });
    };
    cell.tree = [...material.outputTree, ...guardrails]; cell.bytes = new Map([...material.bytes, ...guardrailBytes]);
    for (const file of cell.tree) {
      const bytes = cell.bytes.get(file.member.path);
      if (!bytes || bytes.length !== file.member.byteLength || sha256(bytes) !== file.member.sha256) throw new NativeStop('fixture-bytes-mismatch', 'failed');
      write(file.root === 'home' ? cell.home : cell.project, file.path, bytes);
      cell.configurationPins.push(pathPins(join(file.root === 'home' ? cell.home : cell.project, ...file.path.split('/'))));
      const stagedPath = join(file.root === 'home' ? cell.home : cell.project, ...file.path.split('/'));
      cell.configurationFacts.push({ path: stagedPath, identity: configurationIdentity(stagedPath) });
    }
    if (credential) write(cell.home, credential.destination, credential.bytes);
    cell.outputTreeSha256 = material.outputTreeSha256; cell.guardrailsSha256 = guardrailsSha256;
    if (!checkNativePersistence(cell, credential?.destination ? [credential.destination] : [], [], check)) throw new NativeStop('configuration-changed', 'failed');
    return sha256(canonicalJson({ outputTreeSha256: cell.outputTreeSha256, guardrailsSha256: cell.guardrailsSha256 }));
  } catch (error) { if (error instanceof NativeStop) throw error; throw new NativeStop('staging-unavailable'); }
}
export function checkNativePersistence(cell: NativeCell, homeStatePaths: string[], projectStatePaths: string[], check: () => void): boolean {
  check(); if (!pinsMatch(cell.pins) || !cell.configurationPins.every(pinsMatch)) return false;
  try {
    if (!cell.configurationFacts.every(file => configurationIdentity(file.path) === file.identity)) return false;
    for (const file of cell.tree) {
      const path = join(file.root === 'home' ? cell.home : cell.project, ...file.path.split('/'));
      const pins = pathPins(path); const captured = readRegularFileWithStats(path, { maxBytes: 8 * 1024 * 1024 });
      if (!captured || captured.identity.nlink !== 1n || !pinsMatch(pins) || captured.contents.length !== file.member.byteLength || sha256(captured.contents) !== file.member.sha256) return false;
    }
    let seen = 0;
    const walk = (root: string, selected: string[], state: string[], prefix = ''): boolean => {
      for (const name of readdirSync(join(root, prefix))) {
        check(); if (++seen > 4096) throw new NativeStop('limit-exceeded');
        const path = prefix ? `${prefix}/${name}` : name; const stat = lstatSync(join(root, ...path.split('/')));
        if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1 || !stat.isDirectory() && !stat.isFile()) return false;
        if (selected.includes(path)) { if (!stat.isFile()) return false; continue; }
        if (state.some(allowed => path === allowed || path.startsWith(`${allowed}/`))) continue;
        if (!stat.isDirectory() || !selected.some(file => file.startsWith(`${path}/`)) || !walk(root, selected, state, path)) return false;
      }
      return true;
    };
    return walk(cell.home, cell.tree.filter(file => file.root === 'home').map(file => file.path), homeStatePaths) &&
      walk(cell.project, cell.tree.filter(file => file.root === 'project').map(file => file.path), projectStatePaths);
  } catch (error) { if (error instanceof NativeStop) throw error; return false; }
}
export function removeNativeCell(cell: NativeCell, check: () => void): boolean {
  try {
    check(); if (!cell.pins.length || !pinsMatch(cell.pins) || !basename(cell.path).match(/^aih-native-[a-f0-9]{32}$/)) return false;
    let count = 0;
    const safe = (path: string): boolean => {
      check(); if (++count > 8192) return false;
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || stats.isFile() && stats.nlink !== 1 || !stats.isDirectory() && !stats.isFile()) return false;
      return !stats.isDirectory() || readdirSync(path).every(name => safe(join(path, name)));
    };
    if (!safe(cell.path) || !pinsMatch(cell.pins)) return false;
    rmSync(cell.path, { recursive: true, maxRetries: 0 }); return true;
  } catch { return false; }
}
