// Public-seam helpers for hook-group acceptance: host Prepare/Apply on disposable
// roots, validated against the published 1.1.0 prepared/result schemas.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { prepare, apply } from '../dist/core/index.js';
import preparedSchema from '../dist/core/schemas/prepared-work/1.1.0.json' with { type: 'json' };
import resultSchema from '../dist/core/schemas/run-result/1.1.0.json' with { type: 'json' };
import { SETTINGS, authorize, groupOf, hookOp, hookSelection, policy11, request } from './hook-group-fixture.mjs';

export const controls = { logging: 'off' };
const ajv = new Ajv2020({ allErrors: true, strict: true });
export const validPrepared = ajv.compile(preparedSchema);
export const validResult = ajv.compile(resultSchema);

/** Prepare, assert the public schema, then Apply with explicit approval. */
export async function run(s, policy, { resolutions, expect = 'ready', allowPartial, controls: extra } = {}) {
  const prepared = await prepare(request(s.project, policy, resolutions), { ...controls, ...extra });
  assert.equal(prepared.status, expect, JSON.stringify(prepared.diagnostics));
  if (prepared.review) assert.equal(validPrepared(prepared.review), true, JSON.stringify(validPrepared.errors));
  if (!prepared.prepared) return { prepared };
  const result = await apply(prepared.prepared, authorize(prepared, allowPartial === undefined ? {} : { allowPartial }), { ...controls, ...extra });
  assert.equal(validResult(result), true, JSON.stringify(validResult.errors));
  return { prepared, result };
}
export const prep = (s, policy, resolutions, extra) => prepare(request(s.project, policy, resolutions), { ...controls, ...extra });
export const only = prepared => prepared.review.operations[0];
export const opOf = (prepared, id) => prepared.review.operations.find(item => item.id === id);
export const ownershipRoots = s => {
  const dir = join(s.home, '.aih', 'core', 'ownership');
  return existsSync(dir) ? readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => ({ name, ...JSON.parse(readFileSync(join(dir, name), 'utf8')) })) : [];
};
export const guard = (name = 'guard-a') => policy11([hookSelection(name, [hookOp('add', name)])]);
export const neighbor = (name, extra = {}) => ({ matcher: 'Edit', hooks: [{ type: 'command', command: `mine/${name}.sh` }], ...extra });
export const compact = groups => `{"hooks":{"PreToolUse":${JSON.stringify(groups)}}}`;
export const guardWith = (name, extra) => policy11([hookSelection(name, [hookOp('add', name, { group: groupOf(name, extra) })])]);
export const groupsOf = s => JSON.parse(s.read(SETTINGS)).hooks.PreToolUse;
/** The per-operation observed digest exactly as reviewed: `targetBeforeSha256`. */
export const resolveOp = (prepared, selectionId, operationId, choice = 'replace') =>
  ({ selectionId, operationId, choice, observedSha256: opOf(prepared, `${selectionId}/${operationId}`).details.hookGroup.targetBeforeSha256 });
