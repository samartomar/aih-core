import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { nativeLifecycleIds, nativeVerificationDefinitions, validateNativeVerificationDefinition }
  from '../../src/harness/native/contracts.mjs';

const historicalAdmission = JSON.parse(readFileSync(new URL('../fixtures/native-linux-historical-admission.json', import.meta.url), 'utf8'));

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

test('the registered WSL2 candidate binds the exact current platform and has no admission evidence', () => {
  const definition = nativeVerificationDefinitions.find(value => value.lifecycleId === 'linux-srt.v1');
  assert.ok(definition);
  agree('registered candidate', definition, true);
  assert.deepEqual(definition.platform, { os: 'linux', arch: 'x64', execution: 'wsl2', osRelease: '6.18.58.1-microsoft-standard-WSL2' });
  assert.equal(definition.id, 'claude-linux-x64-wsl2-srt-2.1.285-wsl-3.0.5.0');
  assert.equal(definition.state, 'candidate');
  assert.deepEqual(definition.clientVersions, ['2.1.285']);
  assert.equal(definition.evidenceSha256, null);
  assert.deepEqual(definition.sessionArgv, [...SESSION, '--tools', '']);
  for (const clientVersions of [['2.1.*'], ['^2.1.285']])
    agree('nonexact version', { ...definition, clientVersions }, false);
});

test('1.1.0 accepts the exact historical admission independently of the active registry', () => {
  assert.deepEqual(nativeVerificationDefinitions.filter(definition => definition.state === 'admitted'), []);
  const published = JSON.parse(readFileSync(schemaUrl('1.1.0'), 'utf8'));
  const legacy = JSON.parse(readFileSync(schemaUrl('1.0.0'), 'utf8'));
  const admissionRules = schema => schema.allOf.filter(rule => rule.if?.properties?.state?.const === 'admitted');
  assert.deepEqual(admissionRules(published).map(rule => rule.then), [{ enum: [historicalAdmission] }]);
  assert.deepEqual(admissionRules(legacy).map(rule => rule.then), [false]);
  agree('historical admission with its exact reviewed evidence', historicalAdmission, true);
  agree('historical admission with changed runtime bytes',
    { ...historicalAdmission, runtimeMembers: [{ ...historicalAdmission.runtimeMembers[0], sha256: '0'.repeat(64) }] }, false);
  agree('historical admission with new kernel',
    { ...historicalAdmission, platform: nativeVerificationDefinitions.find(d => d.platform.os === 'linux').platform }, false);
  for (const candidate of nativeVerificationDefinitions) {
    agree('candidate claiming historical admission evidence',
      { ...candidate, state: 'admitted', evidenceSha256: historicalAdmission.evidenceSha256 }, false);
    agree('candidate claiming unreviewed admission evidence',
      { ...candidate, state: 'admitted', evidenceSha256: 'e'.repeat(64) }, false);
  }
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
