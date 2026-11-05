// Admission of a plan request (contract 4.1, 8.1, 14, 15) before any effect: format, source identities and digests,
// tool ids, containment and limits. Each step is checked by its kind's handler (`./steps`).
import { isAbsolute } from 'node:path';
import { isProxy } from 'node:util/types';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../internal/canonical.js';
import { cloneJsonValueStructureV1 } from '../internal/strict-json.js';
import { schemaProblems } from './formats.js';
import { limitValue } from './limits.js';
import { handlerFor } from './steps/index.js';
import { knownCli } from './tools.js';
import { checkValues, declarations, unboundInput } from './inputs.js';
import type { Json } from '../types.js';
import type { Invalid, PlanControls, PlanRequest, Problem, Refusal, UnsupportedVersion } from './types.js';
import { PLAN_REQUEST } from './types.js';
import type { Lowered, SourceFacts, StepContext } from './steps/types.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const key = (sourceId: string, sourcePath: string): string => `${sourceId}\0${sourcePath}`;
const refused = (code: string, reason: string, extra: Partial<Refusal> = {}): Refusal => ({ status: 'refused', code, reason, ...extra });
const limit = (name: string, reason: string, extra: Partial<Refusal> = {}): Refusal =>
  refused('limit-exceeded', reason, { limit: name, value: limitValue(name), ...extra });

export interface CheckedStep { index: number; op: string; lowered: Lowered; skipped: boolean }
export interface CheckedPlan {
  /** The saved request document (no bytes), as strict JSON; its digest binds the review. */
  document: PlanRequest;
  documentDigest: string;
  /** sha256 of every supplied byte string, in `files` order, so Apply can tell whether the caller changed them. */
  bytesDigest: string;
  steps: CheckedStep[];
  ignoredFiles: { sourceId: string; sourcePath: string }[];
  profiles: { id: string; version: string | number }[];
  /** Each `scans` entry's supplied inventory with its bytes (Node API), or `null` when it has none or lacks bytes. */
  inventories: ({ path: string; mode: '100644' | '100755'; bytes: Uint8Array }[] | null)[];
  /** The supplied source bytes by source id and path, for matching a source tree (contract 13); never authority. */
  sourceBytes: Map<string, Uint8Array>;
}

/** Admits a plan request; `files[].bytes` are copied, never kept by reference. */
export async function checkPlanRequest(input: unknown, controls: PlanControls): Promise<{ checked: CheckedPlan } | Refusal | Invalid | UnsupportedVersion> {
  const invalid = (problems: Problem[]): Invalid => ({ status: 'invalid', problems });
  if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input))
    return invalid([{ path: '', reason: 'type', message: 'A plan request is an object.' }]);
  const raw = input as Record<string, unknown>;
  if (typeof raw.schema === 'string' && raw.schema !== PLAN_REQUEST && raw.schema.startsWith('urn:aihq:core:plan-request:'))
    return { status: 'unsupported-version', encountered: raw.schema, supported: [PLAN_REQUEST] };
  // Source bytes ride beside the document in the Node API only (C65): take them out before reading the document.
  const supplied: (Buffer | undefined)[] = [];
  let projection: unknown = raw;
  if (Array.isArray(raw.files)) {
    const files: unknown[] = [];
    for (const [index, entry] of raw.files.entries()) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && Object.hasOwn(entry, 'bytes')) {
        const { bytes, ...rest } = entry as Record<string, unknown>;
        if (!(bytes instanceof Uint8Array)) return invalid([{ path: `/files/${index}/bytes`, reason: 'type', message: 'Source bytes are a Uint8Array.' }]);
        if (bytes.byteLength > limitValue('file-bytes')) return limit('file-bytes', `Source file ${index} is larger than one file may be.`);
        supplied.push(Buffer.from(bytes)); files.push(rest);
      } else { supplied.push(undefined); files.push(entry); }
    }
    projection = { ...raw, files };
  }
  // Scan inventories carry their bytes the same way; they are only for matching (C66).
  const inventories: CheckedPlan['inventories'] = [];
  if (Array.isArray(raw.scans)) {
    const scans: unknown[] = [];
    for (const [index, entry] of raw.scans.entries()) {
      const list = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as { inventory?: unknown }).inventory : undefined;
      if (!Array.isArray(list)) { inventories.push(null); scans.push(entry); continue; }
      const rows: unknown[] = []; const bytes: Uint8Array[] = [];
      for (const [at, row] of list.entries()) {
        if (row && typeof row === 'object' && !Array.isArray(row) && Object.hasOwn(row, 'bytes')) {
          const { bytes: value, ...rest } = row as Record<string, unknown>;
          if (!(value instanceof Uint8Array)) return invalid([{ path: `/scans/${index}/inventory/${at}/bytes`, reason: 'type', message: 'Inventory bytes are a Uint8Array.' }]);
          if (value.byteLength > limitValue('file-bytes')) return limit('file-bytes', `Inventory file ${at} of scan ${index} is larger than one file may be.`);
          bytes.push(Buffer.from(value)); rows.push(rest);
        } else rows.push(row);
      }
      inventories.push(bytes.length === list.length ? (rows as { path: string; mode: '100644' | '100755' }[]).map((row, at) => ({ path: row.path, mode: row.mode, bytes: bytes[at]! })) : null);
      scans.push({ ...(entry as object), inventory: rows });
    }
    projection = { ...(projection as object), scans };
  }
  let document: PlanRequest;
  try { document = cloneJsonValueStructureV1(projection, 'plan request', 32) as unknown as PlanRequest; }
  catch { return invalid([{ path: '', reason: 'strict-json', message: 'Expected bounded, plain strict JSON data.' }]); }
  const text = canonicalJson(document as unknown as Json);
  // Scan evidence is never re-checked at Apply (C18): it is not part of what Apply binds.
  const boundText = canonicalJson(withoutScans(document) as unknown as Json);
  if (Buffer.byteLength(text) > limitValue('request-bytes')) return limit('request-bytes', 'The plan request is larger than one request may be.');
  const problems = schemaProblems(PLAN_REQUEST, document);
  if (problems) return invalid(problems);
  if (document.scope === 'project' && typeof document.target.project !== 'string')
    return invalid([{ path: '/target/project', reason: 'required', message: 'A project-scope request names its project folder.' }]);
  if (typeof document.target.project === 'string' && !isAbsolute(document.target.project))
    return invalid([{ path: '/target/project', reason: 'absolute', message: 'The project folder is an absolute path.' }]);

  const files = new Map<string, { index: number; sha256: string; bytes?: Buffer }>();
  const duplicates: Problem[] = [];
  document.files.forEach((entry, index) => {
    const id = key(entry.sourceId, entry.sourcePath);
    if (files.has(id)) duplicates.push({ path: `/files/${index}`, reason: 'duplicate-file', message: `\`${entry.sourcePath}\` from \`${entry.sourceId}\` is passed twice.` });
    else files.set(id, { index, sha256: entry.sha256, ...(supplied[index] ? { bytes: supplied[index] } : {}) });
  });
  if (duplicates.length) return invalid(duplicates);
  if (document.plan.plan.length > limitValue('plan-steps')) return limit('plan-steps', 'The plan has more steps than one plan may have.');
  for (const profile of document.profiles)
    if (!knownCli(profile.id as string)) return refused('tool-unknown', `Profile \`${profile.id}\` has no registry tool.`, { tool: profile.id as string });
  // A path reference blocks (the item would read a file nothing places); a plugin-namespaced `name` reference is a warning.
  const pathReference = (document.plan.references as unknown[]).some(reference =>
    !!reference && typeof reference === 'object' && (reference as { kind?: unknown }).kind !== 'name');
  if (document.plan.clashes.length || document.plan.status === 'incomplete' && pathReference)
    return refused('plan-unresolved', 'The plan has a clash or path reference only replanning can fix.',
      { fixes: ['names', 'overrides', 'bundle'] });

  const itemFiles = new Map<string, SourceFacts>(); const notices = new Map<string, SourceFacts>();
  const itemInputs = new Map<string, { isSecret: boolean }>();
  const pluginFiles = new Map<string, SourceFacts>(); const bundleFiles = new Map<string, SourceFacts>();
  for (const content of document.contents as unknown as { sources: { id: string; notices?: { sourcePath: string; sha256: string }[] }[];
      items: { id: string; files: SourceFacts[]; requirements?: { inputs?: Record<string, { isSecret?: unknown }> } }[] }[]) {
    for (const source of content.sources) for (const notice of source.notices ?? [])
      notices.set(key(source.id, notice.sourcePath), { sourceId: source.id, sourcePath: notice.sourcePath, sha256: notice.sha256, executable: false });
    for (const item of content.items) for (const [name, spec] of Object.entries(item.requirements?.inputs ?? {}))
      itemInputs.set(key(item.id, name), { isSecret: !!spec && typeof spec === 'object' && spec.isSecret === true });
    // An item's own files and its editions' (the upstream's own version for one client, Catalog content `editions`).
    for (const item of content.items as { id: string; files: SourceFacts[]; editions?: Record<string, { files?: SourceFacts[] }> }[])
      for (const file of [...item.files, ...Object.values(item.editions ?? {}).flatMap(edition => edition?.files ?? [])])
        if (!itemFiles.has(key(item.id, file.sourcePath)))
          itemFiles.set(key(item.id, file.sourcePath), { sourceId: file.sourceId, sourcePath: file.sourcePath, sha256: file.sha256, executable: file.executable });
    // Runtime bundles' root files, shared by the items that read them (Catalog content `bundles`).
    for (const bundle of ((content as { bundles?: unknown }).bundles ?? []) as { id?: unknown; sourceId?: unknown; files?: unknown }[])
      if (bundle && typeof bundle.id === 'string' && typeof bundle.sourceId === 'string' && Array.isArray(bundle.files))
        for (const file of bundle.files as { sourcePath?: unknown; sha256?: unknown; executable?: unknown }[])
          if (file && typeof file.sourcePath === 'string' && typeof file.sha256 === 'string')
            bundleFiles.set(key(bundle.id, key(bundle.sourceId, file.sourcePath)), { sourceId: bundle.sourceId, sourcePath: file.sourcePath,
              sha256: file.sha256, executable: file.executable === true });
    // A framework's recorded plugin folders: the files a local-plugin route copies as one unit (Catalog D120).
    const framework = (content as { framework?: { id?: unknown } }).framework?.id;
    const folders = (content as { plugins?: unknown }).plugins;
    if (typeof framework === 'string' && Array.isArray(folders)) for (const folder of folders as { sourceId?: unknown; files?: unknown }[])
      if (folder && typeof folder.sourceId === 'string' && Array.isArray(folder.files))
        for (const file of folder.files as { sourcePath?: unknown; sha256?: unknown; executable?: unknown }[])
          if (file && typeof file.sourcePath === 'string' && typeof file.sha256 === 'string')
            pluginFiles.set(key(framework, key(folder.sourceId, file.sourcePath)), { sourceId: folder.sourceId, sourcePath: file.sourcePath,
              sha256: file.sha256, executable: file.executable === true });
  }
  // Ordinary values in the request, secrets only in the controls, each for an input its item declares (4.1, C59).
  const declared = declarations(document.contents);
  const valueProblems = checkValues(declared, document.inputs, controls.privateInputs);
  if (valueProblems.length) return invalid(valueProblems);
  const qualifications = new Map<string, { [field: string]: Json }>();
  for (const entry of document.qualifications ?? []) if (entry && typeof entry === 'object' && !Array.isArray(entry))
    qualifications.set(sha256(Buffer.from(canonicalJson(entry))), entry as { [field: string]: Json });
  const named = new Set<string>();
  let captured = 0;
  const skips = new Set((document.resolutions ?? []).filter(item => item.choice === 'skip').map(item => item.step));
  const steps: CheckedStep[] = []; const stepProblems: Problem[] = [];
  for (const [index, step] of document.plan.plan.entries()) {
    const handler = handlerFor(step.op);
    if ('known' in handler) return refused('step-unknown', handler.known ?
      `Step ${index} is a \`${step.op}\` step, which this Core does not carry out yet.` :
      `Step ${index} is a \`${step.op}\` step, which this Core does not know.`, { step: index, op: step.op });
    const context: StepContext = {
      request: document, controls, index,
      itemFile: (item, sourcePath) => itemFiles.get(key(item, sourcePath)),
      sourceFile: (sourceId, sourcePath, bundle) => bundle === undefined ? notices.get(key(sourceId, sourcePath)) :
        bundleFiles.get(key(bundle, key(sourceId, sourcePath))),
      qualification: sha => qualifications.get(sha),
      itemInput: (item, input) => itemInputs.get(key(item, input)),
      inputs: clis => ({ index, request: document, privateInputs: controls.privateInputs, declared, clis }),
      pluginFile: (framework, sourceId, sourcePath) => pluginFiles.get(key(framework, key(sourceId, sourcePath))),
      bytesFor: facts => {
        const entry = files.get(key(facts.sourceId, facts.sourcePath));
        if (!entry || !entry.bytes) return { refusal: refused('source-missing',
          `Step ${index} needs \`${facts.sourcePath}\` from \`${facts.sourceId}\`, which was not supplied with its bytes.`, { step: index }) };
        if (entry.sha256 !== facts.sha256 || sha256(entry.bytes) !== entry.sha256) return { refusal: refused('source-mismatch',
          `The bytes of \`${facts.sourcePath}\` from \`${facts.sourceId}\` differ from the plan.`, { step: index }) };
        const id = key(facts.sourceId, facts.sourcePath);
        if (!named.has(id)) { named.add(id); captured += entry.bytes.length; }
        return { bytes: Buffer.from(entry.bytes) };
      }
    };
    const outcome = await handler.prepare(step as never, context);
    if ('problem' in outcome) { stepProblems.push(outcome.problem); continue; }
    if ('refusal' in outcome) return outcome.refusal;
    if (captured > limitValue('captured-bytes')) return limit('captured-bytes', 'The plan names more source bytes than one Apply may capture.');
    steps.push({ index, op: step.op, lowered: outcome.lowered, skipped: skips.has(index) });
  }
  if (stepProblems.length) return invalid(stepProblems);
  // Every declared input of a planned item lands at a place some step marks; otherwise it is never guessed (C63).
  const bound = new Set(steps.flatMap(step => (step.lowered.bound?.review ?? []).map(row => `${row.item}\0${row.input}`)));
  const unbound = unboundInput(declared, new Set(steps.flatMap(step => step.lowered.managementIds)), bound);
  if (unbound) return refused('input-binding-missing', `\`${unbound.input}\` of \`${unbound.item}\` has no place marked in the plan; replan with a Catalog that marks input places.`,
    { item: unbound.item, input: unbound.input });
  for (const resolution of document.resolutions ?? [])
    if (!steps.some(step => step.index === resolution.step && step.lowered.managementIds.includes(resolution.managementId)))
      return invalid([{ path: '/resolutions', reason: 'resolution-unknown', message: `No step ${resolution.step} belongs to \`${resolution.managementId}\`.` }]);
  const ignoredFiles = document.files.filter(entry => !named.has(key(entry.sourceId, entry.sourcePath)))
    .map(entry => ({ sourceId: entry.sourceId, sourcePath: entry.sourcePath }));
  const bytesDigest = createHash('sha256').update(supplied.map(bytes => bytes ? sha256(bytes) : '-').join(',')).digest('hex');
  const sourceBytes = new Map<string, Uint8Array>();
  for (const [id, entry] of files) if (entry.bytes) sourceBytes.set(id, entry.bytes);
  return { checked: { document, documentDigest: createHash('sha256').update(boundText).digest('hex'), bytesDigest, steps, ignoredFiles,
    profiles: document.profiles.map(profile => ({ id: profile.id as string, version: profile.version as string | number })), inventories, sourceBytes } };
}

const withoutScans = <T extends object>(value: T): T => { const { scans: _scans, ...rest } = value as T & { scans?: unknown }; return rest as T; };

/** The same digests for a request handed to Apply's re-check: `undefined` when it can no longer be read. */
export function requestDigests(input: unknown): { documentDigest: string; bytesDigest: string } | undefined {
  try {
    const raw = input as Record<string, unknown>;
    const files = Array.isArray(raw.files) ? raw.files : [];
    const projection = { ...withoutScans(raw), files: files.map(entry => {
      if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'bytes')) return entry;
      const { bytes: _bytes, ...rest } = entry as Record<string, unknown>; return rest;
    }) };
    if (!Array.isArray(raw.files)) delete (projection as { files?: unknown }).files;
    const text = canonicalJson(cloneJsonValueStructureV1(projection, 'plan request', 32) as Json);
    const bytes = files.map(entry => entry && typeof entry === 'object' && (entry as { bytes?: unknown }).bytes instanceof Uint8Array ?
      sha256((entry as { bytes: Uint8Array }).bytes) : '-');
    return { documentDigest: createHash('sha256').update(text).digest('hex'), bytesDigest: createHash('sha256').update(bytes.join(',')).digest('hex') };
  } catch { return undefined; }
}
