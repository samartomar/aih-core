// A `write` step, or a Markdown `merge` block, with `render` (contract 8.1, C23, C51, D106): Core never renders itself. It checks the profile
// versions the render records against the supplied profiles (`profile-mismatch`) and the source bytes against their
// sha256 (`source-mismatch`), then calls the caller's `controls.catalog.renderStep` on the checked bytes only.
// The render shape is Catalog's: `{ name, profile, version, … }`, or `{ name, profiles: [{ id, version }], … }` for a
// combined render, with `from: { item, sourceId?, sourcePath, sha256? }` when it renders an item file.
import { createHash } from 'node:crypto';
import { limitValue } from '../limits.js';
import { problem, refusal } from './common.js';
import type { Json } from '../../types.js';
import type { PlanStep } from '../types.js';
import type { SourceFacts, StepContext, StepOutcome } from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
type Version = string | number;
const isVersion = (value: unknown): value is Version =>
  typeof value === 'string' && value.length > 0 && value.length <= 64 || Number.isSafeInteger(value) && (value as number) >= 0;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, Json> => !!value && typeof value === 'object' && !Array.isArray(value);
/** A Catalog result's reason, bounded and on one line, for Core's own reason text. */
const quoted = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, 256) : 'no reason given';

/**
 * The profiles a render records: one `{ profile, version }`, or a combined render's `profiles`, or none for a render
 * Catalog makes from the plan alone (`bundle-root` in a shared Markdown file, `duplicates-report`).
 */
function recordedProfiles(render: Record<string, Json>): { id: string; version: Version }[] | undefined {
  if (!Object.hasOwn(render, 'profiles') && !Object.hasOwn(render, 'profile')) return Object.hasOwn(render, 'version') ? undefined : [];
  if (Object.hasOwn(render, 'profiles')) {
    const list = render.profiles;
    if (Object.hasOwn(render, 'profile') || !Array.isArray(list) || list.length === 0 || list.length > 64) return undefined;
    const out: { id: string; version: Version }[] = [];
    for (const entry of list) {
      if (!object(entry) || typeof entry.id !== 'string' || !ID.test(entry.id) || !isVersion(entry.version)) return undefined;
      out.push({ id: entry.id, version: entry.version });
    }
    return new Set(out.map(entry => entry.id)).size === out.length ? out : undefined;
  }
  return typeof render.profile === 'string' && ID.test(render.profile) && isVersion(render.version) ?
    [{ id: render.profile, version: render.version }] : undefined;
}

export interface Rendered { bytes: Buffer; executable: boolean; profiles: { id: string; version: Version }[]; name: string }

/** Checks and carries out one render; `owners` are the step's management ids (its `item` or `items`). */
export async function renderWrite(step: PlanStep & Record<string, Json>, context: StepContext, path: string, owners: string[]):
  Promise<{ rendered: Rendered } | Exclude<StepOutcome, { lowered: unknown }>> {
  const { index, controls, request } = context;
  const renderStep = controls.catalog?.renderStep;
  if (typeof renderStep !== 'function')
    return refusal('catalog-required', `Step ${index} renders \`${path}\` and needs the Catalog that made the plan (\`controls.catalog.renderStep\`).`, index);
  const render = step.render;
  const profiles = object(render) && typeof render.name === 'string' && render.name.length > 0 && render.name.length <= 128 ?
    recordedProfiles(render) : undefined;
  if (!object(render) || !profiles)
    return problem(index, 'render', 'render', 'A render names its transform and the profile id and version it was planned with.');
  for (const recorded of profiles) {
    const supplied = request.profiles.find(entry => entry.id === recorded.id);
    if (!supplied) return refusal('profile-mismatch', `Step ${index} was rendered with profile \`${recorded.id}\`, which the request does not supply.`, index);
    if (supplied.version !== recorded.version)
      return refusal('profile-mismatch', `Step ${index} was planned with \`${recorded.id}\` version ${String(recorded.version)}, not version ${String(supplied.version)}.`, index);
  }
  if (step.executable !== undefined && typeof step.executable !== 'boolean') return problem(index, 'executable', 'executable', 'A step\'s `executable` is a boolean.');

  const files: { sourceId: string; sourcePath: string; bytes: Uint8Array }[] = [];
  let facts: SourceFacts | undefined;
  if (step.from !== undefined) {
    const from = step.from;
    if (!object(from) || typeof from.sourcePath !== 'string' || from.sha256 !== undefined && (typeof from.sha256 !== 'string' || !SHA.test(from.sha256)))
      return problem(index, 'from', 'from', 'A rendered write names `from` as an item file or a source notice.');
    // As for a plain write: `from` with `item` is that item's file; without it, a notice or bundle file by `sourceId`.
    const item = typeof from.item === 'string' ? from.item : typeof from.sourceId === 'string' ? undefined : owners.length === 1 ? owners[0]! : undefined;
    facts = item !== undefined ? context.itemFile(item, from.sourcePath, { ...(typeof from.sourceId === 'string' ? { sourceId: from.sourceId } : {}),
      ...(typeof from.sha256 === 'string' ? { sha256: from.sha256 } : {}) }) : typeof from.sourceId === 'string' ?
      context.sourceFile(from.sourceId, from.sourcePath, typeof step.bundle === 'string' ? step.bundle : undefined) : undefined;
    if (!facts) return refusal('source-missing', `Step ${index} names \`${from.sourcePath}\`, which no supplied content document lists.`, index);
    if (typeof from.sourceId === 'string' && from.sourceId !== facts.sourceId || typeof from.sha256 === 'string' && from.sha256 !== facts.sha256)
      return refusal('source-mismatch', `Step ${index}'s source facts for \`${from.sourcePath}\` differ from the content document's.`, index);
    const supplied = context.bytesFor(facts); if ('refusal' in supplied) return supplied;
    files.push({ sourceId: facts.sourceId, sourcePath: facts.sourcePath, bytes: new Uint8Array(supplied.bytes) });
  }

  let result: unknown;
  try {
    result = await renderStep(structuredClone(step), structuredClone(request.contents), structuredClone(request.profiles), files);
  } catch {
    return problem(index, 'render', 'render-failed', 'The caller\'s Catalog failed to render this step.');
  }
  if (object(result as Json) && (result as { status?: unknown }).status === 'refused') {
    const { code, reason } = result as { code?: unknown; reason?: unknown };
    if (code === 'source-mismatch' || code === 'profile-mismatch')
      return refusal(code, `The Catalog refused to render step ${index}: ${quoted(reason)}.`, index);
    return problem(index, 'render', 'render-failed', `The Catalog refused to render step ${index} (${quoted(code)}): ${quoted(reason)}.`);
  }
  const ok = result as { status?: unknown; bytes?: unknown; sha256?: unknown } | null;
  if (!ok || ok.status !== 'ok' || !(ok.bytes instanceof Uint8Array) || typeof ok.sha256 !== 'string')
    return problem(index, 'render', 'render-failed', 'The Catalog did not return rendered bytes for this step.');
  if (ok.bytes.byteLength > limitValue('file-bytes'))
    return { refusal: { status: 'refused', code: 'limit-exceeded', reason: `The render of step ${index} is larger than one file may be.`,
      limit: 'file-bytes', value: limitValue('file-bytes'), step: index } };
  const bytes = Buffer.from(ok.bytes);
  if (sha256(bytes) !== ok.sha256) return problem(index, 'render', 'render-failed', 'The Catalog\'s rendered bytes differ from the sha256 it reported.');
  return { rendered: { bytes, executable: step.executable === true || step.executable === undefined && facts?.executable === true,
    profiles, name: render.name as string } };
}
