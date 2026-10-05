import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyNativeClient } from '@aihq/core';
import { validateNativeVerificationBundle, validateNativeVerificationResult } from '@aihq/core/contracts';

const request = { schema: 'urn:aihq:core:native-verification-request:1.0.0', client: 'claude' };
test('invalid native requests never create a session or cell', async () => {
  let accessed = false;
  const result = await verifyNativeClient({ ...request, get command() { accessed = true; return 'secret'; } });
  assert.equal(accessed, false);
  assert.equal(result.status, 'invalid');
  assert.equal(result.verdict, 'unverified');
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.cleanup, { processes: 'not-created', files: 'not-created', retainedCell: null });
});
test('native controls reject getters, forged signals and unused configuration bindings', async () => {
  const invalid = [
    { budgetMs: 999 }, { budgetMs: NaN }, { signal: Object.create(AbortSignal.prototype) },
    { configurationSources: {} }, { command: 'ignored' }, { sandboxRoot: 'relative' },
    Object.defineProperty({}, 'budgetMs', { enumerable: true, get() { throw Error('credential'); } }),
  ];
  for (const controls of invalid) {
    const result = await verifyNativeClient(request, controls);
    assert.equal(result.status, 'invalid'); assert.equal(result.sessions.length, 0);
    assert.equal(JSON.stringify(result).includes('credential'), false);
  }
});
test('proxy and cyclic native input is rejected before invoking traps or touching the host', async () => {
  let invoked = 0;
  const hostile = new Proxy({}, { get() { invoked++; throw Error('private'); }, ownKeys() { invoked++; throw Error('private'); } });
  const cycle = { ...request }; cycle.configuration = cycle;
  for (const [selected, controls] of [[hostile, undefined], [request, hostile], [cycle, undefined]]) {
    const result = await verifyNativeClient(selected, controls);
    assert.equal(result.status, 'invalid'); assert.equal(result.sessions.length, 0); assert.equal(result.cleanup.files, 'not-created');
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
  assert.equal(invoked, 0);
});
test('a pre-aborted valid request cancels without acquiring material or creating a cell', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await verifyNativeClient(request, { signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.verdict, 'unverified');
  assert.deepEqual(result.sessions, []); assert.equal(result.cleanup.files, 'not-created');
});
test('every roster member has an explicit unsupported or unadmitted native outcome', async () => {
  for (const client of ['claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'opencode', 'kimi', 'kiro', 'antigravity', 'zed']) {
    const result = await verifyNativeClient({ ...request, client });
    assert.equal(result.client.id, client); assert.equal(result.status, 'incomplete'); assert.equal(result.verdict, 'unverified');
    assert.equal(result.sessions.length, 0); assert.equal(result.cleanup.files, 'not-created');
    assert.ok(result.stages.some(row => ['client-unsupported', 'platform-unsupported', 'cell-not-admitted'].includes(row.reason)));
    assert.deepEqual(validateNativeVerificationResult(result).diagnostics, []);
  }
});

// This installed test artifact supplies a fixed controlled process adapter. It is never shipped,
// admitted, or presented as a native client proof. Only the public verifier is exercised.
const fixtureRuntime = scenario => `
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, lstatSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
const scenario = ${JSON.stringify(scenario)};
const hash = v => createHash('sha256').update(v).digest('hex');
const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '['+v.map(canonical).join(',')+']' : '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const fixture = Buffer.from('Initial controlled instruction.'); const guardrail = Buffer.from('Controlled deny rules.');
const member = { path:'package/test/instruction', sha256:hash(fixture), byteLength:fixture.length };
const guard = { root:'home', path:'settings.json', member:{path:'package/test/guardrail',sha256:hash(guardrail),byteLength:guardrail.length} };
const outputTree = [{root:'project',path:'INSTRUCTIONS.md',member}];
const treeHash = tree => hash(canonical(tree.map(({root,path,member})=>({root,path,sha256:member.sha256,byteLength:member.byteLength})).sort((a,b)=>a.root.localeCompare(b.root)||a.path.localeCompare(b.path))));
const marker = hash('controlled-marker');
const expectedResultSha256 = hash(canonical({content:[{type:'text',text:'leaf'}],isError:false}));
let snapshotReadyResolve;
export const snapshotReady=new Promise(resolve=>snapshotReadyResolve=resolve);
export const nativeDefinitions = [{id:'controlled.claude.v1',client:'claude',state:'candidate',platform:{os:process.platform,arch:process.arch,execution:'native',osRelease:release()},clientVersions:['1.0.0'],executableNames:['node'],runtimeMembers:[],versionArgv:['--version'],sessionArgv:[],parserId:'controlled.claude.v1',identityAdapterId:'claude-oauth-otel.v1',credentialDestination:{root:'home',path:'oauth.json'},guardrails:[guard],guardrailsSha256:treeHash([guard]),lifecycleId:'test-controlled',isolation:{mechanism:'client-native',observerId:'test-controlled',documentation:[]},evidenceSha256:null}];
export function nativeBundledFixture() {return {id:'aihq.native-fixture.v1',client:'claude',adapterId:'controlled.claude.v1',outputTree,outputTreeSha256:treeHash(outputTree),instructions:[{root:'project',path:'INSTRUCTIONS.md',sha256:member.sha256,evidence:'marker',markerSha256:marker}],server:{name:'fixture',transport:'stdio',runtime:[],evidenceAdapterId:'aihq.fixture.v1',observation:'native',toolNames:['attest','query'],queryTool:'query',queryArguments:{node:'entry'},challenge:{mode:'argument',field:'challenge'},expectedResultSha256,expectedAnswer:'leaf'},manifestSha256:hash('controlled-bundled-manifest'),archiveSha256:null,scope:'bundled-mechanism',bytes:new Map([[member.path,fixture],[guard.member.path,guardrail]])};}
export function nativeCapabilities(){return {lifecycle:scenario!=='known-managed',peerIdentity:true,credentialChannel:true};}
export function nativeManagedRestriction(){return scenario==='known-managed';}
export function nativeServerEvidenceAvailable(){return scenario!=='missing-client-and-server';}
export async function resolveNativeClient(){if(scenario==='missing-client-and-server')return {outcome:'unavailable',reason:'client-absent'};return {executable:process.execPath,observedVersion:'1.0.0',argv:[],sha256:hash(readFileSync(process.execPath)),runtime:[]};}
export function revalidateNativeClient(pin){return hash(readFileSync(pin.executable))===pin.sha256;}
export async function captureNativeIdentity(binding){return {credential:Buffer.from('{}'),expected:binding.expected,sourceIdentity:null};}
export function revalidateNativeIdentity(){return true;}
export async function protectNativeCell(){return true;}
export function nativeStatePaths(){return {home:[],project:[]};}
export function createNativeRuntime(){return {nativeDefinitions,nativeBundledFixture,nativeCapabilities,nativeManagedRestriction,nativeServerEvidenceAvailable,resolveNativeClient,revalidateNativeClient,captureNativeIdentity,revalidateNativeIdentity,protectNativeCell,nativeStatePaths,startNativeSession};}
const childScript = ${JSON.stringify(`let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>raw+=v);process.stdin.on('end',()=>{const x=JSON.parse(raw);if(!x.wait||x.partial)process.stdout.write(JSON.stringify(x.observations));if(x.wait)return setTimeout(()=>{},60000);});`)};
export async function startNativeSession(input){
  if(scenario==='spawn-rejected')return {outcome:'unavailable',reason:'session-launch-failed'};
  const child=spawn(process.execPath,['-e',childScript],{cwd:input.cell.project,env:input.environment,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const observations={sessionId:scenario==='reused'?'controlled-session':'controlled-session-'+input.index,resumed:false,loading:'observed',restrictions:scenario==='managed'?'managed':'observed',authentication:scenario==='identity-conflict'?'conflict':'matched',discovery:{complete:true,clientTools:['attest','query'],serverList:true},instructions:{nativeSha256:[],attestations:[{markerSha256:scenario==='bad-attestation'?hash('wrong'):marker,challengeMatched:true,clientReceipt:true}],rejected:false,alternateRead:scenario==='later-read'},query:{correlated:true,challengeMatched:!scenario.startsWith('bad-challenge'),resultSha256:scenario.startsWith('bad-query')?hash('wrong'):expectedResultSha256,answerSha256:hash('leaf'),rejectedCalls:scenario==='early-query'||scenario.endsWith('-refused')},isolation:scenario==='hygiene'?'unobservable':'observed',serverPeerBound:true,counts:{observedBytes:0,telemetryEvents:1,rpcMessages:3}};
  const partial=scenario.includes('-snapshot-'); let snapshot;
  if(scenario.includes('-snapshot-bad-query'))observations.query.resultSha256=hash('wrong');
  if(scenario.endsWith('-unfinished-auth'))observations.authentication='missing';
  let output='';let closed=false;let ended;
  const closePromise=new Promise(resolve=>ended=resolve);child.once('close',()=>{closed=true;ended();});
  let timer; let abort;
  const accepted=new Promise((resolve,reject)=>{
    child.stdout.on('data',part=>{output+=part.toString();if(partial){try{snapshot=JSON.parse(output);snapshot.counts.observedBytes=Buffer.byteLength(output);snapshot.completed=['session-freshness','loading-mode','tool-restrictions','tool-discovery','instruction-loading','read-only-query'];if(!scenario.endsWith('-unfinished-auth'))snapshot.completed.push('provider-authentication');snapshotReadyResolve();}catch{}}});
    child.once('error',reject);
    abort=()=>{child.stdin.destroy();child.kill();reject(Error('controlled cancellation'));};
    if(input.signal)input.signal.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{child.kill();resolve({...snapshot??observations,completed:snapshot?.completed??[],failure:{reason:'budget-exhausted',outcome:'unavailable'}});},Math.max(1,input.deadline-performance.now()));
    child.once('close',()=>{clearTimeout(timer);if(input.signal)input.signal.removeEventListener('abort',abort);if(scenario==='partial-spawn')return resolve({...observations,completed:[],failure:{reason:'native-internal',outcome:'unavailable'}});try{const value=JSON.parse(output);value.counts.observedBytes=Buffer.byteLength(output);if(scenario==='changed-config'&&input.index===1)writeFileSync(join(input.cell.project,'INSTRUCTIONS.md'),'changed');if(scenario==='replaced-config'&&input.index===1){const p=join(input.cell.project,'INSTRUCTIONS.md');unlinkSync(p);writeFileSync(p,fixture);}resolve(value);}catch{reject(Error('controlled output unavailable'));}});
  });
  child.stdin.end(JSON.stringify({observations,wait:scenario==='cancel'||scenario==='deadline'||partial,partial}));
  const handle={pid:child.pid,argv:[process.execPath,'-e',childScript],...(scenario==='alternate-challenge'?{challenge:hash('controlled-challenge-'+input.index)}:{}),observations:accepted,snapshot(){return snapshot??{...observations,completed:[],counts:{observedBytes:0,telemetryEvents:0,rpcMessages:0}};},async cleanup(){clearTimeout(timer);if(input.signal)input.signal.removeEventListener('abort',abort);if(!closed){child.stdin.destroy();child.kill();await closePromise;}return {confirmed:scenario!=='cleanup-unresolved',survivors:scenario==='cleanup-unresolved'?[{pid:child.pid,role:'client'}]:[]};}};
  return scenario==='partial-spawn'?{outcome:'unavailable',reason:'native-internal',partial:handle}:handle;
}
`;
const identity = { adapterId: 'claude-oauth-otel.v1', provisionedRoot: join(tmpdir(), 'controlled-provisioned'), manifestSha256: 'a'.repeat(64),
  expected: { accountUuid: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222' } };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function archiveMembers(entries) {
  const chunks = [];
  for (const [name, bytes, kind = '0'] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000600\0', 100);
    header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header.write(kind, 156); header.write('ustar\0', 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
async function controlled(t, scenario, controls = {}) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-controlled-native-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  cpSync(join(root, 'dist'), join(directory, 'dist'), { recursive: true });
  cpSync(join(root, 'package.json'), join(directory, 'package.json'));
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const native = join(directory, 'dist', 'harness', 'native'); mkdirSync(native, { recursive: true });
  writeFileSync(join(native, 'runtime.mjs'), fixtureRuntime(scenario));
  const requestedRoot = join(directory, 'cells'); mkdirSync(requestedRoot);
  const sandboxRoot = realpathSync.native(requestedRoot);
  writeFileSync(join(directory, 'entry.mjs'), "export { verifyNativeClient } from '@aihq/core';\nexport { snapshotReady } from './dist/harness/native/runtime.mjs';\n");
  const api = await import(pathToFileURL(join(directory, 'entry.mjs')).href);
  let selected = request;
  if (scenario === 'supplied-healthy') {
    const instruction = Buffer.from('Initial controlled instruction.');
    const release = Buffer.from('{}'); const recipe = Buffer.from('{}');
    const member = { path: 'package/test/instruction', sha256: digest(instruction), byteLength: instruction.length };
    const serverBytes = Buffer.from('// Controlled fixture data; no provider or server run.');
    const serverMember = { path: 'package/test/server.mjs', sha256: digest(serverBytes), byteLength: serverBytes.length };
    const outputTree = [{ root: 'project', path: 'INSTRUCTIONS.md', member }, { root: 'project', path: 'server.mjs', member: serverMember }];
    const bundle = {
      schema: 'urn:aihq:core:native-verification-bundle:1.0.0', id: 'fixture.supplied', client: 'claude', adapterId: 'controlled.claude.v1', scope: 'test-configuration',
      package: { name: '@aihq/controlled-native', version: '1.0.0' }, release: { path: 'package/release.json', sha256: digest(release), byteLength: release.length },
      selection: { itemId: 'controlled', itemSha256: digest('{}'), recipe: { path: 'package/recipe.json', sha256: digest(recipe), byteLength: recipe.length }, inputs: {} },
      startingTree: [], startingTreeSha256: digest('[]'), outputTree,
      outputTreeSha256: digest(JSON.stringify(outputTree.map(value => ({ byteLength: value.member.byteLength, path: value.path, root: value.root, sha256: value.member.sha256 })))),
      instructions: [{ root: 'project', path: 'INSTRUCTIONS.md', sha256: member.sha256, evidence: 'marker', markerSha256: digest('controlled-marker') }],
      server: { name: 'fixture', transport: 'stdio', runtime: [serverMember], evidenceAdapterId: 'aihq.fixture.v1', observation: 'native', toolNames: ['attest', 'query'], queryTool: 'query',
        queryArguments: { node: 'entry' }, challenge: { mode: 'argument', field: 'challenge' }, expectedResultSha256: digest('{"content":[{"text":"leaf","type":"text"}],"isError":false}'), expectedAnswer: 'leaf' },
    };
    assert.deepEqual(validateNativeVerificationBundle(bundle).diagnostics, []);
    const manifest = Buffer.from(JSON.stringify(bundle));
    const archive = archiveMembers([['package/m.json', manifest], ['package/release.json', release], ['package/recipe.json', recipe], [member.path, instruction], [serverMember.path, serverBytes]]);
    const archivePath = join(directory, 'supplied.tar'); writeFileSync(archivePath, archive);
    const manifestSha256 = digest(manifest);
    selected = { ...request, configuration: { kind: 'supplied', input: 'reviewed', bundleId: bundle.id, manifestSha256 } };
    controls = { ...controls, configurationSources: { reviewed: { archivePath, archiveSha256: digest(archive), archiveBytes: archive.length,
      manifestPath: 'package/m.json', manifestSha256, manifestBytes: manifest.length } } };
  }
  if (scenario.startsWith('archive-')) {
    const manifest = Buffer.from('{}');
    const entries = scenario === 'archive-traversal' ? [['package/../m.json', manifest]] :
      scenario === 'archive-link' ? [['package/m.json', Buffer.alloc(0), '2']] :
      scenario === 'archive-duplicate' ? [['package/m.json', manifest], ['package/m.json', manifest]] :
      [['package/m.json', manifest]];
    const archive = archiveMembers(entries); const archivePath = join(directory, 'supplied.tar');
    writeFileSync(archivePath, archive);
    const manifestSha256 = scenario === 'archive-manifest-mismatch' ? 'b'.repeat(64) : digest(manifest);
    selected = { ...request, configuration: { kind: 'supplied', input: 'reviewed', bundleId: 'fixture.supplied', manifestSha256 } };
    controls = { ...controls, configurationSources: { reviewed: {
      archivePath, archiveSha256: scenario === 'archive-pin-mismatch' ? 'b'.repeat(64) : digest(archive), archiveBytes: archive.length,
      manifestPath: 'package/m.json', manifestSha256, manifestBytes: manifest.length,
    } } };
  }
  const cancellation = scenario.startsWith('cancel-snapshot-') ? new AbortController() : undefined;
  const pending = api.verifyNativeClient(selected, { admission: 'candidate-smoke', testIdentity: identity,
    ...(scenario === 'default-temp' ? {} : { sandboxRoot }), ...controls, ...(cancellation ? { signal: cancellation.signal } : {}) });
  if (cancellation) { await Promise.race([api.snapshotReady, pending.then(() => { throw Error('controlled snapshot never arrived'); })]); cancellation.abort(); }
  const result = await pending;
  assert.deepEqual(validateNativeVerificationResult(result).diagnostics, []);
  return result;
}
test('controlled processes exercise two fresh sessions, fixed configuration and full result aggregation', async t => {
  const result = await controlled(t, 'healthy');
  assert.equal(result.status, 'complete', JSON.stringify(result)); assert.equal(result.verdict, 'verified');
  assert.equal(result.admission, 'candidate-smoke'); assert.equal(result.proofScope, 'bundled-mechanism');
  assert.equal(result.sessions.length, 2);
  assert.notEqual(result.sessions[0].process.clientSessionId, result.sessions[1].process.clientSessionId);
  assert.equal(result.sessions[0].stagedConfigurationDigest, result.sessions[1].stagedConfigurationDigest);
  assert.deepEqual(result.stages.filter(row => row.id === 'configuration-unchanged').map(row => row.reason), ['before-session-2', 'after-session-2']);
  assert.deepEqual(result.cleanup, { processes: 'confirmed', files: 'removed', retainedCell: null });
});
test('controlled hygiene evidence preserves both sessions while remaining unverified', async t => {
  const result = await controlled(t, 'hygiene');
  assert.equal(result.sessions.length, 2); assert.equal(result.status, 'incomplete'); assert.equal(result.verdict, 'unverified');
  assert.equal(result.security.sandbox.level, 'hygiene-only');
});
test('default OS temporary parent supports controlled verification without a sandboxRoot control', async t => {
  const result = await controlled(t, 'default-temp');
  assert.equal(result.status, 'complete', JSON.stringify(result)); assert.equal(result.verdict, 'verified');
  assert.equal(result.sessions.length, 2); assert.equal(result.cleanup.files, 'removed');
});
test('controlled supplied pins acquire and stage the exact archived output for both sessions', async t => {
  const result = await controlled(t, 'supplied-healthy');
  assert.equal(result.status, 'complete'); assert.equal(result.verdict, 'verified'); assert.equal(result.proofScope, 'test-configuration');
  assert.equal(result.content.bundleId, 'fixture.supplied'); assert.match(result.content.archiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.sessions.length, 2); assert.equal(result.cleanup.files, 'removed');
});
test('controlled evidence channel challenge replaces the unused initial challenge digest', async t => {
  const result = await controlled(t, 'alternate-challenge');
  assert.equal(result.verdict, 'verified');
  assert.ok(result.sessions.every(value => value.challengeSha256 === digest(digest('controlled-challenge-'+value.index))));
});
test('known managed restriction takes precedence over unavailable lifecycle', async t => {
  const result = await controlled(t, 'known-managed');
  assert.ok(result.stages.some(value => value.outcome === 'restricted' && value.reason === 'managed-restriction'));
  assert.equal(result.sessions.length, 0); assert.equal(result.cleanup.files, 'not-created');
});
test('missing executable remains observable when the fixed server adapter is unavailable', async t => {
  const result = await controlled(t, 'missing-client-and-server');
  assert.ok(result.stages.some(value => value.reason === 'client-absent'));
  assert.equal(result.sessions.length, 0); assert.equal(result.cleanup.files, 'not-created');
});
for (const [scenario, reason, verdict, sessions] of [
  ['reused', 'session-not-fresh', 'failed', 2],
  ['changed-config', 'configuration-changed', 'failed', 1],
  ['replaced-config', 'configuration-changed', 'failed', 1],
  ['bad-attestation', 'instruction-attestation-mismatch', 'unverified', 1],
  ['bad-query', 'query-answer-mismatch', 'failed', 1],
  ['bad-query-refused', 'query-answer-mismatch', 'failed', 1],
  ['bad-challenge', 'query-challenge-mismatch', 'unverified', 1],
  ['bad-challenge-refused', 'query-challenge-mismatch', 'unverified', 1],
  ['early-query', 'restriction-unobservable', 'unverified', 1],
  ['later-read', 'instruction-source-ambiguous', 'unverified', 1],
  ['identity-conflict', 'identity-conflict', 'unverified', 1],
  ['managed', 'managed-restriction', 'unverified', 1],
  ['partial-spawn', 'native-internal', 'unverified', 1],
  ['spawn-rejected', 'session-launch-failed', 'unverified', 0],
]) test('controlled '+scenario+' prevents acceptance and cleans its actual child', async t => {
  const result = await controlled(t, scenario);
  assert.equal(result.verdict, verdict); assert.equal(result.sessions.length, sessions);
  assert.ok([...result.stages, ...result.sessions.flatMap(session => session.stages)].some(row => row.reason === reason));
  if (scenario === 'early-query') assert.ok(result.sessions[0].stages.some(row => row.id === 'instruction-loading' && row.outcome === 'passed'));
  assert.equal(result.cleanup.files, 'removed'); assert.equal(result.survivingProcesses.length, 0);
});
test('controlled cancellation retains an actual launch and confirms cleanup', async t => {
  const controller = new AbortController(); const abortTimer = setTimeout(() => controller.abort(), 1500);
  t.after(() => clearTimeout(abortTimer));
  const result = await controlled(t, 'cancel', { signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.sessions.length, 1);
  assert.equal(result.cleanup.processes, 'confirmed'); assert.equal(result.cleanup.files, 'removed');
});
test('controlled deadline drains and cleans the single session without inventing session two', async t => {
  const result = await controlled(t, 'deadline', { budgetMs: 1000 });
  assert.equal(result.status, 'incomplete'); assert.equal(result.verdict, 'unverified'); assert.equal(result.sessions.length, 1);
  assert.ok(result.sessions[0].stages.some(row => row.reason === 'budget-exhausted'));
  assert.equal(result.cleanup.files, 'removed');
});
for (const interruption of ['cancel', 'budget']) {
  test('controlled ' + interruption + ' retains a completed query contradiction and prior proof', async t => {
    const result = await controlled(t, interruption + '-snapshot-bad-query', { budgetMs: 4000 });
    assert.equal(result.status, interruption === 'cancel' ? 'cancelled' : 'complete');
    assert.equal(result.verdict, 'failed'); assert.equal(result.sessions.length, 1);
    const stages = result.sessions[0].stages;
    for (const id of ['session-freshness', 'loading-mode', 'tool-restrictions', 'provider-authentication', 'tool-discovery', 'instruction-loading'])
      assert.ok(stages.some(row => row.id === id && row.outcome === 'passed'), JSON.stringify(stages));
    assert.ok(stages.some(row => row.id === 'read-only-query' && row.outcome === 'failed' && row.reason === 'query-answer-mismatch'));
    assert.ok(result.limits.observedBytes > 0); assert.equal(result.cleanup.files, 'removed');
  });
  test('controlled ' + interruption + ' preserves finished protocol rows while authentication is unfinished', async t => {
    const result = await controlled(t, interruption + '-snapshot-unfinished-auth', { budgetMs: 4000 });
    assert.equal(result.status, interruption === 'cancel' ? 'cancelled' : 'incomplete');
    assert.equal(result.verdict, 'unverified'); assert.equal(result.sessions.length, 1);
    const stages = result.sessions[0].stages;
    assert.ok(stages.some(row => row.id === 'provider-authentication' && row.outcome === 'unavailable'));
    assert.ok(stages.some(row => row.id === 'read-only-query' && row.outcome === 'passed'));
    assert.ok(stages.some(row => row.id === 'isolation' && row.outcome === 'unavailable'));
    assert.equal(result.cleanup.processes, 'confirmed'); assert.equal(result.cleanup.files, 'removed');
  });
  test('controlled ' + interruption + ' retains a query failure after unfinished authentication', async t => {
    const result = await controlled(t, interruption + '-snapshot-bad-query-unfinished-auth', { budgetMs: 4000 });
    assert.equal(result.status, interruption === 'cancel' ? 'cancelled' : 'complete');
    assert.equal(result.verdict, 'failed'); assert.equal(result.sessions.length, 1);
    const stages = result.sessions[0].stages;
    assert.ok(stages.some(row => row.id === 'provider-authentication' && row.outcome === 'unavailable'));
    assert.ok(stages.some(row => row.id === 'read-only-query' && row.outcome === 'failed' && row.reason === 'query-answer-mismatch'));
    assert.equal(result.cleanup.files, 'removed');
  });
}
test('controlled unconfirmed process cleanup retains the cell and reports opaque recovery', async t => {
  const result = await controlled(t, 'cleanup-unresolved');
  assert.equal(result.status, 'incomplete'); assert.equal(result.cleanup.processes, 'unresolved');
  assert.equal(result.cleanup.files, 'retained'); assert.match(result.cleanup.retainedCell, /^aih-native-[a-f0-9]{32}$/);
  assert.equal(result.survivingProcesses.length, 1); assert.equal(result.sessions.length, 1);
});
for (const [scenario, reason] of [
  ['archive-pin-mismatch', 'fixture-bytes-mismatch'], ['archive-manifest-mismatch', 'fixture-bytes-mismatch'],
  ['archive-traversal', 'material-path-unsafe'], ['archive-link', 'material-path-unsafe'], ['archive-duplicate', 'material-path-unsafe'],
]) test('supplied '+scenario+' rejects independently pinned archive material before creating a cell', async t => {
  const result = await controlled(t, scenario);
  assert.equal(result.status, 'complete'); assert.equal(result.verdict, 'failed');
  assert.equal(result.sessions.length, 0); assert.equal(result.cleanup.files, 'not-created');
  assert.ok(result.stages.some(row => row.reason === reason));
});
