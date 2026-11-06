// Which CLI ids a plan may name (C37, C73): a Catalog profile id must be a registry id with surface `cli`, and content
// steps target only the registry tools Catalog has a profile for (contract 6). Only the id counts: an alias (such as
// `claude`) is accepted for selection by name, never in a plan. A registry change that drops one of these CLIs fails here.
import { findTool } from '../../harness/tool-registry.mjs';
import { cliFacts } from '../../harness/cli-facts.mjs';

const PROFILED = new Set(cliFacts.profiled);

export function knownCli(id: string): boolean {
  const found = findTool(id);
  return PROFILED.has(id) && !!found && found.via === 'id' && found.tool.surface === 'cli';
}
