// Proving a recipe origin (contract 8.2, C25, C44). A plan's `recipe` is only a claim, because plans are not signed.
// Core checks the supplied `recipe.json` text against `recipe.sha256`, re-runs the caller's `planRecipe` with the
// proof's choices and options and the request's contents, profiles and qualifications, and compares the result with
// the plan byte for byte (canonical JSON). Only a match records the recipe origin. No proof, a mismatch or a failed
// reproduction records `chosen` ("origin not proven") and never blocks the install; only a malformed proof (`invalid`)
// or a proof with no `controls.catalog.planRecipe` (`catalog-required`) stops Prepare. A plan without `recipe`
// (`planInstall`) is always `chosen`.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../internal/canonical.js';
import { cloneJsonValueStructureV1, parseStrictJsonObjectV1 } from '../internal/strict-json.js';
import type { Json } from '../types.js';
import type { Invalid, Origin, PlanControls, PlanRequest, Refusal } from './types.js';

export const NOT_PROVEN = 'origin not proven';
export interface OriginResult { origin: Origin; note: string | null }

const unproven: OriginResult = { origin: 'chosen', note: NOT_PROVEN };
const invalid = (path: string, message: string): Invalid => ({ status: 'invalid', problems: [{ path, reason: 'recipe-proof', message }] });

export async function proveOrigin(request: PlanRequest, controls: PlanControls): Promise<OriginResult | Refusal | Invalid> {
  const recipe = request.plan.recipe;
  if (!recipe) return { origin: 'chosen', note: null };
  const proof = request.recipeProof as { pluginJson: string; recipeJson: string; choices: Json; options?: Record<string, Json> } | undefined;
  if (proof === undefined) return unproven;
  // The schema fixes the proof's fields; each recipe plugin file must itself be a strict JSON object.
  let document: Json;
  try { parseStrictJsonObjectV1(proof.pluginJson, 'plugin.json'); }
  catch { return invalid('/recipeProof/pluginJson', 'The recipe plugin\'s `plugin.json` is not a strict JSON object.'); }
  try { document = parseStrictJsonObjectV1(proof.recipeJson, 'recipe.json') as Json; }
  catch { return invalid('/recipeProof/recipeJson', 'The recipe\'s `recipe.json` is not a strict JSON object.'); }
  const planRecipe = controls.catalog?.planRecipe;
  if (typeof planRecipe !== 'function') return { status: 'refused', code: 'catalog-required',
    reason: `Proving the origin of recipe \`${recipe.id}\` needs the Catalog that made the plan (\`controls.catalog.planRecipe\`).` };
  if (createHash('sha256').update(proof.recipeJson, 'utf8').digest('hex') !== recipe.sha256) return unproven;
  const options: Record<string, Json> = { ...(proof.options ?? {}), scope: request.scope,
    source: { repository: recipe.repository, commit: recipe.commit },
    ...(request.qualifications?.length ? { qualifications: structuredClone(request.qualifications) } : {}) };
  let reproduced: unknown;
  try {
    reproduced = await planRecipe(document, structuredClone(request.contents), structuredClone(request.profiles),
      structuredClone(proof.choices), options);
    reproduced = cloneJsonValueStructureV1(reproduced, 'reproduced plan', 32, 16 * 1_048_576);
  } catch { return unproven; }
  if (canonicalJson(reproduced as Json) !== canonicalJson(request.plan as unknown as Json)) return unproven;
  return { origin: { recipe: { id: recipe.id, sha256: recipe.sha256, repository: recipe.repository, commit: recipe.commit },
    data: request.plan.data === null ? null : { ...request.plan.data } }, note: null };
}
