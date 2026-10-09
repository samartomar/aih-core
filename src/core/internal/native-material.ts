import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstatSync, readdirSync } from 'node:fs';
import { readRegularFileWithStats } from './fsxn.js';
import { ownedDirectoryChain, pathPins, pinsMatch, sha256 } from './host-files.js';
import { canonicalJson, codeUnitCompare } from './canonical.js';
import { parseStrictJsonObjectV1 } from './strict-json.js';
import { NativeStop, safeNativePath } from './native-input.js';
import { validateNativeVerificationBundle } from '../native-contracts.js';
import type { NativeVerificationBundle, NativeVerificationRequest } from '../native-contracts.js';
import type { NativeVerificationControls } from '../native-verification.js';

export type NativeTreeFile = NativeVerificationBundle['outputTree'][number];
export type NativeMember = NativeTreeFile['member'];
export interface NativeMaterial {
  id: string; client: string; adapterId: string;
  outputTree: NativeTreeFile[]; outputTreeSha256: string;
  instructions: NativeVerificationBundle['instructions']; server: NativeVerificationBundle['server'];
  manifestSha256: string; archiveSha256: string | null;
  scope: 'bundled-mechanism' | 'test-configuration' | 'production-configuration';
  bytes: Map<string, Buffer>;
}
export function nativeTreeDigest(tree: NativeTreeFile[]): string {
  return sha256(canonicalJson(tree.map(({ root, path, member }) => ({ root, path, sha256: member.sha256, byteLength: member.byteLength }))
    .sort((a, b) => codeUnitCompare(a.root, b.root) || codeUnitCompare(a.path, b.path))));
}
export function nativeReadPinned(path: string, maximum: number, check: () => void): Buffer {
  check();
  let pins;
  try { pins = pathPins(path); } catch { throw new NativeStop('configuration-unavailable'); }
  const captured = readRegularFileWithStats(path, { maxBytes: maximum });
  if (!captured || captured.identity.nlink !== 1n || !pinsMatch(pins)) throw new NativeStop('configuration-unavailable');
  check(); return captured.contents;
}
/** Internal seam: `posix` gates the multi-link allowance; `owned` accepts the owner uid (root by default). */
export interface RuntimePinTrust { posix: boolean; owned: (uid: bigint) => boolean }
const systemTrust: RuntimePinTrust = { posix: process.platform !== 'win32', owned: uid => uid === 0n };
/**
 * Platform runtime pins only. A multi-link regular file (e.g. a rust-coreutils multicall binary) is
 * accepted when POSIX, root-owned, not group/other writable, under root-owned non-writable real
 * directories, and unchanged across the read. Single-link files behave exactly as `nativeReadPinned`.
 */
export function nativeReadPinnedRuntime(path: string, maximum: number, check: () => void, trust: RuntimePinTrust = systemTrust): Buffer {
  check();
  let pins;
  try { pins = pathPins(path, trust.posix); } catch { throw new NativeStop('configuration-unavailable'); }
  const captured = readRegularFileWithStats(path, { maxBytes: maximum });
  if (!captured || !pinsMatch(pins, trust.posix)) throw new NativeStop('configuration-unavailable');
  if (captured.identity.nlink !== 1n) {
    const opened = captured.identity;
    let now;
    try { now = lstatSync(path, { bigint: true }); } catch { throw new NativeStop('configuration-unavailable'); }
    if (!trust.posix || !now.isFile() || now.dev !== opened.dev || now.ino !== opened.ino || now.size !== opened.size || now.mtimeNs !== opened.mtimeNs ||
      now.ctimeNs !== opened.ctimeNs || now.nlink !== opened.nlink || !trust.owned(opened.uid) || (opened.mode & 0o022n) !== 0n ||
      !ownedDirectoryChain(path, trust.owned)) throw new NativeStop('configuration-unavailable');
  }
  check(); return captured.contents;
}
function tarNumber(field: Buffer): number {
  const value = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(value)) throw new NativeStop('material-path-unsafe', 'failed');
  const number = parseInt(value, 8);
  if (!Number.isSafeInteger(number) || number < 0) throw new NativeStop('limit-exceeded');
  return number;
}
function tarString(field: Buffer): string {
  const zero = field.indexOf(0); const bytes = zero < 0 ? field : field.subarray(0, zero);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new NativeStop('material-path-unsafe', 'failed'); }
}
/** Parse only bounded regular ustar members; no filesystem extraction occurs. */
function tarMembers(archive: Buffer, check: () => void): Map<string, Buffer> {
  let bytes: Buffer;
  try { bytes = archive[0] === 0x1f && archive[1] === 0x8b ? gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 }) : archive; }
  catch { throw new NativeStop('limit-exceeded'); }
  if (bytes.length > 512 * 1024 * 1024) throw new NativeStop('limit-exceeded');
  const members = new Map<string, Buffer>(); const aliases = new Set<string>(); let count = 0; let offset = 0; let ended = false;
  while (offset + 512 <= bytes.length) {
    check(); const header = bytes.subarray(offset, offset + 512); offset += 512;
    if (header.every(value => value === 0)) { ended = true; break; }
    if (++count > 4096) throw new NativeStop('limit-exceeded');
    const sum = header.reduce((total, value, index) => total + (index >= 148 && index < 156 ? 32 : value), 0);
    if (sum !== tarNumber(header.subarray(148, 156))) throw new NativeStop('fixture-bytes-mismatch', 'failed');
    const prefix = tarString(header.subarray(345, 500)); const name = tarString(header.subarray(0, 100));
    const kind = header[156]; const directory = kind === 53;
    const path = `${prefix ? `${prefix}/` : ''}${name}`.replace(directory ? /\/$/ : /$^/, '');
    if (!safeNativePath(path, true) && !(directory && path === 'package')) throw new NativeStop('material-path-unsafe', 'failed');
    const alias = path.normalize('NFC').toLowerCase();
    if (aliases.has(alias)) throw new NativeStop('material-path-unsafe', 'failed');
    aliases.add(alias);
    const length = tarNumber(header.subarray(124, 136));
    if (offset + length > bytes.length) throw new NativeStop('fixture-bytes-mismatch', 'failed');
    if (directory) { if (length !== 0) throw new NativeStop('material-path-unsafe', 'failed'); }
    else if (kind === 0 || kind === 48) members.set(path, bytes.subarray(offset, offset + length));
    else throw new NativeStop('material-path-unsafe', 'failed');
    offset += Math.ceil(length / 512) * 512;
  }
  if (!ended || bytes.subarray(offset).some(value => value !== 0)) throw new NativeStop('fixture-bytes-mismatch', 'failed');
  // A file may not act as an ancestor directory, regardless of archive order.
  for (const path of members.keys()) for (const ancestor of path.split('/').slice(0, -1).map((_, index) => path.split('/').slice(0, index + 1).join('/')))
    if (members.has(ancestor)) throw new NativeStop('material-path-unsafe', 'failed');
  return members;
}
function captureMembers(members: NativeMember[], source: Map<string, Buffer>, check: () => void): Map<string, Buffer> {
  const selected = new Map<string, Buffer>(); let total = 0;
  for (const member of members) {
    check(); if (!safeNativePath(member.path, true)) throw new NativeStop('material-path-unsafe', 'failed');
    if (selected.has(member.path)) {
      const old = selected.get(member.path)!;
      if (old.length !== member.byteLength || sha256(old) !== member.sha256) throw new NativeStop('fixture-bytes-mismatch', 'failed');
      continue;
    }
    if (member.byteLength > 8 * 1024 * 1024 || selected.size >= 256 || (total += member.byteLength) > 32 * 1024 * 1024) throw new NativeStop('limit-exceeded');
    const bytes = source.get(member.path);
    if (!bytes || bytes.length !== member.byteLength || sha256(bytes) !== member.sha256) throw new NativeStop('fixture-bytes-mismatch', 'failed');
    selected.set(member.path, Buffer.from(bytes));
  }
  return selected;
}
export function validateMaterialTrees(material: Pick<NativeMaterial, 'outputTree' | 'outputTreeSha256' | 'instructions'>): void {
  const aliases = new Set<string>();
  for (const file of material.outputTree) {
    if (!safeNativePath(file.path)) throw new NativeStop('material-path-unsafe', 'failed');
    const alias = `${file.root}/${file.path.normalize('NFC').toLowerCase()}`;
    if (aliases.has(alias) || [...aliases].some(other => other.startsWith(`${alias}/`) || alias.startsWith(`${other}/`))) throw new NativeStop('material-path-unsafe', 'failed');
    aliases.add(alias);
  }
  if (nativeTreeDigest(material.outputTree) !== material.outputTreeSha256) throw new NativeStop('fixture-bytes-mismatch', 'failed');
  for (const instruction of material.instructions) {
    const file = material.outputTree.find(file => file.root === instruction.root && file.path === instruction.path);
    if (!file || file.member.sha256 !== instruction.sha256) throw new NativeStop('fixture-bytes-mismatch', 'failed');
  }
}
export function acquireNativeSupplied(request: NativeVerificationRequest, controls: NativeVerificationControls, check: () => void): NativeMaterial {
  if (request.configuration?.kind !== 'supplied') throw new NativeStop('configuration-unavailable');
  const selection = request.configuration; const binding = controls.configurationSources![selection.input]!;
  const archive = nativeReadPinned(binding.archivePath, 256 * 1024 * 1024, check);
  if (archive.length !== binding.archiveBytes || sha256(archive) !== binding.archiveSha256) throw new NativeStop('fixture-bytes-mismatch', 'failed');
  const members = tarMembers(archive, check); const manifest = members.get(binding.manifestPath);
  if (!manifest || manifest.length !== binding.manifestBytes || sha256(manifest) !== binding.manifestSha256) throw new NativeStop('fixture-bytes-mismatch', 'failed');
  if (manifest.length > 256 * 1024) throw new NativeStop('limit-exceeded');
  let bundle: NativeVerificationBundle;
  try {
    const parsed = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(manifest), 'native bundle');
    const validation = validateNativeVerificationBundle(parsed);
    if (!validation.valid) throw new NativeStop(validation.diagnostics.some(d => d.code === 'SCHEMA_UNSUPPORTED') ? 'configuration-channel-unsupported' : 'configuration-unavailable', validation.diagnostics.some(d => d.code === 'SCHEMA_UNSUPPORTED') ? 'unsupported' : 'unavailable');
    bundle = parsed as unknown as NativeVerificationBundle;
  } catch (error) { if (error instanceof NativeStop) throw error; throw new NativeStop('configuration-unavailable'); }
  if (bundle.id !== selection.bundleId || bundle.client !== request.client) throw new NativeStop('fixture-bytes-mismatch', 'failed');
  if (nativeTreeDigest(bundle.startingTree) !== bundle.startingTreeSha256) throw new NativeStop('fixture-bytes-mismatch', 'failed');
  const bytes = captureMembers([bundle.release, bundle.selection.recipe, ...bundle.startingTree.map(file => file.member), ...bundle.outputTree.map(file => file.member), ...bundle.server.runtime, ...(bundle.server.recorder ? [bundle.server.recorder] : [])], members, check);
  const material: NativeMaterial = { ...bundle, bytes, manifestSha256: binding.manifestSha256, archiveSha256: binding.archiveSha256 };
  validateMaterialTrees(material); return material;
}
const installedRoot = dirname(fileURLToPath(new URL('../../../package.json', import.meta.url)));
export interface NativeHelperPin { paths: { path: string; sha256: string }[]; sha256: string }
export function captureNativeHelpers(check: () => void): NativeHelperPin {
  const directory = fileURLToPath(new URL('../../harness/native/', import.meta.url));
  const files: string[] = [];
  const inventory = (root: string, depth: number): void => {
    check();
    if (depth > 4) throw new NativeStop('limit-exceeded');
    for (const name of readdirSync(root).sort(codeUnitCompare)) {
      check();
      const path = join(root, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new NativeStop('configuration-unavailable');
      if (stat.isDirectory()) inventory(path, depth + 1);
      else if (!stat.isFile()) throw new NativeStop('configuration-unavailable');
      else if (!name.endsWith('.d.mts')) {
        files.push(path);
        if (files.length > 64) throw new NativeStop('limit-exceeded');
      }
    }
  };
  try { inventory(directory, 0); }
  catch (error) { if (error instanceof NativeStop) throw error; throw new NativeStop('configuration-unavailable'); }
  if (!files.includes(join(directory, 'runtime.mjs'))) throw new NativeStop('configuration-unavailable');
  const paths = [join(installedRoot, 'package.json'), ...files]
    .map(path => ({ path, sha256: sha256(nativeReadPinned(path, 8 * 1024 * 1024, check)) }));
  return { paths, sha256: sha256(canonicalJson(paths.map(({ path, sha256 }) => ({ name: path === join(installedRoot, 'package.json') ? 'package.json' : path.slice(directory.length), sha256 })))) };
}
export function revalidateNativeHelpers(pin: NativeHelperPin, check: () => void): boolean {
  try { return captureNativeHelpers(check).sha256 === pin.sha256; } catch (error) { if (error instanceof NativeStop && ['cancelled', 'budget-exhausted'].includes(error.reason)) throw error; return false; }
}
export function captureNativeInstalledMembers(members: NativeMember[], check: () => void, bundledBytes: Map<string, Buffer> = new Map()): Map<string, Buffer> {
  const source = new Map<string, Buffer>();
  for (const member of members) {
    if (!safeNativePath(member.path, true)) throw new NativeStop('material-path-unsafe', 'failed');
    const bundled = bundledBytes.get(member.path);
    if (bundled) source.set(member.path, bundled);
    else {
      const file = join(installedRoot, ...member.path.slice('package/'.length).split('/'));
      source.set(member.path, nativeReadPinned(file, 8 * 1024 * 1024, check));
    }
  }
  return captureMembers(members, source, check);
}
