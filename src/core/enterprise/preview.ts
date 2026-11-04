// `previewAdmission` (contract 11, C32): the enforced, advisory and fulfilment results of one plan or change request for a
// declared target, in one browser-safe call with no host effects. `installed` is the caller's copy of `list`'s inventory
// for that target; without it fulfilment counts only this request. A preview never proves a recipe origin, so a plan's
// named recipe reads `unknown` for obligations and fails closed for prohibitions, as an unproven origin does at Prepare.
import { canonicalJson } from '../internal/canonical.js';
import { recipeIdentityDescriptor } from '../internal/recipe-identity.js';
import { sha256 } from '../internal/sha256.js';
import { cloneJsonValueStructureV1 } from '../internal/strict-json.js';
import { findTool } from '../../harness/tool-registry.mjs';
import { validateFormat } from '../plan/formats.js';
import { admitChanges, admitPlan, obligations, type ChangeFacts, type ClaimFacts, type DeclaredTarget, type Denial, type Obligations,
  type StepFacts, type Subject } from './admission.js';
import { validateOrganization, type Organization } from './organization.js';
import type { Json } from '../types.js';
import type { Problem } from '../plan/types.js';

export interface PreviewAdmissionRequest {
  organization: unknown;
  /** A plan request or change request document (source bytes are not needed). */
  request: unknown;
  /** The declared client (registry id and surface) and repository; Core never infers them. */
  target?: { client?: { id: string; surface: 'cli' | 'ide' }; repository?: string };
  /** The caller's copy of `list`'s inventory for this target. */
  installed?: unknown;
}
export interface AdmissionPreview {
  admitted: boolean; denials: Denial[]; advisory: Obligations['advisory']; fulfilment: Obligations['fulfilment'];
  scanSigners: Organization['scanSigners'] | null;
}
export type PreviewAdmissionResult = { status: 'ok'; value: AdmissionPreview } | { status: 'invalid'; problems: Problem[] } |
  { status: 'unsupported-version'; encountered: string; supported: string[] };

const PLAN_REQUEST = 'urn:aihq:core:plan-request:0.1.0';
const CHANGE_REQUEST = 'urn:aihq:core:change-request:0.1.0';
const INVENTORY = 'urn:aihq:core:inventory:0.1.0';
const invalid = (path: string, reason: string, message: string): PreviewAdmissionResult => ({ status: 'invalid', problems: [{ path, reason, message }] });
type Doc = Record<string, unknown>;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export async function previewAdmission(input: PreviewAdmissionRequest): Promise<PreviewAdmissionResult> {
  let call: PreviewAdmissionRequest;
  try { call = cloneJsonValueStructureV1(input as unknown as Json, 'preview', 40, 64 * 1_048_576) as unknown as PreviewAdmissionRequest; }
  catch { return invalid('', 'strict-json', 'Expected bounded, plain strict JSON data.'); }
  if (!call || typeof call !== 'object' || Object.keys(call).some(key => !['organization', 'request', 'target', 'installed'].includes(key)))
    return invalid('', 'request', 'A preview is `{ organization, request, target?, installed? }`.');
  const read = validateOrganization(call.organization);
  if (read.status !== 'ok') return read.status === 'invalid' ? { status: 'invalid', problems: read.problems.map(item => ({ ...item, path: `/organization${item.path}` })) } : read;
  const organization = read.value;
  const format = validateFormat(call.request);
  if (format.status !== 'ok') return format.status === 'invalid' ? { status: 'invalid', problems: format.problems.map(item => ({ ...item, path: `/request${item.path}` })) } : format;
  if (format.schema !== PLAN_REQUEST && format.schema !== CHANGE_REQUEST) return invalid('/request/schema', 'request', 'The request is a plan request or a change request.');
  const request = call.request as Doc & { scope: 'project' | 'user'; target: Doc };
  const declared = targetOf(request.scope, call.target ?? { ...(request.target.client ? { client: request.target.client } : {}),
    ...(request.target.repository ? { repository: request.target.repository } : {}) } as PreviewAdmissionRequest['target']);
  if ('status' in declared) return declared;
  let recorded: ClaimFacts[] = [];
  if (call.installed !== undefined) {
    const inventory = validateFormat(call.installed);
    if (inventory.status !== 'ok' || inventory.schema !== INVENTORY) return invalid('/installed', 'installed', 'Pass the inventory `list` returned for this target.');
    recorded = installedClaims(call.installed as Doc, request.scope);
  }
  let denials: Denial[]; let added: ClaimFacts[];
  if (format.schema === PLAN_REQUEST) ({ denials, added } = previewPlan(organization, declared, request));
  else ({ denials, added } = await previewChanges(organization, declared, request));
  const keys = new Set(added.map(claim => claim.key));
  const after = [...recorded.filter(claim => !keys.has(claim.key)), ...added];
  const results = obligations(organization, declared, added, after);
  return { status: 'ok', value: { admitted: denials.length === 0, denials, advisory: results.advisory, fulfilment: results.fulfilment,
    scanSigners: organization.scanSigners ? structuredClone(organization.scanSigners) : null } };
}

function targetOf(scope: 'project' | 'user', target: PreviewAdmissionRequest['target']): DeclaredTarget | PreviewAdmissionResult {
  const client = target?.client;
  if (client !== undefined) {
    const found = client && typeof client === 'object' ? findTool(client.id) : undefined;
    if (!found || found.via !== 'id' || found.tool.surface !== client.surface) return invalid('/target/client', 'client', 'The client is a registry id with its surface.');
  }
  if (target?.repository !== undefined && (typeof target.repository !== 'string' || !target.repository)) return invalid('/target/repository', 'repository', 'The repository is a string.');
  return { scope, client: client ? { id: client.id, surface: client.surface } : null, repository: target?.repository ?? null };
}

/** The inventory's entries at this scope, one claim per recorded CLI claim. */
function installedClaims(inventory: Doc, scope: 'project' | 'user'): ClaimFacts[] {
  const entries = Array.isArray(inventory.entries) ? inventory.entries as Doc[] : [];
  return entries.filter(entry => entry.scope === scope).flatMap(entry => {
    const plan = entry.origin !== null && entry.origin !== undefined || strings(entry.items).length > 0;
    const claims = Array.isArray(entry.claims) && entry.claims.length ? entry.claims as { cli: string | null }[] : [{ cli: null }];
    return claims.map(claim => ({ key: `${String(entry.managementId)}\0${claim.cli ?? ''}`, managementId: String(entry.managementId), scope,
      clis: claim.cli ? [claim.cli] : strings(entry.clis), origin: (entry.origin ?? null) as ClaimFacts['origin'], items: strings(entry.items),
      kind: typeof entry.kind === 'string' ? entry.kind : null, framework: typeof entry.framework === 'string' ? entry.framework : null,
      // The inventory names no change identity: a change entry counts for no content entry, and fulfils no change entry here.
      change: plan ? null : 'unknown' }));
  });
}

function previewPlan(organization: Organization, target: DeclaredTarget, request: Doc): { denials: Denial[]; added: ClaimFacts[] } {
  const facts = new Map<string, { kind: string | null; framework: string | null }>();
  for (const content of (request.contents as Doc[] | undefined) ?? []) {
    const framework = typeof (content.framework as Doc | undefined)?.id === 'string' ? (content.framework as Doc).id as string : null;
    for (const item of (Array.isArray(content.items) ? content.items : []) as Doc[])
      if (typeof item.id === 'string') facts.set(item.id, { kind: typeof item.kind === 'string' ? item.kind : null, framework });
  }
  const plan = request.plan as Doc & { plan: Doc[]; data: { repository: string; commit: string } | null; recipe?: { id: string; sha256: string; commit: string } };
  const profiles = strings(((request.profiles as Doc[] | undefined) ?? []).map(profile => profile.id));
  const steps: StepFacts[] = [];
  const claims = new Map<string, ClaimFacts>();
  plan.plan.forEach((raw, index) => {
    const ids = [...(typeof raw.item === 'string' ? [raw.item] : []), ...strings(raw.items)];
    const owners = ids.length ? [...new Set(ids)] : typeof raw.framework === 'string' ? [raw.framework] : [];
    const subject = (item: string): Subject => ({ item, framework: facts.get(item)?.framework ?? null, kind: facts.get(item)?.kind ?? null });
    const contained = strings(raw.contains);
    const subjects: Subject[] = ids.length ? [...new Set(ids)].map(subject) : contained.length ? contained.map(item => ({ ...subject(item),
      framework: typeof raw.framework === 'string' ? raw.framework : facts.get(item)?.framework ?? null })) :
      [{ item: null, framework: typeof raw.framework === 'string' ? raw.framework : null, kind: null }];
    const scope = raw.root === 'project' ? 'project' as const : 'user' as const;
    const clis: (string | null)[] = typeof raw.cli === 'string' ? [raw.cli] : strings(raw.clis).length ? strings(raw.clis) : [null];
    for (const managementId of owners) {
      steps.push({ step: index, managementId, scope, clis, subjects });
      for (const cli of clis) {
        const key = `${managementId}\0${cli ?? ''}`;
        const known = facts.get(managementId);
        if (scope === target.scope && !claims.has(key)) claims.set(key, { key, managementId, scope, clis: cli ? [cli] : profiles, origin: 'chosen',
          items: known ? [managementId] : [], kind: known?.kind ?? null, framework: known?.framework ?? (known ? null : managementId), change: null });
      }
    }
  });
  const recipe = plan.recipe ? { id: plan.recipe.id, sha256: plan.recipe.sha256, commit: plan.recipe.commit } : null;
  const denials = admitPlan(organization, target, { steps, data: plan.data, origin: 'chosen', recipe });
  return { denials, added: [...claims.values()].map(claim => recipe ? { ...claim, claimed: recipe } : claim) };
}

async function previewChanges(organization: Organization, target: DeclaredTarget, request: Doc): Promise<{ denials: Denial[]; added: ClaimFacts[] }> {
  const changes: ChangeFacts[] = [];
  for (const entry of request.changes as (Doc & { managementId: string; inputs: Record<string, Json>; change?: Doc; reference?: { sha256: string; materials: never } })[]) {
    const change = entry.change as (Doc & { materials: never; inputs?: ChangeFacts['inputs'] }) | undefined;
    const descriptor = change ? recipeIdentityDescriptor(await sha256(new TextEncoder().encode(canonicalJson(change as unknown as Json))), change.materials) :
      recipeIdentityDescriptor(entry.reference!.sha256, entry.reference!.materials);
    const identity = `sha256:${await sha256(new TextEncoder().encode(canonicalJson(descriptor as unknown as Json)))}`;
    changes.push({ managementId: entry.managementId, identity, scope: request.scope as 'project' | 'user', inputs: change?.inputs ?? {},
      configuration: entry.inputs, privateInputs: [], lifecycle: ((request.resolutions as Doc[] | undefined) ?? [])
        .filter(item => item.managementId === entry.managementId && item.choice !== 'skip').map(item => item.choice as 'replace' | 'adopt') });
  }
  const denials = admitChanges(organization, target, changes);
  return { denials, added: changes.map(change => ({ key: change.managementId, managementId: change.managementId, scope: change.scope, clis: [],
    origin: null, items: [], kind: null, framework: null, change: change.identity })) };
}
