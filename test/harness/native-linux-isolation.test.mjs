import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { isolationProbeNames, evaluateLinuxIsolation, inspectLinuxArguments, inspectLinuxProxyCapability, validIsolationProbes } from '../../src/harness/native/linux-isolation.mjs';

test('only the pinned bwrap and shell sites may carry the current vendor proxy capability', () => {
  const token = 'a'.repeat(32), digest = createHash('sha256').update(token).digest('hex');
  const spec = { sha256: digest, bwrap: '/usr/bin/bwrap', bash: '/usr/bin/bash' };
  const url = `http://user:${token}@localhost:3128`;
  assert.deepEqual(inspectLinuxProxyCapability({ executablePath: spec.bwrap, argv: ['bwrap', '--setenv', 'HTTP_PROXY', url] }, spec),
    { clean: true, bwrapArguments: 1, shellArguments: 0, unexpectedArguments: 0 });
  assert.deepEqual(inspectLinuxProxyCapability({ executablePath: spec.bash, argv: ['bash', '-c', `bwrap --setenv HTTP_PROXY ${url}`] }, spec),
    { clean: true, bwrapArguments: 0, shellArguments: 1, unexpectedArguments: 0 });
  const unexpected = inspectLinuxProxyCapability({ executablePath: '/usr/bin/claude', argv: ['claude', token] }, spec);
  assert.equal(unexpected.clean, false); assert.equal(unexpected.unexpectedArguments, 1);
  assert.equal(JSON.stringify(unexpected).includes(token), false);
  assert.equal(inspectLinuxProxyCapability({ executablePath: spec.bwrap, argv: [url.replace(token, 'b'.repeat(32))] }, spec).clean, false);
  assert.equal(inspectLinuxProxyCapability({ executablePath: spec.bash, argv: ['bash', token] }, spec).clean, false);
  assert.equal(inspectLinuxProxyCapability({ executablePath: spec.bwrap, argv: ['bwrap', '--setenv', 'UNEXPECTED', token] }, spec).clean, false);
  assert.equal(inspectLinuxProxyCapability({ executablePath: spec.bwrap, argv: ['bwrap', '--file', token] }, spec).clean, false);
  assert.equal(inspectLinuxProxyCapability({ executablePath: spec.bwrap, argv: [url] }, {}).clean, null);
});

const passed = () => Object.fromEntries(isolationProbeNames.map(name => [name, true]));
const proven = () => ({ probes: passed(), authenticated: true, clientBound: true, serverBound: true,
  namespaceSeparated: true, profileCompared: true, argumentsClean: true });

test('isolation is observed only with every authenticated denial, separated namespaces and a bound client and server', () => {
  assert.equal(evaluateLinuxIsolation(proven()), 'observed');
  for (const key of ['authenticated', 'clientBound', 'serverBound', 'profileCompared'])
    assert.equal(evaluateLinuxIsolation({ ...proven(), [key]: false }), 'unobservable', key);
  for (const key of ['namespaceSeparated', 'argumentsClean']) {
    assert.equal(evaluateLinuxIsolation({ ...proven(), [key]: null }), 'unobservable', key);
    assert.equal(evaluateLinuxIsolation({ ...proven(), [key]: false }), 'violated', key);
    assert.equal(evaluateLinuxIsolation({ ...proven(), [key]: 'false' }), 'unobservable', key);
  }
  assert.equal(evaluateLinuxIsolation(null), 'unobservable');
});

test('each probe separates proven access, proven denial and missing proof', () => {
  for (const name of isolationProbeNames) {
    const missing = passed(); delete missing[name];
    assert.equal(evaluateLinuxIsolation({ ...proven(), probes: missing }), 'unobservable', name);
    assert.equal(evaluateLinuxIsolation({ ...proven(), probes: { ...passed(), [name]: null } }), 'unobservable', name);
    assert.equal(evaluateLinuxIsolation({ ...proven(), probes: { ...passed(), [name]: false } }), 'violated', name);
    assert.equal(evaluateLinuxIsolation({ ...proven(), probes: { ...passed(), [name]: 1 } }), 'unobservable', name);
  }
  assert.equal(evaluateLinuxIsolation({ ...proven(), probes: { ...passed(), injected: true } }), 'unobservable');
  assert.equal(validIsolationProbes({ ...passed(), injected: true }), false);
  assert.equal(validIsolationProbes(null), false);
});

test('unauthenticated material never proves a violation', () => {
  assert.equal(evaluateLinuxIsolation({ ...proven(), authenticated: false, probes: { ...passed(), outsideReadDenied: false } }), 'unobservable');
  assert.equal(evaluateLinuxIsolation({ ...proven(), authenticated: false, namespaceSeparated: false }), 'unobservable');
  assert.equal(evaluateLinuxIsolation({ ...proven(), authenticated: false, argumentsClean: false }), 'unobservable');
});

test('argument inspection never returns argument text, refuses protected values and leaves oversize argv unproven', () => {
  const secrets = ['oauth-synthetic', 'otel-synthetic', 'evidence-synthetic', 'account-synthetic'];
  for (const value of secrets) {
    const result = inspectLinuxArguments(['/usr/bin/node', '--value=' + value], secrets);
    assert.equal(result.clean, false);
    assert.equal(JSON.stringify(result).includes(value), false);
  }
  assert.deepEqual(inspectLinuxArguments(['/usr/bin/node', '/fixed/runner.mjs'], secrets), { clean: true, inspected: 2 });
  assert.deepEqual(inspectLinuxArguments(new Array(4097).fill('x'), secrets), { clean: null, inspected: 0 });
  assert.deepEqual(inspectLinuxArguments(['x'.repeat(1024 * 1024 + 1)], secrets), { clean: null, inspected: 0 });
  assert.deepEqual(inspectLinuxArguments('argv', secrets), { clean: null, inspected: 0 });
  assert.deepEqual(inspectLinuxArguments(['/usr/bin/node'], ['']), { clean: true, inspected: 1 });
});
