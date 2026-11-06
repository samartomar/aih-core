export interface BindingTool {
  readonly id: string; readonly label: string; readonly surface: 'cli' | 'ide'; readonly binaries: readonly string[]; readonly aliases: readonly string[];
}
export declare const toolBindings: readonly unknown[];
export declare const qualifyingIsolation: readonly string[];
export declare const observedToolIds: readonly string[];
export declare function findBindingTool(name: unknown): { tool: BindingTool; via: 'id' | 'alias' } | undefined;
export declare function selectBindingTool(id: string):
  | { status: 'selected'; tool: BindingTool }
  | { status: 'refused'; code: 'PREREQUISITE_UNAVAILABLE'; reason: 'tool-not-observed'; tool: BindingTool }
  | { status: 'refused'; code: 'INPUT_INVALID'; reason: 'unknown-tool' };
