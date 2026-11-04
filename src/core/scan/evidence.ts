// Scan evidence for a plan request (contract 13, C18, C35, C49, C53, C66): the caller's summaries are verified with
// Scan's `verifySummary` against the allowed signers, the exact verified result is matched with `matchScan` against
// the item's source tree, and what was shown is remembered per key and authenticated signer. Nothing here decides
// what runs: no status, refusal or exit code depends on a score, a label, a signer, a match or Scan being installed.
import { createHash } from 'node:crypto';
import { scanRead, type MatchFile, type ScanSigner, type VerifyResult } from './read.js';
import { memoryKey, readMemory, writeMemory, type MemoryEntry } from './memory.js';
import type { Json } from '../types.js';
import type { ReviewNotScanned, ReviewScan, ScanFacts } from '../plan/types.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const keyOf = (sourceId: string, sourcePath: string): string => `${sourceId}\0${sourcePath}`;

/** One `scans` entry of the saved request document; inventory bytes ride beside it in the Node API. */
export interface ScanInput {
  summary: string; bundle: string | Record<string, Json>;
  withdrawn?: string | string[] | null; withdrawnBundle?: string | Record<string, Json> | (string | Record<string, Json>)[] | null;
  inventory?: { path: string; mode: '100644' | '100755' }[] | null;
}
interface ContentFile { sourceId: string; sourcePath: string; sha256: string; executable?: boolean; cli?: string }
interface ContentDocument {
  framework?: { id?: string };
  items?: { id: string; kind?: string; files?: ContentFile[]; scanKey?: string; bundle?: unknown; editions?: Record<string, { files?: ContentFile[]; scanKey?: string }> }[];
  bundles?: { id: string; sourceId?: string; files?: ContentFile[]; scanKey?: string }[];
  plugins?: { sourceId: string; path: string; files?: { sourcePath: string; sha256: string; executable?: boolean }[]; scanKey?: string; folderScanKey?: string }[];
}
/** What a scan key is in the request's content: whose it is, and the files that make up its tree when Core knows them. */
interface Subject { managementIds: string[]; tree?: { path: string; sourceId: string; sourcePath: string; sha256: string; executable: boolean }[] }

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const dirname = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
/**
 * An item file's item-relative path, as Catalog keys an item folder (Catalog 5.4, D64): a skill's files sit under the
 * folder of its `SKILL.md` (a one-file command installs as `SKILL.md`); a file of any other kind under its own name.
 */
function itemRelative(kind: string | undefined, files: ContentFile[], file: ContentFile): string {
  if (kind !== 'skill') return basename(file.sourcePath);
  const general = files.filter(entry => entry.cli === undefined);
  const skill = general.filter(entry => basename(entry.sourcePath) === 'SKILL.md')
    .sort((a, b) => a.sourcePath.split('/').length - b.sourcePath.split('/').length)[0];
  if (!skill) {
    const only = general.length === 1 ? general[0] : undefined;
    if (only?.sourcePath.endsWith('.md')) return file.sourcePath === only.sourcePath ? 'SKILL.md' : basename(file.sourcePath);
    return basename(file.sourcePath);
  }
  const root = dirname(skill.sourcePath);
  return root === '' ? file.sourcePath : file.sourcePath.slice(root.length + 1);
}

/** Every scan key the content documents record, with whose it is and its tree (item, edition, bundle, plugin folder). */
function subjects(contents: ContentDocument[]): Map<string, Subject> {
  const found = new Map<string, Subject>();
  const add = (key: unknown, managementIds: string[], tree?: Subject['tree']) => {
    if (typeof key !== 'string') return;
    const known = found.get(key);
    if (known) { known.managementIds = [...new Set([...known.managementIds, ...managementIds])]; known.tree ??= tree; }
    else found.set(key, { managementIds: [...managementIds], ...(tree ? { tree } : {}) });
  };
  const treeOf = (kind: string | undefined, files: ContentFile[]) => files.map(file => ({ path: itemRelative(kind, files, file),
    sourceId: file.sourceId, sourcePath: file.sourcePath, sha256: file.sha256, executable: file.executable === true }));
  for (const content of contents) {
    const items = Array.isArray(content.items) ? content.items : [];
    for (const item of items) {
      if (!item || typeof item.id !== 'string') continue;
      add(item.scanKey, [item.id], Array.isArray(item.files) ? treeOf(item.kind, item.files) : undefined);
      for (const edition of Object.values(item.editions ?? {}))
        add(edition?.scanKey, [item.id], Array.isArray(edition?.files) ? treeOf(item.kind, edition.files) : undefined);
    }
    for (const bundle of Array.isArray(content.bundles) ? content.bundles : []) {
      if (!bundle || typeof bundle.id !== 'string') continue;
      const readers = items.filter(item => item?.bundle === bundle.id).map(item => item.id);
      add(bundle.scanKey, readers, Array.isArray(bundle.files) ? bundle.files.map(file => ({ path: file.sourcePath,
        sourceId: file.sourceId ?? bundle.sourceId ?? '', sourcePath: file.sourcePath, sha256: file.sha256, executable: file.executable === true })) : undefined);
    }
    const framework = content.framework?.id;
    for (const folder of Array.isArray(content.plugins) ? content.plugins : []) {
      if (!folder || typeof framework !== 'string') continue;
      const relative = (path: string) => folder.path === '/' ? path : path.slice(folder.path.length + 1);
      add(folder.scanKey, [framework], Array.isArray(folder.files) ? folder.files.map(file => ({ path: relative(file.sourcePath),
        sourceId: folder.sourceId, sourcePath: file.sourcePath, sha256: file.sha256, executable: file.executable === true })) : undefined);
      // The whole folder a native install clones: only a supplied inventory makes up its tree.
      add(folder.folderScanKey, [framework]);
    }
  }
  return found;
}

const list = <T>(value: T | T[] | null | undefined): T[] => value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
const jsonInput = (value: string | Record<string, Json>): Uint8Array | Record<string, unknown> => typeof value === 'string' ? utf8(value) : value;

export interface ScanEvaluation {
  scans: ReviewScan[];
  /** The receipt facts each management id records: the key, revision and signer shown (contract 5). */
  facts: Map<string, ScanFacts[]>;
  /** Moves the memory forward; call once the review is presented. Its warnings join the review's. */
  remember(held: ReadonlySet<string>): string[];
}

/**
 * Verifies, matches and presents every supplied summary. `files` are the request's source bytes, used only when their
 * sha256 is the content's; `inventories` are each entry's supplied complete tree with its bytes (`null` when none).
 */
export async function evaluateScans(input: { scans: ScanInput[]; inventories: (MatchFile[] | null)[]; contents: unknown[];
    files: Map<string, Uint8Array>; planned: ReadonlySet<string>; signers: ScanSigner[] }): Promise<ScanEvaluation> {
  const facts = new Map<string, ScanFacts[]>();
  const read = await scanRead();
  if ('unavailable' in read) return { facts, remember: () => [], scans: input.scans.map((_entry, index) => ({ index, status: 'unavailable',
    reason: 'scan-unavailable', sentence: `Scan evidence was not checked: ${read.unavailable}`, scanKey: null, revision: null,
    label: null, coverage: null, score: null, signer: null, withdrawn: false, older: false, lastSeen: null, withdrawals: [],
    managementIds: [], match: { status: 'not-checked', reason: 'scan-unavailable' } })) };
  const memory = readMemory();
  const before = new Map([...memory.entries].map(([key, entry]) => [key, { ...entry }]));
  const fresh = new Set<string>();
  const now = Date.now();
  const advance = (scanKey: string, issuer: string, subject: string, change: { revision?: number; withdrawnThrough?: number }) => {
    const key = memoryKey(scanKey, issuer, subject);
    const entry: MemoryEntry = memory.entries.get(key) ?? { scanKey, issuer, subject, revision: null, withdrawnThrough: null, seen: now };
    if (change.revision !== undefined) entry.revision = Math.max(entry.revision ?? 0, change.revision);
    if (change.withdrawnThrough !== undefined) entry.withdrawnThrough = Math.max(entry.withdrawnThrough ?? 0, change.withdrawnThrough);
    entry.seen = now;
    memory.entries.set(key, entry); fresh.add(key);
  };
  const known = subjects(input.contents as ContentDocument[]);
  const scans: ReviewScan[] = [];
  for (const [index, entry] of input.scans.entries()) {
    const withdrawn = list(entry.withdrawn).map(utf8);
    const bundles = list(entry.withdrawnBundle).map(jsonInput);
    let result: VerifyResult;
    try {
      result = await read.verifySummary(utf8(entry.summary), jsonInput(entry.bundle), input.signers,
        withdrawn.length || bundles.length ? { withdrawn, withdrawnBundle: bundles } : {});
    } catch { result = { status: 'refused', reason: 'scan-failed', verified: false }; }
    if (result.status !== 'ok' || !('summary' in result)) {
      const reason = 'reason' in result && typeof result.reason === 'string' ? result.reason : result.status;
      scans.push({ index, status: 'not-verified', reason, sentence: `This Scan result did not verify (${reason}); it is shown as evidence of nothing.`,
        scanKey: null, revision: null, label: null, coverage: null, score: null, signer: null, withdrawn: false, older: false, lastSeen: null,
        withdrawals: [], managementIds: [], match: { status: 'not-checked', reason: 'not-verified' } });
      continue;
    }
    const { summary, signer } = result;
    const remembered = before.get(memoryKey(summary.scanKey, signer.issuer, signer.subject));
    const older = remembered?.revision !== null && remembered?.revision !== undefined && summary.revision < remembered.revision;
    const outcomes = result.withdrawals.map(outcome => ({ status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.throughRevision !== undefined ? { throughRevision: outcome.throughRevision } : {}) }));
    // An authenticated withdrawal for this key and signer moves withdrawn-through even when it ends before this
    // revision; one for another key or signer moves nothing.
    const through = outcomes.filter(outcome => outcome.throughRevision !== undefined &&
      (outcome.status === 'applies' || outcome.status === 'not-applicable' && outcome.reason === 'later-revision')).map(outcome => outcome.throughRevision!);
    const rememberedThrough = remembered?.withdrawnThrough ?? null;
    const isWithdrawn = result.withdrawn || rememberedThrough !== null && rememberedThrough >= summary.revision;
    const subject = known.get(summary.scanKey);
    const managementIds = (subject?.managementIds ?? []).filter(id => input.planned.has(id)).sort();
    let match: ReviewScan['match'];
    const inventory = input.inventories[index];
    if (entry.inventory && !inventory) match = { status: 'not-checked', reason: 'inventory-bytes-missing' };
    else if (!managementIds.length && !inventory) match = { status: 'not-checked', reason: 'not-in-plan' };
    else {
      let tree: MatchFile[] | undefined = inventory ?? undefined;
      const source: 'inventory' | 'files' = inventory ? 'inventory' : 'files';
      if (!tree && subject?.tree) {
        const bytes = subject.tree.map(file => input.files.get(keyOf(file.sourceId, file.sourcePath)));
        if (bytes.every((value, at) => value !== undefined && sha256(value) === subject.tree![at]!.sha256))
          tree = subject.tree.map((file, at) => ({ path: file.path, mode: file.executable ? '100755' : '100644', bytes: bytes[at]! }));
      }
      if (!tree) match = { status: 'not-checked', reason: 'inventory-not-supplied' };
      else {
        let matched;
        try { matched = await read.matchScan(result, tree); } catch { matched = { status: 'refused', reason: 'scan-failed' }; }
        match = matched.status === 'ok' && 'matches' in matched ?
          { status: matched.matches ? 'matches' : 'differs', source, differences: {
            missing: [...matched.differences.missing], extra: [...matched.differences.extra], changed: [...matched.differences.changed],
            modeChanged: [...matched.differences.modeChanged] } } :
          { status: 'refused', source, reason: 'reason' in matched && typeof matched.reason === 'string' ? matched.reason : matched.status };
      }
    }
    advance(summary.scanKey, signer.issuer, signer.subject, { revision: summary.revision });
    for (const value of through) advance(summary.scanKey, signer.issuer, signer.subject, { withdrawnThrough: value });
    const shown: ReviewScan = { index, status: 'verified', sentence: sentence(summary, signer, isWithdrawn, older, match, remembered?.revision ?? null),
      scanKey: summary.scanKey, revision: summary.revision, label: summary.label, coverage: summary.coverage, score: summary.score,
      signer: { identity: signer.identity, trusted: signer.trusted, issuer: signer.issuer, subject: signer.subject },
      withdrawn: isWithdrawn, older, lastSeen: remembered?.revision ?? null, withdrawals: outcomes, managementIds, match };
    scans.push(shown);
    for (const id of managementIds) {
      const rows = facts.get(id) ?? []; facts.set(id, rows);
      rows.push({ scanKey: summary.scanKey, revision: summary.revision, signer: { ...shown.signer! }, label: summary.label,
        coverage: summary.coverage, withdrawn: isWithdrawn, match: match.status });
    }
  }
  return { scans, facts, remember(held) {
    const warnings: string[] = memory.unreadable ? ['scan-memory-unreadable: Core could not read its Scan memory, so this review has no older-revision or remembered-withdrawal checks.'] : [];
    if (!fresh.size) return warnings;
    const written = writeMemory(memory.entries, held, fresh);
    if (written.heldEvicted) warnings.push('scan-memory-full: Core\'s Scan memory is full, so it forgot the oldest result it had seen for an installed key; that key\'s older-revision check is lost.');
    if (!written.written) warnings.push('scan-memory-unavailable: Core could not save its Scan memory; the results shown here are not remembered.');
    return warnings;
  } };
}

function sentence(summary: { label: string; coverage: string; revision: number; scanKey: string }, signer: { identity: string; trusted: boolean },
    withdrawn: boolean, older: boolean, match: ReviewScan['match'], lastSeen: number | null): string {
  const parts = [`Scan says ${summary.label} (${summary.coverage} coverage), revision ${summary.revision}, signed by ${signer.identity}` +
    (signer.trusted ? '' : ', not by a trusted publisher')];
  if (withdrawn) parts.push('withdrawn');
  if (older) parts.push(`older than the last result seen (revision ${lastSeen})`);
  parts.push(match.status === 'matches' ? 'it matches this content' : match.status === 'differs' ? 'it does not match this content' :
    match.status === 'refused' ? `match refused (${match.reason})` : match.reason === 'inventory-not-supplied' ? 'match not checked: inventory not supplied' :
    match.reason === 'inventory-bytes-missing' ? 'match not checked: inventory bytes not supplied' : 'match not checked: the key is not in this plan');
  return `${parts.join('; ')}. Scan informs; it never blocks.`;
}

/** Steps whose output no source scan covers (Catalog D68, D72, D73): rendered, fetched or program-made, by `scanned: false`. */
export function notScanned(steps: { op: string; [field: string]: Json }[]): ReviewNotScanned[] {
  const program = new Set(['acquire', 'tool-command', 'upstream-installer', 'upstream-setup']);
  return steps.flatMap((step, index) => step.scanned === false || step.render !== undefined ? [{ step: index, op: step.op,
    reason: step.render !== undefined ? 'rendered' as const : step.op === 'fetch' ? 'fetched' as const : program.has(step.op) ? 'program' as const : 'not-scanned' as const,
    sentence: step.render !== undefined ? `Step ${index}'s rendered output is not scanned; the source's scan does not cover it.` :
      program.has(step.op) ? `Step ${index}'s program effects are not scanned.` : `Step ${index}'s output is not scanned.` }] : []);
}
