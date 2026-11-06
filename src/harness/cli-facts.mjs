// Portable Harness data: the per-CLI facts Core's plan path and inspection read (contract 6, 8.1, 12; C29, C45, C69,
// C72, C73). Core keeps no CLI names of its own: it reads them here, as it reads the tool registry. Importing this
// performs no host observation.

const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};

export const cliFacts = freeze({
  /** The registry CLIs Catalog has a tool profile for: the only CLIs a plan's profiles and steps may name (C73). */
  profiled: ['claude-code', 'codex', 'copilot', 'kiro', 'antigravity', 'opencode', 'kimi', 'cursor', 'dsh'],
  /** CLIs observed to load a junctioned skill folder on Windows (C29, L1, L2); a link for any other CLI is a copy. */
  junctionLinks: ['claude-code', 'codex', 'copilot', 'kimi', 'kiro', 'opencode'],
  /** Guidance files a CLI reads only up to a size: the resulting file is checked before any write (C72). */
  guidanceLimits: [{ cli: 'codex', label: 'Codex', file: 'AGENTS.md', maxBytes: 32 * 1024 }],
  /**
   * CLIs that can switch one plugin skill off (C45, C69): a marked block in the user's config file holding one table of
   * the array `table`, keyed by the plugin-qualified `plugin:skill` name.
   */
  switchOff: [{ cli: 'codex', file: ['.codex', 'config.toml'], table: ['skills', 'config'] }],
  /**
   * Harness inspection targets that are registry tools under another id. `cursor` is the IDE when its `cursor` command
   * ran and the CLI otherwise.
   */
  inspectTargets: [
    { target: 'claude', tool: 'claude-code' },
    { target: 'cursor', tool: 'cursor-ide', binary: 'cursor' },
    { target: 'cursor', tool: 'cursor' }
  ]
});

/** The size limit of a guidance file named `file` for one of these CLIs, or `undefined`. */
export function guidanceLimit(clis, file) {
  return cliFacts.guidanceLimits.find(limit => clis.includes(limit.cli) && limit.file === file);
}
/** The switch-off route of a CLI, or `undefined` when it has none. */
export function switchOffRoute(cli) {
  return cliFacts.switchOff.find(route => route.cli === cli);
}
/** The Harness inspection target a registry tool is inspected under. */
export function inspectTargetOf(tool) {
  return cliFacts.inspectTargets.find(entry => entry.tool === tool)?.target ?? tool;
}
/**
 * The registry tool a Harness target's version command reached: `null` when the target covers more than one tool and
 * no command says which. A target that names no other tool is its own registry id.
 */
export function inspectToolOf(target, binary) {
  const named = cliFacts.inspectTargets.filter(entry => entry.target === target);
  if (!named.length) return target;
  if (binary === undefined) return named.length === 1 ? named[0].tool : null;
  return (named.find(entry => entry.binary === binary) ?? named.find(entry => entry.binary === undefined))?.tool ?? null;
}
