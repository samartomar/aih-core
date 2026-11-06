// Scan revision memory (contract 5, 13, C49, C53): `~/.aih/core/scans.json` keeps the highest revision and the
// withdrawn-through revision seen per scan key and authenticated signer (issuer and subject), so it outlives removal and
// reinstall. It is bounded at 2 MiB, of which entries for signers the request did not trust may use at most a quarter,
// so they never push out what trusted signers said. It is read, merged and written under Core's state lock, keeping
// the highest values per key when two operations meet. It never refuses anything and is never sent anywhere. It is
// Core's private state, not a published format.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseStrictJsonObjectV1 } from '../internal/strict-json.js';
import { lockTarget, protectState, stateFiles, stateRoot, writeStateFile } from '../internal/state.js';

const FILE = 'scans.json';
export const SCAN_MEMORY_BYTES = 2 * 1_048_576;
/** The share of the memory that entries from signers the request didn't trust may take. */
export const UNTRUSTED_MEMORY_BYTES = SCAN_MEMORY_BYTES / 4;
/** A memory over its bound (written by an older or other process) is read and trimmed on the next write, not discarded. */
const READ_BYTES = 4 * SCAN_MEMORY_BYTES;
const KIND = 'aih-core-scan-memory';
const SCAN_KEY = /^git-(sha1:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/;

export interface MemoryEntry {
  scanKey: string; issuer: string; subject: string;
  /** The highest authenticated revision seen, or `null` when only a withdrawal was seen. */
  revision: number | null;
  /** The highest authenticated withdrawn-through revision seen for this key and signer, or `null`. */
  withdrawnThrough: number | null;
  /** When this entry last moved or was seen (milliseconds); the oldest goes first when the memory is full. */
  seen: number;
  /** Present when a request that showed it trusted its signer. Other entries share a smaller budget of their own. */
  trusted?: true;
}
export const memoryKey = (scanKey: string, issuer: string, subject: string): string => `${scanKey}\0${issuer}\0${subject}`;

const revision = (value: unknown): boolean => value === null || Number.isSafeInteger(value) && (value as number) >= 1;
const text = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length <= 2048;
function valid(entry: unknown): entry is MemoryEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const value = entry as Record<string, unknown>;
  const keys = Object.keys(value).length;
  return (keys === 6 || keys === 7 && value.trusted === true) && typeof value.scanKey === 'string' && SCAN_KEY.test(value.scanKey) &&
    text(value.issuer) && text(value.subject) && revision(value.revision) && revision(value.withdrawnThrough) &&
    Number.isSafeInteger(value.seen) && (value.seen as number) >= 0;
}

/** The remembered entries by key; an unreadable memory reads as empty (its checks are lost, nothing is refused). */
export function readMemory(): { entries: Map<string, MemoryEntry>; unreadable: boolean } {
  const entries = new Map<string, MemoryEntry>();
  try {
    if (!existsSync(join(stateRoot(), FILE))) return { entries, unreadable: false };
    protectState([FILE]);
    const bytes = stateFiles(READ_BYTES).read(FILE);
    if (!bytes || bytes.length > READ_BYTES) return { entries, unreadable: true };
    const document = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'Scan memory') as
      { kind?: unknown; version?: unknown; entries?: unknown };
    if (document.kind !== KIND || document.version !== 1 || !Array.isArray(document.entries)) return { entries, unreadable: true };
    for (const entry of document.entries) if (valid(entry)) entries.set(memoryKey(entry.scanKey, entry.issuer, entry.subject), { ...entry });
    return { entries, unreadable: false };
  } catch { return { entries, unreadable: true }; }
}

const maxOf = (a: number | null, b: number | null): number | null => a === null ? b : b === null ? a : Math.max(a, b);
/** One entry from two sightings: the highest revision, withdrawn-through and time seen; trusted if either was. */
export function mergeEntry(a: MemoryEntry, b: MemoryEntry): MemoryEntry {
  const trusted = a.trusted === true || b.trusted === true;
  return { scanKey: a.scanKey, issuer: a.issuer, subject: a.subject, revision: maxOf(a.revision, b.revision),
    withdrawnThrough: maxOf(a.withdrawnThrough, b.withdrawnThrough), seen: Math.max(a.seen, b.seen), ...(trusted ? { trusted: true as const } : {}) };
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** The lock that orders every read, merge and write of the memory across processes. */
const MEMORY_LOCK = 'aih-core:scan-memory';

/**
 * Moves the memory forward by `entries` under Core's state lock: what is stored now (another operation may have
 * written meanwhile) is read again and merged with the highest value per key, then written within the bound (see
 * `writeMemory`). A lock another process keeps holding past a short wait leaves the memory as it is
 * (`written: false`); nothing is refused.
 */
export function rememberEntries(entries: Map<string, MemoryEntry>, held: ReadonlySet<string>, fresh: ReadonlySet<string>):
    { written: boolean; heldEvicted: boolean } {
  let unlock: (() => void) | undefined;
  try {
    protectState([]);
    for (let attempt = 0; !unlock; attempt += 1) {
      try { unlock = lockTarget(MEMORY_LOCK); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 40) throw error; sleep(50); }
    }
  } catch { return { written: false, heldEvicted: false }; }
  try {
    const stored = readMemory();
    const merged = new Map(stored.entries);
    for (const [key, entry] of entries) { const other = merged.get(key); merged.set(key, other ? mergeEntry(other, entry) : { ...entry }); }
    return writeMemory(merged, held, fresh);
  } finally { try { unlock(); } catch { /* a lock left behind is reclaimed by the next operation */ } }
}

/**
 * Writes the memory back within its bound. Entries from signers no request trusted go first, and may take at most
 * `UNTRUSTED_MEMORY_BYTES`. Then, when full, the oldest entries for keys no receipt holds go first; if only held keys
 * remain, the oldest of those goes too and the result says so (`heldEvicted`). Entries this request just advanced
 * (`fresh`) go last. Returns `written: false` when the state could not be written; nothing is refused. Call it under
 * the memory lock (`rememberEntries`).
 */
export function writeMemory(entries: Map<string, MemoryEntry>, held: ReadonlySet<string>, fresh: ReadonlySet<string>):
    { written: boolean; heldEvicted: boolean } {
  const head = `{"kind":"${KIND}","version":1,"entries":[`, tail = ']}\n';
  const rows = [...entries.entries()].map(([key, entry]) => ({ key, entry, text: JSON.stringify(entry) }));
  let size = Buffer.byteLength(head) + Buffer.byteLength(tail) + rows.reduce((total, row, index) => total + Buffer.byteLength(row.text) + (index ? 1 : 0), 0);
  const rank = (row: typeof rows[number]) => fresh.has(row.key) ? 2 : held.has(row.entry.scanKey) ? 1 : 0;
  const trusted = (row: typeof rows[number]) => row.entry.trusted === true ? 1 : 0;
  const order = [...rows].sort((a, b) => trusted(a) - trusted(b) || rank(a) - rank(b) || a.entry.seen - b.entry.seen);
  let untrusted = rows.reduce((total, row) => total + (trusted(row) ? 0 : Buffer.byteLength(row.text) + 1), 0);
  const dropped = new Set<string>();
  let heldEvicted = false;
  for (const row of order) {
    if (size <= SCAN_MEMORY_BYTES && (trusted(row) || untrusted <= UNTRUSTED_MEMORY_BYTES)) break;
    const bytes = Buffer.byteLength(row.text) + 1;
    dropped.add(row.key); size -= bytes;
    if (!trusted(row)) untrusted -= bytes;
    if (rank(row) > 0) heldEvicted = true;
  }
  const kept = rows.filter(row => !dropped.has(row.key)).sort((a, b) => a.entry.seen - b.entry.seen ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const bytes = Buffer.from(`${head}${kept.map(row => row.text).join(',')}${tail}`);
  try {
    protectState([FILE]);
    writeStateFile(FILE, bytes, 0o600, false, SCAN_MEMORY_BYTES + 1);
    return { written: true, heldEvicted };
  } catch { return { written: false, heldEvicted }; }
}
