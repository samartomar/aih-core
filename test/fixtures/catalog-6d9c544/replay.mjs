// Plan requests made from REAL @aihq/catalog output recorded in `recorded.json` (samartomar/aih-catalog commit
// 6d9c544, unreleased 0.1.0 candidate; see generate.mjs). The content, profiles, plans and render bytes are Catalog's
// own; only `renderStep` here is a replay of the recorded results, so Core's tests need no Catalog install. Nothing here
// shows a client loading the result, a released Catalog, or a qualified AI setup.
import { readFileSync } from 'node:fs';

export const recorded = JSON.parse(readFileSync(new URL('./recorded.json', import.meta.url), 'utf8'));
export const PLAN_REQUEST = 'urn:aihq:core:plan-request:0.1.0';
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const canonical = value => JSON.stringify(sorted(value));
export const profiles = Object.values(recorded.profiles).map(text => JSON.parse(text));
const renders = new Map(recorded.renders.map(entry => [entry.step, entry.result]));

/** `controls.catalog`: Catalog's recorded `renderStep` results for exactly the recorded steps (else a refusal). */
export const catalog = {
  version: recorded.producer.version,
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

/** Catalog's real codebase-memory-mcp data plan on windows-x64 at project scope. */
export function cbmRequest(project) {
  const { content, plan, files, qualifications } = recorded.cbm;
  return { schema: PLAN_REQUEST, scope: 'project', target: { project }, plan: structuredClone(plan), contents: [structuredClone(content)],
    profiles: structuredClone(profiles), files: withBytes(files), qualifications: structuredClone(qualifications) };
}
