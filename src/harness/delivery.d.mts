import type { BindingKind, BindingPlatform, BindingSupport, ObservedLevel, ToolBinding } from './tool-binding.mjs';
import type { RegistryTool } from './tool-registry.mjs';

/** A checked Catalog release 1.6 item as its reader returns it; only the fields rendering reads are named. */
export interface CatalogItem {
  readonly id: string; readonly kind: BindingKind; readonly contentSha256: string; readonly behaviourSha256: string;
  readonly materials: readonly {
    readonly id: string; readonly relPath: string; readonly packagePath: string; readonly sha256: string; readonly byteLength: number;
    readonly executable?: boolean | 'unknown'; readonly sourceId?: string; readonly role?: 'content' | 'behaviour';
    readonly size?: { readonly bytes: number; readonly chars: number; readonly status: 'measured' | 'unknown' };
  }[];
  readonly payload?: Readonly<Record<string, unknown>> | null;
  readonly requirements?: { readonly inputs?: Readonly<Record<string, unknown>> };
  readonly size?: { readonly parts: readonly { readonly part: string; readonly bytes: number; readonly chars: number }[]; readonly status?: string };
  readonly [field: string]: unknown;
}
export interface ItemRef { framework: string; itemId: string }
export interface SetRef { readonly framework: string; readonly setId: string; readonly setSha256: string }
export interface DeliveryRefusal {
  status: 'refused'; code: 'INPUT_INVALID' | 'PREREQUISITE_UNAVAILABLE'; reason: string; path?: string; message?: string;
  tool?: RegistryTool; diagnostics?: { code: string; reason: string; path: string; message: string }[];
}
export interface RenderedDelivery {
  status: 'rendered'; tool: string; item: ItemRef; bindingDigest: string; materialRoot: 'catalog';
  /** An ordinary Core recipe (urn:aihq:core:recipe:1.0.0, or 1.1.0 when it registers a hook group). */
  recipe: {
    schema: 'urn:aihq:core:recipe:1.0.0' | 'urn:aihq:core:recipe:1.1.0'; id: string; description: string;
    inputs: Record<string, unknown>;
    materials: { id: string; source: { kind: 'local'; input: 'catalog' }; path: string; sha256: string; byteLength: number }[];
    targets: ('project' | 'user')[]; prerequisites: { kind: 'executable'; name: string }[];
    operations: Record<string, unknown>[]; checks: Record<string, unknown>[];
  };
}
export declare const deliveryMaterialRoot: 'catalog';
export declare function renderDelivery(request: {
  tool: string; item: CatalogItem; binding: ToolBinding; scope: 'project' | 'user'; projectFolder?: string;
  grantApproval?: readonly ItemRef[];
  /** Text of content materials keyed by material id, needed only for marker blocks; checked against each SHA-256. */
  contents?: Readonly<Record<string, string>>;
}): RenderedDelivery | DeliveryRefusal;

export type StaticBlockerCode = 'protocol-not-spoken' | 'required-but-unsupported' | 'native-only-kind' | 'same-folder';
export interface Size { bytes: number; chars: number }
export interface ItemCompatibility {
  item: ItemRef; support: BindingSupport; reason: string; observed: ObservedLevel;
  observedOn: { toolVersion: string; os: 'windows' | 'macos' | 'linux'; arch: 'x64' | 'arm64'; observedAt: string } | null;
  boundAs?: { kind: BindingKind; item: ItemRef; viaFallback: true }; excluded?: true; permissionStep?: string;
  deliveredSize: Size & { alwaysLoaded: Size };
  staticBlockers: { code: StaticBlockerCode; detail: string }[];
}
export interface SetCompatibility {
  set: SetRef; fit: 'full' | 'partial' | 'none'; members: { native: number; unconfirmed: number; none: number };
  deliveredSize: Size & { alwaysLoaded: Size };
}
export interface CompatibilityResult {
  status: 'checked'; tool: string; platform: BindingPlatform; bindingDigest: string;
  items: ItemCompatibility[]; sets: SetCompatibility[];
}
export interface CompatibilityEntry {
  readonly item: CatalogItem; readonly fallback?: CatalogItem; readonly excluded?: boolean; readonly required?: boolean;
  readonly sets?: readonly SetRef[];
}
export declare function checkCompatibility(request: {
  tool: string; platform: BindingPlatform; items: readonly CompatibilityEntry[]; binding: ToolBinding;
}): CompatibilityResult | DeliveryRefusal;
