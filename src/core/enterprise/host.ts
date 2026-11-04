// Enterprise admission on the host (contract 11): read the caller-named organization source fresh at Prepare and again at
// Apply, check the declared target, collect the recorded claims of a place, and present the result in reviews and runs.
import { readGitHubPolicy, readLocalPolicy, type GitHubPolicySource, type LocalPolicySource } from '../../harness/runtime.mjs';
import { localPolicySourceLabel } from '../../harness/local-policy.mjs';
import { findTool } from '../../harness/tool-registry.mjs';
import { readOwnership } from '../internal/state.js';
import { sameProject } from '../plan/claims.js';
import { limitValue } from '../plan/limits.js';
import { parseOrganization, type Organization } from './organization.js';
import { obligations, type ClaimFacts, type DeclaredTarget, type Denial, type Obligations } from './admission.js';
import type { Invalid, OrganizationReview, Problem, Refusal } from '../plan/types.js';
export type { OrganizationReview } from '../plan/types.js';
import type { Json } from '../types.js';

export type OrganizationSource = GitHubPolicySource | LocalPolicySource;
/** What Enterprise needs from the controls: the organization source and, for a private GitHub repository, a token. */
export interface EnterpriseControls { organization?: OrganizationSource; authentication?: { kind: 'none' } | { kind: 'bearer'; token: string } }
/** An organization read at Prepare: the document and the identity Apply's fresh read must match. */
export interface BoundOrganization {
  source: OrganizationSource; authentication?: EnterpriseControls['authentication'];
  organization: Organization; contentDigest: string; resolvedCommit: string | null;
  label: Json;
}
/** What a run reports (C71): the actual fulfilment over the claims the run left. */
export interface OrganizationRun { id: string; fulfilment: Obligations['fulfilment'] }

/** The two Enterprise keys of a controls object, checked; `undefined` when they are malformed. */
export function enterpriseControls(controls: Record<string, unknown>): EnterpriseControls | undefined {
  const source = controls.organization;
  if (source !== undefined && (!source || typeof source !== 'object' || Array.isArray(source))) return undefined;
  const authentication = controls.authentication as EnterpriseControls['authentication'] | undefined;
  if (authentication !== undefined && !(authentication && typeof authentication === 'object' &&
      (authentication.kind === 'none' || authentication.kind === 'bearer' && typeof authentication.token === 'string'))) return undefined;
  return { ...(source ? { organization: source as OrganizationSource } : {}), ...(authentication ? { authentication } : {}) };
}

/** Enterprise applies only with `mode: 'enterprise'` and a named source; either one alone is not admitted. */
export function enterpriseMode(mode: unknown, controls: EnterpriseControls): Refusal | Invalid | 'vibe' | 'enterprise' {
  if (mode === 'enterprise' && !controls.organization) return { status: 'refused', code: 'organization-required',
    reason: 'An Enterprise request needs the organization source: pass it in `controls.organization` (`--org-file`, or `--org-repository`, `--org-path` and `--org-ref`).' };
  if (mode !== 'enterprise' && (controls.organization || controls.authentication))
    return { status: 'invalid', problems: [{ path: '/mode', reason: 'organization-vibe', message: 'A Vibe request takes no organization source; say `mode: "enterprise"`.' }] };
  return mode === 'enterprise' ? 'enterprise' : 'vibe';
}

/** The caller's declared target: the client (registry id and surface) and optionally the repository. Never inferred. */
export function declaredTarget(scope: 'project' | 'user', target: { client?: unknown; repository?: unknown } | undefined): DeclaredTarget | Refusal | Invalid {
  const client = target?.client as { id?: unknown; surface?: unknown } | undefined;
  const repository = target?.repository;
  if (repository !== undefined && (typeof repository !== 'string' || repository.length === 0 || repository.length > 512))
    return { status: 'invalid', problems: [{ path: '/target/repository', reason: 'repository', message: 'The repository is a non-empty string.' }] };
  if (client === undefined) return { scope, client: null, repository: (repository as string | undefined) ?? null };
  if (!client || typeof client !== 'object' || typeof client.id !== 'string' || !['cli', 'ide'].includes(client.surface as string) ||
      Object.keys(client).some(key => key !== 'id' && key !== 'surface'))
    return { status: 'invalid', problems: [{ path: '/target/client', reason: 'client', message: 'The client is `{ id, surface }`: a registry id and `cli` or `ide`.' }] };
  const found = findTool(client.id);
  if (!found || found.via !== 'id' || found.tool.surface !== client.surface)
    return { status: 'refused', code: 'tool-unknown', tool: client.id, reason: `\`${client.id}\` is not a registry tool with surface \`${String(client.surface)}\`.` };
  return { scope, client: { id: client.id, surface: client.surface as 'cli' | 'ide' }, repository: (repository as string | undefined) ?? null };
}

const isLocal = (source: OrganizationSource): source is LocalPolicySource => (source as { provider?: unknown }).provider === 'local';
async function readSource(source: OrganizationSource, controls: EnterpriseControls & { signal?: AbortSignal }) {
  return isLocal(source) ? readLocalPolicy(source, controls.signal ? { signal: controls.signal } : undefined) :
    readGitHubPolicy(source, { ...(controls.authentication ? { authentication: controls.authentication } : {}), ...(controls.signal ? { signal: controls.signal } : {}) });
}

/** Reads and checks the organization document now (Prepare). Nothing is cached: Apply reads it again. */
export async function readOrganization(controls: EnterpriseControls & { signal?: AbortSignal }): Promise<BoundOrganization | Refusal | Invalid> {
  const source = controls.organization!;
  const read = await readSource(source, controls);
  if (read.status === 'cancelled') return { status: 'refused', code: 'cancelled', reason: 'Preparation was cancelled.' };
  if (read.status === 'invalid') return { status: 'invalid', problems: [{ path: '/controls/organization', reason: read.reason, message: read.message }] };
  if (read.status !== 'read') return read.reason === 'response-bytes' ?
    { status: 'refused', code: 'limit-exceeded', limit: 'document-bytes', value: limitValue('document-bytes'), reason: read.message } :
    { status: 'refused', code: 'organization-unavailable', reason: `The organization document could not be read (${read.reason}): ${read.message}` };
  const parsed = parseOrganization(read.bytes);
  if (parsed.status === 'unsupported-version') return { status: 'invalid', problems: [{ path: '/controls/organization', reason: 'unsupported-version',
    message: `\`${parsed.encountered}\` is not an organization format this Core reads; it reads ${parsed.supported.join(', ')}.` }] };
  if (parsed.status === 'invalid') return { status: 'invalid', problems: parsed.problems.map((problem: Problem) => ({ ...problem, path: `/organization${problem.path}` })) };
  const resolvedCommit = 'resolvedCommit' in read ? read.resolvedCommit : null;
  const label: Json = isLocal(source) ? { ...localPolicySourceLabel(source) } :
    { provider: 'github', repository: `${source.repository.owner}/${source.repository.name}`, path: source.path,
      revision: { ...source.revision }, resolvedCommit };
  return { source, ...(controls.authentication ? { authentication: controls.authentication } : {}), organization: parsed.value,
    contentDigest: read.contentDigest, resolvedCommit, label };
}

/** Apply's fresh read (contract 11): `true` only when the same source still holds the same bytes (and commit). */
export async function stillHolds(bound: BoundOrganization, signal?: AbortSignal): Promise<boolean> {
  try {
    const read = await readSource(bound.source, { ...(bound.authentication ? { authentication: bound.authentication } : {}), ...(signal ? { signal } : {}) });
    return read.status === 'read' && read.contentDigest === bound.contentDigest &&
      ('resolvedCommit' in read ? read.resolvedCommit : null) === bound.resolvedCommit;
  } catch { return false; }
}

/**
 * The claims recorded at one place (contract 11 fulfilment): this scope's receipts for this project, each with its
 * recorded CLI, origin and content facts, and a change's identity from the members it holds.
 */
export function recordedClaims(root: string, scope: 'project' | 'user', project: string | null): ClaimFacts[] {
  let stored;
  try { stored = readOwnership(root).value; } catch { return []; }
  const claims: ClaimFacts[] = [];
  for (const item of Object.values(stored.items ?? {})) {
    if (item.scope !== scope) continue;
    const plan = item.plan;
    if (plan) {
      if (scope === 'user' && !sameProject(plan, project)) continue;
      claims.push({ key: item.managementId, managementId: plan.managementId ?? item.managementId, scope, clis: plan.cli ? [plan.cli] : [...plan.clis],
        origin: plan.origin, items: [...plan.items], kind: plan.kind ?? null, framework: plan.framework ?? null, change: null });
      continue;
    }
    const claim = item.claim;
    if (scope === 'user' && (claim?.project ?? null) !== project && !(claim === undefined && project === null)) continue;
    const owner = Object.values(stored.members).find(member => member.managementId === item.managementId ||
      (member.claims ?? []).some(entry => entry.scope === scope && entry.managementId === item.managementId));
    claims.push({ key: item.managementId, managementId: claim?.managementId ?? item.managementId, scope, clis: [], origin: null, items: [],
      kind: null, framework: null, change: owner?.recipeIdentity ?? 'unknown' });
  }
  // A change's claims may be recorded only on the members they hold (no item record): one claim per management id.
  const known = new Set(claims.map(claim => claim.key));
  for (const owner of Object.values(stored.members)) for (const claim of owner.claims ?? [{ managementId: owner.managementId, scope }]) {
    if (claim.scope !== scope || known.has(claim.managementId) || scope === 'user' && project !== null) continue;
    known.add(claim.managementId);
    claims.push({ key: claim.managementId, managementId: claim.managementId, scope, clis: [], origin: null, items: [], kind: null, framework: null,
      change: owner.recipeIdentity });
  }
  return claims;
}

/** The claims after a request (C71): what is recorded, minus what it releases or replaces, plus what it makes. */
export function projected(recorded: ClaimFacts[], released: Set<string>, added: ClaimFacts[]): ClaimFacts[] {
  const replaced = new Set([...released, ...added.map(claim => claim.key)]);
  return [...recorded.filter(claim => !replaced.has(claim.key)), ...added];
}

export function organizationReview(bound: BoundOrganization, target: DeclaredTarget, denials: Denial[], results: Obligations): OrganizationReview {
  return { id: bound.organization.id, source: bound.label, contentDigest: bound.contentDigest,
    target: { scope: target.scope, client: target.client ? { ...target.client } : null, repository: target.repository },
    admitted: denials.length === 0, denials: denials.map(denial => ({ ...denial })), advisory: results.advisory, fulfilment: results.fulfilment,
    scanSigners: bound.organization.scanSigners ? structuredClone(bound.organization.scanSigners) as OrganizationReview['scanSigners'] : null };
}

/** What Apply needs to re-read authority and report actual fulfilment once the run is done. */
export interface EnterpriseState { bound: BoundOrganization; target: DeclaredTarget; root: string; project: string | null }
export function actualFulfilment(state: EnterpriseState): OrganizationRun {
  const after = recordedClaims(state.root, state.target.scope, state.project);
  return { id: state.bound.organization.id, fulfilment: obligations(state.bound.organization, state.target, [], after).fulfilment };
}

/** The blocked result's code and reason, naming the first entry or rule that denies (contract 14). */
export function denialReason(denials: Denial[]): string {
  const first = denials[0]!;
  const by = first.entry ? `entry \`${first.entry}\`` : `rule \`${first.rule}\``;
  return `The organization denies this request (${by}): ${first.message}${denials.length > 1 ? ` (${denials.length - 1} more in the review)` : ''}`;
}
