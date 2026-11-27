// Enterprise admission of plan requests (contract 11, D108): the facts admission compares, from the checked plan, the
// content documents it was made from and the claims it makes. Nothing is inferred: a step names its item, items or
// framework, and an item's kind and framework come from the content documents, or stay unknown.
import { admitPlan, itemFacts, obligations, planSubjects, type ClaimFacts, type DeclaredTarget, type Denial, type ItemFacts, type Obligations,
  type StepFacts } from './admission.js';
import { declaredTarget, enterpriseMode, organizationReview, placeClaims, projected, readOrganization, type EnterpriseControls,
  type EnterpriseState, type OrganizationReview } from './host.js';
import type { CheckedStep } from '../plan/request.js';
import type { Invalid, Origin, PlanRequest, Refusal } from '../plan/types.js';

/** Each content item's kind and framework, by item id, as the request's content documents state them. */
export const contentFacts = (request: PlanRequest): ItemFacts => itemFacts(request.contents);

export interface PlanClaim { key: string; managementId: string; scope: 'project' | 'user'; cli: string | null }

/** The facts of the claims a plan makes, for fulfilment. */
export function plannedClaims(claims: PlanClaim[], planClis: string[], origin: Origin, facts: ItemFacts): ClaimFacts[] {
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
  // The same subjects a preview judges (C81 included), by plan step.
  const subjects = planSubjects(request.contents, request.plan.plan);
  const stepFacts: StepFacts[] = steps.filter(step => !step.skipped).flatMap(step => step.lowered.managementIds.map(managementId => ({
    step: step.index, managementId, scope: step.lowered.root === 'project' ? 'project' as const : 'user' as const,
    clis: step.lowered.kind === 'plugin' ? [step.lowered.cli] : step.lowered.review.clis?.length ? [...step.lowered.review.clis] : [null],
    subjects: subjects[step.index]! })));
  const recipe = request.plan.recipe ? { id: request.plan.recipe.id, sha256: request.plan.recipe.sha256, commit: request.plan.recipe.commit } : null;
  const organization = enterprise.state.bound.organization;
  const denials = admitPlan(organization, enterprise.target, { steps: stepFacts, data: request.plan.data, origin, recipe });
  const planClis = [...new Set((request.profiles as { id?: unknown }[]).map(profile => profile.id).filter((id): id is string => typeof id === 'string'))];
  const added = plannedClaims(claims, planClis, origin, facts);
  const after = projected(placeClaims(enterprise.target.scope, project), new Set(released), added);
  const results = obligations(organization, enterprise.target, added, after);
  return { denials, results, review: organizationReview(enterprise.state.bound, enterprise.target, denials, results) };
}
