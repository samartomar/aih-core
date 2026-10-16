import type { Json } from '../types.js';
import { decode, fail, type ConfigEntry } from './recipe-editors.js';

/** Array and inline-table nesting accepted by the scanner; above what the renderer can produce. */
const maxDepth = 64;
interface Value { start: number; end: number; kind: 'array' | 'inline' | 'other'; items: Value[] }
interface Assignment { start: number; end: number; valueStart: number; valueEnd: number; value: Value }
interface Table { segments: string[]; first: number; last: number }
interface Parsed { text: string; tables: Map<string, Table>; assignments: Map<string, Assignment> }

const bare = /^[A-Za-z0-9_-]+$/u;
const bareKey = /[A-Za-z0-9_-]+/uy;
const timestamp = /(?:\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?![A-Za-z0-9_.+:-])/uy;
const token = /(?:true|false|[+-]?(?:inf|nan)|[+-]?0x[0-9A-Fa-f_]+|[+-]?0o[0-7_]+|[+-]?0b[01_]+|[+-]?[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)(?![A-Za-z0-9_.+:-])/uy;
const identity = (segments: string[]): string => JSON.stringify(segments);
const startsWith = (path: string[], prefix: string[]): boolean =>
  path.length >= prefix.length && prefix.every((part, i) => part === path[i]);
const malformed = (value: string): boolean => /\p{Cs}/u.test(value);
const escapes: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

function tomlScalarSyntax(value: string): boolean {
  return /^(?:"(?:[^"\\\r\n]|\\["\\btnfr]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8})*"|'[^'\r\n]*'|true|false|[+-]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)$/u.test(value);
}
/** Scalars the editor owns, and arrays whose elements are all owned. */
function managed(text: string, value: Value): boolean {
  if (value.kind === 'array') return value.items.every(item => managed(text, item));
  return value.kind === 'other' && tomlScalarSyntax(text.slice(value.start, value.end));
}

const control = (code: number): boolean => code < 0x20 && code !== 0x09 || code === 0x7f;
const newlineAt = (text: string, at: number): number =>
  text.startsWith('\r\n', at) ? 2 : text[at] === '\n' || text[at] === '\r' ? 1 : 0;
function skipBlank(text: string, at: number): number {
  while (text[at] === ' ' || text[at] === '\t') at += 1;
  return at;
}
function skipComment(text: string, at: number): number {
  if (text[at] !== '#') return at;
  while (at < text.length && text[at] !== '\n' && text[at] !== '\r') at += 1;
  return at;
}
/** Whitespace, newlines and comments between array elements. */
function skipFiller(text: string, at: number): number {
  for (;;) {
    const next = skipComment(text, skipBlank(text, at));
    const eol = newlineAt(text, next);
    if (!eol) return next;
    at = next + eol;
  }
}

function basicString(text: string, at: number): { value: string; end: number } | null {
  let value = '';
  for (let i = at + 1; i < text.length;) {
    const char = text[i]!;
    if (char === '"') return { value, end: i + 1 };
    if (char === '\\') {
      const next = text[i + 1];
      const width = next === 'u' ? 4 : next === 'U' ? 8 : 0;
      if (width) {
        const digits = text.slice(i + 2, i + 2 + width);
        const code = digits.length === width && /^[0-9a-fA-F]+$/u.test(digits) ? parseInt(digits, 16) : -1;
        if (code < 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) return null;
        value += String.fromCodePoint(code);
        i += 2 + width;
      } else if (next !== undefined && Object.hasOwn(escapes, next)) { value += escapes[next]; i += 2; }
      else return null;
    } else if (control(char.charCodeAt(0))) return null;
    else { value += char; i += 1; }
  }
  return null;
}
function literalString(text: string, at: number): { value: string; end: number } | null {
  const close = text.indexOf("'", at + 1);
  if (close < 0) return null;
  const value = text.slice(at + 1, close);
  return [...value].some(char => control(char.charCodeAt(0))) ? null : { value, end: close + 1 };
}
function key(text: string, at: number): { value: string; end: number } | null {
  if (text[at] === '"') return basicString(text, at);
  if (text[at] === "'") return literalString(text, at);
  bareKey.lastIndex = at;
  const match = bareKey.exec(text);
  return match ? { value: match[0], end: at + match[0].length } : null;
}
function multiline(text: string, at: number, quote: string, escaped: boolean): number {
  const close = quote.repeat(3);
  for (let i = at + 3; i < text.length;) {
    const char = text[i]!;
    if (escaped && char === '\\') { i += 2; continue; }
    if (text.startsWith(close, i)) {
      let end = i + 3;
      while (end < i + 5 && text[end] === quote) end += 1;
      return end;
    }
    const code = char.charCodeAt(0);
    if (code !== 0x0a && code !== 0x0d && control(code)) fail('unsupported-toml-syntax');
    i += 1;
  }
  return fail('unsupported-toml-syntax');
}
function value(text: string, at: number, depth: number): Value {
  const syntax = (): never => fail('unsupported-toml-syntax');
  const char = text[at];
  const other = (end: number): Value => ({ start: at, end, kind: 'other', items: [] });
  if (char === '"' || char === "'") {
    if (text.startsWith(char.repeat(3), at)) return other(multiline(text, at, char, char === '"'));
    const string = char === '"' ? basicString(text, at) : literalString(text, at);
    return string ? other(string.end) : syntax();
  }
  if (char === '[') {
    if (depth >= maxDepth) syntax();
    const items: Value[] = [];
    let i = skipFiller(text, at + 1);
    while (text[i] !== ']') {
      const item = value(text, i, depth + 1);
      items.push(item);
      i = skipFiller(text, item.end);
      if (text[i] === ',') i = skipFiller(text, i + 1);
      else if (text[i] !== ']') syntax();
    }
    return { start: at, end: i + 1, kind: 'array', items };
  }
  if (char === '{') {
    if (depth >= maxDepth) syntax();
    let i = skipBlank(text, at + 1);
    if (text[i] === '}') return { start: at, end: i + 1, kind: 'inline', items: [] };
    for (;;) {
      for (;;) {
        const name = key(text, i);
        if (!name) syntax();
        i = skipBlank(text, name!.end);
        if (text[i] !== '.') break;
        i = skipBlank(text, i + 1);
      }
      if (text[i] !== '=') syntax();
      const item = value(text, skipBlank(text, i + 1), depth + 1);
      i = skipBlank(text, item.end);
      if (text[i] === '}') return { start: at, end: i + 1, kind: 'inline', items: [] };
      if (text[i] !== ',') syntax();
      i = skipBlank(text, i + 1);
    }
  }
  for (const pattern of [timestamp, token]) {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (match) return other(at + match[0].length);
  }
  return syntax();
}

function parse(text: string): Parsed {
  const tables = new Map<string, Table>();
  const assignments = new Map<string, Assignment>();
  const headers: Table[] = [];
  let current: string[] = [];
  let at = 0;
  while (at < text.length) {
    const lineStart = at;
    let i = skipBlank(text, at);
    const line = (stop: number): number => {
      const end = skipComment(text, skipBlank(text, stop));
      const eol = newlineAt(text, end);
      return end < text.length && !eol ? -1 : end + eol;
    };
    if (text[i] === '[') {
      if (text[i + 1] === '[') fail('unsupported-toml-array-table');
      const segments: string[] = [];
      i += 1;
      for (;;) {
        i = skipBlank(text, i);
        const name = key(text, i);
        if (!name) fail('unsupported-toml-table');
        segments.push(name!.value);
        i = skipBlank(text, name!.end);
        if (text[i] !== '.') break;
        i += 1;
      }
      if (text[i] !== ']') fail('unsupported-toml-table');
      const next = line(i + 1);
      const id = identity(segments);
      if (next < 0 || tables.has(id)) fail('unsupported-toml-table');
      const table = { segments, first: lineStart, last: text.length };
      tables.set(id, table);
      headers.push(table);
      current = segments;
      at = next;
    } else if (i >= text.length || text[i] === '#' || newlineAt(text, i)) {
      const next = line(i);
      if (next < 0) fail('unsupported-toml-syntax');
      at = next;
    } else {
      const name = key(text, i);
      if (!name) fail('unsupported-toml-syntax');
      i = skipBlank(text, name!.end);
      if (text[i] !== '=') fail('unsupported-toml-syntax');
      const valueStart = skipBlank(text, i + 1);
      const parsed = value(text, valueStart, 0);
      const next = line(parsed.end);
      if (next < 0) fail('unsupported-toml-syntax');
      const id = identity([...current, name!.value]);
      if (assignments.has(id)) fail('duplicate-toml-key');
      assignments.set(id, { start: lineStart, end: next, valueStart, valueEnd: parsed.end, value: parsed });
      at = next;
    }
  }
  headers.forEach((table, index) => { table.last = headers[index + 1]?.first ?? text.length; });
  tables.set(identity([]), { segments: [], first: 0, last: headers[0]?.first ?? text.length });
  for (const id of assignments.keys()) {
    const path = JSON.parse(id) as string[];
    for (const table of tables.values()) if (table.segments.length && startsWith(table.segments, path)) fail('unsupported-toml-path');
  }
  return { text, tables, assignments };
}

function basic(text: string): string {
  return JSON.stringify(text).replaceAll('\x7f', '\\u007F');
}
function render(item: Json): string {
  if (typeof item === 'string') {
    if (malformed(item)) fail('unsupported-toml-value');
    return basic(item);
  }
  if (typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return String(item);
  if (Array.isArray(item)) return `[${item.map(render).join(', ')}]`;
  return fail('unsupported-toml-value');
}
function renderKey(segment: string): string {
  return bare.test(segment) ? segment : basic(segment);
}

export function tomlMember(before: Buffer | null, path: string[]): Buffer | null {
  if (before === null) return null;
  const text = decode(before);
  const member = parse(text).assignments.get(identity(path));
  if (!member) return null;
  if (!managed(text, member.value)) fail('unsupported-toml-value');
  return Buffer.from(text.slice(member.valueStart, member.valueEnd));
}
export function editToml(before: Buffer | null, entries: ConfigEntry[]): Buffer {
  let text = decode(before);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const entry of entries) {
    if (entry.path.some(malformed)) fail('unsupported-toml-path');
    const parsed = parse(text);
    const tableSegments = entry.path.slice(0, -1);
    const name = entry.path.at(-1)!;
    if ([...parsed.tables.values()].some(table => table.segments.length && startsWith(table.segments, entry.path)))
      fail('unsupported-toml-path');
    const current = parsed.assignments.get(identity(entry.path));
    if (current && !managed(text, current.value)) fail('unsupported-toml-value');
    if (entry.action === 'remove') {
      if (current) text = text.slice(0, current.start) + text.slice(current.end);
      continue;
    }
    const rendered = render(entry.value!);
    if (current) {
      text = text.slice(0, current.valueStart) + rendered + text.slice(current.valueEnd);
      continue;
    }
    if (tableSegments.some((_, i) => parsed.assignments.has(identity(tableSegments.slice(0, i + 1)))) ||
        [...parsed.assignments.keys()].some(id => {
          const path = JSON.parse(id) as string[];
          return path.length > entry.path.length && startsWith(path, entry.path);
        })) fail('unsupported-toml-path');
    const region = parsed.tables.get(identity(tableSegments));
    if (region) {
      const prefix = region.last > 0 && !/[\r\n]$/u.test(text.slice(0, region.last)) ? eol : '';
      text = text.slice(0, region.last) + `${prefix}${renderKey(name)} = ${rendered}${eol}` + text.slice(region.last);
    } else {
      const separator = text && !/[\r\n]$/u.test(text) ? eol : '';
      text += `${separator}[${tableSegments.map(renderKey).join('.')}]${eol}${renderKey(name)} = ${rendered}${eol}`;
    }
  }
  parse(text);
  return Buffer.from(text, 'utf8');
}
