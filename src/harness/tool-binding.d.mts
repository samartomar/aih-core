import type { RegistryTool } from './tool-registry.mjs';
export type BindingKind = 'skill' | 'agent' | 'command' | 'rule' | 'hook' | 'mcp-server' | 'document';
export type BindingSupport = 'native' | 'none' | 'unconfirmed';
export type ObservedLevel = 'recognised' | 'registered' | 'listed-only' | 'delivered' | 'none';
export interface BindingPlatform { readonly os: string; readonly arch: string }
export interface BindingObservation {
  readonly toolVersion: string; readonly observedAt: string; readonly coreVersion: string;
  readonly os: 'windows' | 'macos' | 'linux'; readonly arch: 'x64' | 'arm64';
  readonly isolation: 'os-account' | 'sandbox' | 'env-redirect-outside-profile' | 'env-redirect-inside-profile';
  readonly runRecordDigest: string;
  readonly delivered: 'delivered' | 'not-delivered';
  readonly registered: 'registered' | 'registered-pending-approval' | 'visible-to-model' | 'not-registered' | 'inconclusive' | 'not-checked';
  readonly recognised: 'recognised' | 'listed-only' | 'not-recognised' | 'contaminated' | 'not-run';
}
export interface ToolLayout {
  readonly support: BindingSupport; readonly reason: string; readonly observations: readonly BindingObservation[];
  readonly roots: { readonly project?: string; readonly user?: { readonly path: string; readonly resolvedBy: string } };
  readonly skillKey?: 'folder' | 'declared-name'; readonly convert?: { readonly to: string; readonly converter: string };
  readonly namespace?: 'folder' | 'prefix';
  readonly register?: { readonly file: string; readonly container: readonly string[]; readonly format: 'json' | 'jsonc' | 'toml' | 'yaml';
    readonly approval: 'none' | 'per-user' | 'per-project'; readonly permissionStep?: string };
  readonly formats?: readonly string[]; readonly hookEvents?: Readonly<Record<string, string>>;
  readonly hookProtocols?: readonly string[]; readonly commandTemplate?: string;
}
export interface ToolBinding {
  readonly schema: 'urn:aihq:harness:tool-binding:1.0.0'; readonly tool: string; readonly digest: string;
  readonly layouts: Readonly<Record<BindingKind, ToolLayout>>; readonly entryFiles: readonly string[];
  readonly entryPointer?: { readonly file: string; readonly template: string };
  readonly alsoReads: readonly { readonly what: string; readonly where: 'ancestor-folders' | 'other-tool-folders' | 'account-sync' | 'user-profile' }[];
}
export interface CellSupport {
  support: BindingSupport; observed: ObservedLevel; stale: boolean;
  observedOn?: { toolVersion: string; os: string; arch: string; observedAt: string };
}
export type BindingSelection =
  | ({ status: 'selected'; tool: string; kind: BindingKind; digest: string; layout: ToolLayout } & CellSupport & { support: 'native' })
  | { status: 'refused'; code: 'PREREQUISITE_UNAVAILABLE'; reason: 'kind-not-native'; tool: string; kind: BindingKind;
      cell: { support: 'none' | 'unconfirmed'; reason: string } }
  | { status: 'refused'; code: 'PREREQUISITE_UNAVAILABLE'; reason: 'tool-not-observed'; tool: RegistryTool }
  | { status: 'refused'; code: 'INPUT_INVALID'; reason: 'unknown-tool' };
export declare const toolBindingKinds: readonly BindingKind[];
export declare const toolBindings: readonly ToolBinding[];
export declare function deriveCellSupport(query: { kind: BindingKind; observations: readonly BindingObservation[];
  platform?: BindingPlatform; installedVersion?: string }): CellSupport;
export declare function selectBindingCell(query: { tool: string; kind: BindingKind; platform: BindingPlatform;
  installedVersion?: string }): BindingSelection;
export declare function validateToolBinding(value: unknown): {
  valid: boolean; diagnostics: { code: string; reason: string; path: string; message: string; encountered?: string; supported?: string[] }[];
};
