// Which planned steps make a client start a program later (contract 7): an MCP server entry a client launches, a hook, a
// settings key that runs a command, or a file written executable. The review marks each one with a fixed label and shows
// the programs and arguments it configures, or the written bytes' sha256 and whether the file is made executable.
import { createHash } from 'node:crypto';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import type { Json } from '../../types.js';
import type { ExecutableConfiguration } from '../types.js';
import { isLoaderVariable } from '../inputs.js';

type Launch = ExecutableConfiguration['launches'][number];
const plain = (value: Json | undefined): value is { [key: string]: Json } => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: Json | undefined): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
/** Settings keys a client runs as a command (beside `command` itself). */
const COMMAND_KEYS = new Set(['apikeyhelper', 'awsauthrefresh', 'awscredentialexport', 'otelheadershelper', 'notify', 'statuscommand',
  // Copilot's hooks run a `bash` or `powershell` command; Gemini CLI runs its tools' discovery and call commands.
  'bash', 'powershell', 'discoverycommand', 'callcommand']);
/**
 * Environment names a client itself acts on to run a program, beyond the loader list: Claude Code wraps every Bash
 * command in `CLAUDE_CODE_SHELL_PREFIX` and sources `CLAUDE_ENV_FILE` before it. Setting one is executable configuration.
 */
const CLIENT_EXEC_ENV = new Set(['CLAUDE_CODE_SHELL_PREFIX', 'CLAUDE_ENV_FILE', 'CLAUDE_CODE_GIT_BASH_PATH']);
const runsCode = (name: string): boolean => isLoaderVariable(name) || CLIENT_EXEC_ENV.has(name.toUpperCase());
/**
 * Whether a parsed settings value sets, in an environment at any depth, a loader or search variable or a name a client
 * runs a program by. Environments are `env`, `environment`, and Codex's `shell_environment_policy.set`.
 */
function setsLoader(value: Json | undefined, depth = 0, parent = ''): boolean {
  if (depth > 32) return false;
  if (Array.isArray(value)) return value.some(item => setsLoader(item, depth + 1, parent));
  if (!plain(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    (/^(env|environment)$/i.test(key) || key === 'set' && parent === 'shell_environment_policy') && plain(child) && Object.keys(child).some(runsCode) ||
    setsLoader(child, depth + 1, key));
}
/**
 * Whether TOML or YAML text assigns an upper-case loader name, or one a client runs a program by, anywhere: at a line's
 * start, in an inline table (`{ NODE_OPTIONS = … }`) or as a dotted key's last part (`shell_environment_policy.set.NODE_OPTIONS = …`).
 */
const assignsLoader = (text: string): boolean =>
  [...text.matchAll(/(?:^|[\s{,.])["']?([A-Z_][A-Z0-9_]*)["']?\s*[:=]/gm)].some(match => runsCode(match[1]!));
/** Claude Code's settings that switch on a project's MCP servers without its own approval prompt. */
const MCP_ENABLE = new Set(['enableallprojectmcpservers', 'enabledmcpjsonservers']);
function enablesMcp(value: Json | undefined, depth = 0): boolean {
  if (depth > 32) return false;
  if (Array.isArray(value)) return value.some(item => enablesMcp(item, depth + 1));
  return plain(value) && Object.entries(value).some(([key, child]) => MCP_ENABLE.has(key.toLowerCase()) || enablesMcp(child, depth + 1));
}
/** The remote URLs a value's MCP server entries connect to, under any client's name for the URL. */
const URL_KEYS = new Set(['url', 'serverurl', 'httpurl']);
function remotesIn(value: Json | undefined, depth = 0, found: string[] = []): string[] {
  if (depth > 32) return found;
  if (Array.isArray(value)) for (const item of value) remotesIn(item, depth + 1, found);
  else if (plain(value)) for (const [key, child] of Object.entries(value)) {
    if (URL_KEYS.has(key.toLowerCase()) && typeof child === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(child)) found.push(child);
    else remotesIn(child, depth + 1, found);
  }
  return found;
}
/** A merge entry as it lands: re-nested at its whole key, so a value written at a command key is seen under that key. */
const nested = (segments: string[], entry: Json): Json => segments.reduceRight<Json>((inner, segment) => ({ [segment]: inner }), entry);

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

/**
 * A JSON or TOML merge entry's label, classified as it lands (the entry re-nested at its whole key, the same classifier
 * as for a written file): an MCP server it starts or connects to, a hook (also one whose command Core doesn't find), the
 * switch that enables project MCP servers, or a settings command (also an environment that sets a loader variable or
 * a name a client runs a program by); `undefined` when it configures none.
 */
export function mergeConfiguration(segments: string[], entry: Json, hide: (text: string) => string = text => text): ExecutableConfiguration | undefined {
  const whole = nested(segments, entry);
  const launches = shown(launchesIn(whole), hide);
  const hooks = mentionsHooks(segments, entry) || mentionsHooks([], whole);
  const loader = setsLoader(whole);
  const enabling = enablesMcp(whole);
  const mcp = segments.some(segment => /^(mcpservers|mcp_servers|mcp|servers|context_servers)$/i.test(segment));
  const connects = mcp ? remotesIn(whole).map(hide) : [];
  if (!launches.length && !hooks && !loader && !enabling && !connects.length) return undefined;
  const kind = hooks ? 'hook' : mcp ? 'mcp-server' : enabling ? 'mcp-enable' : 'settings-command';
  return { label: 'executable-configuration', kind, launches, ...(connects.length ? { connects } : {}) };
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
/** Words a configuration that starts a program names, in any key form: a write that never names one starts nothing. */
const COMMAND_WORDS = /command|notify|hooks?|apikeyhelper|awsauthrefresh|awscredentialexport|otelheadershelper|statuscommand|mcp_?servers|context_servers/i;
/** Text with TOML and YAML escapes (`\uXXXX`, `\UXXXXXXXX`, `\xNN`) decoded, so an escaped key is seen as itself. */
const unescaped = (text: string): string => text.replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})|\\x([0-9a-fA-F]{2})/g,
  (_whole, u4: string | undefined, u8: string | undefined, x2: string | undefined) => {
    try { return String.fromCodePoint(parseInt(u4 ?? u8 ?? x2!, 16)); } catch { return ''; }
  });
/** A value the line scans read as written, never a raw token that stands for something else (`*c`, `>-`, `"""`, `""`). */
const resolved = (launch: Launch): boolean => !!launch.command && !/^(?:[*&!|>]|""|''|\[|\{)/.test(launch.command) && launch.command !== '"""';
/** TOML or YAML forms the line scans don't read: inline or flow tables, multi-line values, anchors, aliases, tags, merge and explicit keys. */
const COMPLEX_TOML = /=\s*\{|^\s*[^#=\n]*=\s*\[\s*(#.*)?$|"""|'''|\\u|\\U/m;
const COMPLEX_YAML = /[{}]|^\s*\?\s|<<\s*:|(?:^|\s)[&*!][^\s]|:\s*[|>][-+]?\s*$|^\s*-\s*$|\\x|\\u/m;
/**
 * The programs a written text configures, read by its content: JSON (comments, a BOM, trailing commas allowed) is
 * parsed. Any other text that names a command-like key in any form (escapes decoded) is read line by line as TOML or
 * YAML; when it uses a form those scans don't read, or a value they can't resolve, it is `unparsed`: it is labelled all the
 * same, never left out. Markdown is read only in its front matter.
 */
function textLaunches(path: string, bytes: Buffer): { launches: Launch[]; hooks: boolean; loader?: boolean; enabling?: boolean; connects?: string[]; unparsed?: 'unparsed' | 'unparsed-yaml' } {
  const none = { launches: [], hooks: false };
  let text: string;
  // UTF-8, or UTF-16 with its byte order mark (a client may refuse it, but the review still reads it).
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); } catch { return none; }
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false }) as Json;
  if (!errors.length && parsed !== null && typeof parsed === 'object') return { launches: launchesIn(parsed), hooks: mentionsHooks([], parsed), loader: setsLoader(parsed), enabling: enablesMcp(parsed), connects: remotesIn(parsed) };
  if (/\.(md|mdc|markdown)$/i.test(path)) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!front) return none;
    text = front[1]!;
  }
  if (bytes.length > 1_048_576) return { ...none, unparsed: 'unparsed' };
  // Every YAML file is labelled: Core has no full YAML parser, so none is proved to start nothing.
  const yamlFile = /\.ya?ml$/i.test(path);
  const loader = assignsLoader(text);
  if (!yamlFile && !COMMAND_WORDS.test(unescaped(text))) return loader ? { ...none, loader } : none;
  const toml = /\.toml$/i.test(path) || /^\s*\[[^\]\n]+\]\s*(#.*)?$/m.test(text) || /^\s*[A-Za-z0-9_."'-]+\s*=/m.test(text) && !/^\s*[A-Za-z0-9_"'-]+\s*:\s/m.test(text);
  if (toml) {
    const read = tomlLaunches(text);
    return COMPLEX_TOML.test(text) || !read.launches.length || !read.launches.every(resolved) ? { launches: [], hooks: read.hooks, loader, unparsed: 'unparsed' } : { ...read, loader };
  }
  const read = yamlLaunches(text);
  return COMPLEX_YAML.test(text) || /\\/.test(text) || !read.launches.length || !read.launches.every(resolved) ? { launches: [], hooks: read.hooks, loader, unparsed: 'unparsed-yaml' } : { ...read, loader };
}
/** A written file's label: made executable, or settings (in any format) that run commands; with the bytes' sha256 either way. */
export function writeConfiguration(path: string, bytes: Buffer, executable: boolean, hide: (text: string) => string = text => text): ExecutableConfiguration | undefined {
  const read = textLaunches(path, bytes);
  const launches = shown(read.launches, hide); const hooks = read.hooks;
  const connects = (read.connects ?? []).map(hide);
  if (!executable && !launches.length && !read.unparsed && !hooks && !read.loader && !read.enabling && !connects.length) return undefined;
  return { label: 'executable-configuration', kind: executable ? 'executable-file' : read.unparsed ?? (hooks ? 'hook' : read.enabling ? 'mcp-enable' : 'settings-command'),
    launches, ...(connects.length ? { connects } : {}), sha256: createHash('sha256').update(bytes).digest('hex'), executable };
}
