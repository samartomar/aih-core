// Bounded readers for acquired archives (`.tar.gz`/`.tgz` and `.zip`): member count, expanded bytes and paths are
// checked before anything is written. A path that is absolute, has `..`, `.` or empty segments, or a backslash is
// refused (`archive-invalid`); so is a link whose target would leave the archive.
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { limitValue } from '../limits.js';
import { AcquireError } from './download.js';

export interface ArchiveEntry { path: string; type: 'file' | 'directory' | 'symlink' | 'hardlink'; mode: number; data?: Buffer; target?: string }
const fail = (): never => { throw new AcquireError('archive-invalid'); };

export function memberPath(value: string): string {
  const path = value.replace(/^\.\//, '').replace(/\/+$/, '');
  const segments = path.split('/');
  if (!path || path.length > 4096 || path.startsWith('/') || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path) ||
      segments.some(segment => segment === '' || segment === '.' || segment === '..')) fail();
  return path;
}
/** Whether a link at `path` pointing to `target` stays inside the archive root. */
export function linkInside(path: string, target: string): boolean {
  if (target.startsWith('/') || target.includes('\\') || /^[A-Za-z]:/.test(target)) return false;
  const parts = path.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') { if (!parts.length) return false; parts.pop(); }
    else if (segment && segment !== '.') parts.push(segment);
  }
  return true;
}
export function readArchive(bytes: Buffer, file: string): ArchiveEntry[] {
  if (/\.zip$/i.test(file)) return linksContained(readZip(bytes));
  if (/\.(tar\.gz|tgz)$/i.test(file)) return linksContained(readTar(bytes));
  throw new AcquireError('archive-unsupported');
}
/**
 * Links stay inside the archive on disk, not only by their own text: no member lies under a link, and no link's target
 * leads through or onto another link, so a chain of links each lexically inside can never leave the root.
 */
function linksContained(entries: ArchiveEntry[]): ArchiveEntry[] {
  const fold = (path: string) => path.toLowerCase();
  const links = new Set(entries.filter(entry => entry.type === 'symlink').map(entry => fold(entry.path)));
  if (!links.size) return entries;
  const throughLink = (path: string, self: boolean): boolean => {
    const segments = path.split('/');
    for (let length = 1; length < segments.length + (self ? 1 : 0); length++) if (links.has(fold(segments.slice(0, length).join('/')))) return true;
    return false;
  };
  for (const entry of entries) {
    if (throughLink(entry.path, false)) fail();
    if (entry.type !== 'symlink') continue;
    const parts = entry.path.split('/').slice(0, -1);
    for (const segment of entry.target!.split('/')) {
      if (segment === '..') parts.pop(); else if (segment && segment !== '.') parts.push(segment);
    }
    if (parts.length && throughLink(parts.join('/'), true)) fail();
  }
  return entries;
}
function bounded(entries: ArchiveEntry[], size: number): void {
  if (entries.length > limitValue('artifact-members') || size > limitValue('artifact-expanded-bytes')) throw new AcquireError('limit-exceeded');
}
const field = (header: Buffer, start: number, length: number): string => {
  const slice = header.subarray(start, start + length); const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? length : end).toString('utf8');
};
const octal = (header: Buffer, start: number, length: number): number => {
  const text = field(header, start, length).trim();
  if (!/^[0-7]*$/.test(text)) fail();
  return text ? parseInt(text, 8) : 0;
};
function readTar(compressed: Buffer): ArchiveEntry[] {
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: limitValue('artifact-expanded-bytes') }); } catch { throw new AcquireError('archive-invalid'); }
  const entries: ArchiveEntry[] = []; let offset = 0; let longName: string | undefined; let paxPath: string | undefined; let paxLink: string | undefined; let longLink: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = octal(header, 124, 12); const type = String.fromCharCode(header[156]!) || '0';
    const start = offset + 512; const end = start + size;
    if (end > tar.length) fail();
    const data = tar.subarray(start, end);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = field(data, 0, data.length); continue; }
    if (type === 'K') { longLink = field(data, 0, data.length); continue; }
    if (type === 'x') {
      for (let at = 0; at < data.length;) {
        const space = data.indexOf(0x20, at); if (space < 0) fail();
        const length = Number(data.subarray(at, space).toString()); if (!Number.isSafeInteger(length) || length <= 0) fail();
        const record = data.subarray(space + 1, at + length - 1).toString('utf8'); const equals = record.indexOf('=');
        if (record.slice(0, equals) === 'path') paxPath = record.slice(equals + 1);
        if (record.slice(0, equals) === 'linkpath') paxLink = record.slice(equals + 1);
        at += length;
      }
      continue;
    }
    if (type === 'g') continue;
    const prefix = field(header, 345, 155);
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const link = paxLink ?? longLink ?? field(header, 157, 100);
    paxPath = longName = paxLink = longLink = undefined;
    const mode = octal(header, 100, 8) & 0o777;
    if (name === './' || name === '.') continue;
    const path = memberPath(name);
    if (type === '0' || type === '\0' || type === '7') entries.push({ path, type: 'file', mode, data: Buffer.from(data) });
    else if (type === '5') entries.push({ path, type: 'directory', mode });
    else if (type === '2') { if (!linkInside(path, link)) fail(); entries.push({ path, type: 'symlink', mode, target: link }); }
    else if (type === '1') entries.push({ path, type: 'hardlink', mode, target: memberPath(link) });
    else fail();
    bounded(entries, tar.length);
  }
  return entries;
}
function readZip(zip: Buffer): ArchiveEntry[] {
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65_557); at--) if (zip.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  if (end < 0) fail();
  const count = zip.readUInt16LE(end + 10); let at = zip.readUInt32LE(end + 16);
  const entries: ArchiveEntry[] = []; let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) fail();
    const method = zip.readUInt16LE(at + 10); const compressedSize = zip.readUInt32LE(at + 20); const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28); const extra = zip.readUInt16LE(at + 30); const comment = zip.readUInt16LE(at + 32);
    const external = zip.readUInt32LE(at + 38); const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extra + comment;
    const unixMode = (external >>> 16) & 0o777;
    if (name.endsWith('/')) { entries.push({ path: memberPath(name), type: 'directory', mode: unixMode || 0o755 }); continue; }
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) fail();
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    if (raw.length !== compressedSize) fail();
    expanded += size; if (expanded > limitValue('artifact-expanded-bytes')) throw new AcquireError('limit-exceeded');
    let data: Buffer;
    try { data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: size }) : fail(); }
    catch (error) { if (error instanceof AcquireError) throw error; throw new AcquireError('archive-invalid'); }
    if (data.length !== size) fail();
    entries.push({ path: memberPath(name), type: 'file', mode: unixMode || 0o644, data });
    bounded(entries, expanded);
  }
  return entries;
}
