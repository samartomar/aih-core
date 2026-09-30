import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { pathPins, pinsMatch, type PathPin } from './host-files.js';

export const MATERIAL_LIMITS = Object.freeze({
  compressedBytes: 64 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024,
  regularMembers: 4096,
  memberBytes: 16 * 1024 * 1024,
  recipeBytes: 1_000_000,
  capturedBytes: 512 * 1024 * 1024,
  acquisitionMs: 60_000,
  pathBytes: 4096,
  pathSegments: 64,
});

export interface MaterialMemberDescriptor { id: string; path: string; sha256: string; byteLength: number }
export interface InlineMaterialDescriptor extends MaterialMemberDescriptor {
  source: MaterialRecipeReference['source'];
}
export interface MaterialRecipeReference {
  source: { kind: 'archive'; url: string; sha256: string; byteLength: number } | { kind: 'local'; input: string };
  path: string;
  sha256: string;
  byteLength: number;
  materials: MaterialMemberDescriptor[];
}
export interface CapturedRecipeReference {
  readonly recipeSha256: string;
  readonly materials: readonly Readonly<MaterialMemberDescriptor>[];
  readRecipe(): Buffer;
  readMaterial(id: string): Buffer | undefined;
  /** Rechecks the source for local handles; archive bytes were captured and remain private. */
  recheck(): Promise<boolean>;
}
export interface CapturedInlineMaterials {
  readonly materials: readonly Readonly<MaterialMemberDescriptor>[];
  readMaterial(id: string): Buffer | undefined;
  recheck(): Promise<boolean>;
}

export class MaterialCaptureError extends Error {
  constructor(readonly reason: string) {
    super(`Material capture failed: ${reason}`);
    this.name = 'MaterialCaptureError';
  }
}
function fail(reason: string): never { throw new MaterialCaptureError(reason); }
const hex = /^[a-f0-9]{64}$/u;
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' &&
      Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
      'value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}));
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function byteLength(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= limit;
}
function digest(value: unknown): value is string { return typeof value === 'string' && hex.test(value); }
function memberPath(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MATERIAL_LIMITS.pathBytes ||
      value.startsWith('/') || value.startsWith('\\') || isAbsolute(value)) fail('unsafe-member-path');
  const segments = value.split('/');
  if (segments.length > MATERIAL_LIMITS.pathSegments || segments.some(segment => !segment || segment === '.' ||
      segment === '..' || segment.includes('\\') || segment.includes(':') || /[. ]$/u.test(segment) ||
      /[\u0000-\u001f\u007f]/u.test(segment) || /\p{C}/u.test(segment) ||
      segment.normalize('NFC') !== segment || reserved.test(segment))) fail('unsafe-member-path');
  return value;
}
function memberDescriptor(value: unknown): MaterialMemberDescriptor {
  if (!exact(value, ['id', 'path', 'sha256', 'byteLength']) ||
      typeof value.id !== 'string' || !value.id || value.id.length > 256 ||
      !digest(value.sha256) || !byteLength(value.byteLength, MATERIAL_LIMITS.memberBytes)) fail('invalid-member-descriptor');
  return { id: value.id, path: memberPath(value.path), sha256: value.sha256, byteLength: value.byteLength };
}
type CheckedReference = Omit<MaterialRecipeReference, 'materials'> & { materials: MaterialMemberDescriptor[] };
function checkedSource(source: unknown): MaterialRecipeReference['source'] {
  if (!plain(source) || (source.kind !== 'local' && source.kind !== 'archive')) fail('invalid-source');
  if (source.kind === 'local') {
    if (!exact(source, ['kind', 'input']) || typeof source.input !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(source.input)) fail('invalid-local-source');
  } else {
    if (!exact(source, ['kind', 'url', 'sha256', 'byteLength']) || typeof source.url !== 'string' ||
        !digest(source.sha256) || !byteLength(source.byteLength, MATERIAL_LIMITS.compressedBytes)) fail('invalid-archive-source');
    let url: URL;
    try { url = new URL(source.url); } catch { fail('invalid-archive-url'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash ||
        (url.port && url.port !== '443')) fail('invalid-archive-url');
  }
  return source as MaterialRecipeReference['source'];
}
function checkedReference(value: unknown): CheckedReference {
  if (!exact(value, ['source', 'path', 'sha256', 'byteLength', 'materials']) ||
      !digest(value.sha256) || !byteLength(value.byteLength, MATERIAL_LIMITS.recipeBytes) ||
      !Array.isArray(value.materials) || value.materials.length > MATERIAL_LIMITS.regularMembers) fail('invalid-reference');
  const path = memberPath(value.path);
  const source = checkedSource(value.source);
  const materials = value.materials.map(memberDescriptor);
  const ids = new Set<string>();
  const paths = new Map<string, string>();
  let total = value.byteLength;
  for (const material of materials) {
    if (ids.has(material.id)) fail('duplicate-material-id');
    ids.add(material.id);
    const samePath = paths.get(material.path);
    const identity = `${material.sha256}:${material.byteLength}`;
    if (samePath !== undefined && samePath !== identity) fail('inconsistent-material-path');
    paths.set(material.path, identity);
    if (samePath === undefined && material.path !== path) total += material.byteLength;
  }
  if (materials.some((item, index) => index > 0 && materials[index - 1]!.id >= item.id)) fail('unsorted-materials');
  const recipePathIdentity = paths.get(path);
  if (recipePathIdentity !== undefined && recipePathIdentity !== `${value.sha256}:${value.byteLength}`)
    fail('inconsistent-material-path');
  if (total > MATERIAL_LIMITS.capturedBytes) fail('captured-byte-limit');
  return { source, path, sha256: value.sha256,
    byteLength: value.byteLength, materials };
}
function referenceDeclaredBytes(reference: CheckedReference): number {
  const paths = new Set([reference.path]);
  let total = reference.byteLength;
  for (const material of reference.materials) if (!paths.has(material.path)) {
    paths.add(material.path);
    total += material.byteLength;
  }
  return total;
}
type CheckedInline = InlineMaterialDescriptor[];
function checkedInlineMaterials(value: unknown): { materials: CheckedInline; bytes: number } {
  if (!Array.isArray(value) || value.length > MATERIAL_LIMITS.regularMembers) fail('invalid-inline-materials');
  const materials: CheckedInline = value.map(item => {
    if (!exact(item, ['id', 'path', 'sha256', 'byteLength', 'source'])) fail('invalid-inline-material');
    const member = memberDescriptor({ id: item.id, path: item.path, sha256: item.sha256,
      byteLength: item.byteLength });
    return { ...member, source: checkedSource(item.source) };
  });
  const ids = new Set<string>();
  const paths = new Map<string, string>();
  const archives = new Map<string, string>();
  let bytes = 0;
  for (const [index, item] of materials.entries()) {
    if (ids.has(item.id)) fail('duplicate-material-id');
    if (index > 0 && materials[index - 1]!.id >= item.id) fail('unsorted-materials');
    ids.add(item.id);
    const sourceKey = item.source.kind === 'archive' ? `archive:${item.source.url}` : `local:${item.source.input}`;
    const key = `${sourceKey}\0${item.path}`;
    const identity = `${item.sha256}:${item.byteLength}`;
    const previous = paths.get(key);
    if (previous !== undefined && previous !== identity) fail('inconsistent-material-path');
    paths.set(key, identity);
    if (previous === undefined) bytes += item.byteLength;
    if (item.source.kind === 'archive') {
      const archiveIdentity = `${item.source.sha256}:${item.source.byteLength}`;
      const prior = archives.get(item.source.url);
      if (prior !== undefined && prior !== archiveIdentity) fail('inconsistent-archive-source');
      archives.set(item.source.url, archiveIdentity);
    }
  }
  if (bytes > MATERIAL_LIMITS.capturedBytes) fail('captured-byte-limit');
  return { materials, bytes };
}
function referenceDeclaration(reference: CheckedReference): string {
  return JSON.stringify(['reference', sourceDeclaration(reference.source), reference.path, reference.sha256,
    reference.byteLength, reference.materials.map(item => [item.id, item.path, item.sha256, item.byteLength])]);
}
function sourceDeclaration(source: MaterialRecipeReference['source']): unknown {
  return source.kind === 'local' ? ['local', source.input] :
    ['archive', source.url, source.sha256, source.byteLength];
}
function inlineDeclaration(materials: CheckedInline): string {
  return JSON.stringify(['inline', materials.map(item =>
    [item.id, item.path, item.sha256, item.byteLength, sourceDeclaration(item.source)])]);
}

/** Register every selection, seal once, then pass this budget to each capture in the same preparation. */
export class MaterialCaptureBudget {
  private sealed = false;
  private total = 0;
  private readonly declarations = new Map<string, number>();
  get declaredBytes(): number { return this.total; }
  private declare(key: string, bytes: number): void {
    if (this.sealed) fail('capture-budget-sealed');
    if (bytes > MATERIAL_LIMITS.capturedBytes - this.total) fail('captured-byte-limit');
    this.total += bytes;
    this.declarations.set(key, (this.declarations.get(key) ?? 0) + 1);
  }
  declareReference(reference: MaterialRecipeReference): void {
    const checked = checkedReference(reference);
    this.declare(referenceDeclaration(checked), referenceDeclaredBytes(checked));
  }
  declareInline(materials: unknown): void {
    const checked = checkedInlineMaterials(materials);
    this.declare(inlineDeclaration(checked.materials), checked.bytes);
  }
  seal(): void { if (this.sealed) fail('capture-budget-sealed'); this.sealed = true; }
  claimReference(reference: CheckedReference): void { this.claim(referenceDeclaration(reference)); }
  claimInline(materials: CheckedInline): void { this.claim(inlineDeclaration(materials)); }
  private claim(key: string): void {
    if (!this.sealed) fail('capture-budget-unsealed');
    const remaining = this.declarations.get(key) ?? 0;
    if (!remaining) fail('capture-not-declared');
    this.declarations.set(key, remaining - 1);
  }
}
export function createMaterialCaptureBudget(): MaterialCaptureBudget { return new MaterialCaptureBudget(); }
function checkBytes(bytes: Buffer | undefined, sha256: string, length: number, reason: string): Buffer {
  if (!bytes || bytes.length !== length || hash(bytes) !== sha256) fail(reason);
  return bytes;
}
function declaredClosure(recipe: Buffer, members: readonly MaterialMemberDescriptor[]): void {
  let document: unknown;
  try { document = JSON.parse(fatalUtf8.decode(recipe)); } catch { fail('invalid-recipe-json'); }
  if (!plain(document) || !Array.isArray(document.materials) || document.materials.length !== members.length)
    fail('material-closure-mismatch');
  const expected = new Map(members.map(member => [member.id, member]));
  const seen = new Set<string>();
  for (const actual of document.materials) {
    if (!exact(actual, ['id', 'sha256', 'byteLength']) || typeof actual.id !== 'string' || seen.has(actual.id))
      fail('material-closure-mismatch');
    seen.add(actual.id);
    const pin = expected.get(actual.id);
    if (!pin || actual.sha256 !== pin.sha256 || actual.byteLength !== pin.byteLength)
      fail('material-closure-mismatch');
  }
}

type FileIdentity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint };
type LocalRoot = { canonical: string; pins: PathPin[] };
function localRoot(root: unknown): LocalRoot {
  if (typeof root !== 'string' || !isAbsolute(root)) fail('invalid-local-root');
  try { if (!statSync(root).isDirectory()) fail('unsafe-local-root'); }
  catch (error) { if (error instanceof MaterialCaptureError) throw error; fail('local-root-unavailable'); }
  let pins: PathPin[];
  try { pins = pathPins(root); } catch { fail('unsafe-local-root'); }
  if (!pinsMatch(pins)) fail('unsafe-local-root');
  const canonical = realpathSync.native(root);
  if (!pinsMatch(pins)) fail('unsafe-local-root');
  return { canonical, pins };
}
function readLocal(root: string, path: string, expectedLength: number, deadline: number, signal?: AbortSignal): { bytes: Buffer; identity: FileIdentity } {
  const segments = path.split('/');
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-local-path');
  }
  const file = join(root, ...segments);
  const rel = relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('unsafe-local-path');
  const named = lstatSync(file, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink()) fail('unsafe-local-file');
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino ||
        before.size !== named.size || before.size !== BigInt(expectedLength)) fail('local-file-changed');
    const output = Buffer.alloc(expectedLength + 1);
    let offset = 0;
    while (offset < output.length) {
      if (signal?.aborted) fail('cancelled');
      if (performance.now() > deadline) fail('acquisition-deadline');
      const count = readSync(fd, output, offset, Math.min(64 * 1024, output.length - offset), null);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (offset !== expectedLength || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs) fail('local-file-changed');
    return { bytes: output.subarray(0, offset), identity: {
      dev: before.dev, ino: before.ino, size: before.size, mtimeNs: before.mtimeNs,
    } };
  } finally { if (fd !== undefined) closeSync(fd); }
}

function utf8Field(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  try { return fatalUtf8.decode(end < 0 ? bytes : bytes.subarray(0, end)); }
  catch { fail('invalid-tar-utf8'); }
}
function octal(header: Buffer, start: number, length: number): number {
  const text = utf8Field(header, start, length).trim();
  if (!text || !/^[0-7]+$/u.test(text)) fail('invalid-tar-number');
  const number = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(number) || number < 0) fail('invalid-tar-number');
  return number;
}
function tarHeader(header: Buffer): { path: string; type: string; size: number; mode: number } {
  const checksum = octal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i]!;
  if (checksum !== sum) fail('invalid-tar-checksum');
  const name = utf8Field(header, 0, 100);
  const prefix = utf8Field(header, 345, 155);
  return { path: prefix ? `${prefix}/${name}` : name,
    type: utf8Field(header, 156, 1) || '0', size: octal(header, 124, 12), mode: octal(header, 100, 8) };
}
function paxPath(bytes: Buffer): string {
  let offset = 0;
  let path: string | undefined;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space <= offset) fail('invalid-pax-record');
    const prefix = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/u.test(prefix)) fail('invalid-pax-record');
    const length = Number(prefix);
    if (!Number.isSafeInteger(length) || length > bytes.length - offset || length <= space - offset + 1)
      fail('invalid-pax-record');
    const record = bytes.subarray(space + 1, offset + length);
    if (record.at(-1) !== 10) fail('invalid-pax-record');
    const equals = record.indexOf(61);
    if (equals < 1) fail('invalid-pax-record');
    const key = record.subarray(0, equals).toString('ascii');
    if (key === 'path') {
      if (path !== undefined) fail('duplicate-pax-path');
      try { path = fatalUtf8.decode(record.subarray(equals + 1, -1)); }
      catch { fail('invalid-pax-record'); }
    } else if (!['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment'].includes(key))
      fail('unsafe-pax-record');
    offset += length;
  }
  if (path === undefined) fail('missing-pax-path');
  return path;
}
function archivePath(value: string, directory: boolean): string {
  return memberPath(directory && value.endsWith('/') ? value.slice(0, -1) : value);
}
async function download(source: Extract<MaterialRecipeReference['source'], { kind: 'archive' }>,
  deadline: number, signal?: AbortSignal): Promise<Buffer> {
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try { response = await fetch(source.url, { signal: combined, redirect: 'error' }); }
  catch { fail(signal?.aborted ? 'cancelled' : 'archive-download-failed'); }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    fail('archive-download-failed');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) !== source.byteLength)) {
    await response.body.cancel();
    fail('archive-length-mismatch');
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  const hashing = createHash('sha256');
  let length = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch { fail(signal?.aborted ? 'cancelled' : 'archive-download-failed'); }
      if (chunk.done) break;
      if (performance.now() > deadline) fail('acquisition-deadline');
      length += chunk.value.length;
      if (length > source.byteLength || length > MATERIAL_LIMITS.compressedBytes) fail('compressed-byte-limit');
      hashing.update(chunk.value);
      parts.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (length !== source.byteLength || hashing.digest('hex') !== source.sha256) fail('archive-identity-mismatch');
  return Buffer.concat(parts, length);
}
async function readArchive(bytes: Buffer, selected: ReadonlyMap<string, { sha256: string; byteLength: number }>,
  deadline: number, signal?: AbortSignal): Promise<Map<string, Buffer>> {
  const gunzip = createGunzip();
  const input = Readable.from([bytes]);
  input.pipe(gunzip);
  const found = new Map<string, Buffer>();
  const explicit = new Set<string>();
  const kinds = new Map<string, 'file' | 'directory'>();
  const folded = new Map<string, string>();
  let queue = Buffer.alloc(0);
  let state: 'header' | 'body' | 'padding' | 'end' = 'header';
  let current: { path: string; type: string; size: number; mode: number } | undefined;
  let pendingPax: string | undefined;
  let bodyParts: Buffer[] = [];
  let remaining = 0;
  let padding = 0;
  let headers = 0;
  let regular = 0;
  let expanded = 0;
  let zeroHeaders = 0;
  try {
    for await (const part of gunzip) {
      if (signal?.aborted) fail('cancelled');
      if (performance.now() > deadline) fail('acquisition-deadline');
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      expanded += chunk.length;
      if (expanded > MATERIAL_LIMITS.expandedBytes) fail('expanded-byte-limit');
      queue = queue.length ? Buffer.concat([queue, chunk]) : chunk;
      while (queue.length) {
        if (performance.now() > deadline) fail('acquisition-deadline');
        if (state === 'end') {
          if (queue.some(byte => byte !== 0)) fail('trailing-tar-data');
          queue = Buffer.alloc(0);
          break;
        }
        if (state === 'header') {
          if (queue.length < 512) break;
          const header = queue.subarray(0, 512);
          queue = queue.subarray(512);
          if (header.every(byte => byte === 0)) {
            zeroHeaders++;
            if (zeroHeaders === 2) state = 'end';
            continue;
          }
          if (zeroHeaders) fail('invalid-tar-terminator');
          headers++;
          if (headers > MATERIAL_LIMITS.regularMembers * 2) fail('tar-entry-limit');
          current = tarHeader(header);
          if (current.size > MATERIAL_LIMITS.memberBytes) fail('member-byte-limit');
          if (!['0', '5', 'x'].includes(current.type)) fail('unsafe-tar-entry');
          if (current.type === '5' && current.size !== 0) fail('invalid-directory-entry');
          if (current.type === 'x') {
            if (pendingPax !== undefined) fail('duplicate-pax-path');
          } else {
            current.path = archivePath(pendingPax ?? current.path, current.type === '5');
            pendingPax = undefined;
            const segments = current.path.split('/');
            for (let i = 0; i < segments.length; i += 1) {
              const prefix = segments.slice(0, i + 1).join('/');
              const foldedPrefix = prefix.toLocaleLowerCase('en-US');
              const known = folded.get(foldedPrefix);
              if (known !== undefined && known !== prefix) fail('duplicate-tar-target');
              folded.set(foldedPrefix, prefix);
              const leaf = i === segments.length - 1;
              const prior = kinds.get(prefix);
              if (!leaf && prior === 'file') fail('tar-path-overlap');
              if (leaf) {
                if (explicit.has(prefix)) fail('duplicate-tar-target');
                if (prior === 'directory' && current.type !== '5') fail('tar-path-overlap');
                explicit.add(prefix);
                kinds.set(prefix, current.type === '5' ? 'directory' : 'file');
              } else if (prior === undefined) kinds.set(prefix, 'directory');
            }
            if (current.type === '0') {
              regular++;
              if (regular > MATERIAL_LIMITS.regularMembers) fail('regular-member-limit');
              if ((current.mode & 0o111) && !selected.has(current.path)) fail('unreferenced-executable');
            }
          }
          remaining = current.size;
          padding = (512 - (remaining % 512)) % 512;
          bodyParts = [];
          state = remaining ? 'body' : padding ? 'padding' : 'header';
          if (remaining === 0) {
            if (current.type === 'x') fail('missing-pax-path');
            if (current.type === '0' && selected.has(current.path)) found.set(current.path, Buffer.alloc(0));
          }
          continue;
        }
        if (state === 'body') {
          const take = Math.min(remaining, queue.length);
          if (current!.type === 'x' || selected.has(current!.path)) bodyParts.push(Buffer.from(queue.subarray(0, take)));
          queue = queue.subarray(take);
          remaining -= take;
          if (remaining) break;
          const body = Buffer.concat(bodyParts, current!.size);
          if (current!.type === 'x') pendingPax = paxPath(body);
          else if (selected.has(current!.path)) found.set(current!.path, body);
          state = padding ? 'padding' : 'header';
          continue;
        }
        const take = Math.min(padding, queue.length);
        if (queue.subarray(0, take).some(byte => byte !== 0)) fail('invalid-tar-padding');
        queue = queue.subarray(take);
        padding -= take;
        if (padding === 0) state = 'header';
      }
    }
  } catch (error) {
    if (error instanceof MaterialCaptureError) throw error;
    fail('archive-decompression-failed');
  } finally { input.destroy(); gunzip.destroy(); }
  if (state !== 'end' || pendingPax !== undefined || found.size !== selected.size) fail('archive-incomplete');
  for (const [path, pin] of selected) checkBytes(found.get(path), pin.sha256, pin.byteLength, 'member-identity-mismatch');
  return found;
}

/** Captures one reference without installing packages, extracting to a host path, or executing source bytes. */
export async function captureRecipeReference(referenceInput: MaterialRecipeReference,
  materialRoots: Record<string, string> = {}, options: { signal?: AbortSignal; budget?: MaterialCaptureBudget } = {}): Promise<CapturedRecipeReference> {
  const reference = checkedReference(referenceInput);
  if (options.signal?.aborted) fail('cancelled');
  options.budget?.claimReference(reference);
  const deadline = performance.now() + MATERIAL_LIMITS.acquisitionMs;
  const pins = new Map<string, { sha256: string; byteLength: number }>();
  pins.set(reference.path, { sha256: reference.sha256, byteLength: reference.byteLength });
  for (const member of reference.materials) pins.set(member.path, { sha256: member.sha256, byteLength: member.byteLength });
  let captured: Map<string, Buffer>;
  let root: LocalRoot | undefined;
  let identities: Map<string, FileIdentity> | undefined;
  if (reference.source.kind === 'archive') {
    const archive = await download(reference.source, deadline, options.signal);
    captured = await readArchive(archive, pins, deadline, options.signal);
  } else {
    if (!plain(materialRoots) || !Object.hasOwn(materialRoots, reference.source.input)) fail('local-root-unavailable');
    root = localRoot(materialRoots[reference.source.input]);
    captured = new Map(); identities = new Map();
    for (const [path, pin] of pins) {
      if (performance.now() > deadline) fail('acquisition-deadline');
      let file: { bytes: Buffer; identity: FileIdentity };
      try { file = readLocal(root.canonical, path, pin.byteLength, deadline, options.signal); }
      catch (error) { if (error instanceof MaterialCaptureError) throw error; fail('local-file-unavailable'); }
      checkBytes(file.bytes, pin.sha256, pin.byteLength, 'member-identity-mismatch');
      captured.set(path, file.bytes); identities.set(path, file.identity);
    }
    if (!pinsMatch(root.pins)) fail('unsafe-local-root');
  }
  const recipe = checkBytes(captured.get(reference.path), reference.sha256, reference.byteLength, 'recipe-identity-mismatch');
  declaredClosure(recipe, reference.materials);
  const privateBytes = new Map([...captured].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const descriptor = Object.freeze(reference.materials.map(member => Object.freeze({ ...member })));
  return Object.freeze({
    recipeSha256: reference.sha256,
    materials: descriptor,
    readRecipe: () => Buffer.from(privateBytes.get(reference.path)!),
    readMaterial: (id: string) => {
      const member = descriptor.find(item => item.id === id);
      const bytes = member && privateBytes.get(member.path);
      return bytes ? Buffer.from(bytes) : undefined;
    },
    recheck: async () => {
      if (options.signal?.aborted) return false;
      if (root !== undefined && identities !== undefined) {
        if (!pinsMatch(root.pins)) return false;
        const deadline = performance.now() + MATERIAL_LIMITS.acquisitionMs;
        for (const [path, pin] of pins) {
          try {
            const file = readLocal(root.canonical, path, pin.byteLength, deadline, options.signal);
            const identity = identities.get(path)!;
            if (file.identity.dev !== identity.dev || file.identity.ino !== identity.ino ||
                file.identity.size !== identity.size || file.identity.mtimeNs !== identity.mtimeNs ||
                hash(file.bytes) !== pin.sha256) return false;
          } catch { return false; }
        }
        if (!pinsMatch(root.pins)) return false;
      }
      return [...pins].every(([path, pin]) => {
        const bytes = privateBytes.get(path);
        return bytes?.length === pin.byteLength && hash(bytes) === pin.sha256;
      });
    },
  });
}

/** Captures explicit inline member descriptors; no current-directory fallback is permitted. */
export async function captureInlineMaterials(materialsInput: InlineMaterialDescriptor[],
  materialRoots: Record<string, string> = {}, options: { signal?: AbortSignal; budget?: MaterialCaptureBudget } = {}): Promise<CapturedInlineMaterials> {
  if (options.signal?.aborted) fail('cancelled');
  const { materials } = checkedInlineMaterials(materialsInput);
  options.budget?.claimInline(materials);
  const ids = new Set<string>();
  const pathIdentities = new Map<string, string>();
  const archiveSources = new Map<string, { source: Extract<MaterialRecipeReference['source'], { kind: 'archive' }>;
    pins: Map<string, { sha256: string; byteLength: number }> }>();
  const localSources = new Map<string, { root: LocalRoot; pins: Map<string, { sha256: string; byteLength: number }> }>();
  let total = 0;
  for (const [index, item] of materials.entries()) {
    if (ids.has(item.id)) fail('duplicate-material-id');
    if (index > 0 && materials[index - 1]!.id >= item.id) fail('unsorted-materials');
    ids.add(item.id);
    const sourceKey = item.source.kind === 'archive' ? `archive:${item.source.url}` : `local:${item.source.input}`;
    const pathKey = `${sourceKey}\0${item.path}`;
    const identity = `${item.sha256}:${item.byteLength}`;
    const previous = pathIdentities.get(pathKey);
    if (previous !== undefined && previous !== identity) fail('inconsistent-material-path');
    pathIdentities.set(pathKey, identity);
    if (previous === undefined) total += item.byteLength;
    if (total > MATERIAL_LIMITS.capturedBytes) fail('captured-byte-limit');
    if (item.source.kind === 'archive') {
      const group = archiveSources.get(item.source.url);
      if (group && (group.source.sha256 !== item.source.sha256 || group.source.byteLength !== item.source.byteLength))
        fail('inconsistent-archive-source');
      if (group) group.pins.set(item.path, { sha256: item.sha256, byteLength: item.byteLength });
      else archiveSources.set(item.source.url, { source: item.source,
        pins: new Map([[item.path, { sha256: item.sha256, byteLength: item.byteLength }]]) });
    } else {
      if (!plain(materialRoots) || !Object.hasOwn(materialRoots, item.source.input)) fail('local-root-unavailable');
      const group = localSources.get(item.source.input);
      if (group) group.pins.set(item.path, { sha256: item.sha256, byteLength: item.byteLength });
      else localSources.set(item.source.input, { root: localRoot(materialRoots[item.source.input]),
        pins: new Map([[item.path, { sha256: item.sha256, byteLength: item.byteLength }]]) });
    }
  }
  const captured = new Map<string, Buffer>();
  const localProofs: { root: LocalRoot; path: string; pin: { sha256: string; byteLength: number }; identity: FileIdentity }[] = [];
  for (const [url, group] of archiveSources) {
    const deadline = performance.now() + MATERIAL_LIMITS.acquisitionMs;
    const packed = await download(group.source, deadline, options.signal);
    const files = await readArchive(packed, group.pins, deadline, options.signal);
    for (const [path, bytes] of files) captured.set(`archive:${url}\0${path}`, Buffer.from(bytes));
  }
  for (const [input, group] of localSources) {
    const deadline = performance.now() + MATERIAL_LIMITS.acquisitionMs;
    for (const [path, pin] of group.pins) {
      let file: { bytes: Buffer; identity: FileIdentity };
      try { file = readLocal(group.root.canonical, path, pin.byteLength, deadline, options.signal); }
      catch (error) { if (error instanceof MaterialCaptureError) throw error; fail('local-file-unavailable'); }
      checkBytes(file.bytes, pin.sha256, pin.byteLength, 'member-identity-mismatch');
      captured.set(`local:${input}\0${path}`, Buffer.from(file.bytes));
      localProofs.push({ root: group.root, path, pin, identity: file.identity });
    }
    if (!pinsMatch(group.root.pins)) fail('unsafe-local-root');
  }
  const descriptors = Object.freeze(materials.map(({ id, path, sha256, byteLength }) =>
    Object.freeze({ id, path, sha256, byteLength })));
  const keys = new Map(materials.map(item => [item.id,
    `${item.source.kind === 'archive' ? `archive:${item.source.url}` : `local:${item.source.input}`}\0${item.path}`]));
  return Object.freeze({
    materials: descriptors,
    readMaterial: (id: string) => {
      const key = keys.get(id);
      const bytes = key === undefined ? undefined : captured.get(key);
      return bytes ? Buffer.from(bytes) : undefined;
    },
    recheck: async () => {
      if (options.signal?.aborted) return false;
      const deadline = performance.now() + MATERIAL_LIMITS.acquisitionMs;
      for (const proof of localProofs) {
        try {
          if (!pinsMatch(proof.root.pins)) return false;
          const file = readLocal(proof.root.canonical, proof.path, proof.pin.byteLength, deadline, options.signal);
          if (file.identity.dev !== proof.identity.dev || file.identity.ino !== proof.identity.ino ||
              file.identity.size !== proof.identity.size || file.identity.mtimeNs !== proof.identity.mtimeNs ||
              hash(file.bytes) !== proof.pin.sha256) return false;
        } catch { return false; }
      }
      if (localProofs.some(proof => !pinsMatch(proof.root.pins))) return false;
      return materials.every(item => {
        const key = keys.get(item.id)!;
        const bytes = captured.get(key);
        return bytes?.length === item.byteLength && hash(bytes) === item.sha256;
      });
    },
  });
}
