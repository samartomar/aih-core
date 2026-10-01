import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { disposableHome, disposableProject, installedRelease, inlinePolicyText } from './helpers.mjs';
import { authorPolicy, exportPolicy } from '../src/authoring.js';
import { createHost } from '../src/host.js';

disposableHome();

const inlinePolicy = inlinePolicyText();

test('prepare returns a serializable review and opaque session id; approved apply executes in the target', async () => {
  const project = disposableProject();
  const host = createHost({ projectRoot: project });
  const prepared = await host.prepareSession({ policyText: inlinePolicy });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal(typeof prepared.sessionId, 'string');
  assert.notEqual(prepared.sessionId, prepared.review.reviewDigest);
  assert.equal(JSON.stringify(prepared.review).length > 0, true);
  assert.equal('prepared' in prepared, false, 'live handles must never reach the UI');

  const applied = await host.applyApproved({
    sessionId: prepared.sessionId, reviewDigest: prepared.review.reviewDigest, origin: 'interactive'
  });
  assert.equal(applied.completion, 'complete', JSON.stringify(applied.diagnostics));
  assert.equal(
    readFileSync(join(project, 'TEAM.md'), 'utf8'),
    'Read the public consumer example notes.\n'
  );
});

test('apply with a mismatched digest is rejected and the preparation stays usable', async () => {
  const project = disposableProject();
  const host = createHost({ projectRoot: project });
  const prepared = await host.prepareSession({ policyText: inlinePolicy });
  assert.equal(prepared.status, 'ready');

  const rejected = await host.applyApproved({
    sessionId: prepared.sessionId, reviewDigest: '0'.repeat(64), origin: 'interactive'
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'digest-mismatch');

  const applied = await host.applyApproved({
    sessionId: prepared.sessionId, reviewDigest: prepared.review.reviewDigest, origin: 'interactive'
  });
  assert.equal(applied.completion, 'complete', JSON.stringify(applied.diagnostics));
});

test('a consumed or unknown session is lost and requires prepare/approve again', async () => {
  const project = disposableProject();
  const host = createHost({ projectRoot: project });
  const prepared = await host.prepareSession({ policyText: inlinePolicy });
  assert.equal(prepared.status, 'ready');
  const applied = await host.applyApproved({
    sessionId: prepared.sessionId, reviewDigest: prepared.review.reviewDigest, origin: 'interactive'
  });
  assert.equal(applied.completion, 'complete');

  const again = await host.applyApproved({
    sessionId: prepared.sessionId, reviewDigest: prepared.review.reviewDigest, origin: 'interactive'
  });
  assert.equal(again.status, 'lost');
  const unknown = await host.applyApproved({
    sessionId: '00000000-0000-0000-0000-000000000000', reviewDigest: '0'.repeat(64), origin: 'interactive'
  });
  assert.equal(unknown.status, 'lost');
});

test('a catalog-authored policy prepares and applies through the host with configured material roots', async () => {
  const { release, source, materialRoots } = await installedRelease();
  const item = release.items.find(candidate =>
    candidate.dependencies.requires.length === 0 &&
    Object.values(candidate.inputs).some(spec => spec.default !== undefined));
  assert.ok(item, 'catalog supplies a standalone item with a defaulted input');
  const [inputName] = Object.entries(item.inputs).find(([, spec]) => spec.default !== undefined);
  const authored = authorPolicy({ release, mode: 'vibe', materialSource: source, selections: [
    { id: 'chosen', managementId: 'chosen-management', scope: item.scopes[0], itemId: item.id, configuration: {} }
  ] });
  assert.equal(authored.valid, true, JSON.stringify(authored.diagnostics));

  const project = disposableProject();
  const host = createHost({ projectRoot: project, materialRoots });
  const prepared = await host.prepareSession({ policyText: exportPolicy(authored.policy) });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal(prepared.review.effectiveOptions.inputs[`chosen/${inputName}`].origin, 'default');

  const applied = await host.applyApproved({
    sessionId: prepared.sessionId, reviewDigest: prepared.review.reviewDigest, origin: 'interactive'
  });
  assert.equal(applied.completion, 'complete', JSON.stringify(applied.diagnostics));
});

test('invalid policy text prepares nothing and carries diagnostics', async () => {
  const host = createHost({ projectRoot: disposableProject() });
  const prepared = await host.prepareSession({ policyText: '{broken' });
  assert.equal(prepared.status, 'invalid');
  assert.equal('sessionId' in prepared, false);
  assert.ok(prepared.diagnostics.length > 0);
});
