import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, apply } from '../dist/core/index.js';
import { parsePolicy } from '../dist/core/contracts.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import preparedSchema from '../dist/core/schemas/prepared-work/1.0.0.json' with { type: 'json' };
import resultSchema from '../dist/core/schemas/run-result/1.0.0.json' with { type: 'json' };
import { certificateFixture, organizationFixture, encode } from './evidence-fixtures.mjs';

const ajv = new Ajv2020({ strict: true });
const validReview = ajv.compile(preparedSchema), validResult = ajv.compile(resultSchema);

const scratch = mkdtempSync(join(tmpdir(), 'aih-policy-evidence-'));
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => {
  const home = join(scratch, 'home'); mkdirSync(home);
  process.env.HOME = home; process.env.USERPROFILE = home;
});
after(() => {
  for (const [key, value] of Object.entries(previousHome)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});
const association = path => ({ schema: 'urn:aihq:scan:evidence-association:1.0.0',
  scanId: `scan:sha256:${'a'.repeat(64)}`, location: { kind: 'file', path } });
const document = evidence => ({ schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe',
  ...(evidence === undefined ? {} : { evidence }), selections: [{
    id: 'guidance', managementId: 'guidance', scope: 'project', configuration: {}, requires: [],
    recipe: { inline: { schema: 'urn:aihq:core:recipe:1.0.0', id: 'guidance', description: 'Write guidance',
      inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [], operations: [{
        id: 'write', purpose: 'Write requested guidance', kind: 'file.write', scope: 'project', requires: [], checks: [],
        target: { root: 'project', segments: [{ literal: 'TEAM.md' }] }, content: { literal: 'Use the contribution guide.' }
      }] } }
  }] });
const authorization = p => ({ approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest });

test('unavailable optional evidence is reported while the requested setup still completes', async () => {
  const project = mkdtempSync(join(scratch, 'unavailable-'));
  const policy = document([association(join(scratch, 'missing.scan.json'))]);
  const parsed = parsePolicy(JSON.stringify(policy));
  assert.equal(parsed.valid, true, JSON.stringify(parsed.diagnostics));
  const controls = { logging: 'off', evidence: { acquire: true, trust: { keys: [], publishers: [] } } };
  const p = await prepare({ useCase: 'policy', policy: parsed.document, target: { project } }, controls);
  assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
  assert.equal(p.evidence[0].status, 'unverifiable');
  assert.equal(p.evidence[0].reason, 'unavailable');
  assert.equal(validReview(p.review), true, JSON.stringify(validReview.errors));
  const result = await apply(p.prepared, authorization(p), controls);
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  assert.equal(result.evidence[0].reason, 'unavailable');
  assert.equal(validResult(result), true, JSON.stringify(validResult.errors));
  assert.equal(readFileSync(join(project, 'TEAM.md'), 'utf8'), 'Use the contribution guide.');
});

test('omitted, refused and authenticated partial or opaque evidence never changes setup admission or completion', async () => {
  const partial = certificateFixture(), opaque = organizationFixture();
  assert.equal(JSON.parse(Buffer.from(partial.artifact.report.bytesBase64, 'base64')).completion, 'partial');
  const partialPath = join(scratch, 'partial.scan.json'), opaquePath = join(scratch, 'opaque.scan.json');
  const malformedPath = join(scratch, 'malformed.scan.json'), changedPath = join(scratch, 'changed.scan.json');
  writeFileSync(partialPath, partial.bytes); writeFileSync(opaquePath, opaque.bytes); writeFileSync(malformedPath, '{bad');
  const changed = structuredClone(partial.artifact); changed.annexes[0].bytesBase64 = 'eA=='; writeFileSync(changedPath, encode(changed));
  const selected = (path, scanId = partial.expectedScanId) => [{ ...association(path), scanId }];
  for (const [name, evidence, options, expected] of [
    ['omitted', undefined, undefined, 'not-supplied'],
    ['off', selected(partialPath), undefined, 'not-requested'],
    ['malformed', selected(malformedPath), { acquire: true, trust: partial.trust }, 'malformed'],
    ['changed', selected(changedPath), { acquire: true, trust: partial.trust }, 'byte-mismatch'],
    ['id-mismatch', selected(partialPath, `scan:sha256:${'0'.repeat(64)}`), { acquire: true, trust: partial.trust }, 'id-mismatch'],
    ['unknown-publisher', selected(partialPath), { acquire: true, trust: { keys: [], publishers: [] } }, 'unknown-producer'],
    ['untrusted-key', selected(opaquePath, opaque.expectedScanId), { acquire: true, trust: { keys: [], publishers: [] } }, 'untrusted-key'],
    ['partial', selected(partialPath), { acquire: true, trust: partial.trust }, 'authenticated'],
    ['opaque', selected(opaquePath, opaque.expectedScanId), { acquire: true, trust: opaque.trust }, 'authenticated']
  ]) {
    const project = mkdtempSync(join(scratch, `${name}-`));
    const controls = { logging: 'off', ...(options ? { evidence: options } : {}) };
    const p = await prepare({ useCase: 'policy', policy: document(evidence), target: { project } }, controls);
    assert.equal(p.status, 'ready', `${name}: ${JSON.stringify(p)}`);
    assert.equal(p.evidence[0].reason ?? p.evidence[0].status, expected, name);
    const result = await apply(p.prepared, authorization(p), controls);
    assert.equal(result.completion, 'complete', `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.evidence[0].reason ?? result.evidence[0].status, expected, name);
    assert.equal(validResult(result), true, JSON.stringify(validResult.errors));
    assert.equal(readFileSync(join(project, 'TEAM.md'), 'utf8'), 'Use the contribution guide.');
  }
});

test('explicit distrust after review changes only the current evidence result', async () => {
  const f = certificateFixture(); const path = join(scratch, 'distrust.scan.json'); writeFileSync(path, f.bytes);
  const project = mkdtempSync(join(scratch, 'distrust-'));
  const p = await prepare({ useCase: 'policy', policy: document([{ ...association(path), scanId: f.expectedScanId }]),
    target: { project } }, { logging: 'off', evidence: { acquire: true, trust: f.trust } });
  assert.equal(p.status, 'ready'); assert.equal(p.evidence[0].status, 'authenticated');
  const result = await apply(p.prepared, authorization(p), { logging: 'off', evidence: { acquire: true, trust: { keys: [], publishers: [] } } });
  assert.equal(result.completion, 'complete'); assert.equal(result.evidence[0].reason, 'unknown-producer');
});
