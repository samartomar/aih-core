import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { nativeLifecycleIds, nativeVerificationDefinitions, validateNativeVerificationDefinition }
  from '../../src/harness/native/contracts.mjs';

const V10 = 'urn:aihq:harness:native-verification-definition:1.0.0';
const V11 = 'urn:aihq:harness:native-verification-definition:1.1.0';
const schemaUrl = name => new URL(`../../src/harness/schemas/native-verification-definition/${name}.json`, import.meta.url);
const clone = value => JSON.parse(JSON.stringify(value));
// 1.1.0 pins "--tools" next to its empty argument with open-ended prefix arrays, so tuple strictness is off here only.
const ajv = new Ajv2020({ strict: true, strictTuples: false, allErrors: true });
const schema10 = ajv.compile(JSON.parse(readFileSync(schemaUrl('1.0.0'), 'utf8')));
const schema11 = ajv.compile(JSON.parse(readFileSync(schemaUrl('1.1.0'), 'utf8')));

const SESSION = ['-p', '--verbose', '--output-format', 'stream-json'];
const vendor = () => ({
  ...clone(nativeVerificationDefinitions.find(d => d.client === 'claude')),
  schema: V11, id: 'claude-linux-x64-srt-test',
  platform: { os: 'linux', arch: 'x64', execution: 'native', osRelease: '24.04' },
  executableNames: ['claude'], sessionArgv: [...SESSION, '--tools', ''], lifecycleId: 'linux-srt.v1',
  isolation: { mechanism: 'vendor-runtime', observerId: 'anthropic-srt-linux.v1',
    documentation: ['https://code.claude.com/docs/en/sandbox-environments'] }
});
const legacyV11 = () => ({ ...clone(nativeVerificationDefinitions.find(d => d.client === 'claude')), schema: V11 });
const legacy = () => clone(nativeVerificationDefinitions.find(d => d.client === 'claude'));

// Both public seams (portable validator and published JSON Schema) must agree on every case.
const agree = (name, definition, expected, schemaValidator = definition.schema === V10 ? schema10 : schema11) => {
  assert.equal(validateNativeVerificationDefinition(definition).valid, expected, `validator: ${name}`);
  assert.equal(schemaValidator(definition), expected, `schema: ${name} ${JSON.stringify(schemaValidator.errors)}`);
};

test('the registered WSL2 sandbox admission binds its exact tested version and reviewed evidence', () => {
  const definition = nativeVerificationDefinitions.find(value => value.lifecycleId === 'linux-srt.v1');
  assert.ok(definition);
  agree('registered admission', definition, true);
  assert.deepEqual(definition.platform, { os: 'linux', arch: 'x64', execution: 'wsl2', osRelease: '6.18.33.2-microsoft-standard-WSL2' });
  assert.equal(definition.state, 'admitted');
  assert.deepEqual(definition.clientVersions, ['2.1.285']);
  assert.equal(definition.evidenceSha256, 'a8c226d1c56764a6c773268186a79a3643e5a5d0afc2acd9f9708faa9de50947');
  assert.deepEqual(definition.sessionArgv, [...SESSION, '--tools', '']);
  const cases = {
    'null evidence': d => { d.evidenceSha256 = null; },
    'malformed evidence': d => { d.evidenceSha256 = 'not-a-sha256'; },
    'unreviewed evidence': d => { d.evidenceSha256 = 'e'.repeat(64); },
    'extra exact version': d => { d.clientVersions.push('2.1.286'); },
    'different exact version': d => { d.clientVersions = ['2.1.286']; },
    'wildcard version': d => { d.clientVersions = ['2.1.*']; },
    'version range': d => { d.clientVersions = ['^2.1.285']; }
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const copy = clone(definition); mutate(copy); agree(name, copy, false);
  }
});

test('the published 1.1.0 admission rule is exactly the registered admitted definitions', () => {
  const published = JSON.parse(readFileSync(schemaUrl('1.1.0'), 'utf8'));
  const rules = published.allOf.filter(rule => rule.if?.properties?.state?.const === 'admitted');
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].if, { properties: { state: { const: 'admitted' } }, required: ['state'] });
  assert.deepEqual(Object.keys(rules[0].then), ['enum']);
  assert.deepEqual(rules[0].then.enum, clone(nativeVerificationDefinitions.filter(d => d.state === 'admitted')));
  const legacyRules = JSON.parse(readFileSync(schemaUrl('1.0.0'), 'utf8')).allOf
    .filter(rule => rule.if?.properties?.state?.const === 'admitted');
  assert.deepEqual(legacyRules.map(rule => rule.then), [false]);
  assert.ok(nativeVerificationDefinitions.filter(d => d.state === 'admitted').every(d => d.schema === V11));
});

test('schema and validator agree that admission is only an exact registered descriptor', () => {
  const registered = () => clone(nativeVerificationDefinitions.find(d => d.state === 'admitted'));
  const candidate = () => clone(nativeVerificationDefinitions.find(d => d.state === 'candidate'));
  agree('registered admission', registered(), true);
  const cases = {
    'unregistered id with reviewed evidence': d => { d.id = 'claude-linux-x64-wsl2-srt-2.1.286'; },
    'unregistered id with other evidence': d => { d.id = 'claude-linux-x64-srt-2.1.285'; d.evidenceSha256 = 'b'.repeat(64); },
    'osRelease': d => { d.platform.osRelease = '6.6.0-microsoft-standard-WSL2'; },
    'native execution': d => { d.platform.execution = 'native'; },
    'runtime pin': d => { d.runtimeMembers[0].sha256 = '0'.repeat(64); },
    'runtime length': d => { d.runtimeMembers[0].byteLength += 1; },
    'extra argv': d => { d.sessionArgv = [...d.sessionArgv, '--verbose']; },
    'version argv': d => { d.versionArgv = ['-v']; },
    'executable': d => { d.executableNames = ['claude', 'claude-code']; },
    'credential destination': d => { d.credentialDestination.path = '.claude/other.json'; },
    'isolation documentation': d => { d.isolation.documentation = ['https://code.claude.com/docs/en/sandbox-environments']; },
    'widened versions': d => { d.clientVersions = ['2.1.285', '2.1.286']; },
    'other evidence': d => { d.evidenceSha256 = 'b'.repeat(64); },
    'legacy schema': d => { d.schema = V10; }
  };
  for (const [name, mutate] of Object.entries(cases)) { const d = registered(); mutate(d); agree(name, d, false); }
  const promoted = candidate(); promoted.state = 'admitted'; promoted.evidenceSha256 = 'c'.repeat(64);
  agree('1.0.0 candidate claiming admission', promoted, false);
  const promotedV11 = { ...promoted, schema: V11 };
  agree('1.1.0 candidate claiming admission', promotedV11, false);
  const vendorAdmitted = vendor(); vendorAdmitted.state = 'admitted'; vendorAdmitted.evidenceSha256 = 'd'.repeat(64);
  agree('unregistered vendor profile claiming admission', vendorAdmitted, false);
  const demoted = registered(); demoted.state = 'candidate'; demoted.evidenceSha256 = null;
  agree('registered profile as an unadmitted candidate', demoted, true);
});

test('definition 1.1.0 accepts the fixed Linux vendor-runtime profile in native and wsl2 execution', () => {
  agree('vendor', vendor(), true);
  const wsl = vendor(); wsl.platform.execution = 'wsl2';
  agree('vendor wsl2', wsl, true);
  assert.ok(nativeLifecycleIds.includes('linux-srt.v1'));
});

test('definition 1.1.0 continues to represent the existing mechanisms; 1.0.0 behavior is unchanged', () => {
  agree('existing windows candidate as 1.1.0', legacyV11(), true);
  agree('legacy 1.0.0', legacy(), true);
  const vendorV10 = { ...vendor(), schema: V10 };
  agree('1.0.0 with vendor values', vendorV10, false);
  const lifecycleV10 = legacy(); lifecycleV10.platform = vendor().platform; lifecycleV10.lifecycleId = 'linux-srt.v1';
  agree('1.0.0 with linux-srt lifecycle', lifecycleV10, false);
  const emptyV10 = legacy(); emptyV10.sessionArgv = [...SESSION, '--tools', ''];
  agree('1.0.0 with empty argument', emptyV10, false);
  const toolsV10 = legacy(); toolsV10.sessionArgv = [...SESSION, '--tools=Read'];
  agree('1.0.0 --tools= stays accepted', toolsV10, true);
});

test('vendor-runtime requires its exact observer, platform, lifecycle and https documentation together', () => {
  const cases = {
    'wrong observer': d => { d.isolation.observerId = 'anthropic-srt-linux.v2'; },
    'null observer': d => { d.isolation.observerId = null; },
    'arbitrary vendor name': d => { d.isolation.observerId = 'other-vendor.v1'; },
    'no documentation': d => { d.isolation.documentation = []; },
    'http documentation': d => { d.isolation.documentation = ['http://example.com/doc']; },
    'non-url documentation': d => { d.isolation.documentation = ['not a url']; },
    'empty https authority': d => { d.isolation.documentation = ['https://']; },
    'space in documentation authority': d => { d.isolation.documentation = ['https://bad host/doc']; },
    'NUL in documentation': d => { d.isolation.documentation = ['https://example.com/\0']; },
    'posix lifecycle': d => { d.lifecycleId = 'posix-group.v1'; },
    'windows lifecycle': d => { d.lifecycleId = 'windows-job.v1'; },
    'windows platform': d => { d.platform.os = 'win32'; },
    'darwin platform': d => { d.platform.os = 'darwin'; },
    'arm64 platform': d => { d.platform.arch = 'arm64'; },
    'unregistered mechanism': d => { d.isolation.mechanism = 'vendor-runtime-2'; }
  };
  for (const [name, mutate] of Object.entries(cases)) { const d = vendor(); mutate(d); agree(name, d, false); }
});

test('linux-srt.v1 is only valid together with the vendor-runtime mechanism', () => {
  for (const isolation of [
    { mechanism: 'none', observerId: null, documentation: [] },
    { mechanism: 'client-native', observerId: 'claude-managed.v1', documentation: ['https://example.com/doc'] }
  ]) { const d = vendor(); d.isolation = isolation; d.sessionArgv = [...SESSION]; agree(isolation.mechanism, d, false); }
  const posix = vendor(); posix.lifecycleId = 'posix-group.v1';
  posix.isolation = { mechanism: 'none', observerId: null, documentation: [] }; posix.sessionArgv = [...SESSION];
  agree('existing posix mechanism in 1.1.0', posix, true);
  const lifecycleOnly = vendor(); lifecycleOnly.isolation = { mechanism: 'none', observerId: null, documentation: [] };
  lifecycleOnly.sessionArgv = [...SESSION];
  agree('linux-srt with mechanism none', lifecycleOnly, false);
});

test('the empty argument is accepted only as the one literal value right after one standalone --tools', () => {
  const argv = (...tail) => [...SESSION, ...tail];
  const valid = {
    'pair first': ['--tools', '', ...SESSION],
    'pair in the middle': ['-p', '--tools', '', '--verbose', '--output-format', 'stream-json']
  };
  for (const [name, list] of Object.entries(valid)) { const d = vendor(); d.sessionArgv = list; agree(name, d, true); }
  const invalid = {
    'missing pair': argv(),
    'tools without empty': argv('--tools'),
    'tools with value': argv('--tools', 'Read'),
    'tools= form': argv('--tools='),
    'tools= form beside pair': argv('--tools', '', '--tools=Read'),
    'duplicate pair': argv('--tools', '', '--tools', ''),
    'duplicate tools one empty': argv('--tools', '--tools', ''),
    'second tools with value': argv('--tools', '', '--tools', 'Read'),
    'extra empty after pair': argv('--tools', '', ''),
    'extra empty elsewhere': ['', ...argv('--tools', '')],
    'empty before tools': argv('', '--tools'),
    'empty separated from tools': argv('--tools', '--verbose', ''),
    'empty after other flag': argv('--tools', '--model', ''),
    'empty after flag without tools': argv('--model', ''),
    'empty only': argv(''),
    'forbidden flag': argv('--tools', '', '--mcp-config'),
    'forbidden flag value form': argv('--tools', '', '--settings=x'),
    'shell expansion': argv('--tools', '', '$HOME'),
    'NUL argument': argv('--tools', '', 'a\0b'),
    'too many arguments': [...argv('--tools', ''), ...Array.from({ length: 30 }, (_, i) => `--x${i}`)]
  };
  for (const [name, list] of Object.entries(invalid)) { const d = vendor(); d.sessionArgv = list; agree(name, d, false); }
});

test('the empty argument is rejected in 1.1.0 definitions that do not use the vendor profile', () => {
  const posix = legacyV11(); posix.sessionArgv = [...SESSION, '--tools', ''];
  agree('existing mechanism with pair', posix, false);
  const emptyOnly = legacyV11(); emptyOnly.sessionArgv = [...SESSION, ''];
  agree('existing mechanism with empty', emptyOnly, false);
  const version = vendor(); version.versionArgv = ['--version', ''];
  agree('empty version argument', version, false);
  const versionTools = vendor(); versionTools.versionArgv = ['--tools', ''];
  agree('pair in version argv', versionTools, false);
});
