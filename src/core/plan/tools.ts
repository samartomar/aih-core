// Which CLI ids a plan may name (C37, C73): a Catalog profile id must be a registry id with surface `cli`.
// Only the id counts: an alias (such as `claude`) is accepted for selection by name, never in a plan.
import { findTool } from '../../harness/tool-registry.mjs';

export function knownCli(id: string): boolean {
  const found = findTool(id);
  return !!found && found.via === 'id' && found.tool.surface === 'cli';
}
