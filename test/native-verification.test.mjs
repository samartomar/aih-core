import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { verifyNativeClient } from '@aihq/core';
import { validateNativeVerificationBundle, validateNativeVerificationResult } from '@aihq/core/contracts';

const request = { schema: 'urn:aihq:core:native-verification-request:1.0.0', client: 'claude' };
test('controlled selected configuration mutation emits persistence diagnosis with unchanged verdict', async t => {
  const records = [], stream = channel('aih.native.diagnostics.v1'), sink = value => records.push(value);
  stream.subscribe(sink);
  try {
    const result = await controlled(t, 'changed-config');
    assert.equal(result.verdict, 'failed'); assert.equal(result.sessions.length, 1);
    assert.ok(result.stages.some(row => row.reason === 'configuration-changed' && row.outcome === 'failed'));
    const persistence = records.filter(record => record.event === 'native-persistence-diagnostics');
    assert.equal(persistence.length, 1);
    assert.equal(persistence[0].class, 'configuration-facts');
    assert.equal(persistence[0].stage, 'before-session-2');
    assert.deepEqual(persistence[0].items, [{ root: 'project', depth: 1, kind: 'file', token: 'unknown-1', parent: null }]);
    assert.equal(persistence[0].truncated, true); assert.equal(persistence[0].inspectedDiagnosis, null);
  } finally { stream.unsubscribe(sink); }
});
for (const [scenario, failureClass, token, stage, verdict] of [
  ['client-state-diagnostic-todos', 'unexpected-entry', 'todos', 'before-session-2', 'failed'],
  ['client-state-after-session-2', 'unexpected-entry', 'todos', 'after-session-2', 'failed'],
  ['client-state-diagnostic-unknown', 'unexpected-entry', 'unknown-1', 'before-session-2', 'failed'],
  ['client-state-diagnostic-key', 'inspected-state', '.claude.json', 'before-session-2', 'failed'],
  ['client-state-diagnostic-limit', 'limit', 'unknown-1', 'before-session-2', 'unverified'],
]) test(`controlled ${scenario} emits exactly one persistence record and preserves verdict`, async t => {
  const records = [], stream = channel('aih.native.diagnostics.v1'), sink = value => records.push(value);
  stream.subscribe(sink);
  try {
    const result = await controlled(t, scenario);
    assert.equal(result.verdict, verdict); assert.equal(result.sessions.length, stage === 'after-session-2' ? 2 : 1);
    assert.ok(result.stages.some(row => row.reason === (failureClass === 'limit' ? 'limit-exceeded' : 'configuration-changed')));
    const persistence = records.filter(record => record.event === 'native-persistence-diagnostics');
    assert.equal(persistence.length, 1); const record = persistence[0];
    assert.equal(record.class, failureClass); assert.equal(record.stage, stage);
    assert.equal(record.items[0].token, token); assert.equal(record.truncated, true);
    assert.match(record.runSha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(record).includes('privacy-canary'), false);
    if (failureClass === 'inspected-state') assert.deepEqual(record.inspectedDiagnosis, { reason: 'unknown-global-key', token: 'unknown-1' });
  } finally { stream.unsubscribe(sink); }
});
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
import { appendFileSync, readFileSync, writeFileSync, unlinkSync, lstatSync, mkdirSync, linkSync, rmSync } from 'node:fs';
import { createNativeRuntime as installedHarness } from './adapter.mjs';
import { release } from 'node:os';
import { join } from 'node:path';
const scenario = ${JSON.stringify(scenario)};
const cleanupUnresolved = scenario==='cleanup-unresolved'||scenario==='client-state-log-cache-retained';
import { NativeStop } from '../../core/internal/native-input.js';
let recordCleanup;
const hash = v => createHash('sha256').update(v).digest('hex');
const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '['+v.map(canonical).join(',')+']' : '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const fixture = Buffer.from('Initial controlled instruction.'); const guardrail = Buffer.from('Controlled deny rules.');
const member = { path:'package/test/instruction', sha256:hash(fixture), byteLength:fixture.length };
// The home guardrail lives under .claude/, mirroring the real bundled fixture layout.
const guard = { root:'home', path:'.claude/settings.json', member:{path:'package/test/guardrail',sha256:hash(guardrail),byteLength:guardrail.length} };
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
export async function captureNativeIdentity(binding){if(scenario==='identity-capture-refused')return {outcome:'unavailable',reason:'identity-binding-invalid'};return {credential:Buffer.from('{}'),expected:binding.expected,sourceIdentity:null};}
let identityChecks=0;
export function revalidateNativeIdentity(){identityChecks++;return scenario==='identity-recheck-refused'?false:scenario==='identity-pre-staging-refused'?identityChecks<2:true;}
export async function protectNativeCell(){if(scenario==='staging-refused')return false;if(scenario==='protect-helper-cleanup-unresolved'){recordCleanup({confirmed:false,survivors:[{pid:65001,role:'helper'}]},performance.now());return false;}return true;}
// Ordinary client state comes from the installed Harness enumeration and its separate inspector.
const harness = installedHarness({ nativeVerificationDefinitions: [] }, { readPinned(){ throw Error('unused'); }, Stop: Error });
const harnessClient = { client:'claude', parserId:'claude-stream-json.v1' };
const tree = (path, exclusions = []) => ({ path, exclusions, inspected:false });
const contracts = {
  'state-two-wildcards': { home:[tree('.claude/projects', ['*/*'])], project:[] },
  'state-traversal': { home:[tree('../outside')], project:[] },
  'state-overlap': { home:[tree('.claude')], project:[] },
  'state-credential-overlap': { home:[tree('oauth.json')], project:[] },
  'state-too-many': { home:Array.from({ length:17 }, (_, i) => tree('state-'+i)), project:[] },
  'state-inspector-missing': { home:[{ path:'client.json', exclusions:[], inspected:true }], project:[] },
};
export function nativeStatePaths(){return contracts[scenario] ?? harness.nativeStatePaths(harnessClient);}
export function inspectNativeState(_definition, input){return harness.inspectNativeState(harnessClient, input);}
export function classifyNativePersistence(_definition, input){return harness.classifyNativePersistence(harnessClient, input);}
export function publishNativePersistence(input){return harness.publishNativePersistence(input);}
const writeState=(root,path,bytes)=>{const target=join(root,...path.split('/'));mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,bytes);};
const globalState=(project={})=>JSON.stringify({numStartups:2,firstStartTime:'2026-10-05T00:00:00.000Z',userID:'0'.repeat(64),hasCompletedOnboarding:true,
  projects:{'/cell/project':{allowedTools:[],mcpServers:{},enabledMcpjsonServers:[],disabledMcpjsonServers:[],hasTrustDialogAccepted:false,projectOnboardingSeenCount:1,lastSessionId:'00000000-0000-4000-8000-000000000000',lastCost:0,...project}}});
function clientWrites(cell,index){
  if(scenario==='client-state-housekeeping'||scenario==='client-state-registry-after-session-2'){
    mkdirSync(join(cell.home,'.claude','sessions'),{recursive:true});
    writeState(cell.home,'.claude/.last-cleanup','housekeeping-'+index);
    if(index===2&&scenario==='client-state-registry-after-session-2')writeState(cell.home,'.claude/sessions/pid.json','{}');
  }
  if(scenario.startsWith('client-state-log-cache')){
    const cache='.cache/claude-cli-nodejs/-cell-project/';
    if(index===1){
      writeState(cell.home,cache+'errors/2026-10-07T00-00-00.jsonl','{"error":"privacy-canary-error"}'+String.fromCharCode(10));
      writeState(cell.home,cache+'mcp-logs-fixture/2026-10-07T00-00-00.jsonl','{"stderr":"privacy-canary-stderr"}'+String.fromCharCode(10));
    }else if(scenario==='client-state-log-cache-removed'){
      rmSync(join(cell.home,'.cache'),{recursive:true});
    }else{
      appendFileSync(join(cell.home,cache+'errors/2026-10-07T00-00-00.jsonl'),'{"error":"privacy-canary-appended"}'+String.fromCharCode(10));
      rmSync(join(cell.home,cache+'mcp-logs-fixture'),{recursive:true});
      writeState(cell.home,cache+'mcp-logs-fixture/2026-10-07T01-00-00.jsonl','{"stderr":"privacy-canary-new"}'+String.fromCharCode(10));
    }
  }
  if(index!==(scenario==='client-state-after-session-2'?2:1)||!scenario.startsWith('client-state'))return;
  writeState(cell.home,'.claude/projects/cell-project/session-1.jsonl','{"transcript":true}');
  writeState(cell.home,'.claude/.claude.json',globalState());
  const dir=(root,path)=>mkdirSync(join(root,...path.split('/')),{recursive:true});
  ({
    'client-state-diagnostic-todos':()=>dir(cell.home,'.claude/todos'),
    'client-state-after-session-2':()=>dir(cell.home,'.claude/todos'),
    'client-state-diagnostic-unknown':()=>writeState(cell.home,'.claude/privacy-canary-name','privacy-canary-value'),
    'client-state-diagnostic-key':()=>writeState(cell.home,'.claude/.claude.json','{"privacy-canary-key":"privacy-canary-value"}'),
    'client-state-diagnostic-limit':()=>dir(cell.home,'.claude/projects/'+Array(32).fill('deep').join('/')),
    'client-state-full':()=>{writeState(cell.home,'.claude/projects/cell-project/session-1/tool-results/r.txt','result');
      writeState(cell.home,'.claude/backups/.claude.json.backup.1759622400000',globalState());dir(cell.home,'.claude/.claude.json.lock');
      writeState(cell.home,'.claude/history.jsonl','{"display":"prompt"}');dir(cell.home,'.claude/history.jsonl.lock');
      writeState(cell.home,'.claude/telemetry/1p_failed_events.session-1.json','[]');},
    'client-state-tiny-memory':()=>writeState(cell.home,'.claude/projects/cell-project/tiny_memory/note.md','remember'),
    'client-state-session-aliases':()=>writeState(cell.home,'.claude/projects/cell-project/.session-aliases','{}'),
    'client-state-personal-memory':()=>writeState(cell.home,'.claude/memory/personal/MEMORY.md','remember'),
    'client-state-shell-snapshot':()=>writeState(cell.home,'.claude/shell-snapshots/snapshot-bash-1-x.sh','export X=1'),
    'client-state-session-env':()=>writeState(cell.home,'.claude/session-env/session-1/hook-0.sh','export X=1'),
    'client-state-sessions':()=>writeState(cell.home,'.claude/sessions/peer.json','{}'),
    'client-state-policy-limits':()=>writeState(cell.home,'.claude/policy-limits.json','{}'),
    'client-state-memory':()=>writeState(cell.home,'.claude/projects/cell-project/memory/MEMORY.md','remember'),
    'client-state-memory-case':()=>writeState(cell.home,'.claude/projects/cell-project/Memory/MEMORY.md','remember'),
    'client-state-changed-config':()=>writeFileSync(join(cell.project,'INSTRUCTIONS.md'),'changed'),
    'client-state-hardlink':()=>linkSync(join(cell.home,'.claude','projects','cell-project','session-1.jsonl'),join(cell.home,'.claude','projects','cell-project','alias.jsonl')),
    'client-state-user-mcp':()=>writeState(cell.home,'.claude/.claude.json',JSON.stringify({numStartups:2,mcpServers:{extra:{type:'stdio',command:'node'}}})),
    'client-state-project-mcp':()=>writeState(cell.home,'.claude/.claude.json',globalState({mcpServers:{extra:{type:'stdio',command:'node'}}})),
    'client-state-allowed-tools':()=>writeState(cell.home,'.claude/.claude.json',globalState({allowedTools:['Bash']})),
    'client-state-trust':()=>writeState(cell.home,'.claude/.claude.json',globalState({hasTrustDialogAccepted:true})),
    'client-state-unknown-key':()=>writeState(cell.home,'.claude/.claude.json',JSON.stringify({numStartups:2,futureLoader:{path:'x'}})),
    'client-state-root-global':()=>writeState(cell.home,'.claude.json',globalState()),
  })[scenario]?.();
}
export function createNativeRuntime(_module,dependencies){recordCleanup=dependencies.recordCleanup;return {nativeDefinitions,nativeBundledFixture,nativeCapabilities,nativeManagedRestriction,nativeServerEvidenceAvailable,resolveNativeClient,revalidateNativeClient,captureNativeIdentity,revalidateNativeIdentity,protectNativeCell,nativeStatePaths,classifyNativePersistence,publishNativePersistence,...(scenario==='state-inspector-missing'?{}:{inspectNativeState}),startNativeSession};}
const childScript = ${JSON.stringify(`let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>raw+=v);process.stdin.on('end',()=>{const x=JSON.parse(raw);if(x.ready)process.stdout.write(JSON.stringify({ready:true}));if(!x.wait||x.partial)process.stdout.write(JSON.stringify(x.observations));if(x.wait)return setTimeout(()=>{},60000);});`)};
export async function startNativeSession(input){
  if(scenario==='pre-client-cleanup-unresolved')return {outcome:'unavailable',reason:'server-evidence-unavailable',cleanup:{confirmed:false,survivors:[{pid:65000,role:'helper'}]},cleanupStartedAt:performance.now()};
  if(scenario==='spawn-rejected')return {outcome:'unavailable',reason:'session-launch-failed'};
  const child=spawn(process.execPath,['-e',childScript],{cwd:input.cell.project,env:input.environment,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const observations={sessionId:scenario==='reused'?'controlled-session':'controlled-session-'+input.index,resumed:false,loading:'observed',restrictions:scenario==='managed'?'managed':'observed',authentication:scenario==='identity-conflict'?'conflict':'matched',discovery:{complete:true,clientTools:['attest','query'],serverList:true},instructions:{nativeSha256:[],attestations:[{markerSha256:scenario==='bad-attestation'?hash('wrong'):marker,challengeMatched:true,clientReceipt:true}],rejected:false,alternateRead:scenario==='later-read'},query:{correlated:true,challengeMatched:!scenario.startsWith('bad-challenge'),resultSha256:scenario.startsWith('bad-query')?hash('wrong'):expectedResultSha256,answerSha256:hash('leaf'),rejectedCalls:scenario==='early-query'||scenario.endsWith('-refused')},isolation:scenario==='hygiene'?'unobservable':'observed',serverPeerBound:true,counts:{observedBytes:0,telemetryEvents:1,rpcMessages:3}};
  const partial=scenario.includes('-snapshot-'); let snapshot;
  if(scenario.includes('-snapshot-bad-query'))observations.query.resultSha256=hash('wrong');
  if(scenario.endsWith('-unfinished-auth'))observations.authentication='missing';
  if(scenario.endsWith('-pending-receipt'))observations.query.answerSha256=null;
  if(scenario.includes('-missing-result'))observations.query.resultSha256=null;
  if(scenario.endsWith('-bad-client-answer'))observations.query.answerSha256=hash('wrong-client-answer');
  if(scenario==='completed-invalid-counts')observations.counts.telemetryEvents=-1;
  if(scenario==='completed-over-limit-counts')observations.counts.rpcMessages=513;
  if(scenario.startsWith('active-')){
    const early=scenario==='active-managed'||scenario==='active-managed-final'||scenario==='active-malformed';
    observations.completed=early?['session-freshness']:['session-freshness','loading-mode','tool-restrictions','provider-authentication'];
    if(scenario==='active-managed-final')delete observations.completed;
    if(scenario==='active-collector-cap-unfinished')observations.completed.pop();
    observations.loading=scenario==='active-managed-final'?'not-loaded':early?'unobservable':'observed';
    observations.restrictions=scenario.startsWith('active-managed')?'managed':'observed';
    observations.authentication=early?'missing':scenario==='active-identity'?'conflict':'limited';
    observations.failure={reason:scenario.startsWith('active-managed')?'managed-restriction':scenario==='active-malformed'?'native-internal':scenario==='active-identity'?'identity-conflict':'limit-exceeded',outcome:scenario.startsWith('active-managed')?'restricted':'unavailable'};
  }
  let output='';let closed=false;let ended;
  const closePromise=new Promise(resolve=>ended=resolve);child.once('close',()=>{closed=true;ended();});
  let timer; let abort;
  const accepted=new Promise((resolve,reject)=>{
    child.stdout.on('data',part=>{output+=part.toString();if(partial){try{
      snapshot=JSON.parse(output);snapshot.counts.observedBytes=Buffer.byteLength(output);
      snapshot.completed=['session-freshness','loading-mode','tool-restrictions','tool-discovery','instruction-loading','read-only-query'];
      if(!scenario.endsWith('-unfinished-auth'))snapshot.completed.push('provider-authentication');
      snapshotReadyResolve();
      // This controlled adapter tests retention at a budget stop after real
      // child proof, independently of startup speed. The real-deadline case
      // below still exercises the verifier's actual timer and process cleanup.
      if(scenario.startsWith('budget-snapshot-'))reject(new NativeStop('budget-exhausted'));
    }catch{}}});
    child.once('error',reject);
    abort=()=>{child.stdin.destroy();child.kill();reject(Error('controlled cancellation'));};
    if(input.signal)input.signal.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{child.kill();resolve({...snapshot??observations,completed:snapshot?.completed??[],counts:{...snapshot?.counts??observations.counts,observedBytes:Buffer.byteLength(output)},failure:{reason:'budget-exhausted',outcome:'unavailable'}});},Math.max(1,input.deadline-performance.now()));
    child.once('close',()=>{clearTimeout(timer);if(input.signal)input.signal.removeEventListener('abort',abort);if(scenario==='partial-spawn')return resolve({...observations,completed:[],failure:{reason:'native-internal',outcome:'unavailable'}});try{const value=JSON.parse(output);value.counts.observedBytes=Buffer.byteLength(output);if(scenario==='changed-config'&&input.index===1)writeFileSync(join(input.cell.project,'INSTRUCTIONS.md'),'changed');if(scenario==='replaced-config'&&input.index===1){const p=join(input.cell.project,'INSTRUCTIONS.md');unlinkSync(p);writeFileSync(p,fixture);}clientWrites(input.cell,input.index);if(scenario==='conflicting-loading-source'&&input.index===1)writeFileSync(join(input.cell.home,'.claude','settings.local.json'),'{}');resolve(value);}catch{reject(Error('controlled output unavailable'));}});
  });
  child.stdin.end(JSON.stringify({observations,wait:scenario==='cancel'||scenario==='deadline'||partial,partial,ready:scenario==='deadline'}));
  const handle={pid:child.pid,argv:[process.execPath,'-e',childScript],...(scenario==='alternate-challenge'?{challenge:hash('controlled-challenge-'+input.index)}:{}),observations:accepted,snapshot(){return snapshot??{...observations,completed:[],counts:{observedBytes:Buffer.byteLength(output),telemetryEvents:0,rpcMessages:0}};},async cleanup(){clearTimeout(timer);if(input.signal)input.signal.removeEventListener('abort',abort);if(!closed){child.stdin.destroy();child.kill();await closePromise;}return {confirmed:!cleanupUnresolved,survivors:cleanupUnresolved?[{pid:child.pid,role:'client'}]:[]};}};
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
  if (cancellation) {
    // Cancellation tests need actual proof readiness, independently of deadline tests.
    let watchdog;
    const terminal = pending.then(result => ({ kind: 'terminal', result }), error => ({ kind: 'rejected', error }));
    try {
      const event = await Promise.race([
        api.snapshotReady.then(() => ({ kind: 'ready' })), terminal,
        new Promise(resolve => { watchdog = setTimeout(() => resolve({ kind: 'watchdog' }), 30_000); })
      ]);
      if (event.kind !== 'ready') {
        cancellation.abort();
        const { result } = await terminal;
        assert.fail('controlled snapshot never arrived: ' + JSON.stringify({ event: event.kind, status: result?.status,
          sessions: result?.sessions.length, stages: result?.stages.map(({ id, reason }) => ({ id, reason })) }));
      }
      cancellation.abort();
    } finally {
      clearTimeout(watchdog);
      if (!cancellation.signal.aborted) cancellation.abort();
      await terminal;
    }
  }
  const result = await pending;
  assert.deepEqual(validateNativeVerificationResult(result).diagnostics, []);
  if (scenario === 'client-state-log-cache-retained') {
    assert.equal(existsSync(join(sandboxRoot, result.cleanup.retainedCell, 'home', '.cache', 'claude-cli-nodejs',
      '-cell-project', 'mcp-logs-fixture', '2026-10-07T00-00-00.jsonl')), true);
  }
  if (scenario === 'client-state-log-cache-removed') assert.equal(result.cleanup.files, 'removed');
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
test('controlled ordinary client-owned state is preserved into the second session', async t => {
  const result = await controlled(t, 'client-state');
  assert.equal(result.status, 'complete', JSON.stringify(result)); assert.equal(result.verdict, 'verified');
  assert.equal(result.sessions.length, 2);
  assert.deepEqual(result.stages.filter(row => row.id === 'configuration-unchanged').map(row => row.outcome), ['passed', 'passed']);
  assert.equal(result.cleanup.files, 'removed');
});
for (const scenario of ['client-state-log-cache', 'client-state-log-cache-removed']) {
test(`controlled client log cache ${scenario} passes both persistence checkpoints and is cleaned up`, async t => {
  const records = [], stream = channel('aih.native.diagnostics.v1'), sink = value => records.push(value);
  stream.subscribe(sink);
  try {
    const result = await controlled(t, scenario);
    assert.equal(result.verdict, 'verified'); assert.equal(result.sessions.length, 2);
    assert.deepEqual(result.stages.filter(row => row.id === 'configuration-unchanged').map(row => row.outcome), ['passed', 'passed']);
    assert.equal(result.cleanup.files, 'removed');
    assert.equal(records.some(record => record.event === 'native-persistence-diagnostics'), false);
    assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
  } finally { stream.unsubscribe(sink); }
});
}

test('controlled client log cache is retained when process cleanup fails', async t => {
  const result = await controlled(t, 'client-state-log-cache-retained');
  assert.equal(result.status, 'incomplete'); assert.equal(result.cleanup.processes, 'unresolved');
  assert.equal(result.cleanup.files, 'retained'); assert.match(result.cleanup.retainedCell, /^aih-native-[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(result).includes('privacy-canary'), false);
});

test('controlled full ordinary client state set is preserved into the second session', async t => {
  const result = await controlled(t, 'client-state-full');
  assert.equal(result.status, 'complete', JSON.stringify(result.stages)); assert.equal(result.verdict, 'verified');
  assert.deepEqual(result.stages.filter(row => row.id === 'configuration-unchanged').map(row => row.outcome), ['passed', 'passed']);
  assert.equal(result.cleanup.files, 'removed');
});
test('controlled hard link inside ordinary client state is configuration-changed and blocks unsafe removal', async t => {
  const result = await controlled(t, 'client-state-hardlink');
  assert.equal(result.verdict, 'failed'); assert.equal(result.sessions.length, 1);
  assert.ok(result.stages.some(row => row.id === 'configuration-unchanged' && row.session === 2 && row.reason === 'configuration-changed'));
  // The existing cleanup rule never removes a tree containing a multiply linked file.
  assert.equal(result.status, 'incomplete'); assert.equal(result.cleanup.files, 'retained');
});
for (const scenario of ['client-state-changed-config', 'client-state-memory', 'client-state-memory-case',
  'client-state-user-mcp', 'client-state-project-mcp', 'client-state-allowed-tools', 'client-state-trust', 'client-state-unknown-key',
  'client-state-root-global', 'client-state-tiny-memory', 'client-state-session-aliases', 'client-state-personal-memory',
  'client-state-shell-snapshot', 'client-state-session-env', 'client-state-sessions', 'client-state-policy-limits',
  'conflicting-loading-source']) {
  test(`controlled ${scenario} beside ordinary client state is configuration-changed`, async t => {
    const result = await controlled(t, scenario);
    assert.equal(result.status, 'complete'); assert.equal(result.verdict, 'failed'); assert.equal(result.sessions.length, 1);
    assert.ok(result.stages.some(row => row.id === 'configuration-unchanged' && row.session === 2 && row.outcome === 'failed' &&
      row.reason === 'configuration-changed'), JSON.stringify(result.stages));
    assert.equal(result.cleanup.files, 'removed');
  });
}
for (const [scenario, outcome, reason] of [['state-two-wildcards', 'unavailable', 'native-internal'], ['state-traversal', 'unavailable', 'native-internal'],
  ['state-too-many', 'unavailable', 'native-internal'], ['state-inspector-missing', 'unavailable', 'native-internal'],
  ['state-overlap', 'unsupported', 'guardrail-path-conflict'], ['state-credential-overlap', 'unsupported', 'guardrail-path-conflict']]) {
  test(`controlled invalid client state contract ${scenario} stops before any session`, async t => {
    const result = await controlled(t, scenario);
    assert.equal(result.sessions.length, 0);
    assert.ok(result.stages.some(row => row.id === 'cell-staging' && row.outcome === outcome && row.reason === reason), JSON.stringify(result.stages));
    assert.ok(!result.stages.some(row => row.id === 'cell-staging' && row.outcome === 'passed'));
    assert.equal(result.cleanup.files, 'removed');
  });
}
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
test('provider authentication requires passed identity binding and exact staging in the same verification run', async t => {
  for (const [scenario, stage, reason] of [
    ['identity-capture-refused', 'identity-binding', 'identity-binding-invalid'],
    ['identity-recheck-refused', 'identity-binding', 'identity-binding-invalid'],
    ['identity-pre-staging-refused', 'cell-staging', 'identity-binding-invalid'],
    ['staging-refused', 'cell-staging', 'staging-unavailable']
  ]) {
    const result = await controlled(t, scenario);
    assert.ok(result.stages.some(row => row.id === stage && row.outcome === 'unavailable' && row.reason === reason), JSON.stringify(result.stages));
    assert.equal(result.sessions.length, 0, scenario);
    assert.equal(result.verdict, 'unverified');
    assert.equal(result.stages.some(row => row.id === 'provider-authentication' && row.outcome === 'passed'), false);
    assert.equal(result.stages.some(row => row.id === 'cell-staging' && row.outcome === 'passed'), false);
  }
  const passed = await controlled(t, 'healthy');
  assert.equal(passed.sessions.length, 2);
  assert.ok(passed.stages.some(row => row.id === 'identity-binding' && row.outcome === 'passed'));
  assert.ok(passed.stages.some(row => row.id === 'cell-staging' && row.outcome === 'passed' &&
    row.evidence.kind === 'digest' && row.evidence.sha256 === passed.content.stagedConfigurationDigest));
  for (const session of passed.sessions) {
    assert.equal(session.stagedConfigurationDigest, passed.content.stagedConfigurationDigest);
    assert.ok(session.stages.some(row => row.id === 'provider-authentication' && row.outcome === 'passed'));
  }
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
// The installed Harness runtime and its real bundled fixture, behind the public verifier. Only the host match is
// retargeted so each registered definition is reached on this machine; no client is resolved or launched.
async function installedFixture(t, definitionId, parserId) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-installed-native-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  cpSync(join(root, 'dist'), join(directory, 'dist'), { recursive: true });
  cpSync(join(root, 'package.json'), join(directory, 'package.json'));
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const native = join(directory, 'dist', 'harness', 'native');
  cpSync(join(native, 'runtime.mjs'), join(native, 'installed-runtime.mjs'));
  writeFileSync(join(native, 'runtime.mjs'), `
import { release } from 'node:os';
import * as installed from './installed-runtime.mjs';
export function createNativeRuntime(_module, dependencies) {
  const runtime = installed.createNativeRuntime(installed, dependencies);
  const registered = installed.nativeVerificationDefinitions.find(value => value.id === ${JSON.stringify(definitionId)});
  const platform = { os: process.platform, arch: process.arch, execution: process.platform === 'linux' && /microsoft/i.test(release()) ? 'wsl2' : 'native', osRelease: release() };
  const definition = { ...registered, platform, ...(${JSON.stringify(parserId ?? null)} ? { parserId: ${JSON.stringify(parserId ?? null)} } : {}) };
  return { ...runtime, nativeDefinitions: [definition], nativeManagedRestriction: () => false,
    resolveNativeClient: async () => ({ outcome: 'unavailable', reason: 'client-absent' }) };
}
`);
  writeFileSync(join(directory, 'entry.mjs'), "export { verifyNativeClient } from '@aihq/core';\n");
  const api = await import(pathToFileURL(join(directory, 'entry.mjs')).href);
  const cells = join(directory, 'cells'); mkdirSync(cells);
  const result = await api.verifyNativeClient(request, { admission: 'candidate-smoke', sandboxRoot: realpathSync.native(cells) });
  assert.deepEqual(validateNativeVerificationResult(result).diagnostics, []);
  return result;
}
const { bundledNativeFixtures, nativeVerificationDefinitions } = await import(new URL('../dist/harness/native/contracts.mjs', import.meta.url).href);
for (const definition of nativeVerificationDefinitions) {
  test(`the shared bundled fixture reaches host presence for ${definition.id}`, async t => {
    const result = await installedFixture(t, definition.id);
    const rows = result.stages.map(({ id, outcome, reason }) => ({ id, outcome, reason }));
    assert.deepEqual(rows.slice(0, 2), [{ id: 'fixture-integrity', outcome: 'passed', reason: 'observed' },
      { id: 'host-presence', outcome: 'unavailable', reason: 'client-absent' }], JSON.stringify(rows));
    assert.equal(result.adapter.id, definition.id); assert.equal(result.proofScope, 'bundled-mechanism');
    assert.equal(result.stages[0].evidence.sha256, bundledNativeFixtures[0].manifestSha256);
    assert.equal(result.sessions.length, 0); assert.equal(result.cleanup.files, 'not-created');
  });
}
test('the bundled fixture is refused by a definition whose fixed parser it does not bind', async t => {
  const result = await installedFixture(t, nativeVerificationDefinitions[0].id, 'claude-unbound.v1');
  assert.ok(result.stages.some(row => row.id === 'fixture-integrity' && row.outcome === 'unsupported' && row.reason === 'configuration-channel-unsupported'),
    JSON.stringify(result.stages));
  assert.ok(!result.stages.some(row => row.id === 'host-presence')); assert.equal(result.cleanup.files, 'not-created');
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
  const result = await controlled(t, 'deadline', { budgetMs: 10000 });
  assert.equal(result.status, 'incomplete'); assert.equal(result.verdict, 'unverified'); assert.equal(result.sessions.length, 1);
  assert.ok(result.sessions[0].stages.some(row => row.reason === 'budget-exhausted'));
  // A ready receipt from the actual child proves the deadline interrupted an active session.
  assert.ok(result.limits.observedBytes > 0);
  assert.equal(result.cleanup.processes, 'confirmed'); assert.equal(result.cleanup.files, 'removed');
});
for (const [profile, reason] of [
  ['completed-invalid-counts', 'native-internal'],
  ['completed-over-limit-counts', 'limit-exceeded'],
]) test('controlled completed proof retains the stop reason for ' + profile, async t => {
  const result = await controlled(t, profile);
  assert.equal(result.status, 'incomplete'); assert.equal(result.verdict, 'unverified'); assert.equal(result.sessions.length, 1);
  assert.ok(result.sessions[0].stages.every(row => row.outcome === 'passed'), JSON.stringify(result.sessions[0].stages));
  const matching = [...result.stages, ...result.sessions[0].stages].filter(row => row.reason === reason);
  assert.equal(matching.length, 1); assert.equal(matching[0].id, 'stop');
  assert.equal(matching[0].outcome, 'unavailable'); assert.equal(matching[0].session, null);
  assert.equal(result.diagnostics.filter(diagnostic => diagnostic.reason === reason).length, 1);
  assert.equal(result.cleanup.processes, 'confirmed'); assert.equal(result.cleanup.files, 'removed');
});
for (const [profile, stageId, outcome, reason] of [
  ['active-managed', 'tool-restrictions', 'restricted', 'managed-restriction'],
  ['active-managed-final', 'tool-restrictions', 'restricted', 'managed-restriction'],
  ['active-malformed', 'loading-mode', 'unavailable', 'native-internal'],
  ['active-identity', 'provider-authentication', 'unavailable', 'identity-conflict'],
  ['active-collector-cap', 'provider-authentication', 'unavailable', 'limit-exceeded'],
  ['active-collector-cap-unfinished', 'provider-authentication', 'unavailable', 'limit-exceeded'],
]) test('controlled session-local ' + profile + ' keeps canonical rows without a run stop', async t => {
  const result = await controlled(t, profile);
  assert.equal(result.status, 'incomplete'); assert.equal(result.verdict, 'unverified'); assert.equal(result.sessions.length, 1);
  assert.equal(result.stages.some(row => row.id === 'stop'), false);
  const stages = result.sessions[0].stages;
  assert.deepEqual(stages.map(row => row.id), ['session-freshness', 'loading-mode', 'tool-restrictions', 'provider-authentication', 'tool-discovery', 'instruction-loading', 'read-only-query', 'isolation', 'cleanup']);
  assert.ok(stages.some(row => row.id === 'session-freshness' && row.outcome === 'passed'));
  assert.ok(stages.some(row => row.id === stageId && row.outcome === outcome && row.reason === reason), JSON.stringify(stages));
  if (profile.startsWith('active-managed')) assert.ok(stages.filter(row => !['session-freshness', 'tool-restrictions', 'cleanup'].includes(row.id)).every(row => row.outcome === 'unavailable' && row.reason === 'not-run-after-restriction'));
  if (profile.startsWith('active-collector-cap')) assert.equal(stages.some(row => row.id === 'provider-authentication' && row.outcome === 'passed'), false);
  assert.equal(result.cleanup.processes, 'confirmed'); assert.equal(result.cleanup.files, 'removed');
});
for (const interruption of ['cancel', 'budget']) {
  // Snapshot semantics use the controlled budget-stop event above; a short
  // wall-clock window would also test unrelated process/fixture startup speed.
  for (const [profile, verdict, queryOutcome] of [
    ['pending-receipt', 'unverified', 'unavailable'],
    ['bad-query-pending-receipt', 'failed', 'failed'],
    ['missing-result', 'unverified', 'unavailable'],
    ['bad-client-answer', 'failed', 'failed'],
    ['missing-result-bad-client-answer', 'failed', 'failed'],
  ]) test('controlled ' + interruption + ' distinguishes missing query proof from contradiction: ' + profile, async t => {
    const result = await controlled(t, interruption + '-snapshot-' + profile);
    assert.equal(result.status, interruption === 'cancel' ? 'cancelled' : verdict === 'failed' ? 'complete' : 'incomplete');
    assert.equal(result.verdict, verdict); assert.equal(result.sessions.length, 1);
    const stages = result.sessions[0].stages;
    for (const id of ['session-freshness', 'loading-mode', 'tool-restrictions', 'provider-authentication', 'tool-discovery', 'instruction-loading'])
      assert.ok(stages.some(row => row.id === id && row.outcome === 'passed'), JSON.stringify(stages));
    assert.ok(stages.some(row => row.id === 'read-only-query' && row.outcome === queryOutcome &&
      row.reason === (queryOutcome === 'failed' ? 'query-answer-mismatch' : 'server-evidence-unavailable')));
    assert.ok(result.limits.observedBytes > 0); assert.equal(result.cleanup.processes, 'confirmed'); assert.equal(result.cleanup.files, 'removed');
  });
  test('controlled ' + interruption + ' retains a completed query contradiction and prior proof', async t => {
    const result = await controlled(t, interruption + '-snapshot-bad-query');
    assert.equal(result.status, interruption === 'cancel' ? 'cancelled' : 'complete');
    assert.equal(result.verdict, 'failed'); assert.equal(result.sessions.length, 1);
    const stages = result.sessions[0].stages;
    for (const id of ['session-freshness', 'loading-mode', 'tool-restrictions', 'provider-authentication', 'tool-discovery', 'instruction-loading'])
      assert.ok(stages.some(row => row.id === id && row.outcome === 'passed'), JSON.stringify(stages));
    assert.ok(stages.some(row => row.id === 'read-only-query' && row.outcome === 'failed' && row.reason === 'query-answer-mismatch'));
    assert.ok(result.limits.observedBytes > 0); assert.equal(result.cleanup.files, 'removed');
  });
  test('controlled ' + interruption + ' preserves finished protocol rows while authentication is unfinished', async t => {
    const result = await controlled(t, interruption + '-snapshot-unfinished-auth');
    assert.equal(result.status, interruption === 'cancel' ? 'cancelled' : 'incomplete');
    assert.equal(result.verdict, 'unverified'); assert.equal(result.sessions.length, 1);
    const stages = result.sessions[0].stages;
    if (interruption === 'budget') assert.ok(stages.some(row => row.reason === 'budget-exhausted'), JSON.stringify(stages));
    assert.ok(stages.some(row => row.id === 'provider-authentication' && row.outcome === 'unavailable'));
    assert.ok(stages.some(row => row.id === 'read-only-query' && row.outcome === 'passed'));
    assert.ok(stages.some(row => row.id === 'isolation' && row.outcome === 'unavailable'));
    assert.equal(result.cleanup.processes, 'confirmed'); assert.equal(result.cleanup.files, 'removed');
  });
  test('controlled ' + interruption + ' retains a query failure after unfinished authentication', async t => {
    const result = await controlled(t, interruption + '-snapshot-bad-query-unfinished-auth');
    assert.equal(result.status, interruption === 'cancel' ? 'cancelled' : 'complete');
    assert.equal(result.verdict, 'failed'); assert.equal(result.sessions.length, 1);
    const stages = result.sessions[0].stages;
    if (interruption === 'budget') assert.ok(stages.some(row => row.reason === 'budget-exhausted'), JSON.stringify(stages));
    assert.ok(stages.some(row => row.id === 'provider-authentication' && row.outcome === 'unavailable'));
    assert.ok(stages.some(row => row.id === 'read-only-query' && row.outcome === 'failed' && row.reason === 'query-answer-mismatch'));
    assert.equal(result.cleanup.files, 'removed');
  });
}
test('controlled failure before a client starts preserves unresolved helper cleanup', async t => {
  const result = await controlled(t, 'pre-client-cleanup-unresolved');
  assert.equal(result.status, 'incomplete');
  assert.equal(result.sessions.length, 0);
  assert.equal(result.cleanup.processes, 'unresolved');
  assert.equal(result.cleanup.files, 'retained');
  assert.deepEqual(result.survivingProcesses, [{ pid: 65000, role: 'helper' }]);
  assert.ok(result.stages.some(row => row.reason === 'termination-unresolved'));
});

test('controlled protection failure carries its helper receipt before session creation', async t => {
  const result = await controlled(t, 'protect-helper-cleanup-unresolved');
  assert.equal(result.status, 'incomplete');
  assert.equal(result.sessions.length, 0);
  assert.equal(result.cleanup.processes, 'unresolved');
  assert.equal(result.cleanup.files, 'retained');
  assert.deepEqual(result.survivingProcesses, [{ pid: 65001, role: 'helper' }]);
  assert.ok(result.stages.some(row => row.id === 'cleanup' && row.reason === 'termination-unresolved'));
});
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


test('controlled housekeeping passes both persistence checkpoints with diagnostics on or off', async t => {
  const plain = await controlled(t, 'client-state-housekeeping');
  const records = [], stream = channel('aih.native.diagnostics.v1'), sink = value => records.push(value);
  stream.subscribe(sink);
  try {
    const observed = await controlled(t, 'client-state-housekeeping');
    assert.equal(plain.verdict, 'verified'); assert.equal(observed.verdict, plain.verdict);
    for (const result of [plain, observed]) {
      assert.equal(result.sessions.length, 2);
      assert.deepEqual(result.stages.filter(row => row.id === 'configuration-unchanged').map(row => row.reason), ['before-session-2', 'after-session-2']);
      assert.deepEqual(result.stages.filter(row => row.id === 'configuration-unchanged').map(row => row.outcome), ['passed', 'passed']);
      assert.equal(result.cleanup.files, 'removed');
    }
    assert.equal(records.some(record => record.event === 'native-persistence-diagnostics'), false);
  } finally { stream.unsubscribe(sink); }
});
test('controlled registry child after session 2 fails the final persistence checkpoint', async t => {
  const result = await controlled(t, 'client-state-registry-after-session-2');
  assert.equal(result.verdict, 'failed'); assert.equal(result.sessions.length, 2);
  assert.deepEqual(result.stages.filter(row => row.id === 'configuration-unchanged').map(row => row.outcome), ['passed', 'failed']);
});
