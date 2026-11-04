// Enterprise admission of plan requests (contract 11, D108): the facts admission compares, from the checked plan, the
// content documents it was made from and the claims it makes. Nothing is inferred: a step names its item, items or
// framework, and an item's kind and framework come from the content documents, or stay unknown.
import { admitPlan, obligations, type ClaimFacts, type DeclaredTarget, type Denial, type Obligations, type StepFacts, type Subject } from './admission.js';
import { declaredTarget, enterpriseMode, organizationReview, projected, readOrganization, recordedClaims, type EnterpriseControls,
  type EnterpriseState, type OrganizationReview } from './host.js';
import type { CheckedStep } from '../plan/request.js';
import type { Invalid, Origin, PlanRequest, Refusal } from '../plan/types.js';

/** Each content item's kind and framework, by item id, as the request's content documents state them. */
export function contentFacts(request: PlanRequest): Map<string, { kind: string | null; framework: string | null }> {
  const facts = new Map<string, { kind: string | null; framework: string | null }>();
  for (const content of request.contents as unknown as { framework?: { id?: unknown }; items?: { id?: unknown; kind?: unknown }[] }[]) {
    const framework = typeof content?.framework?.id === 'string' ? content.framework.id : null;
    for (const item of Array.isArray(content?.items) ? content.items : [])
      if (item && typeof item.id === 'string') facts.set(item.id, { kind: typeof item.kind === 'string' ? item.kind : null, framework });
  }
  return facts;
}

/** What a plan step names (D108): its item or items, or its framework and the items it says it contains. */
function subjectsOf(raw: Record<string, unknown>, facts: ReturnType<typeof contentFacts>): Subject[] {
  const ids = [...(typeof raw.item === 'string' ? [raw.item] : []), ...(Array.isArray(raw.items) ? raw.items.filter((id): id is string => typeof id === 'string') : [])];
  const subject = (item: string): Subject => ({ item, framework: facts.get(item)?.framework ?? null, kind: facts.get(item)?.kind ?? null });
  if (ids.length) return [...new Set(ids)].map(subject);
  const framework = typeof raw.framework === 'string' ? raw.framework : null;
  const contained = Array.isArray(raw.contains) ? raw.contains.filter((id): id is string => typeof id === 'string') : [];
  if (contained.length) return contained.map(item => ({ ...subject(item), framework: framework ?? facts.get(item)?.framework ?? null }));
  return [{ item: null, framework, kind: null }];
}

export interface PlanClaim { key: string; managementId: string; scope: 'project' | 'user'; cli: string | null }

/** The facts of the claims a plan makes, for fulfilment. */
export function plannedClaims(claims: PlanClaim[], planClis: string[], origin: Origin, facts: ReturnType<typeof contentFacts>): ClaimFacts[] {
  return claims.map(claim => {
    const known = facts.get(claim.managementId);
    return { key: claim.key, managementId: claim.managementId, scope: claim.scope, clis: claim.cli !== null ? [claim.cli] : [...planClis], origin,
      items: known ? [claim.managementId] : [], kind: known?.kind ?? null, framework: known?.framework ?? (known ? null : claim.managementId), change: null };
  });
}

/** The Enterprise context of a request: `undefined` in Vibe mode. */
export interface Enterprise { state: Omit<EnterpriseState, 'root' | 'project'>; target: DeclaredTarget }
export async function enterpriseContext(mode: unknown, scope: 'project' | 'user', target: PlanRequest['target'] | undefined,
    controls: EnterpriseControls & { signal?: AbortSignal }): Promise<Enterprise | undefined | Refusal | Invalid> {
  const chosen = enterpriseMode(mode, controls);
  if (typeof chosen !== 'string') return chosen;
  if (chosen === 'vibe') return undefined;
  const declared = declaredTarget(scope, target);
  if ('status' in declared) return declared;
  const bound = await readOrganization(controls);
  if ('status' in bound) return bound;
  return { state: { bound, target: declared }, target: declared };
}

/** Admission and projected fulfilment of one plan at its place (C57, C71). */
export function admitPlanRequest(enterprise: Enterprise, request: PlanRequest, steps: CheckedStep[], origin: Origin, claims: PlanClaim[],
    released: string[], root: string, project: string | null): { denials: Denial[]; review: OrganizationReview; results: Obligations } {
  const facts = contentFacts(request);
  const stepFacts: StepFacts[] = steps.filter(step => !step.skipped).flatMap(step => step.lowered.managementIds.map(managementId => ({
    step: step.index, managementId, scope: step.lowered.root === 'project' ? 'project' as const : 'user' as const,
    clis: step.lowered.kind === 'plugin' ? [step.lowered.cli] : step.lowered.review.clis?.length ? [...step.lowered.review.clis] : [null],
    subjects: subjectsOf(request.plan.plan[step.index] as Record<string, unknown>, facts) })));
  const recipe = request.plan.recipe ? { id: request.plan.recipe.id, sha256: request.plan.recipe.sha256, commit: request.plan.recipe.commit } : null;
  const organization = enterprise.state.bound.organization;
  const denials = admitPlan(organization, enterprise.target, { steps: stepFacts, data: request.plan.data, origin, recipe });
  const planClis = [...new Set((request.profiles as { id?: unknown }[]).map(profile => profile.id).filter((id): id is string => typeof id === 'string'))];
  const added = plannedClaims(claims, planClis, origin, facts).filter(claim => claim.scope === enterprise.target.scope);
  const after = projected(recordedClaims(root, enterprise.target.scope, project), new Set(released), added);
  const results = obligations(organization, enterprise.target, added, after);
  return { denials, results, review: organizationReview(enterprise.state.bound, enterprise.target, denials, results) };
}
