// Packed-consumer check: the installed support entry interprets current trust,
// and macOS session results. Runs inside an isolated consumer with a temporary HOME.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getGuidance, renderSupportMarkdown } from '@aihq/core/contracts';

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

const future = getGuidance({ kind: 'run', result: { ...read('run-result-1.2-partial'), schema: 'urn:aihq:core:run-result:1.9.0' } }, options);
assert.equal(future.diagnostics[0].code, 'SCHEMA_UNSUPPORTED');
console.log('packed support families passed');
