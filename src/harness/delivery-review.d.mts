import type { ApprovalLocation } from './tool-binding.mjs';
export interface DeliveredEntry { readonly path: string; readonly bytes: Uint8Array; readonly block: boolean }
export interface ReviewSize { bytes: number; chars: number }
export declare function selectionDeliveredSize(kind: string | undefined, delivered: readonly DeliveredEntry[]): ReviewSize & { alwaysLoaded?: ReviewSize };
export declare function hookGroupCommands(group: unknown): string[];
export declare function bindingLayout(tool: string, kind: string): { bindingDigest: string; support: 'native' | 'none' | 'unconfirmed';
  observed: 'recognised' | 'registered' | 'listed-only' | 'delivered' | 'none' } | undefined;
export declare function bindingPermissionStep(tool: string, kind: string): string | undefined;
export declare function permissionNotice(label: string, step: string): string;
export declare function bindingPermissionNotice(tool: string, kind: string): string | undefined;
export declare function bindingApprovalLocation(tool: string, kind: string):
  { register: { file: string; container: readonly string[] }; location: Exclude<ApprovalLocation, { shape: 'other' }> } | undefined;
export declare function approvalGiven(location: Exclude<ApprovalLocation, { shape: 'other' }>, document: unknown, key: string): boolean;
