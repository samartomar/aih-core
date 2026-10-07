import { mkdirSync, lstatSync, readdirSync, realpathSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { join, resolve, relative, parse, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathPins, pinsMatch, sha256, type PathPin } from './host-files.js';
import { readRegularFileWithStats } from './fsxn.js';
import { canonicalJson } from './canonical.js';
import { NativeStop, safeNativePath } from './native-input.js';
import { nativeTreeDigest, type NativeMaterial, type NativeTreeFile } from './native-material.js';
import type { NativeStateEntry } from './native-session.js';

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
    const staged: NativeStatePlan = { home: credential ? [{ path: credential.destination, exclusions: [], inspected: false }] : [], project: [] };
    if (!checkNativePersistence(cell, staged, check)) throw new NativeStop('configuration-changed', 'failed');
    return sha256(canonicalJson({ outputTreeSha256: cell.outputTreeSha256, guardrailsSha256: cell.guardrailsSha256 }));
  } catch (error) { if (error instanceof NativeStop) throw error; throw new NativeStop('staging-unavailable'); }
}
export type NativePersistenceClass = 'pins' | 'configuration-facts' | 'selected-member' | 'unexpected-entry' |
  'state-tree-entry' | 'inspected-state' | 'read-failure' | 'limit';
export type NativeInspectedDiagnosis = { reason: 'unknown-global-key' | 'unknown-project-key' | 'grant-content' |
  'value-shape' | 'malformed-json' | 'oversized' | 'not-record' | 'read-failure'; token: string | null };
export interface NativePersistenceFact { root: 'home' | 'project'; segments: readonly string[]; depth: number; kind: 'file' | 'dir' | 'other' }
export interface NativePersistenceDiagnostics {
  class: NativePersistenceClass;
  items: { root: 'home' | 'project'; depth: number; kind: 'file' | 'dir' | 'other'; token: string; parent: string | null }[];
  truncated: boolean; inspectedDiagnosis: NativeInspectedDiagnosis | null;
}
export type NativeStateInspector = (root: 'home' | 'project', path: string, bytes: Buffer, diagnose?: (value: NativeInspectedDiagnosis) => void) => boolean;
export interface NativeStatePlan { home: NativeStateEntry[]; project: NativeStateEntry[]; inspect?: NativeStateInspector;
  classify?: (fact: NativePersistenceFact) => string }
const STATE_ENTRIES = 16, STATE_EXCLUSIONS = 8, STATE_SEGMENTS = 16, STATE_DEPTH = 32, INSPECTED_STATE_BYTES = 1024 * 1024;
const aliasOverlap = (a: string, b: string): boolean => {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
};
const plainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
/**
 * Validate the runtime's fixed client-state contract before staging and append the staged credential. A malformed
 * contract is an adapter defect; state that overlaps selected configuration or the credential is a path conflict.
 */
export function nativeStatePlan(value: unknown, selected: NativeTreeFile[], credential: string | undefined, inspect?: NativeStateInspector,
  classify?: NativeStatePlan['classify']): NativeStatePlan {
  const invalid = () => new NativeStop('native-internal');
  if (!plainRecord(value) || Object.keys(value).sort().join() !== 'home,project') throw invalid();
  const plan: NativeStatePlan = { home: [], project: [], ...(inspect ? { inspect } : {}), ...(classify ? { classify } : {}) };
  for (const root of ['home', 'project'] as const) {
    const list = value[root];
    if (!Array.isArray(list) || list.length > STATE_ENTRIES) throw invalid();
    for (const raw of list) {
      if (!plainRecord(raw) || Object.keys(raw).sort().join() !== 'exclusions,inspected,path') throw invalid();
      const { path, exclusions, inspected } = raw;
      if (typeof path !== 'string' || !safeNativePath(path) || path.split('/').length > STATE_SEGMENTS || typeof inspected !== 'boolean' ||
        !Array.isArray(exclusions) || exclusions.length > STATE_EXCLUSIONS || inspected && (exclusions.length > 0 || !inspect)) throw invalid();
      const fixed: string[] = [];
      for (const exclusion of exclusions) {
        const parts = typeof exclusion === 'string' && exclusion.length <= 512 ? exclusion.split('/') : [];
        if (!parts.length || parts.length > STATE_SEGMENTS || parts.filter(part => part === '*').length > 1 || parts.every(part => part === '*') ||
          !parts.every(part => part === '*' || safeNativePath(part))) throw invalid();
        fixed.push(parts.join('/').toLowerCase());
      }
      if (plan[root].some(other => aliasOverlap(other.path, path))) throw invalid();
      if (selected.some(file => file.root === root && aliasOverlap(file.path, path)) || root === 'home' && credential !== undefined && aliasOverlap(credential, path))
        throw new NativeStop('guardrail-path-conflict', 'unsupported');
      plan[root].push({ path, exclusions: fixed, inspected });
    }
  }
  if (credential !== undefined) plan.home.push({ path: credential, exclusions: [], inspected: false });
  return plan;
}
/**
 * Selected bytes must be unchanged and every other cell path must be fixed client state. State trees may change,
 * except links, non-regular files and paths under their loading exclusions; inspected files must pass inspection.
 */
export function checkNativePersistence(cell: NativeCell, plan: NativeStatePlan, check: () => void,
  diagnose?: (value: NativePersistenceDiagnostics) => void): boolean {
  let failure: NativePersistenceDiagnostics | undefined;
  let current: NativePersistenceFact | undefined; let ordinal = 0; let readingInspected = false;
  let seen = 0; let firstFact: NativePersistenceFact | undefined;
  const metadata = new Map<string, Stats>();
  const fact = (root: 'home' | 'project', path: string, kind: NativePersistenceFact['kind'] = 'other'): NativePersistenceFact => {
    const segments = path ? path.split('/') : [];
    return { root, segments, depth: segments.length, kind };
  };
  const absoluteFact = (path: string): NativePersistenceFact | undefined => {
    for (const root of ['home', 'project'] as const) if (inside(cell[root], path)) return fact(root, relative(cell[root], path).split(/[\\/]/).join('/'));
    return undefined;
  };
  const item = (value: NativePersistenceFact) => {
    const classify = (value: NativePersistenceFact) => {
      let token: string | undefined;
      try { token = plan.classify?.(value); } catch { /* Observation only. */ }
      return token ?? `unknown-${++ordinal}`;
    };
    const token = classify(value);
    const parent = value.depth <= 1 ? null : classify({ root: value.root, segments: value.segments.slice(0, -1), depth: value.depth - 1, kind: 'dir' });
    return { root: value.root, depth: Math.min(value.depth, 64), kind: value.kind, token, parent };
  };
  const fail = (reason: NativePersistenceClass, value = current, inspectedDiagnosis: NativeInspectedDiagnosis | null = null): false => {
    firstFact ??= value;
    failure ??= { class: reason, items: value ? [item(value)] : [], truncated: true, inspectedDiagnosis };
    return false;
  };
  // A failed admission never resumes admission. This second, metadata-only walk spends only the
  // remaining entry budget, has no new cancellation/budget gates, and cannot change the first decision.
  const collect = () => {
    if (!diagnose || !failure || failure.class === 'pins' || failure.class === 'limit') return;
    const reported = new Set(firstFact ? [`${firstFact.root}/${firstFact.segments.join('/')}`] : []);
    const add = (value: NativePersistenceFact) => {
      const key = `${value.root}/${value.segments.join('/')}`;
      if (!reported.has(key) && failure!.items.length < 16) {
        reported.add(key); failure!.items.push(item(value));
      }
    };
    const same = (a: Stats, b: Stats) => !b.isSymbolicLink() && b.isDirectory() &&
      a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
    const stable = (pins: PathPin[]) => pins.every(pin => {
      try {
        // Fixed OS aliases use the host's existing alias validation; cell directories never admit links.
        if (pin.identity.startsWith('alias:')) return pinsMatch([pin]);
        const stat = lstatSync(pin.path, { bigint: true });
        return !stat.isSymbolicLink() && stat.isDirectory() && `${stat.dev}:${stat.ino}:${stat.mode}` === pin.identity;
      } catch { return false; }
    });
    const excluded = (state: NativeStateEntry, parts: string[]) => state.exclusions.some(value => {
      const pattern = value.split('/');
      return pattern.length <= parts.length && pattern.every((part, i) => part === '*' || part === parts[i]?.toLowerCase());
    });
    const walk = (rootName: 'home' | 'project', prefix: string, expected: Stats, state?: NativeStateEntry): boolean => {
      if (seen >= 4096 || failure!.items.length >= 16) return false;
      const value = fact(rootName, prefix, 'dir');
      const relativeDepth = state ? value.depth - state.path.split('/').length : value.depth;
      if (relativeDepth >= STATE_DEPTH) return true; // Skip this boundary; other branches remain observable.
      const absolute = join(cell[rootName], ...value.segments);
      let names: string[]; let pins: PathPin[];
      try {
        if (!pinsMatch(cell.pins)) return false;
        pins = pathPins(absolute);
        if (!same(expected, lstatSync(absolute)) || !stable(pins)) return true;
        names = readdirSync(absolute);
        if (!stable(pins)) return true;
      } catch { add(value); return true; }
      const selected = cell.tree.filter(file => file.root === rootName).map(file => file.path);
      const declared = [...selected, ...plan[rootName].map(value => value.path)];
      for (const name of names) {
        if (seen >= 4096 || failure!.items.length >= 16) return false;
        if (!stable(pins)) return true;
        const path = prefix ? `${prefix}/${name}` : name;
        const child = fact(rootName, path);
        // Names only, never Dirent link targets or file contents. Containment is checked before metadata access.
        const target = join(cell[rootName], ...child.segments);
        if (!inside(cell[rootName], target)) { add(child); continue; }
        let stat: Stats;
        try {
          const prior = metadata.get(`${rootName}/${path}`);
          if (prior) stat = prior;
          else { ++seen; stat = lstatSync(target); }
        } catch { add(child); continue; }
        if (!stable(pins)) return true;
        child.kind = stat.isSymbolicLink() ? 'other' : stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : 'other';
        const ordinary = !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile() && stat.nlink === 1);
        const owned = plan[rootName].find(value => value.path === path);
        const active = state ?? owned;
        const rejected = !ordinary || (state ? excluded(state, child.segments.slice(state.path.split('/').length)) :
          selected.includes(path) || owned?.inspected ? !stat.isFile() :
          !owned && (!stat.isDirectory() || !declared.some(value => value.startsWith(`${path}/`))));
        if (rejected) add(child);
        // A changed selected member or inspected container is a failed identity/content boundary.
        if (ordinary && stat.isDirectory() && !selected.includes(path) && !owned?.inspected &&
          !walk(rootName, path, stat, active)) return false;
      }
      return true;
    };
    for (const rootName of ['home', 'project'] as const) {
      if (seen >= 4096 || failure.items.length >= 16) break;
      try {
        const stat = lstatSync(cell[rootName]);
        if (!stat.isSymbolicLink() && stat.isDirectory() && !walk(rootName, '', stat)) break;
      } catch { add(fact(rootName, '')); }
    }
  };
  try {
    check(); if (!pinsMatch(cell.pins)) return fail('pins', undefined);
    for (const pins of cell.configurationPins) if (!pinsMatch(pins)) return fail('pins', absoluteFact(pins.at(-1)?.path ?? cell.path));
    for (const file of cell.configurationFacts) {
      current = absoluteFact(file.path);
      if (current) current.kind = 'file';
      if (configurationIdentity(file.path) !== file.identity) return fail('configuration-facts');
    }
    for (const file of cell.tree) {
      current = fact(file.root, file.path, 'file');
      const path = join(file.root === 'home' ? cell.home : cell.project, ...file.path.split('/'));
      const pins = pathPins(path); const captured = readRegularFileWithStats(path, { maxBytes: 8 * 1024 * 1024 });
      if (!captured) return fail('read-failure');
      if (captured.identity.nlink !== 1n || !pinsMatch(pins) || captured.contents.length !== file.member.byteLength || sha256(captured.contents) !== file.member.sha256) return fail('selected-member');
    }
    const inspected: { root: 'home' | 'project'; path: string; absolute: string }[] = [];
    const entry = (rootName: 'home' | 'project', root: string, path: string) => {
      current = fact(rootName, path);
      check(); if (++seen > 4096) throw new NativeStop('limit-exceeded');
      const stat = lstatSync(join(root, ...path.split('/')));
      if (diagnose) metadata.set(`${rootName}/${path}`, stat);
      current.kind = stat.isSymbolicLink() ? 'other' : stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : 'other';
      return stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1 || !stat.isDirectory() && !stat.isFile() ? undefined : stat;
    };
    const excluded = (state: NativeStateEntry, relative: string[]) => state.exclusions.some(exclusion => {
      const parts = exclusion.split('/');
      return parts.length <= relative.length && parts.every((part, index) => part === '*' || part === relative[index]?.toLowerCase());
    });
    const walkState = (rootName: 'home' | 'project', root: string, state: NativeStateEntry, relative: string[]): boolean => {
      current = fact(rootName, [state.path, ...relative].join('/'), 'dir');
      if (relative.length >= STATE_DEPTH) throw new NativeStop('limit-exceeded');
      const names = readdirSync(join(root, ...state.path.split('/'), ...relative));
      for (const name of names) {
        const next = [...relative, name]; const stat = entry(rootName, root, [state.path, ...next].join('/'));
        if (!stat || excluded(state, next)) {
          fail('state-tree-entry');
          return false;
        }
        if (stat.isDirectory() && !walkState(rootName, root, state, next)) return false;
      }
      return true;
    };
    const walk = (rootName: 'home' | 'project', root: string, selected: string[], state: readonly NativeStateEntry[], prefix = ''): boolean => {
      current = fact(rootName, prefix, 'dir');
      const names = readdirSync(join(root, prefix));
      const declared = [...selected, ...state.map(value => value.path)];
      for (const name of names) {
        const path = prefix ? `${prefix}/${name}` : name; const stat = entry(rootName, root, path);
        const owned = state.find(value => value.path === path);
        if (!stat) return fail(owned?.inspected ? 'inspected-state' : owned ? 'state-tree-entry' : selected.includes(path) ? 'selected-member' : 'unexpected-entry',
          current, owned?.inspected ? { reason: 'value-shape', token: null } : null);
        if (selected.includes(path)) { if (!stat.isFile()) return fail('selected-member'); continue; }
        if (owned?.inspected) { if (!stat.isFile()) return fail('inspected-state', current, { reason: 'not-record', token: null }); inspected.push({ root: rootName, path, absolute: join(root, ...path.split('/')) }); continue; }
        if (owned) { if (stat.isDirectory() && !walkState(rootName, root, owned, [])) return false; continue; }
        if (!stat.isDirectory() || !declared.some(file => file.startsWith(`${path}/`))) {
          fail('unexpected-entry');
          return false;
        }
        if (!walk(rootName, root, selected, state, path)) return false;
      }
      return true;
    };
    if (!walk('home', cell.home, cell.tree.filter(file => file.root === 'home').map(file => file.path), plan.home) ||
      !walk('project', cell.project, cell.tree.filter(file => file.root === 'project').map(file => file.path), plan.project)) return false;
    for (const file of inspected) {
      current = fact(file.root, file.path, 'file');
      readingInspected = true;
      check();
      const captured = readRegularFileWithStats(file.absolute, { maxBytes: INSPECTED_STATE_BYTES });
      if (!captured) {
        if (lstatSync(file.absolute).size > INSPECTED_STATE_BYTES) return fail('inspected-state', current, { reason: 'oversized', token: null });
        return fail('read-failure', current, { reason: 'read-failure', token: null });
      }
      if (captured.identity.nlink !== 1n) return fail('inspected-state', current, { reason: 'value-shape', token: null });
      let accepted = false;
      let inspection: NativeInspectedDiagnosis | null = null;
      try { accepted = plan.inspect?.(file.root, file.path, captured.contents, value => { inspection ??= value; }) === true; }
      catch { inspection = { reason: 'read-failure', token: null }; }
      if (!accepted) return fail('inspected-state', current, inspection ?? { reason: 'value-shape', token: null });
      readingInspected = false;
    }
    return true;
  } catch (error) {
    if (error instanceof NativeStop) { if (error.reason === 'limit-exceeded') fail('limit'); throw error; }
    return fail('read-failure', current, readingInspected ? { reason: 'read-failure', token: null } : null);
  } finally {
    if (failure) {
      try { collect(); } catch { /* Partial observation cannot replace the original failure. */ }
      try { diagnose?.(failure); } catch { /* Observation cannot change a verdict or stop. */ }
    }
  }
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
