// Which planned steps make a client start a program later (contract 7): an MCP server entry a client launches, a hook, a
// settings key that runs a command, or a file written executable. The review marks each one with a fixed label and shows
// the programs and arguments it configures, or the written bytes' sha256 and whether the file is made executable.
import { createHash } from 'node:crypto';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import type { Json } from '../../types.js';
import type { ExecutableConfiguration } from '../types.js';

type Launch = ExecutableConfiguration['launches'][number];
const plain = (value: Json | undefined): value is { [key: string]: Json } => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: Json | undefined): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
/** Settings keys a client runs as a command (beside `command` itself). */
const COMMAND_KEYS = new Set(['apikeyhelper', 'awsauthrefresh', 'awscredentialexport', 'otelheadershelper', 'notify', 'statuscommand']);

/** Every program a JSON value configures: each `command` (with its `args`, or an argv list) and each command-running key. */
export function launchesIn(value: Json | undefined): Launch[] {
  const found: Launch[] = [];
  const walk = (node: Json | undefined, depth: number): void => {
    if (depth > 32) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (!plain(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'command' && typeof child === 'string' && child) found.push({ command: child, args: strings(node.args) ? [...node.args] : [] });
      else if (key === 'command' && strings(child) && child.length) found.push({ command: child[0]!, args: child.slice(1) });
      else if (COMMAND_KEYS.has(key.toLowerCase()) && typeof child === 'string' && child) found.push({ command: child, args: [] });
      else if (COMMAND_KEYS.has(key.toLowerCase()) && strings(child) && child.length) found.push({ command: child[0]!, args: child.slice(1) });
      else if (key !== 'args' && key !== 'env' && key !== 'environment') walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return found;
}
/** Launches as the review shows them: a secret value in a command or argument reads `[REDACTED]`. */
const shown = (launches: Launch[], hide: (text: string) => string): Launch[] => launches.map(launch => ({ command: hide(launch.command), args: launch.args.map(hide) }));
const mentionsHooks = (segments: string[], value: Json | undefined): boolean =>
  segments.some(segment => segment.toLowerCase() === 'hooks') || plain(value) && Object.keys(value).some(key => key.toLowerCase() === 'hooks');

/** A JSON or TOML merge entry's label: an MCP server it starts, a hook, or a settings command; `undefined` when it starts none. */
export function mergeConfiguration(segments: string[], entry: Json, hide: (text: string) => string = text => text): ExecutableConfiguration | undefined {
  const launches = shown(launchesIn(entry), hide);
  if (!launches.length) return undefined;
  const mcp = segments.some(segment => /^(mcpservers|mcp_servers|mcp|servers|context_servers)$/i.test(segment));
  const kind = mentionsHooks(segments, entry) ? 'hook' : mcp ? 'mcp-server' : 'settings-command';
  return { label: 'executable-configuration', kind, launches };
}
const quoted = (value: string): string[] => [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(match => match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2]!);
const commandKey = (key: string): boolean => key.toLowerCase() === 'command' || COMMAND_KEYS.has(key.toLowerCase());
/** TOML settings, read line by line: each table's `command` with its `args`, and every command-running key. */
function tomlLaunches(text: string): { launches: Launch[]; hooks: boolean } {
  const launches: Launch[] = []; let hooks = false; let current: Launch | undefined;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) { current = undefined; if (header[1]!.split('.').some(part => part.replace(/["']/g, '').toLowerCase() === 'hooks')) hooks = true; continue; }
    const assignment = /^\s*([A-Za-z0-9_."'-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) continue;
    const key = assignment[1]!.split('.').at(-1)!.replace(/["']/g, '');
    const values = quoted(assignment[2]!);
    if (key.toLowerCase() === 'hooks') hooks = true;
    if (key === 'args' && current) current.args = values;
    else if (commandKey(key) && values.length) {
      current = { command: values[0]!, args: assignment[2]!.trim().startsWith('[') ? values.slice(1) : [] };
      launches.push(current);
    }
  }
  return { launches, hooks };
}
/** YAML settings, read line by line: every `command` and command-running key, with a flow-list `args` beside it. */
function yamlLaunches(text: string): { launches: Launch[]; hooks: boolean } {
  const launches: Launch[] = []; let hooks = false; let current: Launch | undefined;
  for (const line of text.split(/\r?\n/)) {
    const pair = /^\s*(?:-\s+)?([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, raw] = pair as unknown as [string, string, string];
    const value = raw.replace(/\s+#.*$/, '').trim();
    if (key.toLowerCase() === 'hooks') hooks = true;
    if (key === 'args' && current) { current.args = value.startsWith('[') ? value.slice(1, -1).split(',').map(part => part.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []; continue; }
    if (!commandKey(key) || !value) continue;
    const list = value.startsWith('[') ? value.slice(1, -1).split(',').map(part => part.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [value.replace(/^["']|["']$/g, '')];
    if (!list.length) continue;
    current = { command: list[0]!, args: list.slice(1) };
    launches.push(current);
  }
  return { launches, hooks };
}
/** The programs a written text configures, read by its content: JSON (comments, a BOM, trailing commas allowed), else TOML, else YAML. */
function textLaunches(bytes: Buffer): { launches: Launch[]; hooks: boolean } {
  if (bytes.length > 1_048_576) return { launches: [], hooks: false };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); } catch { return { launches: [], hooks: false }; }
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false }) as Json;
  if (!errors.length && parsed !== null && typeof parsed === 'object') return { launches: launchesIn(parsed), hooks: mentionsHooks([], parsed) };
  const toml = tomlLaunches(text);
  if (toml.launches.length) return toml;
  const yaml = yamlLaunches(text);
  return yaml.launches.length ? yaml : { launches: [], hooks: false };
}
/** A written file's label: made executable, or settings (in any format) that run commands; with the bytes' sha256 either way. */
export function writeConfiguration(path: string, bytes: Buffer, executable: boolean, hide: (text: string) => string = text => text): ExecutableConfiguration | undefined {
  const read = textLaunches(bytes);
  const launches = shown(read.launches, hide); const hooks = read.hooks;
  if (!executable && !launches.length) return undefined;
  return { label: 'executable-configuration', kind: executable ? 'executable-file' : hooks ? 'hook' : 'settings-command', launches,
    sha256: createHash('sha256').update(bytes).digest('hex'), executable };
}
