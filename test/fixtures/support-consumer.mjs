// Packed-consumer check: the installed support entry interprets current trust,
// macOS session and targeted organization results. Runs inside an isolated
// consumer with a temporary HOME; the organization source is a local fake.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepare } from '@aihq/core';
import { getGuidance, renderSupportMarkdown } from '@aihq/core/support';

const read = name => JSON.parse(readFileSync(new URL(`./support-fixtures/${name}.json`, import.meta.url), 'utf8'));
const options = { platform: process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux' };
const wrap = (review, status) => ({ status, runId: 'support-consumer', review, diagnostics: [], record: { status: 'disabled', reason: 'logging-off' } });
function present(input) {
  const guidance = getGuidance(input, options), report = renderSupportMarkdown(input, options);
  assert.equal(guidance.status, 'complete', JSON.stringify(guidance.diagnostics));
  assert.equal(report.status, 'rendered', JSON.stringify(report.diagnostics));
  return { guidance, markdown: report.markdown.replace(/\\([&<>"'\\`*_[\]{}()#+.!|~\-])/g, '$1') };
}

const trustRun = present({ kind: 'run', result: read('run-result-1.2-partial') });
assert.match(trustRun.markdown, /Package: @aihq\/core 1\.0\.0-dev\.6/);
assert.equal(trustRun.guidance.items[0].reason, 'incomplete');
assert.equal(present({ kind: 'run', result: read('run-result-1.2-stale') }).guidance.items[0].reason, 'rejected');
assert.deepEqual(present({ kind: 'prepare', result: wrap(read('prepared-work-1.2-ready'), 'ready') }).guidance.items, []);
const trust14 = { ...read('prepared-work-1.2-partial'), schema: 'urn:aihq:core:prepared-work:1.4.0' };
assert.match(present({ kind: 'prepare', result: wrap(trust14, 'partial') }).markdown, /Status: partial/);

const macosRun = present({ kind: 'run', result: read('run-result-1.3-desktop') });
assert.ok(macosRun.guidance.items.some(item => item.evidenceIds.includes('/operations/0')));
assert.match(macosRun.markdown, /Status: incomplete/);
assert.match(present({ kind: 'prepare', result: wrap(read('prepared-work-1.3-desktop'), 'ready') }).markdown,
  /Package: @aihq\/core 1\.0\.0-dev\.9/);

const routes = read('organization-routes');
globalThis.fetch = async url => {
  const route = routes[new URL(String(url)).pathname];
  return route === undefined ? new Response('{"message":"Not Found"}', { status: 404 }) :
    new Response(JSON.stringify(route.body), { status: route.status, headers: { 'content-type': 'application/json' } });
};
const organization = await prepare({ useCase: 'policy', policy: read('organization-policy'), target: { project: process.env.SUPPORT_PROJECT },
  organizationSource: read('organization-source'), organizationTarget: { schema: 'urn:aihq:core:organization-target:1.0.0', client: 'codex' } },
  { logging: 'off' });
assert.equal(organization.status, 'ready', JSON.stringify(organization.diagnostics));
assert.equal(organization.review.schema, 'urn:aihq:core:prepared-work:1.5.0');
const targeted = present({ kind: 'prepare', result: organization });
assert.match(targeted.markdown, /Status: ready/);
assert.doesNotMatch(targeted.markdown, /Example-Org|project-guidance/);

const future = getGuidance({ kind: 'run', result: { ...read('run-result-1.2-partial'), schema: 'urn:aihq:core:run-result:1.9.0' } }, options);
assert.equal(future.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
console.log('packed support families passed');
