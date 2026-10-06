import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { contractSupport as harnessSupport, selectRepairDefinition, selectTrustCell, trustCapabilities, exportDefaultNames, type TrustCapabilityCell } from '../harness/contracts.mjs';
import { discoverTrustSources, serializeTrustSet, parseTrustOutput, reviewTrustDelta, trustHelperFiles,
  detectTrustPlatform, verifyTrustAdmissionEvidence, hashTrustLibraries, getTrustFileIntegration, type TrustDiscovery } from '../harness/trust.mjs';
import { getTrustRecipe, renderRepair, assessRepairObservations } from '../harness/runtime.mjs';
import { observeRepair } from './repair.js';
import { validateTrustRepairRequest, validateCertificateExportRequest } from './trust-contracts.js';
import { prepare as preparePolicy, apply as applyPolicy, dataObject, validateControls } from './recipe-engine.js';
import { canonicalJson } from './internal/canonical.js';
import { cloneJsonValueStructureV1, deepFreezeStrictJsonV1, parseStrictJsonObjectV1 } from './internal/strict-json.js';
import { distributionManifest, installedDistribution } from './internal/installed-distribution.js';
import { pathPins, pinsMatch, sha256, userHomeRoot, type PathPin } from './internal/host-files.js';
import { readRegularFile, readRegularFileWithStats } from './internal/fsxn.js';
import { readOwnership, stateRoot, protectState, writeHistory } from './internal/state.js';
import { readTrustCustody, readPendingTrust, pendingEntries, custodyParticipant, type TrustCustodyEntry, type TrustCustodyImage } from './internal/trust-custody.js';
import { memberKey } from './internal/recipe-lifecycle.js';
import { resolveTrustPath, type TrustPath } from './internal/trust-path.js';
import { joinSessionParticipant } from './internal/macos-session-custody.js';
import type { TrustEngineParticipant } from './internal/trust-participant.js';
import type { Diagnostic, Recipe } from './types.js';
import type { TrustRepairRequest, CertificateExportRequest, TrustSources, TrustInputs,
  TrustTargetReview, TrustOutputReview, TrustRunOutput, TrustRunTarget } from './trust-contracts.js';
import type { Authorization, HostControls, PreparationResult, PreparedHandle, PreparedReview, RunResult } from './host-types.js';

const EXPORT = 'urn:aihq:core:certificate-export-request:1.0.0';
const REPAIR = 'urn:aihq:core:repair-request:1.0.0';
const DEFINITION = 'urn:aihq:harness:repair:1.1.0';
const PREPARED = 'urn:aihq:core:prepared-work:1.2.0' as const;
const RESULT = 'urn:aihq:core:run-result:1.2.0' as const;
const disabled = { status: 'disabled', reason: 'logging-off' } as const;
type Request = TrustRepairRequest | CertificateExportRequest;
interface Capture { file: string; pins: PathPin[]; bytes: Buffer; sha256: string; origin: 'explicit' | 'retained'; admittedSha256?: string }
class SourceCaptureFailure extends Error {
  constructor(readonly origin: Capture['origin'], reason: string) { super(reason); }
}
interface TrustState { request: Request; requestSha256: string; policy: PreparedHandle; policyDigest: string; review: PreparedReview;
  inputs: TrustInputs; captures: Map<string, Capture>; discovery: TrustDiscovery; helperSha256: string; material: { path: string; directory: string; pins: PathPin[] };
  output: TrustPath; entry: TrustCustodyEntry; includeNodeBundled: boolean; policyControls: HostControls; recheck(signal?:AbortSignal):Promise<void> }
const handles = new WeakMap<PreparedHandle, TrustState>();
const knownHandles = new WeakMap<PreparedHandle, Request['useCase']>();
const stagedMaterials = new Set<TrustState['material']>();
process.once('exit',() => { for (const material of stagedMaterials) cleanup(material); });
const hash = (v: unknown) => sha256(canonicalJson(v));
const admissionModule=join(dirname(distributionManifest),'dist/harness/trust-capabilities.mjs');
// An ESM import stays cached. A changed installed module cannot revoke a cell while
// leaving its old imported object authorized in this process.
const loadedAdmissionSha256=(()=>{try {
  const bytes=readRegularFile(admissionModule,{maxBytes:1_048_576});if(!bytes)return null;
  // Harness may have been imported before Core. Compare the fixed JSON payload
  // with its cached object without evaluating changed installed JavaScript.
  const payload=/export const trustCellRecords = Object\.freeze\((\[[\s\S]*\])\);\s*$/.exec(bytes.toString('utf8'))?.[1];
  if(!payload||canonicalJson(parseStrictJsonObjectV1(`{"cells":${payload}}`,'admission').cells)!==canonicalJson(trustCapabilities.cells))return null;
  return sha256(bytes);
}catch{return null;}})();
function installedAdmission(cell?: TrustCapabilityCell): string {
  const bytes=readRegularFile(admissionModule,{maxBytes:1_048_576});
  if(!bytes||sha256(bytes)!==loadedAdmissionSha256) throw new Error('trust-admission-changed');
  if(!cell) return hash({module:sha256(bytes)});
  const root=dirname(distributionManifest),path=join(root,cell.evidence.reference);
  if(relative(root,path).startsWith('..')||isAbsolute(relative(root,path))) throw new Error('evidence-path');
  const evidence=readRegularFile(path,{maxBytes:1_048_576});
  if(!evidence||sha256(evidence)!==cell.evidence.sha256) throw new Error('evidence-unavailable');
  return hash({module:sha256(bytes),cell,evidence:{reference:cell.evidence.reference,sha256:sha256(evidence)}});
}
const diagnostic = (code: string, reason: string): Diagnostic => ({ code, reason, message: 'Review the reported trust prerequisite and prepare again.' });
function publicDiagnostics(rows: readonly Diagnostic[], review?: PreparedReview): Diagnostic[] {
  return rows.map(row => {
    const publicRow: Diagnostic={code:row.code,reason:row.reason,message:row.message};
    for (const key of ['path','encountered','supported','guidance'] as const) if (row[key] !== undefined)
      Object.assign(publicRow,{[key]:row[key]});
    const sourceId=(row as Diagnostic & {sourceId?:string}).sourceId;
    if (sourceId && review && 'trust' in review.inputs) {
      const index=review.inputs.trust.sources.findIndex(source => source.id === sourceId);
      if (index >= 0) publicRow.path=`/inputs/trust/sources/${index}`;
    }
    return publicRow;
  });
}
function trustControls(controls: HostControls): void { dataObject(controls, ['signal','logging']); validateControls(controls); }
function record<T extends PreparationResult | RunResult>(result: T, controls: HostControls): T {
  const safe = JSON.parse(JSON.stringify({ ...result, prepared: undefined }));
  // Source bodies and private bindings are absent by construction. Redact the routine home path.
  let text = JSON.stringify(safe); const home = userHomeRoot();
  for (const path of [home, home.replaceAll('\\','/')]) text = text.split(JSON.stringify(path).slice(1,-1)).join('<home>');
  result.record = writeHistory(result.runId, JSON.parse(text), controls.logging ?? 'on');
  if (result.record.status === 'failed') result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', result.record.reason));
  return result;
}
function installedHelper(): string {
  const root = dirname(distributionManifest); const packageIdentity = installedDistribution();
  if (canonicalJson(packageIdentity) !== canonicalJson(harnessSupport.package)) throw new Error('harness-unsupported');
  const names = [...new Set(['package.json','dist/distribution.mjs','dist/harness/contracts.mjs','dist/harness/runtime.mjs','dist/harness/ca.mjs',
    'dist/harness/user-trust-definitions.mjs','dist/harness/user-trust.mjs','dist/harness/jvm-trust-definitions.mjs',
    ...trustHelperFiles.map(name => name.startsWith('dist/') ? name : `dist/${name}`)])].sort();
  const libraries = hashTrustLibraries({packageRoot:root}); if (libraries.status !== 'hashed') throw new Error(libraries.reason);
  return hash({libraries:libraries.sha256,helpers:names.map(name => { const bytes = readRegularFile(join(root,name), { maxBytes: 4_000_000 });
    if (!bytes) throw new Error('harness-unavailable'); return { name, sha256: sha256(bytes) }; })});
}
function capture(file: string, origin: Capture['origin'], admittedSha256?: string): Capture {
  try {
  if (typeof file !== 'string' || !isAbsolute(file) || file.length > 4096) throw new Error('source-path');
  const pins = pathPins(file); const first = readRegularFileWithStats(file, { maxBytes: 1_048_576 });
  const second = readRegularFileWithStats(file, { maxBytes: 1_048_576 });
  if (!first || !second || !first.contents.equals(second.contents) || first.identity.dev !== second.identity.dev ||
      first.identity.ino !== second.identity.ino || !pinsMatch(pins)) throw new Error(origin === 'retained' ? 'supplied-source-unavailable' : 'source-unavailable');
  const digest = sha256(first.contents);
  if (origin === 'retained' && digest !== admittedSha256) throw new Error('supplied-source-changed');
  return { file, pins, bytes: first.contents, sha256: digest, origin, ...(admittedSha256 === undefined ? {} : { admittedSha256 }) };
  } catch(error) {
    const reason=error instanceof Error&&/^[a-z-]{1,64}$/.test(error.message)?error.message:'source-unavailable';
    throw new SourceCaptureFailure(origin,origin==='retained'&&reason!=='supplied-source-changed'?'supplied-source-unavailable':reason);
  }
}
function captureSources(sources: TrustSources, prior?: TrustCustodyEntry, pendingIds:ReadonlySet<string>=new Set()): Map<string, Capture> {
  const paths = new Map((prior?.sources ?? []).filter(s => s.kind === 'supplied').map(s => [s.id.startsWith('supplied:') ? s.id.slice(9) : s.id, { file: s.privateFile!, digest: s.sourceSha256 }]));
  for (const id of sources.removeSupplied ?? []) { if (!paths.delete(id)&&!pendingIds.has(id)) throw new Error('invalid-source-selection'); }
  for (const item of sources.supplied) paths.set(item.id, { file: item.file, digest: '' });
  if (paths.size > 32) throw new Error('source-limit');
  const captures = new Map<string,Capture>();
  for (const [id, p] of [...paths].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0))
    captures.set(id, capture(p.file, p.digest ? 'retained' : 'explicit', p.digest || undefined));
  if (!sources.os && captures.size === 0 && !prior&&!pendingIds.size) throw new Error('invalid-source-selection');
  return captures;
}
async function discover(sources: TrustSources, captures: Map<string,Capture>, request: Request, includeNodeBundled: boolean, signal?: AbortSignal): Promise<TrustDiscovery> {
  return discoverTrustSources({ sources: { os: sources.os, supplied: [...captures].map(([id,c]) => ({ id, bytes: c.bytes,
    origin: c.origin, ...(c.admittedSha256 === undefined ? {} : { admittedSha256: c.admittedSha256 }) })) },
    network: request.network ?? 'declared', includeNodeBundled, ...(signal === undefined ? {} : { signal }) });
}
function baseReview(useCase: Request['useCase'], route: 'native'|'file'|'export', id: string, controls: HostControls): PreparedReview {
  let home = ''; try { home = userHomeRoot(); } catch { /* Invalid home yields blocked before effects. */ }
  return { schema: PREPARED, useCase, mode: 'standalone', target: { scope: 'user', project: home },
    inputs: { trust: { route, definition: { id, schema: DEFINITION }, helperSha256: '0'.repeat(64), package: { name: '@aihq/core', version: harnessSupport.package.version },
      bindingSha256: '0'.repeat(64), sourceSetSha256: route === 'native' ? null : sha256('aih.trust.sources.v1\0[]'), targets: [], sources: [], certificates: [], outputs: [] } },
    operations: [], observations: [], conflicts: [], omissions: [],
    effectiveOptions: { logging: { value: controls.logging ?? 'on', origin: controls.logging === undefined ? 'default' : 'explicit' }, inputs: {} }, reviewDigest: '' };
}
function unavailableTarget(id: string, route: 'native'|'file', reason: string): TrustTargetReview {
  return { id, route, admission: 'unavailable', reason, cellId: null, client: null, policy: null, configurationSha256: null,
    secondarySources: [], verification: { status: 'unavailable', reason, checkIds: [] } };
}
function cleanup(material?: TrustState['material']): void {
  if (!material) return;
  stagedMaterials.delete(material);
  if (!pinsMatch(material.pins)) return;
  try { unlinkSync(material.path); rmdirSync(material.directory); } catch { /* Inert protected work remains for deliberate inspection. */ }
}

export async function prepareTrust(input: Request, controls: HostControls = {},
  sessionParticipant?: (entry: TrustCustodyEntry) => TrustEngineParticipant): Promise<PreparationResult> {
  const runId = randomUUID(); let safeControls: HostControls = { logging: 'off' }; let material: TrustState['material'] | undefined;
  let rawUseCase: Request['useCase'] = 'certificate-export'; let route: 'native'|'file'|'export' = 'export'; let id = 'certificate-export';
  let review = baseReview(rawUseCase, route, id, safeControls);
  const done = (status: PreparationResult['status'], diagnostics: Diagnostic[], resolutions: NonNullable<PreparationResult['resolutionInputs']> = []): PreparationResult => {
    diagnostics=publicDiagnostics(diagnostics,review);
    cleanup(material); review.conflicts = diagnostics.filter(d => d.code === 'STATE_CONFLICT'); review.omissions = diagnostics.filter(d => d.code !== 'STATE_CONFLICT');
    const { reviewDigest: _digest, ...content } = review; review.reviewDigest = hash(content);
    return record({ status, runId, ...(status === 'invalid' || status === 'cancelled' ? {} : {review: deepFreezeStrictJsonV1(review)}), diagnostics, record: disabled, resolutionInputs: resolutions }, safeControls);
  };
  try {
    trustControls(controls); safeControls = controls;
    const request = cloneJsonValueStructureV1(input, 'trust request', 32) as Request;
    if (request.schema !== EXPORT && request.schema !== REPAIR) return done('invalid', [diagnostic('SCHEMA_UNSUPPORTED','schema-unsupported')]);
    rawUseCase = request.useCase; route = request.useCase === 'certificate-export' ? 'export' : request.route;
    id = request.useCase === 'certificate-export' ? 'certificate-export' : request.repairs?.[0]?.id ?? '';
    review = baseReview(rawUseCase,route,id,controls);
    const validation = request.schema === EXPORT ? validateCertificateExportRequest(request) : validateTrustRepairRequest(request);
    if (!validation.valid) return done('invalid', validation.diagnostics);
    if (controls.signal?.aborted) return done('cancelled', [diagnostic('CANCELLED','cancelled')]);
    const definition = selectRepairDefinition({ requestSchema: request.schema, repairId: id, definitionSchema: DEFINITION });
    if (!definition) return done('invalid', [diagnostic('SCHEMA_UNSUPPORTED','schema-unsupported')]);
    const targetIds = request.useCase === 'repair' ? definition.targets.filter(t => request.repairs[0].targets.includes(t)) : [];
    const variant = definition.variants.find(v => 'route' in v && v.route === route && v.os === process.platform && v.architectures.some(a => a === process.arch) &&
      v.network === (request.network ?? 'declared') && canonicalJson(v.targets) === canonicalJson(targetIds));
    const inputVariants=definition.variants.filter(v=>'route' in v&&v.route===route);
    const inputIds=variant&&'inputIds' in variant?variant.inputIds:inputVariants.reduce<string[]>((ids,v)=>ids.filter(key=>'inputIds' in v&&v.inputIds.includes(key)),
      inputVariants[0]&&'inputIds' in inputVariants[0]?[...inputVariants[0].inputIds]:[]);
    if (request.useCase === 'repair') {
      dataObject(request.repairs[0].inputs,[...inputIds]);
      for(const key of inputIds) {
        const declaration=definition.inputs[key];const value=request.repairs[0].inputs[key];
        if (!declaration) throw new Error('harness-unsupported');
        if (value===undefined&&!declaration.required) continue;
        const invalid=declaration.type==='file' ? typeof value!=='string'||!isAbsolute(value)||value.length>4096||/[\p{Cc}\p{Cf}]/u.test(value) :
          declaration.type==='string' ? typeof value!=='string'||value.length>(declaration.maxLength??4096)||/[\p{Cc}\p{Cf}]/u.test(value) :
          declaration.type==='boolean' ? typeof value!=='boolean' : typeof value!=='number'||!Number.isSafeInteger(value);
        if(invalid) return done('invalid',[diagnostic('INPUT_INVALID','repair-input')]);
      }
    }
    const helperSha256 = installedHelper();
    let cell: TrustCapabilityCell|undefined;let admissionSha256=installedAdmission();
    const inputs = review.inputs as TrustInputs; inputs.trust.helperSha256 = helperSha256;
    inputs.trust.bindingSha256 = hash({request,helperSha256,admissionSha256,home:userHomeRoot()});
    const isExport=request.useCase==='certificate-export';
    const integration=isExport?undefined:getTrustFileIntegration(id,targetIds);
    if (route === 'native' || !isExport&&integration?.status!=='supported') {
      const reason = route === 'native' ? 'native-route-unsupported' : 'file-route-unsupported';
      inputs.trust.targets = targetIds.map(t => unavailableTarget(t,route === 'native' ? 'native':'file',reason));
      return done('blocked',[diagnostic('PREREQUISITE_UNAVAILABLE',reason)]);
    }
    const image = readTrustCustody(true);const pending=readPendingTrust(image); const home = userHomeRoot();
    const format = isExport ? request.format ?? 'pem' : integration!.status==='supported'?integration!.format:'pem';
    if (isExport) {
      const platform = detectTrustPlatform();
      if (!platform.release) return done('blocked',[diagnostic('PREREQUISITE_UNAVAILABLE','trust-platform-unsupported')]);
      const admission = selectTrustCell({ definitionId:id,route:'export',target:null,
        platform:{ os:platform.os,release:platform.release,architecture:platform.architecture },network:request.network ?? 'declared',format },trustCapabilities);
      if (admission.status !== 'admitted') return done('blocked',[diagnostic('PREREQUISITE_UNAVAILABLE','trust-format-unavailable')]);
      if (!variant||!('capabilityIds' in variant)||!variant.capabilityIds.includes(admission.cell.id)) return done('blocked',[diagnostic('PREREQUISITE_UNAVAILABLE','trust-format-unavailable')]);
      const evidence = verifyTrustAdmissionEvidence({ packageRoot:dirname(distributionManifest),capabilities:trustCapabilities });
      if (!evidence.valid) return done('blocked',evidence.diagnostics);
      cell=admission.cell;admissionSha256=installedAdmission(cell);
      inputs.trust.bindingSha256=hash({request,helperSha256,admissionSha256,home});
    }
    let output: TrustPath; let managementId: string; const selectionId = isExport ? 'export':'trust'; const operationId = isExport ? 'write-ca':'material';
    if (isExport) {
      const known=new Map(image.value.entries.map(e=>[e.pathKey,e]));
      for(const entry of pending?pendingEntries(pending):[])if(!known.has(entry.pathKey))known.set(entry.pathKey,entry);
      output = resolveTrustPath(request.output ?? `.aih/exports/${exportDefaultNames[format]}`,format,[...known.values()]);
      managementId = `ca-export-${sha256(output.pathKey)}`;
    } else {
      if(!definition.managementId||!definition.materialName) throw new Error('harness-unsupported');
      managementId = definition.managementId;
      const managed = join(stateRoot(),'content',sha256(`${home}\0user\0${managementId}`),definition.materialName);
      const relativePath = relative(home,managed).replaceAll('\\','/');
      output = { home,path:managed,relativePath,pathKey:canonicalJson({ home,segments:relativePath.split('/') }),pins:pathPins(managed) };
    }
    if (!isExport && !variant) return done('blocked',[diagnostic('PREREQUISITE_UNAVAILABLE','file-route-unsupported')]);
    const observations = !isExport && variant ? assessRepairObservations({id,managedPath:output.path,variantRef:variant.recipeRef,
      observations:observeRepair(id,targetIds,variant.recipeRef)}) : [];
    const unresolvedObservations = observations.filter(o => o.conflict && !request.resolutions?.some(r => r.selectionId === selectionId && r.operationId === o.operationId &&
      r.choice === 'replace' && r.observedSha256 === sha256(o.observedValue!)));
    if (unresolvedObservations.length) return done('blocked',[diagnostic('STATE_CONFLICT','existing-target-observation')],unresolvedObservations.map(o => ({selectionId,
      operationId:o.operationId,observedSha256:sha256(o.observedValue!),availableChoices:['replace']})));
    const policyResolutions = request.resolutions?.filter(r => !observations.some(o => r.selectionId === selectionId && r.operationId === o.operationId));
    const prior = image.value.entries.find(e => e.pathKey === output.pathKey);
    const sources: TrustSources = request.sources ?? { os: true,supplied: [] };
    const pendingIds=new Set<string>();
    if(pending) {
      // A one-output request cannot discharge another pending output's obligations.
      if(pending.intent.outputs.length!==1||pending.intent.outputs[0]!.pathKey!==output.pathKey) throw new Error('trust-custody-pending');
      const explicit=new Set(sources.supplied.map(s=>s.id)),removed=new Set(sources.removeSupplied??[]);
      const obligations=[...pending.before.entries,...pending.after.entries].filter(e=>e.pathKey===output.pathKey).flatMap(e=>e.sources.filter(s=>s.kind==='supplied'));
      for(const source of obligations)pendingIds.add(source.id.slice(9));
      if([...removed].some(sourceId=>!pendingIds.has(sourceId)&&!prior?.sources.some(s=>s.kind==='supplied'&&s.id===`supplied:${sourceId}`)))throw new Error('invalid-source-selection');
      if(obligations.some(s=>!explicit.has(s.id.slice(9))&&!removed.has(s.id.slice(9)))) throw new Error('trust-custody-pending');
      review.observations.push({id:'pending-trust-reconciliation',reason:`pending-intent:${pending.digest}; before:${pending.beforeSha256}; after:${pending.afterSha256}`});
    }
    let osFileAdmissionUnavailable = false;
    if (!isExport) {
      const platform=detectTrustPlatform();
      inputs.trust.targets=targetIds.map(target => {
        if (!sources.os) return unavailableTarget(target,'file','file-prerequisite-unavailable');
        const selected=platform.release ? selectTrustCell({definitionId:id,route:'file',target,
          platform:{os:platform.os,release:platform.release,architecture:platform.architecture},network:request.network ?? 'declared'},trustCapabilities):undefined;
        // A cell alone cannot establish the actual executable/backend/configuration binding.
        // No installed OS-sourced client binding adapter is admitted in this distribution.
        osFileAdmissionUnavailable=true;
        return unavailableTarget(target,'file',selected?.status === 'admitted' ? 'client-binding-unavailable':'file-route-unsupported');
      });
    }
    const captures = captureSources(sources,prior,pendingIds); const includeNodeBundled = integration?.status==='supported'&&integration.includeNodeBundled;
    if ((prior||pending) && !sources.os && captures.size === 0 && !includeNodeBundled) return done('blocked',[diagnostic('PREREQUISITE_UNAVAILABLE','trust-output-empty')]);
    const discovery = await discover(sources,captures,request,includeNodeBundled,controls.signal);
    inputs.trust.sources = discovery.sources; inputs.trust.sourceSetSha256 = discovery.sourceSetSha256 ?? sha256(`aih.trust.sources.v1\0${canonicalJson(discovery.sources)}`);
    inputs.trust.certificates = reviewTrustDelta({ discovery, ...(prior ? { prior: { sources: prior.sources } } : {}) });
    if (discovery.status !== 'ready') return done(discovery.status,discovery.diagnostics);
    if (osFileAdmissionUnavailable) return done('blocked',[diagnostic('PREREQUISITE_UNAVAILABLE','file-route-unsupported')]);
    const serialized = await serializeTrustSet({ format,certificates: [...discovery.der.values()].map(der => ({ der })) });
    if (serialized.status !== 'serialized') return done('blocked',[diagnostic(serialized.code,serialized.reason)]);
    const before = readRegularFile(output.path,{ maxBytes:16*1024*1024 });
    const ownership = readOwnership(isExport ? home : dirname(output.path));
    const owner = ownership.value.members[memberKey({kind:'file',path:isExport ? output.relativePath : definition.materialName!})];
    const beforeSha256 = before ? sha256(before):null;
    let conflict: string | undefined; let hint = false;
    if (!prior && owner?.managementId.startsWith('ca-export-')) conflict='trust-custody-conflict';
    if (prior) {
      if (!owner || !before) conflict = 'trust-custody-conflict';
      else if (owner.managementId !== managementId || owner.claims?.some(c => c.managementId !== managementId) || owner.sha256 === prior.outputSha256 && owner.recipeIdentity !== prior.recipeIdentity) conflict = 'trust-custody-conflict';
      else if (beforeSha256 !== prior.outputSha256) { conflict = 'trust-output-conflict'; hint = true; }
      else if (owner.sha256 !== prior.outputSha256 || owner.recipeIdentity !== prior.recipeIdentity) conflict = 'trust-custody-conflict';
    } else if (before) {
      conflict = owner?.managementId.startsWith('ca-export-') ? 'trust-custody-conflict':'trust-output-conflict';
      hint = conflict === 'trust-output-conflict' && (!owner || owner.managementId === managementId && !owner.claims?.some(c => c.managementId !== managementId));
    }
    if(pending&&!(prior&&before&&owner&&owner.managementId===prior.managementId&&owner.recipeIdentity===prior.recipeIdentity&&
      owner.sha256===prior.outputSha256&&beforeSha256===prior.outputSha256)) {
      // Pending evidence proves consistency only. Fresh exact replacement establishes
      // missing authority/provenance from explicitly validated sources.
      conflict=before?'trust-output-conflict':undefined;hint=!!before;
    }
    if (prior && beforeSha256 !== prior.outputSha256) review.observations.push({id:'recorded-trust-custody',
      reason:`recorded-output:${prior.outputSha256}; observed-output:${beforeSha256 ?? 'absent'}; recorded-recipe:${prior.recipeIdentity}; observed-recipe:${owner?.recipeIdentity ?? 'absent'}`});
    let parsedPrior: ReturnType<typeof parseTrustOutput> | undefined;
    if (before) {
      parsedPrior = parseTrustOutput(before,format,{ maxBytes:16*1024*1024 });
      if (parsedPrior.status !== 'parsed') {
        if (!conflict || conflict === 'trust-output-conflict') conflict = 'existing-trust-uncomposable';
        hint = false;
      }
      else inputs.trust.certificates = reviewTrustDelta({ discovery,prior:{ sources:prior?.sources ?? [],output:parsedPrior } });
    }
    const resolution = request.resolutions?.find(r => r.selectionId === selectionId && r.operationId === operationId);
    if (resolution && (!hint || resolution.observedSha256 !== beforeSha256 || resolution.choice !== 'replace')) return done('invalid',[diagnostic('INPUT_INVALID','resolution-stale')]);
    const outputRow: TrustOutputReview = { selectionId,operationId,managementId,path:output.path,pathKey:output.pathKey,format,
      consumerProfile:serialized.consumerProfile,beforeSha256,afterSha256:serialized.sha256,custodyBeforeSha256:image.digest,
      certificateCount:serialized.certificateCount,effect:conflict ? 'conflict':beforeSha256 === serialized.sha256 ? 'unchanged':before ? 'replace':'create' };
    inputs.trust.outputs = [outputRow];
    if (conflict && !resolution) return done('blocked',[diagnostic('STATE_CONFLICT',conflict)],hint ? [{ selectionId,operationId,observedSha256:beforeSha256,availableChoices:['replace'] }]:[]);
    const entry: TrustCustodyEntry = { managementId,selectionId,operationId,pathKey:output.pathKey,relativePath:output.relativePath,format,
      outputSha256:serialized.sha256,recipeIdentity:`sha256:${'0'.repeat(64)}`,sourceSetSha256:discovery.sourceSetSha256!,
      sources:discovery.sources.map(s => ({ id:s.id,kind:s.kind,fingerprints:[...s.fingerprints],sourceSha256:s.sourceSha256!,policySha256:s.policySha256,
        runtimeVersion:s.runtimeVersion,privateFile:s.kind === 'supplied' ? captures.get(s.id.startsWith('supplied:') ? s.id.slice(9) : s.id)?.file ?? null:null })) };
    const directory = join(stateRoot(),'work',runId); protectState(); mkdirSync(directory,{ recursive:true,mode:0o700 }); protectState([`work/${runId}`]);
    const materialPath = join(directory,'trust-material'); writeFileSync(materialPath,serialized.bytes,{ flag:'wx',mode:0o600 }); protectState([`work/${runId}/trust-material`]);
    material = { path:materialPath,directory,pins:pathPins(materialPath) };
    stagedMaterials.add(material);
    let recipe: Recipe; let configuration: Record<string,string> = {};
    const descriptor = { id:'generated-ca',source:{ kind:'local' as const,input:'generated-export' },path:'trust-material',sha256:serialized.sha256,byteLength:serialized.bytes.byteLength };
    if (isExport) {
      if(!variant) throw new Error('harness-unsupported');
      const generated=getTrustRecipe(variant.recipeRef,{materialId:descriptor.id,materialPath:descriptor.path,
        outputSegments:output.relativePath.split('/'),sha256:serialized.sha256,byteLength:serialized.bytes.length});
      if(generated?.status!=='recipe'||!generated.recipe) throw new Error('harness-unsupported');
      recipe=generated.recipe as Recipe;
    } else {
      if (!variant) return done('blocked',[diagnostic('PREREQUISITE_UNAVAILABLE','file-route-unsupported')]);
      const fixed=getTrustRecipe(variant.recipeRef);
      if(fixed?.status!=='recipe'||!fixed.recipe) throw new Error('harness-unsupported');
      recipe = cloneJsonValueStructureV1(fixed.recipe,'recipe',32) as Recipe;
      const rendered = renderRepair({ id,variantRef:variant.recipeRef,bundlePath:output.path,bundleSha256:serialized.sha256,fingerprints:serialized.fingerprints });
      if (rendered.status !== 'completed') return done(rendered.status,rendered.diagnostics);
      configuration = rendered.bindings; delete recipe.inputs.bundle; recipe.materials = [descriptor];
      const fileOperation = recipe.operations.find(o => o.id === 'material'); if (!fileOperation || fileOperation.kind !== 'file.write') throw new Error('recipe-unavailable');
      delete fileOperation.content; fileOperation.material = descriptor.id;
      inputs.trust.targets = targetIds.map(t => ({ ...unavailableTarget(t,'file','supplied-file-route'),admission:'admitted',reason:null,
        verification:{ status:request.network === 'off' ? 'skipped':'planned',reason:request.network === 'off' ? 'network-off':'client-check-planned',checkIds:definition.offlineVerification.filter(v => v.target === t).map(v => `trust/${v.checkId}`) } }));
    }
    const requestSha256 = hash(request);
    const capturedMaterial = material!;
    const recheck = async (signal = controls.signal) => {
      try {
        if (installedHelper() !== helperSha256 || installedAdmission(cell)!==admissionSha256 || hash(input) !== requestSha256) throw new Error('review-stale');
        if(cell&&!verifyTrustAdmissionEvidence({packageRoot:dirname(distributionManifest),capabilities:trustCapabilities}).valid) throw new Error('review-stale');
        const current = new Map<string,Capture>();
        for (const [sourceId,c] of captures) {
          if (!pinsMatch(c.pins)) throw new Error('review-stale');
          const fresh = capture(c.file,c.origin,c.admittedSha256); if (fresh.sha256 !== c.sha256) throw new Error('review-stale'); current.set(sourceId,fresh);
        }
        const observed = await discover(sources,current,request,includeNodeBundled,signal);
        if (observed.status !== 'ready' || observed.sourceSetSha256 !== discovery.sourceSetSha256 || hash(observed.binding) !== hash(discovery.binding)) throw new Error('review-stale');
        if (!pinsMatch(capturedMaterial.pins) || sha256(readRegularFile(capturedMaterial.path,{maxBytes:12*1024*1024}) ?? Buffer.alloc(0)) !== serialized.sha256) throw new Error('review-stale');
        if (!isExport && variant) {
          const live=assessRepairObservations({id,managedPath:output.path,variantRef:variant.recipeRef,observations:observeRepair(id,targetIds,variant.recipeRef)});
          if (live.length !== observations.length || live.some((o,i) => o.id !== observations[i]?.id || ![observations[i]?.raw,observations[i]?.expectedRaw].includes(o.raw))) throw new Error('review-stale');
        }
      } catch {
        // A reviewed binding becoming unavailable is stale just as a changed digest is.
        throw new Error(signal?.aborted ? 'cancelled':'review-stale');
      }
    };
    const custody = custodyParticipant(image,[entry],recheck,[],pending);
    const participant = sessionParticipant ? joinSessionParticipant(custody, sessionParticipant(entry)) : custody;
    const policyControls: HostControls = { ...controls,logging:'off',materialRoots:{ 'generated-export':directory } };
    const prepared = await preparePolicy({ useCase:'policy',target:{ project:home },policy:{ schema:'urn:aihq:core:execution-policy:1.0.0',mode:'vibe',
      selections:[{ id:selectionId,managementId,scope:'user',configuration,requires:[],recipe:{ inline:recipe } }] },
      ...(policyResolutions?.length ? { resolutions:[...policyResolutions] }: {}) },policyControls,undefined,undefined,participant);
    if (!prepared.review || !prepared.prepared || prepared.status !== 'ready') {
      review.operations = prepared.review?.operations ?? []; return done(prepared.status,prepared.diagnostics,prepared.resolutionInputs?.map(r => ({ ...r,availableChoices:['replace'] })) ?? []);
    }
    outputRow.effect = beforeSha256 === serialized.sha256 ? 'unchanged':before ? 'replace':'create';
    inputs.trust.bindingSha256 = hash({ request,helperSha256,admissionSha256,pending:participant.reviewBinding,paths:[...captures].map(([id,c]) => ({ id,file:c.file,pins:c.pins,sha256:c.sha256 })),
      output,ownership:ownership.digest,custody:image.digest,discovery:discovery.binding,recipeIdentity:entry.recipeIdentity,outputSha256:serialized.sha256,
      observations:observations.map(o => ({id:o.id,sha256:sha256(o.raw)})) });
    review.operations = prepared.review.operations; review.conflicts = prepared.review.conflicts; review.omissions = prepared.review.omissions;
    const { reviewDigest:_digest,...content } = review; review.reviewDigest = hash({ review:content,policyDigest:prepared.review.reviewDigest });
    review = deepFreezeStrictJsonV1(review);
    const handle = Object.freeze({}) as PreparedHandle;
    knownHandles.set(handle,request.useCase);
    handles.set(handle,{ request:input,requestSha256,policy:prepared.prepared,policyDigest:prepared.review.reviewDigest,review,inputs,captures,discovery,helperSha256,
      material:capturedMaterial,output,entry,includeNodeBundled,policyControls,recheck });
    material = undefined;
    return record({ status:'ready',runId,review,prepared:handle,diagnostics:[],record:disabled,resolutionInputs:[] },controls);
  } catch (error) {
    const caught = error instanceof Error && /^[a-z-]{1,64}$/.test(error.message) ? error.message:'trust-input';
    const reason = caught === 'request-field' ? 'unknown-field':caught;
    const invalid = error instanceof SourceCaptureFailure && error.origin==='explicit' || ['invalid-source-selection','source-path','invalid-path','format-path-mismatch','request-object','unknown-field','logging','signal'].includes(reason);
    const state = ['output-path-alias','trust-custody-conflict','trust-custody-pending'].includes(reason);
    return done(reason === 'cancelled' ? 'cancelled':invalid ? 'invalid':'blocked',[diagnostic(reason === 'cancelled' ? 'CANCELLED':invalid ? 'INPUT_INVALID':
      state ? 'STATE_CONFLICT':['source-limit','custody-record-limit'].includes(reason) ? 'SOURCE_LIMIT':'PREREQUISITE_UNAVAILABLE',reason)]);
  }
}

export function isTrustHandle(value: PreparedHandle): boolean { return !!value && knownHandles.has(value); }
/** Internal host finalization for a preview whose live handle will not be applied. */
export function disposeTrustHandle(value: PreparedHandle): void {
  const state=handles.get(value); if (!state) return; handles.delete(value); cleanup(state.material);
}
export async function applyTrust(handle: PreparedHandle, authorization: Authorization, controls: HostControls = {}): Promise<RunResult> {
  const state = handles.get(handle);
  let logging: RunResult['effectiveOptions']['logging']={value:'on',origin:'default'};
  const rejected = (reason:string,code='REVIEW_STALE',completion:RunResult['completion']='rejected'): RunResult => ({ schema:RESULT,runId:randomUUID(),useCase:state?.review.useCase ?? knownHandles.get(handle) ?? 'certificate-export',completion,
    ...(state ? {inputs:state.inputs}:{}),effectiveOptions:{logging},operations:[],checks:[],diagnostics:[diagnostic(code,reason)],record:disabled,followUp:[],trust:{outputs:[],targets:[]} });
  try {
    trustControls(controls); logging={value:controls.logging ?? 'on',origin:controls.logging === undefined ? 'default':'explicit'};
    dataObject(authorization,['reviewDigest','approved','origin','allowPartial']);
  }
  catch { return rejected('unknown-field','INPUT_INVALID'); }
  if (!state) return rejected('handle-unavailable');
  if (authorization.approved !== true || !['interactive','automation'].includes(authorization.origin) || authorization.reviewDigest !== state.review.reviewDigest) return rejected('approval-required','APPROVAL_REQUIRED');
  if (controls.signal?.aborted) { handles.delete(handle); cleanup(state.material); return record(rejected('cancelled','CANCELLED','cancelled'),controls); }
  const result = await applyPolicy(state.policy,{...authorization,reviewDigest:state.policyDigest},{...state.policyControls,...controls,logging:'off'},() => state.recheck(controls.signal));
  handles.delete(handle); cleanup(state.material);
  const outcomes: {outputs:TrustRunOutput[];targets:TrustRunTarget[]} = { outputs:[],targets:[] };
  if (result.completion === 'complete') {
    try {
      const image = readTrustCustody(); const actual = readRegularFile(state.output.path,{maxBytes:12*1024*1024});
      const entry = image.value.entries.find(e => e.pathKey === state.entry.pathKey);
      if (!actual || sha256(actual) !== state.entry.outputSha256 || !entry || entry.recipeIdentity !== state.entry.recipeIdentity || entry.sourceSetSha256 !== state.entry.sourceSetSha256) throw new Error('trust-custody-conflict');
      outcomes.outputs.push({operationId:state.entry.operationId,path:state.output.path,format:state.entry.format,sha256:sha256(actual),certificateCount:state.inputs.trust.outputs[0]!.certificateCount,
        status:result.operations.find(o => o.id === `${state.entry.selectionId}/${state.entry.operationId}`)?.application === 'already-satisfied' ? 'unchanged':'written'});
    } catch { result.completion='incomplete';result.diagnostics.push(diagnostic('STATE_CONFLICT','trust-custody-conflict')); }
  }
  for (const target of state.inputs.trust.targets) {
    const ops = result.operations.filter(o => o.id.startsWith('trust/') && o.id.includes(target.id));
    const applied = ops.some(o => o.application === 'applied'); const satisfied = ops.length && ops.every(o => o.application === 'already-satisfied');
    outcomes.targets.push({id:target.id,configuration:ops.some(o => o.effectsUncertain)?'uncertain':applied?'applied':satisfied?'already-satisfied':'not-applied',verification:state.request.network === 'off' ? 'skipped':
      ops.some(o => o.verification.status === 'failed') ? 'failed':ops.length && ops.every(o => o.verification.status === 'passed') ? 'passed':'unavailable',
      reason:state.request.network === 'off' ? 'network-off':'client-check-outcome',policyObservationSha256:null});
  }
  const diagnostics = publicDiagnostics(result.diagnostics.map(d => d.code === 'REVIEW_STALE' ? {...d,reason:'trust-binding-changed'}:d),state.review);
  return record({...result,schema:RESULT,useCase:state.review.useCase,inputs:state.inputs,trust:outcomes,diagnostics,
    effectiveOptions:{logging:{value:controls.logging ?? 'on',origin:controls.logging === undefined?'default':'explicit'}}},controls);
}
