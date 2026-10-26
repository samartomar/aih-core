export interface DeliveredEntry { readonly path: string; readonly bytes: Uint8Array; readonly block: boolean }
export interface ReviewSize { bytes: number; chars: number }
export declare function selectionDeliveredSize(kind: string | undefined, delivered: readonly DeliveredEntry[]): ReviewSize & { alwaysLoaded?: ReviewSize };
export declare function hookGroupCommands(group: unknown): string[];
export declare function bindingPermissionStep(tool: string, kind: string): string | undefined;
