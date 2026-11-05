// Plan requests made from REAL @aihq/catalog output recorded in `recorded.json` (samartomar/aih-catalog commit
// 26df4c0, unreleased candidate 0.0.0-dev.1; see generate.mjs). The content, profiles, plans and render bytes are Catalog's
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
 * recorded `planRecipe` plans for exactly the recorded inputs (else a refusal, so Core records `chosen`).
 */
export const catalog = {
  version: recorded.producer.version,
  planRecipe(recipe, contents, recipeProfiles, choices, options) {
    const asked = canonical([recipe, contents, recipeProfiles, choices, options]);
    const match = Object.values(recorded.recipes).find(({ contents: recordedContents, recipeJson, choices: recordedChoices, options: recordedOptions, profiles: ids }) =>
      asked === canonical([JSON.parse(recipeJson), recordedContents, profiles.filter(profile => ids.includes(profile.id)), recordedChoices, recordedOptions]));
    return match ? structuredClone(match.plan) : { status: 'refused', code: 'not-recorded', reason: 'these planRecipe inputs were not recorded from the real Catalog' };
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

const recipeFiles = () => JSON.parse(gunzipSync(readFileSync(new URL('./recipe-files.json.gz', import.meta.url))).toString('utf8'));
const decoded = files => files.map(({ text, base64, ...entry }) => ({ ...entry, bytes: text === undefined ? Buffer.from(base64, 'base64') : Buffer.from(text, 'utf8') }));

/**
 * Catalog's real `planRecipe` plan of a recorded recipe as a plan request, with the bytes of the files it copies and the
 * recipe proof: `superpowers` (a Core-side FIXTURE recipe at user scope: the native plugin on Claude Code from the pinned
 * local marketplace the plan writes, and on Codex by marketplace name; one skill as items on Kiro), `egm` (Catalog's
 * draft `egm-base` at project scope) or `trio` (Catalog's `code-intelligence-trio` on linux-x64 at project scope, with
 * the qualifications it names).
 */
export function recipeRequest(name, project) {
  const { contents, plan, pluginJson, recipeJson, choices, options, profiles: ids, files } = recorded.recipes[name];
  const held = Array.isArray(files) ? files : recipeFiles()[name];
  const { scope, source, qualifications, ...rest } = options;
  return { schema: PLAN_REQUEST, scope, target: { project }, plan: structuredClone(plan), contents: structuredClone(contents),
    profiles: structuredClone(profiles.filter(profile => ids.includes(profile.id))), files: decoded(held),
    ...(qualifications ? { qualifications: structuredClone(qualifications) } : {}),
    recipeProof: { pluginJson, recipeJson, choices: structuredClone(choices), ...(Object.keys(rest).length ? { options: structuredClone(rest) } : {}) } };
}

/** Catalog's real codebase-memory-mcp data plan on `cell` (`windows-x64` or `linux-x64`) at project scope. */
export function cbmRequest(project, cell = 'windows-x64') {
  const { content, plans, files, qualifications } = recorded.cbm;
  return { schema: PLAN_REQUEST, scope: 'project', target: { project }, plan: structuredClone(plans[cell]), contents: [structuredClone(content)],
    profiles: structuredClone(profiles), files: withBytes(files), qualifications: structuredClone(qualifications) };
}
