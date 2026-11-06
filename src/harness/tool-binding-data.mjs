// Portable Harness data shared by the tool registry and the binding table. No host observation.
import bindingData from './tool-bindings.json' with { type: 'json' };

const deepFreeze = value => {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};
// Seeded with the 23 October 2026 Windows canary observations. Every change here ships in a new Core version.
export const toolBindings = deepFreeze(bindingData);
// Isolation that keeps the user's own configuration out of the observation. Inside-profile redirection never counts.
export const qualifyingIsolation = Object.freeze(['os-account', 'sandbox', 'env-redirect-outside-profile']);
/** Tools with at least one cell observed under qualifying isolation, in table order. */
export const observedToolIds = Object.freeze(toolBindings
  .filter(binding => Object.values(binding.layouts).some(layout =>
    layout.observations.some(item => qualifyingIsolation.includes(item.isolation))))
  .map(binding => binding.tool));

// The ids the binding table names (the observation records' own vocabulary, not a published registry).
const tool = (id, label, surface, binaries, aliases = []) =>
  Object.freeze({ id, label, surface, binaries: Object.freeze(binaries), aliases: Object.freeze(aliases) });
const bindingTools = Object.freeze([
  tool('claude', 'Claude Code', 'cli', ['claude'], ['claude-code']), tool('codex', 'Codex CLI', 'cli', ['codex']),
  tool('kiro', 'Kiro CLI', 'cli', ['kiro-cli']), tool('copilot', 'Copilot CLI', 'cli', ['copilot']),
  tool('antigravity', 'Antigravity CLI', 'cli', ['agy']), tool('gemini', 'Gemini CLI', 'cli', ['gemini']),
  tool('opencode', 'OpenCode', 'cli', ['opencode']), tool('kimi', 'Kimi Code', 'cli', ['kimi']), tool('cursor', 'Cursor', 'ide', ['cursor']),
  tool('windsurf', 'Windsurf', 'ide', ['windsurf']), tool('zed', 'Zed', 'ide', ['zed', 'zeditor', 'zedit']),
  tool('kiro-ide', 'Kiro IDE', 'ide', ['kiro']), tool('copilot-vscode', 'GitHub Copilot in VS Code', 'ide', ['code'])
]);
const observedTools = new Set(observedToolIds);
/** The binding tool a name denotes, and whether the name is its id or an alias; undefined when unknown. */
export function findBindingTool(name) {
  if (typeof name !== 'string') return undefined;
  const entry = bindingTools.find(item => item.id === name || item.aliases.includes(name));
  return entry && { tool: entry, via: entry.id === name ? 'id' : 'alias' };
}
/** A binding tool with at least one observed cell; any other is refused. */
export function selectBindingTool(id) {
  const entry = findBindingTool(id)?.tool;
  if (!entry) return { status: 'refused', code: 'INPUT_INVALID', reason: 'unknown-tool' };
  if (!observedTools.has(entry.id)) return { status: 'refused', code: 'PREREQUISITE_UNAVAILABLE', reason: 'tool-not-observed', tool: entry };
  return { status: 'selected', tool: entry };
}
