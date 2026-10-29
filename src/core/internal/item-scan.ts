// Core's reading of Scan item records for one selection (prepared work 1.7.0). A record is the Catalog's claim about
// which bytes a scan covered; it counts only after Core checks it against the selection's own captured materials and
// the capture entries of the scan artifact it names (Scan's `verifyItemRecord` rule). Scan's decision table then gives
// the card summary. Nothing here reads a Catalog or acquires evidence; the caller supplies both.
import { validateArtifact } from '../evidence/artifact.js';
import { canonicalBytes, sha256, strictParse } from '../evidence/json.js';
import { artifactLimits } from '../evidence/validation.js';
import type { AssociationResult } from '../evidence/types.js';
import type { ScanSummary } from '../host-types.js';
import type { ItemMaterial, ItemScanRecord, SelectionMetadata } from '../types.js';

/** The payload pseudo-material: covered by the record's `behaviourSha256` subject, never a captured file. */
const PAYLOAD = '#payload';
/** One captured file the scan report lists: its exact bytes and whether the scan's selection read it. */
interface CaptureEntry { sha256: string; byteLength: number; selected: boolean }
/** An artifact named by a record: unreadable, or its authentication and the files its report captured. */
export type ScanArtifact = { readable: false } |
  { readable: true; association: AssociationResult; entries: ReadonlyMap<string, CaptureEntry> };
interface Bytes { sha256: string; byteLength: number }
/** A material the selection delivers, as Core captured it: its Catalog material id and package path. */
export interface OwnMaterial extends Bytes { id: string; path: string }
export interface SelectionScan {
  scanId?: string; coverage?: ItemScanRecord['coverage']; scanState: ScanSummary;
  /** Scan ids of every record that passed the check with matched coverage: the artifacts that cover this selection's bytes. */
  covering: string[];
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('report-shape');
  return value as Record<string, unknown>;
};
/**
 * The files a scan artifact's report captured, checked against the report's own capture digest. Any artifact or
 * report Core cannot read this way is `undefined`: an unreadable record never counts.
 */
export async function artifactEntries(bytes: Uint8Array): Promise<ReadonlyMap<string, CaptureEntry> | undefined> {
  try {
    const { reportBytes } = await validateArtifact(bytes);
    const report = record(strictParse(reportBytes, 'report', artifactLimits.report));
    // Scan reports 1.0.0 and 2.0.0 carry the same capture and selection; Core reads nothing else from them.
    if (report.schema !== 'urn:aihq:scan:report:1.0.0' && report.schema !== 'urn:aihq:scan:report:2.0.0') return undefined;
    const capture = record(record(report.source).capture);
    const domain = { 'aih-source-capture-1': 'aih.scan.capture.v1', 'aih-source-capture-2': 'aih.scan.capture.v2' }[String(capture.profile)];
    if (!domain || !Array.isArray(capture.entries) ||
        await sha256(canonicalBytes({ domain, profile: capture.profile, entries: capture.entries })) !== capture.captureSha256) return undefined;
    const paths = record(report.selection).paths;
    if (!Array.isArray(paths)) return undefined;
    const selected = new Set(paths.filter((path): path is string => typeof path === 'string'));
    const entries = new Map<string, CaptureEntry>();
    for (const value of capture.entries) {
      const entry = record(value);
      if ((entry.kind === 'file' || entry.kind === 'file-link') && typeof entry.path === 'string' &&
          typeof entry.sha256 === 'string' && Number.isSafeInteger(entry.byteLength))
        entries.set(entry.path, { sha256: entry.sha256, byteLength: entry.byteLength as number, selected: selected.has(entry.path) });
    }
    return entries;
  } catch {
    return undefined;
  }
}

/**
 * Scan's `verifyItemRecord` as Core can apply it, against the item's own materials (`declared`: the Catalog item's
 * content and behaviour files at their package paths, as Scan's item descriptor names them). The subject is this item.
 * Every material the selection delivers is the declared material of the same id, path and bytes, so the declaration is
 * bound to what Core captured. The record lists exactly the declared materials (beside `#payload`), each captured with the
 * declared bytes, and the artifact's capture holds those bytes, selected for scanning, at the declared package path (a
 * record's `relPath` is item-relative). A relabelled record fails, including one for an item that shares every content
 * file and differs only in behaviour.
 */
export function recordCovers(scanRecord: ItemScanRecord, item: SelectionMetadata['item'], declared: readonly ItemMaterial[],
    own: readonly OwnMaterial[], entries: ReadonlyMap<string, CaptureEntry>): boolean {
  const { subject } = scanRecord;
  if (subject.frameworkId !== item.framework || subject.itemId !== item.itemId ||
      subject.contentSha256 !== item.contentSha256 || subject.behaviourSha256 !== item.behaviourSha256) return false;
  const byId = new Map(declared.map(material => [material.materialId, material]));
  if (!own.every(material => {
    const named = byId.get(material.id);
    return named !== undefined && named.path === material.path && sameBytes(named, material);
  })) return false;
  const listed = scanRecord.materials.filter(material => material.materialId !== PAYLOAD);
  if (listed.length !== declared.length || new Set(listed.map(material => material.materialId)).size !== listed.length) return false;
  return listed.every(material => {
    const named = byId.get(material.materialId);
    const captured = named && entries.get(named.path);
    return material.captured && named !== undefined && sameBytes(named, material) && captured !== undefined && captured.selected &&
      sameBytes(captured, material);
  });
}
const sameBytes = (a: Bytes, b: Bytes): boolean => a.sha256 === b.sha256 && a.byteLength === b.byteLength;

const NONE = { error: 0, warning: 0, note: 0, unavailable: 0 };
/** A summary with no picked record: nothing scanned, nothing readable, or nothing that covers the selection's bytes. */
const emptyScan = (state: ScanSummary['state']): SelectionScan =>
  ({ scanState: { state, findings: { ...NONE }, suppressed: 0, scannedAt: null }, covering: [] });
const authenticated = (artifact: ScanArtifact) => artifact.readable && artifact.association.status === 'authenticated';
/** Ranked by coverage, then authentication, then completion, then the newest scan: never by time alone. */
function rank(a: { scanRecord: ItemScanRecord; artifact: ScanArtifact }, b: { scanRecord: ItemScanRecord; artifact: ScanArtifact }): number {
  const keys = (entry: typeof a) => [entry.scanRecord.coverage === 'matched' ? 0 : 1, authenticated(entry.artifact) ? 0 : 1,
    entry.scanRecord.completion === 'complete' ? 0 : 1];
  const left = keys(a), right = keys(b);
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return left[index]! - right[index]!;
  const at = (entry: typeof a) => Date.parse(entry.scanRecord.createdAt);
  return at(b) - at(a) || (a.scanRecord.scanId < b.scanRecord.scanId ? -1 : a.scanRecord.scanId > b.scanRecord.scanId ? 1 : 0);
}

/**
 * One selection's scan state, by Scan's decision table. Core accepts no Scan trust policy yet, so rows 6 to 12 (required
 * detectors, severity profile, revocation, age) cannot pass and `verified` is never given: a checked record is
 * `not-verified` with `unchecked`, or `not-authenticated` when its artifact's signature was refused.
 */
export function selectionScan(item: SelectionMetadata['item'], records: readonly ItemScanRecord[] | undefined,
    declared: readonly ItemMaterial[], own: readonly OwnMaterial[], artifacts: ReadonlyMap<string, ScanArtifact>): SelectionScan {
  if (!records?.length) return emptyScan('not-scanned');
  // Core checks a record against the bytes the selection delivers. With none (an item whose behaviour is only its
  // payload), Core cannot tell a relabelled record from a real one, so none counts.
  if (!own.length) return emptyScan('not-covered');
  const readable = records.flatMap(scanRecord => {
    const artifact = artifacts.get(scanRecord.scanId);
    return artifact?.readable ? [{ scanRecord, artifact }] : [];
  });
  if (!readable.length) return emptyScan('unreadable');
  const passing = readable.filter(entry => entry.artifact.readable && recordCovers(entry.scanRecord, item, declared, own, entry.artifact.entries));
  if (!passing.length) return emptyScan('not-covered');
  const covering = [...new Set(passing.filter(entry => entry.scanRecord.coverage === 'matched').map(entry => entry.scanRecord.scanId))];
  const picked = [...passing].sort(rank)[0]!;
  const { scanRecord } = picked;
  const findings = { ...NONE };
  let suppressed = 0;
  for (const detector of scanRecord.detectors) {
    for (const key of Object.keys(findings) as (keyof typeof NONE)[]) findings[key] += detector.findings[key];
    suppressed += detector.suppressed.reduce((total, entry) => total + entry.count, 0);
  }
  const summary = (state: ScanSummary['state'], why?: ScanSummary['why']): SelectionScan => ({ scanId: scanRecord.scanId,
    coverage: scanRecord.coverage, scanState: { state, ...(why ? { why } : {}), findings, suppressed, scannedAt: scanRecord.createdAt }, covering });
  if (scanRecord.coverage !== 'matched') return summary('not-covered');
  if (scanRecord.completion === 'partial') return summary('partial');
  const association = picked.artifact.readable ? picked.artifact.association : undefined;
  return summary('not-verified', association?.status === 'unverifiable' ? 'not-authenticated' : 'unchecked');
}
