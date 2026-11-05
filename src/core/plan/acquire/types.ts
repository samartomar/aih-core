// What an admitted `acquire` step carries from Prepare to Apply (contract 8.1, D54, D86, D105, C46).
import type { AcquiredFile, DownloadRole, DownloadSource } from '../types.js';

/**
 * One byte-checked download (C78): obtained from a supplied folder, the recorded https `url` (`null` when none is recorded)
 * or the index by exact identity, and kept only when its length and sha256 match.
 */
export interface Download { url: string | null; file: string; sha256: string; bytes: number | null }
export interface ArchiveMember { path: string; sha256: string; executable: boolean }
/** A host build tool a qualification observed (`build.tools`): a prerequisite, never downloaded. */
export interface BuildTool { name: string; version: string; sha256: string }
/** How a closure wheel was built when its prebuilt bytes were unavailable (Catalog `build`): pinned inputs only. */
export interface WheelBuild { source: Download; dependencies: (Download & { name: string; version: string })[]; tools: BuildTool[] }
export interface ClosureWheel extends Download { name: string; version: string; build: WheelBuild | null }
// The published shapes (review `downloads`, receipt and `list` `aiSetup.downloads`) are defined once, in `../types.ts`.
export type { DownloadRole };
/** The one source Apply tries for a download, fixed at Prepare and shown in the review (C78). */
export type Source = DownloadSource;
/** Where one acquired file actually came from (receipt and `list`). A built wheel is never byte-qualified. */
export type DownloadRecord = AcquiredFile;
export interface AcquireSpec {
  step: number;
  aiSetup: string;
  version: string;
  cell: string;
  /** The qualification document's sha256 (hex). */
  qualification: string;
  /** The AI setup folder under the home folder, `.aihq/ai-setup/<name>/<version>/<cell>`. */
  into: string;
  kind: 'pypi-wheel' | 'native-archive';
  artifact: Download;
  /** A native archive's qualified members, extracted byte-checked into the folder. */
  members: ArchiveMember[];
  /** A Python tool's hash-locked, binary-only wheel closure. */
  closure: ClosureWheel[];
  /** A Python tool's interpreter choice: an installed one inside `range` first, then the qualified `fallback`. */
  interpreter: { range: string; fallback: Download & { version: string } } | null;
}
/** The interpreter Prepare found (C46): in range, never byte-qualified. */
export interface InstalledInterpreter { path: string; version: string }
/** What one acquisition did: which interpreter branch ran, and why the fallback did (C46). */
export interface AcquireFacts {
  branch: 'installed' | 'fallback' | null;
  interpreter: InstalledInterpreter | null;
  fallback: boolean;
  fallbackReason: string | null;
  /** Where each file the install used came from (C78). */
  downloads?: DownloadRecord[];
}
/** The real failures that switch an installed interpreter to the reviewed fallback (D105); `build-failed` only with a build. */
export const FALLBACK_REASONS = ['none-found', 'outside-range', 'wheel-install-failed', 'readback-failed', 'build-failed'] as const;
export const MANIFEST = '.aih-acquired';
export const ACQUIRING = '.aih-acquiring';
