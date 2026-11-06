// Which planned steps make a client start a program later (contract 7): an MCP server entry a client launches, a hook, a
// settings key that runs a command, or a file written executable. The review marks each one with a fixed label and shows
// the programs and arguments it configures, or the written bytes' sha256 and whether the file is made executable.
import { createHash } from 'node:crypto';
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
/** A written file's label: made executable, or JSON settings that run commands; with the bytes' sha256 either way. */
export function writeConfiguration(path: string, bytes: Buffer, executable: boolean, hide: (text: string) => string = text => text): ExecutableConfiguration | undefined {
  let launches: Launch[] = []; let hooks = false;
  if (/\.json$/i.test(path) && bytes.length <= 1_048_576) {
    try { const parsed = JSON.parse(bytes.toString('utf8')) as Json; launches = shown(launchesIn(parsed), hide); hooks = mentionsHooks([], parsed); } catch { /* not JSON settings */ }
  }
  if (!executable && !launches.length) return undefined;
  return { label: 'executable-configuration', kind: executable ? 'executable-file' : hooks ? 'hook' : 'settings-command', launches,
    sha256: createHash('sha256').update(bytes).digest('hex'), executable };
}
