// Which CLI ids a plan may name (C37, C73): a Catalog profile id must be a registry id with surface `cli`.
//
// The Harness registry still carries the pre-C73 ids (`claude`, IDE `cursor`, no `dsh`); its rename belongs to the
// tool-registry slice. Until then this table is the C73 mapping itself, checked against the registry so a registry
// change that drops one of these CLIs fails here instead of silently admitting it.
import { findTool } from '../../harness/tool-registry.mjs';

/** C73: registry id (surface cli) per Catalog profile id; `null` where the registry entry is added by the rename. */
const PROFILE_TOOLS: Readonly<Record<string, string | null>> = Object.freeze({
  'claude-code': 'claude', codex: 'codex', copilot: 'copilot', kiro: 'kiro', antigravity: 'antigravity',
  opencode: 'opencode', kimi: 'kimi', cursor: null, dsh: null,
});

export function knownCli(id: string): boolean {
  if (!Object.hasOwn(PROFILE_TOOLS, id)) return false;
  const registry = PROFILE_TOOLS[id];
  if (registry === null) return true;
  const found = findTool(registry);
  return !!found && found.tool.surface === 'cli';
}
