// Portable reading of a change (`urn:aihq:core:change:0.1.0`, contract 4.2): its one schema, the retained semantic rules
// of the bounded editors, inputs, materials, approvals and hook groups, and its canonical material-bound identity.
// No host effects: this module is published through `@aihq/core/contracts`.
import { recipeSemantics } from '../internal/policy-validation.js';
import { canonicalJson } from '../internal/canonical.js';
import { recipeIdentityDescriptor } from '../internal/recipe-identity.js';
import { checkedInlineMaterials, checkedReference, MaterialCaptureError } from '../internal/material-descriptors.js';
import { sha256 } from '../internal/sha256.js';
import { cloneJsonValueStructureV1, parseStrictJsonObjectV1 } from '../internal/strict-json.js';
import { schemaProblems } from '../plan/formats.js';
import type { Invalid, Problem, UnsupportedVersion } from '../plan/types.js';
import type { Json, MaterialIdentity, MaterialRecipeReference, Recipe } from '../types.js';

export const CHANGE = 'urn:aihq:core:change:0.1.0' as const;
export const CHANGE_REQUEST = 'urn:aihq:core:change-request:0.1.0' as const;
/** The retained operation rules are recipe 1.4.0's (contract 14.2); the engine reads a change in that shape. */
const ENGINE_FORMAT = 'urn:aihq:core:recipe:1.4.0' as const;

/** A change document (contract 4.2): today's authored operation kinds and editors under one 0.1.0 version (C22, C26). */
/** `config.entries` in a change: `set: [{ path, value }]` (or `{ path, input }` for a declared input) and `remove: [{ path }]`. */
export interface ChangeConfigEntries { set?: ({ path: string[]; value: Json } | { path: string[]; input: string })[]; remove?: { path: string[] }[] }
export interface ChangeOperation { id: string; purpose: string; kind: Recipe['operations'][number]['kind']; scope: 'project' | 'user'; requires: string[]; checks: string[]; [field: string]: Json }
export interface Change {
  schema: typeof CHANGE; id: string; description: string; inputs: Recipe['inputs']; materials: Recipe['materials'];
  targets: ('project' | 'user')[]; prerequisites: Recipe['prerequisites']; operations: ChangeOperation[]; checks: { [field: string]: Json }[];
}
/** A change acquired by reference: one local, HTTPS or exact-GitHub-commit archive member and its material closure. */
export type ChangeReference = MaterialRecipeReference;

const bounded = (value: unknown): unknown => cloneJsonValueStructureV1(value, 'change', 32, 1_000_000);
type Data = Record<string, unknown>;
/** The contract's root names onto the engine's: `user` is the home folder. */
const engineTarget = (target: Data): Data => ({ ...target, root: target.root === 'user' ? 'userHome' : target.root });

/**
 * The change as the one engine reads it (recipe 1.4.0 shape): roots renamed, and `config.entries` `set`/`remove` lowered
 * to the engine's entries, sets first, in order. Operations in `skipped`, and every operation that waits for one of them,
 * are left out. Identity is always taken over the change document itself, never over this shape.
 */
export function engineRecipe(change: Change, skipped: ReadonlySet<string> = new Set()): Recipe {
  const document = change as unknown as Data & { operations: Data[]; checks: Data[] };
  const left = new Set(skipped);
  for (let grew = true; grew;) {
    grew = false;
    for (const op of document.operations) if (!left.has(op.id as string) && (op.requires as string[]).some(id => left.has(id))) { left.add(op.id as string); grew = true; }
  }
  const operations = document.operations.filter(op => !left.has(op.id as string)).map(op => {
    const out: Data = { ...op };
    if (out.target) out.target = engineTarget(out.target as Data);
    if (out.cwd) out.cwd = engineTarget(out.cwd as Data);
    if (op.kind === 'config.entries') {
      const { set = [], remove = [], ...rest } = out as Data & ChangeConfigEntries;
      return { ...rest, entries: [...set.map(entry => ({ path: entry.path, action: 'set',
        value: 'input' in entry ? { input: entry.input } : { literal: entry.value } })), ...remove.map(entry => ({ path: entry.path, action: 'remove' }))] };
    }
    return out;
  });
  const checks = document.checks.map(check => ({ ...check, ...(check.target ? { target: engineTarget(check.target as Data) } : {}),
    ...(check.cwd ? { cwd: engineTarget(check.cwd as Data) } : {}) }));
  return { ...document, schema: ENGINE_FORMAT, operations, checks } as unknown as Recipe;
}
/** The operations a skip leaves out: the skipped ones and everything that waits for them, in change order. */
export function leftOut(change: Change, skipped: ReadonlySet<string>): string[] {
  const kept = new Set(engineRecipe(change, skipped).operations.map(op => op.id));
  return change.operations.map(op => op.id).filter(id => !kept.has(id));
}
/** An engine problem path inside a config edit, named in the change's own `set`/`remove` terms. */
function changePath(change: Change, path: string): string {
  const match = /^\/operations\/(\d+)\/entries\/(\d+)(.*)$/.exec(path);
  if (!match) return path;
  const op = (change.operations[Number(match[1])] ?? {}) as ChangeConfigEntries;
  const at = Number(match[2]); const sets = op.set?.length ?? 0;
  const rest = match[3]!.replace(/^\/value$/, '');
  return at < sets ? `/operations/${match[1]}/set/${at}${rest}` : `/operations/${match[1]}/remove/${at - sets}${rest}`;
}

export type ChangeResult = { status: 'ok'; schema: typeof CHANGE } | Invalid | UnsupportedVersion;
/** Reads one change: `ok`, `invalid` with problems, or `unsupported-version` for any other format id. Never throws. */
export function validateChange(value: unknown): ChangeResult {
  let safe: unknown;
  try { safe = bounded(value); }
  catch { return { status: 'invalid', problems: [{ path: '', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data within 1,000,000 bytes.' }] }; }
  const id = safe && typeof safe === 'object' && !Array.isArray(safe) ? (safe as { schema?: unknown }).schema : undefined;
  if (typeof id === 'string' && id !== CHANGE) return { status: 'unsupported-version', encountered: id, supported: [CHANGE] };
  const problems = schemaProblems(CHANGE, safe);
  if (problems) return { status: 'invalid', problems };
  const change = safe as Change;
  const empty = change.operations.flatMap((op, index) => op.kind === 'config.entries' && !(op as unknown as ChangeConfigEntries).set?.length &&
    !(op as unknown as ChangeConfigEntries).remove?.length ? [{ path: `/operations/${index}`, reason: 'entries-empty', message: 'A config.entries operation sets or removes at least one key.' }] : []);
  if (empty.length) return { status: 'invalid', problems: empty };
  const semantic = recipeSemantics(engineRecipe(change));
  if (semantic.length) return { status: 'invalid', problems: semantic.map(item => ({ path: changePath(change, item.path ?? ''), reason: item.reason, message: item.message })) };
  return { status: 'ok', schema: CHANGE };
}

export interface ChangeIdentity { status: 'ok'; changeIdentity: string; changeSha256: string; materials: MaterialIdentity[] }
export type DeriveChangeIdentityRequest = { change: Change } | { changeBytes: Uint8Array; reference: ChangeReference };
const refused = (reason: string, path: string, problems: Problem[] = []): Invalid =>
  ({ status: 'invalid', problems: problems.length ? problems : [{ path, reason, message: 'The change cannot be identified.' }] });

/**
 * The canonical identity of a change and its material closure (contract 4.2): `sha256:` over the change's canonical
 * digest and its sorted material identities. An inline change hashes its canonical JSON; a referenced change hashes
 * its exact bytes, which must match the reference. Pure Web Crypto; nothing is acquired.
 */
export async function deriveChangeIdentity(request: DeriveChangeIdentityRequest): Promise<ChangeIdentity | Invalid | UnsupportedVersion> {
  try {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return refused('request', '');
    const keys = Object.keys(request).sort().join(',');
    let change: Change; let changeSha256: string;
    if (keys === 'change') {
      const read = validateChange((request as { change: unknown }).change);
      if (read.status !== 'ok') return read;
      change = bounded((request as { change: unknown }).change) as Change;
      if (change.materials.some(item => !('source' in item))) return refused('material-closure', '/change/materials');
      try { checkedInlineMaterials(change.materials as never); }
      catch (error) { return refused(error instanceof MaterialCaptureError ? error.reason : 'materials', '/change/materials'); }
      changeSha256 = await sha256(new TextEncoder().encode(canonicalJson(change as never)));
    } else if (keys === 'changeBytes,reference') {
      const { changeBytes, reference } = request as { changeBytes: unknown; reference: unknown };
      if (!(changeBytes instanceof Uint8Array) || changeBytes.byteLength > 1_000_000) return refused('change-bytes', '/changeBytes');
      let pinned: ChangeReference;
      try { pinned = bounded(reference) as ChangeReference; checkedReference(pinned); }
      catch (error) { return refused(error instanceof MaterialCaptureError ? error.reason : 'reference', '/reference'); }
      const bytes = new Uint8Array(changeBytes);
      changeSha256 = await sha256(bytes);
      if (bytes.byteLength !== pinned.byteLength || changeSha256 !== pinned.sha256) return refused('change-bytes-mismatch', '/changeBytes');
      let parsed: unknown;
      try { parsed = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'change'); }
      catch { return refused('strict-json', '/changeBytes'); }
      const read = validateChange(parsed);
      if (read.status !== 'ok') return read;
      change = parsed as Change;
      if (canonicalJson(recipeIdentityDescriptor(changeSha256, change.materials).materials) !==
          canonicalJson(recipeIdentityDescriptor(changeSha256, pinned.materials).materials)) return refused('material-closure', '/reference/materials');
    } else return refused('request', '');
    const descriptor = recipeIdentityDescriptor(changeSha256, change.materials);
    return { status: 'ok', changeIdentity: `sha256:${await sha256(new TextEncoder().encode(canonicalJson(descriptor)))}`,
      changeSha256, materials: descriptor.materials };
  } catch { return refused('change', ''); }
}
