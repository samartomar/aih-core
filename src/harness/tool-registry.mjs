// Portable Harness data: the AI tools Harness knows, by surface. Importing it performs no host observation.
import { Ajv2020 } from 'ajv/dist/2020.js';
import registrySchema from './schemas/tool-registry/1.0.0.json' with { type: 'json' };
import { pointerMember, unsupportedFormat } from './native/canonical.mjs';

const REGISTRY = 'urn:aihq:harness:tool-registry:1.0.0';
const tool = (id, label, surface, binaries, aliases = []) =>
  Object.freeze({ id, label, surface, binaries: Object.freeze(binaries), aliases: Object.freeze(aliases) });

// Ids and labels are a stable vocabulary other packages may cite. Every native client id is a registry id.
// Command-line tools and IDEs are separate entries: an IDE layout is never a CLI's.
export const toolRegistry = Object.freeze({
  schema: REGISTRY,
  tools: Object.freeze([
    tool('claude', 'Claude Code', 'cli', ['claude'], ['claude-code']),
    tool('codex', 'Codex CLI', 'cli', ['codex']),
    tool('kiro', 'Kiro CLI', 'cli', ['kiro-cli']),
    tool('copilot', 'Copilot CLI', 'cli', ['copilot']),
    // Antigravity's CLI is its own tool, not Gemini CLI.
    tool('antigravity', 'Antigravity CLI', 'cli', ['agy']),
    tool('gemini', 'Gemini CLI', 'cli', ['gemini']),
    tool('opencode', 'OpenCode', 'cli', ['opencode']),
    tool('kimi', 'Kimi Code', 'cli', ['kimi']),
    tool('cursor', 'Cursor', 'ide', ['cursor']),
    tool('windsurf', 'Windsurf', 'ide', ['windsurf']),
    tool('zed', 'Zed', 'ide', ['zed', 'zeditor', 'zedit']),
    tool('kiro-ide', 'Kiro IDE', 'ide', ['kiro']),
    tool('copilot-vscode', 'GitHub Copilot in VS Code', 'ide', ['code'])
  ])
});

// Seeded observation presence: tools with at least one observed cell in the 23 October 2026 Windows
// canary runs. The observed binding table (urn:aihq:harness:tool-binding:1.0.0) replaces this seed.
const observedTools = new Set(['claude', 'codex', 'kiro', 'copilot', 'antigravity']);

/** Tools with at least one observed binding cell, in registry order; `includeUnobserved` lists the rest too. */
export function listTools(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'includeUnobserved') ||
      (options.includeUnobserved !== undefined && typeof options.includeUnobserved !== 'boolean'))
    throw new TypeError('listTools accepts only { includeUnobserved?: boolean }');
  const tools = toolRegistry.tools.filter(entry => options.includeUnobserved === true || observedTools.has(entry.id));
  return Object.freeze(tools);
}

/** Resolves a requested tool id or alias. An unobserved tool is refused, never offered as a target. */
export function selectTool(id) {
  const entry = typeof id === 'string' ? toolRegistry.tools.find(item => item.id === id || item.aliases.includes(id)) : undefined;
  if (!entry) return { status: 'refused', code: 'INPUT_INVALID', reason: 'unknown-tool' };
  if (!observedTools.has(entry.id)) return { status: 'refused', code: 'PREREQUISITE_UNAVAILABLE', reason: 'tool-not-observed', tool: entry };
  return { status: 'selected', tool: entry };
}

let check;
/** Validates a tool-registry 1.0.0 document: its schema plus one tool per id and alias. */
export function validateToolRegistry(value) {
  const unsupported = unsupportedFormat(value, [REGISTRY]);
  if (unsupported) return { valid: false, diagnostics: [unsupported] };
  check ??= new Ajv2020({ allErrors: true, strict: true }).compile(registrySchema);
  if (!check(value)) return { valid: false, diagnostics: check.errors.map(error => ({ code: 'INPUT_INVALID', reason: 'schema',
    path: error.keyword === 'additionalProperties' ? `${error.instancePath}/${pointerMember(error.params.additionalProperty)}` : error.instancePath,
    message: 'The tool registry does not match its schema.' })) };
  const diagnostics = [];
  const seen = new Set();
  value.tools.forEach((entry, index) => [entry.id, ...entry.aliases].forEach((name, position) => {
    if (seen.has(name)) diagnostics.push({ code: 'INPUT_INVALID', reason: 'duplicate-tool-name',
      path: position === 0 ? `/tools/${index}/id` : `/tools/${index}/aliases/${position - 1}`,
      message: 'A tool id or alias names more than one tool.' });
    seen.add(name);
  }));
  return { valid: diagnostics.length === 0, diagnostics };
}
