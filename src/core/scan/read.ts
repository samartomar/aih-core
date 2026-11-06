// The one Scan import (contract 2, 13, C18): `@aihq/scan/read` for `verifySummary` and `matchScan`, nothing else. Scan
// is an optional peer: it is loaded only when a request supplies Scan evidence, and its absence is a result, never a
// failure, so building, installing and running Core never need Scan. It is loaded only from beside Core (`loadPeer`).
import { loadPeer } from '../internal/peer.js';

/** A Scan signer in Scan's shape; `identity` is only a label, trust comes from the authenticated issuer and subject. */
export interface ScanSigner { identity: string; issuer: string; subject: string; extensions?: Record<string, string> }
export interface VerifiedSigner { identity: string; trusted: boolean; issuer: string; subject: string }
export interface WithdrawalOutcome { status: string; reason?: string; throughRevision?: number }
export interface ScanSummary { scanKey: string; revision: number; label: string; coverage: 'complete' | 'partial'; score: number }
export type VerifyResult = { status: 'ok'; verified: true; withdrawn: boolean; signer: VerifiedSigner; summary: ScanSummary;
  withdrawals: readonly WithdrawalOutcome[] } | { status: string; reason?: string; verified: false };
export interface MatchFile { path: string; mode: '100644' | '100755'; bytes: Uint8Array }
export type MatchResult = { status: 'ok'; matches: boolean; coverage: string; scanKey: string;
  differences: { missing: string[]; extra: string[]; changed: string[]; modeChanged: string[] } } | { status: string; reason?: string };
export interface ScanRead {
  verifySummary(bytes: Uint8Array, bundle: Uint8Array | Record<string, unknown>, allowedSigners?: readonly ScanSigner[],
    options?: { withdrawn?: readonly Uint8Array[]; withdrawnBundle?: readonly (Uint8Array | Record<string, unknown>)[] }): Promise<VerifyResult>;
  matchScan(verified: VerifyResult, files: readonly MatchFile[]): Promise<MatchResult>;
}

const SPECIFIER: string = '@aihq/scan/read';
let loaded: ScanRead | undefined;

/** The caller's installed `@aihq/scan/read`, or why it can't be used. Never throws. */
export async function scanRead(): Promise<ScanRead | { unavailable: string }> {
  if (loaded) return loaded;
  const peer = await loadPeer(SPECIFIER);
  if (peer.status === 'not-exported') return { unavailable: 'The installed `@aihq/scan` has no `@aihq/scan/read`; it needs Scan 0.1.0.' };
  if (peer.status === 'outside')
    return { unavailable: '`@aihq/scan` was found outside the folder Core is installed in, so it was not loaded and the supplied Scan evidence was not checked.' };
  if (peer.status !== 'loaded') return { unavailable: '`@aihq/scan` is not installed beside Core, so the supplied Scan evidence was not checked.' };
  const module = peer.module as Partial<ScanRead>;
  if (typeof module.verifySummary !== 'function' || typeof module.matchScan !== 'function')
    return { unavailable: 'The installed `@aihq/scan` has no `verifySummary` and `matchScan` in `@aihq/scan/read`.' };
  loaded = { verifySummary: module.verifySummary.bind(module), matchScan: module.matchScan.bind(module) };
  return loaded;
}
