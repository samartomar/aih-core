// Plan requests made from REAL @aihq/catalog output recorded in `recorded.json` (samartomar/aih-catalog commit
// 32db997, unreleased 0.1.0 candidate; see generate.mjs). The content, profiles, plans and render bytes are Catalog's
// own; only `renderStep` and `planRecipe` here replay the recorded results, so Core's tests need no Catalog install.
// Nothing here shows a client loading the result, a released Catalog, or a qualified AI setup.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export const recorded = JSON.parse(readFileSync(new URL('./recorded.json', import.meta.url), 'utf8'));
export const PLAN_REQUEST = 'urn:aihq:core:plan-request:0.1.0';
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const canonical = value => JSON.stringify(sorted(value));
export const profiles = Object.values(recorded.profiles).map(text => JSON.parse(text));
const renders = new Map(recorded.renders.map(entry => [entry.step, entry.result]));

/**
 * `controls.catalog`: Catalog's recorded `renderStep` results for exactly the recorded steps (else a refusal), and its
 * one recorded `planRecipe` plan for exactly the recorded inputs (else a refusal, so Core records `chosen`).
 */
export const catalog = {
  version: recorded.producer.version,
  planRecipe(recipe, contents, recipeProfiles, choices, options) {
    const { content, recipeJson, choices: recorded_, options: recordedOptions, profiles: ids, plan } = recorded.recipe;
    const same = canonical([recipe, contents, recipeProfiles, choices, options]) ===
      canonical([JSON.parse(recipeJson), [content], profiles.filter(profile => ids.includes(profile.id)), recorded_, recordedOptions]);
    return same ? structuredClone(plan) : { status: 'refused', code: 'not-recorded', reason: 'these planRecipe inputs were not recorded from the real Catalog' };
  },
  renderStep(step) {
    const result = renders.get(canonical(step));
    if (!result) return { status: 'refused', code: 'not-recorded', reason: 'this step was not recorded from the real Catalog' };
    return result.status === 'ok' ? { status: 'ok', sha256: result.sha256, bytes: new Uint8Array(Buffer.from(result.base64, 'base64')) } : result;
  }
};

const withBytes = files => files.map(({ text, ...entry }) => ({ ...entry, bytes: Buffer.from(text, 'utf8') }));

/** The real bring-your-own plan at `scope` as a Node API plan request (bytes on each `files` entry). */
export function byoRequest(scope, project, extra = {}) {
  const { content, files, plans } = recorded.byo;
  return { schema: PLAN_REQUEST, scope, target: { project }, plan: structuredClone(plans[scope]), contents: [structuredClone(content)],
    profiles: structuredClone(profiles), files: withBytes(files), inputs: { 'my-skills.mcp.filesystem': { FILESYSTEM_ROOT: '/work' } }, ...extra };
}
export const BYO_SECRET = 'exa-0123456789SECRET';
export const byoControls = (extra = {}) => ({ catalog, privateInputs: { 'my-skills.mcp.exa-web-search': { EXA_API_KEY: BYO_SECRET } }, ...extra });

/** A rule declaring a placeholder input, planned for Claude Code alone (`claude`) or with Codex (`shared`), at project scope. */
export function rulesRequest(name, project, team = 'platform') {
  const { content, files, plans } = recorded.rules;
  return { schema: PLAN_REQUEST, scope: 'project', target: { project }, plan: structuredClone(plans[name]), contents: [structuredClone(content)],
    profiles: structuredClone(profiles.filter(profile => plans[name].profiles.some(used => used.id === profile.id))), files: withBytes(files),
    inputs: { 'my-rules.rule.team': { TEAM: team } } };
}

/**
 * Catalog's real `planRecipe` plan of a recipe (a Core-side FIXTURE document) over its Superpowers data at user scope:
 * the native plugin on Claude Code and Codex by marketplace name, and one skill as items on Kiro, with the bytes of the
 * files it copies at the pinned upstream commit and the recipe proof.
 */
export function recipeRequest(project) {
  const { content, plan, pluginJson, recipeJson, choices, profiles: ids } = recorded.recipe;
  const files = JSON.parse(gunzipSync(readFileSync(new URL('./recipe-files.json.gz', import.meta.url))).toString('utf8'));
  return { schema: PLAN_REQUEST, scope: 'user', target: { project }, plan: structuredClone(plan), contents: [structuredClone(content)],
    profiles: structuredClone(profiles.filter(profile => ids.includes(profile.id))),
    files: files.map(({ text, base64, ...entry }) => ({ ...entry, bytes: text === undefined ? Buffer.from(base64, 'base64') : Buffer.from(text, 'utf8') })),
    recipeProof: { pluginJson, recipeJson, choices: structuredClone(choices) } };
}

/** Catalog's real codebase-memory-mcp data plan on `cell` (`windows-x64` or `linux-x64`) at project scope. */
export function cbmRequest(project, cell = 'windows-x64') {
  const { content, plans, files, qualifications } = recorded.cbm;
  return { schema: PLAN_REQUEST, scope: 'project', target: { project }, plan: structuredClone(plans[cell]), contents: [structuredClone(content)],
    profiles: structuredClone(profiles), files: withBytes(files), qualifications: structuredClone(qualifications) };
}
