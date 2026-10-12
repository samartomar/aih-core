import { decode, fail, type ConfigEntry } from './recipe-editors.js';

interface Assignment { start: number; end: number; valueStart: number; valueEnd: number; value: string }
const name = /^[A-Za-z0-9_.-]+$/u;
const identity = (section: string, key: string) => `${section}\0${key.toLowerCase()}`;
function parse(text: string) {
  const sections = new Map<string, number>();
  const assignments = new Map<string, Assignment>();
  let section: string | undefined; let offset = 0; let previous: string | undefined; let previousIndent = 0;
  for (const match of text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/gu)) {
    const row = match[1]!; const end = offset + match[0].length;
    if (!match[0]) break;
    if (!row.trim() || /^[ \t]*[#;]/u.test(row)) { offset = end; continue; }
    const header = /^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:[#;].*)?$/u.exec(row);
    if (header) {
      if (sections.has(header[1]!)) fail('duplicate-ini-section');
      section = header[1]!; sections.set(section, end); previous = undefined;
    } else if (previous && (row.match(/^[ \t]*/u)?.[0].length ?? 0) > previousIndent) {
      // Continuations of unrelated options are retained verbatim. A selected
      // option with a continuation is deliberately not an editable scalar.
      if (/^[ \t]+[A-Za-z0-9_.-]+[ \t]*(?:=|:(?!\/\/))/u.test(row)) fail('unsupported-ini-syntax');
      assignments.get(previous)!.value += '\n' + row;
    } else {
      const entry = /^[ \t]*([A-Za-z0-9_.-]+)([ \t]*[=:][ \t]*)(.*)$/u.exec(row);
      if (!entry || section === undefined) fail('unsupported-ini-syntax');
      const key = identity(section, entry[1]!);
      if (assignments.has(key)) fail('duplicate-ini-key');
      const valueStart = offset + row.indexOf(entry[1]!) + entry[1]!.length + entry[2]!.length;
      const value = entry[3]!.trimEnd();
      assignments.set(key, { start: offset, end, valueStart, valueEnd: valueStart + value.length, value });
      previous = key;
      previousIndent = row.match(/^[ \t]*/u)![0].length;
    }
    offset = end;
  }
  return { sections, assignments };
}
function selected(path: string[]): string {
  if (path.length !== 2 || path.some(part => !name.test(part))) fail('unsupported-ini-path');
  return identity(path[0]!, path[1]!);
}
export function iniMember(before: Buffer | null, path: string[]): Buffer | null {
  if (before?.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || before?.includes(0)) fail('unsupported-ini-syntax');
  const key = selected(path); const member = parse(decode(before)).assignments.get(key);
  if (!member) return null;
  if (/[\r\n\0]/u.test(member.value)) fail('unsupported-ini-value');
  return Buffer.from(member.value);
}
export function editIni(before: Buffer | null, entries: ConfigEntry[]): Buffer {
  let text = decode(before);
  if (before?.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || text.includes('\0')) fail('unsupported-ini-syntax');
  const eol = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
  const selectedKeys = new Set<string>();
  for (const entry of entries) {
    const key = selected(entry.path);
    if (selectedKeys.has(key)) fail('overlapping-entry-paths');
    selectedKeys.add(key);
    const parsed = parse(text); const current = parsed.assignments.get(key);
    if (current && /[\r\n\0]/u.test(current.value)) fail('unsupported-ini-value');
    if (entry.action === 'remove') {
      if (current) text = text.slice(0, current.start) + text.slice(current.end);
      continue;
    }
    if (typeof entry.value !== 'string' || !entry.value || entry.value !== entry.value.trim() || /[\r\n\0]/u.test(entry.value)) fail('unsupported-ini-value');
    if (current) text = text.slice(0, current.valueStart) + entry.value + text.slice(current.valueEnd);
    else {
      const section = entry.path[0]!;
      const at = parsed.sections.get(section);
      const body = at === undefined ? '' : text.slice(at).split(/^[ \t]*\[/mu)[0]!;
      const indent = /^([ \t]*)[A-Za-z0-9_.-]+[ \t]*[=:]/mu.exec(body)?.[1] ?? '';
      const row = `${indent}${entry.path[1]}=${entry.value}${eol}`;
      if (at === undefined) text += `${text && !/[\r\n]$/u.test(text) ? eol : ''}[${section}]${eol}${row}`;
      else text = text.slice(0, at) + (at === text.length && !/[\r\n]$/u.test(text) ? eol : '') + row + text.slice(at);
    }
  }
  return Buffer.from(text);
}
