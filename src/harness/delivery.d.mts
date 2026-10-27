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
  /** For `approval-shape-unsupported`: approve the server in the tool, as its permission step says. */
  guidance?: string;
  tool?: RegistryTool; diagnostics?: { code: string; reason: string; path: string; message: string }[];
}
export interface RenderedDelivery {
  status: 'rendered'; tool: string; item: ItemRef; bindingDigest: string; materialRoot: 'catalog';
  /** An ordinary Core recipe (urn:aihq:core:recipe:1.0.0, 1.1.0 when it registers a hook group, 1.4.0 when it allows one MCP server). */
  recipe: {
    schema: 'urn:aihq:core:recipe:1.0.0' | 'urn:aihq:core:recipe:1.1.0' | 'urn:aihq:core:recipe:1.4.0'; id: string; description: string;
    inputs: Record<string, unknown>;
    materials: { id: string; source: { kind: 'local'; input: 'catalog' }; path: string; sha256: string; byteLength: number }[];
    targets: ('project' | 'user')[]; prerequisites: { kind: 'executable'; name: string }[];
    operations: Record<string, unknown>[]; checks: Record<string, unknown>[];
  };
}
export declare const deliveryMaterialRoot: 'catalog';
export declare function renderDelivery(request: {
  tool: string; item: CatalogItem; binding: ToolBinding; scope: 'project' | 'user'; projectFolder?: string;
  /** Supply both to refuse rendering without native binding evidence for this exact tuple. Neither establishes native admission. */
  platform?: BindingPlatform; installedVersion?: string;
  /** The one MCP server item being rendered, ticked to have its approval written; never a list or approve-all. */
  grantApproval?: ItemRef;
  /** Text of content materials keyed by material id, needed only for marker blocks; checked against each SHA-256. */
  contents?: Readonly<Record<string, string>>;
}): RenderedDelivery | DeliveryRefusal;

export type StaticBlockerCode = 'protocol-not-spoken' | 'required-but-unsupported' | 'native-only-kind' | 'same-folder';
export interface Size { bytes: number; chars: number }
export interface ItemCompatibility {
  item: ItemRef; support: BindingSupport; reason: string; observed: ObservedLevel;
  observedOn: { toolVersion: string; os: 'windows' | 'macos' | 'linux'; arch: 'x64' | 'arm64'; observedAt: string } | null;
  boundAs?: { kind: BindingKind; item: ItemRef; viaFallback: true }; excluded?: true; permissionStep?: string;
  /** Why renderDelivery would refuse this item for the binding although no static blocker applies. */
  notRendered?: { reason: string; detail: string };
  deliveredSize: Size & { alwaysLoaded: Size };
  staticBlockers: { code: StaticBlockerCode; detail: string }[];
}
export interface SetCompatibility {
  set: SetRef; fit: 'full' | 'partial' | 'none'; members: { native: number; unconfirmed: number; none: number };
  deliveredSize: Size & { alwaysLoaded: Size };
}
/**
 * Display-only plugin-route guidance for one framework: the route text of the supplied Catalog `nativeRoutes` lines
 * naming the tool by its registry label. A route says how the tool's own plugin manager could install upstream's
 * bundle; it never means the bundle is installed, enabled, permitted, observed or working, and Core never runs it.
 */
export interface PluginRouteGuidance {
  framework: string; source: 'catalog-native-routes';
  /** `listed`: lines name this tool. `not-listed`: lines were supplied, none names this tool's label. `not-supplied`: none were passed. */
  state: 'listed' | 'not-listed' | 'not-supplied';
  lines: string[];
}
export interface CompatibilityResult {
  status: 'checked'; tool: string; platform: BindingPlatform; bindingDigest: string;
  items: ItemCompatibility[]; sets: SetCompatibility[];
  /** Present only when the request passed `nativeRoutes`: one entry per checked item framework or supplied framework. */
  pluginRoutes?: PluginRouteGuidance[];
}
export interface CompatibilityEntry {
  readonly item: CatalogItem; readonly fallback?: CatalogItem; readonly excluded?: boolean; readonly required?: boolean;
  readonly sets?: readonly SetRef[];
}
export declare function checkCompatibility(request: {
  tool: string; platform: BindingPlatform; installedVersion?: string; items: readonly CompatibilityEntry[]; binding: ToolBinding;
  /** Each checked Catalog release's `nativeRoutes` lines (`<tool name>: <route>`), by the release's framework. */
  nativeRoutes?: readonly { readonly framework: string; readonly lines: readonly string[] }[];
}): CompatibilityResult | DeliveryRefusal;
