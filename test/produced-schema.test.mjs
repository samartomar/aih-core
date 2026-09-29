import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import preparedSchema from '../dist/schemas/prepared-work/1.0.0.json' with { type: 'json' };
import resultSchema from '../dist/schemas/run-result/1.0.0.json' with { type: 'json' };
import { prepare, apply } from '../dist/index.js';

test('public produced schemas accept a reviewed generic operation and its result', async () => {
  const project = mkdtempSync(join(tmpdir(), 'aih-produced-schema-'));
  const oldHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    const home = join(project, 'home'); mkdirSync(home);
    process.env.HOME = home; process.env.USERPROFILE = home;
    const policy = { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
      id: 'item', managementId: 'item', scope: 'project', configuration: {}, requires: [],
      recipe: { inline: { schema: 'urn:aihq:core:recipe:1.0.0', id: 'generic', description: 'Generic schema fixture',
        inputs: {}, materials: [], targets: ['project'], prerequisites: [], operations: [{
          id: 'edit', purpose: 'Edit one config entry', kind: 'config.entries', scope: 'project',
          target: { root: 'project', segments: [{ literal: 'config.json' }] }, format: 'json',
          entries: [{ path: ['enabled'], action: 'set', value: { literal: true } }], requires: [], checks: []
        }], checks: [] } }
    }] };
    const p = await prepare({ useCase: 'policy', policy, target: { project } }, { logging: 'off' });
    assert.equal(p.status, 'ready', JSON.stringify(p.diagnostics));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validatePrepared = ajv.compile(preparedSchema);
    const validateResult = ajv.compile(resultSchema);
    assert.equal(validatePrepared(p.review), true, JSON.stringify(validatePrepared.errors));
    const result = await apply(p.prepared, { approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest }, { logging: 'off' });
    assert.equal(result.completion, 'complete', JSON.stringify(result));
    assert.equal(validateResult(result), true, JSON.stringify(validateResult.errors));
  } finally {
    for (const [key, value] of Object.entries(oldHome)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(project, { recursive: true, force: true });
  }
});
