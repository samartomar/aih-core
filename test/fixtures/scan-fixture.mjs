// Core-side Scan FIXTURES for plan requests. The summaries and withdrawals come from scan-read-fixture/vectors.json:
// signed in a private TEST-ONLY Sigstore universe that only the bundled scan-read-fixture (installed as @aihq/scan)
// trusts. They drive Scan's real verify/match code offline; they are not Scan output and prove no production trust.
import { readFileSync } from 'node:fs';
import { ownRequest } from './plan-fixture.mjs';

export const vectors = JSON.parse(readFileSync(new URL('./scan-read-fixture/vectors.json', import.meta.url), 'utf8'));
export const A = vectors.signers.A, B = vectors.signers.B;

/** One `scans` entry: a signed summary, optionally with withdrawals and a complete inventory (Node API bytes). */
export function scanEntry(name, { withdrawn = [], inventory = null } = {}) {
  const summary = vectors.summaries[name];
  return { summary: summary.text, bundle: summary.bundle,
    withdrawn: withdrawn.length ? withdrawn.map(id => vectors.withdrawals[id].text) : null,
    withdrawnBundle: withdrawn.length ? withdrawn.map(id => vectors.withdrawals[id].bundle) : null,
    inventory };
}

/** The complete inventory of a fixture skill as Scan keyed it, with optional changed files. */
export const inventoryOf = (name, changed = {}) => Object.entries({ ...vectors.content[name], ...changed })
  .map(([path, text]) => ({ path, mode: '100644', bytes: Buffer.from(text) }));

/**
 * An own-content plan request for fixture skills whose content items carry the scan key Catalog would record.
 * `changed` replaces a skill's file text (the content then records the changed bytes, but keeps the scanned key);
 * `omit` leaves a skill file out of the plan's steps and `files`, so the plan's files no longer make up the tree.
 */
export function scannedRequest(project, names, scans, { changed = {}, omit = {}, clis = ['claude-code'] } = {}) {
  const skills = Object.fromEntries(names.map(name => [name, { ...vectors.content[name], ...changed[name] }]));
  const request = ownRequest(project, skills, clis);
  for (const item of request.contents[0].items) item.scanKey = vectors.keys[item.name];
  for (const [name, path] of Object.entries(omit)) {
    const sourcePath = `${name}/${path}`;
    request.plan.plan = request.plan.plan.filter(step => step.from?.sourcePath !== sourcePath);
    request.files = request.files.filter(file => file.sourcePath !== sourcePath);
  }
  return { ...request, scans };
}
