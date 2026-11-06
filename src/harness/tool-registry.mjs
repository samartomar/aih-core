// Portable Harness data: the tool registry (contract 6, C37, C73). Importing it performs no host observation.
// Registry ids match Catalog's profile ids. A command-line tool and an IDE are separate entries, and an IDE is never
// mapped to a CLI profile. An alias is accepted only when someone selects a tool by name; plans, receipts and
// organization documents carry ids only. What can be selected comes from the registry alone, not from observations.
import { Ajv2020 } from 'ajv/dist/2020.js';
import registrySchema from '../core/schemas/tool-registry/0.1.0.json' with { type: 'json' };

const REGISTRY = 'urn:aihq:core:tool-registry:0.1.0';
const tool = (id, label, surface, binaries, aliases = []) =>
  Object.freeze({ id, label, surface, binaries: Object.freeze(binaries), aliases: Object.freeze(aliases) });

export const toolRegistry = Object.freeze({
  schema: REGISTRY,
  tools: Object.freeze([
    // Renamed from `claude` to match Catalog's profile; the old id stays an alias for selection only.
    tool('claude-code', 'Claude Code', 'cli', ['claude'], ['claude']),
    tool('codex', 'Codex CLI', 'cli', ['codex']),
    tool('kiro', 'Kiro CLI', 'cli', ['kiro-cli']),
    tool('copilot', 'Copilot CLI', 'cli', ['copilot']),
    // Antigravity's CLI is its own tool, not Gemini CLI.
    tool('antigravity', 'Antigravity CLI', 'cli', ['agy']),
    tool('gemini', 'Gemini CLI', 'cli', ['gemini']),
    tool('opencode', 'OpenCode', 'cli', ['opencode']),
    tool('kimi', 'Kimi Code', 'cli', ['kimi']),
    tool('cursor', 'Cursor CLI', 'cli', ['cursor-agent']),
    tool('dsh', 'DeepSeek Harness', 'cli', ['dsh']),
    // Renamed from `cursor`, which now names the CLI.
    tool('cursor-ide', 'Cursor', 'ide', ['cursor']),
    tool('windsurf', 'Windsurf', 'ide', ['windsurf']),
    tool('zed', 'Zed', 'ide', ['zed', 'zeditor', 'zedit']),
    tool('kiro-ide', 'Kiro IDE', 'ide', ['kiro']),
    tool('copilot-vscode', 'GitHub Copilot in VS Code', 'ide', ['code'])
  ])
});

/** Registry tools in registry order; `{ surface }` keeps one surface. Anything else is `invalid`. */
export function listTools(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'surface') ||
      (options.surface !== undefined && options.surface !== 'cli' && options.surface !== 'ide'))
    return { status: 'invalid', problems: [{ path: '', reason: 'options', message: "listTools accepts only { surface?: 'cli' | 'ide' }." }] };
  return { status: 'ok', tools: Object.freeze(toolRegistry.tools.filter(entry => options.surface === undefined || entry.surface === options.surface)) };
}

/** The registry entry a name denotes, and whether the name is its id or an alias; undefined when unknown. */
export function findTool(name) {
  if (typeof name !== 'string') return undefined;
  const found = toolRegistry.tools.find(item => item.id === name) ?? toolRegistry.tools.find(item => item.aliases.includes(name));
  return found && { tool: found, via: found.id === name ? 'id' : 'alias' };
}

/** Resolves a tool id or alias to its registry entry; an unknown name is refused `tool-unknown`. */
export function selectTool(name) {
  const found = findTool(name);
  if (!found) return { status: 'refused', code: 'tool-unknown', reason: 'The tool registry has no tool by that id or alias.' };
  return { status: 'ok', tool: found.tool, via: found.via };
}

let check;
/** Reads a tool-registry 0.1.0 document: its schema, plus one tool per id and alias. */
export function validateToolRegistry(value) {
  const declared = value !== null && typeof value === 'object' && !Array.isArray(value) ? value.schema : undefined;
  if (typeof declared === 'string' && declared !== REGISTRY && declared.startsWith('urn:aihq:'))
    return { status: 'unsupported-version', encountered: declared, supported: [REGISTRY] };
  check ??= new Ajv2020({ allErrors: true, strict: true }).compile(registrySchema);
  let ok;
  try { ok = check(value); } catch { ok = false; }
  if (!ok) return { status: 'invalid', problems: (check.errors ?? [{ instancePath: '', keyword: 'type', params: {} }]).slice(0, 64).map(error => ({
    path: error.keyword === 'additionalProperties' ? `${error.instancePath}/${String(error.params.additionalProperty).replaceAll('~', '~0').replaceAll('/', '~1')}` : error.instancePath,
    reason: error.keyword === 'additionalProperties' ? 'unknown-field' : error.keyword,
    message: 'The tool registry does not match its schema.' })) };
  const problems = [];
  const seen = new Set();
  value.tools.forEach((entry, index) => [entry.id, ...entry.aliases].forEach((name, position) => {
    if (seen.has(name)) problems.push({ path: position === 0 ? `/tools/${index}/id` : `/tools/${index}/aliases/${position - 1}`,
      reason: 'duplicate-tool-name', message: 'A tool id or alias names more than one tool.' });
    seen.add(name);
  }));
  return problems.length ? { status: 'invalid', problems } : { status: 'ok' };
}
