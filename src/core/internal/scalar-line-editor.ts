import { decode, fail, type ConfigEntry } from './recipe-editors.js';

type Format = 'yaml' | 'properties';
interface Row { start: number; end: number; valueStart: number; valueEnd: number; value: string }
function keyOf(path: string[]) {
  if (path.length !== 1 || !/^[A-Za-z0-9_.-]+$/u.test(path[0]!)) fail('unsupported-scalar-path');
  return path[0]!;
}
function yamlScalar(value: string): void {
  if (!value) return;
  if (value.startsWith('"')) {
    try { if (typeof JSON.parse(value) !== 'string') fail('unsupported-scalar-syntax'); }
    catch { fail('unsupported-scalar-syntax'); }
  } else if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/u.test(value)) fail('unsupported-scalar-syntax');
  } else if (/^[\[\]{},&*!|>%@`?]|[&*!]|:[ \t]/u.test(value)) fail('unsupported-scalar-syntax');
}
function parse(format: Format, before: Buffer | null) {
  const text = decode(before); const rows = new Map<string, Row>();
  if (before?.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || text.includes('\0') || /\r(?!\n)/u.test(text)) fail('unsupported-scalar-syntax');
  let offset = 0; let previous: string | undefined;
  for (const match of text.matchAll(/([^\r\n]*)(\r\n|\n|$)/gu)) {
    if (!match[0]) break;
    const row = match[1]!; const end = offset + match[0].length;
    if (!row.trim() || (format === 'yaml' ? /^\s*#/u : /^\s*[#!]/u).test(row)) { offset = end; continue; }
    if (format === 'yaml' && /^[ \t]/u.test(row)) {
      if (!previous || /\t/u.test(row)) fail('unsupported-scalar-syntax');
      const nested = /^[ ]+(?:-[ ]+|[A-Za-z0-9_.-]+[ ]*:[ ]*)(.*)$/u.exec(row);
      if (!nested) fail('unsupported-scalar-syntax');
      yamlScalar(nested[1]!.trimEnd());
      rows.get(previous)!.value += '\n' + row; offset = end; continue;
    }
    const found = (format === 'yaml' ? /^([A-Za-z0-9_.-]+)([ \t]*:[ \t]*)(.*)$/u : /^[ \t]*([A-Za-z0-9_.-]+)([ \t]*=[ \t]*)(.*)$/u).exec(row);
    if (!found || format === 'properties' && (row.match(/\\+$/u)?.[0].length ?? 0) % 2 || format === 'yaml' && /[&*!]|^<<\s*:/u.test(row)) fail('unsupported-scalar-syntax');
    const key = found[1]!; if (rows.has(key)) fail('duplicate-scalar-key');
    const valueStart = offset + row.indexOf(key) + key.length + found[2]!.length;
    const value = found[3]!.trimEnd();
    if (format === 'yaml') yamlScalar(value);
    rows.set(key, { start: offset, end, valueStart, valueEnd: valueStart + value.length, value });
    previous = key;
    offset = end;
  }
  return { text, rows };
}
function scalar(format: Format, value: string) {
  if (!value || /[\r\n\0]/u.test(value) || format === 'properties' && /\\/u.test(value) || format === 'yaml' && /^[|>\[\]{},&*!]/u.test(value)) fail('unsupported-scalar-value');
  if (format === 'yaml' && value.startsWith('"')) { try { if (typeof JSON.parse(value) !== 'string') fail('unsupported-scalar-value'); } catch { fail('unsupported-scalar-value'); } }
  return Buffer.from(value);
}
export function scalarLineMember(format: Format, before: Buffer | null, path: string[]): Buffer | null {
  const member = parse(format, before).rows.get(keyOf(path));
  return member ? scalar(format, member.value) : null;
}
export function editScalarLines(format: Format, before: Buffer | null, entries: ConfigEntry[]): Buffer {
  let { text } = parse(format, before); const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const entry of entries) {
    const key = keyOf(entry.path); const current = parse(format, Buffer.from(text)).rows.get(key);
    if (current) scalar(format, current.value);
    if (entry.action === 'remove') { if (current) text = text.slice(0, current.start) + text.slice(current.end); continue; }
    if (typeof entry.value !== 'string' || !entry.value || entry.value.trim() !== entry.value || /[\r\n\0]/u.test(entry.value) || format === 'properties' && /\\/u.test(entry.value)) fail('unsupported-scalar-value');
    const value = format === 'yaml' ? JSON.stringify(entry.value) : entry.value;
    if (current) text = text.slice(0, current.valueStart) + value + text.slice(current.valueEnd);
    else text += `${text && !text.endsWith('\n') ? eol : ''}${key}${format === 'yaml' ? ': ' : '='}${value}${eol}`;
  }
  return Buffer.from(text);
}
