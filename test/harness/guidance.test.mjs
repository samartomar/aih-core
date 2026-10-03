import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveGuidance, subjectLabel, reasonLabel } from '../../dist/harness/guidance.mjs';
import { repairIndex } from '../../dist/harness/contracts.mjs';

const check = (target, reason, id = `${target}/version`, outcome = 'failed') =>
  ({ kind: 'check', target, reason, id, outcome, evidenceId: '/checks/3' });
const derive = (facts, platform = 'linux', extra = {}) => deriveGuidance({ kind: 'inspect', platform, facts, ...extra });
const text = items => JSON.stringify(items);

test('shipped labels and unknown facts cannot copy authored strings', () => {
  assert.equal(subjectLabel('curl'), 'curl'); assert.equal(subjectLabel('toString'), undefined);
  assert.equal(reasonLabel('certificate-chain'), 'Certificate chain rejected'); assert.equal(reasonLabel('constructor'), undefined);
  const items = derive([check('SENTINEL-c0ffee-secret', 'SENTINEL-c0ffee-secret')]);
  assert.equal(items[0].target, 'unknown'); assert.equal(items[0].reason, 'unrecognized-diagnostic');
  assert.equal(items[0].summary, 'Review the diagnostic and inspect again.');
  assert.doesNotMatch(text(items), /SENTINEL/);
  for (const target of ['docker', 'homebrew', 'node']) assert.equal(derive([check(target, 'SENTINEL-c0ffee-secret')])[0].summary, 'Review the diagnostic and inspect again.');
});

test('requested executable, broken install and unselected absence have distinct guidance', () => {
  const missing = derive([check('git', 'executable-missing', 'git/version', 'unavailable')]);
  assert.match(missing[0].summary, /Git.*PATH/); assert.match(text(missing), /approved installation|PATH correction/);
  assert.match(text(missing), /fresh shell/);
  assert.equal(derive([{ kind: 'tool', target: 'git', selection: 'unselected', state: 'absent', evidenceId: '/tools/0' }, check('git', 'executable-missing')]).length, 0);
  assert.match(derive([check('git', 'version-exit')])[0].summary, /version command failed/);
  const curl = derive([check('npm', 'executable-missing', 'npm/tls/os/registry.npmjs.org', 'unavailable')]);
  assert.equal(curl[0].id, 'missing-curl'); assert.equal(curl[0].target, 'curl');
  assert.deepEqual(curl[0].evidenceIds, ['/checks/3']); assert.doesNotMatch(text(curl), /npm|Node/);
});

test('Docker, Homebrew, npm/PATH and managed access are actionable on each explicit platform', () => {
  for (const platform of ['win32', 'darwin', 'linux', 'unknown']) {
    const docker = derive([check('docker', 'version-exit')], platform);
    assert.deepEqual(docker.map(item => item.audience), ['developer', 'administrator']);
    assert.match(text(docker), platform === 'win32' || platform === 'darwin' ? /Docker Desktop/ : /daemon/);
    if (platform === 'linux') assert.match(text(docker), /approved group membership/);
    assert.doesNotMatch(text(docker), /chmod|sudo|666/);
    const brew = derive([check('homebrew', 'executable-missing')], platform);
    if (platform === 'win32') { assert.match(text(brew), /not applicable/); assert.doesNotMatch(text(brew), /opt\/homebrew|linuxbrew/); }
    if (platform === 'darwin') { assert.match(text(brew), /\/opt\/homebrew/); assert.match(text(brew), /\/usr\/local/); }
    if (platform === 'linux') assert.match(text(brew), /\/home\/linuxbrew\/\.linuxbrew/);
    const npm = derive([{ kind: 'tool', target: 'node', state: 'runnable', selection: 'requested', evidenceId: '/tools/0' },
      check('npm', 'executable-missing'), { kind: 'observation', target: 'npm', id: 'npm/resolution', evidenceId: '/observations/1' }, check('bash', 'wsl-launcher')], platform);
    assert.match(text(npm), /Node.js is runnable/); assert.match(text(npm), /PATH evidence/); assert.match(text(npm), /reopen the shell/);
    assert.match(text(npm), /ambiguous Windows WSL launcher/);
    for (const reason of ['state-protection', 'state-unwritable', 'organization-permission-incomplete', 'authentication-required-or-denied', 'EACCES', 'EPERM']) {
      const access = derive([check('docker', reason)], platform);
      assert.deepEqual(access.map(item => item.audience), ['developer', 'administrator']);
      assert.match(text(access), /scope and action/); assert.match(text(access), /Elevation alone may not resolve/);
      assert.equal(access.flatMap(item => item.repairs).length, 0);
    }
    assert.equal(derive([{ kind: 'diagnostic', code: 'AUTHORITY_DENIED', reason: 'arbitrary', evidenceId: '/diagnostics/0' }], platform).length, 2);
  }
});

test('MCP certificate evidence is conditional Node guidance; connection/auth evidence has no trust repair', () => {
  const items = derive([check('mcp', 'certificate-chain', 'mcp/tls/1')]);
  assert.equal(items[0].id, 'mcp-node-trust'); assert.equal(items[1].audience, 'administrator');
  assert.match(text(items), /diagnostic Node TLS probe/); assert.match(text(items), /Confirm which runtime/); assert.match(text(items), /does not prove/);
  assert.deepEqual(items[0].repairs, [{ id: 'node-npm-ca', targets: ['node'], requiredInputs: [{ name: 'caFile', type: 'file', description: 'Certificate-only PEM file' }] }]);
  for (const reason of ['connection-failed', 'authentication-required-or-denied']) {
    assert.equal(derive([check('mcp', reason)]).flatMap(item => item.repairs).length, 0);
    assert.doesNotMatch(text(derive([check('mcp', reason)])), /node-npm-ca/);
    assert.match(text(derive([check('mcp', reason)])), /reachability/); assert.match(text(derive([check('mcp', reason)])), /proxy/);
  }
});

test('Node OS-trust is offered only for its supported origin and target; metadata drives every repair', () => {
  for (const platform of ['win32', 'darwin', 'linux', 'unknown']) {
    const npm = derive([check('npm', 'node-certificate-chain', 'npm/tls/node/registry.npmjs.org')], platform)[0];
    assert.deepEqual(npm.repairs.map(item => item.id), platform === 'unknown' ? [] : ['node-npm-ca', 'node-os-trust']);
    if (platform !== 'unknown') assert.deepEqual(npm.repairs[1].targets, ['node']);
    assert.equal(derive([check('npm', 'node-certificate-chain', 'npm/tls/node/private.invalid')], platform)[0].repairs.some(item => item.id === 'node-os-trust'), false);
    for (const definition of repairIndex.filter(item => ['user-tools-ca', 'jvm-ca'].includes(item.id))) {
      for (const target of definition.targets) {
        const item = derive([check(target, 'certificate-chain')], platform)[0];
        assert.equal(item.repairs.length, platform === 'unknown' ? 0 : 1);
        if (platform === 'unknown') continue;
        const repair = item.repairs[0];
        assert.equal(repair.id, definition.id); assert.deepEqual(repair.targets, [target]);
        assert.ok(definition.variants.some(variant => variant.os === platform && variant.targets.length === 1 && variant.targets[0] === target));
        assert.deepEqual(repair.requiredInputs, Object.entries(definition.inputs).filter(([, value]) => value.required).map(([name, value]) => ({ name, type: value.type, description: value.description })));
        if (definition.id === 'jvm-ca') assert.deepEqual(repair.requiredInputs.map(input => input.name), ['caFile', 'baselineStore']);
      }
    }
    assert.equal(derive([check('claude', 'certificate-chain')], platform)[0].repairs.length, 0);
  }
});

test('repair context restricts targets and suggestions; policy identifiers never classify tools', () => {
  const facts = [check(undefined, 'certificate-chain', 'trust/gradle-behavior')];
  const items = derive(facts, 'linux', { kind: 'run', useCase: 'repair', repair: { id: 'jvm-ca', targets: ['gradle'] } });
  assert.equal(items[0].target, 'gradle'); assert.deepEqual(items[0].repairs[0].targets, ['gradle']);
  assert.equal(derive(facts, 'linux', { kind: 'run', useCase: 'repair', repair: { id: 'jvm-ca', targets: ['maven'] } })[0].repairs.length, 0);
  const policy = derive([check(undefined, 'certificate-chain', 'trust/gradle-behavior')], 'linux', { kind: 'run', useCase: 'policy' });
  assert.equal(policy[0].target, 'policy'); assert.deepEqual(policy[0].repairs, []);
});

test('client loading stays unverified and interrupted results require fresh preparation', () => {
  for (const target of ['antigravity', 'zed']) {
    const item = derive([{ kind: 'observation', id: `${target}/loading`, target, evidenceId: '/observations/1' }])[0];
    assert.match(text(item), /does not verify native loading/); assert.match(text(item), /does not start/);
  }
  for (const value of ['invalid', 'blocked', 'cancelled', 'partial', 'incomplete', 'rejected']) {
    const item = derive([{ kind: 'status', value, evidenceId: '/status' }])[0];
    assert.equal(item.reason, value); assert.match(text(item), /fresh review/); assert.match(text(item), /do not reuse.*or replay/);
  }
  const many = derive(Array.from({ length: 300 }, () => check('git', 'version-exit')));
  assert.equal(many.length, 256); assert.equal(many.at(-1).id, 'guidance-omitted'); assert.match(many.at(-1).summary, /45.*omitted/);
});
