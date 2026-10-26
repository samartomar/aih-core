import type { BindingKind } from './tool-binding.mjs';
export interface ToolHostItemReference { framework: string; itemId: string }
export interface ToolHostItem extends ToolHostItemReference {
  kind: BindingKind;
  /** The name the tool sees: a skill folder, an agent, command, rule or document file name, or an MCP server key. */
  key?: string;
  /** Program names the item needs on PATH, such as a hook's interpreter. */
  executables?: string[];
  /** Input names the item needs; values are never passed to inspection. */
  inputs?: string[];
  /** Items this one requires, as resolved by Catalog. */
  requires?: ToolHostItemReference[];
}
export interface ToolHostRequest { tool: string; project: string; items: ToolHostItem[] }
export interface ToolHostControls { signal?: AbortSignal; budgetMs?: number }
export type ToolHostCopy =
  | { state: 'found'; paths: string[] }
  | { state: 'none' }
  | { state: 'unavailable'; reason: string };
export type ToolHostBlocker =
  | { code: 'executable-missing'; item: ToolHostItemReference; executable: string }
  | { code: 'input-required'; item: ToolHostItemReference; input: string }
  | { code: 'dependency-missing'; item: ToolHostItemReference; dependency: ToolHostItemReference };
export type ToolHostWarning =
  | { code: 'same-key-elsewhere'; item: ToolHostItemReference; key: string; where: 'user' | 'parent-folder' | 'plugin'; path: string }
  | { code: 'also-reads'; what: string; where: 'ancestor-folders' | 'other-tool-folders' | 'account-sync' | 'user-profile' };
export interface ToolHostUnchecked {
  fact: 'tool-version' | 'executable' | 'user-copy' | 'parent-folder-copy' | 'plugin-copy' | 'stale';
  item?: ToolHostItemReference; executable?: string; reason: string;
}
export interface ToolHostItemResult extends ToolHostItemReference {
  kind: BindingKind; key?: string;
  /** The newest tool version among the cell's observations, when any. */
  observedVersion?: string;
  /** `true` when the installed version is newer than every proving observation; `'unchecked'` when it is unknown. */
  stale: boolean | 'unchecked';
  executables: { name: string; state: 'present' | 'absent' | 'unknown' }[];
  inputs: string[];
  copies: { user: ToolHostCopy; parentFolders: ToolHostCopy; plugins: ToolHostCopy };
}
export interface ToolHostLimits { budgetMs: number; elapsedMs: number; reads: number; maxReads: number }
export type ToolHostResult =
  | { status: 'complete' | 'incomplete' | 'cancelled';
      tool: { id: string; label: string }; binding: { digest: string };
      platform?: { os: 'windows' | 'macos' | 'linux'; arch: 'x64' | 'arm64' };
      installedVersion: { state: 'known'; version: string; source: 'package-manifest' | 'version-folder' } |
        { state: 'unknown'; reason: string };
      stale: boolean | 'unchecked';
      items: ToolHostItemResult[]; hostBlockers: ToolHostBlocker[]; warnings: ToolHostWarning[];
      unchecked: ToolHostUnchecked[];
      diagnostics: { code: string; reason: string; message: string }[]; limits: ToolHostLimits }
  | { status: 'invalid' | 'refused' | 'cancelled';
      diagnostics: { code: string; reason: string; message: string }[]; limits: ToolHostLimits };
/**
 * Observes, with bounded reads and nothing run, the installed tool and project for the given items.
 * Never removes or edits what it finds. Unknown and unavailable facts are reported in `unchecked`.
 */
export declare function inspectToolHost(request: ToolHostRequest, controls?: ToolHostControls): Promise<ToolHostResult>;
