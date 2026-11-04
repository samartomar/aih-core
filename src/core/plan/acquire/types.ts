// What an admitted `acquire` step carries from Prepare to Apply (contract 8.1, D54, D86, D105, C46).

/** One byte-checked download: Core fetches only `url` and keeps the bytes only when their length and sha256 match. */
export interface Download { url: string; file: string; sha256: string; bytes: number | null }
export interface ArchiveMember { path: string; sha256: string; executable: boolean }
export interface ClosureWheel extends Download { name: string; version: string }
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
}
/** The real failures that switch an installed interpreter to the reviewed fallback (D105). */
export const FALLBACK_REASONS = ['none-found', 'outside-range', 'wheel-install-failed', 'readback-failed'] as const;
export const MANIFEST = '.aih-acquired';
export const ACQUIRING = '.aih-acquiring';
