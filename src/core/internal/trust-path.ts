import { lstatSync, realpathSync, readdirSync, statfsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, parse } from 'node:path';
import { canonicalJson } from './canonical.js';
import { pathPins, userHomeRoot, validSegment, type PathPin } from './host-files.js';

export interface TrustPath { home: string; path: string; relativePath: string; pathKey: string; pins: PathPin[] }
function sameIdentity(a: string, b: string): boolean {
  try { const x = lstatSync(a, { bigint: true }); const y = lstatSync(b, { bigint: true });
    return x.ino !== 0n && x.dev === y.dev && x.ino === y.ino; } catch { return false; }
}
/** Native lookup supplies spelling and identity; text folding supplies neither. */
function canonicalSegments(home: string, segments: string[]): string[] {
  const result: string[] = []; let parent = home;
  for (const name of segments) {
    const path = join(parent, name);
    try {
      const stat = lstatSync(path); if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new Error('output-path-alias');
      const matches = readdirSync(parent).filter(sibling => sameIdentity(path, join(parent, sibling)));
      if (matches.length !== 1) throw new Error('output-path-alias');
      result.push(matches[0]!); parent = join(parent, matches[0]!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      result.push(...segments.slice(result.length)); break;
    }
  }
  return result;
}
/** Prove the nearest existing directory's native name behavior for absent aliases. */
function nameBehavior(path: string): 'sensitive' | 'insensitive' {
  let parent = dirname(path);
  while (true) { try { if (!lstatSync(parent).isDirectory()) throw new Error('output-path-alias'); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const next = dirname(parent); if (next === parent) throw new Error('output-path-alias'); parent = next; } }
  if (process.platform === 'win32') {
    const volume = spawnSync('fsutil.exe', ['fsinfo', 'volumeinfo', parse(parent).root], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536 });
    if (volume.status !== 0 || !/NTFS/.test(volume.stdout)) throw new Error('output-path-alias');
    const query = spawnSync('fsutil.exe', ['file', 'queryCaseSensitiveInfo', parent], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536 });
    if (query.status !== 0) throw new Error('output-path-alias');
    if (/is disabled\./.test(query.stdout)) return 'insensitive';
    if (/is enabled\./.test(query.stdout)) return 'sensitive';
    throw new Error('output-path-alias');
  }
  if (process.platform === 'linux') {
    // Only known local filesystems; arbitrary network/overlay semantics are unclaimed.
    const kind = statfsSync(parent).type;
    // ext4 supports per-directory case folding, so its filesystem tag alone is insufficient.
    if ([0x58465342, 0x01021994, 0x9123683e].includes(kind)) return 'sensitive';
  }
  // APFS normalization and per-volume behavior need a native proven adapter.
  throw new Error('output-path-alias');
}
function insensitiveEquivalent(a: string, b: string): boolean {
  // Native ordinal comparison is established for ASCII on the proven NTFS cell.
  // Unicode equivalence requires the volume's full collation proof; fail closed.
  if (/[^\x20-\x7e]/.test(a + b)) throw new Error('output-path-alias');
  const script = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AihName { [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode)] public static extern int CompareStringOrdinal(string a,int al,string b,int bl,bool ignoreCase); }'; [AihName]::CompareStringOrdinal($env:AIH_NAME_A,-1,$env:AIH_NAME_B,-1,$true)";
  const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{ encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:65536,
    env:{...process.env,AIH_NAME_A:a,AIH_NAME_B:b} });
  if (result.status !== 0 || !/^[123]\s*$/.test(result.stdout)) throw new Error('output-path-alias');
  return result.stdout.trim() === '2';
}
export function nativeTrustPathEquivalent(a: string, b: string): boolean {
  if (a === b || sameIdentity(a,b)) return true;
  const parentA = dirname(a); const parentB = dirname(b);
  if (parentA !== parentB && !sameIdentity(parentA,parentB)) return false;
  const aName = a.slice(parentA.length + 1); const bName = b.slice(parentB.length + 1);
  return nameBehavior(a) === 'sensitive' ? aName === bName : insensitiveEquivalent(aName,bName);
}
export function resolveTrustPath(output: string, format: 'pem' | 'pkcs7-der' | 'jks', retained: readonly { pathKey: string; relativePath: string }[] = []): TrustPath {
  if (typeof output !== 'string' || !output || output.length > 4096 || output.includes('\\') || output.split('/').some(part => !validSegment(part))) throw new Error('invalid-path');
  if (!output.endsWith(format === 'pem' ? '.pem' : format === 'pkcs7-der' ? '.p7b' : '.jks')) throw new Error('format-path-mismatch');
  const home = userHomeRoot(); const segments = canonicalSegments(home, output.split('/'));
  if (segments[0] === '.aih' && segments[1] === 'core') throw new Error('invalid-path');
  let relativePath = segments.join('/'); let path = join(home, ...segments);
  let pathKey = canonicalJson({ home, segments });
  for (const entry of retained) {
    const prior = join(home, ...entry.relativePath.split('/'));
    if (pathKey === entry.pathKey || sameIdentity(path, prior)) { relativePath = entry.relativePath; path = prior; pathKey = entry.pathKey; break; }
    let aAbsent = false; let bAbsent = false;
    try { lstatSync(path); } catch (e) { aAbsent = (e as NodeJS.ErrnoException).code === 'ENOENT'; }
    try { lstatSync(prior); } catch (e) { bAbsent = (e as NodeJS.ErrnoException).code === 'ENOENT'; }
    if (aAbsent && bAbsent && dirname(path) === dirname(prior)) {
      const behavior = nameBehavior(path);
      if (behavior === 'insensitive' && insensitiveEquivalent(segments.at(-1)!,entry.relativePath.split('/').at(-1)!)) {
        // Lookup cannot prove equivalence for two absent spellings: reject distinct aliases.
        // Never invent a second identity from a lowercased string.
        throw new Error('output-path-alias');
      }
    }
  }
  if (relative(home, path).startsWith('..')) throw new Error('invalid-path');
  return { home: realpathSync.native(home), path, relativePath, pathKey, pins: pathPins(path) };
}
