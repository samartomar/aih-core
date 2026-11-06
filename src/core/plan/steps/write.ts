// `write` (Catalog 9, contract 8.1): one file from an item file or a source notice, checked by sha256.
// A `render` is carried out by the caller's Catalog (C51, `./render.ts`). Input bindings (`inputs`, D121) are filled at
// the placeholders the item declares for that file, after any render (`../inputs.ts`).
import { aiSetupReserved, clis, owners, problem, refusal, target } from './common.js';
import { renderWrite } from './render.js';
import { bindText, parseBindings, unfilledPlaceholder, type BoundInputs } from '../inputs.js';
import type { Json } from '../../types.js';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { MCP_FACTS } from '../mcp-facts.js';
import type { PlanStep } from '../types.js';
import type { StepContext, StepHandler, StepOutcome } from './types.js';

/** The file's bytes with its placeholder bindings filled. */
function filled(step: PlanStep & Record<string, Json>, context: StepContext, path: string, clisServed: string[], bytes: Buffer):
    { bytes: Buffer; bound?: BoundInputs } | Exclude<StepOutcome, { lowered: unknown }> {
  const parsed = parseBindings(step.inputs, context.index, ['placeholder']);
  if ('problem' in parsed) return parsed;
  if (!parsed.bindings.length) return { bytes };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return problem(context.index, 'inputs', 'input-binding', `\`${path}\` is not text, so it holds no placeholder.`); }
  const from = step.from && typeof step.from === 'object' && !Array.isArray(step.from) && typeof step.from.sourcePath === 'string' ? step.from.sourcePath : undefined;
  const done = bindText(text, path, parsed.bindings, context.inputs(clisServed), from);
  if (!('text' in done)) return done;
  return { bytes: Buffer.from(done.text, 'utf8'), bound: done.bound };
}

/** The source id and sha256 a `from` names, when it names them. */
const sourceFacts = (from: { [key: string]: Json }): { sourceId?: string; sha256?: string } =>
  ({ ...(typeof from.sourceId === 'string' ? { sourceId: from.sourceId } : {}), ...(typeof from.sha256 === 'string' ? { sha256: from.sha256 } : {}) });

/** The review says when a written file is made executable. */
const asExecutable = (executable: unknown): string => executable === true ? ' as an executable file' : '';
export const write: StepHandler = {
  op: 'write',
  // An executable file is never placed in an AI setup's folder, not even its settings folder.
  async prepare(step, context) {
    const outcome = await lowerWrite(step, context);
    if (!('lowered' in outcome) || outcome.lowered.kind !== 'write') return outcome;
    const lowered = outcome.lowered;
    // A whole MCP config file is never an MCP item's write: its entries go through the merge that binds them to the
    // item. Any other writer's is labelled with the programs it starts.
    const items = (context.request.contents as unknown as { items?: { id?: unknown; kind?: unknown }[] }[]).flatMap(content => content.items ?? []);
    if (lowered.managementIds.some(id => items.some(item => item.id === id && item.kind === 'mcp')) && mcpConfigFile(context, lowered.path, lowered.bytes))
      return refusal('mcp-entry-shape', `Step ${context.index} writes \`${lowered.path}\`, a whole MCP configuration file, for an MCP item; its entry is a merge.`, context.index);
    if (!lowered.executable) return outcome;
    return aiSetupReserved(lowered.root, lowered.path, context.index, true) ?? outcome;
  }
};
/**
 * Whether a written file is an MCP configuration file: any known client's MCP place (Core's facts and the request's
 * profiles), or text holding an MCP container in any format: JSON or JSONC (comments, a BOM, trailing commas), a TOML
 * `[mcp_servers…]` table or `mcp_servers` key, or a YAML `mcpServers:` key.
 */
function mcpConfigFile(context: StepContext, path: string, bytes: Buffer): boolean {
  const fold = (value: unknown) => typeof value === 'string' ? value.toLowerCase() : value;
  const places = [...Object.values(MCP_FACTS).flatMap(facts => Object.values(facts.places)),
    ...(context.request.profiles as unknown as { places?: { mcp?: Record<string, Json> } }[]).flatMap(profile => Object.values(profile.places?.mcp ?? {}))]
    .map(place => place && typeof place === 'object' && !Array.isArray(place) ? fold((place as Record<string, Json>).file) : undefined);
  if (places.includes(fold(path))) return true;
  let text: string;
  try { text = new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
  catch { return false; }
  const holds = (value: unknown, depth = 0): boolean => depth < 32 && !!value && typeof value === 'object' &&
    Object.entries(value).some(([key, child]) => /^(mcpservers|mcp_servers|servers|mcp|context_servers)$/i.test(key) || holds(child, depth + 1));
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (!errors.length && parsed && typeof parsed === 'object') return holds(parsed);
  return /^\s*\[\[?\s*["']?(mcp_servers|context_servers)["']?\s*[.\]]/im.test(text) || /^\s*["']?(mcp_servers|mcpServers|context_servers)["']?\s*[=:]/im.test(text);
}
async function lowerWrite(step: Parameters<StepHandler['prepare']>[0], context: StepContext): Promise<StepOutcome> {
  {
    const { index } = context;
    const owner = owners(step, index); if ('problem' in owner) return owner;
    const placed = target(step, index); if (!('root' in placed)) return placed;
    const reserved = aiSetupReserved(placed.root, placed.path, index); if (reserved) return reserved;
    const served = clis(step, index); if (!('clis' in served)) return served;
    if (step.render !== undefined) {
      const done = await renderWrite(step, context, placed.path, owner.ids);
      if (!('rendered' in done)) return done;
      const bytes = filled(step, context, placed.path, served.clis, done.rendered.bytes); if (!('bytes' in bytes)) return bytes;
      const unfilled = unfilledPlaceholder(step, index, bytes.bytes.toString('utf8'), owner.ids, context.inputs(served.clis)); if (unfilled) return unfilled;
      return { lowered: { kind: 'write', managementIds: owner.ids, root: placed.root, path: placed.path, bytes: bytes.bytes,
        executable: done.rendered.executable, sentence: `Writes \`${placed.path}\`${asExecutable(done.rendered.executable)}, rendered by your Catalog (\`${done.rendered.name}\`)`,
        cantPromise: null, review: { ...owner.review, clis: served.clis, ...(bytes.bound ? { inputs: bytes.bound.review } : {}) },
        ...(bytes.bound ? { bound: bytes.bound } : {}), profiles: done.rendered.profiles } };
    }
    const from = step.from;
    // A local-plugin route copies its framework's recorded plugin folder file by file (Catalog D120).
    if (owner.review.framework !== undefined && from && typeof from === 'object' && !Array.isArray(from) &&
        typeof from.sourceId === 'string' && typeof from.sourcePath === 'string' && from.item === undefined && from.source === undefined) {
      const facts = context.pluginFile(owner.review.framework, from.sourceId, from.sourcePath);
      if (!facts) return refusal('source-missing', `Step ${index} names \`${from.sourcePath}\`, which no recorded plugin folder of \`${owner.review.framework}\` lists.`, index);
      if (from.sha256 !== undefined && from.sha256 !== facts.sha256)
        return refusal('source-mismatch', `Step ${index} names other bytes for \`${from.sourcePath}\` than the content document records.`, index);
      const supplied = context.bytesFor(facts); if ('refusal' in supplied) return supplied;
      return { lowered: { kind: 'write', managementIds: owner.ids, root: placed.root, path: placed.path, bytes: supplied.bytes,
        executable: facts.executable, sentence: `Writes \`${placed.path}\`${asExecutable(facts.executable)}, part of the \`${owner.review.framework}\` local plugin`, cantPromise: null,
        review: { ...owner.review, clis: served.clis }, source: { sourceId: facts.sourceId, sourcePath: facts.sourcePath, sha256: facts.sha256 } } };
    }
    // Catalog's `from` is `{ item?, sourceId, sourcePath, sha256 }`: an item's (or edition's) file, or, without `item`, a
    // file shared by the step's `items`: a source notice, or a file of the runtime `bundle` the step names.
    if (!from || typeof from !== 'object' || Array.isArray(from) || typeof from.sourcePath !== 'string' ||
        typeof from.item !== 'string' && typeof from.sourceId !== 'string' || step.bundle !== undefined && typeof step.bundle !== 'string')
      return problem(index, 'from', 'from', 'A write step names `from` as an item file, or by `sourceId` a source notice or bundle file.');
    const facts = typeof from.item === 'string' ? context.itemFile(from.item, from.sourcePath, sourceFacts(from)) :
      context.sourceFile(from.sourceId as string, from.sourcePath, step.bundle as string | undefined);
    if (!facts) return refusal('source-missing', `Step ${index} names \`${from.sourcePath}\`, which no supplied content document lists.`, index);
    if (from.sourceId !== undefined && from.sourceId !== facts.sourceId || from.sha256 !== undefined && from.sha256 !== facts.sha256)
      return refusal('source-mismatch', `Step ${index}'s source facts for \`${from.sourcePath}\` differ from the content document's.`, index);
    const supplied = context.bytesFor(facts); if ('refusal' in supplied) return supplied;
    const bytes = filled(step, context, placed.path, served.clis, supplied.bytes); if (!('bytes' in bytes)) return bytes;
    const unfilled = unfilledPlaceholder(step, index, bytes.bytes.toString('utf8'), owner.ids, context.inputs(served.clis)); if (unfilled) return unfilled;
    return { lowered: { kind: 'write', managementIds: owner.ids, root: placed.root, path: placed.path, bytes: bytes.bytes,
      executable: facts.executable, sentence: `Writes \`${placed.path}\`${asExecutable(facts.executable)}`, cantPromise: null,
      review: { ...owner.review, clis: served.clis, ...(bytes.bound ? { inputs: bytes.bound.review } : {}) },
      ...(bytes.bound ? { bound: bytes.bound } : {}), source: { sourceId: facts.sourceId, sourcePath: facts.sourcePath, sha256: facts.sha256 } } };
  }
};
