// The organization document `urn:aihq:core:organization:0.1.0` (contract 11, C31, C35): content and change entries, the
// source rules and the organization's Scan signers. Portable: no host, network or filesystem effects.
import { findTool } from '../../harness/tool-registry.mjs';
import { cloneJsonValueStructureV1, parseStrictJsonObjectV1 } from '../internal/strict-json.js';
import { canonicalJson } from '../internal/canonical.js';
import { inputAccepts } from '../internal/policy-validation.js';
import { schemaProblems } from '../plan/formats.js';
import { limitValue } from '../plan/limits.js';
import type { InputSpec, Json } from '../types.js';
import type { Problem } from '../plan/types.js';

export const ORGANIZATION = 'urn:aihq:core:organization:0.1.0' as const;

export type Obligation = 'permitted' | 'recommended' | 'required' | 'prohibited';
/** Narrowing shared by every entry: absent means every scope, client or repository. */
export interface Narrowing { scopes?: ('project' | 'user')[]; clients?: string[]; repositories?: string[] }
/** A content selector (C31): every named field must match; `recipe` matches only a proven origin (C44). */
export interface ContentSelector { item?: string; kind?: string; framework?: string; recipe?: { id: string; sha256?: string; commit?: string } }
export interface ContentEntry extends Narrowing { id: string; obligation: Obligation; content: ContentSelector }
export type InputPermission = { allowDeclared: true } | { fixed: Json } | { choices: Json[] };
/** A change entry: admits changes by identity, with input and lifecycle permissions (as recipe entries did). */
export interface ChangeEntry extends Narrowing {
  id: string; obligation: Obligation; change: { identity: string };
  inputs?: Record<string, InputPermission>; lifecycle?: { replace?: boolean; adopt?: boolean; remove?: boolean };
}
export type OrganizationEntry = ContentEntry | ChangeEntry;
/** A Scan signer in Scan's shape: `identity` is only a label; trust comes from the issuer and subject (contract 13). */
export interface ScanSigner { identity?: string; issuer: string; subject: string; extensions?: { [field: string]: Json } }
export interface Organization {
  schema: typeof ORGANIZATION; id: string; entries: OrganizationEntry[];
  sources?: { published?: { repository: string; commit?: string }[]; own?: { kinds?: string[] } };
  scanSigners?: { replace?: ScanSigner[]; add?: ScanSigner[] };
}
export type OrganizationResult = { status: 'ok'; value: Organization } | { status: 'invalid'; problems: Problem[] } |
  { status: 'unsupported-version'; encountered: string; supported: string[] };

export const isChangeEntry = (entry: OrganizationEntry): entry is ChangeEntry => 'change' in entry;
const invalid = (problems: Problem[]): OrganizationResult => ({ status: 'invalid', problems });

/** Reads an organization document: schema, bounds (1,000,000 bytes, depth 32), known clients, unique ids and contradictions. */
export function validateOrganization(value: unknown): OrganizationResult {
  let document: Organization;
  try { document = cloneJsonValueStructureV1(value, 'organization', limitValue('document-depth'), 16 * 1_048_576) as Organization; }
  catch { return invalid([{ path: '', reason: 'document-depth', message: 'The organization document is not bounded, plain strict JSON (at most 32 levels deep).' }]); }
  if (document === null || typeof document !== 'object' || Array.isArray(document))
    return invalid([{ path: '', reason: 'type', message: 'An organization document is an object.' }]);
  if (new TextEncoder().encode(canonicalJson(document as unknown as Json)).byteLength > limitValue('document-bytes'))
    return invalid([{ path: '', reason: 'document-bytes', message: 'The organization document is larger than 1,000,000 bytes.' }]);
  const schema = (document as { schema?: unknown }).schema;
  if (typeof schema === 'string' && schema !== ORGANIZATION && schema.startsWith('urn:aihq:core:organization'))
    return { status: 'unsupported-version', encountered: schema, supported: [ORGANIZATION] };
  const problems = schemaProblems(ORGANIZATION, document);
  if (problems) return invalid(problems);
  const found: Problem[] = [];
  const ids = new Set<string>();
  document.entries.forEach((entry, index) => {
    if (ids.has(entry.id)) found.push({ path: `/entries/${index}/id`, reason: 'duplicate-entry', message: `Entry \`${entry.id}\` is named twice.` });
    ids.add(entry.id);
    for (const [at, client] of (entry.clients ?? []).entries())
      if (findTool(client)?.via !== 'id') found.push({ path: `/entries/${index}/clients/${at}`, reason: 'client-unknown',
        message: `\`${client}\` is not a tool registry id.` });
  });
  // A required and a prohibited entry that select the same content on overlapping targets contradict each other (contract 11).
  document.entries.forEach((left, a) => document.entries.forEach((right, b) => {
    if (b <= a || ![left.obligation, right.obligation].includes('required') || ![left.obligation, right.obligation].includes('prohibited')) return;
    if (!targetsOverlap(left, right) || !selectsSame(left, right)) return;
    found.push({ path: `/entries/${b}`, reason: 'obligation-contradiction',
      message: `Entries \`${left.id}\` and \`${right.id}\` both require and prohibit the same content on overlapping targets.` });
  }));
  // A fixed or listed value must be one the change's input could hold; that is checked at admission against the input itself.
  return found.length ? invalid(found) : { status: 'ok', value: document };
}

/** Parses organization document bytes as strict UTF-8 JSON, then validates it. */
export function parseOrganization(bytes: Uint8Array): OrganizationResult {
  if (bytes.byteLength > limitValue('document-bytes'))
    return invalid([{ path: '', reason: 'document-bytes', message: 'The organization document is larger than 1,000,000 bytes.' }]);
  let parsed: unknown;
  try { parsed = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), 'organization'); }
  catch { return invalid([{ path: '', reason: 'strict-json', message: 'The organization document is not strict UTF-8 JSON.' }]); }
  return validateOrganization(parsed);
}

const overlaps = <T>(left: T[] | undefined, right: T[] | undefined, same: (a: T, b: T) => boolean = (a, b) => a === b): boolean =>
  !left || !right || left.some(a => right.some(b => same(a, b)));
const targetsOverlap = (left: Narrowing, right: Narrowing): boolean => overlaps(left.scopes, right.scopes) && overlaps(left.clients, right.clients) &&
  overlaps(left.repositories, right.repositories, (a, b) => a.toLowerCase() === b.toLowerCase());
/**
 * Whether two entries provably select the same content: the same change identity, or one content selector whose named
 * fields the other names with the same values (so whatever the narrower matches, the broader matches too). Selectors
 * that only might share content (a recipe against a kind) are not reported; admission still enforces the prohibition.
 */
function selectsSame(left: OrganizationEntry, right: OrganizationEntry): boolean {
  if (isChangeEntry(left) || isChangeEntry(right)) return isChangeEntry(left) && isChangeEntry(right) && left.change.identity === right.change.identity;
  const fields = (selector: ContentSelector) => Object.entries(selector).map(([key, value]) => [key, canonicalJson(value as Json)] as const);
  const within = (a: ContentSelector, b: ContentSelector) => fields(a).every(([key, value]) => fields(b).some(([other, text]) => other === key && text === value));
  return within(left.content, right.content) || within(right.content, left.content);
}

/** Whether a permission admits a value of this input (a fixed value or every choice must be one the input could hold). */
export function permissionFits(spec: InputSpec, permission: InputPermission): boolean {
  if ('fixed' in permission) return inputAccepts(spec, permission.fixed);
  if ('choices' in permission) return permission.choices.every(choice => inputAccepts(spec, choice));
  return true;
}
