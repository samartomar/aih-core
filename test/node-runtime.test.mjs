import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, apply } from '@aihq/core';
import { diagnose } from '@aihq/core/harness/runtime';

test('public preparation refuses simulated lower patch and unassessed major runtime boundaries', async () => {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'node');
  try {
    for (const version of ['26.12.0', '25.9.0', '27.0.0']) {
      Object.defineProperty(process.versions, 'node', { ...original, value: version });
      for (const request of [{}, { useCase: 'repair' }]) {
        const result = await prepare(request, { logging: 'off' });
        assert.equal(result.status, 'invalid');
        assert.equal(result.diagnostics[0].reason, 'node-runtime', version);
      }
    }
  } finally { Object.defineProperty(process.versions, 'node', original); }
});

test('a conflicting PATH Node does not replace the selected host or invent npm identity', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-node-path-'));
  const previous = process.env.PATH;
  try {
    writeFileSync(join(root, 'node'), '#!/bin/sh\nprintf "v27.0.0\\n"\n', { mode: 0o755 });
    writeFileSync(join(root, 'npm'), '#!/bin/sh\nprintf "12.2.1\\n"\n', { mode: 0o755 });
    process.env.PATH = root;
    const result = await diagnose({ requestId: 'conflict', targets: ['node', 'npm'], network: 'off' });
    assert.ok(result.observations.find(item => item.id === 'node/version').detail.includes(process.versions.node));
    assert.match(result.observations.find(item => item.id === 'node/resolution').detail, /1 other candidate/);
    assert.match(result.observations.find(item => item.id === 'npm/version').detail, /12\.2\.1/);
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostics identify the selected Node host even when PATH has no Node', async () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = '';
    const result = await diagnose({ requestId: 'runtime', targets: ['node', 'npm'], network: 'off' });
    assert.ok(result.observations.some(item => item.id === 'node/version' && item.detail.includes(process.versions.node)));
    assert.ok(result.observations.some(item => item.id === 'node/resolution' && /not found on PATH/.test(item.detail)));
    assert.equal(result.checks.find(item => item.id === 'npm/version').reason, 'executable-missing');
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

test('the selected Node host prepares and applies a public policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-node-runtime-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    const home = join(root, 'home'), project = join(root, 'project');
    mkdirSync(home); mkdirSync(project);
    process.env.HOME = home; process.env.USERPROFILE = home;
    const prepared = await prepare({ useCase: 'policy', target: { project }, policy: {
      schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
        id: 'runtime', managementId: 'runtime-fixture', scope: 'project', configuration: {}, requires: [],
        recipe: { inline: { schema: 'urn:aihq:core:recipe:1.0.0', id: 'runtime', description: 'Runtime fixture',
          inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [], operations: [{
            id: 'write', purpose: 'Write fixture', kind: 'file.write', scope: 'project',
            target: { root: 'project', segments: [{ literal: 'fixture.txt' }] }, content: { literal: 'ready' },
            requires: [], checks: []
          }] } }
      }]
    } }, { logging: 'off' });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    const result = await apply(prepared.prepared, { approved: true, origin: 'automation',
      reviewDigest: prepared.review.reviewDigest }, { logging: 'off' });
    assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
